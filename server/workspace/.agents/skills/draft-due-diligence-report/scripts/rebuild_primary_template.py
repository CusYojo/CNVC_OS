#!/usr/bin/env python3
"""Rebuild a fact-free structural DOCX template from an accepted report.

The output keeps styles, fields, headings, sections, headers/footers and table
geometry.  It intentionally removes all project-specific visible body facts.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
import re
from pathlib import Path
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile
from xml.etree import ElementTree as ET


W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}
Q = lambda name: f"{{{W}}}{name}"

KEY_VALUE_TABLES = {1, 2, 3, 4, 5, 6}
GENERIC_PLACEHOLDER = "{{据实填写}}"
FIXED_FIRST_COLUMN_LABELS = {}
FIXED_TABLE_HEADERS = {
    8: ["股东", "认缴注册资本（万元）", "持股比例"],
    10: ["{{组织架构图}}", "", ""],
    11: ["关联主体或事项", "关联关系及投资相关情况"],
    12: ["类别", "资质、认证或荣誉情况"],
    13: ["核心产品", "产品定义/核心功能", "应用场景/目标客户", "商业化进展"],
    14: ["核心技术", "技术描述/原理", "技术来源/权属", "技术门槛/产品作用"],
    15: ["应用场景", "解决方案"],
    16: ["年份", "代表成果", "对现有产品/技术的作用"],
    17: ["知识产权类别", "权属及进展"],
    18: ["业务板块", "主要产品/服务", "收入来源", "销售与交付方式"],
    19: ["主要成本项", "成本构成/采购情况"],
    22: ["人员类别"],
    24: ["营业收入构成"],
    25: ["投资亮点", "业务基础", "投资价值"],
}
# Keep the fact-free template compact.  These caps only control prototype rows;
# final reports add or remove rows according to supported project facts.  The
# balance-sheet prototype drops a single inherited orphan row, while adaptive
# business and forecast tables keep only a representative expandable skeleton.
TEMPLATE_MAX_ROWS = {
    10: 1,
    11: 2,
    19: 2,
    23: 39,
    24: 20,
}
EXPLICIT_FONT = "仿宋_GB2312"
HEADING_FONT = "黑体"
EXPLICIT_TABLE_SIZE_HALF_POINTS = 24
COMPACT_TABLE_SIZE_HALF_POINTS: dict[int, int] = {}
HEADING_REPLACEMENTS = {
    "8、风险提示与对策": "8、风险识别与控制",
    "风险控制建议": "风险控制安排",
    "2.4.1 马晓健——联合创始人、CEO": "2.4.1 创始人及核心管理人员",
    "2.4.2 刘航欣——联合创始人、CTO": "2.4.2 联合创始人及核心管理人员",
    "2.4.3 黄思远——联合创始人、首席科学家": "2.4.3 核心技术或科研团队",
    "4.2.1 乐聚智能": "4.2.1 核心已验证客户",
    "4.2.2 宇树科技": "4.2.2 其他已签约客户",
    "4.2.3 智元机器人": "4.2.3 报告期进行中项目",
    "4.2.4 星海图": "4.2.4 其他Pipeline或客户验证",
    "2.4.1 杨林——创始人、实际控制人": "2.4.1 创始人及实际控制人",
    "2.4.2 刘岩鑫——联合创始人、商务负责人": "2.4.2 联合创始人及核心管理人员",
    "2.4.3 Abdulmotaleb El Saddik与董海巍——院士及高校合作团队": "2.4.3 海外/核心研发及高校合作团队",
    "4.2.1 江苏行之途": "4.2.1 核心已验证客户",
    "4.2.2 其他2025年客户": "4.2.2 其他历史客户",
    "4.2.3 2026年进行中项目": "4.2.3 报告期进行中项目",
    "2.7 资质、荣誉及法律合规情况": "2.7 资质、认证及荣誉情况",
}


def load_layout_profile() -> dict[str, object]:
    path = Path(__file__).resolve().parents[1] / "assets" / "table-layout-profile.json"
    return json.loads(path.read_text(encoding="utf-8"))


TABLE_LAYOUT_PROFILE = load_layout_profile()


def table_contract(table_number: int) -> dict[str, object]:
    item = next(
        (
            candidate
            for candidate in TABLE_LAYOUT_PROFILE.get("tables", [])
            if int(candidate.get("number", -1)) == table_number
        ),
        None,
    )
    if item is None:
        raise ValueError(f"table {table_number} is absent from table-layout-profile.json")
    role_name = str(item["role"])
    contract = dict(TABLE_LAYOUT_PROFILE.get("roles", {}).get(role_name, {}))
    contract.update(item)
    contract["role"] = role_name
    defaults = dict(TABLE_LAYOUT_PROFILE.get("defaults", {}))
    for key in (
        "label_paragraph_spacing",
        "header_paragraph_spacing",
        "body_paragraph_spacing",
    ):
        if key not in contract and key in defaults:
            contract[key] = defaults[key]
    contract["long_row_chars"] = int(
        contract.get(
            "long_row_chars",
            defaults.get("long_row_chars", 80),
        )
    )
    return contract


def text_of(node: ET.Element) -> str:
    return "".join(item.text or "" for item in node.findall(".//w:t", NS)).strip()


def set_visible_text(node: ET.Element, value: str) -> None:
    if node.tag == Q("tc"):
        direct_paragraphs = node.findall("w:p", NS)
        for paragraph in direct_paragraphs[1:]:
            node.remove(paragraph)
    texts = node.findall(".//w:t", NS)
    if texts:
        texts[0].text = value
        for item in texts[1:]:
            item.text = ""
        return
    paragraph = node if node.tag == Q("p") else node.find(".//w:p", NS)
    if paragraph is None:
        paragraph = ET.SubElement(node, Q("p"))
    run = ET.SubElement(paragraph, Q("r"))
    text = ET.SubElement(run, Q("t"))
    text.text = value


def _prepend(parent: ET.Element, child: ET.Element) -> None:
    parent.insert(0, child)


def set_run_format(
    run: ET.Element,
    *,
    font: str,
    size_half_points: int,
    bold: bool,
) -> None:
    """Write explicit Word run properties, including the East Asia font."""
    rpr = run.find("w:rPr", NS)
    if rpr is None:
        rpr = ET.Element(Q("rPr"))
        _prepend(run, rpr)

    set_rpr_format(
        rpr,
        font=font,
        size_half_points=size_half_points,
        bold=bold,
    )


def set_rpr_format(
    rpr: ET.Element,
    *,
    font: str,
    size_half_points: int,
    bold: bool,
) -> None:
    """Write exact delivery typography to an existing run-property node."""

    fonts = rpr.find("w:rFonts", NS)
    if fonts is None:
        fonts = ET.Element(Q("rFonts"))
        _prepend(rpr, fonts)
    for attribute in ("ascii", "hAnsi", "eastAsia", "cs"):
        fonts.set(Q(attribute), font)

    for name in ("sz", "szCs"):
        node = rpr.find(f"w:{name}", NS)
        if node is None:
            node = ET.SubElement(rpr, Q(name))
        node.set(Q("val"), str(size_half_points))

    for name in ("b", "bCs"):
        node = rpr.find(f"w:{name}", NS)
        if bold:
            if node is None:
                node = ET.SubElement(rpr, Q(name))
            node.set(Q("val"), "1")
        else:
            if node is None:
                node = ET.SubElement(rpr, Q(name))
            node.set(Q("val"), "0")


def format_visible_runs(
    node: ET.Element,
    *,
    font: str,
    size_half_points: int,
    bold: bool,
) -> None:
    for run in node.findall(".//w:r", NS):
        if any((text.text or "").strip() for text in run.findall(".//w:t", NS)):
            set_run_format(
                run,
                font=font,
                size_half_points=size_half_points,
                bold=bold,
            )


def apply_table_typography(table: ET.Element, table_number: int) -> None:
    """Turn every editable table slot into an explicitly formatted prototype."""
    rows = table.findall("w:tr", NS)
    size_half_points = COMPACT_TABLE_SIZE_HALF_POINTS.get(
        table_number,
        EXPLICIT_TABLE_SIZE_HALF_POINTS,
    )
    contract = table_contract(table_number)
    header_rows = set(int(item) for item in contract.get("header_rows", []))
    section_labels = {str(item) for item in contract.get("section_row_labels", [])}
    key_value = str(contract["role"]).startswith("key_value")
    for row_index, row in enumerate(rows):
        is_section = re.sub(r"\s+", "", text_of(row)) in section_labels
        for column_index, cell in enumerate(row.findall("w:tc", NS)):
            is_header = row_index in header_rows
            is_key_label = key_value and column_index == 0
            format_visible_runs(
                cell,
                font=EXPLICIT_FONT,
                size_half_points=EXPLICIT_TABLE_SIZE_HALF_POINTS if is_header else size_half_points,
                bold=is_header or is_key_label or is_section,
            )


def _set_cell_fill(cell: ET.Element, fill: str | None) -> None:
    tc_pr = cell.find("w:tcPr", NS)
    if tc_pr is None:
        tc_pr = ET.Element(Q("tcPr"))
        _prepend(cell, tc_pr)
    shade = tc_pr.find("w:shd", NS)
    if not fill or str(fill).lower() == "auto":
        if shade is not None:
            tc_pr.remove(shade)
        return
    if shade is None:
        shade = ET.SubElement(tc_pr, Q("shd"))
    shade.set(Q("val"), "clear")
    shade.set(Q("color"), "auto")
    shade.set(Q("fill"), str(fill).upper())


def _set_alignment(cell: ET.Element, alignment: str | None) -> None:
    if not alignment:
        return
    for paragraph in cell.findall("w:p", NS):
        p_pr = paragraph.find("w:pPr", NS)
        if p_pr is None:
            p_pr = ET.Element(Q("pPr"))
            _prepend(paragraph, p_pr)
        jc = p_pr.find("w:jc", NS)
        if jc is None:
            jc = ET.SubElement(p_pr, Q("jc"))
        jc.set(Q("val"), alignment)


def _set_paragraph_spacing(cell: ET.Element, specification: dict[str, object] | None) -> None:
    if not specification:
        return
    for paragraph in cell.findall("w:p", NS):
        p_pr = paragraph.find("w:pPr", NS)
        if p_pr is None:
            p_pr = ET.Element(Q("pPr"))
            _prepend(paragraph, p_pr)
        spacing = p_pr.find("w:spacing", NS)
        if spacing is None:
            spacing = ET.SubElement(p_pr, Q("spacing"))
        mapping = {
            "line": "line",
            "line_rule": "lineRule",
            "before": "before",
            "after": "after",
        }
        for key, attribute in mapping.items():
            if key in specification:
                spacing.set(Q(attribute), str(specification[key]))


def _paragraph_spacing(
    contract: dict[str, object], row_index: int, column_index: int
) -> dict[str, object] | None:
    role = str(contract["role"])
    if role.startswith("key_value"):
        key = (
            "label_paragraph_spacing"
            if column_index in set(contract.get("label_columns", [0]))
            else "body_paragraph_spacing"
        )
    elif row_index in set(int(item) for item in contract.get("header_rows", [0])):
        key = "header_paragraph_spacing"
    else:
        key = "body_paragraph_spacing"
    value = contract.get(key)
    return dict(value) if isinstance(value, dict) else None


def _set_row_property(row: ET.Element, name: str, enabled: bool) -> None:
    tr_pr = row.find("w:trPr", NS)
    if tr_pr is None:
        tr_pr = ET.Element(Q("trPr"))
        _prepend(row, tr_pr)
    node = tr_pr.find(f"w:{name}", NS)
    if enabled and node is None:
        ET.SubElement(tr_pr, Q(name))
    elif not enabled and node is not None:
        tr_pr.remove(node)


def _header_style(contract: dict[str, object], row_index: int) -> tuple[str | None, str, bool]:
    for specification in contract.get("header_row_styles", []):
        if int(specification.get("row", -1)) == row_index:
            return (
                specification.get("fill"),
                str(specification.get("alignment", "center")),
                bool(specification.get("bold", True)),
            )
    return (
        contract.get("header_fill"),
        str(contract.get("header_alignment", "center")),
        bool(contract.get("header_bold", True)),
    )


def apply_table_role_layout(table: ET.Element, table_number: int) -> None:
    contract = table_contract(table_number)
    role = str(contract["role"])
    header_rows = set(int(item) for item in contract.get("header_rows", []))
    repeat_rows = set(int(item) for item in contract.get("repeat_header_rows", []))
    split_policy = str(contract.get("row_split_policy", "keep_short_rows"))
    long_row_chars = int(contract.get("long_row_chars", 80))
    section_labels = {str(item) for item in contract.get("section_row_labels", [])}
    for row_index, row in enumerate(table.findall("w:tr", NS)):
        _set_row_property(row, "tblHeader", row_index in repeat_rows)
        row_text = re.sub(r"\s+", "", text_of(row))
        is_section = row_text in section_labels
        if split_policy in {"allow_rows", "allow_long_rows"}:
            _set_row_property(row, "cantSplit", False)
        elif split_policy == "keep_rows":
            _set_row_property(row, "cantSplit", True)
        else:
            _set_row_property(row, "cantSplit", len(row_text) < long_row_chars)
        height = row.find("./w:trPr/w:trHeight", NS)
        if height is not None and height.get(Q("hRule")) == "exact":
            height.set(Q("hRule"), "atLeast")

        for column_index, cell in enumerate(row.findall("w:tc", NS)):
            if is_section:
                fill = contract.get("section_fill", "E7E6E6")
                alignment = contract.get("section_alignment", "center")
            elif role.startswith("key_value"):
                is_label = column_index in set(contract.get("label_columns", [0]))
                fill = contract.get("label_fill") if is_label else None
                alignment = contract.get("label_alignment" if is_label else "value_alignment")
            elif row_index in header_rows:
                fill, alignment, _ = _header_style(contract, row_index)
            else:
                fill = contract.get("body_fill")
                alignments = contract.get("body_alignment_by_column", [])
                alignment = (
                    alignments[column_index]
                    if column_index < len(alignments)
                    else contract.get("body_alignment", "center")
                )
            _set_cell_fill(cell, fill)
            _set_alignment(cell, str(alignment) if alignment else None)
            _set_paragraph_spacing(
                cell,
                _paragraph_spacing(contract, row_index, column_index),
            )


def finalize_table(table: ET.Element, table_number: int) -> None:
    apply_table_typography(table, table_number)
    apply_table_role_layout(table, table_number)


def paragraph_style(paragraph: ET.Element) -> str:
    style = paragraph.find("./w:pPr/w:pStyle", NS)
    return style.get(Q("val"), "") if style is not None else ""


def is_heading(paragraph: ET.Element, style_names: dict[str, str]) -> bool:
    style = style_names.get(paragraph_style(paragraph), paragraph_style(paragraph)).lower()
    return bool(re.search(r"heading|标题", style))


def heading_size_half_points(paragraph: ET.Element, style_names: dict[str, str]) -> int:
    style = style_names.get(paragraph_style(paragraph), paragraph_style(paragraph)).lower()
    if re.search(r"heading\s*3|标题\s*3|标题三", style):
        return 24
    return 30


def has_field(paragraph: ET.Element) -> bool:
    return paragraph.find(".//w:instrText", NS) is not None or paragraph.find(".//w:fldChar", NS) is not None


def has_section_break(paragraph: ET.Element) -> bool:
    return paragraph.find("./w:pPr/w:sectPr", NS) is not None


def is_disposable_empty_paragraph(paragraph: ET.Element) -> bool:
    """Return true only for visually empty paragraphs with no structural role."""
    return (
        paragraph.tag == Q("p")
        and not text_of(paragraph)
        and not has_field(paragraph)
        and not has_section_break(paragraph)
        and paragraph.find(".//w:drawing", NS) is None
        and paragraph.find(".//w:pict", NS) is None
    )


def remove_empty_paragraphs_before_later_h1(
    body: ET.Element,
    style_names: dict[str, str],
) -> int:
    """Remove stale spacer paragraphs before later Heading 1 paragraphs.

    The reference report uses Heading 1's ``pageBreakBefore`` property.  Empty
    paragraphs left immediately before a later chapter therefore create a
    header/footer-only page in some Word-compatible renderers.  Section-break
    paragraphs are explicitly preserved.
    """
    removed = 0
    seen_h1 = False
    for child in list(body):
        if child.tag != Q("p") or not is_heading(child, style_names):
            continue
        style = style_names.get(paragraph_style(child), paragraph_style(child)).lower()
        if not re.search(r"heading\s*1|标题\s*1|标题一", style):
            continue
        if seen_h1:
            siblings = list(body)
            index = siblings.index(child) - 1
            while index >= 0 and is_disposable_empty_paragraph(siblings[index]):
                body.remove(siblings[index])
                removed += 1
                siblings = list(body)
                index = siblings.index(child) - 1
        seen_h1 = True
    return removed


def remove_empty_heading_paragraphs(
    body: ET.Element,
    style_names: dict[str, str],
) -> int:
    """Remove empty Heading paragraphs that would pollute the TOC or page rhythm."""
    removed = 0
    for child in list(body):
        if (
            child.tag == Q("p")
            and not text_of(child)
            and is_heading(child, style_names)
            and not has_field(child)
            and not has_section_break(child)
        ):
            body.remove(child)
            removed += 1
    return removed


def rebuild_grouped_financial_table(table: ET.Element) -> None:
    """Create the V22 vertical, grouped historical-financial prototype."""
    existing_rows = table.findall("w:tr", NS)
    if not existing_rows:
        raise ValueError("table 23 has no prototype row")
    prototype_source = existing_rows[1] if len(existing_rows) > 1 else existing_rows[0]
    prototype = deepcopy(prototype_source)
    prototype_cells = prototype.findall("w:tc", NS)
    if len(prototype_cells) < 4:
        raise ValueError("table 23 prototype must contain at least four cells")
    for cell in prototype_cells[4:]:
        prototype.remove(cell)
    for cell in prototype.findall("w:tc", NS):
        tc_pr = cell.find("w:tcPr", NS)
        if tc_pr is not None:
            for tag in ("gridSpan", "vMerge"):
                node = tc_pr.find(f"w:{tag}", NS)
                if node is not None:
                    tc_pr.remove(node)

    grid = table.find("w:tblGrid", NS)
    if grid is None:
        grid = ET.Element(Q("tblGrid"))
        table.insert(0, grid)
    grid_columns = grid.findall("w:gridCol", NS)
    grid_prototype = deepcopy(grid_columns[-1]) if grid_columns else ET.Element(Q("gridCol"))
    for node in list(grid):
        if node.tag == Q("gridCol"):
            grid.remove(node)
    for _ in range(4):
        grid.append(deepcopy(grid_prototype))

    for row in existing_rows:
        table.remove(row)
    rows: list[list[str]] = [
        ["单位：万元", "{{实际期间1}}", "{{实际期间2}}", "{{实际期间3}}"],
        ["利润表", "", "", ""],
        ["营业收入", "{{值}}", "{{值}}", "{{值}}"],
        ["营业成本", "{{值}}", "{{值}}", "{{值}}"],
        ["毛利", "{{值}}", "{{值}}", "{{值}}"],
        ["毛利率", "{{值}}", "{{值}}", "{{值}}"],
        ["销售费用", "{{值}}", "{{值}}", "{{值}}"],
        ["研发费用", "{{值}}", "{{值}}", "{{值}}"],
        ["管理费用", "{{值}}", "{{值}}", "{{值}}"],
        ["财务费用", "{{值}}", "{{值}}", "{{值}}"],
        ["净利润", "{{值}}", "{{值}}", "{{值}}"],
        ["资产负债表", "", "", ""],
        ["货币资金", "{{值}}", "{{值}}", "{{值}}"],
        ["应收账款", "{{值}}", "{{值}}", "{{值}}"],
        ["存货", "{{值}}", "{{值}}", "{{值}}"],
        ["其他流动资产", "{{值}}", "{{值}}", "{{值}}"],
        ["流动资产合计", "{{值}}", "{{值}}", "{{值}}"],
        ["固定资产", "{{值}}", "{{值}}", "{{值}}"],
        ["其他非流动资产", "{{值}}", "{{值}}", "{{值}}"],
        ["非流动资产合计", "{{值}}", "{{值}}", "{{值}}"],
        ["资产合计", "{{值}}", "{{值}}", "{{值}}"],
        ["短期借款", "{{值}}", "{{值}}", "{{值}}"],
        ["应付账款", "{{值}}", "{{值}}", "{{值}}"],
        ["合同负债", "{{值}}", "{{值}}", "{{值}}"],
        ["其他流动负债", "{{值}}", "{{值}}", "{{值}}"],
        ["流动负债合计", "{{值}}", "{{值}}", "{{值}}"],
        ["非流动负债", "{{值}}", "{{值}}", "{{值}}"],
        ["非流动负债合计", "{{值}}", "{{值}}", "{{值}}"],
        ["负债合计", "{{值}}", "{{值}}", "{{值}}"],
        ["实收资本", "{{值}}", "{{值}}", "{{值}}"],
        ["资本公积", "{{值}}", "{{值}}", "{{值}}"],
        ["未分配利润", "{{值}}", "{{值}}", "{{值}}"],
        ["所有者权益合计", "{{值}}", "{{值}}", "{{值}}"],
        ["负债和所有者权益合计", "{{值}}", "{{值}}", "{{值}}"],
        ["现金流量表", "", "", ""],
        ["经营活动现金流量净额", "{{值}}", "{{值}}", "{{值}}"],
        ["投资活动现金流量净额", "{{值}}", "{{值}}", "{{值}}"],
        ["筹资活动现金流量净额", "{{值}}", "{{值}}", "{{值}}"],
        ["期末现金及现金等价物余额", "{{值}}", "{{值}}", "{{值}}"],
    ]
    for values in rows:
        row = deepcopy(prototype)
        cells = row.findall("w:tc", NS)
        for cell, value in zip(cells, values):
            set_visible_text(cell, value)
        table.append(row)


def sanitize_table(table: ET.Element, table_number: int) -> None:
    rows = table.findall("w:tr", NS)
    if table_number == 23:
        rebuild_grouped_financial_table(table)
        finalize_table(table, table_number)
        return
    if table_number == 12 and rows:
        current_header = [text_of(cell) for cell in rows[0].findall("w:tc", NS)]
        expected_header = FIXED_TABLE_HEADERS[12]
        if current_header[: len(expected_header)] != expected_header:
            row_index = list(table).index(rows[0])
            table.insert(row_index, deepcopy(rows[0]))
            rows = table.findall("w:tr", NS)
    max_rows = TEMPLATE_MAX_ROWS.get(table_number)
    if max_rows is not None and len(rows) > max_rows:
        for row in rows[max_rows:]:
            table.remove(row)
        rows = table.findall("w:tr", NS)

    fixed_labels = FIXED_FIRST_COLUMN_LABELS.get(table_number)
    if fixed_labels is not None:
        if len(rows) != len(fixed_labels):
            raise ValueError(
                f"table {table_number} must contain {len(fixed_labels)} rows, got {len(rows)}"
            )
        for row_index, (row, label) in enumerate(zip(rows, fixed_labels)):
            cells = row.findall("w:tc", NS)
            if len(cells) != 2:
                raise ValueError(
                    f"table {table_number} row {row_index + 1} must contain two cells"
                )
            set_visible_text(cells[0], label)
            if row_index > 0:
                set_visible_text(cells[1], GENERIC_PLACEHOLDER)
        finalize_table(table, table_number)
        return

    fixed_headers = FIXED_TABLE_HEADERS.get(table_number)
    if fixed_headers is not None and rows:
        header_cells = rows[0].findall("w:tc", NS)
        if len(header_cells) < len(fixed_headers):
            raise ValueError(
                f"table {table_number} needs at least {len(fixed_headers)} header cells, got {len(header_cells)}"
            )
        for cell, value in zip(header_cells, fixed_headers):
            set_visible_text(cell, value)

    for row_index, row in enumerate(rows):
        cells = row.findall("w:tc", NS)
        for column_index, cell in enumerate(cells):
            if table_number in KEY_VALUE_TABLES:
                preserve_role = column_index == 0
            else:
                preserve_role = row_index == 0
            if preserve_role:
                continue
            placeholder = "{{行项}}" if column_index == 0 else GENERIC_PLACEHOLDER
            set_visible_text(cell, placeholder)

    # Keep wide forecast tables readable in the fact-free template. Final
    # reports replace these compact slots with real years and values.
    if table_number in {22, 24} and rows:
        cells = rows[0].findall("w:tc", NS)
        for index, cell in enumerate(cells[1:], start=1):
            set_visible_text(cell, f"{{{{年{index}}}}}")
        for row in rows[1:]:
            for column_index, cell in enumerate(row.findall("w:tc", NS)):
                set_visible_text(cell, "{{行项}}" if column_index == 0 else "{{值}}")
    finalize_table(table, table_number)


def sanitize_document(raw: bytes, target_terms: list[str], style_names: dict[str, str]) -> bytes:
    root = ET.fromstring(raw)
    body = root.find("w:body", NS)
    if body is None:
        raise ValueError("word/document.xml has no w:body")

    table_number = 0
    body_started = False
    for child in body:
        if child.tag == Q("tbl"):
            table_number += 1
            sanitize_table(child, table_number)
            continue
        if child.tag != Q("p"):
            continue
        current = text_of(child)
        if not current or has_field(child):
            continue
        if is_heading(child, style_names):
            body_started = True
            continue
        if "上会尽职调查报告" in current:
            format_visible_runs(
                child,
                font=HEADING_FONT,
                size_half_points=44,
                bold=True,
            )
            continue
        if any(term and term in current for term in target_terms) and not body_started:
            set_visible_text(child, "{{目标公司全称}}")
        elif re.search(r"投资团队|尽调团队|项目团队", current):
            set_visible_text(child, "{{出具团队}}")
        elif re.fullmatch(r"[二〇○零一二三四五六七八九十年月日\s]+", current):
            set_visible_text(child, "{{报告日期}}")
        elif "目录" == current:
            continue
        else:
            set_visible_text(child, GENERIC_PLACEHOLDER)

        updated = text_of(child)
        if (
            "上会尽职调查报告" in updated
            or ("{{目标公司全称}}" in updated and not body_started)
        ):
            format_visible_runs(
                child,
                font=HEADING_FONT,
                size_half_points=44,
                bold=True,
            )
        elif "{{出具团队}}" in updated or "{{报告日期}}" in updated:
            format_visible_runs(
                child,
                font=EXPLICIT_FONT,
                size_half_points=28,
                bold=False,
            )
        elif GENERIC_PLACEHOLDER in updated:
            format_visible_runs(
                child,
                font=EXPLICIT_FONT,
                size_half_points=24,
                bold=False,
            )

    for text_node in root.findall(".//w:t", NS):
        if not text_node.text:
            continue
        for old, new in HEADING_REPLACEMENTS.items():
            text_node.text = text_node.text.replace(old, new)
        if "投资结论及建议" not in text_node.text and "投资结论" in text_node.text:
            text_node.text = text_node.text.replace("投资结论", "投资结论及建议")

    for child in body:
        if child.tag != Q("p") or not is_heading(child, style_names) or not text_of(child):
            continue
        format_visible_runs(
            child,
            font=HEADING_FONT,
            size_half_points=heading_size_half_points(child, style_names),
            bold=True,
        )

    remove_empty_paragraphs_before_later_h1(body, style_names)
    remove_empty_heading_paragraphs(body, style_names)

    if table_number != 27:
        raise ValueError(f"source report must contain 27 tables, got {table_number}")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def sanitize_core(raw: bytes) -> bytes:
    root = ET.fromstring(raw)
    for node in root.iter():
        if node.text and node.text.strip():
            local = node.tag.rsplit("}", 1)[-1]
            if local == "title":
                node.text = "上会尽职调查报告结构模板"
            elif local in {"subject", "description", "keywords"}:
                node.text = "脱敏结构模板；不含任何项目事实"
            elif local in {"creator", "lastModifiedBy"}:
                node.text = "Codex"
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def sanitize_styles(raw: bytes) -> bytes:
    """Make future Normal/Heading runs inherit the V20 delivery fonts."""
    root = ET.fromstring(raw)
    default_rpr = root.find("./w:docDefaults/w:rPrDefault/w:rPr", NS)
    if default_rpr is not None:
        set_rpr_format(
            default_rpr,
            font=EXPLICIT_FONT,
            size_half_points=24,
            bold=False,
        )
    for style in root.findall("w:style", NS):
        style_id = style.get(Q("styleId"), "")
        name_node = style.find("w:name", NS)
        style_name = name_node.get(Q("val"), "") if name_node is not None else ""
        normalized = f"{style_id} {style_name}".lower()
        is_normal = style_id.lower() == "normal" or style_name.lower() == "normal"
        heading_match = re.search(r"heading\s*([123])|标题\s*([123一二三])", normalized)
        if not is_normal and not heading_match:
            continue
        rpr = style.find("w:rPr", NS)
        if rpr is None:
            rpr = ET.SubElement(style, Q("rPr"))
        if is_normal:
            set_rpr_format(
                rpr,
                font=EXPLICIT_FONT,
                size_half_points=24,
                bold=False,
            )
        else:
            level_token = next(
                (value for value in heading_match.groups() if value),
                "1",
            )
            set_rpr_format(
                rpr,
                font=HEADING_FONT,
                size_half_points=24 if level_token in {"3", "三"} else 30,
                bold=True,
            )
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def build(source: Path, output: Path, target_terms: list[str]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(source) as src, tempfile.NamedTemporaryFile(
        prefix="dd-template-", suffix=".docx", dir=output.parent, delete=False
    ) as handle:
        temporary = Path(handle.name)
    try:
        with ZipFile(source) as src, ZipFile(temporary, "w", ZIP_DEFLATED) as dst:
            styles_root = ET.fromstring(src.read("word/styles.xml"))
            style_names = {}
            for style in styles_root.findall("w:style", NS):
                style_id = style.get(Q("styleId"), "")
                name = style.find("w:name", NS)
                if style_id and name is not None:
                    style_names[style_id] = name.get(Q("val"), style_id)
            for item in src.infolist():
                raw = src.read(item.filename)
                if item.filename == "word/document.xml":
                    raw = sanitize_document(raw, target_terms, style_names)
                elif item.filename == "word/styles.xml":
                    raw = sanitize_styles(raw)
                elif item.filename == "docProps/core.xml":
                    raw = sanitize_core(raw)
                if item.filename.endswith(".xml"):
                    text = raw.decode("utf-8", errors="ignore")
                    for term in target_terms:
                        text = text.replace(term, "{{目标公司}}")
                    raw = text.encode("utf-8")
                dst.writestr(item, raw)
        temporary.replace(output)
    finally:
        if temporary.exists():
            temporary.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--target-term", action="append", default=[])
    args = parser.parse_args()
    build(args.source.resolve(), args.output.resolve(), args.target_term)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
