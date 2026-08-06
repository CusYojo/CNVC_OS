#!/usr/bin/env python3
"""Audit the evidence ledger before investment-report drafting."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


ALLOWED_STATUS = {
    "verified",
    "third_party_confirmed",
    "public_fact",
    "company_claim",
    "analyst_estimate",
    "analyst_judgment",
    "unverified",
    "conflicted",
}
ALLOWED_MATERIALITY = {"critical", "high", "medium", "low"}
REQUIRED_PROJECT = {"name", "legal_entity", "cutoff_date", "currency"}
REQUIRED_FACT = {"id", "statement", "entity", "status", "materiality", "source", "source_type"}


def load(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError("evidence ledger must be a JSON object")
    return value


def audit(data: dict) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    project = data.get("project")
    if not isinstance(project, dict):
        errors.append("project must be an object")
        project = {}
    for key in sorted(REQUIRED_PROJECT):
        if not str(project.get(key, "")).strip():
            errors.append(f"project.{key} is required")

    facts = data.get("facts")
    if not isinstance(facts, list) or not facts:
        errors.append("facts must be a non-empty array")
        return errors, warnings

    seen: set[str] = set()
    cutoff = str(project.get("cutoff_date", ""))
    for idx, fact in enumerate(facts, 1):
        label = f"facts[{idx}]"
        if not isinstance(fact, dict):
            errors.append(f"{label} must be an object")
            continue
        for key in sorted(REQUIRED_FACT):
            if not str(fact.get(key, "")).strip():
                errors.append(f"{label}.{key} is required")
        fact_id = str(fact.get("id", "")).strip()
        if fact_id in seen:
            errors.append(f"duplicate evidence id: {fact_id}")
        if fact_id:
            seen.add(fact_id)
        if fact_id and not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{1,31}", fact_id):
            warnings.append(f"{fact_id}: use a short stable alphanumeric evidence id")

        status = str(fact.get("status", "")).strip()
        if status and status not in ALLOWED_STATUS:
            errors.append(f"{fact_id or label}: unsupported status '{status}'")
        materiality = str(fact.get("materiality", "")).strip()
        if materiality and materiality not in ALLOWED_MATERIALITY:
            errors.append(f"{fact_id or label}: unsupported materiality '{materiality}'")

        statement = str(fact.get("statement", ""))
        if re.search(r"\d", statement):
            if not str(fact.get("period", "")).strip():
                errors.append(f"{fact_id or label}: numeric statement lacks period")
            if not str(fact.get("unit", "")).strip():
                errors.append(f"{fact_id or label}: numeric statement lacks unit")
        if status == "conflicted" and not fact.get("conflicts"):
            errors.append(f"{fact_id or label}: conflicting evidence requires conflicts")
        if materiality in {"critical", "high"} and status in {"unverified", "company_claim"}:
            warnings.append(f"{fact_id or label}: material fact remains {status}")
        if cutoff and str(fact.get("as_of_date", "")) > cutoff:
            warnings.append(f"{fact_id or label}: as_of_date is after project cutoff_date")
        if not str(fact.get("intended_use", "")).strip():
            warnings.append(f"{fact_id or label}: intended_use is blank")

    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence")
    args = parser.parse_args()
    path = Path(args.evidence).resolve()
    try:
        errors, warnings = audit(load(path))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}")
        return 1
    for item in warnings:
        print(f"WARNING: {item}")
    for item in errors:
        print(f"ERROR: {item}")
    print(f"Evidence audit: {len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
