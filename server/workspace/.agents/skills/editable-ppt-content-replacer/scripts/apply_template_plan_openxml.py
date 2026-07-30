#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import posixpath
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from openxml_runtime import (
    A_NS,
    CT_NS,
    P_NS,
    PKG_REL_NS,
    R_NS,
    add_text_box,
    add_relationship,
    ensure_content_type,
    find_object,
    local_name,
    notes_master_xml,
    notes_slide_xml,
    qn,
    read_json,
    relationship_part,
    render_pptx,
    replace_notes_text,
    replace_text,
    slide_names,
    write_json,
)


NOTES_SLIDE_REL = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"
)
NOTES_MASTER_REL = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster"
)
SLIDE_REL = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
)
NOTES_SLIDE_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"
)
NOTES_MASTER_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"
)


def xml_bytes(root: ET.Element) -> bytes:
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def relation_root(raw: bytes | None = None) -> ET.Element:
    if raw:
        return ET.fromstring(raw)
    return ET.Element(qn(PKG_REL_NS, "Relationships"))


def find_relation(
    root: ET.Element,
    relation_type: str,
) -> ET.Element | None:
    return next(
        (
            relation
            for relation in root.findall(qn(PKG_REL_NS, "Relationship"))
            if relation.get("Type") == relation_type
        ),
        None,
    )


def notes_target(slide_part: str, rel_root: ET.Element) -> str | None:
    relation = find_relation(rel_root, NOTES_SLIDE_REL)
    if relation is None:
        return None
    target = relation.get("Target", "")
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(
        posixpath.join(posixpath.dirname(slide_part), target)
    )


def next_notes_part(existing: set[str]) -> str:
    numbers = [
        int(match.group(1))
        for name in existing
        if (match := re.fullmatch(r"ppt/notesSlides/notesSlide(\d+)\.xml", name))
    ]
    return f"ppt/notesSlides/notesSlide{max(numbers, default=0) + 1}.xml"


def ensure_notes_master(
    files: dict[str, bytes],
    content_types: ET.Element,
    presentation: ET.Element,
    presentation_rels: ET.Element,
) -> str:
    masters = sorted(
        name
        for name in files
        if re.fullmatch(r"ppt/notesMasters/notesMaster\d+\.xml", name)
    )
    if masters:
        return masters[0]
    master_part = "ppt/notesMasters/notesMaster1.xml"
    files[master_part] = notes_master_xml()
    master_rels = relation_root()
    add_relationship(
        master_rels,
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme",
        "../theme/theme1.xml",
    )
    files[relationship_part(master_part)] = xml_bytes(master_rels)
    ensure_content_type(content_types, master_part, NOTES_MASTER_CONTENT_TYPE)
    relation_id = add_relationship(
        presentation_rels,
        NOTES_MASTER_REL,
        "notesMasters/notesMaster1.xml",
    )
    notes_list = presentation.find("./p:notesMasterIdLst", {"p": P_NS})
    if notes_list is None:
        notes_list = ET.Element(qn(P_NS, "notesMasterIdLst"))
        slide_size = presentation.find("./p:sldSz", {"p": P_NS})
        if slide_size is not None:
            presentation.insert(list(presentation).index(slide_size), notes_list)
        else:
            presentation.append(notes_list)
    ET.SubElement(
        notes_list,
        qn(P_NS, "notesMasterId"),
        {qn(R_NS, "id"): relation_id},
    )
    return master_part


def main() -> None:
    parser = argparse.ArgumentParser(
        description="使用公开 OpenXML 运行时在原 PPTX 中应用白名单文字替换。"
    )
    parser.add_argument("--template", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--render-dir", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--libreoffice")
    parser.add_argument("--pdftoppm")
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    args = parser.parse_args()

    template = args.template.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if template == output:
        raise ValueError("输出文件不能覆盖输入模板")
    plan = read_json(args.plan.expanduser().resolve())
    if plan.get("layoutPolicy") != "strict":
        raise ValueError("应用计划必须包含 layoutPolicy=strict")
    operations = plan.get("operations")
    if not isinstance(operations, list):
        raise ValueError("应用计划必须包含 operations 数组")

    with zipfile.ZipFile(template) as source:
        infos = source.infolist()
        files = {info.filename: source.read(info.filename) for info in infos}
    slides = sorted(
        (
            name
            for name in files
            if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
        ),
        key=lambda name: int(re.search(r"(\d+)", name).group(1)),
    )
    slide_roots: dict[int, ET.Element] = {}
    applied: list[dict] = []
    for index, operation in enumerate(operations, 1):
        action = operation.get("action")
        if action not in {
            "replace_text",
            "replace_text_group",
            "add_disclaimer_textbox",
        }:
            raise ValueError(f"第 {index} 项 {action} 没有安全的原位执行器")
        page = int(operation.get("slide", 0))
        if page < 1 or page > len(slides):
            raise ValueError(f"第 {index} 项页码超出范围：{page}")
        root = slide_roots.setdefault(page, ET.fromstring(files[slides[page - 1]]))
        if action == "add_disclaimer_textbox":
            shape_id = int(operation.get("shapeId", 0))
            add_text_box(
                root,
                shape_id,
                str(operation.get("name", "")),
                str(operation.get("text", "")),
                list(operation.get("bbox", [])),
                float(operation.get("fontSize", 12)),
                str(operation.get("fontFace", "微软雅黑")),
                str(operation.get("fontColor", "4B5563")),
            )
            applied.append(
                {
                    "operationIndex": index,
                    "slide": page,
                    "shapeId": shape_id,
                    "action": action,
                    "status": "added-controlled-disclaimer-openxml",
                }
            )
            continue
        targets = (
            operation.get("shapeIds", [])
            if action == "replace_text_group"
            else [operation.get("shapeId")]
        )
        for raw_shape_id in targets:
            shape_id = int(raw_shape_id)
            target = find_object(root, shape_id)
            if target is None:
                raise ValueError(
                    f"第 {index} 项未找到第 {page} 页 shapeId={shape_id}"
                )
            body = target.find("./p:txBody", {"p": P_NS})
            if body is None:
                raise ValueError(
                    f"第 {index} 项目标不是可编辑文字对象："
                    f"第 {page} 页 shapeId={shape_id}"
                )
            replace_text(body, str(operation.get("text", "")))
            replacement = str(operation.get("text", ""))
            if re.search(r"[\u3400-\u9fff]", replacement):
                matching_runs = [
                    run
                    for run in body.iter()
                    if local_name(run.tag) in {"r", "fld"}
                    and re.search(
                        r"[\u3400-\u9fff]",
                        "".join(
                            node.text or ""
                            for node in run.iter(qn(A_NS, "t"))
                        ),
                    )
                ]
                if not matching_runs or any(
                    (run.find("./a:rPr", {"a": A_NS}) is None)
                    or run.find("./a:rPr", {"a": A_NS}).get("lang") != "zh-CN"
                    for run in matching_runs
                ):
                    raise ValueError(
                        f"第 {index} 项中文替换未写入 zh-CN 语言标记："
                        f"第 {page} 页 shapeId={shape_id}"
                    )
            applied.append(
                {
                    "operationIndex": index,
                    "slide": page,
                    "shapeId": shape_id,
                    "action": action,
                    "status": (
                        "applied-in-place-openxml-cjk-language-normalized"
                        if re.search(r"[\u3400-\u9fff]", replacement)
                        else "applied-in-place-openxml"
                    ),
                }
            )
    for page, root in slide_roots.items():
        files[slides[page - 1]] = xml_bytes(root)

    source_notes = {
        int(page): str(value)
        for page, value in (plan.get("sourceNotes") or {}).items()
        if str(value).strip()
    }
    if source_notes:
        content_types = ET.fromstring(files["[Content_Types].xml"])
        presentation = ET.fromstring(files["ppt/presentation.xml"])
        presentation_rel_part = relationship_part("ppt/presentation.xml")
        presentation_rels = relation_root(files.get(presentation_rel_part))
        master_parts = sorted(
            name
            for name in files
            if re.fullmatch(r"ppt/notesMasters/notesMaster\d+\.xml", name)
        )
        master_part = master_parts[0] if master_parts else None
        content_types_changed = False
        presentation_changed = False
        existing = set(files)
        for page, note_text in source_notes.items():
            slide_part = slides[page - 1]
            rel_part = relationship_part(slide_part)
            rels = relation_root(files.get(rel_part))
            target = notes_target(slide_part, rels)
            if target and target in files:
                notes_root = ET.fromstring(files[target])
                replace_notes_text(notes_root, note_text)
                files[target] = xml_bytes(notes_root)
                continue
            if master_part is None:
                master_part = ensure_notes_master(
                    files,
                    content_types,
                    presentation,
                    presentation_rels,
                )
                content_types_changed = True
                presentation_changed = True
            target = next_notes_part(existing)
            existing.add(target)
            files[target] = notes_slide_xml(note_text)
            notes_rels = relation_root()
            add_relationship(
                notes_rels,
                SLIDE_REL,
                f"../slides/{posixpath.basename(slide_part)}",
            )
            add_relationship(
                notes_rels,
                NOTES_MASTER_REL,
                f"../notesMasters/{posixpath.basename(master_part)}",
            )
            files[relationship_part(target)] = xml_bytes(notes_rels)
            add_relationship(
                rels,
                NOTES_SLIDE_REL,
                f"../notesSlides/{posixpath.basename(target)}",
            )
            files[rel_part] = xml_bytes(rels)
            ensure_content_type(content_types, target, NOTES_SLIDE_CONTENT_TYPE)
            content_types_changed = True
        if content_types_changed:
            files["[Content_Types].xml"] = xml_bytes(content_types)
        if presentation_changed:
            files["ppt/presentation.xml"] = xml_bytes(presentation)
            files[presentation_rel_part] = xml_bytes(presentation_rels)

    output.parent.mkdir(parents=True, exist_ok=True)
    original_info = {info.filename: info for info in infos}
    with zipfile.ZipFile(output, "w") as target:
        for name, content in files.items():
            info = original_info.get(name)
            if info is not None:
                target.writestr(info, content)
            else:
                target.writestr(name, content, compress_type=zipfile.ZIP_DEFLATED)

    rendered = 0
    if args.render_dir:
        if not args.libreoffice or not args.pdftoppm:
            raise ValueError("渲染检查需要 --libreoffice 和 --pdftoppm")
        rendered = render_pptx(
            output,
            args.render_dir.expanduser().resolve(),
            args.libreoffice,
            args.pdftoppm,
            args.timeout_seconds,
        )
        if rendered != len(slides):
            raise RuntimeError(
                f"渲染页数不一致：期望 {len(slides)}，实际 {rendered}"
            )
    if args.report:
        write_json(
            args.report.expanduser().resolve(),
            {
                "template": str(template),
                "output": str(output),
                "runtime": "openxml-stdlib+libreoffice",
                "operationCount": len(applied),
                "sourceNotesSlideCount": len(source_notes),
                "renderedSlideCount": rendered,
                "operations": applied,
            },
        )
    print(f"已在原模板中应用 {len(applied)} 个白名单文字目标：{output}")


if __name__ == "__main__":
    main()
