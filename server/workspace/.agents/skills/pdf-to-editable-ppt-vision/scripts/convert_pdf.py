#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
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


def build_editability_report(
    route_report,
    overrides_path,
    vision_analysis_path=None,
    minimum_confidence=0.85,
):
    overrides = {"slides": {}}
    if overrides_path:
        overrides = json.loads(
            overrides_path.expanduser().resolve().read_text(encoding="utf-8")
        )
    semantic_keys = (
        "shapes",
        "connectors",
        "texts",
        "icons",
        "charts",
        "tables",
    )
    analyses = {}
    if vision_analysis_path and vision_analysis_path.exists():
        vision_analysis = json.loads(
            vision_analysis_path.read_text(encoding="utf-8")
        )
        analyses = {
            int(page["page"]): page
            for page in vision_analysis.get("pages") or []
        }
    pages = []
    for page in route_report["pages"]:
        candidates = page.get("embedded_image_candidates") or []
        if not candidates:
            continue
        page_override = overrides.get("slides", {}).get(str(page["page"]), {})
        override_count = sum(
            len(page_override.get(key) or []) for key in semantic_keys
        )
        raster_review_count = sum(
            1
            for region in (
                analyses.get(int(page["page"]), {}).get("regions") or []
            )
            if (
                region.get("recommendedAction") in {"keep-raster", "ignore"}
                and bool(region.get("reconstructionComplete"))
                and float(region.get("confidence") or 0)
                >= minimum_confidence
            )
        )
        if override_count:
            status = "semantic-overrides-present"
        elif raster_review_count >= len(candidates):
            status = "agent-reviewed-raster-accepted"
        else:
            status = "review-required"
        pages.append(
            {
                "page": page["page"],
                "candidate_count": len(candidates),
                "candidates": candidates,
                "semantic_override_count": override_count,
                "raster_review_count": raster_review_count,
                "status": status,
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
        "--libreoffice",
        help="LibreOffice/soffice 可执行文件，用于最终逐页渲染检查。",
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
        "--text-grouping",
        choices=("line", "hybrid", "paragraph"),
        default="hybrid",
        help="原生PDF文字框粒度：line逐行；hybrid保守段落聚类（默认）；paragraph扩大段落聚类。",
    )
    parser.add_argument(
        "--line-break-mode",
        choices=("preserve", "smart", "reflow"),
        default="preserve",
        help="合并段落内部的换行策略：preserve保留模板换行（默认）；smart识别软换行；reflow尽量自动重排。",
    )
    parser.add_argument(
        "--paragraph-order",
        choices=("source", "spatial"),
        default="spatial",
        help="OCR 段落阅读顺序；spatial 可避免多栏页面的检测顺序把同一段落拆散。",
    )
    parser.add_argument(
        "--require-paragraph-coverage",
        action="store_true",
        help="将未合并的多行段落候选设为阻断错误；用户明确要求整段一起编辑时启用。",
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
        "--typography-profile",
        type=Path,
        help="扁平化页面字体与字号规范 JSON；要求贴合模板字体时建议显式提供。",
    )
    parser.add_argument(
        "--font-size-mode",
        choices=("raw", "normalized", "strict"),
        default="normalized",
        help="OCR 字号策略；normalized/strict 会统一相同样式的字体与字号。",
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
        "--editable-targets",
        default="",
        help="必须元素化的对象类别，逗号分隔：text,icons,shapes,connectors,tables,charts。",
    )
    parser.add_argument(
        "--residue-ocr-engine",
        choices=("auto", "apple-vision", "tesseract"),
        default="auto",
        help="最终去字背景二次 OCR 后端；与首次 OCR 独立运行。",
    )
    parser.add_argument(
        "--vision-mode",
        choices=("off", "audit", "assist", "required"),
        default="off",
        help="视觉语义增强：off关闭；audit只分析；assist应用高置信度重建；required存在未解决区域时失败。",
    )
    parser.add_argument(
        "--vision-provider",
        choices=("http", "json"),
        default="http",
        help="视觉分析提供方：Linux 内网 HTTP 服务或离线 JSON。",
    )
    parser.add_argument("--vision-endpoint", help="HTTP 视觉服务端点。")
    parser.add_argument(
        "--vision-json-dir",
        type=Path,
        help="离线视觉分析 JSON 目录，文件名为 page-XX.json 或 slide-XX.json。",
    )
    parser.add_argument(
        "--vision-pages",
        help="显式指定视觉分析页码，例如 1,3-5；默认分析扁平化页和大图候选页。",
    )
    parser.add_argument(
        "--vision-min-confidence",
        type=float,
        default=0.85,
        help="自动应用视觉重建的最低置信度，默认 0.85。",
    )
    parser.add_argument(
        "--vision-timeout-seconds",
        type=int,
        default=180,
        help="单页视觉服务调用超时，默认 180 秒。",
    )
    parser.add_argument(
        "--vision-render-dpi",
        type=int,
        default=200,
        help="视觉模型输入页面的渲染 DPI，默认 200。",
    )
    parser.add_argument(
        "--vision-qa-mode",
        choices=("auto", "off", "audit", "required"),
        default="auto",
        help="最终视觉复核；auto 在视觉关闭时关闭、required 模式下强制，其余只审计。",
    )
    parser.add_argument(
        "--allow-unverified-vision-text",
        action="store_true",
        help="允许将只有视觉模型证据的文字写入 PPT；默认关闭，生产环境不建议启用。",
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
    if args.vision_timeout_seconds <= 0:
        raise ValueError("--vision-timeout-seconds 必须大于 0")
    if args.vision_render_dpi < 96:
        raise ValueError("--vision-render-dpi 不能小于 96")
    if not 0 <= args.vision_min_confidence <= 1:
        raise ValueError("--vision-min-confidence 必须位于 0 到 1")

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

    libreoffice = (
        args.libreoffice
        or shutil.which("libreoffice")
        or shutil.which("soffice")
    )
    if not libreoffice:
        raise FileNotFoundError(
            "未找到 LibreOffice；请通过 --libreoffice 指定"
        )

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

    vision_render_dir = source_render_dir
    if args.vision_mode != "off":
        vision_render_dir = work_dir / "vision-renders"
        vision_render_dir.mkdir(parents=True, exist_ok=True)
        for old in vision_render_dir.glob("raw-*.png"):
            old.unlink()
        run(
            [
                pdftoppm,
                "-png",
                "-r",
                str(args.vision_render_dpi),
                input_pdf,
                vision_render_dir / "raw",
            ],
            timeout_seconds=args.command_timeout_seconds,
        )
        normalize_source_renders(vision_render_dir)

    model_path = work_dir / "pdf-model.json"
    text_grouping_report_path = work_dir / "text-grouping-report.json"
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
        "--text-grouping",
        args.text_grouping,
        "--line-break-mode",
        args.line_break_mode,
        "--text-grouping-report",
        text_grouping_report_path,
    ]
    for watermark_text in args.watermark_text:
        extract_command.extend(["--watermark-text", watermark_text])
    run(extract_command, timeout_seconds=args.command_timeout_seconds)
    text_grouping_qa_path = work_dir / "text-grouping-qa-report.json"
    text_grouping_qa_command = [
            sys.executable,
            SKILL_DIR / "scripts" / "validate_text_grouping.py",
            "--model",
            model_path,
            "--grouping-report",
            text_grouping_report_path,
            "--output",
            text_grouping_qa_path,
        ]
    if args.require_paragraph_coverage:
        text_grouping_qa_command.append("--require-paragraph-coverage")
    run(
        text_grouping_qa_command,
        timeout_seconds=args.command_timeout_seconds,
    )

    route_report = classify_pdf_model(model_path)
    route_report_path = work_dir / "route-report.json"
    route_report_path.write_text(
        json.dumps(route_report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    vision_analysis_path = work_dir / "vision-analysis.json"
    semantic_plan_path = work_dir / "semantic-plan.json"
    semantic_overrides_path = work_dir / "semantic-overrides.json"
    effective_overrides = (
        args.overrides.expanduser().resolve() if args.overrides else None
    )
    if args.vision_mode != "off":
        vision_command = [
            sys.executable,
            SKILL_DIR / "scripts" / "analyze_pages_with_vision.py",
            "--model",
            model_path,
            "--route-report",
            route_report_path,
            "--render-dir",
            vision_render_dir,
            "--output",
            vision_analysis_path,
            "--mode",
            args.vision_mode,
            "--provider",
            args.vision_provider,
            "--timeout-seconds",
            str(args.vision_timeout_seconds),
        ]
        if args.vision_endpoint:
            vision_command.extend(["--endpoint", args.vision_endpoint])
        if args.vision_json_dir:
            vision_command.extend(
                ["--json-dir", args.vision_json_dir.expanduser().resolve()]
            )
        if args.vision_pages:
            vision_command.extend(["--pages", args.vision_pages])
        run(vision_command, timeout_seconds=args.command_timeout_seconds)

        fusion_command = [
            sys.executable,
            SKILL_DIR / "scripts" / "fuse_vision_evidence.py",
            "--model",
            model_path,
            "--vision-analysis",
            vision_analysis_path,
            "--output-plan",
            semantic_plan_path,
            "--output-overrides",
            semantic_overrides_path,
            "--minimum-confidence",
            str(args.vision_min_confidence),
            "--mode",
            args.vision_mode,
            "--editable-targets",
            args.editable_targets,
        ]
        if effective_overrides:
            fusion_command.extend(["--base-overrides", effective_overrides])
        if args.allow_unverified_vision_text:
            fusion_command.append("--allow-unverified-vision-text")
        run(fusion_command, timeout_seconds=args.command_timeout_seconds)
        effective_overrides = semantic_overrides_path
    else:
        vision_analysis_path.write_text(
            json.dumps(
                {
                    "schemaVersion": "1.0",
                    "mode": "off",
                    "provider": None,
                    "selectedPages": [],
                    "pages": [],
                    "errors": [],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        semantic_plan_path.write_text(
            json.dumps(
                {
                    "schemaVersion": "1.0",
                    "visionMode": "off",
                    "appliedOperationCount": 0,
                    "unresolvedRegions": [],
                    "pages": [],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    editability_report = build_editability_report(
        route_report,
        effective_overrides,
        vision_analysis_path,
        args.vision_min_confidence,
    )
    editability_report_path = work_dir / "editability-report.json"
    editability_report_path.write_text(
        json.dumps(editability_report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if args.vision_mode == "required" and editability_report["review_required_pages"]:
        pages = "、".join(
            str(page) for page in editability_report["review_required_pages"]
        )
        raise RuntimeError(
            f"视觉 required 模式下第 {pages} 页仍有未完成语义重建的大面积图片"
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
            "--text-grouping",
            args.text_grouping,
            "--line-break-mode",
            args.line_break_mode,
            "--paragraph-order",
            args.paragraph_order,
            "--font-size-mode",
            args.font_size_mode,
            "--text-grouping-report",
            work_dir / "flattened-text-grouping-report.json",
            "--typography-report",
            work_dir / "typography-calibration-report.json",
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
        if args.typography_profile:
            command.extend(
                [
                    "--typography-profile",
                    args.typography_profile.expanduser().resolve(),
                ]
            )
        run(command, timeout_seconds=args.command_timeout_seconds)
        flattened_grouping_qa_command = [
                sys.executable,
                SKILL_DIR / "scripts" / "validate_text_grouping.py",
                "--model",
                flattened_model,
                "--grouping-report",
                work_dir / "flattened-text-grouping-report.json",
                "--output",
                text_grouping_qa_path,
            ]
        if args.require_paragraph_coverage:
            flattened_grouping_qa_command.append(
                "--require-paragraph-coverage"
            )
        run(
            flattened_grouping_qa_command,
            timeout_seconds=args.command_timeout_seconds,
        )

        local_builder = SKILL_DIR / "scripts" / "build_flattened_ocr_ppt.mjs"
        command = [
            node,
            local_builder,
            "--model",
            flattened_model,
            "--output",
            output_pptx,
        ]
        if effective_overrides:
            command.extend(["--overrides", effective_overrides])
        build_manifest_path = work_dir / "build-manifest.json"
        command.extend(["--build-manifest", build_manifest_path])
        run(
            command,
            cwd=work_dir,
            timeout_seconds=args.command_timeout_seconds,
        )
    else:
        local_builder = SKILL_DIR / "scripts" / "build_editable_ppt.mjs"
        command = [
            node,
            local_builder,
            "--model",
            model_path,
            "--output",
            output_pptx,
        ]
        if effective_overrides:
            command.extend(["--overrides", effective_overrides])
        build_manifest_path = work_dir / "build-manifest.json"
        command.extend(["--build-manifest", build_manifest_path])
        run(
            command,
            cwd=work_dir,
            timeout_seconds=args.command_timeout_seconds,
        )

    semantic_qa_path = work_dir / "semantic-build-report.json"
    if effective_overrides:
        run(
            [
                sys.executable,
                SKILL_DIR / "scripts" / "validate_semantic_build.py",
                "--overrides",
                effective_overrides,
                "--build-manifest",
                build_manifest_path,
                "--output",
                semantic_qa_path,
            ],
            timeout_seconds=args.command_timeout_seconds,
        )
    else:
        semantic_qa_path.write_text(
            json.dumps(
                {
                    "passed": True,
                    "expectedObjectCount": 0,
                    "emittedObjectCount": 0,
                    "missingObjects": [],
                    "failedObjects": [],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    canvas_report_path = work_dir / "canvas-overflow-report.json"
    run(
        [
            sys.executable,
            SKILL_DIR / "scripts" / "validate_canvas_bounds.py",
            "--pptx",
            output_pptx,
            "--output",
            canvas_report_path,
        ],
        timeout_seconds=args.command_timeout_seconds,
    )

    editable_coverage_path = work_dir / "editable-coverage-report.json"
    if args.editable_targets.strip():
        coverage_model = (
            flattened_model
            if (
                route_report["route"] == "flattened"
                and args.flattened_mode == "ocr"
            )
            else model_path
        )
        run(
            [
                sys.executable,
                SKILL_DIR / "scripts" / "validate_editable_coverage.py",
                "--build-manifest",
                build_manifest_path,
                "--model",
                coverage_model,
                "--vision-analysis",
                vision_analysis_path,
                "--semantic-plan",
                semantic_plan_path,
                "--targets",
                args.editable_targets,
                "--output",
                editable_coverage_path,
            ],
            timeout_seconds=args.command_timeout_seconds,
        )
    else:
        editable_coverage_path.write_text(
            json.dumps(
                {
                    "schemaVersion": "1.0",
                    "targets": [],
                    "passed": True,
                    "notRequired": True,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    editable_target_set = {
        item.strip().lower()
        for item in args.editable_targets.split(",")
        if item.strip()
    }
    editable_surface_path = work_dir / "editable-surface-audit.json"
    foreground_only_path = work_dir / "foreground-only.pptx"
    foreground_render_dir = work_dir / "foreground-renders"
    residue_report_path = work_dir / "editability-residue-report.json"
    if editable_target_set:
        run(
            [
                sys.executable,
                SKILL_DIR / "scripts" / "audit_editable_surface.py",
                "--pptx",
                output_pptx,
                "--output",
                editable_surface_path,
                "--foreground-only-pptx",
                foreground_only_path,
                "--semantic-plan",
                semantic_plan_path,
            ],
            timeout_seconds=args.command_timeout_seconds,
        )
    else:
        editable_surface_path.write_text(
            json.dumps(
                {"schemaVersion": "1.0", "passed": True, "notRequired": True},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    if (
        "text" in editable_target_set
        and route_report["route"] == "flattened"
        and args.flattened_mode == "ocr"
    ):
        residue_ocr_dir = work_dir / "final-background-residue-ocr"
        residue_command = [
            sys.executable,
            SKILL_DIR / "scripts" / "ocr_background_residue.py",
            "--input-dir",
            work_dir / "flattened-editable" / "clean-backgrounds",
            "--output-dir",
            residue_ocr_dir,
            "--ocr-engine",
            args.residue_ocr_engine,
            "--languages",
            args.ocr_languages,
            "--tesseract-psm",
            str(args.tesseract_psm),
        ]
        if args.tesseract:
            residue_command.extend(["--tesseract", args.tesseract])
        run(
            residue_command,
            timeout_seconds=args.command_timeout_seconds,
        )
        surface_audit = json.loads(
            editable_surface_path.read_text(encoding="utf-8")
        )
        coverage_result = json.loads(
            editable_coverage_path.read_text(encoding="utf-8")
        )
        required_object_count = sum(
            int(value)
            for value in (coverage_result.get("expected") or {}).values()
        )
        unresolved_graphics = len(
            coverage_result.get("unresolved") or []
        )
        run(
            [
                sys.executable,
                SKILL_DIR
                / "scripts"
                / "build_editability_residue_report.py",
                "--ocr-dir",
                residue_ocr_dir,
                "--output",
                residue_report_path,
                "--required-object-count",
                str(required_object_count),
                "--foreground-object-count",
                str(
                    surface_audit.get("totals", {}).get(
                        "foregroundObjectCount", 0
                    )
                ),
                "--unresolved-graphic-regions",
                str(unresolved_graphics),
            ],
            timeout_seconds=args.command_timeout_seconds,
        )
        residue_result = json.loads(
            residue_report_path.read_text(encoding="utf-8")
        )
        if not residue_result.get("passed"):
            raise RuntimeError(
                "最终去字背景仍有有效文字残留，或前景对象覆盖不足；"
                "已停止交付，详见 editability-residue-report.json"
            )
    else:
        residue_report_path.write_text(
            json.dumps(
                {"schemaVersion": "1.0", "passed": True, "notRequired": True},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    render_dir = work_dir / "artifact-renders"
    run(
        [
            sys.executable,
            SKILL_DIR / "scripts" / "render_pptx.py",
            "--input",
            output_pptx,
            "--render-dir",
            render_dir,
            "--libreoffice",
            libreoffice,
            "--pdftoppm",
            pdftoppm,
            "--timeout-seconds",
            str(args.command_timeout_seconds),
        ],
        timeout_seconds=args.command_timeout_seconds,
    )
    if editable_target_set:
        run(
            [
                sys.executable,
                SKILL_DIR / "scripts" / "render_pptx.py",
                "--input",
                foreground_only_path,
                "--render-dir",
                foreground_render_dir,
                "--libreoffice",
                libreoffice,
                "--pdftoppm",
                pdftoppm,
                "--timeout-seconds",
                str(args.command_timeout_seconds),
            ],
            timeout_seconds=args.command_timeout_seconds,
        )

    visual_qa_mode = args.vision_qa_mode
    if visual_qa_mode == "auto":
        if args.vision_mode == "off":
            visual_qa_mode = "off"
        elif args.vision_mode == "required":
            visual_qa_mode = "required"
        else:
            visual_qa_mode = "audit"
    visual_qa_path = work_dir / "visual-qa-report.json"
    visual_qa_command = [
        sys.executable,
        SKILL_DIR / "scripts" / "review_renders_with_vision.py",
        "--source-render-dir",
        vision_render_dir,
        "--artifact-render-dir",
        render_dir,
        "--output",
        visual_qa_path,
        "--mode",
        visual_qa_mode,
        "--provider",
        args.vision_provider,
        "--timeout-seconds",
        str(args.vision_timeout_seconds),
    ]
    if args.vision_endpoint:
        visual_qa_command.extend(["--endpoint", args.vision_endpoint])
    if args.vision_json_dir:
        visual_qa_command.extend(
            ["--json-dir", args.vision_json_dir.expanduser().resolve()]
        )
    if editable_target_set:
        visual_qa_command.extend(
            [
                "--foreground-render-dir",
                foreground_render_dir,
                "--require-foreground",
            ]
        )
    run(visual_qa_command, timeout_seconds=args.command_timeout_seconds)

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
            render_dir,
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
    semantic_qa = json.loads(
        semantic_qa_path.read_text(encoding="utf-8")
    )
    text_grouping_qa = json.loads(
        text_grouping_qa_path.read_text(encoding="utf-8")
    )
    semantic_plan = json.loads(
        semantic_plan_path.read_text(encoding="utf-8")
    )
    visual_qa = json.loads(
        visual_qa_path.read_text(encoding="utf-8")
    )
    editable_coverage = json.loads(
        editable_coverage_path.read_text(encoding="utf-8")
    )
    residue_gate = json.loads(
        residue_report_path.read_text(encoding="utf-8")
    )
    canvas_gate = json.loads(
        canvas_report_path.read_text(encoding="utf-8")
    )
    typography_path = work_dir / "typography-calibration-report.json"
    typography = (
        json.loads(typography_path.read_text(encoding="utf-8"))
        if typography_path.exists()
        else {"passed": True, "mode": "native-pdf"}
    )
    output_sha256 = hashlib.sha256(output_pptx.read_bytes()).hexdigest()
    editability_review_passed = not bool(
        editability_report.get("review_required_pages")
    )
    unresolved_semantic_regions = semantic_plan.get("unresolvedRegions", [])
    agent_visual_qa_pending = (
        visual_qa_mode == "off"
        and (
            args.vision_mode != "off"
            or bool(editable_target_set)
        )
    )
    visual_gate_passed = (
        (
            visual_qa_mode == "off"
            and not agent_visual_qa_pending
        )
        or bool(visual_qa.get("passed"))
    )
    handoff = {
        "schemaVersion": "1.1",
        "producerSkill": "pdf-to-editable-ppt-vision",
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
        "textGroupingMode": args.text_grouping,
        "lineBreakMode": args.line_break_mode,
        "textGroupingQaPassed": bool(text_grouping_qa.get("passed")),
        "textGroupingQaReport": str(text_grouping_qa_path),
        "textGroupingQaReportRelative": str(
            text_grouping_qa_path.relative_to(work_dir)
        ),
        "textGroupingQaReportSha256": hashlib.sha256(
            text_grouping_qa_path.read_bytes()
        ).hexdigest(),
        "visionMode": args.vision_mode,
        "visionAnalysisReport": str(vision_analysis_path),
        "visionAnalysisReportRelative": str(
            vision_analysis_path.relative_to(work_dir)
        ),
        "visionAnalysisReportSha256": hashlib.sha256(
            vision_analysis_path.read_bytes()
        ).hexdigest(),
        "semanticPlan": str(semantic_plan_path),
        "semanticPlanRelative": str(semantic_plan_path.relative_to(work_dir)),
        "semanticPlanSha256": hashlib.sha256(
            semantic_plan_path.read_bytes()
        ).hexdigest(),
        "semanticQaPassed": bool(semantic_qa.get("passed")),
        "semanticQaReport": str(semantic_qa_path),
        "semanticQaReportRelative": str(
            semantic_qa_path.relative_to(work_dir)
        ),
        "semanticQaReportSha256": hashlib.sha256(
            semantic_qa_path.read_bytes()
        ).hexdigest(),
        "editableTargets": editable_coverage.get("targets", []),
        "editableCoveragePassed": bool(editable_coverage.get("passed")),
        "editableCoverageReport": str(editable_coverage_path),
        "editableCoverageReportRelative": str(
            editable_coverage_path.relative_to(work_dir)
        ),
        "editableCoverageReportSha256": hashlib.sha256(
            editable_coverage_path.read_bytes()
        ).hexdigest(),
        "typographyCalibrationPassed": bool(typography.get("passed")),
        "typographyMode": typography.get("mode"),
        "editabilityResiduePassed": bool(residue_gate.get("passed")),
        "editabilityResidueReport": str(residue_report_path),
        "editableSurfaceAudit": str(editable_surface_path),
        "foregroundOnlyPptx": (
            str(foreground_only_path) if editable_target_set else None
        ),
        "foregroundRenderDirectory": (
            str(foreground_render_dir) if editable_target_set else None
        ),
        "foregroundQaRequired": bool(editable_target_set),
        "canvasBoundsPassed": bool(canvas_gate.get("passed")),
        "canvasBoundsReport": str(canvas_report_path),
        "visualQaMode": visual_qa_mode,
        "visualQaPassed": bool(visual_qa.get("passed")),
        "agentVisualQaPending": agent_visual_qa_pending,
        "visualQaReport": str(visual_qa_path),
        "visualQaReportRelative": str(
            visual_qa_path.relative_to(work_dir)
        ),
        "visualQaReportSha256": hashlib.sha256(
            visual_qa_path.read_bytes()
        ).hexdigest(),
        "unresolvedSemanticRegions": unresolved_semantic_regions,
        "unresolvedEditablePages": editability_report.get(
            "review_required_pages", []
        ),
        "readyForContentReplacement": bool(watermark_qa.get("passed"))
        and bool(semantic_qa.get("passed"))
        and bool(text_grouping_qa.get("passed"))
        and bool(editable_coverage.get("passed"))
        and bool(typography.get("passed"))
        and bool(residue_gate.get("passed"))
        and bool(canvas_gate.get("passed"))
        and editability_review_passed
        and not unresolved_semantic_regions
        and visual_gate_passed,
    }
    if typography_path.exists():
        handoff.update(
            {
                "typographyCalibrationReport": str(typography_path),
                "typographyCalibrationReportRelative": str(
                    typography_path.relative_to(work_dir)
                ),
                "typographyCalibrationReportSha256": hashlib.sha256(
                    typography_path.read_bytes()
                ).hexdigest(),
            }
        )
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
