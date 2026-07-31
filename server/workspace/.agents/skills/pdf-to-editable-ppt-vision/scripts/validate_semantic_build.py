#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


KEY_TO_TYPE = {
    "covers": "cover",
    "shapes": "shape",
    "connectors": "connector",
    "texts": "text",
    "icons": "icon",
    "charts": "chart",
    "tables": "table",
}


def main() -> None:
    parser = argparse.ArgumentParser(description="验证语义覆盖对象是否实际写入 PPTX 构建清单。")
    parser.add_argument("--overrides", required=True, type=Path)
    parser.add_argument("--build-manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    overrides = json.loads(
        args.overrides.expanduser().resolve().read_text(encoding="utf-8")
    )
    manifest = json.loads(
        args.build_manifest.expanduser().resolve().read_text(encoding="utf-8")
    )
    emitted = {
        (int(item["page"]), item.get("semanticId"), item.get("type"))
        for item in manifest.get("objects") or []
        if item.get("emitted")
    }
    missing = []
    expected_count = 0
    for page_number, page in (overrides.get("slides") or {}).items():
        for key, object_type in KEY_TO_TYPE.items():
            for item in page.get(key) or []:
                name = item.get("name")
                if not name:
                    continue
                expected_count += 1
                if (int(page_number), name, object_type) not in emitted:
                    missing.append(
                        {
                            "page": int(page_number),
                            "name": name,
                            "type": object_type,
                        }
                    )
    failed_entries = [
        item for item in manifest.get("objects") or [] if not item.get("emitted")
    ]
    result = {
        "passed": not missing and not failed_entries,
        "expectedObjectCount": expected_count,
        "emittedObjectCount": len(emitted),
        "missingObjects": missing,
        "failedObjects": failed_entries,
    }
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if not result["passed"]:
        raise RuntimeError(
            f"语义构建验证失败：缺少 {len(missing)} 个对象，"
            f"构建失败 {len(failed_entries)} 个对象"
        )
    print(f"语义构建验证通过：{expected_count} 个对象")


if __name__ == "__main__":
    main()
