#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(path)
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="在当前 Agent 完成最终视觉复核后重新签发转换交接证书。"
    )
    parser.add_argument("--work-dir", required=True, type=Path)
    args = parser.parse_args()

    work_dir = args.work_dir.expanduser().resolve()
    handoff_path = work_dir / "conversion-handoff.json"
    handoff = load(handoff_path)
    watermark = load(work_dir / "watermark-handoff-report.json")
    semantic = load(work_dir / "semantic-build-report.json")
    text_grouping_path = work_dir / "text-grouping-qa-report.json"
    text_grouping = (
        load(text_grouping_path)
        if text_grouping_path.exists()
        else {
            "passed": handoff.get("textGroupingQaPassed", True),
            "mode": handoff.get("textGroupingMode", "line"),
        }
    )
    visual_path = work_dir / "visual-qa-report.json"
    visual = load(visual_path)
    coverage_path = work_dir / "editable-coverage-report.json"
    coverage = (
        load(coverage_path)
        if coverage_path.exists()
        else {"passed": True, "targets": []}
    )
    residue_path = work_dir / "editability-residue-report.json"
    residue = (
        load(residue_path)
        if residue_path.exists()
        else {"passed": False}
    )
    editability = load(work_dir / "editability-report.json")
    semantic_plan = load(work_dir / "semantic-plan.json")
    request_path = work_dir / "agent-vision-request.json"
    request = load(request_path) if request_path.exists() else {}
    executor = request.get("visionExecutor") or {}

    editability_passed = not bool(editability.get("review_required_pages"))
    unresolved = semantic_plan.get("unresolvedRegions") or []
    ready = (
        bool(watermark.get("passed"))
        and bool(semantic.get("passed"))
        and bool(text_grouping.get("passed"))
        and bool(visual.get("passed"))
        and bool(coverage.get("passed"))
        and bool(residue.get("passed"))
        and editability_passed
        and not unresolved
    )
    updates = {
        "visionProvider": "current-agent",
        "visionModel": executor.get("model"),
        "visualQaMode": "required",
        "visualQaPassed": bool(visual.get("passed")),
        "visualQaReport": str(visual_path),
        "visualQaReportRelative": str(visual_path.relative_to(work_dir)),
        "visualQaReportSha256": sha256(visual_path),
        "textGroupingQaPassed": bool(text_grouping.get("passed")),
        "editableCoveragePassed": bool(coverage.get("passed")),
        "editableTargets": coverage.get("targets", []),
        "editabilityResiduePassed": bool(residue.get("passed")),
        "editabilityReviewPassed": editability_passed,
        "unresolvedSemanticRegions": unresolved,
        "unresolvedEditablePages": editability.get(
            "review_required_pages", []
        ),
        "readyForContentReplacement": ready,
    }
    if text_grouping_path.exists():
        updates.update(
            {
                "textGroupingQaReport": str(text_grouping_path),
                "textGroupingQaReportRelative": str(
                    text_grouping_path.relative_to(work_dir)
                ),
                "textGroupingQaReportSha256": sha256(
                    text_grouping_path
                ),
            }
        )
    if coverage_path.exists():
        updates.update(
            {
                "editableCoverageReport": str(coverage_path),
                "editableCoverageReportRelative": str(
                    coverage_path.relative_to(work_dir)
                ),
                "editableCoverageReportSha256": sha256(coverage_path),
            }
        )
    if residue_path.exists():
        updates.update(
            {
                "editabilityResidueReport": str(residue_path),
                "editabilityResidueReportRelative": str(
                    residue_path.relative_to(work_dir)
                ),
                "editabilityResidueReportSha256": sha256(residue_path),
            }
        )
    handoff.update(updates)
    handoff_path.write_text(
        json.dumps(handoff, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if not ready:
        raise RuntimeError("Agent 视觉复核后的交接条件仍未全部通过")
    print(f"Agent 视觉交接证书已签发：{handoff_path}")


if __name__ == "__main__":
    main()
