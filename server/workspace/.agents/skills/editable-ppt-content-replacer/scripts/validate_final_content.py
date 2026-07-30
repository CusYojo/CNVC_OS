#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from validate_replacement_manifest import load_json, object_index, validate_manifest


def validate_final_content(
    manifest: dict[str, Any],
    template_map: dict[str, Any],
    result_map: dict[str, Any],
    watermark_qa_report: dict[str, Any],
) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    preflight = validate_manifest(manifest, template_map)
    if not preflight["passed"]:
        errors.append("替换清单预检未通过")
        errors.extend(preflight["errors"])
    before = object_index(template_map)
    after = object_index(result_map)
    assignments = manifest.get("slotAssignments", [])
    coverage: list[dict[str, Any]] = []
    for assignment in assignments:
        if not isinstance(assignment, dict):
            continue
        assignment_id = str(assignment.get("assignmentId", ""))
        slide = int(assignment.get("slide", 0))
        disposition = assignment.get("disposition")
        shape_ids = [int(value) for value in assignment.get("shapeIds", [])]
        expected_ids = [
            int(value)
            for value in assignment.get("expectedContentShapeIds", [])
        ]
        failures: list[str] = []
        if disposition == "delete":
            remaining = [
                shape_id
                for shape_id in shape_ids
                if (slide, shape_id) in after
            ]
            if remaining:
                failures.append(f"应删除但仍存在：{remaining}")
        else:
            missing = [
                shape_id
                for shape_id in shape_ids
                if (slide, shape_id) not in after
            ]
            if missing:
                failures.append(f"对象丢失：{missing}")
        if disposition == "replace":
            blank: list[int] = []
            for shape_id in expected_ids:
                source = before.get((slide, shape_id), {})
                target = after.get((slide, shape_id))
                if target is None:
                    continue
                kind = str(source.get("kind", ""))
                if kind.startswith("shape:") and not str(
                    target.get("text", "")
                ).strip():
                    blank.append(shape_id)
                elif kind == "picture" and not target.get("media"):
                    blank.append(shape_id)
                elif kind in {"chart", "table"} and target.get("kind") != kind:
                    blank.append(shape_id)
            if blank:
                failures.append(f"替换后仍为空或类型错误：{blank}")
        if failures:
            errors.append(
                f"槽位分配 {assignment_id} 最终覆盖失败：{'；'.join(failures)}"
            )
        coverage.append(
            {
                "assignmentId": assignment_id,
                "slide": slide,
                "semanticKey": assignment.get("semanticKey"),
                "disposition": disposition,
                "failures": failures,
                "status": "passed" if not failures else "failed",
            }
        )
    if watermark_qa_report.get("passed") is not True:
        errors.append("最终 PPTX 未通过渲染后水印复检")
    research_audit = preflight.get("researchEvidenceAudit", {})
    return {
        "passed": not errors,
        "errors": errors,
        "warnings": warnings,
        "metrics": {
            "slotAssignmentCount": len(coverage),
            "passedSlotAssignmentCount": sum(
                item["status"] == "passed" for item in coverage
            ),
            "failedSlotAssignmentCount": sum(
                item["status"] == "failed" for item in coverage
            ),
            "watermarkQaPassed": watermark_qa_report.get("passed") is True,
            "researchEvidenceAuditPassed": (
                research_audit.get("status") in {"passed", "not-required"}
            ),
            "sourceCount": len(research_audit.get("sources", [])),
            "evidenceCount": len(research_audit.get("evidence", [])),
        },
        "coverage": coverage,
        "researchEvidenceAudit": research_audit,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="验证最终PPTX的槽位内容覆盖和水印复检结果。"
    )
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--template-map", required=True, type=Path)
    parser.add_argument("--result-map", required=True, type=Path)
    parser.add_argument("--watermark-qa-report", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = validate_final_content(
        load_json(args.manifest),
        load_json(args.template_map),
        load_json(args.result_map),
        load_json(args.watermark_qa_report),
    )
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if not report["passed"]:
        print("最终内容验收失败：")
        for error in report["errors"]:
            print("-", error)
        print(f"报告：{output}")
        raise SystemExit(1)
    print(
        "最终内容验收通过："
        f"{report['metrics']['passedSlotAssignmentCount']} 个槽位分配全部完成，"
        "水印复检通过"
    )
    print(f"报告：{output}")


if __name__ == "__main__":
    main()
