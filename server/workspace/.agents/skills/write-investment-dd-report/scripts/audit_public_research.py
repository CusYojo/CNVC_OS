#!/usr/bin/env python3
"""审计公开信息检索日志是否覆盖尽调所需的核心问题域。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


REQUIRED_AREAS = {
    "entity",
    "team",
    "product",
    "customers_cases",
    "financing",
    "intellectual_property",
    "compliance",
    "market_competition",
}
AREA_REQUIRED_FIELDS = {
    "entity": {"entity.basic_registry", "ownership.public_ownership"},
    "team": {"team.core_people"},
    "product": {"product.product_matrix"},
    "customers_cases": {"business.public_customer_cases"},
    "financing": {"ownership.financing_history"},
    "intellectual_property": {"product.ip_schedule"},
    "compliance": {"legal.public_compliance"},
    "market_competition": {"market.competitor_matrix"},
}
SOURCE_CLASSES = {
    "official_company",
    "government",
    "regulator_registry",
    "customer_primary",
    "partner_primary",
    "investor_primary",
    "marketplace_primary",
    "media",
    "secondary_database",
    "research",
}
PRIMARY_CLASSES = {
    "official_company",
    "government",
    "regulator_registry",
    "customer_primary",
    "partner_primary",
    "investor_primary",
    "marketplace_primary",
}
STATUSES = {"supported", "exhausted_no_result", "conflicted", "not_applicable"}
TREATMENTS = {"fact", "analysis", "valuation", "transaction_condition", "omit"}


def load(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError("public-research.json must contain an object")
    return value


def audit(data: dict) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    project = data.get("project")
    if not isinstance(project, dict):
        errors.append("project must be an object")
        project = {}
    for key in ("legal_entity", "cutoff_date"):
        if not str(project.get(key, "")).strip():
            errors.append(f"project.{key} is required")

    queries = data.get("queries")
    if not isinstance(queries, list):
        errors.append("queries must be an array")
        queries = []
    sources = data.get("sources")
    if not isinstance(sources, list):
        errors.append("sources must be an array")
        sources = []
    coverage = data.get("coverage")
    if not isinstance(coverage, list):
        errors.append("coverage must be an array")
        coverage = []

    query_ids: set[str] = set()
    queried_areas: set[str] = set()
    query_count_by_area = {area: 0 for area in REQUIRED_AREAS}
    queried_fields_by_area = {area: set() for area in REQUIRED_AREAS}
    for index, query in enumerate(queries, 1):
        label = f"queries[{index}]"
        if not isinstance(query, dict):
            errors.append(f"{label} must be an object")
            continue
        query_id = str(query.get("id", "")).strip()
        if not query_id:
            errors.append(f"{label}.id is required")
        elif query_id in query_ids:
            errors.append(f"duplicate query id: {query_id}")
        query_ids.add(query_id)
        area = str(query.get("area", "")).strip()
        if area not in REQUIRED_AREAS:
            errors.append(f"{label}.area is unsupported: {area}")
        else:
            queried_areas.add(area)
            query_count_by_area[area] += 1
        for key in ("query", "date"):
            if not str(query.get(key, "")).strip():
                errors.append(f"{label}.{key} is required")
        if not isinstance(query.get("result_count"), int) or query.get("result_count") < 0:
            errors.append(f"{label}.result_count must be a non-negative integer")
        if not isinstance(query.get("source_ids", []), list):
            errors.append(f"{label}.source_ids must be an array")
        field_ids = query.get("field_ids")
        if not isinstance(field_ids, list) or not field_ids:
            errors.append(f"{label}.field_ids must be a non-empty array")
        elif area in REQUIRED_AREAS:
            queried_fields_by_area[area].update(map(str, field_ids))

    missing_query_areas = sorted(REQUIRED_AREAS - queried_areas)
    if missing_query_areas:
        errors.append("missing query coverage: " + ", ".join(missing_query_areas))
    for area, count in sorted(query_count_by_area.items()):
        if count < 2:
            errors.append(f"area '{area}' requires at least two distinct queries, got {count}")
        missing_fields = AREA_REQUIRED_FIELDS[area] - queried_fields_by_area[area]
        if missing_fields:
            errors.append(
                f"area '{area}' lacks field-level queries for: {', '.join(sorted(missing_fields))}"
            )

    source_ids: set[str] = set()
    primary_count = 0
    supported_fields: set[str] = set()
    for index, source in enumerate(sources, 1):
        label = f"sources[{index}]"
        if not isinstance(source, dict):
            errors.append(f"{label} must be an object")
            continue
        source_id = str(source.get("id", "")).strip()
        if not source_id:
            errors.append(f"{label}.id is required")
        elif source_id in source_ids:
            errors.append(f"duplicate source id: {source_id}")
        source_ids.add(source_id)
        for key in ("title", "publisher", "url", "accessed_date", "entity"):
            if not str(source.get(key, "")).strip():
                errors.append(f"{label}.{key} is required")
        source_class = str(source.get("source_class", "")).strip()
        if source_class not in SOURCE_CLASSES:
            errors.append(f"{label}.source_class is unsupported: {source_class}")
        if source_class in PRIMARY_CLASSES:
            primary_count += 1
        supports = source.get("supports")
        if not isinstance(supports, list) or not supports:
            errors.append(f"{label}.supports must be a non-empty array")
        else:
            for support_index, support in enumerate(supports, 1):
                support_label = f"{label}.supports[{support_index}]"
                if not isinstance(support, dict):
                    errors.append(
                        f"{support_label} must be an object with field_id, claim and as_of_date"
                    )
                    continue
                for key in ("field_id", "claim", "as_of_date"):
                    if not str(support.get(key, "")).strip():
                        errors.append(f"{support_label}.{key} is required")
                field_id = str(support.get("field_id", "")).strip()
                if field_id:
                    supported_fields.add(field_id)

    if len(sources) < 4:
        errors.append("at least four adopted public sources are required")
    if primary_count < 3:
        errors.append("at least three adopted sources must be primary or authoritative")

    covered_areas: set[str] = set()
    coverage_fields_by_area = {area: set() for area in REQUIRED_AREAS}
    for index, item in enumerate(coverage, 1):
        label = f"coverage[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{label} must be an object")
            continue
        area = str(item.get("area", "")).strip()
        if area not in REQUIRED_AREAS:
            errors.append(f"{label}.area is unsupported: {area}")
        else:
            covered_areas.add(area)
        status = str(item.get("status", "")).strip()
        treatment = str(item.get("reader_treatment", "")).strip()
        if status not in STATUSES:
            errors.append(f"{label}.status is unsupported: {status}")
        if treatment not in TREATMENTS:
            errors.append(f"{label}.reader_treatment is unsupported: {treatment}")
        field_ids = item.get("field_ids")
        if not isinstance(field_ids, list) or not field_ids:
            errors.append(f"{label}.field_ids must be a non-empty array")
        elif area in REQUIRED_AREAS:
            coverage_fields_by_area[area].update(map(str, field_ids))
        item_query_ids = item.get("query_ids")
        if not isinstance(item_query_ids, list) or not item_query_ids:
            errors.append(f"{label}.query_ids must be a non-empty array")
        else:
            unknown = sorted(set(map(str, item_query_ids)) - query_ids)
            if unknown:
                errors.append(f"{label}: unknown query id(s): {', '.join(unknown)}")
        item_source_ids = item.get("source_ids", [])
        if not isinstance(item_source_ids, list):
            errors.append(f"{label}.source_ids must be an array")
        else:
            unknown = sorted(set(map(str, item_source_ids)) - source_ids)
            if unknown:
                errors.append(f"{label}: unknown source id(s): {', '.join(unknown)}")
            if status == "supported" and not item_source_ids:
                errors.append(f"{label}: supported coverage requires source_ids")
            if status == "supported" and isinstance(field_ids, list):
                unsupported = sorted(set(map(str, field_ids)) - supported_fields)
                if unsupported:
                    errors.append(
                        f"{label}: supported field(s) lack atomic source claims: {', '.join(unsupported)}"
                    )
        if status == "exhausted_no_result" and treatment in {"fact", "analysis"}:
            errors.append(f"{label}: no-result coverage cannot become a reader-facing fact or analysis")

    missing_coverage = sorted(REQUIRED_AREAS - covered_areas)
    if missing_coverage:
        errors.append("missing coverage disposition: " + ", ".join(missing_coverage))
    for area, required_fields in sorted(AREA_REQUIRED_FIELDS.items()):
        missing_fields = required_fields - coverage_fields_by_area[area]
        if missing_fields:
            errors.append(
                f"area '{area}' lacks field-level disposition for: {', '.join(sorted(missing_fields))}"
            )

    for query in queries:
        if not isinstance(query, dict):
            continue
        unknown = sorted(set(map(str, query.get("source_ids", []))) - source_ids)
        if unknown:
            errors.append(f"query {query.get('id', '')}: unknown source id(s): {', '.join(unknown)}")

    return errors, warnings


def self_test() -> int:
    queries = []
    sources = []
    coverage = []
    for area_index, area in enumerate(sorted(REQUIRED_AREAS), 1):
        source_id = f"S{area_index}"
        field_ids = sorted(AREA_REQUIRED_FIELDS[area])
        sources.append(
            {
                "id": source_id,
                "title": f"{area}官方来源",
                "publisher": "主管机关或交易相对方",
                "url": f"https://example.com/{area}",
                "accessed_date": "2026-08-05",
                "source_class": "government",
                "entity": "测试公司有限公司",
                "supports": [
                    {
                        "field_id": field_id,
                        "claim": f"支持字段{field_id}的原子事实",
                        "as_of_date": "2026-08-05",
                    }
                    for field_id in field_ids
                ],
            }
        )
        query_ids = []
        for query_index in range(1, 3):
            query_id = f"Q{area_index}_{query_index}"
            query_ids.append(query_id)
            queries.append(
                {
                    "id": query_id,
                    "area": area,
                    "field_ids": field_ids,
                    "query": f'"测试公司有限公司" {area} {query_index}',
                    "date": "2026-08-05",
                    "result_count": 1,
                    "source_ids": [source_id],
                }
            )
        coverage.append(
            {
                "area": area,
                "field_ids": field_ids,
                "status": "supported",
                "reader_treatment": "fact",
                "query_ids": query_ids,
                "source_ids": [source_id],
            }
        )
    good = {
        "project": {"legal_entity": "测试公司有限公司", "cutoff_date": "2026-08-05"},
        "queries": queries,
        "sources": sources,
        "coverage": coverage,
    }
    errors, warnings = audit(good)
    if errors or warnings:
        print("ERROR: public research valid self-test failed")
        for item in errors + warnings:
            print(item)
        return 1
    bad = json.loads(json.dumps(good))
    bad["queries"][0].pop("field_ids")
    errors, _ = audit(bad)
    if not errors:
        print("ERROR: public research negative self-test failed")
        return 1
    print("Public research audit self-test: passed")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("research_log", nargs="?")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if not args.research_log:
        parser.error("research_log is required unless --self-test is used")
    try:
        errors, warnings = audit(load(Path(args.research_log).resolve()))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}")
        return 1
    for warning in warnings:
        print(f"WARNING: {warning}")
    for error in errors:
        print(f"ERROR: {error}")
    print(f"Public research audit: {len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors or warnings else 0


if __name__ == "__main__":
    raise SystemExit(main())
