#!/usr/bin/env python3
"""Forward-test strict user-feedback contracts against an accepted report.

The accepted report must pass. Historical table labels, visible internal
evidence IDs, unauthorized scope prefaces, mechanical post-table judgment
paragraphs, visible reasoning labels, formulaic conclusions, duplicated
commercial-validation columns, related-party risk tails, open due-diligence
language, and defensive investment-thesis prose must each be rejected by their
deterministic gate.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile
from xml.etree import ElementTree as ET


sys.dont_write_bytecode = True

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}
Q = lambda name: f"{{{W}}}{name}"
EXPECTED_TABLE_11_HEADER = ["关联主体或事项", "关联关系及投资相关情况"]
EXPECTED_TABLE_12_HEADER = ["类别", "资质、认证或荣誉情况"]
EXPECTED_TABLE_27_HEADER = ["风险类别", "具体风险描述", "风险控制安排"]
EXPECTED_BUSINESS_HEADERS = {
    8: ["股东", "认缴注册资本（万元）", "持股比例"],
    10: ["{{组织架构图}}", "", ""],
    13: ["核心产品", "产品定义/核心功能", "应用场景/目标客户", "商业化进展"],
    14: ["核心技术", "技术描述/原理", "技术来源/权属", "技术门槛/产品作用"],
    18: ["业务板块", "主要产品/服务", "收入来源", "销售与交付方式"],
    25: ["投资亮点", "业务基础", "投资价值"],
}


def normalized_text(node: ET.Element) -> str:
    text = "".join(item.text or "" for item in node.findall(".//w:t", NS))
    return "".join(text.split())


def table_header(docx: Path, table_number: int) -> list[str]:
    with ZipFile(docx) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    tables = root.findall(".//w:tbl", NS)
    if len(tables) < table_number:
        raise ValueError(f"expected at least {table_number} tables, got {len(tables)}")
    row = tables[table_number - 1].find("w:tr", NS)
    return [normalized_text(cell) for cell in row.findall("w:tc", NS)] if row is not None else []


def make_historical_regression(source: Path, output: Path) -> None:
    def mutate(document: ET.Element) -> None:
        tables = document.findall(".//w:tbl", NS)
        header = tables[10].find("w:tr", NS)
        cells = header.findall("w:tc", NS) if header is not None else []
        text_nodes = cells[0].findall(".//w:t", NS) if cells else []
        if not text_nodes:
            raise ValueError("table 11 first header has no text node")
        text_nodes[0].text = "事项"
        for node in text_nodes[1:]:
            node.text = ""

    write_mutation(source, output, mutate)


def write_mutation(source: Path, output: Path, mutate) -> None:
    with ZipFile(source) as src:
        document = ET.fromstring(src.read("word/document.xml"))
        mutate(document)
        replacement = ET.tostring(document, encoding="utf-8", xml_declaration=True)

        with ZipFile(output, "w", ZIP_DEFLATED) as dst:
            for item in src.infolist():
                raw = replacement if item.filename == "word/document.xml" else src.read(item.filename)
                dst.writestr(item, raw)


def paragraph(text: str) -> ET.Element:
    node = ET.Element(Q("p"))
    run = ET.SubElement(node, Q("r"))
    text_node = ET.SubElement(run, Q("t"))
    text_node.text = text
    return node


def add_visible_evidence_id(document: ET.Element) -> None:
    first_row = document.find(".//w:tbl/w:tr", NS)
    cells = first_row.findall("w:tc", NS) if first_row is not None else []
    value_text = cells[1].find(".//w:t", NS) if len(cells) > 1 else None
    if value_text is None:
        raise ValueError("report has no first-table value text for evidence-ID mutation")
    value_text.text = (value_text.text or "") + "〔SRC-0001〕"


def add_unauthorized_preface(document: ET.Element) -> None:
    body = document.find("w:body", NS)
    if body is None:
        raise ValueError("report has no document body")
    body.insert(0, paragraph("报告基础与范围：本段为错误的样例外前置说明。"))


def first_top_level_table_index(document: ET.Element) -> tuple[ET.Element, int]:
    body = document.find("w:body", NS)
    if body is None:
        raise ValueError("report has no document body")
    children = list(body)
    first_table_index = next(
        (index for index, child in enumerate(children) if child.tag == Q("tbl")),
        None,
    )
    if first_table_index is None:
        raise ValueError("report has no top-level table")
    return body, first_table_index


def add_judgment_module(document: ET.Element) -> None:
    body, first_table_index = first_top_level_table_index(document)
    body.insert(
        first_table_index,
        paragraph("行业判断：本段为错误的样例外判断模块。"),
    )


def add_post_table_narrative(document: ET.Element) -> None:
    body, first_table_index = first_top_level_table_index(document)
    body.insert(
        first_table_index + 1,
        paragraph("本段为错误的机械表后分析说明。"),
    )


def append_to_table_cell(document: ET.Element, table_number: int, row: int, column: int, value: str) -> None:
    table = document.findall(".//w:tbl", NS)[table_number - 1]
    target_row = table.findall("w:tr", NS)[row]
    target_cell = target_row.findall("w:tc", NS)[column]
    target_cell.append(paragraph(value))


def add_open_dd_language(document: ET.Element) -> None:
    append_to_table_cell(document, 1, 0, 1, "相关收入仍需进一步核验。")


def add_generic_defensive_judgment(document: ET.Element) -> None:
    append_to_table_cell(
        document,
        5,
        0,
        1,
        "公司所处赛道具有长期需求，但行业关注度、政策与同业融资不能直接证明公司份额和估值。",
    )


def add_decision_layer_meta_language(document: ET.Element) -> None:
    append_to_table_cell(document, 1, 0, 1, "根据公司提供的材料，公司共有12名员工。")


def add_exclusionary_decision_language(document: ET.Element) -> None:
    append_to_table_cell(document, 5, 0, 1, "未验收项目不纳入本轮估值。")


def add_simulated_post_investment_language(document: ET.Element) -> None:
    append_to_table_cell(document, 8, 1, 0, "模拟投后股东")


def restore_post_investment_shareholder_header(document: ET.Element) -> None:
    table = document.findall(".//w:tbl", NS)[7]
    header = table.find("w:tr", NS)
    values = ["投后股东", "投后认缴注册资本（万元）", "投后持股比例"]
    cells = header.findall("w:tc", NS) if header is not None else []
    for cell, value in zip(cells, values):
        text_nodes = cell.findall(".//w:t", NS)
        if not text_nodes:
            raise ValueError("table 8 header cell has no text node")
        text_nodes[0].text = value
        for node in text_nodes[1:]:
            node.text = ""


def remove_legal_compliance_header(document: ET.Element) -> None:
    table = document.findall(".//w:tbl", NS)[11]
    header = table.find("w:tr", NS)
    values = ["证照资质", "公司当前为研发型企业。"]
    cells = header.findall("w:tc", NS) if header is not None else []
    for cell, value in zip(cells, values):
        text_nodes = cell.findall(".//w:t", NS)
        if not text_nodes:
            raise ValueError("table 12 first row cell has no text node")
        text_nodes[0].text = value
        for node in text_nodes[1:]:
            node.text = ""


def add_transaction_execution_meta_language(document: ET.Element) -> None:
    append_to_table_cell(document, 2, 0, 1, "交易实施按付款安排与工商变更口径执行。")


def add_risk_status_meta_language(document: ET.Element) -> None:
    append_to_table_cell(document, 27, 1, 2, "状态：已接受。")


def add_visible_reasoning_label(document: ET.Element) -> None:
    append_to_table_cell(document, 3, 0, 1, "中心判断：公司具备投资价值。")


def add_formulaic_ai_summary(document: ET.Element) -> None:
    append_to_table_cell(document, 5, 0, 1, "核心逻辑由三项事实构成。")


def add_related_party_risk_tail(document: ET.Element) -> None:
    append_to_table_cell(document, 11, 1, 1, "相关安排用于避免利益冲突及相关不利后果。")


def restore_business_validation_header(document: ET.Element) -> None:
    table = document.findall(".//w:tbl", NS)[17]
    header = table.find("w:tr", NS)
    values = ["业务阶段", "主要产品/服务", "收入来源", "商业验证"]
    cells = header.findall("w:tc", NS) if header is not None else []
    for cell, value in zip(cells, values):
        text_nodes = cell.findall(".//w:t", NS)
        if not text_nodes:
            raise ValueError("table 18 header cell has no text node")
        text_nodes[0].text = value
        for node in text_nodes[1:]:
            node.text = ""


def add_advisory_conclusion(document: ET.Element) -> None:
    body = document.find("w:body", NS)
    if body is None:
        raise ValueError("report has no document body")
    children = list(body)
    conclusion_index = next(
        (
            index
            for index, child in reversed(list(enumerate(children)))
            if child.tag == Q("p") and "投资结论" in normalized_text(child)
        ),
        None,
    )
    if conclusion_index is None:
        raise ValueError("report has no investment conclusion heading")
    body.insert(conclusion_index + 1, paragraph("建议推进本轮投资。"))


def add_formulaic_approval_conclusion(document: ET.Element) -> None:
    body = document.find("w:body", NS)
    if body is None:
        raise ValueError("report has no document body")
    children = list(body)
    conclusion_index = next(
        (
            index
            for index, child in reversed(list(enumerate(children)))
            if child.tag == Q("p") and "投资结论" in normalized_text(child)
        ),
        None,
    )
    if conclusion_index is None:
        raise ValueError("report has no investment conclusion heading")
    body.insert(
        conclusion_index + 1,
        paragraph("本项目投资结论为同意按照本报告所列交易方案实施投资。"),
    )


def restore_advisory_risk_header(document: ET.Element) -> None:
    table = document.findall(".//w:tbl", NS)[26]
    header = table.find("w:tr", NS)
    cells = header.findall("w:tc", NS) if header is not None else []
    text_nodes = cells[2].findall(".//w:t", NS) if len(cells) >= 3 else []
    if not text_nodes:
        raise ValueError("table 27 third header has no text node")
    text_nodes[0].text = "风险控制建议"
    for node in text_nodes[1:]:
        node.text = ""


def run_validator(
    validator: Path,
    report: Path,
    target_company: str | None,
    forbidden: list[str],
) -> tuple[int, dict[str, object]]:
    command = [
        sys.executable,
        str(validator),
        str(report),
        "--report-stage",
        "investment-recommendation",
        "--strict-sample-schema",
    ]
    if target_company:
        command.extend(["--target-company", target_company])
    for term in forbidden:
        command.extend(["--forbid-term", term])
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"validator did not return JSON (exit={completed.returncode}): {completed.stderr}"
        ) from exc
    return completed.returncode, result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("accepted_report", type=Path)
    parser.add_argument("--target-company")
    parser.add_argument("--forbid-term", action="append", default=[])
    args = parser.parse_args()

    skill_root = Path(__file__).resolve().parents[1]
    validator = skill_root / "scripts" / "validate_dd_report.py"
    template = skill_root / "assets" / "primary-dd-report-template.docx"
    accepted_report = args.accepted_report.resolve()

    template_table_11_header = table_header(template, 11)
    if template_table_11_header != EXPECTED_TABLE_11_HEADER:
        raise SystemExit(
            f"template table-11 header mismatch: {template_table_11_header!r} != {EXPECTED_TABLE_11_HEADER!r}"
        )
    template_table_12_header = table_header(template, 12)
    if template_table_12_header != EXPECTED_TABLE_12_HEADER:
        raise SystemExit(
            f"template table-12 header mismatch: {template_table_12_header!r} != {EXPECTED_TABLE_12_HEADER!r}"
        )
    template_risk_header = table_header(template, 27)
    if template_risk_header != EXPECTED_TABLE_27_HEADER:
        raise SystemExit(
            f"template table-27 header mismatch: {template_risk_header!r} != {EXPECTED_TABLE_27_HEADER!r}"
        )
    for table_number, expected_header in EXPECTED_BUSINESS_HEADERS.items():
        actual_header = table_header(template, table_number)
        if actual_header != expected_header:
            raise SystemExit(
                f"template table-{table_number} header mismatch: {actual_header!r} != {expected_header!r}"
            )

    positive_code, positive = run_validator(
        validator, accepted_report, args.target_company, args.forbid_term
    )
    if positive_code != 0 or positive.get("status") != "pass":
        raise SystemExit(f"accepted report failed strict validation: {positive!r}")

    cases = [
        (
            "historical_table_11_header",
            make_historical_regression,
            "TABLE_HEADER_CONTRACT",
        ),
        (
            "visible_evidence_id",
            lambda source, output: write_mutation(source, output, add_visible_evidence_id),
            "VISIBLE_EVIDENCE_ID",
        ),
        (
            "unauthorized_preface",
            lambda source, output: write_mutation(source, output, add_unauthorized_preface),
            "UNAUTHORIZED_PREFACE_BLOCK",
        ),
        (
            "judgment_module",
            lambda source, output: write_mutation(source, output, add_judgment_module),
            "UNAUTHORIZED_JUDGMENT_MODULE",
        ),
        (
            "post_table_narrative",
            lambda source, output: write_mutation(source, output, add_post_table_narrative),
            "UNAUTHORIZED_POST_TABLE_NARRATIVE",
        ),
        (
            "open_dd_language",
            lambda source, output: write_mutation(source, output, add_open_dd_language),
            "OPEN_DD_LANGUAGE",
        ),
        (
            "generic_defensive_judgment",
            lambda source, output: write_mutation(source, output, add_generic_defensive_judgment),
            "GENERIC_DEFENSIVE_JUDGMENT",
        ),
        (
            "decision_layer_meta_language",
            lambda source, output: write_mutation(source, output, add_decision_layer_meta_language),
            "DECISION_LAYER_META_LANGUAGE",
        ),
        (
            "exclusionary_decision_language",
            lambda source, output: write_mutation(source, output, add_exclusionary_decision_language),
            "EXCLUSIONARY_DECISION_LANGUAGE",
        ),
        (
            "simulated_post_investment_language",
            lambda source, output: write_mutation(source, output, add_simulated_post_investment_language),
            "SIMULATED_POST_INVESTMENT_LANGUAGE",
        ),
        (
            "post_investment_shareholder_header",
            lambda source, output: write_mutation(source, output, restore_post_investment_shareholder_header),
            "TABLE_HEADER_CONTRACT",
        ),
        (
            "missing_legal_compliance_header",
            lambda source, output: write_mutation(source, output, remove_legal_compliance_header),
            "TABLE_HEADER_CONTRACT",
        ),
        (
            "transaction_execution_meta_language",
            lambda source, output: write_mutation(source, output, add_transaction_execution_meta_language),
            "TRANSACTION_EXECUTION_META_LANGUAGE",
        ),
        (
            "risk_status_meta_language",
            lambda source, output: write_mutation(source, output, add_risk_status_meta_language),
            "RISK_STATUS_META_LANGUAGE",
        ),
        (
            "visible_reasoning_label",
            lambda source, output: write_mutation(source, output, add_visible_reasoning_label),
            "VISIBLE_REASONING_LABEL",
        ),
        (
            "formulaic_ai_summary",
            lambda source, output: write_mutation(source, output, add_formulaic_ai_summary),
            "FORMULAIC_AI_SUMMARY",
        ),
        (
            "related_party_risk_tail",
            lambda source, output: write_mutation(source, output, add_related_party_risk_tail),
            "ASSOCIATION_RISK_NARRATIVE_SPILL",
        ),
        (
            "business_validation_header",
            lambda source, output: write_mutation(source, output, restore_business_validation_header),
            "BUSINESS_VALIDATION_COLUMN_DUPLICATION",
        ),
        (
            "formulaic_approval_conclusion",
            lambda source, output: write_mutation(source, output, add_formulaic_approval_conclusion),
            "FORMULAIC_APPROVAL_CONCLUSION",
        ),
        (
            "advisory_risk_header",
            lambda source, output: write_mutation(source, output, restore_advisory_risk_header),
            "TABLE_HEADER_CONTRACT",
        ),
    ]
    results = []
    with tempfile.TemporaryDirectory(prefix="dd-feedback-regression-") as tmp:
        for name, make_negative, expected_code in cases:
            negative_report = Path(tmp) / f"{name}.docx"
            make_negative(accepted_report, negative_report)
            negative_code, negative = run_validator(
                validator, negative_report, args.target_company, args.forbid_term
            )
            error_codes = {
                error.get("code")
                for error in negative.get("errors", [])
                if isinstance(error, dict)
            }
            if negative_code == 0 or negative.get("status") != "fail":
                raise SystemExit(f"{name} was not rejected")
            if expected_code not in error_codes:
                raise SystemExit(
                    f"{name} failed for the wrong reason: {sorted(error_codes)!r}"
                )
            results.append(
                {
                    "mutation": name,
                    "expected_code": expected_code,
                    "error_codes": sorted(error_codes),
                }
            )

    print(
        json.dumps(
            {
                "status": "pass",
                "accepted_report": str(accepted_report),
                "template_table_11_header": template_table_11_header,
                "template_table_12_header": template_table_12_header,
                "template_table_27_header": template_risk_header,
                "positive_status": positive.get("status"),
                "negative_cases": results,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
