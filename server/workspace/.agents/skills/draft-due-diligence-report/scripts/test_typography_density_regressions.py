#!/usr/bin/env python3
"""Prove that V21 typography and table-depth regressions are rejected.

The rebuilt primary template is the positive typography fixture because it
contains the exact delivery fonts.  The read-only sample remains the positive
content-depth fixture.  Each negative fixture changes one observable invariant.
"""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile
from xml.etree import ElementTree as ET

import validate_dd_report as validator


W = validator.W
NS = validator.NS
Q = validator.Q


def load_parts(docx: Path) -> tuple[ET.Element, ET.Element]:
    with ZipFile(docx) as archive:
        return (
            ET.fromstring(archive.read("word/document.xml")),
            ET.fromstring(archive.read("word/styles.xml")),
        )


def top_level_nodes(document: ET.Element, styles_by_id: dict[str, str]):
    body = document.find("w:body", NS)
    result = []
    if body is None:
        return result
    for child in body:
        if child.tag == Q("p"):
            text = validator.text_of(child)
            style_name = styles_by_id.get(validator.style_id(child), validator.style_id(child))
            level = validator.heading_level(style_name)
            kind = "paragraph"
        elif child.tag == Q("tbl"):
            text = validator.text_of(child)
            level = None
            kind = "table"
        else:
            continue
        if text:
            result.append((kind, text, level, child))
    return result


def write_mutation(source: Path, output: Path, mutate) -> None:
    with ZipFile(source) as src:
        document = ET.fromstring(src.read("word/document.xml"))
        mutate(document)
        replacement = ET.tostring(document, encoding="utf-8", xml_declaration=True)
        with ZipFile(output, "w", ZIP_DEFLATED) as dst:
            for item in src.infolist():
                dst.writestr(
                    deepcopy(item),
                    replacement if item.filename == "word/document.xml" else src.read(item.filename),
                )


def set_run_style(run: ET.Element, font: str, size_half_points: int, bold: bool) -> None:
    rpr = run.find("w:rPr", NS)
    if rpr is None:
        rpr = ET.Element(Q("rPr"))
        run.insert(0, rpr)
    fonts = rpr.find("w:rFonts", NS)
    if fonts is None:
        fonts = ET.SubElement(rpr, Q("rFonts"))
    for attribute in ("ascii", "hAnsi", "eastAsia", "cs"):
        fonts.set(Q(attribute), font)
    for name in ("sz", "szCs"):
        node = rpr.find(f"w:{name}", NS)
        if node is None:
            node = ET.SubElement(rpr, Q(name))
        node.set(Q("val"), str(size_half_points))
    for name in ("b", "bCs"):
        node = rpr.find(f"w:{name}", NS)
        if bold and node is None:
            ET.SubElement(rpr, Q(name))
        elif not bold and node is not None:
            rpr.remove(node)


def mutate_cover_to_songti_12(document: ET.Element) -> None:
    body = document.find("w:body", NS)
    if body is None:
        raise ValueError("missing body")
    changed = 0
    for paragraph in body.findall("w:p", NS):
        value = validator.normalized_text(validator.text_of(paragraph))
        if not value or value == "目录":
            continue
        for run in paragraph.findall(".//w:r", NS):
            if validator.normalized_text(validator.text_of(run)):
                set_run_style(run, "宋体", 24, False)
        changed += 1
        if changed == 4:
            return
    raise ValueError("could not locate four cover paragraphs")


def mutate_all_tables_to_8_5(document: ET.Element) -> None:
    for table in document.findall(".//w:tbl", NS):
        for run in table.findall(".//w:r", NS):
            if validator.normalized_text(validator.text_of(run)):
                set_run_style(run, "宋体", 17, False)


def mutate_one_table_to_10_5(document: ET.Element) -> None:
    table = document.findall(".//w:tbl", NS)[2]
    for run in table.findall(".//w:r", NS):
        if validator.normalized_text(validator.text_of(run)):
            set_run_style(run, "仿宋_GB2312", 21, False)


def replace_cell_with_sentence(cell: ET.Element, sentence: str) -> None:
    paragraphs = cell.findall("w:p", NS)
    if not paragraphs:
        paragraph = ET.SubElement(cell, Q("p"))
    else:
        paragraph = paragraphs[0]
        for extra in paragraphs[1:]:
            cell.remove(extra)
    texts = paragraph.findall(".//w:t", NS)
    if not texts:
        run = ET.SubElement(paragraph, Q("r"))
        texts = [ET.SubElement(run, Q("t"))]
    texts[0].text = sentence
    for node in texts[1:]:
        node.text = ""


def mutate_table_3_to_short_sentences(document: ET.Element) -> None:
    table = document.findall(".//w:tbl", NS)[2]
    for row in table.findall("w:tr", NS):
        cells = row.findall("w:tc", NS)
        if len(cells) >= 2:
            replace_cell_with_sentence(cells[1], "行业处于早期阶段，仍需持续验证。")


def mutate_table_5_to_one_sentence(document: ET.Element) -> None:
    table = document.findall(".//w:tbl", NS)[4]
    rows = table.findall("w:tr", NS)
    cells = rows[0].findall("w:tc", NS)
    replace_cell_with_sentence(cells[1], "公司具有一定技术和市场价值。")


def mutate_financial_tables_to_short_rows(document: ET.Element) -> None:
    tables = document.findall(".//w:tbl", NS)
    for table_number, keep_rows in ((23, 1), (24, 1)):
        table = tables[table_number - 1]
        rows = table.findall("w:tr", NS)
        for row in rows[keep_rows:]:
            table.remove(row)


def style_contract_results(docx: Path) -> list[dict[str, str]]:
    document, styles = load_parts(docx)
    style_names = validator.style_map(styles)
    tables = document.findall(".//w:tbl", NS)
    style_errors, _ = validator.typography_contract(
        document,
        styles,
        style_names,
        top_level_nodes(document, style_names),
        tables,
        None,
        validator.load_style_profile(),
    )
    return style_errors


def density_contract_results(docx: Path) -> list[dict[str, str]]:
    document, _ = load_parts(docx)
    tables = document.findall(".//w:tbl", NS)
    density_errors, _, _ = validator.content_density_contract(tables)
    return density_errors


def codes(items: list[dict[str, str]]) -> set[str]:
    return {item["code"] for item in items}


def main() -> int:
    skill_root = Path(__file__).resolve().parents[1]
    reference = skill_root / "assets" / "reference-dd-report.docx"
    template = skill_root / "assets" / "primary-dd-report-template.docx"

    positive_style = style_contract_results(template)
    # The immutable visual reference predates V22's grouped table-23 schema;
    # table-23's positive contract is proved against the rebuilt template.
    positive_density = [
        item for item in density_contract_results(reference)
        if item["code"] != "FINANCIAL_CLASSIFICATION"
    ]
    template_financial = [
        item for item in density_contract_results(template)
        if item["code"] == "FINANCIAL_CLASSIFICATION"
    ]
    if positive_style or positive_density or template_financial:
        raise SystemExit(
            f"reference fixture failed new contracts: style={positive_style!r}, density={positive_density!r}, template_financial={template_financial!r}"
        )

    mutations = {
        "cover_songti_12": (template, mutate_cover_to_songti_12, {"TYPOGRAPHY_FONT", "TYPOGRAPHY_SIZE"}, "style"),
        "tables_songti_8_5": (template, mutate_all_tables_to_8_5, {"TABLE_TEXT_TOO_SMALL", "TABLE_BODY_SIZE_INCONSISTENT", "TABLE_GLOBAL_STYLE_OVERRIDE", "TABLE_FONT"}, "style"),
        "one_table_10_5": (template, mutate_one_table_to_10_5, {"TABLE_BODY_SIZE_INCONSISTENT", "TABLE_LOCAL_FONT_OVERRIDE"}, "style"),
        "table_3_short": (reference, mutate_table_3_to_short_sentences, {"TABLE_CONTENT_DEPTH"}, "density"),
        "table_5_one_sentence": (reference, mutate_table_5_to_one_sentence, {"TABLE_CONTENT_DEPTH"}, "density"),
        "financial_rows_deleted": (reference, mutate_financial_tables_to_short_rows, {"FINANCIAL_TABLE_LINE_ITEMS"}, "density"),
    }

    observed: dict[str, list[str]] = {}
    with tempfile.TemporaryDirectory(prefix="dd-typography-density-") as tmp:
        root = Path(tmp)
        for name, (source, mutation, expected, category) in mutations.items():
            negative = root / f"{name}.docx"
            write_mutation(source, negative, mutation)
            actual = codes(
                style_contract_results(negative)
                if category == "style"
                else density_contract_results(negative)
            )
            if not expected.issubset(actual):
                raise SystemExit(f"{name} failed for wrong reason: expected={sorted(expected)!r}, actual={sorted(actual)!r}")
            observed[name] = sorted(actual)

    print(
        json.dumps(
            {
                "status": "pass",
                "positive_typography_fixture": str(template),
                "positive_density_fixture": str(reference),
                "negative_regressions": observed,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
