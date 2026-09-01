#!/usr/bin/env python3
"""Validate a concise case-style Chinese investment-proposal DOCX."""

from __future__ import annotations

import argparse
import json
import math
import re
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}
Q = lambda name: f"{{{W}}}{name}"


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


def parse_number(value: str) -> float | None:
    cleaned = re.sub(r"[\s,，]", "", value).replace("％", "%")
    cleaned = re.sub(r"^(约|人民币)", "", cleaned)
    match = re.fullmatch(r"([-+]?\d+(?:\.\d+)?)(万元|亿元|元|%|倍)?", cleaned)
    if not match:
        return None
    number = float(match.group(1))
    return number


def style_maps(styles: ET.Element) -> tuple[dict[str, str], dict[str, str]]:
    id_to_name: dict[str, str] = {}
    id_to_font: dict[str, str] = {}
    for style in styles.findall("w:style", NS):
        style_id = style.get(Q("styleId"), "")
        name = style.find("w:name", NS)
        if style_id and name is not None:
            id_to_name[style_id] = name.get(Q("val"), style_id)
        fonts = style.find("./w:rPr/w:rFonts", NS)
        if style_id and fonts is not None:
            font = fonts.get(Q("eastAsia")) or fonts.get(Q("ascii"))
            if font:
                id_to_font[style_id] = font
    return id_to_name, id_to_font


def style_id_of(paragraph: ET.Element) -> str:
    pstyle = paragraph.find("./w:pPr/w:pStyle", NS)
    return pstyle.get(Q("val"), "") if pstyle is not None else ""


def ppr_attr(paragraph: ET.Element, element: str, attribute: str = "val") -> str | None:
    node = paragraph.find(f"./w:pPr/w:{element}", NS)
    return node.get(Q(attribute)) if node is not None else None


def check_case_paragraph_formats(
    paragraphs: list[ET.Element],
    id_to_name: dict[str, str],
    errors: list[dict[str, str]],
) -> dict[str, int]:
    counts = {"salutation": 0, "body": 0, "heading": 0}
    nonempty = [(index, p) for index, p in enumerate(paragraphs, start=1) if text_of(p)]
    for paragraph_index, paragraph in nonempty:
        text = text_of(paragraph)
        style_name = id_to_name.get(style_id_of(paragraph), style_id_of(paragraph))
        if "投资决策委员会成员" in text:
            counts["salutation"] += 1
            if (
                style_name != "星实-正文"
                or ppr_attr(paragraph, "ind", "firstLine") != "0"
            ):
                errors.append(issue(
                    "SALUTATION_FORMAT",
                    "salutation must use the body style and directly clear first-line indent",
                    f"paragraph[{paragraph_index}]",
                ))
            continue

        if style_name == "星实-正文":
            counts["body"] += 1
            expected_indent = "480"
            if (
                ppr_attr(paragraph, "ind", "firstLine") != expected_indent
            ):
                errors.append(issue(
                    "BODY_PARAGRAPH_INDENT",
                    f"JiaLiang case body must directly use firstLine={expected_indent}",
                    f"paragraph[{paragraph_index}]",
                ))
        elif style_name in {"星实-题目", "星实-一标", "星实-二标"}:
            counts["heading"] += 1
            if style_name == "星实-一标":
                if ppr_attr(paragraph, "spacing", "before") != "240" or ppr_attr(paragraph, "spacing", "after") != "0":
                    errors.append(issue("H1_SPACING", "JiaLiang H1 must use before=240 and after=0", f"paragraph[{paragraph_index}]"))

    if len(nonempty) >= 2:
        for role, (paragraph_index, paragraph) in zip(("SIGNOFF", "DATE"), nonempty[-2:]):
            if ppr_attr(paragraph, "jc") != "right":
                errors.append(issue(f"{role}_ALIGNMENT", "signoff/date must align to the right body boundary", f"paragraph[{paragraph_index}]"))
            if ppr_attr(paragraph, "ind", "firstLine") != "0" or ppr_attr(paragraph, "ind", "left") != "0":
                errors.append(issue(f"{role}_INDENT", "signoff/date must use left=0 and firstLine=0", f"paragraph[{paragraph_index}]"))
            if ppr_attr(paragraph, "spacing", "line") != "480" or ppr_attr(paragraph, "spacing", "lineRule") != "exact":
                errors.append(issue(f"{role}_SPACING", "signoff/date must use exact 24pt line spacing", f"paragraph[{paragraph_index}]"))
    return counts


def check_body_run_sizes(
    paragraphs: list[ET.Element],
    id_to_name: dict[str, str],
    errors: list[dict[str, str]],
) -> int:
    checked = 0
    for paragraph_index, paragraph in enumerate(paragraphs, start=1):
        if id_to_name.get(style_id_of(paragraph), style_id_of(paragraph)) != "星实-正文":
            continue
        for run_index, run in enumerate(paragraph.findall("w:r", NS), start=1):
            if not text_of(run):
                continue
            checked += 1
            size = run.find("./w:rPr/w:sz", NS)
            size_cs = run.find("./w:rPr/w:szCs", NS)
            actual = size.get(Q("val")) if size is not None else None
            actual_cs = size_cs.get(Q("val")) if size_cs is not None else None
            expected = "24"
            if actual != expected or actual_cs != expected:
                errors.append(issue(
                    "BODY_RUN_SIZE",
                    f"body run must explicitly use JiaLiang size {expected}/{expected}, got {actual}/{actual_cs}",
                    f"paragraph[{paragraph_index}].run[{run_index}]",
                ))
    return checked


def check_financial_arithmetic(table: ET.Element, index: int, errors: list[dict[str, str]]) -> None:
    matrix: list[list[str]] = []
    for row in table.findall("w:tr", NS):
        matrix.append([text_of(cell) for cell in row.findall("w:tc", NS)])
    if not matrix:
        return

    rows: dict[str, list[str]] = {}
    aliases = {
        "营业收入": "revenue", "收入": "revenue",
        "营业成本": "cost", "成本": "cost",
        "毛利": "gross", "毛利润": "gross",
        "毛利率": "margin",
    }
    for row in matrix:
        if not row:
            continue
        label = re.sub(r"[：:\s]", "", row[0])
        if label in aliases:
            rows[aliases[label]] = row[1:]

    if {"revenue", "cost", "gross"}.issubset(rows):
        width = min(len(rows["revenue"]), len(rows["cost"]), len(rows["gross"]))
        for col in range(width):
            revenue = parse_number(rows["revenue"][col])
            cost = parse_number(rows["cost"][col])
            gross = parse_number(rows["gross"][col])
            if None in {revenue, cost, gross}:
                continue
            expected = float(revenue) - float(cost)
            tolerance = max(1.0, abs(expected) * 0.01)
            if not math.isclose(float(gross), expected, abs_tol=tolerance):
                errors.append(issue(
                    "GROSS_PROFIT_MISMATCH",
                    f"column {col + 2}: revenue {revenue} - cost {cost} = {expected}, not {gross}",
                    f"table[{index}]",
                ))

    if {"revenue", "gross", "margin"}.issubset(rows):
        width = min(len(rows["revenue"]), len(rows["gross"]), len(rows["margin"]))
        for col in range(width):
            revenue = parse_number(rows["revenue"][col])
            gross = parse_number(rows["gross"][col])
            margin = parse_number(rows["margin"][col])
            if None in {revenue, gross, margin} or float(revenue) == 0:
                continue
            expected = float(gross) / float(revenue) * 100
            if not math.isclose(float(margin), expected, abs_tol=1.0):
                errors.append(issue(
                    "GROSS_MARGIN_MISMATCH",
                    f"column {col + 2}: gross/revenue = {expected:.2f}%, not {margin}%",
                    f"table[{index}]",
                ))


def validate(docx: Path, render_dir: Path | None) -> dict[str, Any]:
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

    id_to_name, id_to_font = style_maps(styles)
    paragraphs = document.findall(".//w:body/w:p", NS)
    ptexts = [text_of(p) for p in paragraphs]
    styled = [(text_of(p), id_to_name.get(style_id_of(p), style_id_of(p))) for p in paragraphs]
    nonempty = [(text, style) for text, style in styled if text]
    titles = [text for text, style in nonempty if style == "星实-题目"]
    h1 = [text for text, style in nonempty if style == "星实-一标"]
    h2 = [text for text, style in nonempty if style == "星实-二标"]

    if len(titles) != 1 or "投资" not in titles[0] or "提案" not in titles[0]:
        errors.append(issue("TITLE", "expected one case-style investment proposal title", "document body"))
    if not any("投资决策委员会" in text for text, _ in nonempty[:8]):
        errors.append(issue("SALUTATION", "investment committee salutation is missing", "document body"))
    if not 3 <= len(h1) <= 6:
        errors.append(issue("H1_COUNT", f"expected 3-6 first-level headings, got {len(h1)}", "document body"))
    if not any("基本情况" in heading for heading in h1):
        errors.append(issue("BASIC_SECTION", "company basic-information section is missing", "document body"))
    if not any("交易" in heading for heading in h1):
        warnings.append(issue("TRANSACTION_SECTION", "transaction section is missing", "document body"))

    sects = document.findall(".//w:sectPr", NS)
    if len(sects) != 1:
        errors.append(issue("SECTION_COUNT", f"expected one section, got {len(sects)}", "word/document.xml"))
    elif sects:
        size = sects[0].find("w:pgSz", NS)
        if size is None or size.get(Q("w")) != "11906" or size.get(Q("h")) != "16838":
            errors.append(issue("PAGE_GEOMETRY", "page must be A4 portrait 11906x16838 DXA", "w:sectPr"))

    body_style_ids = [sid for sid, name in id_to_name.items() if name == "星实-正文"]
    h2_style_ids = [sid for sid, name in id_to_name.items() if name == "星实-二标"]
    body_font = id_to_font.get(body_style_ids[0]) if body_style_ids else None
    h2_font = id_to_font.get(h2_style_ids[0]) if h2_style_ids else None
    body_runs_checked = check_body_run_sizes(paragraphs, id_to_name, errors)
    if body_runs_checked == 0:
        errors.append(issue("BODY_RUNS_EMPTY", "no non-empty case-style body runs found", "document body"))
    paragraph_formats_checked = check_case_paragraph_formats(paragraphs, id_to_name, errors)

    all_text = "\n".join(ptexts)
    banned = ["〔资料记载〕", "〔分析判断〕", "〔待核验〕", "〔资料缺口〕", "Decision Manifest", "transaction_response"]
    for token in banned:
        if token in all_text:
            errors.append(issue("BANNED_VISIBLE_TEXT", f"visible internal text: {token}", "document body"))

    audit_tokens = ["核验", "应取得", "待确认", "未满足时", "终止条件", "交割前", "技术复测", "函证"]
    audit_count = sum(all_text.count(token) for token in audit_tokens)
    if audit_count > 8:
        errors.append(issue("AUDIT_CHECKLIST_DRIFT", f"found {audit_count} diligence-workflow phrases", "document body"))
    elif audit_count > 4:
        warnings.append(issue("AUDIT_CHECKLIST_DRIFT", f"found {audit_count} diligence-workflow phrases", "document body"))

    if any(sect.find("w:headerReference", NS) is None or sect.find("w:footerReference", NS) is None for sect in sects):
        errors.append(issue("HEADER_FOOTER_REFERENCE", "JiaLiang layout must preserve the default header and footer references", "w:sectPr"))

    tables = document.findall(".//w:tbl", NS)
    for index, table in enumerate(tables, start=1):
        rows = table.findall("w:tr", NS)
        location = f"table[{index}]"
        if rows and rows[0].find("./w:trPr/w:tblHeader", NS) is None:
            warnings.append(issue("REPEATING_HEADER", "first row is not marked as a repeating header", location))
        for row_index, row in enumerate(rows[1:], start=2):
            for col_index, cell in enumerate(row.findall("w:tc", NS), start=1):
                value = text_of(cell)
                if numeric_text(value):
                    alignments = [jc_of(p) for p in cell.findall("w:p", NS)]
                    if not alignments or any(a != "right" for a in alignments):
                        warnings.append(issue("NUMERIC_ALIGNMENT", f"numeric value {value!r} is not right aligned", f"{location}.row[{row_index}].col[{col_index}]"))
                        break
        check_financial_arithmetic(table, index, errors)

    if render_dir is not None:
        pages = sorted(render_dir.glob("page-*.png"))
        if not pages:
            errors.append(issue("MISSING_RENDER", "no rendered page PNGs found", str(render_dir)))
        for page in pages:
            if page.stat().st_size < 5000:
                errors.append(issue("EMPTY_RENDER_PAGE", "rendered page is suspiciously small", str(page)))

    metrics = {
        "h1": len(h1), "h2": len(h2), "tables": len(tables),
        "paragraphs": len(nonempty), "audit_phrase_count": audit_count,
        "body_font": body_font, "heading2_font": h2_font,
        "body_runs_checked": body_runs_checked,
        "paragraph_formats_checked": paragraph_formats_checked,
    }
    return {"status": "pass" if not errors else "fail", "errors": errors, "warnings": warnings, "metrics": metrics}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docx", type=Path)
    parser.add_argument("--render-dir", type=Path)
    args = parser.parse_args()
    report = validate(args.docx, args.render_dir)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
