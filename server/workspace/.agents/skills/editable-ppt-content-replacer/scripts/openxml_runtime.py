#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import json
import os
import posixpath
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart"
XML_NS = "http://www.w3.org/XML/1998/namespace"
EMU_PER_PIXEL = 9525

NS = {"p": P_NS, "a": A_NS, "r": R_NS, "c": C_NS}
OBJECT_TAGS = {"sp", "pic", "graphicFrame", "grpSp", "cxnSp"}

for prefix, namespace in (
    ("p", P_NS),
    ("a", A_NS),
    ("r", R_NS),
    ("c", C_NS),
    ("", PKG_REL_NS),
):
    ET.register_namespace(prefix, namespace)


def qn(namespace: str, name: str) -> str:
    return f"{{{namespace}}}{name}"


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def slide_number(name: str) -> int:
    match = re.search(r"slide(\d+)\.xml$", name)
    return int(match.group(1)) if match else 0


def slide_names(archive: zipfile.ZipFile) -> list[str]:
    fallback = sorted(
        (
            name
            for name in archive.namelist()
            if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
        ),
        key=slide_number,
    )
    try:
        presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
        rels = relationships(archive, "ppt/presentation.xml")
        ordered: list[str] = []
        for slide_id in presentation.findall("./p:sldIdLst/p:sldId", NS):
            relation_id = slide_id.get(qn(R_NS, "id"), "")
            relation = rels.get(relation_id)
            target = relation.get("target") if relation else None
            if target and target in archive.namelist():
                ordered.append(target)
        if len(ordered) == len(fallback) and set(ordered) == set(fallback):
            return ordered
    except (KeyError, ET.ParseError):
        pass
    return fallback


def relationship_part(part_name: str) -> str:
    directory = posixpath.dirname(part_name)
    return posixpath.join(
        directory,
        "_rels",
        posixpath.basename(part_name) + ".rels",
    )


def resolve_relationship_target(source_part: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(
        posixpath.join(posixpath.dirname(source_part), target)
    )


def relationships(
    archive: zipfile.ZipFile,
    source_part: str,
) -> dict[str, dict[str, str]]:
    rel_part = relationship_part(source_part)
    if rel_part not in archive.namelist():
        return {}
    root = ET.fromstring(archive.read(rel_part))
    result: dict[str, dict[str, str]] = {}
    for relation in root.findall(qn(PKG_REL_NS, "Relationship")):
        relation_id = relation.get("Id")
        if not relation_id:
            continue
        target = relation.get("Target", "")
        result[relation_id] = {
            "type": relation.get("Type", ""),
            "target": resolve_relationship_target(source_part, target),
        }
    return result


def direct_nonvisual(element: ET.Element) -> ET.Element | None:
    paths = {
        "sp": "./p:nvSpPr/p:cNvPr",
        "pic": "./p:nvPicPr/p:cNvPr",
        "graphicFrame": "./p:nvGraphicFramePr/p:cNvPr",
        "grpSp": "./p:nvGrpSpPr/p:cNvPr",
        "cxnSp": "./p:nvCxnSpPr/p:cNvPr",
    }
    path = paths.get(local_name(element.tag))
    return element.find(path, NS) if path else None


def direct_text_body(element: ET.Element) -> ET.Element | None:
    if local_name(element.tag) != "sp":
        return None
    return element.find("./p:txBody", NS)


def object_elements(root: ET.Element) -> list[ET.Element]:
    return [
        element
        for element in root.iter()
        if local_name(element.tag) in OBJECT_TAGS
        and direct_nonvisual(element) is not None
    ]


def object_id(element: ET.Element) -> int | None:
    nonvisual = direct_nonvisual(element)
    if nonvisual is None:
        return None
    try:
        return int(nonvisual.get("id", ""))
    except ValueError:
        return None


def text_body_text(text_body: ET.Element | None) -> str:
    if text_body is None:
        return ""
    paragraphs: list[str] = []
    for paragraph in text_body.findall("./a:p", NS):
        pieces = [
            node.text or ""
            for node in paragraph.iter(qn(A_NS, "t"))
        ]
        paragraphs.append("".join(pieces))
    while paragraphs and not paragraphs[-1]:
        paragraphs.pop()
    return "\n".join(paragraphs)


def text_style(text_body: ET.Element | None) -> dict:
    if text_body is None:
        return {
            "body": {},
            "paragraph": {},
            "paragraphText": {},
            "run": {"fontSize": 0, "signature": ""},
        }
    body_pr = text_body.find("./a:bodyPr", NS)
    paragraph = text_body.find("./a:p", NS)
    paragraph_pr = (
        paragraph.find("./a:pPr", NS) if paragraph is not None else None
    )
    run_pr = text_body.find(".//a:rPr", NS)
    if run_pr is None:
        run_pr = text_body.find(".//a:defRPr", NS)
    latin = run_pr.find("./a:latin", NS) if run_pr is not None else None
    east_asian = run_pr.find("./a:ea", NS) if run_pr is not None else None
    font_size = 0.0
    if run_pr is not None:
        try:
            font_size = float(run_pr.get("sz", "0")) / 100
        except ValueError:
            font_size = 0.0
    style_copy = copy.deepcopy(text_body)
    for text_node in style_copy.iter(qn(A_NS, "t")):
        text_node.text = ""
    # 语言标记属于校对和字体回退元数据，不是模板可见排版指纹。
    # 中文内容替换会把目标运行从模板遗留的 en-US 规范化为 zh-CN；
    # 保真校验仍需严格比较字体、字号、颜色、段落和几何属性。
    for style_node in style_copy.iter():
        if local_name(style_node.tag) in {"rPr", "defRPr", "endParaRPr"}:
            style_node.attrib.pop("lang", None)
    for parent in style_copy.iter():
        for child in list(parent):
            if (
                local_name(child.tag) == "rPr"
                and not child.attrib
                and len(child) == 0
            ):
                parent.remove(child)
    signature = sha256_bytes(ET.tostring(style_copy, encoding="utf-8"))
    return {
        "body": dict(body_pr.attrib) if body_pr is not None else {},
        "paragraph": (
            dict(paragraph_pr.attrib) if paragraph_pr is not None else {}
        ),
        "paragraphText": {},
        "run": {
            "fontSize": font_size,
            "bold": run_pr.get("b") if run_pr is not None else None,
            "italic": run_pr.get("i") if run_pr is not None else None,
            "typeface": (
                (east_asian or latin).get("typeface")
                if (east_asian is not None or latin is not None)
                else None
            ),
            "signature": signature,
        },
    }


def object_bbox(element: ET.Element) -> list[float]:
    tag = local_name(element.tag)
    paths = {
        "sp": "./p:spPr/a:xfrm",
        "pic": "./p:spPr/a:xfrm",
        "graphicFrame": "./p:xfrm",
        "grpSp": "./p:grpSpPr/a:xfrm",
        "cxnSp": "./p:spPr/a:xfrm",
    }
    transform = element.find(paths.get(tag, ""), NS)
    if transform is None:
        return [0.0, 0.0, 0.0, 0.0]
    offset = transform.find("./a:off", NS)
    extent = transform.find("./a:ext", NS)
    if offset is None or extent is None:
        return [0.0, 0.0, 0.0, 0.0]
    values = [
        float(offset.get("x", "0")) / EMU_PER_PIXEL,
        float(offset.get("y", "0")) / EMU_PER_PIXEL,
        float(extent.get("cx", "0")) / EMU_PER_PIXEL,
        float(extent.get("cy", "0")) / EMU_PER_PIXEL,
    ]
    return [round(value, 2) for value in values]


def background_candidate(
    kind: str,
    bbox: list[float],
    slide_width_emu: int,
    slide_height_emu: int,
    z_index: int,
) -> dict:
    """Conservatively flag slide-local objects that may carry template styling.

    This is a review hint, not an instruction to keep or delete an object.
    Background decisions remain explicit in the replacement manifest.
    """
    slide_width = float(slide_width_emu) / EMU_PER_PIXEL
    slide_height = float(slide_height_emu) / EMU_PER_PIXEL
    if (
        not kind.startswith("shape:")
        and kind != "picture"
        or slide_width <= 0
        or slide_height <= 0
        or len(bbox) != 4
    ):
        return {"isCandidate": False}
    x, y, width, height = (float(value) for value in bbox)
    if width <= 0 or height <= 0:
        return {"isCandidate": False}
    coverage = min(1.0, (width * height) / (slide_width * slide_height))
    tolerance_x = slide_width * 0.025
    tolerance_y = slide_height * 0.025
    touches_left = x <= tolerance_x
    touches_right = x + width >= slide_width - tolerance_x
    touches_top = y <= tolerance_y
    touches_bottom = y + height >= slide_height - tolerance_y
    early_layer = z_index <= 8
    full_bleed = (
        width >= slide_width * 0.94
        and height >= slide_height * 0.94
        and touches_left
        and touches_right
        and touches_top
        and touches_bottom
    )
    horizontal_band = (
        width >= slide_width * 0.94
        and height >= slide_height * 0.08
        and touches_left
        and touches_right
        and (touches_top or touches_bottom)
    )
    vertical_band = (
        height >= slide_height * 0.94
        and width >= slide_width * 0.08
        and touches_top
        and touches_bottom
        and (touches_left or touches_right)
    )
    large_early_layer = early_layer and coverage >= 0.62
    reasons = []
    if full_bleed:
        reasons.append("full-bleed")
    if horizontal_band:
        reasons.append("edge-horizontal-band")
    if vertical_band:
        reasons.append("edge-vertical-band")
    if large_early_layer:
        reasons.append("large-early-layer")
    return {
        "isCandidate": bool(reasons),
        "reasons": reasons,
        "coverage": round(coverage, 4),
        "zIndex": z_index,
    }


def object_kind(element: ET.Element) -> str:
    tag = local_name(element.tag)
    if tag == "pic":
        return "picture"
    if tag == "graphicFrame":
        data = element.find(".//a:graphicData", NS)
        uri = data.get("uri", "") if data is not None else ""
        if "table" in uri.lower():
            return "table"
        if "chart" in uri.lower() or element.find(".//c:chart", {
            "c": "http://schemas.openxmlformats.org/drawingml/2006/chart"
        }) is not None:
            return "chart"
        return "shape:graphic-frame"
    if tag == "grpSp":
        return "shape:group"
    if tag == "cxnSp":
        return "shape:connector"
    if direct_text_body(element) is not None:
        return "shape:textbox"
    return "shape:vector"


def object_media(
    archive: zipfile.ZipFile,
    element: ET.Element,
    slide_relationships: dict[str, dict[str, str]],
) -> str | None:
    if local_name(element.tag) != "pic":
        return None
    blip = element.find(".//a:blip", NS)
    if blip is None:
        return None
    relation_id = blip.get(qn(R_NS, "embed")) or blip.get(qn(R_NS, "link"))
    relation = slide_relationships.get(relation_id or "")
    target = relation.get("target") if relation else None
    if not target or target not in archive.namelist():
        return None
    return sha256_bytes(archive.read(target))


def object_data(
    archive: zipfile.ZipFile,
    element: ET.Element,
    slide_relationships: dict[str, dict[str, str]],
) -> dict | None:
    kind = object_kind(element)
    if kind == "table":
        rows: list[list[str]] = []
        for row in element.findall(".//a:tbl/a:tr", NS):
            values: list[str] = []
            for cell in row.findall("./a:tc", NS):
                paragraphs: list[str] = []
                for paragraph in cell.findall(".//a:p", NS):
                    paragraphs.append(
                        "".join(
                            node.text or ""
                            for node in paragraph.iter(qn(A_NS, "t"))
                        )
                    )
                values.append("\n".join(paragraphs))
            rows.append(values)
        encoded = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        return {
            "kind": "table",
            "values": rows,
            "signature": sha256_bytes(encoded),
        }
    if kind != "chart":
        return None
    chart = element.find(".//c:chart", NS)
    relation_id = chart.get(qn(R_NS, "id")) if chart is not None else None
    relation = slide_relationships.get(relation_id or "")
    target = relation.get("target") if relation else None
    if not target or target not in archive.namelist():
        return {"kind": "chart", "values": [], "formulas": [], "signature": ""}
    root = ET.fromstring(archive.read(target))
    values = [node.text or "" for node in root.findall(".//c:v", NS)]
    formulas = [node.text or "" for node in root.findall(".//c:f", NS)]
    embedded_hashes: list[str] = []
    for chart_relation in relationships(archive, target).values():
        embedded = chart_relation.get("target")
        if (
            chart_relation.get("type", "").endswith("/package")
            and embedded in archive.namelist()
        ):
            embedded_hashes.append(sha256_bytes(archive.read(embedded)))
    payload = {
        "values": values,
        "formulas": formulas,
        "embeddedWorkbookSha256": sorted(embedded_hashes),
    }
    return {
        "kind": "chart",
        **payload,
        "signature": sha256_bytes(
            json.dumps(
                payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8")
        ),
        "part": target,
    }


def background_signature(root: ET.Element | None) -> str:
    if root is None:
        return ""
    background = root.find("./p:cSld/p:bg", NS)
    if background is None:
        return ""
    return sha256_bytes(ET.tostring(background, encoding="utf-8"))


def analyze_pptx(path: Path) -> dict:
    source_bytes = path.read_bytes()
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        presentation_root = ET.fromstring(archive.read("ppt/presentation.xml"))
        slide_size = presentation_root.find("./p:sldSz", NS)
        width_emu = int(slide_size.get("cx", "0")) if slide_size is not None else 0
        height_emu = int(slide_size.get("cy", "0")) if slide_size is not None else 0
        media_ids = sorted(
            {
                sha256_bytes(archive.read(name))
                for name in names
                if re.fullmatch(r"ppt/media/[^/]+", name)
            }
        )
        note_texts: list[dict[str, str]] = []
        for name in names:
            if not name.startswith("ppt/notesSlides/") or not name.endswith(".xml"):
                continue
            try:
                note_root = ET.fromstring(archive.read(name))
            except ET.ParseError:
                continue
            text = "\n".join(
                node.text or ""
                for node in note_root.iter(qn(A_NS, "t"))
                if (node.text or "").strip()
            )
            if text:
                note_texts.append({"part": name, "text": text})
        slides: list[dict] = []
        for index, part_name in enumerate(slide_names(archive), 1):
            root = ET.fromstring(archive.read(part_name))
            rels = relationships(archive, part_name)
            layout = next(
                (
                    relation["target"]
                    for relation in rels.values()
                    if relation["type"].endswith("/slideLayout")
                ),
                "",
            )
            layout_root = (
                ET.fromstring(archive.read(layout))
                if layout and layout in archive.namelist()
                else None
            )
            layout_relationships = (
                relationships(archive, layout) if layout_root is not None else {}
            )
            master = next(
                (
                    relation["target"]
                    for relation in layout_relationships.values()
                    if relation["type"].endswith("/slideMaster")
                ),
                "",
            )
            master_root = (
                ET.fromstring(archive.read(master))
                if master and master in archive.namelist()
                else None
            )
            objects: list[dict] = []
            for z_index, element in enumerate(object_elements(root), 1):
                shape_id = object_id(element)
                if shape_id is None or shape_id <= 0:
                    continue
                nonvisual = direct_nonvisual(element)
                body = direct_text_body(element)
                kind = object_kind(element)
                bbox = object_bbox(element)
                objects.append(
                    {
                        "shapeId": shape_id,
                        "name": nonvisual.get("name", "") if nonvisual is not None else "",
                        "kind": kind,
                        "bbox": bbox,
                        "zIndex": z_index,
                        "backgroundCandidate": background_candidate(
                            kind,
                            bbox,
                            width_emu,
                            height_emu,
                            z_index,
                        ),
                        "text": text_body_text(body),
                        "textStyle": text_style(body),
                        "media": object_media(archive, element, rels),
                        "data": object_data(archive, element, rels),
                    }
                )
            title = next(
                (
                    str(item["text"]).strip()
                    for item in objects
                    if str(item["text"]).strip()
                ),
                f"Slide {index}",
            )
            slides.append(
                {
                    "number": index,
                    "title": title,
                    "layoutId": layout,
                    "masterId": master,
                    "backgroundSignatures": {
                        "slide": background_signature(root),
                        "layout": background_signature(layout_root),
                        "master": background_signature(master_root),
                    },
                    "widthEmu": width_emu,
                    "heightEmu": height_emu,
                    "objects": objects,
                }
            )
        return {
            "sha256": sha256_bytes(source_bytes),
            "slideCount": len(slides),
            "layoutCount": sum(
                bool(re.fullmatch(r"ppt/slideLayouts/slideLayout\d+\.xml", name))
                for name in names
            ),
            "masterCount": sum(
                bool(re.fullmatch(r"ppt/slideMasters/slideMaster\d+\.xml", name))
                for name in names
            ),
            "mediaIds": media_ids,
            "noteTexts": note_texts,
            "slides": slides,
        }


def find_object(root: ET.Element, shape_id: int) -> ET.Element | None:
    for element in object_elements(root):
        if object_id(element) == shape_id:
            return element
    return None


def _text_run_for_node(
    text_body: ET.Element,
    text_node: ET.Element,
) -> ET.Element | None:
    for element in text_body.iter():
        if local_name(element.tag) not in {"r", "fld"}:
            continue
        if text_node in element.iter(qn(A_NS, "t")):
            return element
    return None


def replace_text(text_body: ET.Element, value: str) -> None:
    nodes = list(text_body.iter(qn(A_NS, "t")))
    if not nodes:
        paragraph = text_body.find("./a:p", NS)
        if paragraph is None:
            paragraph = ET.SubElement(text_body, qn(A_NS, "p"))
        run = ET.SubElement(paragraph, qn(A_NS, "r"))
        nodes = [ET.SubElement(run, qn(A_NS, "t"))]
    for node in nodes:
        node.text = ""
        node.attrib.pop(qn(XML_NS, "space"), None)
    nodes[0].text = value
    if value[:1].isspace() or value[-1:].isspace():
        nodes[0].set(qn(XML_NS, "space"), "preserve")
    if re.search(r"[\u3400-\u9fff]", value):
        run = _text_run_for_node(text_body, nodes[0])
        if run is None:
            raise ValueError("中文替换目标缺少可编辑文字运行")
        run_properties = run.find("./a:rPr", NS)
        if run_properties is None:
            run_properties = ET.Element(qn(A_NS, "rPr"))
            run.insert(0, run_properties)
        # 语言标记不改变字体、字号、颜色、坐标或段落样式，但可避免
        # PowerPoint/WPS 将中文替换内容按英文校对和字体回退处理。
        run_properties.set("lang", "zh-CN")


def add_text_box(
    root: ET.Element,
    shape_id: int,
    name: str,
    value: str,
    bbox: list[float],
    font_size: float = 12,
    font_face: str = "微软雅黑",
    font_color: str = "4B5563",
) -> ET.Element:
    if find_object(root, shape_id) is not None:
        raise ValueError(f"新增文本框 shapeId={shape_id} 已存在")
    if len(bbox) != 4 or any(float(item) < 0 for item in bbox):
        raise ValueError("新增文本框 bbox 必须包含四个非负像素值")
    if float(bbox[2]) <= 0 or float(bbox[3]) <= 0:
        raise ValueError("新增文本框宽度和高度必须大于零")
    if not re.fullmatch(r"[0-9A-Fa-f]{6}", font_color):
        raise ValueError("新增文本框 fontColor 必须是六位十六进制颜色")
    tree = root.find("./p:cSld/p:spTree", NS)
    if tree is None:
        raise ValueError("幻灯片缺少 p:spTree，无法新增责任声明文本框")

    shape = ET.Element(qn(P_NS, "sp"))
    nv_shape = ET.SubElement(shape, qn(P_NS, "nvSpPr"))
    ET.SubElement(
        nv_shape,
        qn(P_NS, "cNvPr"),
        {"id": str(shape_id), "name": name},
    )
    ET.SubElement(nv_shape, qn(P_NS, "cNvSpPr"), {"txBox": "1"})
    ET.SubElement(nv_shape, qn(P_NS, "nvPr"))

    shape_properties = ET.SubElement(shape, qn(P_NS, "spPr"))
    transform = ET.SubElement(shape_properties, qn(A_NS, "xfrm"))
    ET.SubElement(
        transform,
        qn(A_NS, "off"),
        {
            "x": str(round(float(bbox[0]) * EMU_PER_PIXEL)),
            "y": str(round(float(bbox[1]) * EMU_PER_PIXEL)),
        },
    )
    ET.SubElement(
        transform,
        qn(A_NS, "ext"),
        {
            "cx": str(round(float(bbox[2]) * EMU_PER_PIXEL)),
            "cy": str(round(float(bbox[3]) * EMU_PER_PIXEL)),
        },
    )
    geometry = ET.SubElement(
        shape_properties,
        qn(A_NS, "prstGeom"),
        {"prst": "rect"},
    )
    ET.SubElement(geometry, qn(A_NS, "avLst"))
    ET.SubElement(shape_properties, qn(A_NS, "noFill"))
    line = ET.SubElement(shape_properties, qn(A_NS, "ln"))
    ET.SubElement(line, qn(A_NS, "noFill"))

    text_body = ET.SubElement(shape, qn(P_NS, "txBody"))
    ET.SubElement(
        text_body,
        qn(A_NS, "bodyPr"),
        {
            "wrap": "square",
            "rtlCol": "0",
            "anchor": "t",
            "lIns": "0",
            "rIns": "0",
            "tIns": "0",
            "bIns": "0",
        },
    )
    ET.SubElement(text_body, qn(A_NS, "lstStyle"))
    size = str(max(800, round(float(font_size) * 100)))
    for line_text in value.splitlines() or [""]:
        paragraph = ET.SubElement(text_body, qn(A_NS, "p"))
        ET.SubElement(paragraph, qn(A_NS, "pPr"), {"algn": "l"})
        run = ET.SubElement(paragraph, qn(A_NS, "r"))
        run_properties = ET.SubElement(
            run,
            qn(A_NS, "rPr"),
            {"lang": "zh-CN", "sz": size, "dirty": "0"},
        )
        solid_fill = ET.SubElement(run_properties, qn(A_NS, "solidFill"))
        ET.SubElement(
            solid_fill,
            qn(A_NS, "srgbClr"),
            {"val": font_color.upper()},
        )
        ET.SubElement(run_properties, qn(A_NS, "latin"), {"typeface": font_face})
        ET.SubElement(run_properties, qn(A_NS, "ea"), {"typeface": font_face})
        ET.SubElement(run_properties, qn(A_NS, "cs"), {"typeface": font_face})
        text_node = ET.SubElement(run, qn(A_NS, "t"))
        text_node.text = line_text
        ET.SubElement(
            paragraph,
            qn(A_NS, "endParaRPr"),
            {"lang": "zh-CN", "sz": size, "dirty": "0"},
        )
    tree.append(shape)
    return shape


def replace_notes_text(root: ET.Element, value: str) -> None:
    body_shape = None
    for shape in root.findall(".//p:sp", NS):
        placeholder = shape.find("./p:nvSpPr/p:nvPr/p:ph", NS)
        if placeholder is not None and placeholder.get("type") == "body":
            body_shape = shape
            break
    if body_shape is None:
        raise RuntimeError("备注页缺少 body 占位符")
    body = body_shape.find("./p:txBody", NS)
    if body is None:
        body = ET.SubElement(body_shape, qn(P_NS, "txBody"))
        ET.SubElement(body, qn(A_NS, "bodyPr"))
        ET.SubElement(body, qn(A_NS, "lstStyle"))
    existing_text = text_body_text(body).strip()
    source_block = str(value).strip()
    if re.search(r"\[Sources\].*?\[/Sources\]", existing_text, flags=re.DOTALL):
        combined_text = re.sub(
            r"\[Sources\].*?\[/Sources\]",
            source_block,
            existing_text,
            flags=re.DOTALL,
        )
    elif existing_text:
        combined_text = f"{existing_text}\n{source_block}"
    else:
        combined_text = source_block
    paragraphs = body.findall("./a:p", NS)
    paragraph_template = copy.deepcopy(paragraphs[0]) if paragraphs else None
    for paragraph in paragraphs:
        body.remove(paragraph)
    for line in combined_text.splitlines() or [""]:
        paragraph = (
            copy.deepcopy(paragraph_template)
            if paragraph_template is not None
            else ET.Element(qn(A_NS, "p"))
        )
        text_nodes = list(paragraph.iter(qn(A_NS, "t")))
        if not text_nodes:
            run = ET.SubElement(paragraph, qn(A_NS, "r"))
            text_nodes = [ET.SubElement(run, qn(A_NS, "t"))]
        for node in text_nodes:
            node.text = ""
        text_nodes[0].text = line
        body.append(paragraph)


def next_relationship_id(root: ET.Element, prefix: str = "rId") -> str:
    existing = {
        relation.get("Id", "")
        for relation in root.findall(qn(PKG_REL_NS, "Relationship"))
    }
    index = 1
    while f"{prefix}{index}" in existing:
        index += 1
    return f"{prefix}{index}"


def add_relationship(
    root: ET.Element,
    relation_type: str,
    target: str,
) -> str:
    relation_id = next_relationship_id(root)
    ET.SubElement(
        root,
        qn(PKG_REL_NS, "Relationship"),
        {"Id": relation_id, "Type": relation_type, "Target": target},
    )
    return relation_id


def notes_slide_xml(notes_text: str) -> bytes:
    root = ET.Element(qn(P_NS, "notes"))
    common = ET.SubElement(root, qn(P_NS, "cSld"))
    tree = ET.SubElement(common, qn(P_NS, "spTree"))
    nv_group = ET.SubElement(tree, qn(P_NS, "nvGrpSpPr"))
    ET.SubElement(nv_group, qn(P_NS, "cNvPr"), {"id": "1", "name": ""})
    ET.SubElement(nv_group, qn(P_NS, "cNvGrpSpPr"))
    ET.SubElement(nv_group, qn(P_NS, "nvPr"))
    group_properties = ET.SubElement(tree, qn(P_NS, "grpSpPr"))
    ET.SubElement(group_properties, qn(A_NS, "xfrm"))
    for shape_id, name, placeholder_type, index in (
        ("2", "Slide Image Placeholder", "sldImg", "0"),
        ("3", "Notes Placeholder", "body", "1"),
        ("4", "Slide Number Placeholder", "sldNum", "5"),
    ):
        shape = ET.SubElement(tree, qn(P_NS, "sp"))
        nv_shape = ET.SubElement(shape, qn(P_NS, "nvSpPr"))
        ET.SubElement(
            nv_shape,
            qn(P_NS, "cNvPr"),
            {"id": shape_id, "name": name},
        )
        ET.SubElement(nv_shape, qn(P_NS, "cNvSpPr"))
        nv_props = ET.SubElement(nv_shape, qn(P_NS, "nvPr"))
        ET.SubElement(
            nv_props,
            qn(P_NS, "ph"),
            {"type": placeholder_type, "idx": index},
        )
        ET.SubElement(shape, qn(P_NS, "spPr"))
        if placeholder_type in {"body", "sldNum"}:
            body = ET.SubElement(shape, qn(P_NS, "txBody"))
            ET.SubElement(body, qn(A_NS, "bodyPr"))
            ET.SubElement(body, qn(A_NS, "lstStyle"))
            if placeholder_type == "body":
                for line in notes_text.splitlines() or [""]:
                    paragraph = ET.SubElement(body, qn(A_NS, "p"))
                    run = ET.SubElement(paragraph, qn(A_NS, "r"))
                    ET.SubElement(run, qn(A_NS, "t")).text = line
            else:
                ET.SubElement(body, qn(A_NS, "p"))
    color_map = ET.SubElement(root, qn(P_NS, "clrMapOvr"))
    ET.SubElement(color_map, qn(A_NS, "masterClrMapping"))
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def notes_master_xml() -> bytes:
    root = ET.Element(qn(P_NS, "notesMaster"))
    common = ET.SubElement(root, qn(P_NS, "cSld"))
    tree = ET.SubElement(common, qn(P_NS, "spTree"))
    nv_group = ET.SubElement(tree, qn(P_NS, "nvGrpSpPr"))
    ET.SubElement(nv_group, qn(P_NS, "cNvPr"), {"id": "1", "name": ""})
    ET.SubElement(nv_group, qn(P_NS, "cNvGrpSpPr"))
    ET.SubElement(nv_group, qn(P_NS, "nvPr"))
    group_properties = ET.SubElement(tree, qn(P_NS, "grpSpPr"))
    ET.SubElement(group_properties, qn(A_NS, "xfrm"))
    for shape_id, placeholder_type, index in (
        ("2", "sldImg", "2"),
        ("3", "body", "3"),
        ("4", "sldNum", "5"),
    ):
        shape = ET.SubElement(tree, qn(P_NS, "sp"))
        nv_shape = ET.SubElement(shape, qn(P_NS, "nvSpPr"))
        ET.SubElement(
            nv_shape,
            qn(P_NS, "cNvPr"),
            {"id": shape_id, "name": f"{placeholder_type} Placeholder"},
        )
        ET.SubElement(nv_shape, qn(P_NS, "cNvSpPr"))
        nv_props = ET.SubElement(nv_shape, qn(P_NS, "nvPr"))
        ET.SubElement(
            nv_props,
            qn(P_NS, "ph"),
            {"type": placeholder_type, "idx": index},
        )
        ET.SubElement(shape, qn(P_NS, "spPr"))
        body = ET.SubElement(shape, qn(P_NS, "txBody"))
        ET.SubElement(body, qn(A_NS, "bodyPr"))
        ET.SubElement(body, qn(A_NS, "lstStyle"))
        ET.SubElement(body, qn(A_NS, "p"))
    ET.SubElement(
        root,
        qn(P_NS, "clrMap"),
        {
            "bg1": "lt1",
            "tx1": "dk1",
            "bg2": "lt2",
            "tx2": "dk2",
            "accent1": "accent1",
            "accent2": "accent2",
            "accent3": "accent3",
            "accent4": "accent4",
            "accent5": "accent5",
            "accent6": "accent6",
            "hlink": "hlink",
            "folHlink": "folHlink",
        },
    )
    notes_style = ET.SubElement(root, qn(P_NS, "notesStyle"))
    level = ET.SubElement(notes_style, qn(A_NS, "lvl1pPr"), {"marL": "0"})
    ET.SubElement(level, qn(A_NS, "defRPr"), {"sz": "1200"})
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def ensure_content_type(
    root: ET.Element,
    part_name: str,
    content_type: str,
) -> None:
    normalized = "/" + part_name.lstrip("/")
    extension = posixpath.splitext(part_name)[1].lstrip(".").lower()
    for default in root.findall(qn(CT_NS, "Default")):
        if (
            str(default.get("Extension", "")).lower() == extension
            and default.get("ContentType") == content_type
        ):
            return
    for override in root.findall(qn(CT_NS, "Override")):
        if override.get("PartName") == normalized:
            return
    ET.SubElement(
        root,
        qn(CT_NS, "Override"),
        {"PartName": normalized, "ContentType": content_type},
    )


def render_pptx(
    pptx_path: Path,
    render_dir: Path,
    libreoffice: str,
    pdftoppm: str,
    timeout_seconds: int = 1800,
) -> int:
    render_dir.mkdir(parents=True, exist_ok=True)
    for old in render_dir.glob("slide-*.png"):
        old.unlink()
    with tempfile.TemporaryDirectory(prefix="pptx-render-") as directory:
        temporary = Path(directory)
        profile = temporary / "lo-profile"
        profile.mkdir()
        command = [
            libreoffice,
            "--headless",
            f"-env:UserInstallation={profile.as_uri()}",
            "--convert-to",
            "pdf",
            "--outdir",
            str(temporary),
            str(pptx_path),
        ]
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
        )
        if result.returncode:
            raise RuntimeError(
                "LibreOffice 渲染失败："
                + (result.stderr or result.stdout)[-4000:]
            )
        pdf_candidates = list(temporary.glob("*.pdf"))
        if not pdf_candidates:
            raise RuntimeError("LibreOffice 未生成用于视觉 QA 的 PDF")
        result = subprocess.run(
            [
                pdftoppm,
                "-png",
                "-r",
                "120",
                str(pdf_candidates[0]),
                str(render_dir / "slide"),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
        )
        if result.returncode:
            raise RuntimeError(
                "Poppler 渲染失败："
                + (result.stderr or result.stdout)[-4000:]
            )
    renders = sorted(
        render_dir.glob("slide-*.png"),
        key=lambda item: int(re.search(r"(\d+)$", item.stem).group(1)),
    )
    if not renders:
        raise RuntimeError("PPTX 视觉 QA 未生成任何页面图片")
    return len(renders)
