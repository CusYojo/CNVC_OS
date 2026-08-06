#!/usr/bin/env python3
"""Audit report JSON for evidence discipline and decision completeness."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


REPORT_TYPES = {"comprehensive", "business", "financial", "legal", "technical", "screening", "pre_ic"}
FIELD_DRIVEN_REPORT_TYPES = {"comprehensive", "business", "financial", "legal", "technical", "pre_ic"}
FIXED_REPORT_TITLE = "尽职调查报告"
BLOCK_TYPES = {"heading", "paragraph", "bullet", "numbered_item", "callout", "table", "key_value_table", "image", "page_break", "section_break"}
NATURES = {"fact", "analysis", "recommendation", "gap"}
PLACEHOLDERS = ("[[", "TODO", "TBD", "Lorem", "待补充", "此处填写", "示例文字")
PROMOTIONAL = ("唯一", "第一", "领先", "顶尖", "绝对", "确定性强", "无重大风险")
COMPREHENSIVE_CHAPTERS = {
    "投资概要与建议": ("投资概要", "投资建议"),
    "公司与治理": ("公司", "股权", "治理"),
    "团队与组织": ("团队", "组织"),
    "产品与技术": ("产品", "技术", "知识产权"),
    "业务验证": ("业务", "客户", "供应链"),
    "行业与竞争": ("行业", "市场", "竞争"),
    "财务与资金": ("财务", "资金"),
    "估值回报退出": ("估值", "回报", "退出"),
    "法律合规": ("法律", "合规"),
    "风险": ("风险",),
    "结论与交割": ("结论", "交割", "条件"),
    "尽调缺口或附件": ("尽调缺口", "附件", "来源"),
}
DETA_LEVEL_ONE = (
    "投资概要",
    "公司概况",
    "产品与技术",
    "业务情况",
    "行业和市场",
    "未来发展规划",
    "投资方案",
    "风险提示与对策",
    "投资结论及建议",
)
DETA_OVERVIEW_LEVEL_TWO = (
    "公司情况",
    "交易要点",
    "行业概况",
    "商业模式和经营管理",
    "投资价值与风险",
)
APPENDIX_TOKENS = ("尽调缺口", "资料请求", "来源", "附件", "证据索引")
WORKPAPER_MAIN_BODY_PHRASES = (
    "核查框架",
    "验证框架",
    "核查重点",
    "核查材料",
    "应取得数据",
    "需要回答的事实",
    "必须完成的勾稽",
    "完成标准",
    "底稿要求",
    "优先资料清单",
    "尽调工作流",
    "经营质量评价框架",
    "建议的经营里程碑",
    "建议的估值处理",
)
SEMANTIC_ROLES = {
    "company_key_facts",
    "transaction_summary",
    "cap_table",
    "financing_history",
    "control_structure",
    "team",
    "organization_headcount",
    "product_matrix",
    "technology_architecture",
    "ip_schedule",
    "customer_closed_loop",
    "public_customer_cases",
    "revenue_breakdown",
    "cost_and_suppliers",
    "historical_financials",
    "cash_runway",
    "working_capital",
    "forecast_and_funding",
    "competitor_matrix",
    "legal_compliance",
    "related_party_transactions",
    "material_contracts",
    "valuation",
    "return_scenarios",
    "risk_register",
    "decision",
}
MINIMUM_IC_ROLES = {
    "transaction_summary",
    "cap_table",
    "customer_closed_loop",
    "historical_financials",
    "forecast_and_funding",
    "valuation",
    "risk_register",
    "decision",
}


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return value


def block_text(block: dict) -> str:
    parts = [str(block.get(k, "")) for k in ("title", "label", "text", "caption")]
    parts.extend(str(x) for x in block.get("headers", []) if x is not None)
    for row in block.get("rows", []):
        parts.extend(str(x) for x in row)
    return " ".join(parts)


def audit(report: dict, evidence: dict) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    meta = report.get("meta")
    if not isinstance(meta, dict):
        errors.append("meta must be an object")
        meta = {}
    for key in ("project_name", "legal_entity", "report_title", "report_date", "author", "report_type", "cutoff_date"):
        if not str(meta.get(key, "")).strip():
            errors.append(f"meta.{key} is required")
    report_title = str(meta.get("report_title", "")).strip()
    if report_title and report_title != FIXED_REPORT_TITLE:
        errors.append(
            f"meta.report_title must be exactly '{FIXED_REPORT_TITLE}', got '{report_title}'"
        )
    report_type = str(meta.get("report_type", ""))
    if report_type and report_type not in REPORT_TYPES:
        errors.append(f"unsupported report_type '{report_type}'")
    template_profile = str(meta.get("template_profile", ""))
    if template_profile and template_profile != "deta_v5_up_to_ic":
        errors.append(f"unsupported template_profile '{template_profile}'")

    evidence_ids = {
        str(item.get("id"))
        for item in evidence.get("facts", [])
        if isinstance(item, dict) and item.get("id")
    }
    strong_ids = {
        str(item.get("id"))
        for item in evidence.get("facts", [])
        if isinstance(item, dict) and item.get("status") in {"verified", "third_party_confirmed", "public_fact"}
    }
    blocks = report.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        errors.append("blocks must be a non-empty array")
        return errors, warnings

    headings: list[str] = []
    level_one_headings: list[str] = []
    level_two_headings: list[str] = []
    all_text: list[str] = []
    current_level_one = ""
    appendix_mode = False
    orientation = "portrait"
    overview_slot_waiting_for_content = ""
    semantic_roles: set[str] = set()
    for idx, block in enumerate(blocks, 1):
        label = f"blocks[{idx}]"
        if not isinstance(block, dict):
            errors.append(f"{label} must be an object")
            continue
        kind = str(block.get("type", ""))
        if kind not in BLOCK_TYPES:
            errors.append(f"{label}: unsupported block type '{kind}'")
            continue
        text = block_text(block)
        all_text.append(text)
        role = str(block.get("semantic_role", "")).strip()
        if role:
            semantic_roles.add(role)
            if role not in SEMANTIC_ROLES:
                errors.append(f"{label}: unsupported semantic_role '{role}'")
        if kind == "heading":
            heading_title = str(block.get("title", ""))
            headings.append(heading_title)
            level = block.get("level")
            if level not in {1, 2, 3, 4}:
                errors.append(f"{label}: heading level must be 1-4")
            if level == 1:
                current_level_one = heading_title
                level_one_headings.append(heading_title)
                appendix_mode = any(token in heading_title for token in APPENDIX_TOKENS)
                overview_slot_waiting_for_content = ""
            elif level == 2:
                level_two_headings.append(heading_title)
                if "投资概要" in current_level_one and heading_title in DETA_OVERVIEW_LEVEL_TWO:
                    overview_slot_waiting_for_content = heading_title
        if kind == "section_break":
            requested = str(block.get("orientation", ""))
            if requested not in {"portrait", "landscape"}:
                errors.append(f"{label}: section_break orientation must be portrait or landscape")
            else:
                orientation = requested
            continue
        if kind not in {"heading", "page_break", "section_break"} and not text.strip():
            errors.append(f"{label}: visible content is empty")
        for token in PLACEHOLDERS:
            if token.lower() in text.lower():
                errors.append(f"{label}: unresolved placeholder '{token}'")

        nature = block.get("nature")
        if kind not in {"heading", "page_break", "section_break"}:
            if nature not in NATURES:
                errors.append(f"{label}: nature must be one of {sorted(NATURES)}")
            cited = block.get("evidence_ids", [])
            if not isinstance(cited, list):
                errors.append(f"{label}: evidence_ids must be an array")
                cited = []
            unknown = sorted(set(str(x) for x in cited) - evidence_ids)
            if unknown:
                errors.append(f"{label}: unknown evidence id(s): {', '.join(unknown)}")
            explicit_unverified = bool(re.search(r"未核验|尚未验证|待核实|无法确认", text))
            if nature == "fact" and not cited and not explicit_unverified:
                errors.append(f"{label}: factual content lacks evidence_ids")
            if nature in {"analysis", "recommendation"} and not cited:
                warnings.append(f"{label}: material {nature} has no evidence basis")
            if any(term in text for term in PROMOTIONAL) and not (set(map(str, cited)) & strong_ids):
                errors.append(f"{label}: promotional claim lacks verified/third-party/public evidence")
        if kind == "table":
            headers = block.get("headers", [])
            rows = block.get("rows", [])
            if not headers or not rows:
                errors.append(f"{label}: table needs headers and rows")
            if any(len(row) != len(headers) for row in rows if isinstance(row, list)):
                errors.append(f"{label}: table row width does not match headers")
            if template_profile == "deta_v5_up_to_ic" and len(headers) >= 6 and orientation != "landscape":
                errors.append(f"{label}: Deta table with six or more columns must be in a landscape section")
        if kind == "key_value_table":
            rows = block.get("rows", [])
            if not rows:
                errors.append(f"{label}: key-value table needs rows")
            if any(len(row) != 2 for row in rows if isinstance(row, list)):
                errors.append(f"{label}: key-value rows must contain exactly two cells")
        if (
            kind in {"table", "key_value_table"}
            and report_type in FIELD_DRIVEN_REPORT_TYPES
            and not role
        ):
            errors.append(f"{label}: IC table requires semantic_role")
        if role and report_type in FIELD_DRIVEN_REPORT_TYPES:
            data_field_ids = block.get("data_field_ids")
            if not isinstance(data_field_ids, list) or not data_field_ids:
                errors.append(f"{label}: semantic_role '{role}' requires data_field_ids")

        if template_profile == "deta_v5_up_to_ic":
            if overview_slot_waiting_for_content and kind not in {"heading", "page_break"}:
                if kind != "key_value_table":
                    errors.append(
                        f"{label}: Deta overview slot '{overview_slot_waiting_for_content}' must begin with a key_value_table"
                    )
                overview_slot_waiting_for_content = ""
            if not appendix_mode:
                for phrase in WORKPAPER_MAIN_BODY_PHRASES:
                    if phrase in text:
                        errors.append(f"{label}: workpaper phrase '{phrase}' is not allowed in the reader-facing main body")

    if report_type == "comprehensive":
        heading_text = " ".join(headings)
        for chapter, terms in COMPREHENSIVE_CHAPTERS.items():
            if not any(term in heading_text for term in terms):
                errors.append(f"comprehensive report lacks chapter: {chapter}")
    if report_type in {"pre_ic", "comprehensive"}:
        for role in sorted(MINIMUM_IC_ROLES - semantic_roles):
            errors.append(f"IC report lacks semantic_role: {role}")

    if template_profile == "deta_v5_up_to_ic":
        if report_type not in {"pre_ic", "comprehensive"}:
            errors.append(f"{report_type} report cannot use deta_v5_up_to_ic")
        for required in DETA_LEVEL_ONE:
            if not any(required in heading for heading in level_one_headings):
                errors.append(f"Deta V5 profile lacks level-one chapter: {required}")
        investment_overview_index = next(
            (idx for idx, value in enumerate(level_one_headings) if "投资概要" in value),
            None,
        )
        if investment_overview_index != 0:
            errors.append("Deta V5 profile must start its reader-facing body with 投资概要")
        for required in DETA_OVERVIEW_LEVEL_TWO:
            if not any(required in heading for heading in level_two_headings):
                errors.append(f"Deta V5 investment overview lacks slot: {required}")

    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report")
    parser.add_argument("--evidence", required=True)
    args = parser.parse_args()
    try:
        report = read_json(Path(args.report).resolve())
        evidence = read_json(Path(args.evidence).resolve())
        errors, warnings = audit(report, evidence)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}")
        return 1
    for item in warnings:
        print(f"WARNING: {item}")
    for item in errors:
        print(f"ERROR: {item}")
    print(f"Report content audit: {len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
