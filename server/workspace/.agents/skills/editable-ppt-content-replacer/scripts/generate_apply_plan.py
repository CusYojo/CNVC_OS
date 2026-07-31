#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from validate_replacement_manifest import (
    load_json,
    validate_manifest,
)


def compact_operation(operation: dict) -> dict:
    action = operation["action"]
    slide = int(operation["slide"])
    result = {
        "slide": slide,
        "action": action,
        "semanticKey": operation.get("semanticKey"),
        "role": operation.get("role"),
        "fitPolicy": "preserve",
        "sourceNote": operation["sourceNote"],
        "evidenceIds": operation.get("evidenceIds", []),
    }
    if operation.get("displayQualifier"):
        result["displayQualifier"] = operation["displayQualifier"]
    if action == "replace_text_group":
        shape_ids = [int(value) for value in operation["shapeIds"]]
        result["shapeIds"] = shape_ids
        result["primaryShapeId"] = int(
            operation.get("primaryShapeId", shape_ids[0])
        )
        result["text"] = operation["text"]
    else:
        shape_id = int(operation["shapeId"])
        result["shapeId"] = shape_id
        if action == "replace_text":
            result["text"] = operation["text"]
        elif action == "add_disclaimer_textbox":
            result.update(
                {
                    "text": operation["text"],
                    "name": operation["name"],
                    "bbox": operation["bbox"],
                    "fontSize": operation.get("fontSize", 12),
                    "fontFace": operation.get("fontFace", "微软雅黑"),
                    "fontColor": operation.get("fontColor", "4B5563"),
                }
            )
        elif action == "replace_image":
            asset = Path(operation["asset"]).expanduser().resolve()
            result["asset"] = str(asset)
            result["assetSha256"] = hashlib.sha256(asset.read_bytes()).hexdigest()
    return result


def source_notes(manifest: dict, operations: list[dict]) -> dict[str, str]:
    sources = {
        str(item.get("sourceId")): item
        for item in manifest.get("sources", [])
        if isinstance(item, dict) and item.get("sourceId")
    }
    evidence = {
        str(item.get("evidenceId")): item
        for item in manifest.get("evidenceRegistry", [])
        if isinstance(item, dict) and item.get("evidenceId")
    }
    by_slide: dict[int, list[str]] = {}
    for operation in operations:
        slide = int(operation["slide"])
        lines = by_slide.setdefault(slide, [])
        for evidence_id in operation.get("evidenceIds", []):
            item = evidence.get(str(evidence_id), {})
            for source_id in item.get("sourceIds", []):
                source = sources.get(str(source_id))
                if not source:
                    continue
                locator = source.get("url") or source.get("locator") or ""
                published = source.get("publishedDate")
                accessed = source.get("accessedDate")
                line = (
                    f"- {source.get('publisher')}｜{source.get('title')}"
                    f"｜{locator}"
                    + (f"｜发布：{published}" if published else "")
                    + (f"｜访问：{accessed}" if accessed else "")
                )
                if line not in lines:
                    lines.append(line)
    return {
        str(slide): "\n".join(["[Sources]", *lines, "[/Sources]"])
        for slide, lines in by_slide.items()
        if lines
    }


def structural_operation(operation: dict, groups: dict[str, dict]) -> dict:
    group_id = str(operation["slotGroupId"])
    group = groups[group_id]
    return {
        "slide": int(operation["slide"]),
        "action": "delete_slot_group",
        "slotGroupId": group_id,
        "shapeIds": [int(value) for value in group["shapeIds"]],
        "contentShapeIds": [
            int(value) for value in group.get("contentShapeIds", [])
        ],
        "decorationShapeIds": [
            int(value) for value in group.get("decorationShapeIds", [])
        ],
        "layoutPolicy": "preserve-grid",
        "reason": operation["reason"],
        "sourceNote": operation["sourceNote"],
        "evidenceIds": operation.get("evidenceIds", []),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="将替换白名单转换为严格模板应用计划、结构删除计划和原生数据操作清单。"
    )
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--template-map", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--native-output", required=True, type=Path)
    parser.add_argument("--structural-output", type=Path)
    args = parser.parse_args()

    manifest = load_json(args.manifest)
    template_map = load_json(args.template_map)
    validation = validate_manifest(manifest, template_map)
    if not validation["passed"]:
        for error in validation["errors"]:
            print("-", error)
        raise SystemExit("替换白名单未通过校验，未生成应用计划")

    ordinary_actions = {
        "replace_text",
        "replace_text_group",
        "add_disclaimer_textbox",
        "replace_image",
    }
    groups = {
        str(item["slotGroupId"]): item
        for item in manifest.get("slotGroups", [])
        if isinstance(item, dict) and item.get("slotGroupId")
    }
    ordinary = [
        compact_operation(operation)
        for operation in manifest["operations"]
        if operation["action"] in ordinary_actions
    ]
    native = [
        operation
        for operation in manifest["operations"]
        if operation["action"] in {"replace_chart_data", "replace_table_data"}
    ]
    structural = [
        structural_operation(operation, groups)
        for operation in manifest["operations"]
        if operation["action"] == "delete_slot_group"
    ]

    content_plan = {
        "templateSha256": template_map["sha256"],
        "layoutPolicy": "strict",
        "operations": ordinary,
        "sourceNotes": source_notes(manifest, manifest["operations"]),
    }
    native_plan = {
        "schemaVersion": manifest.get("schemaVersion", "1.1"),
        "templatePptx": str(
            Path(manifest["templatePptx"]).expanduser().resolve()
        ),
        "templateSha256": template_map["sha256"],
        "layoutPolicy": "strict",
        "operations": native,
    }
    structural_plan = {
        "schemaVersion": manifest.get("schemaVersion", "1.1"),
        "templatePptx": str(
            Path(manifest["templatePptx"]).expanduser().resolve()
        ),
        "templateSha256": template_map["sha256"],
        "layoutPolicy": "strict",
        "operations": structural,
    }

    output = args.output.expanduser().resolve()
    native_output = args.native_output.expanduser().resolve()
    structural_output = (
        args.structural_output.expanduser().resolve()
        if args.structural_output
        else output.parent / "structural-operations.json"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    native_output.parent.mkdir(parents=True, exist_ok=True)
    structural_output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(content_plan, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    native_output.write_text(
        json.dumps(native_plan, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    structural_output.write_text(
        json.dumps(structural_plan, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        f"已生成 {output}：{len(ordinary)} 项文字/图片操作；"
        f"{structural_output}：{len(structural)} 项完整槽位删除；"
        f"{native_output}：{len(native)} 项原生图表/表格操作"
    )
    if not ordinary:
        print("提示：普通应用计划为空，跳过 apply_template_plan_openxml.py。")
    if not structural:
        print("提示：结构删除计划为空，跳过 apply_structural_plan.py。")


if __name__ == "__main__":
    main()
