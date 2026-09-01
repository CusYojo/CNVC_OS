#!/usr/bin/env python3
"""Role-aware DOCX table writer for the due-diligence report template.

The module preserves the template's paragraph/run prototypes, applies the
machine-readable table role contract, and avoids ``cell.text = ...`` or
``paragraph.clear()`` formatting loss.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path
from typing import Iterable, Sequence

from docx.table import _Cell, Table
from docx.text.paragraph import Paragraph
from docx.oxml import OxmlElement
from docx.oxml.ns import qn


SKILL_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROFILE = SKILL_ROOT / "assets" / "table-layout-profile.json"


def load_table_layout_profile(path: Path | None = None) -> dict[str, object]:
    profile_path = path or DEFAULT_PROFILE
    return json.loads(profile_path.read_text(encoding="utf-8"))


def table_contract(
    table_number: int,
    profile: dict[str, object] | None = None,
) -> dict[str, object]:
    loaded = profile or load_table_layout_profile()
    table_items = loaded.get("tables", [])
    table_item = next(
        (item for item in table_items if int(item.get("number", -1)) == table_number),
        None,
    )
    if table_item is None:
        raise ValueError(f"table {table_number} is absent from the layout profile")
    role_name = str(table_item["role"])
    role = dict(loaded.get("roles", {}).get(role_name, {}))
    role.update(table_item)
    role["role"] = role_name
    defaults = dict(loaded.get("defaults", {}))
    for key in (
        "label_paragraph_spacing",
        "header_paragraph_spacing",
        "body_paragraph_spacing",
    ):
        if key not in role and key in defaults:
            role[key] = defaults[key]
    role["long_row_chars"] = int(
        role.get("long_row_chars", defaults.get("long_row_chars", 80))
    )
    return role


def _unique_cells(row) -> list[_Cell]:
    result: list[_Cell] = []
    seen: set[int] = set()
    for cell in row.cells:
        marker = id(cell._tc)
        if marker not in seen:
            seen.add(marker)
            result.append(cell)
    return result


def _get_or_add(parent, tag: str):
    node = parent.find(qn(tag))
    if node is None:
        node = OxmlElement(tag)
        parent.append(node)
    return node


def _set_cell_fill(cell: _Cell, fill: str | None) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shade = tc_pr.find(qn("w:shd"))
    if fill is None or fill.lower() == "auto":
        if shade is not None:
            tc_pr.remove(shade)
        return
    if shade is None:
        shade = OxmlElement("w:shd")
        tc_pr.append(shade)
    shade.set(qn("w:val"), "clear")
    shade.set(qn("w:color"), "auto")
    shade.set(qn("w:fill"), fill.upper())


def _set_paragraph_alignment(paragraph: Paragraph, alignment: str | None) -> None:
    if not alignment:
        return
    p_pr = paragraph._p.get_or_add_pPr()
    jc = p_pr.find(qn("w:jc"))
    if jc is None:
        jc = OxmlElement("w:jc")
        p_pr.append(jc)
    jc.set(qn("w:val"), alignment)


def _set_paragraph_spacing(
    paragraph: Paragraph,
    specification: dict[str, object] | None,
) -> None:
    """Write exact role-aware line and paragraph spacing to one paragraph."""
    if not specification:
        return
    p_pr = paragraph._p.get_or_add_pPr()
    spacing = p_pr.find(qn("w:spacing"))
    if spacing is None:
        spacing = OxmlElement("w:spacing")
        p_pr.append(spacing)
    mapping = {
        "line": "w:line",
        "line_rule": "w:lineRule",
        "before": "w:before",
        "after": "w:after",
    }
    for key, attribute in mapping.items():
        if key in specification:
            spacing.set(qn(attribute), str(specification[key]))


def _set_run_bold(run, bold: bool | None) -> None:
    if bold is None:
        return
    r_pr = run._r.get_or_add_rPr()
    for tag in ("w:b", "w:bCs"):
        node = r_pr.find(qn(tag))
        if bold:
            if node is None:
                node = OxmlElement(tag)
                r_pr.append(node)
            node.set(qn("w:val"), "1")
        else:
            if node is None:
                node = OxmlElement(tag)
                r_pr.append(node)
            node.set(qn("w:val"), "0")


def _prototype_properties(cell: _Cell):
    paragraph = cell.paragraphs[0]
    p_pr = deepcopy(paragraph._p.pPr) if paragraph._p.pPr is not None else None
    prototype_run = next((run for run in paragraph.runs if run.text), None)
    if prototype_run is None and paragraph.runs:
        prototype_run = paragraph.runs[0]
    r_pr = (
        deepcopy(prototype_run._r.rPr)
        if prototype_run is not None and prototype_run._r.rPr is not None
        else None
    )
    return p_pr, r_pr


def _replace_cell_paragraphs(
    cell: _Cell,
    values: Sequence[str],
    *,
    alignment: str | None,
    bold: bool | None,
    spacing: dict[str, object] | None,
) -> None:
    if not values:
        values = [""]
    p_pr, r_pr = _prototype_properties(cell)
    tc = cell._tc
    for paragraph in list(tc.p_lst):
        tc.remove(paragraph)
    for value in values:
        paragraph = OxmlElement("w:p")
        if p_pr is not None:
            paragraph.append(deepcopy(p_pr))
        tc.append(paragraph)
        wrapped = Paragraph(paragraph, cell)
        _set_paragraph_alignment(wrapped, alignment)
        _set_paragraph_spacing(wrapped, spacing)
        run = wrapped.add_run(str(value))
        if r_pr is not None:
            existing = run._r.rPr
            if existing is not None:
                run._r.remove(existing)
            run._r.insert(0, deepcopy(r_pr))
        _set_run_bold(run, bold)


def _set_repeat_header(row, enabled: bool) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    node = tr_pr.find(qn("w:tblHeader"))
    if enabled and node is None:
        node = OxmlElement("w:tblHeader")
        tr_pr.append(node)
    elif not enabled and node is not None:
        tr_pr.remove(node)


def _set_cant_split(row, enabled: bool) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    node = tr_pr.find(qn("w:cantSplit"))
    if enabled and node is None:
        node = OxmlElement("w:cantSplit")
        tr_pr.append(node)
    elif not enabled and node is not None:
        tr_pr.remove(node)


def _remove_exact_height(row) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    height = tr_pr.find(qn("w:trHeight"))
    if height is not None and height.get(qn("w:hRule")) == "exact":
        height.set(qn("w:hRule"), "atLeast")


def _row_style(
    contract: dict[str, object],
    row_index: int,
    column_index: int,
) -> tuple[str | None, str | None, bool | None]:
    role = contract["role"]
    if role.startswith("key_value"):
        label = column_index in set(contract.get("label_columns", [0]))
        return (
            str(contract.get("label_fill")) if label else None,
            str(contract.get("label_alignment" if label else "value_alignment", "center")),
            bool(contract.get("label_bold" if label else "value_bold", label)),
        )
    header_rows = set(int(item) for item in contract.get("header_rows", [0]))
    if row_index in header_rows:
        for specification in contract.get("header_row_styles", []):
            if int(specification.get("row", -1)) == row_index:
                return (
                    specification.get("fill"),
                    specification.get("alignment"),
                    bool(specification.get("bold", True)),
                )
        return (
            contract.get("header_fill"),
            contract.get("header_alignment", "center"),
            bool(contract.get("header_bold", True)),
        )
    alignments = contract.get("body_alignment_by_column", [])
    alignment = (
        alignments[column_index]
        if column_index < len(alignments)
        else contract.get("body_alignment", "center")
    )
    fill = contract.get("body_fill")
    return fill, alignment, bool(contract.get("body_bold", False))


def _paragraph_spacing(
    contract: dict[str, object],
    row_index: int,
    column_index: int,
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


def format_table(
    table: Table,
    table_number: int,
    *,
    profile: dict[str, object] | None = None,
) -> None:
    """Apply the role contract without rewriting cell content."""
    contract = table_contract(table_number, profile)
    if contract.get("semantic_role") == "organization_chart_container":
        return
    repeat_rows = set(int(item) for item in contract.get("repeat_header_rows", []))
    split_policy = str(contract.get("row_split_policy", "keep_short_rows"))
    long_row_chars = int(contract.get("long_row_chars", 80))
    for row_index, row in enumerate(table.rows):
        _set_repeat_header(row, row_index in repeat_rows)
        _remove_exact_height(row)
        row_text = "".join(cell.text for cell in _unique_cells(row))
        section_labels = {
            str(item) for item in contract.get("section_row_labels", [])
        }
        is_section_row = any(
            normalized.strip() == label
            for normalized in ["".join(row_text.split())]
            for label in section_labels
        )
        if split_policy in {"allow_rows", "allow_long_rows"}:
            _set_cant_split(row, False)
        elif split_policy == "keep_rows":
            _set_cant_split(row, True)
        elif split_policy == "keep_short_rows":
            _set_cant_split(row, len(row_text) < long_row_chars)
        for column_index, cell in enumerate(_unique_cells(row)):
            if is_section_row:
                fill = str(contract.get("section_fill", "E7E6E6"))
                alignment = str(contract.get("section_alignment", "center"))
                bold = bool(contract.get("section_bold", True))
            else:
                fill, alignment, bold = _row_style(contract, row_index, column_index)
            _set_cell_fill(cell, fill)
            for paragraph in cell.paragraphs:
                _set_paragraph_alignment(paragraph, alignment)
                _set_paragraph_spacing(
                    paragraph,
                    _paragraph_spacing(contract, row_index, column_index),
                )
                for run in paragraph.runs:
                    if run.text:
                        _set_run_bold(run, bold)


def _resize_table(table: Table, desired_rows: int, header_rows: int) -> None:
    if desired_rows < header_rows:
        raise ValueError("desired row count is smaller than the protected header row count")
    while len(table.rows) < desired_rows:
        prototype_index = len(table.rows) - 1
        if prototype_index < 0:
            raise ValueError("cannot grow a table with no prototype row")
        prototype = table.rows[prototype_index]._tr
        table._tbl.append(deepcopy(prototype))
    while len(table.rows) > desired_rows:
        table._tbl.remove(table.rows[-1]._tr)


def _resize_table_columns(table: Table, desired_columns: int) -> None:
    """Resize an unmerged template table to the caller's data width.

    Forecast and historical-financial periods are evidence-driven.  This
    helper removes unsupported template years and adds only periods supplied
    by the writer.  Merged tables are rejected because blindly cloning merged
    cells can corrupt Word's grid semantics.
    """
    if desired_columns < 1:
        raise ValueError("a table must contain at least one column")
    if not table.rows:
        raise ValueError("cannot resize columns on a table with no prototype row")
    widths = [len(_unique_cells(row)) for row in table.rows]
    if len(set(widths)) != 1:
        raise ValueError("dynamic column resizing requires an unmerged rectangular table")
    current_columns = widths[0]
    if current_columns == desired_columns:
        return

    tbl_grid = table._tbl.find(qn("w:tblGrid"))
    if tbl_grid is None:
        tbl_grid = OxmlElement("w:tblGrid")
        table._tbl.insert(0, tbl_grid)
    grid_columns = list(tbl_grid.findall(qn("w:gridCol")))
    if not grid_columns:
        for _ in range(current_columns):
            tbl_grid.append(OxmlElement("w:gridCol"))
        grid_columns = list(tbl_grid.findall(qn("w:gridCol")))

    while len(grid_columns) < desired_columns:
        tbl_grid.append(deepcopy(grid_columns[-1]))
        grid_columns = list(tbl_grid.findall(qn("w:gridCol")))
    while len(grid_columns) > desired_columns:
        tbl_grid.remove(grid_columns[-1])
        grid_columns = list(tbl_grid.findall(qn("w:gridCol")))

    for row in table.rows:
        while len(_unique_cells(row)) < desired_columns:
            prototype = _unique_cells(row)[-1]._tc
            clone = deepcopy(prototype)
            tc_pr = clone.find(qn("w:tcPr"))
            if tc_pr is not None:
                for tag in ("w:gridSpan", "w:vMerge"):
                    node = tc_pr.find(qn(tag))
                    if node is not None:
                        tc_pr.remove(node)
            row._tr.append(clone)
        while len(_unique_cells(row)) > desired_columns:
            row._tr.remove(_unique_cells(row)[-1]._tc)


def write_table(
    table: Table,
    rows: Sequence[Sequence[str | Sequence[str]]],
    *,
    table_number: int,
    profile: dict[str, object] | None = None,
) -> None:
    """Populate and format one table using explicit table number and role.

    A cell value can be a string or a sequence of strings.  A sequence creates
    multiple real Word paragraphs cloned from the cell's prototype formatting.
    """
    contract = table_contract(table_number, profile)
    header_count = len(contract.get("header_rows", []))
    widths = {len(item) for item in rows}
    if len(widths) != 1:
        raise ValueError(f"table {table_number} rows must have one consistent column count")
    desired_columns = widths.pop() if widths else 0
    _resize_table_columns(table, desired_columns)
    _resize_table(table, len(rows), header_count)
    for row_index, values in enumerate(rows):
        cells = _unique_cells(table.rows[row_index])
        if len(cells) != len(values):
            raise ValueError(
                f"table {table_number} row {row_index + 1} expects {len(cells)} cells, got {len(values)}"
            )
        for column_index, (cell, value) in enumerate(zip(cells, values)):
            paragraphs = [value] if isinstance(value, str) else [str(item) for item in value]
            _, alignment, bold = _row_style(contract, row_index, column_index)
            _replace_cell_paragraphs(
                cell,
                paragraphs,
                alignment=alignment,
                bold=bold,
                spacing=_paragraph_spacing(contract, row_index, column_index),
            )
    format_table(table, table_number, profile=profile)


def format_all_tables(
    tables: Iterable[Table],
    *,
    profile: dict[str, object] | None = None,
) -> None:
    for table_number, table in enumerate(tables, start=1):
        format_table(table, table_number, profile=profile)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Normalize all 27 tables in a DOCX against the table role contract."
    )
    parser.add_argument("input_docx", type=Path)
    parser.add_argument("output_docx", type=Path)
    parser.add_argument("--profile", type=Path)
    args = parser.parse_args()

    from docx import Document

    document = Document(args.input_docx)
    if len(document.tables) != 27:
        raise SystemExit(f"expected 27 tables, got {len(document.tables)}")
    profile = load_table_layout_profile(args.profile) if args.profile else None
    format_all_tables(document.tables, profile=profile)
    args.output_docx.parent.mkdir(parents=True, exist_ok=True)
    document.save(args.output_docx)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
