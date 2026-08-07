#!/usr/bin/env python3
"""Validate investment-proposal DOCX structure and table usability."""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}
Q = lambda name: f"{{{W}}}{name}"

HEADINGS = [
    "一、基本情况简介", "（一）公司简介", "（二）核心团队", "（三）公司股权结构", "（四）产品及技术",
    "（五）运营摘要", "（六）财务摘要", "二、交易条件", "（一）历史融资情况", "（二）本轮公司估值和投资方案",
    "（三）风险控制及保护性条款", "三、公司业务计划", "（一）经营预测与回报测算", "（二）可比公司估值比较",
    "四、项目亮点总结", "五、风险提示与对策", "六、结论",
]


def issue(code: str, message: str, location: str) -> dict[str, str]:
    return {"code": code, "message": message, "location": location}


def text_of(node: ET.Element) -> str:
    return "".join(t.text or "" for t in node.findall(".//w:t", NS)).strip()


def jc_of(paragraph: ET.Element) -> str | None:
    jc = paragraph.find("./w:pPr/w:jc", NS)
    return jc.get(Q("val")) if jc is not None else None


def numeric_text(value: str) -> bool:
    cleaned = re.sub(r"\s+", "", value)
    if cleaned.endswith(("年", "月", "日")):
        return False
    return bool(re.fullmatch(r"(?:约|人民币)?[-+]?\d[\d,.]*(?:万元|亿元|元|%|％|倍)?", cleaned))


def style_font(styles: ET.Element, style_id: str) -> str | None:
    for style in styles.findall("w:style", NS):
        if style.get(Q("styleId")) == style_id:
            fonts = style.find("./w:rPr/w:rFonts", NS)
            if fonts is None:
                return None
            return fonts.get(Q("eastAsia")) or fonts.get(Q("ascii"))
    return None


def style_font_by_name(styles: ET.Element, style_name: str) -> str | None:
    for style in styles.findall("w:style", NS):
        name = style.find("w:name", NS)
        if name is not None and name.get(Q("val")) == style_name:
            fonts = style.find("./w:rPr/w:rFonts", NS)
            if fonts is None:
                return None
            return fonts.get(Q("eastAsia")) or fonts.get(Q("ascii"))
    return None


def validate(docx: Path, manifest: dict[str, Any] | None, render_dir: Path | None) -> dict[str, Any]:
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    try:
        with zipfile.ZipFile(docx) as archive:
            names = set(archive.namelist())
            document = ET.fromstring(archive.read("word/document.xml"))
            styles = ET.fromstring(archive.read("word/styles.xml"))
            settings = ET.fromstring(archive.read("word/settings.xml"))
            footer_xml = "".join(archive.read(n).decode("utf-8", "ignore") for n in names if re.fullmatch(r"word/footer\d+\.xml", n))
    except Exception as exc:
        return {"status": "fail", "errors": [issue("DOCX_READ_ERROR", str(exc), str(docx))], "warnings": [], "metrics": {}}

    paragraphs = document.findall(".//w:body/w:p", NS)
    ptexts = [text_of(p) for p in paragraphs]
    actual = [t for t in ptexts if t in HEADINGS]
    if actual != HEADINGS:
        errors.append(issue("HEADING_TREE", f"expected fixed 17 headings, got {len(actual)} in a different sequence", "word/document.xml"))

    sects = document.findall(".//w:sectPr", NS)
    if len(sects) != 1:
        errors.append(issue("SECTION_COUNT", f"expected one section, got {len(sects)}", "word/document.xml"))
    elif sects:
        size = sects[0].find("w:pgSz", NS)
        margins = sects[0].find("w:pgMar", NS)
        if size is None or size.get(Q("w")) != "11906" or size.get(Q("h")) != "16838":
            errors.append(issue("PAGE_GEOMETRY", "page must be A4 portrait 11906x16838 DXA", "w:sectPr"))
        exact_case = style_font_by_name(styles, "星实-正文") is not None
        expected = (
            {"top": "1440", "bottom": "1497", "left": "1797", "right": "1797"}
            if exact_case else
            {"top": "1440", "bottom": "1440", "left": "1800", "right": "1800"}
        )
        if margins is None or any(margins.get(Q(k)) != v for k, v in expected.items()):
            errors.append(issue("PAGE_MARGINS", f"margins must match active format authority: {expected}", "w:sectPr"))

    body_font = style_font_by_name(styles, "星实-正文") or style_font(styles, "Normal")
    h2_font = style_font_by_name(styles, "星实-二标") or style_font(styles, "Heading2") or style_font(styles, "2")
    if body_font and h2_font and body_font.casefold() == h2_font.casefold():
        errors.append(issue("HEADING_FONT_HIERARCHY", f"Heading2 and body both use {body_font}", "word/styles.xml"))

    all_text = "\n".join(ptexts)
    banned = ["〔资料记载〕", "〔分析判断〕", "〔待核验〕", "〔资料缺口〕", "项目资料显示", "会议纪要记载", "综上所述"]
    for token in banned:
        if token in all_text:
            errors.append(issue("BANNED_VISIBLE_TEXT", f"visible internal or formulaic text: {token}", "document body"))

    if "PAGE" not in footer_xml:
        errors.append(issue("PAGE_FIELD", "footer PAGE field is missing", "word/footer*.xml"))
    if settings.find("w:updateFields", NS) is None:
        warnings.append(issue("FIELD_UPDATE", "updateFields is not enabled", "word/settings.xml"))

    tables = document.findall(".//w:tbl", NS)
    plans = manifest.get("table_plans", []) if isinstance(manifest, dict) else []
    if plans and len(plans) != len(tables):
        errors.append(issue("TABLE_PLAN_COUNT", f"manifest has {len(plans)} plans but DOCX has {len(tables)} tables", "tables"))

    for index, table in enumerate(tables):
        grid = [int(col.get(Q("w"))) for col in table.findall("./w:tblGrid/w:gridCol", NS) if col.get(Q("w"))]
        location = f"table[{index + 1}]"
        if len(grid) >= 3 and max(grid) - min(grid) <= 1:
            errors.append(issue("EQUAL_WIDTH_COLUMNS", "three or more columns use equal widths; apply role-based widths", location))

        rows = table.findall("w:tr", NS)
        if rows:
            header_flag = rows[0].find("./w:trPr/w:tblHeader", NS)
            if header_flag is None:
                errors.append(issue("REPEATING_HEADER", "first row is not marked as a repeating header", location))
        for row_index, row in enumerate(rows[1:], start=2):
            for col_index, cell in enumerate(row.findall("w:tc", NS), start=1):
                value = text_of(cell)
                if numeric_text(value):
                    alignments = [jc_of(p) for p in cell.findall("w:p", NS)]
                    if not alignments or any(a != "right" for a in alignments):
                        errors.append(issue("NUMERIC_ALIGNMENT", f"numeric value {value!r} is not right aligned", f"{location}.row[{row_index}].col[{col_index}]"))
                        break

        if index < len(plans):
            columns = plans[index].get("columns", [])
            weights = [float(c.get("width_weight", 0)) for c in columns if isinstance(c, dict)]
            if len(weights) == len(grid) and sum(weights) > 0 and sum(grid) > 0:
                expected = [w / sum(weights) for w in weights]
                actual_ratio = [w / sum(grid) for w in grid]
                if any(abs(a - e) > 0.08 for a, e in zip(actual_ratio, expected)):
                    errors.append(issue("TABLE_WIDTH_PLAN", "actual column widths do not match width_weight plan", location))

    if render_dir is not None:
        pages = sorted(render_dir.glob("page-*.png"))
        if not pages:
            errors.append(issue("MISSING_RENDER", "no rendered page PNGs found", str(render_dir)))
        for page in pages:
            if page.stat().st_size < 5000:
                errors.append(issue("EMPTY_RENDER_PAGE", "rendered page is suspiciously small", str(page)))

    metrics = {"headings": len(actual), "tables": len(tables), "paragraphs": len([t for t in ptexts if t]), "body_font": body_font, "heading2_font": h2_font}
    return {"status": "pass" if not errors else "fail", "errors": errors, "warnings": warnings, "metrics": metrics}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docx", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--render-dir", type=Path)
    args = parser.parse_args()
    manifest = None
    if args.manifest:
        try:
            manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        except Exception as exc:
            report = {"status": "fail", "errors": [issue("MANIFEST_READ_ERROR", str(exc), str(args.manifest))], "warnings": [], "metrics": {}}
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return 1
    report = validate(args.docx, manifest, args.render_dir)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
