#!/usr/bin/env python3
"""Validate a public-information cross-verification record for a compliance note."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


REQUIRED_TOP_LEVEL = {
    "schema_version", "project", "as_of_date", "scope", "entities", "checks",
    "limitations", "conflicts", "summary",
}
REQUIRED_CATEGORIES = {
    "corporate_registration",
    "administrative_penalties",
    "credit_and_enforcement",
    "litigation",
    "intellectual_property",
    "licences_and_filings",
    "public_adverse_information",
}
OFFICIAL_REQUIRED_CATEGORIES = REQUIRED_CATEGORIES - {"public_adverse_information"}
SOURCE_TYPES = {
    "government", "judicial", "regulator", "ip_office", "company_official",
    "reliable_media", "commercial_database", "search_lead",
}
OFFICIAL_SOURCE_TYPES = {"government", "judicial", "regulator", "ip_office"}
CHECK_STATUSES = {
    "verified", "finding", "access_limited", "not_applicable", "identity_unresolved",
}
CLAIM_TYPES = {"fact_confirmed", "no_adverse_found", "finding", "access_limited"}
IDENTITY_STATUSES = {"matched", "partial", "unresolved"}
MODES = {"online", "online_limited", "offline_user_requested"}
ABSOLUTE_NO_RISK_PHRASES = ["不存在", "绝无", "完全没有", "百分之百", "已全面排除"]
SENSITIVE_QUERY_MARKERS = [
    "基金合伙协议", "投资金额", "拟投资", "投前估值", "投后估值", "返投安排",
    "老股受让", "交易结构", "投委会", "保密",
]


def is_iso_date(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return dt.date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def is_http_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def validate_record(record: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    missing = sorted(REQUIRED_TOP_LEVEL - set(record))
    if missing:
        errors.append(f"missing top-level keys: {missing}")

    if record.get("schema_version") != "1.0":
        errors.append("schema_version must be '1.0'")
    if not is_iso_date(record.get("as_of_date")):
        errors.append("as_of_date must be an ISO date (YYYY-MM-DD)")

    project = record.get("project")
    if not isinstance(project, dict):
        errors.append("project must be an object")
        project = {}
    if not isinstance(project.get("name"), str) or not project.get("name", "").strip():
        errors.append("project.name is required")
    uscc = project.get("unified_social_credit_code", "")
    if not re.fullmatch(r"[0-9A-Z]{18}", uscc):
        errors.append("project.unified_social_credit_code must be 18 uppercase characters")

    scope = record.get("scope")
    if not isinstance(scope, dict):
        errors.append("scope must be an object")
        scope = {}
    mode = scope.get("mode")
    if mode not in MODES:
        errors.append(f"scope.mode must be one of {sorted(MODES)}")
    queries = scope.get("query_terms")
    if not isinstance(queries, list) or not all(isinstance(q, str) and q.strip() for q in queries):
        errors.append("scope.query_terms must be a non-empty string array")
        queries = []
    sensitive_hits = sorted({marker for query in queries for marker in SENSITIVE_QUERY_MARKERS if marker in query})
    if sensitive_hits:
        errors.append(f"query_terms contain confidential transaction markers: {sensitive_hits}")
    if scope.get("sensitive_terms_excluded") is not True:
        errors.append("scope.sensitive_terms_excluded must be true")
    excluded = scope.get("excluded_sensitive_topics")
    if not isinstance(excluded, list) or not excluded:
        errors.append("scope.excluded_sensitive_topics must record excluded confidential topics")
    if scope.get("coverage_status") not in {"complete", "limited", "offline"}:
        errors.append("scope.coverage_status must be complete, limited, or offline")

    entities = record.get("entities")
    if not isinstance(entities, list) or not entities:
        errors.append("entities must be a non-empty array")
        entities = []
    entity_ids: set[str] = set()
    primary_matched = False
    for index, entity in enumerate(entities):
        prefix = f"entities[{index}]"
        if not isinstance(entity, dict):
            errors.append(f"{prefix} must be an object")
            continue
        entity_id = entity.get("entity_id")
        if not isinstance(entity_id, str) or not entity_id:
            errors.append(f"{prefix}.entity_id is required")
        elif entity_id in entity_ids:
            errors.append(f"duplicate entity_id: {entity_id}")
        else:
            entity_ids.add(entity_id)
        if entity.get("identity_status") not in IDENTITY_STATUSES:
            errors.append(f"{prefix}.identity_status is invalid")
        if not isinstance(entity.get("match_basis"), list) or not entity.get("match_basis"):
            errors.append(f"{prefix}.match_basis must be a non-empty array")
        identifiers = entity.get("identifiers")
        if not isinstance(identifiers, dict):
            errors.append(f"{prefix}.identifiers must be an object")
            identifiers = {}
        if entity.get("role") == "primary_target" and entity.get("identity_status") == "matched":
            if identifiers.get("unified_social_credit_code") != uscc:
                errors.append(f"{prefix} primary target USCC does not match project")
            else:
                primary_matched = True
    if mode != "offline_user_requested" and not primary_matched:
        errors.append("online verification requires a matched primary target identified by USCC")

    checks = record.get("checks")
    if not isinstance(checks, list):
        errors.append("checks must be an array")
        checks = []
    seen_categories: set[str] = set()
    check_ids: set[str] = set()
    source_ids: set[str] = set()
    for index, check in enumerate(checks):
        prefix = f"checks[{index}]"
        if not isinstance(check, dict):
            errors.append(f"{prefix} must be an object")
            continue
        check_id = check.get("check_id")
        if not isinstance(check_id, str) or not check_id:
            errors.append(f"{prefix}.check_id is required")
        elif check_id in check_ids:
            errors.append(f"duplicate check_id: {check_id}")
        else:
            check_ids.add(check_id)
        category = check.get("category")
        if category not in REQUIRED_CATEGORIES:
            errors.append(f"{prefix}.category is invalid: {category!r}")
        elif category in seen_categories:
            errors.append(f"duplicate check category: {category}")
        else:
            seen_categories.add(category)
        if check.get("entity_id") not in entity_ids:
            errors.append(f"{prefix}.entity_id does not reference a declared entity")
        status = check.get("status")
        if status not in CHECK_STATUSES:
            errors.append(f"{prefix}.status is invalid")
        claim_type = check.get("claim_type")
        if claim_type not in CLAIM_TYPES:
            errors.append(f"{prefix}.claim_type is invalid")
        conclusion = check.get("conclusion")
        if not isinstance(conclusion, str) or not conclusion.strip():
            errors.append(f"{prefix}.conclusion is required")
            conclusion = ""
        absolute_hits = [phrase for phrase in ABSOLUTE_NO_RISK_PHRASES if phrase in conclusion]
        if absolute_hits:
            errors.append(f"{prefix}.conclusion contains absolute no-risk wording: {absolute_hits}")
        if claim_type == "no_adverse_found" and (
            "截至" not in conclusion or "在列明公开渠道未发现" not in conclusion
        ):
            errors.append(
                f"{prefix}.no_adverse_found must say '截至…在列明公开渠道未发现'"
            )
        check_queries = check.get("queries")
        if not isinstance(check_queries, list) or not all(
            isinstance(query, str) and query.strip() for query in check_queries
        ):
            errors.append(f"{prefix}.queries must be a non-empty string array")
            check_queries = []
        check_sensitive_hits = sorted({
            marker
            for query in check_queries
            for marker in SENSITIVE_QUERY_MARKERS
            if marker in query
        })
        if check_sensitive_hits:
            errors.append(
                f"{prefix}.queries contain confidential transaction markers: "
                f"{check_sensitive_hits}"
            )
        sources = check.get("sources")
        if not isinstance(sources, list):
            errors.append(f"{prefix}.sources must be an array")
            sources = []
        direct_sources = []
        official_sources = []
        for source_index, source in enumerate(sources):
            source_prefix = f"{prefix}.sources[{source_index}]"
            if not isinstance(source, dict):
                errors.append(f"{source_prefix} must be an object")
                continue
            source_id = source.get("source_id")
            if not isinstance(source_id, str) or not source_id:
                errors.append(f"{source_prefix}.source_id is required")
            elif source_id in source_ids:
                errors.append(f"duplicate source_id: {source_id}")
            else:
                source_ids.add(source_id)
            source_type = source.get("source_type")
            if source_type not in SOURCE_TYPES:
                errors.append(f"{source_prefix}.source_type is invalid")
            if not is_http_url(source.get("url")):
                errors.append(f"{source_prefix}.url must be an HTTP(S) URL")
            if not is_iso_date(source.get("accessed_at")):
                errors.append(f"{source_prefix}.accessed_at must be an ISO date")
            if not source.get("title") or not source.get("publisher"):
                errors.append(f"{source_prefix}.title and publisher are required")
            if not isinstance(source.get("matched_identifiers"), list) or not source.get("matched_identifiers"):
                errors.append(f"{source_prefix}.matched_identifiers must be non-empty")
            if source.get("direct") is True and source_type != "search_lead":
                direct_sources.append(source)
            if source.get("direct") is True and source_type in OFFICIAL_SOURCE_TYPES:
                official_sources.append(source)
            if source_type == "search_lead" and source.get("direct") is True:
                errors.append(f"{source_prefix} search_lead cannot be a direct source")
        if status in {"verified", "finding"} and not direct_sources:
            errors.append(f"{prefix} verified/finding status requires a direct source")
        if (
            category in OFFICIAL_REQUIRED_CATEGORIES
            and status in {"verified", "finding"}
            and not official_sources
        ):
            errors.append(f"{prefix} requires at least one direct official source")
        limitations = check.get("limitations")
        if not isinstance(limitations, list):
            errors.append(f"{prefix}.limitations must be an array")
            limitations = []
        if status in {"access_limited", "identity_unresolved"} and not limitations:
            errors.append(f"{prefix} limited/unresolved status requires limitations")

    missing_categories = sorted(REQUIRED_CATEGORIES - seen_categories)
    if mode != "offline_user_requested" and missing_categories:
        errors.append(f"missing required check categories: {missing_categories}")

    limitations = record.get("limitations")
    if not isinstance(limitations, list):
        errors.append("limitations must be an array")
    conflicts = record.get("conflicts")
    if not isinstance(conflicts, list):
        errors.append("conflicts must be an array")
        conflicts = []
    unresolved_material = 0
    for index, conflict in enumerate(conflicts):
        prefix = f"conflicts[{index}]"
        if not isinstance(conflict, dict):
            errors.append(f"{prefix} must be an object")
            continue
        if conflict.get("severity") not in {"material", "non_material"}:
            errors.append(f"{prefix}.severity is invalid")
        if conflict.get("status") not in {"resolved", "unresolved"}:
            errors.append(f"{prefix}.status is invalid")
        if conflict.get("severity") == "material" and conflict.get("status") == "unresolved":
            unresolved_material += 1

    summary = record.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be an object")
        summary = {}
    if summary.get("validation_status") != "pass":
        errors.append("summary.validation_status must be pass for a deliverable record")
    if summary.get("coverage_status") != scope.get("coverage_status"):
        errors.append("summary.coverage_status must match scope.coverage_status")
    if summary.get("unresolved_material_conflicts") != unresolved_material:
        errors.append("summary.unresolved_material_conflicts does not match conflicts")
    if unresolved_material:
        errors.append("unresolved material public/internal conflicts block delivery")
    if summary.get("decision_impact") not in {
        "no_material_public_conflict_found", "conditions_added", "not_verified",
    }:
        errors.append("summary.decision_impact is invalid")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input")
    parser.add_argument("--out")
    args = parser.parse_args()
    path = Path(args.input).expanduser().resolve()
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"pass": False, "errors": [str(exc)]}, ensure_ascii=False))
        return 2
    if not isinstance(record, dict):
        errors = ["root value must be an object"]
    else:
        errors = validate_record(record)
    result = {
        "pass": not errors,
        "input": str(path),
        "errors": errors,
        "metrics": {
            "entity_count": len(record.get("entities", [])) if isinstance(record, dict) else 0,
            "check_count": len(record.get("checks", [])) if isinstance(record, dict) else 0,
            "conflict_count": len(record.get("conflicts", [])) if isinstance(record, dict) else 0,
        },
    }
    if args.out:
        out = Path(args.out).expanduser().resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if not errors else 2


if __name__ == "__main__":
    sys.exit(main())
