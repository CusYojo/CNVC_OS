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
    resolve_relationship_target,
    sha256_bytes,
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
IMAGE_REL = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
)
NOTES_SLIDE_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"
)
NOTES_MASTER_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"
)
IMAGE_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".svg": "image/svg+xml",
}


def xml_bytes(root: ET.Element) -> bytes:
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def content_types_bytes(root: ET.Element) -> bytes:
    raw = ET.tostring(root, encoding="unicode")
    match = re.search(
        r"<([A-Za-z_][\w.-]*):Types "
        r'xmlns:\1="http://schemas.openxmlformats.org/package/2006/content-types">',
        raw,
    )
    if match:
        prefix = match.group(1)
        raw = raw.replace(
            match.group(0),
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
            1,
        )
        raw = raw.replace(f"<{prefix}:", "<").replace(f"</{prefix}:", "</")
    return ('<?xml version="1.0" encoding="utf-8"?>' + raw).encode("utf-8")


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


def replacement_media_part(
    files: dict[str, bytes],
    asset: Path,
    asset_sha256: str,
) -> tuple[str, str]:
    extension = asset.suffix.lower()
    content_type = IMAGE_CONTENT_TYPES.get(extension)
    if content_type is None:
        raise ValueError(
            "图片替换只支持 PNG、JPEG、GIF、BMP、TIFF 或 SVG："
            f"{asset}"
        )
    normalized_extension = ".jpg" if extension == ".jpeg" else extension
    stem = f"ppt/media/replacement-{asset_sha256[:20]}"
    candidate = stem + normalized_extension
    suffix = 1
    while candidate in files and sha256_bytes(files[candidate]) != asset_sha256:
        candidate = f"{stem}-{suffix}{normalized_extension}"
        suffix += 1
    return candidate, content_type


def replace_picture(
    target: ET.Element,
    slide_root: ET.Element,
    slide_part: str,
    slide_relationships: ET.Element,
    files: dict[str, bytes],
    content_types: ET.Element,
    asset: Path,
    expected_sha256: str,
) -> tuple[str, str | None]:
    if local_name(target.tag) != "pic":
        raise ValueError("图片替换目标不是 p:pic")
    blip = target.find(".//a:blip", {"a": A_NS})
    if blip is None:
        raise ValueError("图片替换目标缺少 a:blip")
    asset_bytes = asset.read_bytes()
    actual_sha256 = sha256_bytes(asset_bytes)
    if expected_sha256 and actual_sha256 != expected_sha256:
        raise ValueError(
            f"图片素材 SHA-256 不一致：期望 {expected_sha256}，"
            f"实际 {actual_sha256}"
        )
    media_part, content_type = replacement_media_part(
        files,
        asset,
        actual_sha256,
    )
    files[media_part] = asset_bytes
    ensure_content_type(content_types, media_part, content_type)
    target_path = posixpath.relpath(
        media_part,
        posixpath.dirname(slide_part),
    )
    old_relation_id = blip.get(qn(R_NS, "embed"))
    old_relation = next(
        (
            relation
            for relation in slide_relationships.findall(
                qn(PKG_REL_NS, "Relationship")
            )
            if relation.get("Id") == old_relation_id
        ),
        None,
    )
    old_media_part = (
        resolve_relationship_target(slide_part, old_relation.get("Target", ""))
        if old_relation is not None
        else None
    )
    shared_count = sum(
        node.get(qn(R_NS, "embed")) == old_relation_id
        for node in slide_root.findall(".//a:blip", {"a": A_NS})
    )
    if (
        old_relation is not None
        and old_relation.get("Type") == IMAGE_REL
        and shared_count == 1
    ):
        old_relation.set("Target", target_path)
        relation_id = str(old_relation_id)
    else:
        relation_id = add_relationship(
            slide_relationships,
            IMAGE_REL,
            target_path,
        )
    blip.set(qn(R_NS, "embed"), relation_id)
    blip.attrib.pop(qn(R_NS, "link"), None)
    return actual_sha256, old_media_part


def source_part_for_relationship_part(rel_part: str) -> str:
    if rel_part == "_rels/.rels":
        return ""
    directory = posixpath.dirname(rel_part)
    parent = posixpath.dirname(directory)
    basename = posixpath.basename(rel_part)
    return posixpath.join(parent, basename[:-5])


def prune_unreferenced_media(
    files: dict[str, bytes],
    candidates: set[str],
    content_types: ET.Element,
) -> list[str]:
    referenced: set[str] = set()
    for name, raw in files.items():
        if not name.endswith(".rels"):
            continue
        try:
            root = ET.fromstring(raw)
        except ET.ParseError:
            continue
        source_part = source_part_for_relationship_part(name)
        for relation in root.findall(qn(PKG_REL_NS, "Relationship")):
            if relation.get("TargetMode") == "External":
                continue
            target = relation.get("Target", "")
            if source_part:
                referenced.add(resolve_relationship_target(source_part, target))
            else:
                referenced.add(target.lstrip("/"))
    removed: list[str] = []
    for candidate in sorted(candidates):
        if (
            candidate.startswith("ppt/media/")
            and candidate in files
            and candidate not in referenced
        ):
            del files[candidate]
            removed.append(candidate)
            normalized = "/" + candidate.lstrip("/")
            for override in list(content_types.findall(qn(CT_NS, "Override"))):
                if override.get("PartName") == normalized:
                    content_types.remove(override)
    return removed


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
    actual_template_sha256 = sha256_bytes(template.read_bytes())
    expected_template_sha256 = str(plan.get("templateSha256", ""))
    if not expected_template_sha256:
        raise ValueError("应用计划必须包含 templateSha256")
    if expected_template_sha256 != actual_template_sha256:
        raise ValueError(
            "应用计划与输入模板 SHA-256 不一致，拒绝写入："
            f"计划 {expected_template_sha256}，实际 {actual_template_sha256}"
        )
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
    slide_relationship_roots: dict[int, ET.Element] = {}
    content_types = ET.fromstring(files["[Content_Types].xml"])
    content_types_changed = False
    replaced_media_candidates: set[str] = set()
    applied: list[dict] = []
    for index, operation in enumerate(operations, 1):
        action = operation.get("action")
        if action not in {
            "replace_text",
            "replace_text_group",
            "add_disclaimer_textbox",
            "replace_image",
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
        if action == "replace_image":
            shape_id = int(operation.get("shapeId", 0))
            target = find_object(root, shape_id)
            if target is None:
                raise ValueError(
                    f"第 {index} 项未找到第 {page} 页 shapeId={shape_id}"
                )
            asset = Path(str(operation.get("asset", ""))).expanduser().resolve()
            if not asset.is_file():
                raise ValueError(f"第 {index} 项图片素材不存在：{asset}")
            slide_part = slides[page - 1]
            rel_part = relationship_part(slide_part)
            rel_root = slide_relationship_roots.setdefault(
                page,
                relation_root(files.get(rel_part)),
            )
            content_types_before = content_types_bytes(content_types)
            media_sha256, old_media_part = replace_picture(
                target,
                root,
                slide_part,
                rel_root,
                files,
                content_types,
                asset,
                str(operation.get("assetSha256", "")),
            )
            if content_types_bytes(content_types) != content_types_before:
                content_types_changed = True
            if old_media_part:
                replaced_media_candidates.add(old_media_part)
            applied.append(
                {
                    "operationIndex": index,
                    "slide": page,
                    "shapeId": shape_id,
                    "action": action,
                    "asset": str(asset),
                    "mediaSha256": media_sha256,
                    "status": "applied-in-place-openxml-media-relationship",
                }
            )
            continue
        targets = (
            operation.get("shapeIds", [])
            if action == "replace_text_group"
            else [operation.get("shapeId")]
        )
        primary_shape_id = (
            int(operation.get("primaryShapeId", targets[0]))
            if action == "replace_text_group" and targets
            else int(targets[0])
        )
        if action == "replace_text_group" and primary_shape_id not in {
            int(value) for value in targets
        }:
            raise ValueError(
                f"第 {index} 项 primaryShapeId 不属于 shapeIds"
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
            replacement = (
                str(operation.get("text", ""))
                if shape_id == primary_shape_id
                else ""
            )
            replace_text(body, replacement)
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
                        "cleared-secondary-text-fragment"
                        if action == "replace_text_group"
                        and shape_id != primary_shape_id
                        else "applied-in-place-openxml-cjk-language-normalized"
                        if re.search(r"[\u3400-\u9fff]", replacement)
                        else "applied-in-place-openxml"
                    ),
                }
            )
    for page, root in slide_roots.items():
        files[slides[page - 1]] = xml_bytes(root)
    for page, root in slide_relationship_roots.items():
        files[relationship_part(slides[page - 1])] = xml_bytes(root)
    pruned_media = prune_unreferenced_media(
        files,
        replaced_media_candidates,
        content_types,
    )
    if pruned_media:
        content_types_changed = True
    if content_types_changed:
        files["[Content_Types].xml"] = content_types_bytes(content_types)

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
            files["[Content_Types].xml"] = content_types_bytes(content_types)
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
                "prunedUnreferencedMedia": pruned_media,
                "operations": applied,
            },
        )
    print(f"已在原模板中应用 {len(applied)} 个白名单内容目标：{output}")


if __name__ == "__main__":
    main()
