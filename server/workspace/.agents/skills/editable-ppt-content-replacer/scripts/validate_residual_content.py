#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any
import zipfile


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.expanduser().resolve().read_text(encoding="utf-8"))


def normalize(value: str) -> str:
    return re.sub(r"[\W_]+", "", str(value or "").lower(), flags=re.UNICODE)


def slide_texts(result_map: dict[str, Any]) -> dict[int, str]:
    result: dict[int, str] = {}
    for fallback, slide in enumerate(result_map.get("slides", []), 1):
        page = int(slide.get("number", fallback))
        result[page] = "\n".join(
            str(item.get("text", ""))
            for item in slide.get("objects", [])
            if str(item.get("text", "")).strip()
        )
    return result


def media_targets(result_map: dict[str, Any]) -> dict[tuple[int, int], str]:
    result: dict[tuple[int, int], str] = {}
    for fallback, slide in enumerate(result_map.get("slides", []), 1):
        page = int(slide.get("number", fallback))
        for item in slide.get("objects", []):
            media = item.get("media")
            if media:
                result[(page, int(item["shapeId"]))] = str(media)
    return result


def package_media(pptx: Path) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    with zipfile.ZipFile(pptx) as archive:
        for name in archive.namelist():
            if not name.startswith("ppt/media/") or name.endswith("/"):
                continue
            digest = hashlib.sha256(archive.read(name)).hexdigest()
            result.setdefault(digest, []).append(name)
    return result


def resolve_watermark_validator(value: str | None) -> Path:
    if value:
        return Path(value).expanduser().resolve()
    configured = os.environ.get("PDF_TO_EDITABLE_PPT_SKILL_DIR")
    root = (
        Path(configured).expanduser().resolve()
        if configured
        else Path(__file__).resolve().parents[2] / "pdf-to-editable-ppt"
    )
    return root / "scripts" / "validate_watermark_handoff.py"


def run_visual_ocr(
    validator: Path,
    pptx: Path,
    render_dir: Path,
    terms: list[str],
    ocr_engine: str,
    tesseract: str | None,
    timeout_seconds: int,
) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    if not validator.is_file():
        return {}, [f"未找到视觉 OCR 校验器：{validator}"]
    with tempfile.TemporaryDirectory(prefix="ppt-residual-qa-") as directory:
        temporary = Path(directory)
        empty_report = temporary / "empty-watermark-report.json"
        visual_report = temporary / "visual-residual-report.json"
        empty_report.write_text(
            '{"mode":"auto","entries":[],"custom_terms":[]}\n',
            encoding="utf-8",
        )
        command = [
            sys.executable,
            str(validator),
            "--pptx",
            str(pptx),
            "--render-dir",
            str(render_dir),
            "--watermark-report",
            str(empty_report),
            "--output",
            str(visual_report),
            "--mode",
            "strict",
            "--ocr-engine",
            ocr_engine,
            "--ocr-timeout-seconds",
            str(timeout_seconds),
        ]
        if tesseract:
            command.extend(["--tesseract", tesseract])
        for term in terms:
            command.extend(["--watermark-text", term])
        completed = subprocess.run(
            command,
            text=True,
            capture_output=True,
            timeout=max(120, timeout_seconds * max(1, len(list(render_dir.glob("*.png"))))),
            check=False,
        )
        report = load_json(visual_report) if visual_report.is_file() else {}
        if completed.returncode != 0 and not report:
            detail = (completed.stderr or completed.stdout).strip()
            errors.append(f"视觉 OCR 校验器执行失败：{detail}")
        return report, errors


def validate(
    manifest: dict[str, Any],
    pptx: Path,
    result_map: dict[str, Any],
    render_dir: Path,
    validator: Path,
    ocr_engine: str,
    tesseract: str | None,
    timeout_seconds: int,
) -> dict[str, Any]:
    errors: list[str] = []
    policy = manifest.get("residualPolicy")
    if not isinstance(policy, dict):
        return {
            "passed": False,
            "errors": ["replacement-manifest 缺少 residualPolicy"],
        }
    forbidden_terms = [
        str(value).strip()
        for value in policy.get("forbiddenTextTerms", [])
        if str(value).strip()
    ]
    required_terms = [
        str(value).strip()
        for value in policy.get("requiredTextTerms", [])
        if str(value).strip()
    ]
    gap_only_terms = [
        str(value).strip()
        for value in policy.get("gapOnlyTextTerms", [])
        if str(value).strip()
    ]
    gap_slides = {int(value) for value in policy.get("gapSlideNumbers", [])}
    forbidden_media = {
        str(value) for value in policy.get("forbiddenMediaSha256", [])
    }
    texts = slide_texts(result_map)
    normalized_texts = {page: normalize(text) for page, text in texts.items()}
    text_matches: list[dict[str, Any]] = []
    for page, text in normalized_texts.items():
        for term in forbidden_terms:
            if normalize(term) in text:
                text_matches.append({"slide": page, "term": term})
    if text_matches:
        errors.append("可编辑文字中仍包含禁止残留词")
    all_text = normalize("\n".join(texts.values()))
    missing_required = [
        term for term in required_terms if normalize(term) not in all_text
    ]
    if missing_required:
        errors.append(f"缺少目标项目必要文字：{missing_required}")
    gap_violations: list[dict[str, Any]] = []
    for page, text in normalized_texts.items():
        if page in gap_slides:
            continue
        for term in gap_only_terms:
            if normalize(term) in text:
                gap_violations.append({"slide": page, "term": term})
    if gap_violations:
        errors.append("待核实/未披露类文字出现在非专用缺口页")

    media = media_targets(result_map)
    forbidden_media_matches = [
        {"slide": page, "shapeId": shape_id, "sha256": value}
        for (page, shape_id), value in media.items()
        if value in forbidden_media
    ]
    package_media_hashes = package_media(pptx)
    forbidden_package_media_matches = [
        {"sha256": value, "parts": package_media_hashes[value]}
        for value in sorted(forbidden_media & set(package_media_hashes))
    ]
    if forbidden_media_matches:
        errors.append("最终 PPTX 仍引用禁止的旧项目媒体")
    if forbidden_package_media_matches:
        errors.append("最终 PPTX 包内仍包含禁止的旧项目媒体文件")
    expected_image_failures: list[dict[str, Any]] = []
    for operation in manifest.get("operations", []):
        if not isinstance(operation, dict) or operation.get("action") != "replace_image":
            continue
        asset = Path(str(operation.get("asset", ""))).expanduser().resolve()
        expected = (
            hashlib.sha256(asset.read_bytes()).hexdigest()
            if asset.is_file()
            else str(operation.get("assetSha256", ""))
        )
        key = (int(operation.get("slide", 0)), int(operation.get("shapeId", 0)))
        if media.get(key) != expected:
            expected_image_failures.append(
                {
                    "slide": key[0],
                    "shapeId": key[1],
                    "expectedSha256": expected,
                    "actualSha256": media.get(key),
                }
            )
    if expected_image_failures:
        errors.append("授权 Logo/人物/产品图片未写入预期槽位")

    visual_report, visual_errors = run_visual_ocr(
        validator,
        pptx,
        render_dir,
        forbidden_terms,
        ocr_engine,
        tesseract,
        timeout_seconds,
    )
    errors.extend(visual_errors)
    if visual_report.get("passed") is not True:
        errors.append("最终渲染 OCR 残留扫描未通过")
    return {
        "passed": not errors,
        "errors": errors,
        "policy": policy,
        "editableTextMatches": text_matches,
        "missingRequiredTextTerms": missing_required,
        "gapOnlyTextViolations": gap_violations,
        "forbiddenMediaMatches": forbidden_media_matches,
        "forbiddenPackageMediaMatches": forbidden_package_media_matches,
        "expectedImageFailures": expected_image_failures,
        "visualOcrReport": visual_report,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="扫描最终 PPTX 的旧项目文字、Logo/媒体和渲染 OCR 残留。"
    )
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--pptx", required=True, type=Path)
    parser.add_argument("--result-map", required=True, type=Path)
    parser.add_argument("--render-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--watermark-validator")
    parser.add_argument(
        "--ocr-engine",
        choices=("auto", "apple-vision", "tesseract"),
        default="auto",
    )
    parser.add_argument("--tesseract")
    parser.add_argument("--ocr-timeout-seconds", type=int, default=120)
    args = parser.parse_args()

    report = validate(
        load_json(args.manifest),
        args.pptx.expanduser().resolve(),
        load_json(args.result_map),
        args.render_dir.expanduser().resolve(),
        resolve_watermark_validator(args.watermark_validator),
        args.ocr_engine,
        args.tesseract,
        args.ocr_timeout_seconds,
    )
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if not report["passed"]:
        print("最终残留扫描失败：")
        for error in report["errors"]:
            print("-", error)
        print(f"报告：{output}")
        raise SystemExit(1)
    print(f"最终残留扫描通过：{output}")


if __name__ == "__main__":
    main()
