#!/usr/bin/env python3
"""Validate manifests across image generation, PDF bridge, and editable PPT conversion."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


REPORT_FIELDS = [
    ("watermarkQaReport", "watermarkQaReportSha256"),
    ("editabilityReport", "editabilityReportSha256"),
    ("semanticBuildReport", "semanticBuildReportSha256"),
    ("editableSurfaceReport", "editableSurfaceReportSha256"),
    ("layoutCalibrationReport", "layoutCalibrationReportSha256"),
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"JSON 顶层必须是对象: {path}")
    return data


def resolve_path(value: str | None, base: Path) -> Path | None:
    if not value:
        return None
    path = Path(value).expanduser()
    return (path if path.is_absolute() else base / path).resolve(strict=False)


def validate(args: argparse.Namespace) -> dict:
    image_manifest_path = Path(args.imagegen_manifest).expanduser().resolve()
    bridge_manifest_path = Path(args.bridge_manifest).expanduser().resolve()
    handoff_path = Path(args.conversion_handoff).expanduser().resolve()
    report_path = Path(args.output_report).expanduser().resolve()

    errors: list[str] = []
    warnings: list[str] = []
    artifacts: dict[str, str] = {}

    try:
        image_manifest = load_json(image_manifest_path)
        bridge_manifest = load_json(bridge_manifest_path)
        handoff = load_json(handoff_path)
    except Exception as exc:
        report = {"schema_version": "1.0", "passed": False, "errors": [str(exc)], "warnings": []}
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return report

    image_slides = image_manifest.get("slides")
    bridge_slides = bridge_manifest.get("slides")
    if not isinstance(image_slides, list) or not image_slides:
        errors.append("GordenImagePPTGen manifest 缺少非空 slides")
        image_slides = []
    if not isinstance(bridge_slides, list) or not bridge_slides:
        errors.append("PDF bridge manifest 缺少非空 slides")
        bridge_slides = []
    if len(image_slides) != len(bridge_slides):
        errors.append(f"图片生成页数 {len(image_slides)} 与 PDF bridge 页数 {len(bridge_slides)} 不一致")

    for index, slide in enumerate(image_slides, start=1):
        if not slide.get("task_id"):
            errors.append(f"图片生成第 {index} 页缺少 task_id")
        for field in ("metadata_json", "copied_to"):
            path = resolve_path(slide.get(field), image_manifest_path.parent)
            if path is None or not path.is_file():
                errors.append(f"图片生成第 {index} 页 {field} 文件不存在")

    for index, (image_slide, bridge_slide) in enumerate(zip(image_slides, bridge_slides), start=1):
        image_path = resolve_path(image_slide.get("copied_to"), image_manifest_path.parent)
        bridge_path = resolve_path(bridge_slide.get("path"), bridge_manifest_path.parent)
        if image_path and image_path.is_file() and bridge_path and bridge_path.is_file():
            image_hash = sha256(image_path)
            bridge_hash = sha256(bridge_path)
            recorded_hash = bridge_slide.get("sha256")
            if image_hash != bridge_hash:
                errors.append(f"第 {index} 页从图片生成到 PDF bridge 的源图哈希不一致")
            if recorded_hash != bridge_hash:
                errors.append(f"第 {index} 页 bridge manifest 哈希不正确")

    bridge_pdf = resolve_path(bridge_manifest.get("output_pdf"), bridge_manifest_path.parent)
    if bridge_pdf is None or not bridge_pdf.is_file():
        errors.append("PDF bridge 产物不存在")
    else:
        artifacts["bridge_pdf"] = str(bridge_pdf)
        expected_bridge_hash = bridge_manifest.get("output_pdf_sha256")
        if expected_bridge_hash != sha256(bridge_pdf):
            errors.append("PDF bridge 产物哈希与 manifest 不一致")
    if bridge_manifest.get("flattened") is not True:
        errors.append("PDF bridge manifest 未声明 flattened=true")

    exact_checks = {
        "schemaVersion": "1.2",
        "producerSkill": "pdf-to-editable-ppt",
        "route": "flattened",
        "editableScope": args.expected_editable_scope,
    }
    for field, expected in exact_checks.items():
        if handoff.get(field) != expected:
            errors.append(f"conversion-handoff.{field} 应为 {expected!r}，实际为 {handoff.get(field)!r}")

    for field in (
        "watermarkQaPassed",
        "editabilityReviewPassed",
        "semanticBuildPassed",
        "editableSurfacePassed",
        "layoutCalibrationPassed",
        "readyForContentReplacement",
    ):
        if handoff.get(field) is not True:
            errors.append(f"conversion-handoff.{field} 必须为 true")
    unresolved = handoff.get("unresolvedEditablePages")
    if unresolved != []:
        errors.append("conversion-handoff.unresolvedEditablePages 必须为空数组")

    source_pdf = resolve_path(handoff.get("sourcePdf"), handoff_path.parent)
    if bridge_pdf and bridge_pdf.is_file():
        if source_pdf is None or not source_pdf.is_file():
            errors.append("conversion-handoff.sourcePdf 不存在")
        elif sha256(source_pdf) != sha256(bridge_pdf):
            errors.append("conversion-handoff.sourcePdf 不是当前 PDF bridge 产物")

    final_pptx = resolve_path(handoff.get("templatePptx"), handoff_path.parent)
    if final_pptx is None or not final_pptx.is_file():
        errors.append("conversion-handoff.templatePptx 不存在")
    else:
        artifacts["editable_pptx"] = str(final_pptx)
        if handoff.get("templateSha256") != sha256(final_pptx):
            errors.append("可编辑 PPTX 哈希与 conversion-handoff.templateSha256 不一致")

    for path_field, hash_field in REPORT_FIELDS:
        report_file = resolve_path(handoff.get(path_field), handoff_path.parent)
        if report_file is None:
            warnings.append(f"conversion-handoff 未提供 {path_field}")
            continue
        if not report_file.is_file():
            errors.append(f"{path_field} 文件不存在: {report_file}")
            continue
        expected_hash = handoff.get(hash_field)
        if expected_hash and expected_hash != sha256(report_file):
            errors.append(f"{path_field} 哈希与 {hash_field} 不一致")

    result = {
        "schema_version": "1.0",
        "producer": "create-reference-driven-editable-ppt/validate_pipeline_handoff.py",
        "passed": not errors,
        "errors": errors,
        "warnings": warnings,
        "inputs": {
            "imagegen_manifest": str(image_manifest_path),
            "bridge_manifest": str(bridge_manifest_path),
            "conversion_handoff": str(handoff_path),
        },
        "artifacts": artifacts,
        "page_count": len(image_slides),
        "editable_scope": handoff.get("editableScope"),
        "ready_for_content_replacement": handoff.get("readyForContentReplacement") is True,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--imagegen-manifest", required=True)
    parser.add_argument("--bridge-manifest", required=True)
    parser.add_argument("--conversion-handoff", required=True)
    parser.add_argument("--output-report", required=True)
    parser.add_argument("--expected-editable-scope", default="all")
    return parser


def main(argv: list[str] | None = None) -> int:
    result = validate(build_parser().parse_args(argv))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
