#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parent.parent


def resolve_skill(
    explicit: Path | None,
    environment_key: str,
    sibling_name: str,
) -> Path:
    configured = explicit or (
        Path(os.environ[environment_key]).expanduser()
        if os.environ.get(environment_key)
        else None
    )
    if configured:
        return configured.resolve()
    return (SKILL_DIR.parent / sibling_name).resolve()


def required_files(root: Path, names: tuple[str, ...]) -> dict[str, bool]:
    result: dict[str, bool] = {}
    for name in names:
        result[name] = (root / name).exists()
    return result


def run_pdf_environment_check(
    pdf_skill_dir: Path,
    libreoffice: str | None,
    pdftoppm: str | None,
    timeout_seconds: int,
) -> dict:
    checker = pdf_skill_dir / "scripts" / "check_environment.py"
    if not checker.exists():
        return {
            "ready_for_default_workflow": False,
            "error": f"未找到 {checker}",
        }
    command = [
        sys.executable,
        str(checker),
        "--json",
        "--smoke-timeout-seconds",
        str(timeout_seconds),
    ]
    if libreoffice:
        command.extend(["--libreoffice", libreoffice])
    if pdftoppm:
        command.extend(["--pdftoppm", pdftoppm])
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds + 30,
        )
    except subprocess.TimeoutExpired:
        return {
            "ready_for_default_workflow": False,
            "error": "PDF 技能环境检查超时",
        }
    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {
            "ready_for_default_workflow": False,
            "error": (result.stderr or result.stdout).strip(),
        }
    report["exitCode"] = result.returncode
    return report


def build_report(
    pdf_skill_dir: Path,
    libreoffice: str | None,
    pdftoppm: str | None,
    timeout_seconds: int,
) -> dict:
    local = required_files(
        SKILL_DIR,
        (
            "scripts/validate_replacement_manifest.py",
            "scripts/generate_apply_plan.py",
            "scripts/analyze_template_openxml.py",
            "scripts/generate_background_policy_draft.py",
            "scripts/apply_template_plan_openxml.py",
            "scripts/validate_template_result_openxml.py",
            "scripts/apply_structural_plan.py",
            "scripts/apply_native_table_plan_openxml.py",
            "scripts/validate_final_content.py",
            "scripts/generate_page_closure_draft.py",
            "scripts/generate_template_fingerprint.py",
            "scripts/validate_residual_content.py",
            "scripts/validate_visual_qa_report.py",
        ),
    )
    pdf = required_files(
        pdf_skill_dir,
        (
            "scripts/check_environment.py",
            "scripts/validate_watermark_handoff.py",
        ),
    )
    pdf_environment = run_pdf_environment_check(
        pdf_skill_dir,
        libreoffice,
        pdftoppm,
        timeout_seconds,
    )
    missing = [
        f"editable-ppt-content-replacer/{name}"
        for name, present in local.items()
        if not present
    ]
    missing.extend(
        f"pdf-to-editable-ppt/{name}"
        for name, present in pdf.items()
        if not present
    )
    scripts_ready = not missing
    pdf_ready = bool(pdf_environment.get("ready_for_default_workflow"))
    native_render_ready = bool(
        pdf_environment.get("libreoffice_smoke", {}).get("passed")
    )
    native_visual_ready = bool(
        pdf_environment.get("powerpoint_native_validation_available")
        or pdf_environment.get("strict_watermark_qa_ready")
    )
    native_ready = scripts_ready and native_render_ready and native_visual_ready
    return {
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python": sys.executable,
            "display": os.environ.get("DISPLAY"),
            "waylandDisplay": os.environ.get("WAYLAND_DISPLAY"),
        },
        "skillPaths": {
            "contentReplacer": str(SKILL_DIR),
            "pdfToEditablePpt": str(pdf_skill_dir),
        },
        "requiredFiles": {
            "contentReplacer": local,
            "pdfToEditablePpt": pdf,
        },
        "scriptsReady": scripts_ready,
        "missing": missing,
        "pdfEnvironment": pdf_environment,
        "readyForHeadlessTextImageReplacement": scripts_ready,
        "readyForNativePptxWorkflow": native_ready,
        "readyForPdfConvertedWorkflow": scripts_ready and pdf_ready,
        "readyForDefaultWorkflow": native_ready,
        "powerpointNativeValidationAvailable": bool(
            pdf_environment.get("powerpoint_native_validation_available")
        ),
        "requiresAlternativeVisualQaDisclosure": not bool(
            pdf_environment.get("powerpoint_native_validation_available")
        ),
    }


def print_human(report: dict) -> None:
    current = report["platform"]
    print(f"系统：{current['system']} {current['release']} ({current['machine']})")
    for name, path in report["skillPaths"].items():
        print(f"{name}：{path}")
    print(
        "文本/图片/槽位无头替换："
        + ("可用" if report["readyForHeadlessTextImageReplacement"] else "不可用")
    )
    print(
        "原生 PPTX 严格全流程："
        + ("可用" if report["readyForDefaultWorkflow"] else "不可用")
    )
    print(
        "PDF 转换交接严格全流程："
        + ("可用" if report["readyForPdfConvertedWorkflow"] else "不可用")
    )
    if report["missing"]:
        print("缺少文件：" + "、".join(report["missing"]))
    pdf_environment = report["pdfEnvironment"]
    if pdf_environment.get("error"):
        print("PDF/渲染环境：" + str(pdf_environment["error"]))
    if report["requiresAlternativeVisualQaDisclosure"]:
        print("PowerPoint 原生验证不可用：必须执行替代视觉 QA 并在交付中披露")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="检查可编辑 PPT 内容替换技能的无头服务器运行环境。"
    )
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--pdf-skill-dir", type=Path)
    parser.add_argument("--libreoffice")
    parser.add_argument("--pdftoppm")
    parser.add_argument("--smoke-timeout-seconds", type=int, default=120)
    args = parser.parse_args()
    if args.smoke_timeout_seconds <= 0:
        raise ValueError("--smoke-timeout-seconds 必须大于 0")
    pdf_skill_dir = resolve_skill(
        args.pdf_skill_dir,
        "PDF_TO_EDITABLE_PPT_SKILL_DIR",
        "pdf-to-editable-ppt",
    )
    report = build_report(
        pdf_skill_dir,
        args.libreoffice,
        args.pdftoppm,
        args.smoke_timeout_seconds,
    )
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_human(report)
    raise SystemExit(0 if report["readyForDefaultWorkflow"] else 1)


if __name__ == "__main__":
    main()
