#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


TYPE_ALIASES = {
    "text": {"text", "texts"},
    "icons": {"icon", "icons"},
    "shapes": {"shape", "shapes"},
    "connectors": {"connector", "connectors"},
    "tables": {"table", "tables"},
    "charts": {"chart", "charts"},
}


def load(path: Path | None, default):
    if not path or not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def normalized_targets(value: str) -> list[str]:
    targets = [item.strip().lower() for item in value.split(",") if item.strip()]
    invalid = sorted(set(targets) - set(TYPE_ALIASES))
    if invalid:
        raise ValueError(f"不支持的 editable target：{invalid}")
    return sorted(set(targets))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="按用户要求的对象类别验证可编辑对象覆盖率。"
    )
    parser.add_argument("--build-manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--targets", required=True)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--vision-analysis", type=Path)
    parser.add_argument("--semantic-plan", type=Path)
    args = parser.parse_args()

    targets = normalized_targets(args.targets)
    manifest = load(args.build_manifest, {"objects": []})
    model = load(args.model, {"pages": []})
    vision = load(args.vision_analysis, {"pages": []})
    semantic_plan = load(args.semantic_plan, {"unresolvedRegions": []})
    emitted_objects = [
        item
        for item in (manifest.get("objects") or [])
        if item.get("emitted", True)
    ]

    expected = {target: 0 for target in targets}
    emitted = {target: 0 for target in targets}
    unresolved = []
    for target in targets:
        aliases = TYPE_ALIASES[target]
        emitted[target] = sum(
            str(item.get("type") or "").lower() in aliases
            for item in emitted_objects
        )

    if "text" in targets:
        expected["text"] = sum(
            len(page.get("text") or [])
            if "text" in page
            else sum(
                element.get("kind") == "text"
                for element in (page.get("elements") or [])
            )
            for page in model.get("pages") or []
        )
        expected_text_source_lines = sum(
            int(item.get("source_line_count") or 1)
            for page in model.get("pages") or []
            for item in (
                page.get("text")
                if "text" in page
                else [
                    element
                    for element in (page.get("elements") or [])
                    if element.get("kind") == "text"
                ]
            )
        )
        emitted_text_source_lines = sum(
            int(item.get("sourceLineCount") or 1)
            for item in emitted_objects
            if str(item.get("type") or "").lower()
            in TYPE_ALIASES["text"]
        )
    else:
        expected_text_source_lines = 0
        emitted_text_source_lines = 0

    vision_regions = [
        (int(page.get("page") or 0), region)
        for page in (vision.get("pages") or [])
        for region in (page.get("regions") or [])
    ]
    if "text" in targets and vision.get("pages"):
        text_regions = [
            (page, region)
            for page, region in vision_regions
            if region.get("type") == "text-block"
        ]
        if not text_regions:
            unresolved.append(
                {
                    "target": "text",
                    "reason": "missing-vision-text-inventory",
                }
            )
        else:
            expected_visual_text_blocks = sum(
                int(
                    region.get("expectedObjectCount")
                    or len(region.get("objects") or [])
                    or 1
                )
                for _, region in text_regions
            )
            if emitted["text"] < expected_visual_text_blocks:
                unresolved.append(
                    {
                        "target": "text",
                        "reason": "vision-text-inventory-shortage",
                        "expected": expected_visual_text_blocks,
                        "emitted": emitted["text"],
                    }
                )
    for target, region_types in {
        "icons": {"icon-group"},
        "tables": {"table"},
        "charts": {"chart"},
        "shapes": {"flowchart", "matrix"},
        "connectors": {"flowchart"},
    }.items():
        if target not in targets:
            continue
        matching = [
            (page, region)
            for page, region in vision_regions
            if region.get("type") in region_types
        ]
        if not matching:
            unresolved.append(
                {
                    "target": target,
                    "reason": "missing-vision-inventory",
                }
            )
            continue
        for page, region in matching:
            region_objects = [
                item
                for item in (region.get("objects") or [])
                if str(item.get("type") or "").lower()
                in TYPE_ALIASES[target]
            ]
            expected[target] += max(1, len(region_objects))
            if (
                region.get("recommendedAction") != "semantic-rebuild"
                or not bool(region.get("reconstructionComplete"))
                or not region_objects
            ):
                unresolved.append(
                    {
                        "page": page,
                        "region": region.get("id"),
                        "target": target,
                        "reason": "required-target-not-semantically-rebuilt",
                    }
                )

    for item in semantic_plan.get("unresolvedRegions") or []:
        region_type = str(item.get("type") or "")
        if (
            ("icons" in targets and region_type == "icon-group")
            or ("tables" in targets and region_type == "table")
            or ("charts" in targets and region_type == "chart")
            or (
                {"shapes", "connectors"} & set(targets)
                and region_type in {"flowchart", "matrix"}
            )
        ):
            unresolved.append({**item, "reason": "semantic-plan-unresolved"})

    shortages = {
        target: expected[target] - emitted[target]
        for target in targets
        if emitted[target] < expected[target]
    }
    if emitted_text_source_lines < expected_text_source_lines:
        shortages["textSourceLines"] = (
            expected_text_source_lines - emitted_text_source_lines
        )
    result = {
        "schemaVersion": "1.0",
        "targets": targets,
        "expected": expected,
        "emitted": emitted,
        "shortages": shortages,
        "expectedTextSourceLines": expected_text_source_lines,
        "emittedTextSourceLines": emitted_text_source_lines,
        "unresolved": unresolved,
        "passed": not shortages and not unresolved,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if not result["passed"]:
        raise RuntimeError(
            f"可编辑对象覆盖验证失败：shortages={shortages}；"
            f"unresolved={len(unresolved)}"
        )
    print(f"可编辑对象覆盖验证通过：{emitted}")


if __name__ == "__main__":
    main()
