#!/usr/bin/env python3
"""Audit field-level investment-committee completeness before DOCX generation."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


MODES = {
    "screening_public",
    "business_dd",
    "financial_dd",
    "legal_dd",
    "technical_dd",
    "pre_ic",
    "comprehensive_ic",
}
STATUSES = {"supported", "conflicted", "absent", "not_applicable"}
SOURCE_GRADES = {
    "primary_document",
    "management_record",
    "third_party_primary",
    "public_authoritative",
    "public_secondary",
    "analyst_model",
    "not_applicable",
}
DECISIONS = {"invest", "conditional_invest", "defer", "decline"}

SCREENING_REQUIRED = {
    "entity.basic_registry",
    "ownership.public_ownership",
    "team.core_people",
    "product.product_matrix",
    "business.public_customer_cases",
    "market.competitor_matrix",
    "legal.public_compliance",
    "decision.recommendation",
}

PRE_IC_REQUIRED = {
    "entity.basic_registry",
    "ownership.current_cap_table",
    "ownership.financing_history",
    "ownership.control",
    "team.core_people",
    "team.organization_headcount",
    "product.product_matrix",
    "product.technology_architecture",
    "product.ip_schedule",
    "business.customer_closed_loop",
    "business.revenue_breakdown",
    "finance.historical_financials",
    "finance.cash_runway",
    "finance.forecast_and_funding",
    "market.competitor_matrix",
    "legal.compliance_schedule",
    "legal.related_party_transactions",
    "transaction.round_terms",
    "transaction.pro_forma_cap_table",
    "valuation.valuation_result",
    "risk.risk_register",
    "decision.recommendation",
}

COMPREHENSIVE_EXTRA = {
    "business.cost_and_suppliers",
    "finance.working_capital",
    "valuation.return_scenarios",
    "legal.material_contracts",
}

SPECIALIZED_REQUIRED = {
    "business_dd": {
        "entity.basic_registry",
        "product.product_matrix",
        "business.customer_closed_loop",
        "business.revenue_breakdown",
        "market.competitor_matrix",
        "decision.recommendation",
    },
    "financial_dd": {
        "entity.basic_registry",
        "business.revenue_breakdown",
        "finance.historical_financials",
        "finance.cash_runway",
        "finance.working_capital",
        "finance.forecast_and_funding",
        "decision.recommendation",
    },
    "legal_dd": {
        "entity.basic_registry",
        "ownership.current_cap_table",
        "ownership.control",
        "product.ip_schedule",
        "legal.compliance_schedule",
        "legal.related_party_transactions",
        "legal.material_contracts",
        "decision.recommendation",
    },
    "technical_dd": {
        "entity.basic_registry",
        "team.core_people",
        "product.product_matrix",
        "product.technology_architecture",
        "product.ip_schedule",
        "decision.recommendation",
    },
}

REQUIRED_REPORT_ROLES = {
    "business_dd": {
        "company_key_facts", "product_matrix", "customer_closed_loop",
        "revenue_breakdown", "competitor_matrix", "decision",
    },
    "financial_dd": {
        "company_key_facts", "revenue_breakdown", "historical_financials",
        "cash_runway", "working_capital", "forecast_and_funding", "decision",
    },
    "legal_dd": {
        "company_key_facts", "cap_table", "control_structure", "ip_schedule",
        "legal_compliance", "related_party_transactions", "material_contracts", "decision",
    },
    "technical_dd": {
        "company_key_facts", "team", "product_matrix", "technology_architecture",
        "ip_schedule", "decision",
    },
    "pre_ic": {
        "company_key_facts",
        "transaction_summary",
        "cap_table",
        "team",
        "product_matrix",
        "customer_closed_loop",
        "historical_financials",
        "forecast_and_funding",
        "competitor_matrix",
        "valuation",
        "risk_register",
        "decision",
    },
    "comprehensive_ic": {
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
        "revenue_breakdown",
        "historical_financials",
        "cash_runway",
        "forecast_and_funding",
        "competitor_matrix",
        "legal_compliance",
        "related_party_transactions",
        "valuation",
        "return_scenarios",
        "risk_register",
        "decision",
    },
}

ROLE_REQUIRED_FIELD = {
    "company_key_facts": "entity.basic_registry",
    "transaction_summary": "transaction.round_terms",
    "cap_table": "ownership.current_cap_table",
    "financing_history": "ownership.financing_history",
    "control_structure": "ownership.control",
    "team": "team.core_people",
    "organization_headcount": "team.organization_headcount",
    "product_matrix": "product.product_matrix",
    "technology_architecture": "product.technology_architecture",
    "ip_schedule": "product.ip_schedule",
    "customer_closed_loop": "business.customer_closed_loop",
    "public_customer_cases": "business.public_customer_cases",
    "revenue_breakdown": "business.revenue_breakdown",
    "cost_and_suppliers": "business.cost_and_suppliers",
    "historical_financials": "finance.historical_financials",
    "cash_runway": "finance.cash_runway",
    "working_capital": "finance.working_capital",
    "forecast_and_funding": "finance.forecast_and_funding",
    "competitor_matrix": "market.competitor_matrix",
    "legal_compliance": "legal.compliance_schedule",
    "related_party_transactions": "legal.related_party_transactions",
    "material_contracts": "legal.material_contracts",
    "valuation": "valuation.valuation_result",
    "return_scenarios": "valuation.return_scenarios",
    "risk_register": "risk.risk_register",
    "decision": "decision.recommendation",
}

ALLOWED_GRADES: dict[str, set[str]] = {
    "entity.basic_registry": {"primary_document", "public_authoritative"},
    "ownership.current_cap_table": {"primary_document", "public_authoritative"},
    "ownership.public_ownership": {"public_authoritative", "primary_document"},
    "ownership.financing_history": {"primary_document", "management_record", "public_authoritative"},
    "ownership.control": {"primary_document", "public_authoritative"},
    "team.core_people": {"primary_document", "management_record", "third_party_primary", "public_authoritative"},
    "team.organization_headcount": {"primary_document", "management_record"},
    "product.technology_architecture": {"primary_document", "management_record", "third_party_primary"},
    "product.ip_schedule": {"primary_document", "public_authoritative"},
    "business.public_customer_cases": {"third_party_primary", "public_authoritative"},
    "business.customer_closed_loop": {"primary_document", "management_record", "third_party_primary"},
    "business.revenue_breakdown": {"primary_document", "management_record"},
    "business.cost_and_suppliers": {"primary_document", "management_record", "third_party_primary"},
    "finance.historical_financials": {"primary_document", "management_record"},
    "finance.cash_runway": {"primary_document", "management_record"},
    "finance.forecast_and_funding": {"management_record", "analyst_model"},
    "finance.working_capital": {"primary_document", "management_record"},
    "legal.related_party_transactions": {"primary_document", "management_record"},
    "legal.public_compliance": {"public_authoritative"},
    "legal.material_contracts": {"primary_document"},
    "transaction.round_terms": {"primary_document", "management_record"},
    "transaction.pro_forma_cap_table": {"primary_document", "analyst_model"},
    "valuation.valuation_result": {"analyst_model"},
    "valuation.return_scenarios": {"analyst_model"},
    "decision.recommendation": {"analyst_model"},
}

REQUIRED_KEYS: dict[str, tuple[str, ...]] = {
    "entity.basic_registry": (
        "legal_name",
        "unified_social_credit_code",
        "incorporation_date",
        "registered_capital",
        "legal_representative",
        "registered_address",
        "business_scope",
    ),
    "ownership.control": ("actual_controller", "control_path"),
    "team.organization_headcount": ("total_headcount", "full_time_headcount", "departments"),
    "product.technology_architecture": (
        "architecture",
        "third_party_dependencies",
        "performance_metrics",
        "cost_metrics",
    ),
    "finance.historical_financials": (
        "periods",
        "income_statement",
        "balance_sheet",
        "cash_flow",
    ),
    "finance.cash_runway": ("cash_balance", "monthly_net_burn", "runway_months"),
    "finance.forecast_and_funding": ("scenarios", "drivers", "use_of_funds", "funding_need"),
    "transaction.round_terms": (
        "investment_amount",
        "pre_money_valuation",
        "post_money_valuation",
        "expected_ownership_pct",
        "investment_structure",
    ),
    "valuation.valuation_result": ("methods", "valuation_range", "recommended_entry_value"),
    "decision.recommendation": ("action", "rationale", "conditions", "walk_away_triggers"),
}

ROW_RULES: dict[str, tuple[int, tuple[str, ...]]] = {
    "ownership.current_cap_table": (1, ("shareholder", "subscribed_capital", "ownership_pct")),
    "ownership.public_ownership": (1, ("shareholder", "ownership_pct")),
    "ownership.financing_history": (1, ("date", "round", "investors", "amount")),
    "team.core_people": (2, ("name", "role", "resume", "employment_status")),
    "product.product_matrix": (1, ("product", "buyer", "pricing", "delivery", "maturity", "evidence")),
    "product.ip_schedule": (1, ("asset_type", "name", "owner", "status", "acquisition")),
    "business.public_customer_cases": (2, ("customer", "date", "deliverable", "source")),
    "business.customer_closed_loop": (
        3,
        ("customer", "contract", "amount", "delivery", "acceptance", "revenue", "invoice", "cash", "renewal"),
    ),
    "business.revenue_breakdown": (1, ("period", "legal_entity", "product", "customer", "revenue")),
    "business.cost_and_suppliers": (1, ("supplier", "category", "amount", "concentration_pct")),
    "market.competitor_matrix": (3, ("competitor", "product", "customer", "pricing", "strength", "weakness")),
    "legal.compliance_schedule": (4, ("matter", "finding", "evidence", "transaction_impact")),
    "legal.public_compliance": (3, ("matter", "finding", "source")),
    "legal.related_party_transactions": (1, ("related_party", "relationship", "transaction", "amount", "balance", "pricing_basis")),
    "transaction.pro_forma_cap_table": (1, ("shareholder", "fully_diluted_ownership_pct")),
    "risk.risk_register": (
        3,
        ("risk", "fact", "trigger", "probability", "impact", "owner", "deadline", "evidence", "remedy", "residual_risk"),
    ),
    "valuation.return_scenarios": (3, ("scenario", "exit_year", "dilution", "moic", "irr")),
}


def load(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return value


def blank(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def has_number(value: Any) -> bool:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return True
    return bool(re.search(r"\d", str(value)))


def field_map(data: dict[str, Any], errors: list[str]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    fields = data.get("fields")
    if not isinstance(fields, list):
        errors.append("fields must be an array")
        return result
    for index, item in enumerate(fields, 1):
        label = f"fields[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{label} must be an object")
            continue
        field_id = str(item.get("id", "")).strip()
        if not field_id:
            errors.append(f"{label}.id is required")
            continue
        if field_id in result:
            errors.append(f"duplicate field id: {field_id}")
        result[field_id] = item
        status = str(item.get("status", "")).strip()
        grade = str(item.get("source_grade", "")).strip()
        if status not in STATUSES:
            errors.append(f"{field_id}: unsupported status '{status}'")
        if grade not in SOURCE_GRADES:
            errors.append(f"{field_id}: unsupported source_grade '{grade}'")
        if status == "supported":
            evidence_ids = item.get("evidence_ids")
            if not isinstance(evidence_ids, list) or not evidence_ids:
                errors.append(f"{field_id}: supported field requires evidence_ids")
            if not isinstance(item.get("data"), dict) or not item.get("data"):
                errors.append(f"{field_id}: supported field requires non-empty data")
        if status == "conflicted" and blank(item.get("conflict")):
            errors.append(f"{field_id}: conflicted field requires conflict analysis")
        if status == "not_applicable" and blank(item.get("reason")):
            errors.append(f"{field_id}: not_applicable field requires reason")
    return result


def audit(
    data: dict[str, Any], report: dict[str, Any] | None = None, evidence: dict[str, Any] | None = None
) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    project = data.get("project")
    if not isinstance(project, dict):
        errors.append("project must be an object")
        project = {}
    for key in ("name", "legal_entity", "cutoff_date", "currency", "report_mode"):
        if blank(project.get(key)):
            errors.append(f"project.{key} is required")
    mode = str(project.get("report_mode", ""))
    if mode and mode not in MODES:
        errors.append(f"unsupported report_mode '{mode}'")

    fields = field_map(data, errors)
    if mode == "screening_public":
        required = set(SCREENING_REQUIRED)
    elif mode in SPECIALIZED_REQUIRED:
        required = set(SPECIALIZED_REQUIRED[mode])
    else:
        required = set(PRE_IC_REQUIRED)
    if mode == "comprehensive_ic":
        required |= COMPREHENSIVE_EXTRA
    for field_id in sorted(required):
        item = fields.get(field_id)
        if not item:
            errors.append(f"required field missing: {field_id}")
            continue
        if item.get("status") != "supported":
            errors.append(f"required field is not supported: {field_id} ({item.get('status')})")
            continue
        grade = str(item.get("source_grade", ""))
        allowed = ALLOWED_GRADES.get(field_id)
        if allowed and grade not in allowed:
            errors.append(
                f"{field_id}: source_grade '{grade}' is insufficient; expected one of {sorted(allowed)}"
            )

        payload = item.get("data", {})
        for key in REQUIRED_KEYS.get(field_id, ()):
            if blank(payload.get(key)):
                errors.append(f"{field_id}: data.{key} is required")
        if field_id == "decision.recommendation":
            action = payload.get("action")
            if action not in DECISIONS:
                errors.append(
                    f"decision.recommendation: action must be one of {sorted(DECISIONS)}, got '{action}'"
                )
        if field_id == "transaction.round_terms":
            for key in (
                "investment_amount",
                "pre_money_valuation",
                "post_money_valuation",
                "expected_ownership_pct",
            ):
                if not has_number(payload.get(key)):
                    errors.append(f"transaction.round_terms: data.{key} requires a numeric value")
        if field_id == "valuation.valuation_result":
            for key in ("valuation_range", "recommended_entry_value"):
                if not has_number(payload.get(key)):
                    errors.append(f"valuation.valuation_result: data.{key} requires a numeric value")
        if field_id in ROW_RULES:
            minimum, keys = ROW_RULES[field_id]
            rows = payload.get("rows")
            if not isinstance(rows, list) or len(rows) < minimum:
                errors.append(f"{field_id}: requires at least {minimum} row(s)")
            else:
                for row_index, row in enumerate(rows, 1):
                    if not isinstance(row, dict):
                        errors.append(f"{field_id}.rows[{row_index}] must be an object")
                        continue
                    missing = [key for key in keys if blank(row.get(key))]
                    if missing:
                        errors.append(
                            f"{field_id}.rows[{row_index}] missing: {', '.join(missing)}"
                        )

    if evidence is not None:
        known = {
            str(item.get("id"))
            for item in evidence.get("facts", [])
            if isinstance(item, dict) and item.get("id")
        }
        for field_id, item in fields.items():
            cited = set(map(str, item.get("evidence_ids", [])))
            unknown = sorted(cited - known)
            if unknown:
                errors.append(f"{field_id}: unknown evidence id(s): {', '.join(unknown)}")

    if report is not None:
        meta = report.get("meta", {}) if isinstance(report.get("meta"), dict) else {}
        report_type = str(meta.get("report_type", ""))
        template_profile = str(meta.get("template_profile", ""))
        expected_report_type = {
            "screening_public": "screening",
            "business_dd": "business",
            "financial_dd": "financial",
            "legal_dd": "legal",
            "technical_dd": "technical",
            "pre_ic": "pre_ic",
            "comprehensive_ic": "comprehensive",
        }.get(mode)
        if expected_report_type and report_type != expected_report_type:
            errors.append(
                f"report mode mismatch: diligence-data is '{mode}' but report_type is '{report_type}'"
            )
        if mode not in {"pre_ic", "comprehensive_ic"} and template_profile == "deta_v5_up_to_ic":
            errors.append(
                f"{mode} cannot use deta_v5_up_to_ic; obtain pre_ic P0 evidence first"
            )
        role_blocks: dict[str, list[dict[str, Any]]] = {}
        for block in report.get("blocks", []):
            if not isinstance(block, dict) or not block.get("semantic_role"):
                continue
            role = str(block.get("semantic_role"))
            role_blocks.setdefault(role, []).append(block)
            data_field_ids = block.get("data_field_ids")
            if not isinstance(data_field_ids, list) or not data_field_ids:
                errors.append(f"semantic_role '{role}' requires non-empty data_field_ids")
                continue
            unknown_fields = sorted(set(map(str, data_field_ids)) - set(fields))
            if unknown_fields:
                errors.append(
                    f"semantic_role '{role}' references unknown field(s): {', '.join(unknown_fields)}"
                )
            unsupported_fields = sorted(
                field_id
                for field_id in map(str, data_field_ids)
                if field_id in fields and fields[field_id].get("status") != "supported"
            )
            if unsupported_fields:
                errors.append(
                    f"semantic_role '{role}' references unsupported field(s): {', '.join(unsupported_fields)}"
                )
        roles = set(role_blocks)
        for role in sorted(REQUIRED_REPORT_ROLES.get(mode, set()) - roles):
            errors.append(f"reader-facing report lacks semantic_role: {role}")
        for role in sorted(REQUIRED_REPORT_ROLES.get(mode, set()) & roles):
            required_field = ROLE_REQUIRED_FIELD.get(role)
            if not required_field:
                continue
            if not any(
                required_field in set(map(str, block.get("data_field_ids", [])))
                for block in role_blocks[role]
            ):
                errors.append(
                    f"semantic_role '{role}' must bind required field '{required_field}'"
                )

    return errors, warnings


def self_test() -> int:
    def supported(field_id: str, source_grade: str, data: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": field_id,
            "status": "supported",
            "source_grade": source_grade,
            "evidence_ids": ["F1"],
            "data": data,
        }

    good_screening = {
        "project": {
            "name": "测试公司",
            "legal_entity": "测试公司有限公司",
            "cutoff_date": "2026-08-05",
            "currency": "CNY",
            "report_mode": "screening_public",
        },
        "fields": [
            supported("entity.basic_registry", "public_authoritative", {
                "legal_name": "测试公司有限公司", "unified_social_credit_code": "91110000TEST",
                "incorporation_date": "2025-01-01", "registered_capital": "1000万元",
                "legal_representative": "张三", "registered_address": "北京市",
                "business_scope": "软件开发",
            }),
            supported("ownership.public_ownership", "public_authoritative", {
                "rows": [{"shareholder": "张三", "ownership_pct": 100}]
            }),
            supported("team.core_people", "public_authoritative", {
                "rows": [
                    {"name": "张三", "role": "CEO", "resume": "十年行业经验", "employment_status": "全职"},
                    {"name": "李四", "role": "CTO", "resume": "十年研发经验", "employment_status": "全职"},
                ]
            }),
            supported("product.product_matrix", "public_authoritative", {
                "rows": [{"product": "产品A", "buyer": "企业", "pricing": "订阅",
                          "delivery": "SaaS", "maturity": "已上线", "evidence": "官网"}]
            }),
            supported("business.public_customer_cases", "third_party_primary", {
                "rows": [
                    {"customer": "客户A", "date": "2026-01", "deliverable": "系统A", "source": "客户官网"},
                    {"customer": "客户B", "date": "2026-02", "deliverable": "系统B", "source": "客户官网"},
                ]
            }),
            supported("market.competitor_matrix", "analyst_model", {
                "rows": [
                    {"competitor": f"竞品{i}", "product": "软件", "customer": "企业",
                     "pricing": "订阅", "strength": "渠道", "weakness": "定制"}
                    for i in range(1, 4)
                ]
            }),
            supported("legal.public_compliance", "public_authoritative", {
                "rows": [
                    {"matter": f"事项{i}", "finding": "正常", "source": "主管机关"}
                    for i in range(1, 4)
                ]
            }),
            supported("decision.recommendation", "analyst_model", {
                "action": "defer", "rationale": "价格与证据不匹配",
                "conditions": ["取得关键经营证据"], "walk_away_triggers": ["核心权属不成立"],
            }),
        ],
    }
    errors, warnings = audit(good_screening)
    if errors or warnings:
        print("ERROR: valid screening completeness self-test failed")
        for item in errors + warnings:
            print(item)
        return 1

    bad = {
        "project": {
            "name": "测试公司",
            "legal_entity": "测试公司有限公司",
            "cutoff_date": "2026-08-05",
            "currency": "CNY",
            "report_mode": "pre_ic",
        },
        "fields": [],
    }
    errors, _ = audit(bad)
    if not errors or not any("ownership.current_cap_table" in item for item in errors):
        print("ERROR: completeness self-test failed")
        return 1
    screening = {
        "project": {
            "name": "测试公司",
            "legal_entity": "测试公司有限公司",
            "cutoff_date": "2026-08-05",
            "currency": "CNY",
            "report_mode": "screening_public",
        },
        "fields": [],
    }
    report = {"meta": {"report_type": "screening", "template_profile": "deta_v5_up_to_ic"}, "blocks": []}
    errors, _ = audit(screening, report=report)
    if not any("cannot use deta_v5_up_to_ic" in item for item in errors):
        print("ERROR: mode conflict self-test failed")
        return 1
    print("IC completeness self-test: passed")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("diligence_data", nargs="?")
    parser.add_argument("--report")
    parser.add_argument("--evidence")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if not args.diligence_data:
        parser.error("diligence_data is required unless --self-test is used")
    try:
        data = load(Path(args.diligence_data).resolve())
        report = load(Path(args.report).resolve()) if args.report else None
        evidence = load(Path(args.evidence).resolve()) if args.evidence else None
        errors, warnings = audit(data, report=report, evidence=evidence)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}")
        return 1
    for warning in warnings:
        print(f"WARNING: {warning}")
    for error in errors:
        print(f"ERROR: {error}")
    print(f"IC completeness audit: {len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors or warnings else 0


if __name__ == "__main__":
    raise SystemExit(main())
