#!/usr/bin/env python3
"""Validate a decision manifest before drafting or formatting a proposal."""

from __future__ import annotations

import argparse
import ast
import json
import math
import sys
from pathlib import Path
from typing import Any


COVERAGE_KEYS = {
    "commercialization",
    "financials",
    "technology",
    "market_competition",
    "cap_table",
    "transaction",
    "returns",
    "team",
}
CASE_KEYS = {"why_now", "why_company", "why_price", "value_creation", "downside"}
ROLES = {"label", "date", "numeric", "percent", "narrative", "status"}
STYLES = {"grid", "three-line"}
CAPTIONS = {"natural", "numbered", "none"}


def error(code: str, message: str, path: str) -> dict[str, str]:
    return {"code": code, "message": message, "path": path}


def nonempty(value: Any, minimum: int = 1) -> bool:
    return isinstance(value, str) and len(value.strip()) >= minimum


def eval_formula(formula: str, inputs: dict[str, Any]) -> float:
    tree = ast.parse(formula, mode="eval")

    def visit(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return visit(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return float(node.value)
        if isinstance(node, ast.Name) and node.id in inputs and isinstance(inputs[node.id], (int, float)):
            return float(inputs[node.id])
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = visit(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow)):
            left, right = visit(node.left), visit(node.right)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if isinstance(node.op, ast.Div):
                return left / right
            return left**right
        raise ValueError(f"unsupported expression: {ast.dump(node, include_attributes=False)}")

    return visit(tree)


def validate(record: Any) -> tuple[list[dict[str, str]], list[dict[str, str]], int]:
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    if not isinstance(record, dict):
        return [error("INVALID_ROOT", "manifest must be a JSON object", "$")], warnings, 0

    if record.get("schema_version") != 2:
        errors.append(error("INVALID_SCHEMA_VERSION", "schema_version must be 2", "$.schema_version"))

    project = record.get("project")
    if not isinstance(project, dict) or not nonempty(project.get("target_company")) or not nonempty(project.get("source_cutoff_date")):
        errors.append(error("MISSING_PROJECT", "target_company and source_cutoff_date are required", "$.project"))

    decision = record.get("decision")
    if not isinstance(decision, dict):
        errors.append(error("MISSING_DECISION", "decision is required", "$.decision"))
    else:
        for key in ("recommendation", "authorization_boundary"):
            if not nonempty(decision.get(key), 4):
                errors.append(error("INCOMPLETE_DECISION", f"{key} is required", f"$.decision.{key}"))
        kills = decision.get("kill_conditions")
        if not isinstance(kills, list) or len([x for x in kills if nonempty(x, 4)]) < 3:
            errors.append(error("INSUFFICIENT_KILL_CONDITIONS", "at least three concrete kill conditions are required", "$.decision.kill_conditions"))

    case = record.get("investment_case")
    if not isinstance(case, dict):
        errors.append(error("MISSING_INVESTMENT_CASE", "investment_case is required", "$.investment_case"))
    else:
        for key in sorted(CASE_KEYS):
            if not nonempty(case.get(key), 12):
                errors.append(error("INCOMPLETE_INVESTMENT_CASE", f"{key} must be project-specific", f"$.investment_case.{key}"))

    coverage = record.get("coverage")
    if not isinstance(coverage, dict):
        errors.append(error("MISSING_COVERAGE", "coverage is required", "$.coverage"))
    else:
        for key in sorted(COVERAGE_KEYS):
            item = coverage.get(key)
            path = f"$.coverage.{key}"
            if not isinstance(item, dict):
                errors.append(error("MISSING_COVERAGE_ITEM", f"{key} is required", path))
                continue
            status = item.get("status")
            if status not in {"supported", "partial", "gap"}:
                errors.append(error("INVALID_COVERAGE_STATUS", "status must be supported, partial, or gap", path + ".status"))
            elif status == "gap":
                for field in ("missing", "impact", "action", "transaction_response"):
                    if not nonempty(item.get(field), 4):
                        errors.append(error("INCOMPLETE_GAP_RESPONSE", f"gap requires {field}", path + "." + field))
                warnings.append(error("EVIDENCE_GAP", f"{key} remains a documented evidence gap", path))
            else:
                points = item.get("evidence_points")
                if not isinstance(points, list) or not any(nonempty(x, 4) for x in points):
                    errors.append(error("MISSING_EVIDENCE_POINTS", "supported/partial coverage requires evidence_points", path + ".evidence_points"))

    calculations = record.get("calculations")
    if not isinstance(calculations, list):
        errors.append(error("MISSING_CALCULATIONS", "calculations must be an array", "$.calculations"))
    else:
        for index, calc in enumerate(calculations):
            path = f"$.calculations[{index}]"
            if not isinstance(calc, dict):
                errors.append(error("INVALID_CALCULATION", "calculation must be an object", path))
                continue
            kind = calc.get("kind")
            if kind not in {"derived", "scenario"}:
                errors.append(error("INVALID_CALCULATION_KIND", "kind must be derived or scenario", path + ".kind"))
            if kind == "scenario" and (not nonempty(calc.get("scenario")) or not isinstance(calc.get("assumption_labels"), list)):
                errors.append(error("UNLABELED_SCENARIO", "scenario calculations require scenario and assumption_labels", path))
            formula, inputs, result = calc.get("formula"), calc.get("inputs"), calc.get("result")
            if not isinstance(formula, str) or not isinstance(inputs, dict) or not isinstance(result, (int, float)):
                errors.append(error("INCOMPLETE_CALCULATION", "formula, numeric inputs, and result are required", path))
                continue
            try:
                expected = eval_formula(formula, inputs)
                if not math.isclose(float(result), expected, rel_tol=1e-6, abs_tol=1e-6):
                    errors.append(error("CALCULATION_MISMATCH", f"expected {expected}, got {result}", path + ".result"))
            except Exception as exc:
                errors.append(error("INVALID_FORMULA", str(exc), path + ".formula"))

    plans = record.get("table_plans")
    if not isinstance(plans, list):
        errors.append(error("MISSING_TABLE_PLANS", "table_plans must be an array", "$.table_plans"))
    else:
        for index, plan in enumerate(plans):
            path = f"$.table_plans[{index}]"
            if not isinstance(plan, dict):
                errors.append(error("INVALID_TABLE_PLAN", "table plan must be an object", path))
                continue
            if plan.get("style") not in STYLES or plan.get("caption_policy") not in CAPTIONS:
                errors.append(error("INVALID_TABLE_STYLE", "style or caption_policy is invalid", path))
            columns = plan.get("columns")
            if not isinstance(columns, list) or not 2 <= len(columns) <= 8:
                errors.append(error("INVALID_TABLE_COLUMNS", "table plan requires 2-8 columns", path + ".columns"))
                continue
            roles, weights = [], []
            for col_index, column in enumerate(columns):
                cpath = f"{path}.columns[{col_index}]"
                if not isinstance(column, dict) or column.get("role") not in ROLES:
                    errors.append(error("INVALID_COLUMN_ROLE", "column role is invalid", cpath))
                    continue
                weight = column.get("width_weight")
                if not isinstance(weight, (int, float)) or weight <= 0:
                    errors.append(error("INVALID_COLUMN_WEIGHT", "width_weight must be positive", cpath + ".width_weight"))
                    continue
                roles.append(column["role"])
                weights.append(float(weight))
            if len(set(roles)) > 1 and weights and max(weights) - min(weights) < 1e-9:
                errors.append(error("EQUAL_WIDTH_ROLE_MISMATCH", "different column roles cannot use equal width_weight", path + ".columns"))

    score = max(0, 100 - 12 * len(errors) - 2 * len(warnings))
    return errors, warnings, score


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    try:
        record = json.loads(args.manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "fail", "errors": [error("READ_ERROR", str(exc), "$")], "warnings": [], "score": 0}, ensure_ascii=False, indent=2))
        return 1
    errors, warnings, score = validate(record)
    print(json.dumps({"status": "pass" if not errors else "fail", "errors": errors, "warnings": warnings, "score": score}, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
