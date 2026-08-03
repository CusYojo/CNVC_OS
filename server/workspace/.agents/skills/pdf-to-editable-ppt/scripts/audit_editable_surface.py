#!/usr/bin/env python3
"""Audit PPTX foreground independence and optionally create a background-free QA copy."""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"p": P_NS, "a": A_NS, "r": R_NS}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="统计可编辑前景对象，并生成移除 OCR 整页背景的 QA PPTX。"
    )
    parser.add_argument("--pptx", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--foreground-only-pptx", type=Path)
    return parser.parse_args()


def slide_number(path: str) -> int:
    return int(Path(path).stem.removeprefix("slide"))


def text_of_shape(shape: ET.Element) -> str:
    paragraphs = []
    for paragraph in shape.findall("./p:txBody/a:p", NS):
        parts = []
        for node in paragraph.iter():
            if node.tag == f"{{{A_NS}}}t" and node.text:
                parts.append(node.text)
            elif node.tag == f"{{{A_NS}}}br":
                parts.append("\n")
        paragraphs.append("".join(parts))
    return "\n".join(paragraphs).strip()


def relationship_target(rels_root: ET.Element | None, rel_id: str) -> str | None:
    if rels_root is None:
        return None
    for relationship in rels_root:
        if relationship.attrib.get("Id") == rel_id:
            return relationship.attrib.get("Target")
    return None


def audit_slide(
    slide_root: ET.Element, rels_root: ET.Element | None
) -> tuple[dict, list[str]]:
    backgrounds = []
    removable_rel_ids = []
    text_shapes = []
    foreground_pictures = []
    semantic_shapes = []

    for shape in slide_root.findall(".//p:sp", NS):
        name_node = shape.find("./p:nvSpPr/p:cNvPr", NS)
        name = name_node.attrib.get("name", "") if name_node is not None else ""
        value = text_of_shape(shape)
        if value:
            text_shapes.append({"name": name, "text": value})
        else:
            semantic_shapes.append(name)

    for picture in slide_root.findall(".//p:pic", NS):
        name_node = picture.find("./p:nvPicPr/p:cNvPr", NS)
        name = name_node.attrib.get("name", "") if name_node is not None else ""
        blip = picture.find("./p:blipFill/a:blip", NS)
        rel_id = (
            blip.attrib.get(f"{{{R_NS}}}embed", "") if blip is not None else ""
        )
        item = {
            "name": name,
            "relationshipId": rel_id,
            "target": relationship_target(rels_root, rel_id),
        }
        if name.startswith("ocr-clean-background-"):
            backgrounds.append(item)
            if rel_id:
                removable_rel_ids.append(rel_id)
        else:
            foreground_pictures.append(item)

    report = {
        "backgroundPictureCount": len(backgrounds),
        "backgroundPictures": backgrounds,
        "textShapeCount": len(text_shapes),
        "multiLineTextShapeCount": sum(
            "\n" in item["text"] for item in text_shapes
        ),
        "foregroundPictureCount": len(foreground_pictures),
        "semanticShapeCount": len(semantic_shapes),
        "foregroundObjectCount": (
            len(text_shapes) + len(foreground_pictures) + len(semantic_shapes)
        ),
        "textShapes": text_shapes,
        "foregroundPictures": foreground_pictures,
    }
    return report, removable_rel_ids


def remove_backgrounds(
    slide_root: ET.Element,
    rels_root: ET.Element | None,
    rel_ids: list[str],
) -> None:
    for shape_tree in slide_root.findall(".//p:spTree", NS):
        for child in list(shape_tree):
            if child.tag != f"{{{P_NS}}}pic":
                continue
            name_node = child.find("./p:nvPicPr/p:cNvPr", NS)
            name = name_node.attrib.get("name", "") if name_node is not None else ""
            if name.startswith("ocr-clean-background-"):
                shape_tree.remove(child)
    if rels_root is not None:
        for relationship in list(rels_root):
            if relationship.attrib.get("Id") in rel_ids:
                rels_root.remove(relationship)


def main() -> None:
    args = parse_args()
    output = args.output.expanduser().resolve()
    pptx = args.pptx.expanduser().resolve()
    foreground_only = (
        args.foreground_only_pptx.expanduser().resolve()
        if args.foreground_only_pptx
        else None
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    if foreground_only:
        foreground_only.parent.mkdir(parents=True, exist_ok=True)

    report = {
        "schemaVersion": "1.0",
        "pptx": str(pptx),
        "slides": [],
        "totals": {},
    }
    rewritten: dict[str, bytes] = {}
    with zipfile.ZipFile(pptx) as archive:
        names = set(archive.namelist())
        slide_paths = sorted(
            (
                name
                for name in names
                if name.startswith("ppt/slides/slide")
                and name.endswith(".xml")
                and "/_rels/" not in name
            ),
            key=slide_number,
        )
        for slide_path in slide_paths:
            number = slide_number(slide_path)
            rels_path = f"ppt/slides/_rels/slide{number}.xml.rels"
            slide_root = ET.fromstring(archive.read(slide_path))
            rels_root = (
                ET.fromstring(archive.read(rels_path))
                if rels_path in names
                else None
            )
            slide_report, rel_ids = audit_slide(slide_root, rels_root)
            slide_report["slide"] = number
            report["slides"].append(slide_report)
            if foreground_only:
                remove_backgrounds(slide_root, rels_root, rel_ids)
                rewritten[slide_path] = ET.tostring(
                    slide_root, encoding="utf-8", xml_declaration=True
                )
                if rels_root is not None:
                    rewritten[rels_path] = ET.tostring(
                        rels_root, encoding="utf-8", xml_declaration=True
                    )

        report["totals"] = {
            "slideCount": len(report["slides"]),
            "backgroundPictureCount": sum(
                item["backgroundPictureCount"] for item in report["slides"]
            ),
            "textShapeCount": sum(
                item["textShapeCount"] for item in report["slides"]
            ),
            "multiLineTextShapeCount": sum(
                item["multiLineTextShapeCount"] for item in report["slides"]
            ),
            "foregroundPictureCount": sum(
                item["foregroundPictureCount"] for item in report["slides"]
            ),
            "semanticShapeCount": sum(
                item["semanticShapeCount"] for item in report["slides"]
            ),
            "foregroundObjectCount": sum(
                item["foregroundObjectCount"] for item in report["slides"]
            ),
        }

        if foreground_only:
            with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False) as temporary:
                temporary_path = Path(temporary.name)
            try:
                with zipfile.ZipFile(
                    temporary_path, "w", zipfile.ZIP_DEFLATED
                ) as output_archive:
                    for archive_item in archive.infolist():
                        output_archive.writestr(
                            archive_item,
                            rewritten.get(
                                archive_item.filename,
                                archive.read(archive_item),
                            ),
                        )
                shutil.move(temporary_path, foreground_only)
            finally:
                temporary_path.unlink(missing_ok=True)

    report["passed"] = report["totals"]["foregroundObjectCount"] > 0
    output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if not report["passed"]:
        raise RuntimeError("可编辑前景审计失败：PPTX 中没有任何独立前景对象")
    print(
        f"可编辑前景审计完成：{report['totals']['slideCount']} 页，"
        f"{report['totals']['foregroundObjectCount']} 个前景对象"
    )


if __name__ == "__main__":
    main()
