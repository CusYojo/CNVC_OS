#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from validate_replacement_manifest import load_json, shape_ids_for


def main() -> None:
    parser = argparse.ArgumentParser(
        description="为修改页生成页面闭环复核草稿；未复核对象默认进入 unknownShapeIds。"
    )
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--template-map", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    manifest = load_json(args.manifest)
    template_map = load_json(args.template_map)
    groups = {
        str(item.get("slotGroupId")): item
        for item in manifest.get("slotGroups", [])
        if isinstance(item, dict) and item.get("slotGroupId")
    }
    objects_by_slide: dict[int, set[int]] = {}
    for fallback, slide in enumerate(template_map.get("slides", []), 1):
        page = int(slide.get("number", fallback))
        objects_by_slide[page] = {
            int(item["shapeId"])
            for item in slide.get("objects", [])
            if item.get("shapeId") is not None
        }
    targets_by_slide: dict[int, set[int]] = {}
    for operation in manifest.get("operations", []):
        if not isinstance(operation, dict):
            continue
        if operation.get("action") == "add_disclaimer_textbox":
            continue
        page = int(operation.get("slide", 0))
        targets_by_slide.setdefault(page, set()).update(
            shape_ids_for(operation, groups)
        )

    closures: list[dict[str, Any]] = []
    for page in sorted(targets_by_slide):
        reviewed = objects_by_slide.get(page, set())
        targets = targets_by_slide[page]
        closures.append(
            {
                "slide": page,
                "reviewedShapeIds": sorted(reviewed),
                "allowedKeepShapeIds": [],
                "targetShapeIds": sorted(targets),
                "unknownShapeIds": sorted(reviewed - targets),
            }
        )

    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps({"pageClosures": closures}, ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )
    print(f"已生成页面闭环草稿：{output}")
    print(
        "必须逐页审阅 unknownShapeIds；确认属于模板固定、机构品牌或有证据的"
        "上下文后，才能移入 allowedKeepShapeIds。unknownShapeIds 非空时校验失败。"
    )


if __name__ == "__main__":
    main()
