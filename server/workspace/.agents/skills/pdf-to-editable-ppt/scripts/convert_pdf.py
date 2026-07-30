#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parent.parent


class ChineseArgumentParser(argparse.ArgumentParser):
    def format_help(self):
        return (
            super()
            .format_help()
            .replace("usage:", "用法：")
            .replace("optional arguments:", "可选参数：")
            .replace("options:", "选项：")
            .replace("show this help message and exit", "显示此帮助信息并退出")
        )


def run(command, *, cwd=None, timeout_seconds=None):
    print("+", " ".join(str(part) for part in command), flush=True)
    try:
        subprocess.run(
            [str(part) for part in command],
            cwd=cwd,
            check=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"命令运行超过 {timeout_seconds} 秒：{command[0]}"
        ) from exc


def find_presentations_skill():
    configured = os.environ.get("PRESENTATIONS_SKILL_DIR")
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if candidate.exists():
            return candidate
    root = (
        Path.home()
        / ".codex"
        / "plugins"
        / "cache"
        / "openai-primary-runtime"
        / "presentations"
    )
    candidates = sorted(root.glob("*/skills/presentations"))
    if not candidates:
        raise FileNotFoundError(
            "未找到 Presentations 技能。请设置 PRESENTATIONS_SKILL_DIR。"
        )
    return candidates[-1]


def resolve_artifact_tool_dir(value):
    configured = value or os.environ.get("ARTIFACT_TOOL_DIR")
    if not configured:
        return None
    candidate = Path(configured).expanduser().resolve()
    package_json = candidate / "package.json"
    if not package_json.exists():
        raise FileNotFoundError(package_json)
    metadata = json.loads(package_json.read_text(encoding="utf-8"))
    if metadata.get("name") != "@oai/artifact-tool":
        raise ValueError(f"{candidate} 不是 @oai/artifact-tool 包目录")
    entrypoints = (
        candidate / "dist" / "node" / "artifact_tool.mjs",
        candidate / "dist" / "artifact_tool.mjs",
    )
    if not any(path.exists() for path in entrypoints):
        raise FileNotFoundError(
            f"{candidate} 缺少已构建的 Artifact Tool 入口文件"
        )
    return candidate


def setup_custom_artifact_workspace(work_dir, artifact_tool_dir):
    package_json = work_dir / "package.json"
    if package_json.exists():
        metadata = json.loads(package_json.read_text(encoding="utf-8"))
        if metadata.get("type") != "module":
            raise ValueError(f"{package_json} 必须设置 type=module")
    else:
        package_json.write_text(
            json.dumps({"private": True, "type": "module"}, indent=2) + "\n",
            encoding="utf-8",
        )
    scope_dir = work_dir / "node_modules" / "@oai"
    scope_dir.mkdir(parents=True, exist_ok=True)
    target = scope_dir / "artifact-tool"
    if target.exists() or target.is_symlink():
        if target.is_symlink() and target.resolve() == artifact_tool_dir:
            return
        raise FileExistsError(
            f"{target} 已存在且未指向指定的 Artifact Tool；请使用新的工作目录"
        )
    target.symlink_to(artifact_tool_dir, target_is_directory=True)


def normalize_source_renders(render_dir):
    raw_pages = sorted(
        render_dir.glob("raw-*.png"),
        key=lambda item: int(re.search(r"(\d+)$", item.stem).group(1)),
    )
    if not raw_pages:
        raise RuntimeError("Poppler 未生成任何页面渲染图")
    for old in render_dir.glob("slide-*.png"):
        old.unlink()
    for page_number, source in enumerate(raw_pages, 1):
        target = render_dir / f"slide-{page_number:02d}.png"
        source.replace(target)


def classify_pdf_model(model_path):
    model = json.loads(model_path.read_text(encoding="utf-8"))
    page_reports = []
    flattened_pages = 0
    embedded_image_candidate_count = 0
    for page in model["pages"]:
        text_count = sum(element["kind"] == "text" for element in page["elements"])
        drawing_count = sum(
            element["kind"] == "drawing" for element in page["elements"]
        )
        images = [
            element for element in page["elements"] if element["kind"] == "image"
        ]
        page_area = max(1.0, float(page["width"]) * float(page["height"]))
        full_page_images = []
        embedded_image_candidates = []
        for image in images:
            x0, y0, x1, y1 = image["bbox"]
            image_width = max(0.0, x1 - x0)
            image_height = max(0.0, y1 - y0)
            coverage = image_width * image_height / page_area
            if coverage >= 0.94:
                full_page_images.append(image)
            width_ratio = image_width / max(1.0, float(page["width"]))
            height_ratio = image_height / max(1.0, float(page["height"]))
            if (
                0.05 <= coverage < 0.90
                and width_ratio >= 0.25
                and height_ratio >= 0.15
            ):
                embedded_image_candidates.append(
                    {
                        "asset": image.get("asset"),
                        "bbox": image["bbox"],
                        "coverage": round(coverage, 4),
                        "width_ratio": round(width_ratio, 4),
                        "height_ratio": round(height_ratio, 4),
                    }
                )
        embedded_image_candidate_count += len(embedded_image_candidates)
        flattened = (
            text_count == 0
            and drawing_count == 0
            and len(images) == 1
            and len(full_page_images) == 1
        )
        if flattened:
            flattened_pages += 1
        page_reports.append(
            {
                "page": page["number"],
                "text": text_count,
                "drawings": drawing_count,
                "images": len(images),
                "flattened": flattened,
                "embedded_image_candidates": embedded_image_candidates,
            }
        )
    if flattened_pages == len(page_reports):
        route = "flattened"
    elif flattened_pages:
        route = "mixed"
    else:
        route = "object-rich"
    return {
        "route": route,
        "flattened_pages": flattened_pages,
        "page_count": len(page_reports),
        "watermark_removal": model.get("watermark_removal", {}),
        "embedded_image_candidate_count": embedded_image_candidate_count,
        "pages_with_embedded_image_candidates": [
            page["page"]
            for page in page_reports
            if page["embedded_image_candidates"]
        ],
        "pages": page_reports,
    }


def build_editability_report(route_report, overrides_path):
    overrides = {"slides": {}}
    if overrides_path:
        overrides = json.loads(
            overrides_path.expanduser().resolve().read_text(encoding="utf-8")
        )
    semantic_keys = (
        "covers",
        "shapes",
        "connectors",
        "texts",
        "icons",
        "charts",
        "tables",
        "imageReplacements",
    )
    pages = []
    for page in route_report["pages"]:
        candidates = page.get("embedded_image_candidates") or []
        if not candidates:
            continue
        page_override = overrides.get("slides", {}).get(str(page["page"]), {})
        override_count = sum(
            len(page_override.get(key) or []) for key in semantic_keys
        )
        pages.append(
            {
                "page": page["page"],
                "candidate_count": len(candidates),
                "candidates": candidates,
                "semantic_override_count": override_count,
                "status": (
                    "semantic-overrides-present"
                    if override_count
                    else "review-required"
                ),
            }
        )
    return {
        "candidate_page_count": len(pages),
        "candidate_image_count": sum(
            page["candidate_count"] for page in pages
        ),
        "review_required_pages": [
            page["page"] for page in pages if page["status"] == "review-required"
        ],
        "pages": pages,
    }


def main():
    parser = ChineseArgumentParser(
        description="将演示型 PDF 高还原重建为可编辑 PPTX。"
    )
    parser.add_argument("--input", required=True, type=Path, help="源 PDF 文件")
    parser.add_argument("--output", required=True, type=Path, help="最终 PPTX 文件")
    parser.add_argument(
        "--work-dir", required=True, type=Path, help="独立构建目录"
    )
    parser.add_argument("--node", help="Node.js 可执行文件")
    parser.add_argument("--pdftoppm", help="Poppler pdftoppm 可执行文件")
    parser.add_argument(
        "--artifact-tool-dir",
        type=Path,
        help="Artifact Tool 包目录；也可设置 ARTIFACT_TOOL_DIR。",
    )
    parser.add_argument(
        "--command-timeout-seconds",
        type=int,
        default=1800,
        help="单个外部命令的最长运行秒数，默认 1800。",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=300,
        help="允许处理的最大页数，默认 300；设置 0 表示不限制。",
    )
    parser.add_argument(
        "--flattened-mode",
        choices=("image", "ocr"),
        default="image",
        help="用于完全扁平化 PDF：选择整页图片高保真模式或 OCR 文字可编辑模式。",
    )
    parser.add_argument(
        "--ocr-json-dir",
        type=Path,
        help="预先生成的 slide-XX.json OCR 文件目录；设置后使用 json 后端。",
    )
    parser.add_argument(
        "--ocr-engine",
        choices=("auto", "apple-vision", "tesseract", "json"),
        default="auto",
        help="扁平化 OCR 后端；auto 会根据当前系统自动选择。",
    )
    parser.add_argument(
        "--ocr-languages",
        default="zh-Hans,en-US",
        help="OCR 语言列表，使用逗号分隔；会自动映射为 Tesseract 语言代码。",
    )
    parser.add_argument(
        "--tesseract",
        help="Tesseract 可执行文件；仅在不位于 PATH 时需要指定。",
    )
    parser.add_argument(
        "--tesseract-psm",
        type=int,
        default=11,
        help="Tesseract 页面分割模式，默认值：11。",
    )
    parser.add_argument(
        "--ocr-body-font",
        default="auto",
        help="OCR 正文字体；auto 会根据当前系统选择。",
    )
    parser.add_argument(
        "--ocr-title-font",
        default="auto",
        help="OCR 标题字体；auto 会根据当前系统选择。",
    )
    parser.add_argument(
        "--ocr-corrections",
        type=Path,
        help="包含精确文字替换和归一化排除区域的 JSON 文件。",
    )
    parser.add_argument(
        "--ocr-min-confidence",
        type=float,
        default=0.45,
        help="可编辑文字的最低 OCR 置信度，默认值：0.45。",
    )
    parser.add_argument(
        "--overrides",
        type=Path,
        help="可选的独立图标、原生图表、表格和形状重建清单。",
    )
    parser.add_argument(
        "--watermark-mode",
        choices=("auto", "keep", "aggressive"),
        default="auto",
        help="水印处理模式：auto 默认安全去除；keep 完整保留；aggressive 扩大重复水印识别范围。",
    )
    parser.add_argument(
        "--keep-watermarks",
        action="store_true",
        help="保留全部水印；等同于 --watermark-mode keep。",
    )
    parser.add_argument(
        "--watermark-text",
        action="append",
        default=[],
        help="额外指定要移除的水印文字或短语，可重复传入。",
    )
    parser.add_argument(
        "--watermark-opacity-threshold",
        type=float,
        default=0.45,
        help="自动水印识别的透明度阈值，默认值：0.45。",
    )
    parser.add_argument(
        "--watermark-qa-mode",
        choices=("strict", "xml-only", "off"),
        default="strict",
        help="最终水印交接验收：strict 同时扫描PPTX包和渲染图；xml-only只强制包内扫描；off关闭验收。",
    )
    parser.add_argument(
        "--watermark-qa-ocr-engine",
        choices=("auto", "apple-vision", "tesseract"),
        default="auto",
        help="最终渲染图水印复检使用的OCR后端。",
    )
    parser.add_argument(
        "--watermark-qa-ocr-timeout-seconds",
        type=int,
        default=120,
        help="每次水印 OCR 调用的超时秒数，默认 120。",
    )
    args = parser.parse_args()
    if args.command_timeout_seconds <= 0:
        raise ValueError("--command-timeout-seconds 必须大于 0")
    if args.max_pages < 0:
        raise ValueError("--max-pages 不能小于 0")
    if args.watermark_qa_ocr_timeout_seconds <= 0:
        raise ValueError("--watermark-qa-ocr-timeout-seconds 必须大于 0")

    input_pdf = args.input.expanduser().resolve()
    output_pptx = args.output.expanduser().resolve()
    work_dir = args.work_dir.expanduser().resolve()
    if not input_pdf.exists():
        raise FileNotFoundError(input_pdf)
    if input_pdf.suffix.lower() != ".pdf":
        raise ValueError("--input 必须是 PDF 文件")
    if output_pptx.suffix.lower() != ".pptx":
        raise ValueError("--output 必须以 .pptx 结尾")
    if args.max_pages:
        try:
            import fitz
        except ImportError as exc:
            raise RuntimeError("页数预检需要 PyMuPDF") from exc
        with fitz.open(input_pdf) as document:
            source_page_count = document.page_count
        if source_page_count > args.max_pages:
            raise RuntimeError(
                f"PDF 共 {source_page_count} 页，超过 --max-pages="
                f"{args.max_pages} 的资源保护上限"
            )

    node = args.node or shutil.which("node")
    pdftoppm = args.pdftoppm or shutil.which("pdftoppm")
    if not node:
        raise FileNotFoundError("未找到 Node.js；请通过 --node 指定")
    if not pdftoppm:
        raise FileNotFoundError("未找到 pdftoppm；请通过 --pdftoppm 指定")

    artifact_tool_dir = resolve_artifact_tool_dir(args.artifact_tool_dir)
    presentations_skill = None
    setup_workspace = None
    if artifact_tool_dir is None:
        presentations_skill = find_presentations_skill()
        setup_workspace = (
            presentations_skill
            / "container_tools"
            / "setup_artifact_tool_workspace.mjs"
        )
        if not setup_workspace.exists():
            raise FileNotFoundError(setup_workspace)

    work_dir.mkdir(parents=True, exist_ok=True)
    output_pptx.parent.mkdir(parents=True, exist_ok=True)
    source_render_dir = work_dir / "pdf-renders"
    source_render_dir.mkdir(parents=True, exist_ok=True)

    for old in source_render_dir.glob("raw-*.png"):
        old.unlink()
    run(
        [
            pdftoppm,
            "-png",
            "-r",
            "96",
            input_pdf,
            source_render_dir / "raw",
        ],
        timeout_seconds=args.command_timeout_seconds,
    )
    normalize_source_renders(source_render_dir)

    if artifact_tool_dir is not None:
        setup_custom_artifact_workspace(work_dir, artifact_tool_dir)
    else:
        run(
            [node, setup_workspace, "--workspace", work_dir],
            timeout_seconds=args.command_timeout_seconds,
        )
    model_path = work_dir / "pdf-model.json"
    extract_command = [
        sys.executable,
        SKILL_DIR / "scripts" / "extract_pdf_model.py",
        "--input",
        input_pdf,
        "--build-dir",
        work_dir,
        "--source-render-dir",
        source_render_dir,
        "--output-model",
        model_path,
        "--watermark-mode",
        "keep" if args.keep_watermarks else args.watermark_mode,
        "--watermark-opacity-threshold",
        str(args.watermark_opacity_threshold),
        "--watermark-report",
        work_dir / "watermark-report.json",
    ]
    for watermark_text in args.watermark_text:
        extract_command.extend(["--watermark-text", watermark_text])
    run(extract_command, timeout_seconds=args.command_timeout_seconds)

    route_report = classify_pdf_model(model_path)
    route_report_path = work_dir / "route-report.json"
    route_report_path.write_text(
        json.dumps(route_report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    editability_report = build_editability_report(
        route_report, args.overrides
    )
    editability_report_path = work_dir / "editability-report.json"
    editability_report_path.write_text(
        json.dumps(editability_report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        f"检测到 {route_report['route']} 类型 PDF："
        f"{route_report['flattened_pages']}/{route_report['page_count']} 页为扁平化页面"
    )
    watermark_removal = route_report.get("watermark_removal", {})
    print(
        "文字水印处理："
        f"{watermark_removal.get('mode', 'unknown')}，"
        f"已移除 {watermark_removal.get('removed_span_count', 0)} 个对象"
    )
    if (
        route_report["route"] in ("flattened", "mixed")
        and not args.keep_watermarks
    ):
        print(
            "注意：扁平化页面中的水印已烧录进像素，文字对象过滤无法将其移除；"
            "如需无水印结果，应使用 OCR 元素化后进行背景修补并逐页复核。"
        )
    if editability_report["review_required_pages"]:
        pages = "、".join(
            str(page) for page in editability_report["review_required_pages"]
        )
        print(
            f"可编辑性提醒：第 {pages} 页存在大面积内嵌图片，"
            "其内部流程图、文字、表格或图例可能仍不可编辑。"
            "如用户要求元素级编辑，请检查 editability-report.json，"
            "并通过 --overrides 执行语义重建。"
        )
    if route_report["route"] == "mixed" and args.flattened_mode == "ocr":
        flattened_pages = [
            str(page["page"])
            for page in route_report["pages"]
            if page.get("flattened")
        ]
        raise RuntimeError(
            "混合型 PDF 的选择性 OCR 尚不能由单一转换命令安全合并；"
            f"扁平化页面为 {', '.join(flattened_pages)}。"
            "请拆分这些页面执行 OCR 后按原顺序合并，或使用 image 模式并通过"
            "覆盖清单重建指定区域。转换器已停止，避免静默输出不可编辑页面。"
        )

    if route_report["route"] == "flattened" and args.flattened_mode == "ocr":
        flattened_model = work_dir / "flattened-editable-model.json"
        command = [
            sys.executable,
            SKILL_DIR / "scripts" / "prepare_flattened_ocr.py",
            "--source-render-dir",
            source_render_dir,
            "--output-dir",
            work_dir / "flattened-editable",
            "--output-model",
            flattened_model,
            "--source-pdf",
            input_pdf,
            "--minimum-confidence",
            str(args.ocr_min_confidence),
            "--ocr-engine",
            args.ocr_engine,
            "--languages",
            args.ocr_languages,
            "--tesseract-psm",
            str(args.tesseract_psm),
            "--body-font",
            args.ocr_body_font,
            "--title-font",
            args.ocr_title_font,
        ]
        if args.tesseract:
            command.extend(["--tesseract", args.tesseract])
        if args.ocr_json_dir:
            command.extend(
                ["--ocr-json-dir", args.ocr_json_dir.expanduser().resolve()]
            )
        if args.ocr_corrections:
            command.extend(
                ["--corrections", args.ocr_corrections.expanduser().resolve()]
            )
        run(command, timeout_seconds=args.command_timeout_seconds)

        local_builder = work_dir / "build_flattened_ocr_ppt.mjs"
        shutil.copy2(
            SKILL_DIR / "scripts" / "build_flattened_ocr_ppt.mjs",
            local_builder,
        )
        command = [
            node,
            local_builder,
            "--model",
            flattened_model,
            "--output",
            output_pptx,
            "--render-dir",
            work_dir / "artifact-renders",
        ]
        if args.overrides:
            command.extend(["--overrides", args.overrides.expanduser().resolve()])
        run(
            command,
            cwd=work_dir,
            timeout_seconds=args.command_timeout_seconds,
        )
    else:
        local_builder = work_dir / "build_editable_ppt.mjs"
        shutil.copy2(SKILL_DIR / "scripts" / "build_editable_ppt.mjs", local_builder)
        command = [
            node,
            local_builder,
            "--model",
            model_path,
            "--output",
            output_pptx,
            "--render-dir",
            work_dir / "artifact-renders",
        ]
        if args.overrides:
            command.extend(["--overrides", args.overrides.expanduser().resolve()])
        run(
            command,
            cwd=work_dir,
            timeout_seconds=args.command_timeout_seconds,
        )

    watermark_qa_path = work_dir / "watermark-handoff-report.json"
    watermark_qa_mode = (
        "off" if args.keep_watermarks else args.watermark_qa_mode
    )
    if watermark_qa_mode != "off":
        watermark_qa_command = [
            sys.executable,
            SKILL_DIR / "scripts" / "validate_watermark_handoff.py",
            "--pptx",
            output_pptx,
            "--render-dir",
            work_dir / "artifact-renders",
            "--watermark-report",
            work_dir / "watermark-report.json",
            "--output",
            watermark_qa_path,
            "--mode",
            watermark_qa_mode,
            "--ocr-engine",
            args.watermark_qa_ocr_engine,
            "--ocr-timeout-seconds",
            str(args.watermark_qa_ocr_timeout_seconds),
        ]
        if args.tesseract:
            watermark_qa_command.extend(["--tesseract", args.tesseract])
        for watermark_text in args.watermark_text:
            watermark_qa_command.extend(["--watermark-text", watermark_text])
        run(
            watermark_qa_command,
            timeout_seconds=args.command_timeout_seconds,
        )
    else:
        watermark_qa_path.write_text(
            json.dumps(
                {
                    "passed": False,
                    "mode": "off",
                    "errors": [],
                    "warnings": [
                        "水印交接验收已关闭，文件不得作为无水印模板交给内容替换技能"
                    ],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    watermark_qa = json.loads(
        watermark_qa_path.read_text(encoding="utf-8")
    )
    output_sha256 = hashlib.sha256(output_pptx.read_bytes()).hexdigest()
    editability_review_passed = not bool(
        editability_report.get("review_required_pages")
    )
    handoff = {
        "schemaVersion": "1.1",
        "producerSkill": "pdf-to-editable-ppt",
        "templatePptx": str(output_pptx),
        "templateSha256": output_sha256,
        "pathBinding": "sha256",
        "sourcePdf": str(input_pdf),
        "route": route_report["route"],
        "watermarkPolicy": (
            "keep" if args.keep_watermarks else args.watermark_mode
        ),
        "watermarkQaPassed": bool(watermark_qa.get("passed")),
        "watermarkQaReport": str(watermark_qa_path),
        "watermarkQaReportRelative": str(
            watermark_qa_path.relative_to(work_dir)
        ),
        "watermarkQaReportSha256": hashlib.sha256(
            watermark_qa_path.read_bytes()
        ).hexdigest(),
        "editabilityReviewPassed": editability_review_passed,
        "editabilityReport": str(editability_report_path),
        "editabilityReportRelative": str(
            editability_report_path.relative_to(work_dir)
        ),
        "editabilityReportSha256": hashlib.sha256(
            editability_report_path.read_bytes()
        ).hexdigest(),
        "unresolvedEditablePages": editability_report.get(
            "review_required_pages", []
        ),
        "readyForContentReplacement": bool(watermark_qa.get("passed"))
        and editability_review_passed,
    }
    handoff_path = work_dir / "conversion-handoff.json"
    handoff_path.write_text(
        json.dumps(handoff, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if not handoff["readyForContentReplacement"]:
        print(
            "注意：PPTX 已生成，但尚未通过内容替换交接门槛。"
            f"请处理 {handoff_path} 中的水印或可编辑性问题。"
        )
    else:
        print(f"内容替换交接证书：{handoff_path}")
    print(f"已生成 {output_pptx}")


if __name__ == "__main__":
    main()
