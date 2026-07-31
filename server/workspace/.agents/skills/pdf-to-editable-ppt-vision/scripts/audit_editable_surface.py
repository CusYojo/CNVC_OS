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
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"p": P_NS, "a": A_NS, "r": R_NS}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="统计可编辑前景对象，并生成移除 OCR 整页背景的 QA PPTX。"
    )
    parser.add_argument("--pptx", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--foreground-only-pptx", type=Path)
    parser.add_argument(
        "--semantic-plan",
        type=Path,
        help="语义重建计划；已应用区域内的源栅格图会从前景审计副本移除。",
    )
    return parser.parse_args()


def slide_number(path: str) -> int:
    name = Path(path).stem
    return int(name.removeprefix("slide"))


def text_of_shape(shape: ET.Element) -> str:
    paragraphs = []
    for para in shape.findall("./p:txBody/a:p", NS):
        parts = []
        for node in para.iter():
            if node.tag == f"{{{A_NS}}}t" and node.text:
                parts.append(node.text)
            elif node.tag == f"{{{A_NS}}}br":
                parts.append("\n")
        paragraphs.append("".join(parts))
    return "\n".join(paragraphs).strip()


def relationship_target(rels_root: ET.Element, rel_id: str) -> str | None:
    for rel in rels_root:
        if rel.attrib.get("Id") == rel_id:
            return rel.attrib.get("Target")
    return None


def covered_by_semantic_region(
    frame: dict,
    slide_size: tuple[int, int] | None,
    semantic_regions: list[list[float]],
) -> bool:
    if not slide_size or None in frame.values():
        return False
    slide_cx, slide_cy = slide_size
    x = frame["x"] / slide_cx
    y = frame["y"] / slide_cy
    width = frame["cx"] / slide_cx
    height = frame["cy"] / slide_cy
    picture_area = max(1e-9, width * height)
    for region in semantic_regions:
        rx, ry, rw, rh = region
        intersection_width = max(0.0, min(x + width, rx + rw) - max(x, rx))
        intersection_height = max(0.0, min(y + height, ry + rh) - max(y, ry))
        if intersection_width * intersection_height / picture_area >= 0.90:
            return True
    return False


def frame_of(node: ET.Element, transform_path: str) -> dict:
    transform = node.find(transform_path, NS)
    offset = transform.find("./a:off", NS) if transform is not None else None
    extent = transform.find("./a:ext", NS) if transform is not None else None
    return {
        "x": int(offset.attrib.get("x", 0)) if offset is not None else None,
        "y": int(offset.attrib.get("y", 0)) if offset is not None else None,
        "cx": int(extent.attrib.get("cx", 0)) if extent is not None else None,
        "cy": int(extent.attrib.get("cy", 0)) if extent is not None else None,
    }


def audit_slide(
    slide_root: ET.Element,
    rels_root: ET.Element | None,
    slide_size: tuple[int, int] | None = None,
    semantic_regions: list[list[float]] | None = None,
) -> tuple[dict, list[str], list[str]]:
    semantic_regions = semantic_regions or []
    backgrounds = []
    removable_rel_ids = []
    text_shapes = []
    foreground_pictures = []
    semantic_shapes = []
    semantic_replaced_text_shapes = []

    for shape in slide_root.findall(".//p:sp", NS):
        name_node = shape.find("./p:nvSpPr/p:cNvPr", NS)
        name = name_node.attrib.get("name", "") if name_node is not None else ""
        value = text_of_shape(shape)
        source_text_replaced = (
            name.startswith(("pdf-text-", "pdf-paragraph-", "ocr-text-", "ocr-paragraph-"))
            and covered_by_semantic_region(
                frame_of(shape, "./p:spPr/a:xfrm"),
                slide_size,
                semantic_regions,
            )
        )
        if source_text_replaced:
            semantic_replaced_text_shapes.append(name)
            continue
        if value:
            text_shapes.append({"name": name, "text": value})
        else:
            semantic_shapes.append(name)

    for picture in slide_root.findall(".//p:pic", NS):
        name_node = picture.find("./p:nvPicPr/p:cNvPr", NS)
        name = name_node.attrib.get("name", "") if name_node is not None else ""
        description = (
            name_node.attrib.get("descr", "")
            if name_node is not None
            else ""
        )
        blip = picture.find("./p:blipFill/a:blip", NS)
        rel_id = blip.attrib.get(f"{{{R_NS}}}embed", "") if blip is not None else ""
        target = relationship_target(rels_root, rel_id) if rels_root is not None else None
        frame = frame_of(picture, "./p:spPr/a:xfrm")
        full_slide = False
        if slide_size and None not in frame.values():
            slide_cx, slide_cy = slide_size
            full_slide = (
                abs(frame["x"]) <= slide_cx * 0.01
                and abs(frame["y"]) <= slide_cy * 0.01
                and abs(frame["cx"] - slide_cx) <= slide_cx * 0.02
                and abs(frame["cy"] - slide_cy) <= slide_cy * 0.02
            )
        item = {
            "name": name,
            "description": description,
            "relationshipId": rel_id,
            "target": target,
            "frame": frame,
        }
        semantic_replacement = covered_by_semantic_region(
            frame, slide_size, semantic_regions
        )
        item["semanticReplacement"] = semantic_replacement
        if (
            name.startswith("ocr-clean-background-")
            or "已清除文字的视觉背景" in description
            or full_slide
            or (
                name.startswith("pdf-image-")
                and semantic_replacement
            )
        ):
            backgrounds.append(item)
            if rel_id:
                removable_rel_ids.append(rel_id)
        else:
            foreground_pictures.append(item)

    report = {
        "backgroundPictureCount": len(backgrounds),
        "backgroundPictures": backgrounds,
        "textShapeCount": len(text_shapes),
        "semanticReplacedTextShapeCount": len(semantic_replaced_text_shapes),
        "semanticReplacedTextShapes": semantic_replaced_text_shapes,
        "multiLineTextShapeCount": sum("\n" in item["text"] for item in text_shapes),
        "foregroundPictureCount": len(foreground_pictures),
        "semanticShapeCount": len(semantic_shapes),
        "foregroundObjectCount": (
            len(text_shapes) + len(foreground_pictures) + len(semantic_shapes)
        ),
        "textShapes": text_shapes,
        "foregroundPictures": foreground_pictures,
    }
    return report, removable_rel_ids, semantic_replaced_text_shapes


def remove_backgrounds(
    slide_root: ET.Element,
    rels_root: ET.Element | None,
    rel_ids: list[str],
    slide_size: tuple[int, int] | None = None,
    semantic_regions: list[list[float]] | None = None,
    removable_shape_names: list[str] | None = None,
) -> None:
    semantic_regions = semantic_regions or []
    removable_shape_names = removable_shape_names or []
    for sp_tree in slide_root.findall(".//p:spTree", NS):
        for child in list(sp_tree):
            if child.tag == f"{{{P_NS}}}sp":
                name_node = child.find("./p:nvSpPr/p:cNvPr", NS)
                name = (
                    name_node.attrib.get("name", "")
                    if name_node is not None
                    else ""
                )
                if name in removable_shape_names:
                    sp_tree.remove(child)
                continue
            if child.tag != f"{{{P_NS}}}pic":
                continue
            name_node = child.find("./p:nvPicPr/p:cNvPr", NS)
            name = name_node.attrib.get("name", "") if name_node is not None else ""
            description = (
                name_node.attrib.get("descr", "")
                if name_node is not None
                else ""
            )
            transform = child.find("./p:spPr/a:xfrm", NS)
            offset = transform.find("./a:off", NS) if transform is not None else None
            extent = transform.find("./a:ext", NS) if transform is not None else None
            full_slide = False
            if slide_size and offset is not None and extent is not None:
                slide_cx, slide_cy = slide_size
                x = int(offset.attrib.get("x", 0))
                y = int(offset.attrib.get("y", 0))
                cx = int(extent.attrib.get("cx", 0))
                cy = int(extent.attrib.get("cy", 0))
                full_slide = (
                    abs(x) <= slide_cx * 0.01
                    and abs(y) <= slide_cy * 0.01
                    and abs(cx - slide_cx) <= slide_cx * 0.02
                    and abs(cy - slide_cy) <= slide_cy * 0.02
                )
            if (
                name.startswith("ocr-clean-background-")
                or "已清除文字的视觉背景" in description
                or full_slide
                or (
                    name.startswith("pdf-image-")
                    and covered_by_semantic_region(
                        {
                            "x": int(offset.attrib.get("x", 0)),
                            "y": int(offset.attrib.get("y", 0)),
                            "cx": int(extent.attrib.get("cx", 0)),
                            "cy": int(extent.attrib.get("cy", 0)),
                        }
                        if offset is not None and extent is not None
                        else {"x": None, "y": None, "cx": None, "cy": None},
                        slide_size,
                        semantic_regions,
                    )
                )
            ):
                sp_tree.remove(child)
    if rels_root is not None:
        for rel in list(rels_root):
            if rel.attrib.get("Id") in rel_ids:
                rels_root.remove(rel)


def main() -> None:
    args = parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.foreground_only_pptx:
        args.foreground_only_pptx.parent.mkdir(parents=True, exist_ok=True)

    report = {
        "schemaVersion": "1.0",
        "pptx": str(args.pptx.resolve()),
        "slides": [],
        "totals": {},
    }
    rewritten: dict[str, bytes] = {}
    semantic_regions_by_page: dict[int, list[list[float]]] = {}
    if args.semantic_plan:
        semantic_plan = json.loads(
            args.semantic_plan.expanduser().resolve().read_text(encoding="utf-8")
        )
        for page in semantic_plan.get("pages") or []:
            number = int(page.get("page") or 0)
            semantic_regions_by_page[number] = [
                region["bbox"]
                for region in page.get("regions") or []
                if (
                    region.get("applied")
                    and isinstance(region.get("bbox"), list)
                    and len(region["bbox"]) == 4
                )
            ]

    with zipfile.ZipFile(args.pptx) as archive:
        presentation_root = ET.fromstring(
            archive.read("ppt/presentation.xml")
        )
        slide_size_node = presentation_root.find(
            f".//{{{P_NS}}}sldSz"
        )
        slide_size = (
            (
                int(slide_size_node.attrib["cx"]),
                int(slide_size_node.attrib["cy"]),
            )
            if slide_size_node is not None
            else None
        )
        slide_paths = sorted(
            (
                name
                for name in archive.namelist()
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
                if rels_path in archive.namelist()
                else None
            )
            slide_report, rel_ids, removable_shape_names = audit_slide(
                slide_root,
                rels_root,
                slide_size,
                semantic_regions_by_page.get(number, []),
            )
            slide_report["slide"] = number
            report["slides"].append(slide_report)
            if args.foreground_only_pptx:
                remove_backgrounds(
                    slide_root,
                    rels_root,
                    rel_ids,
                    slide_size,
                    semantic_regions_by_page.get(number, []),
                    removable_shape_names,
                )
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
            "semanticReplacedTextShapeCount": sum(
                item["semanticReplacedTextShapeCount"]
                for item in report["slides"]
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
        report["passed"] = True

        if args.foreground_only_pptx:
            with tempfile.NamedTemporaryFile(
                suffix=".pptx", delete=False
            ) as temporary:
                temp_path = Path(temporary.name)
            try:
                with zipfile.ZipFile(temp_path, "w", zipfile.ZIP_DEFLATED) as output:
                    for item in archive.infolist():
                        output.writestr(item, rewritten.get(item.filename, archive.read(item)))
                shutil.move(temp_path, args.foreground_only_pptx)
            finally:
                temp_path.unlink(missing_ok=True)

    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        f"可编辑前景审计完成：{report['totals']['slideCount']} 页，"
        f"{report['totals']['foregroundObjectCount']} 个前景对象"
    )


if __name__ == "__main__":
    main()
