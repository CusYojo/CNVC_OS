#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from validate_replacement_manifest import load_json, object_index, validate_manifest


def validate_final_content(
    manifest: dict[str, Any],
    template_map: dict[str, Any],
    result_map: dict[str, Any],
    watermark_qa_report: dict[str, Any],
    residual_qa_report: dict[str, Any] | None = None,
    visual_qa_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    preflight = validate_manifest(manifest, template_map)
    if not preflight["passed"]:
        errors.append("替换清单预检未通过")
        errors.extend(preflight["errors"])
    before = object_index(template_map)
    after = object_index(result_map)
    background_fidelity: list[dict[str, Any]] = []
    if str(manifest.get("schemaVersion", "")) == "1.6":
        result_slides = {
            int(slide.get("number", 0)): slide
            for slide in result_map.get("slides", [])
            if isinstance(slide, dict)
        }
        for source_slide in template_map.get("slides", []):
            if not isinstance(source_slide, dict):
                continue
            slide = int(source_slide.get("number", 0))
            target_slide = result_slides.get(slide, {})
            failures: list[str] = []
            if source_slide.get("layoutId") != target_slide.get("layoutId"):
                failures.append("版式引用变化")
            if source_slide.get("masterId") != target_slide.get("masterId"):
                failures.append("母版引用变化")
            if source_slide.get("backgroundSignatures") != target_slide.get(
                "backgroundSignatures"
            ):
                failures.append("母版/版式/幻灯片背景签名变化")
            if failures:
                errors.append(
                    f"第 {slide} 页模板背景保真失败：{'；'.join(failures)}"
                )
            background_fidelity.append(
                {
                    "slide": slide,
                    "failures": failures,
                    "status": "passed" if not failures else "failed",
                }
            )
        for item in manifest.get("protectedObjects", []):
            if (
                not isinstance(item, dict)
                or item.get("classification") != "template_background"
            ):
                continue
            key = (int(item.get("slide", 0)), int(item.get("shapeId", 0)))
            source = before.get(key)
            target = after.get(key)
            if target is None:
                errors.append(
                    f"第 {key[0]} 页受保护模板背景 shapeId={key[1]} 丢失"
                )
                continue
            for field in ("name", "kind", "bbox", "media", "data"):
                if (source or {}).get(field) != target.get(field):
                    errors.append(
                        f"第 {key[0]} 页受保护模板背景 shapeId={key[1]} "
                        f"{field} 发生变化"
                    )
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
    controlled_additions: list[dict[str, Any]] = []
    for operation in manifest.get("operations", []):
        if (
            not isinstance(operation, dict)
            or operation.get("action") != "add_disclaimer_textbox"
        ):
            continue
        slide = int(operation.get("slide", 0))
        shape_id = int(operation.get("shapeId", 0))
        target = after.get((slide, shape_id))
        failures: list[str] = []
        if target is None:
            failures.append("受控责任声明文本框未生成")
        else:
            if target.get("name") != "references.disclaimer.generated":
                failures.append("受控责任声明文本框名称不符")
            if target.get("kind") != "shape:textbox":
                failures.append("受控责任声明不是可编辑文本框")
            if target.get("text") != operation.get("text"):
                failures.append("受控责任声明文字不完整")
        if failures:
            errors.append(
                f"第 {slide} 页责任声明最终覆盖失败：{'；'.join(failures)}"
            )
        controlled_additions.append(
            {
                "slide": slide,
                "shapeId": shape_id,
                "semanticKey": operation.get("semanticKey"),
                "failures": failures,
                "status": "passed" if not failures else "failed",
            }
        )
    operation_checks: list[dict[str, Any]] = []
    for operation in manifest.get("operations", []):
        if not isinstance(operation, dict):
            continue
        action = operation.get("action")
        if action not in {
            "replace_text",
            "replace_text_group",
            "replace_image",
            "replace_chart_data",
            "replace_table_data",
        }:
            continue
        slide = int(operation.get("slide", 0))
        failures: list[str] = []
        targets: list[tuple[int, str | None, str | None]] = []
        if action == "replace_text":
            targets.append(
                (int(operation.get("shapeId", 0)), str(operation.get("text", "")), None)
            )
        elif action == "replace_text_group":
            shape_ids = [int(value) for value in operation.get("shapeIds", [])]
            if not shape_ids:
                failures.append("shapeIds 为空")
                operation_checks.append(
                    {
                        "slide": slide,
                        "action": action,
                        "semanticKey": operation.get("semanticKey"),
                        "failures": failures,
                        "status": "failed",
                    }
                )
                errors.append(f"第 {slide} 页 replace_text_group 最终结果失败：shapeIds 为空")
                continue
            group_mode = operation.get("groupMode", "composite-box")
            if group_mode in {"fragment-map", "line-reflow"}:
                fragment_texts = {
                    int(item["shapeId"]): str(item["text"])
                    for item in operation.get("fragmentTexts", [])
                    if isinstance(item, dict)
                    and isinstance(item.get("shapeId"), int)
                    and isinstance(item.get("text"), str)
                }
                for shape_id in shape_ids:
                    targets.append((shape_id, fragment_texts.get(shape_id), None))
            else:
                primary = int(operation.get("primaryShapeId", shape_ids[0]))
                for shape_id in shape_ids:
                    targets.append(
                        (
                            shape_id,
                            str(operation.get("text", "")) if shape_id == primary else "",
                            None,
                        )
                    )
        elif action == "replace_image":
            asset = Path(str(operation.get("asset", ""))).expanduser().resolve()
            expected_media = (
                hashlib.sha256(asset.read_bytes()).hexdigest()
                if asset.is_file()
                else str(operation.get("assetSha256", ""))
            )
            targets.append((int(operation.get("shapeId", 0)), None, expected_media))
        elif action == "replace_table_data":
            shape_id = int(operation.get("shapeId", 0))
            target = after.get((slide, shape_id))
            expected_values = operation.get("values")
            actual_values = (target or {}).get("data", {}).get("values")
            if target is None:
                failures.append(f"shapeId={shape_id} 不存在")
            elif actual_values != expected_values:
                failures.append(f"shapeId={shape_id} 表格数据与清单不一致")
        elif action == "replace_chart_data":
            shape_id = int(operation.get("shapeId", 0))
            target = after.get((slide, shape_id))
            before_target = before.get((slide, shape_id), {})
            actual_data = (target or {}).get("data", {})
            expected_tokens = {
                str(value)
                for value in operation.get("categories", [])
            }
            for series in operation.get("series", []):
                if isinstance(series, dict):
                    expected_tokens.add(str(series.get("name", "")))
                    expected_tokens.update(str(value) for value in series.get("values", []))
            actual_tokens = {str(value) for value in actual_data.get("values", [])}
            if target is None:
                failures.append(f"shapeId={shape_id} 不存在")
            elif actual_data.get("signature") == before_target.get("data", {}).get(
                "signature"
            ):
                failures.append(f"shapeId={shape_id} 图表数据签名未变化")
            elif expected_tokens - actual_tokens:
                failures.append(
                    f"shapeId={shape_id} 图表缓存缺少目标值："
                    f"{sorted(expected_tokens - actual_tokens)}"
                )
        for shape_id, expected_text, expected_media in targets:
            target = after.get((slide, shape_id))
            if target is None:
                failures.append(f"shapeId={shape_id} 不存在")
            elif expected_text is not None and target.get("text") != expected_text:
                failures.append(f"shapeId={shape_id} 最终文字不精确")
            elif expected_media is not None and target.get("media") != expected_media:
                failures.append(f"shapeId={shape_id} 最终媒体不精确")
        if failures:
            errors.append(
                f"第 {slide} 页 {action} 最终结果失败：{'；'.join(failures)}"
            )
        operation_checks.append(
            {
                "slide": slide,
                "action": action,
                "semanticKey": operation.get("semanticKey"),
                "failures": failures,
                "status": "passed" if not failures else "failed",
            }
        )
    if watermark_qa_report.get("passed") is not True:
        errors.append("最终 PPTX 未通过渲染后水印复检")
    residual_required = str(manifest.get("schemaVersion", "")) in {
        "1.4",
        "1.5",
        "1.6",
    }
    if residual_required:
        if not isinstance(residual_qa_report, dict):
            errors.append("1.4/1.5/1.6 版缺少 final-residual-qa-report.json")
            residual_qa_report = {}
        elif residual_qa_report.get("passed") is not True:
            errors.append("最终 PPTX 未通过旧项目文字、Logo/媒体和 OCR 残留扫描")
    if str(manifest.get("schemaVersion", "")) in {"1.5", "1.6"}:
        if not isinstance(visual_qa_report, dict):
            errors.append("1.5/1.6 版缺少 final-visual-qa-report.json")
            visual_qa_report = {}
        elif visual_qa_report.get("passed") is not True:
            errors.append("最终 PPTX 未通过逐页排版、裁切和空槽视觉验收")
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
            "controlledDisclaimerTextBoxCount": len(controlled_additions),
            "passedControlledDisclaimerTextBoxCount": sum(
                item["status"] == "passed" for item in controlled_additions
            ),
            "watermarkQaPassed": watermark_qa_report.get("passed") is True,
            "residualQaPassed": (
                residual_qa_report.get("passed") is True
                if isinstance(residual_qa_report, dict)
                else False
            ),
            "visualQaPassed": (
                visual_qa_report.get("passed") is True
                if isinstance(visual_qa_report, dict)
                else False
            ),
            "operationCheckCount": len(operation_checks),
            "passedOperationCheckCount": sum(
                item["status"] == "passed" for item in operation_checks
            ),
            "researchEvidenceAuditPassed": (
                research_audit.get("status") in {"passed", "not-required"}
            ),
            "sourceCount": len(research_audit.get("sources", [])),
            "evidenceCount": len(research_audit.get("evidence", [])),
        },
        "coverage": coverage,
        "backgroundFidelity": background_fidelity,
        "controlledAdditions": controlled_additions,
        "operationChecks": operation_checks,
        "researchEvidenceAudit": research_audit,
        "residualQaReport": residual_qa_report,
        "visualQaReport": visual_qa_report,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="验证最终PPTX的槽位内容覆盖和水印复检结果。"
    )
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--template-map", required=True, type=Path)
    parser.add_argument("--result-map", required=True, type=Path)
    parser.add_argument("--watermark-qa-report", required=True, type=Path)
    parser.add_argument("--residual-qa-report", type=Path)
    parser.add_argument("--visual-qa-report", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = validate_final_content(
        load_json(args.manifest),
        load_json(args.template_map),
        load_json(args.result_map),
        load_json(args.watermark_qa_report),
        load_json(args.residual_qa_report) if args.residual_qa_report else None,
        load_json(args.visual_qa_report) if args.visual_qa_report else None,
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
