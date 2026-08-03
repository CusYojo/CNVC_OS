#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
import json
import os
import posixpath
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
OBJECT_TAGS = {"sp", "pic", "grpSp", "graphicFrame", "cxnSp"}


def qn(prefix: str, name: str) -> str:
    return f"{{{NS[prefix]}}}{name}"


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_xml(data: bytes) -> ET.Element:
    for _, namespace in ET.iterparse(io.BytesIO(data), events=("start-ns",)):
        prefix, uri = namespace
        try:
            ET.register_namespace(prefix, uri)
        except ValueError:
            pass
    return ET.fromstring(data)


def serialize_xml(root: ET.Element) -> bytes:
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def relationships(archive: zipfile.ZipFile, part_name: str) -> dict[str, str]:
    directory, filename = posixpath.split(part_name)
    rels_name = posixpath.join(directory, "_rels", filename + ".rels")
    if rels_name not in archive.namelist():
        return {}
    root = parse_xml(archive.read(rels_name))
    result: dict[str, str] = {}
    for item in root.findall("rel:Relationship", NS):
        if item.get("TargetMode") == "External":
            continue
        target = item.get("Target", "")
        resolved = posixpath.normpath(
            posixpath.join(posixpath.dirname(part_name), target)
        ).lstrip("/")
        result[str(item.get("Id"))] = resolved
    return result


def slide_parts_in_order(archive: zipfile.ZipFile) -> list[str]:
    presentation_part = "ppt/presentation.xml"
    presentation = parse_xml(archive.read(presentation_part))
    rels = relationships(archive, presentation_part)
    parts: list[str] = []
    for slide_id in presentation.findall(".//p:sldIdLst/p:sldId", NS):
        rel_id = slide_id.get(qn("r", "id"))
        if rel_id in rels:
            parts.append(rels[rel_id])
    return parts


def direct_shape_id(element: ET.Element) -> int | None:
    paths = (
        "./p:nvSpPr/p:cNvPr",
        "./p:nvPicPr/p:cNvPr",
        "./p:nvGrpSpPr/p:cNvPr",
        "./p:nvGraphicFramePr/p:cNvPr",
        "./p:nvCxnSpPr/p:cNvPr",
    )
    for path in paths:
        node = element.find(path, NS)
        if node is not None:
            try:
                return int(node.get("id", ""))
            except ValueError:
                return None
    return None


def descendant_shape_ids(element: ET.Element) -> set[int]:
    result: set[int] = set()
    for node in element.iter():
        if local_name(node.tag) not in OBJECT_TAGS:
            continue
        shape_id = direct_shape_id(node)
        if shape_id is not None:
            result.add(shape_id)
    return result


def delete_shape_ids(
    parent: ET.Element, targets: set[int], deleted: set[int]
) -> None:
    for child in list(parent):
        if local_name(child.tag) in OBJECT_TAGS:
            shape_id = direct_shape_id(child)
            if shape_id in targets:
                deleted.update(targets & descendant_shape_ids(child))
                parent.remove(child)
                continue
        delete_shape_ids(child, targets, deleted)


def load_plan(path: Path) -> dict:
    data = json.loads(path.expanduser().resolve().read_text(encoding="utf-8"))
    if data.get("layoutPolicy") != "strict":
        raise ValueError("结构删除计划 layoutPolicy 必须为 strict")
    operations = data.get("operations")
    if not isinstance(operations, list) or not operations:
        raise ValueError("结构删除计划必须包含非空 operations 数组")
    seen: set[tuple[int, int]] = set()
    for index, operation in enumerate(operations, 1):
        if operation.get("action") != "delete_slot_group":
            raise ValueError(f"第 {index} 项不是 delete_slot_group")
        if operation.get("layoutPolicy") != "preserve-grid":
            raise ValueError(f"第 {index} 项必须保持 preserve-grid")
        slide = int(operation.get("slide", 0))
        shape_ids = operation.get("shapeIds")
        content_ids = operation.get("contentShapeIds")
        decoration_ids = operation.get("decorationShapeIds")
        if slide <= 0 or not isinstance(shape_ids, list) or not shape_ids:
            raise ValueError(f"第 {index} 项缺少有效页码或 shapeIds")
        shape_set = {int(value) for value in shape_ids}
        if len(shape_set) != len(shape_ids):
            raise ValueError(f"第 {index} 项 shapeIds 不得重复")
        if {int(value) for value in content_ids or []} | {
            int(value) for value in decoration_ids or []
        } != shape_set:
            raise ValueError(f"第 {index} 项必须删除完整的内容对象与装饰对象并集")
        for shape_id in shape_set:
            key = (slide, shape_id)
            if key in seen:
                raise ValueError(
                    f"第 {index} 项重复删除第 {slide} 页 shapeId={shape_id}"
                )
            seen.add(key)
    return data


def apply_plan(
    source_path: Path, plan_path: Path, output_path: Path
) -> dict:
    source_path = source_path.expanduser().resolve()
    output_path = output_path.expanduser().resolve()
    if source_path == output_path:
        raise ValueError("输出文件不能覆盖输入文件")
    plan = load_plan(plan_path)
    with zipfile.ZipFile(source_path) as source:
        slide_parts = slide_parts_in_order(source)
        source_entries = {
            item.filename: source.read(item.filename) for item in source.infolist()
        }
        source_info = {item.filename: item for item in source.infolist()}

    slide_roots: dict[str, ET.Element] = {}
    applied: list[dict] = []
    for index, operation in enumerate(plan["operations"], 1):
        slide = int(operation["slide"])
        if not 1 <= slide <= len(slide_parts):
            raise ValueError(f"第 {index} 项 slide 超出范围")
        slide_part = slide_parts[slide - 1]
        root = slide_roots.setdefault(
            slide_part, parse_xml(source_entries[slide_part])
        )
        targets = {int(value) for value in operation["shapeIds"]}
        deleted: set[int] = set()
        delete_shape_ids(root, targets, deleted)
        missing = sorted(targets - deleted)
        if missing:
            raise ValueError(
                f"第 {index} 项未找到完整槽位对象：第 {slide} 页 {missing}"
            )
        applied.append(
            {
                "operationIndex": index,
                "slide": slide,
                "slotGroupId": operation.get("slotGroupId"),
                "deletedShapeIds": sorted(deleted),
                "contentShapeIds": operation.get("contentShapeIds", []),
                "decorationShapeIds": operation.get("decorationShapeIds", []),
                "status": "complete-slot-deleted",
            }
        )

    modified = {
        name: serialize_xml(root) for name, root in slide_roots.items()
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(
        tempfile.mkstemp(
            prefix=output_path.stem + "-",
            suffix=".pptx",
            dir=output_path.parent,
        )[1]
    )
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as target:
            for name, data in source_entries.items():
                target.writestr(source_info[name], modified.get(name, data))
        with zipfile.ZipFile(temporary) as check:
            bad_file = check.testzip()
            if bad_file:
                raise RuntimeError(f"PPTX 压缩包校验失败：{bad_file}")
        os.replace(temporary, output_path)
    finally:
        if temporary.exists():
            temporary.unlink()
    return {
        "source": str(source_path),
        "output": str(output_path),
        "operationCount": len(applied),
        "operations": applied,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="删除已经授权且内容缺失的完整可选槽位组。"
    )
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    report = apply_plan(args.input, args.plan, args.output)
    if args.report:
        report_path = args.report.expanduser().resolve()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"结构删除报告：{report_path}")
    print(
        f"已删除 {sum(len(item['deletedShapeIds']) for item in report['operations'])} "
        f"个槽位对象，写入 {report['output']}"
    )


if __name__ == "__main__":
    main()
