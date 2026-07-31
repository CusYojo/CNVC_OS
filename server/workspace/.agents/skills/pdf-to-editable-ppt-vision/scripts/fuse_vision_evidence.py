#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from copy import deepcopy
from pathlib import Path


SUPPORTED_OVERRIDE_KEYS = (
    "covers",
    "shapes",
    "connectors",
    "texts",
    "icons",
    "charts",
    "tables",
    "imageReplacements",
)


def normalized_text(value: str) -> str:
    return re.sub(r"[\W_]+", "", str(value or "").lower(), flags=re.UNICODE)


def slide_size(page: dict, width: float = 1280.0) -> tuple[float, float]:
    return width, width * float(page["height"]) / max(1.0, float(page["width"]))


def map_position(bbox, page: dict) -> dict | None:
    if not isinstance(bbox, list) or len(bbox) != 4:
        return None
    try:
        x, y, width, height = [float(value) for value in bbox]
    except (TypeError, ValueError):
        return None
    slide_width, slide_height = slide_size(page)
    return {
        "left": round(x * slide_width, 2),
        "top": round(y * slide_height, 2),
        "width": round(width * slide_width, 2),
        "height": round(height * slide_height, 2),
    }


def page_native_texts(page: dict) -> dict[str, str]:
    result = {}
    for index, element in enumerate(page.get("elements") or []):
        if element.get("kind") == "text":
            result[f"p{int(page['number']):02d}-e{index:04d}"] = str(
                element.get("text") or ""
            )
    return result


def resolve_text(candidate: dict, native_texts: dict[str, str]) -> tuple[str, str | None]:
    evidence = candidate.get("textEvidenceId")
    if evidence and evidence in native_texts:
        native = native_texts[evidence]
        proposed = str(candidate.get("text") or "").strip()
        if proposed and normalized_text(proposed) != normalized_text(native):
            return "", None
        return native, evidence
    value = str(candidate.get("text") or "").strip()
    normalized = normalized_text(value)
    if not normalized:
        return "", None
    for object_id, native in native_texts.items():
        if normalized_text(native) == normalized:
            return native, object_id
    return "", None


def normalize_line(value) -> dict:
    if not isinstance(value, dict):
        return {"style": "solid", "fill": "#000000", "width": 1}
    return {
        "style": value.get("style", "solid"),
        "fill": value.get("fill", "#000000"),
        "width": max(0.0, float(value.get("width", 1))),
    }


def copy_safe_style(value) -> dict:
    if not isinstance(value, dict):
        return {}
    allowed = {
        "fontSize",
        "typeface",
        "color",
        "bold",
        "italic",
        "alignment",
        "verticalAlignment",
        "autoFit",
        "wrap",
        "rotation",
        "insets",
    }
    return {key: value[key] for key in allowed if key in value}


def object_to_override(
    item: dict,
    page: dict,
    native_texts: dict[str, str],
    allow_unverified_text: bool,
) -> tuple[str | None, dict | None, list[str]]:
    warnings: list[str] = []
    object_type = str(item.get("type") or "").strip()
    name = str(item.get("id") or item.get("name") or "").strip()
    position = map_position(item.get("bbox"), page)
    if not name or position is None:
        return None, None, ["对象缺少稳定 id 或有效 bbox"]

    if object_type == "shape":
        value = {
            "name": name,
            "geometry": item.get("geometry", "rect"),
            "position": position,
            "fill": item.get("fill", "#FFFFFF"),
            "line": normalize_line(item.get("line")),
        }
        text, evidence = resolve_text(item, native_texts)
        if text:
            value["text"] = text
            value["textEvidenceId"] = evidence
            value["textStyle"] = copy_safe_style(item.get("textStyle"))
        elif item.get("text"):
            warnings.append(f"{name} 的文字没有 PDF 原生证据，已省略")
        return "shapes", value, warnings

    if object_type == "text":
        text, evidence = resolve_text(item, native_texts)
        if not text and allow_unverified_text:
            text = str(item.get("text") or "").strip()
            evidence = "vision-unverified"
        if not text:
            return None, None, [f"{name} 的文字没有可靠证据，未自动生成"]
        return (
            "texts",
            {
                "name": name,
                "position": position,
                "text": text,
                "textEvidenceId": evidence,
                "textStyle": copy_safe_style(item.get("textStyle")),
            },
            warnings,
        )

    if object_type == "connector":
        value = {
            "name": name,
            "from": item.get("from"),
            "to": item.get("to"),
            "kind": item.get("kind", "straight"),
            "fromSide": item.get("fromSide", "right"),
            "toSide": item.get("toSide", "left"),
            "line": normalize_line(item.get("line")),
        }
        for key in ("head", "tail", "cap", "join"):
            if key in item:
                value[key] = deepcopy(item[key])
        if not value["from"] or not value["to"]:
            return None, None, [f"{name} 缺少 from/to"]
        return "connectors", value, warnings

    if object_type == "icon":
        value = {
            "name": name,
            "mode": item.get("mode", "native"),
            "position": position,
        }
        for key in ("geometry", "fill", "line", "asset", "svg", "parts"):
            if key in item:
                value[key] = item[key]
        return "icons", value, warnings

    if object_type in {"table", "chart"}:
        if not bool(item.get("verifiedData")):
            return None, None, [f"{name} 的数据未经验证，保留为栅格候选"]
        value = deepcopy(item)
        value["name"] = name
        value["position"] = position
        value.pop("bbox", None)
        value.pop("type", None)
        return f"{object_type}s", value, warnings

    return None, None, [f"不支持的视觉对象类型：{object_type or 'empty'}"]


def main() -> None:
    parser = argparse.ArgumentParser(description="融合 PDF 事实和视觉分析，生成安全语义覆盖计划。")
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--vision-analysis", required=True, type=Path)
    parser.add_argument("--output-plan", required=True, type=Path)
    parser.add_argument("--output-overrides", required=True, type=Path)
    parser.add_argument("--base-overrides", type=Path)
    parser.add_argument("--minimum-confidence", type=float, default=0.85)
    parser.add_argument("--mode", choices=("audit", "assist", "required"), default="audit")
    parser.add_argument("--allow-unverified-vision-text", action="store_true")
    parser.add_argument(
        "--editable-targets",
        default="",
        help="必须重建的对象类别；用于把 keep-raster/空对象清单升级为阻断项。",
    )
    args = parser.parse_args()
    editable_targets = {
        item.strip().lower()
        for item in args.editable_targets.split(",")
        if item.strip()
    }

    model = json.loads(args.model.expanduser().resolve().read_text(encoding="utf-8"))
    vision = json.loads(
        args.vision_analysis.expanduser().resolve().read_text(encoding="utf-8")
    )
    pages = {int(page["number"]): page for page in model.get("pages") or []}
    overrides = {"schemaVersion": "1.0", "coordinateSpace": "slide-px", "slides": {}}
    if args.base_overrides:
        overrides = json.loads(
            args.base_overrides.expanduser().resolve().read_text(encoding="utf-8")
        )
        overrides.setdefault("schemaVersion", "1.0")
        overrides.setdefault("coordinateSpace", "slide-px")
        overrides.setdefault("slides", {})

    plan_pages = []
    unresolved = []
    applied_count = 0
    for analysis in vision.get("pages") or []:
        page_number = int(analysis["page"])
        page = pages.get(page_number)
        if page is None:
            unresolved.append({"page": page_number, "reason": "missing-pdf-page"})
            continue
        native_texts = page_native_texts(page)
        page_plan = {
            "page": page_number,
            "regions": [],
            "operations": [],
            "warnings": [],
        }
        if isinstance(analysis.get("typography"), dict):
            page_plan["typography"] = deepcopy(analysis["typography"])
        page_overrides = overrides["slides"].setdefault(str(page_number), {})
        for key in SUPPORTED_OVERRIDE_KEYS:
            page_overrides.setdefault(key, [])

        for region in analysis.get("regions") or []:
            confidence = float(region.get("confidence") or 0)
            apply_region = (
                args.mode in {"assist", "required"}
                and confidence >= args.minimum_confidence
                and region.get("recommendedAction") == "semantic-rebuild"
                and bool(region.get("reconstructionComplete"))
            )
            region_plan = {
                "id": region.get("id"),
                "type": region.get("type"),
                "bbox": region.get("bbox"),
                "confidence": confidence,
                "recommendedAction": region.get("recommendedAction"),
                "applied": False,
                "operationCount": 0,
            }
            required_region = (
                ("icons" in editable_targets and region.get("type") == "icon-group")
                or ("tables" in editable_targets and region.get("type") == "table")
                or ("charts" in editable_targets and region.get("type") == "chart")
                or (
                    {"shapes", "connectors"} & editable_targets
                    and region.get("type") in {"flowchart", "matrix"}
                )
            )
            if not apply_region:
                region_plan["reason"] = (
                    "audit-mode"
                    if args.mode == "audit"
                    else "low-confidence-or-incomplete-reconstruction"
                )
                if (
                    region.get("recommendedAction") == "semantic-rebuild"
                    or required_region
                ):
                    unresolved.append(
                        {
                            "page": page_number,
                            "region": region.get("id"),
                            "type": region.get("type"),
                            "reason": region_plan["reason"],
                        }
                    )
                page_plan["regions"].append(region_plan)
                continue

            region_operations = []
            region_warnings = []
            for item in region.get("objects") or []:
                if not isinstance(item, dict):
                    continue
                key, value, warnings = object_to_override(
                    item,
                    page,
                    native_texts,
                    args.allow_unverified_vision_text,
                )
                region_warnings.extend(warnings)
                if key and value:
                    page_overrides[key].append(value)
                    region_operations.append(
                        {
                            "type": key,
                            "name": value.get("name"),
                            "sourceRegion": region.get("id"),
                        }
                    )

            if (
                region_operations
                and region.get("coverFill")
                and bool(region.get("reconstructionComplete"))
            ):
                cover_position = map_position(region.get("bbox"), page)
                page_overrides["covers"].insert(
                    0,
                    {
                        "name": f"{region.get('id')}-cover",
                        "position": cover_position,
                        "fill": region["coverFill"],
                        "line": {"style": "solid", "fill": "none", "width": 0},
                    },
                )
                region_operations.insert(
                    0,
                    {
                        "type": "covers",
                        "name": f"{region.get('id')}-cover",
                        "sourceRegion": region.get("id"),
                    },
                )

            region_plan["applied"] = bool(region_operations)
            region_plan["operationCount"] = len(region_operations)
            region_plan["warnings"] = region_warnings
            page_plan["operations"].extend(region_operations)
            page_plan["warnings"].extend(region_warnings)
            applied_count += len(region_operations)
            if not region_operations:
                unresolved.append(
                    {
                        "page": page_number,
                        "region": region.get("id"),
                        "type": region.get("type"),
                        "reason": "no-safe-build-operations",
                    }
                )
            elif required_region:
                target_types = {
                    "icon-group": {"icons"},
                    "table": {"tables"},
                    "chart": {"charts"},
                    "flowchart": {"shapes", "connectors"},
                    "matrix": {"shapes"},
                }.get(region.get("type"), set())
                emitted_types = {
                    operation["type"] for operation in region_operations
                }
                expected_types = target_types & {
                    {
                        "icons": "icons",
                        "tables": "tables",
                        "charts": "charts",
                        "shapes": "shapes",
                        "connectors": "connectors",
                    }[target]
                    for target in editable_targets
                    if target in {
                        "icons",
                        "tables",
                        "charts",
                        "shapes",
                        "connectors",
                    }
                }
                if expected_types and not expected_types.issubset(emitted_types):
                    unresolved.append(
                        {
                            "page": page_number,
                            "region": region.get("id"),
                            "type": region.get("type"),
                            "reason": "required-object-type-not-emitted",
                            "missingTypes": sorted(
                                expected_types - emitted_types
                            ),
                        }
                    )
            page_plan["regions"].append(region_plan)
        plan_pages.append(page_plan)

    plan = {
        "schemaVersion": "1.0",
        "source": model.get("source"),
        "visionMode": args.mode,
        "minimumConfidence": args.minimum_confidence,
        "coordinateSpace": "slide-px",
        "appliedOperationCount": applied_count,
        "unresolvedRegions": unresolved,
        "pages": plan_pages,
    }
    output_plan = args.output_plan.expanduser().resolve()
    output_overrides = args.output_overrides.expanduser().resolve()
    output_plan.parent.mkdir(parents=True, exist_ok=True)
    output_overrides.parent.mkdir(parents=True, exist_ok=True)
    output_plan.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    output_overrides.write_text(
        json.dumps(overrides, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    if args.mode == "required" and unresolved:
        raise RuntimeError(f"视觉 required 模式仍有 {len(unresolved)} 个未解决区域")
    print(
        f"证据融合完成：应用 {applied_count} 个操作，"
        f"未解决 {len(unresolved)} 个区域；写入 {output_plan}"
    )


if __name__ == "__main__":
    main()
