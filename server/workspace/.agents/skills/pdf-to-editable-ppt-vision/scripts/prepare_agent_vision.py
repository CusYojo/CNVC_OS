#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

from analyze_pages_with_vision import page_facts, target_pages
from convert_pdf import classify_pdf_model, normalize_source_renders


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent


def run(command, timeout_seconds):
    print("+", " ".join(str(part) for part in command), flush=True)
    subprocess.run(
        [str(part) for part in command],
        check=True,
        timeout=timeout_seconds,
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="为当前 Codex Agent 准备 PDF 页面图片、原生对象事实和视觉分析请求。"
    )
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--pdftoppm")
    parser.add_argument(
        "--agent-model",
        default="gpt-5.6-sol",
        help="记录执行视觉识别的当前 Agent 模型，默认 gpt-5.6-sol。",
    )
    parser.add_argument("--vision-render-dpi", type=int, default=200)
    parser.add_argument("--max-pages", type=int, default=300)
    parser.add_argument("--command-timeout-seconds", type=int, default=1800)
    parser.add_argument("--pages", help="显式页码，例如 1,3-5")
    parser.add_argument(
        "--editable-targets",
        default="text,icons",
        help="视觉分析必须建立完整清单的对象类别，默认 text,icons。",
    )
    parser.add_argument(
        "--watermark-mode",
        choices=("auto", "keep", "aggressive"),
        default="auto",
    )
    parser.add_argument("--watermark-text", action="append", default=[])
    parser.add_argument("--watermark-opacity-threshold", type=float, default=0.45)
    args = parser.parse_args()

    try:
        import fitz
    except ImportError as exc:
        raise RuntimeError("需要 PyMuPDF") from exc

    input_pdf = args.input.expanduser().resolve()
    work_dir = args.work_dir.expanduser().resolve()
    pdftoppm = args.pdftoppm or shutil.which("pdftoppm")
    if not input_pdf.exists():
        raise FileNotFoundError(input_pdf)
    if not pdftoppm:
        raise FileNotFoundError("未找到 pdftoppm")
    with fitz.open(input_pdf) as document:
        page_count = document.page_count
    if args.max_pages and page_count > args.max_pages:
        raise RuntimeError(
            f"PDF 共 {page_count} 页，超过 --max-pages={args.max_pages}"
        )

    work_dir.mkdir(parents=True, exist_ok=True)
    source_render_dir = work_dir / "pdf-renders"
    vision_render_dir = work_dir / "vision-renders"
    source_render_dir.mkdir(parents=True, exist_ok=True)
    vision_render_dir.mkdir(parents=True, exist_ok=True)
    for directory, dpi in (
        (source_render_dir, 96),
        (vision_render_dir, args.vision_render_dpi),
    ):
        for old in directory.glob("raw-*.png"):
            old.unlink()
        run(
            [
                pdftoppm,
                "-png",
                "-r",
                str(dpi),
                input_pdf,
                directory / "raw",
            ],
            args.command_timeout_seconds,
        )
        normalize_source_renders(directory)

    model_path = work_dir / "pdf-model.json"
    extract_command = [
        sys.executable,
        SCRIPT_DIR / "extract_pdf_model.py",
        "--input",
        input_pdf,
        "--build-dir",
        work_dir,
        "--source-render-dir",
        source_render_dir,
        "--output-model",
        model_path,
        "--watermark-mode",
        args.watermark_mode,
        "--watermark-opacity-threshold",
        str(args.watermark_opacity_threshold),
        "--watermark-report",
        work_dir / "watermark-report.json",
    ]
    for value in args.watermark_text:
        extract_command.extend(["--watermark-text", value])
    run(extract_command, args.command_timeout_seconds)

    route_report = classify_pdf_model(model_path)
    route_path = work_dir / "route-report.json"
    route_path.write_text(
        json.dumps(route_report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    explicit_pages = None
    if args.pages:
        explicit_pages = set()
        for item in args.pages.split(","):
            item = item.strip()
            if not item:
                continue
            if "-" in item:
                start, end = item.split("-", 1)
                explicit_pages.update(range(int(start), int(end) + 1))
            else:
                explicit_pages.add(int(item))
        invalid_pages = sorted(
            page for page in explicit_pages if page < 1 or page > page_count
        )
        if invalid_pages:
            raise ValueError(f"--pages 包含无效页码：{invalid_pages}")
    selected = target_pages(route_report, explicit_pages)
    model = json.loads(model_path.read_text(encoding="utf-8"))
    pages = {int(page["number"]): page for page in model.get("pages") or []}
    json_dir = work_dir / "agent-vision"
    json_dir.mkdir(parents=True, exist_ok=True)
    analysis_requests = []
    for page_number in selected:
        page = pages[page_number]
        analysis_requests.append(
            {
                "page": page_number,
                "image": str(
                    (vision_render_dir / f"slide-{page_number:02d}.png").resolve()
                ),
                "analysisOutput": str(
                    (json_dir / f"page-{page_number:02d}.json").resolve()
                ),
                "pdfFacts": page_facts(page),
            }
        )
    qa_requests = [
        {
            "page": page_number,
            "sourceImage": str(
                (source_render_dir / f"slide-{page_number:02d}.png").resolve()
            ),
            "artifactImage": str(
                (work_dir / "artifact-renders" / f"slide-{page_number:02d}.png").resolve()
            ),
            "foregroundImage": str(
                (work_dir / "foreground-renders" / f"slide-{page_number:02d}.png").resolve()
            ),
            "qaOutput": str(
                (json_dir / f"qa-page-{page_number:02d}.json").resolve()
            ),
        }
        for page_number in range(1, page_count + 1)
    ]
    request_path = work_dir / "agent-vision-request.json"
    request_path.write_text(
        json.dumps(
            {
                "schemaVersion": "1.0",
                "sourcePdf": str(input_pdf),
                "visionExecutor": {
                    "backend": "current-agent",
                    "model": args.agent_model,
                    "requiresImageInput": True,
                },
                "coordinateSpace": "normalized-top-left",
                "requirements": {
                    "editableTargets": [
                        item.strip()
                        for item in args.editable_targets.split(",")
                        if item.strip()
                    ],
                    "textPolicy": (
                        "逐页建立 text-block 清单；同一自然段的多行必须作为一个"
                        " paragraph 对象，并保留原始换行。不得把每一视觉行当作独立段落。"
                    ),
                    "typographyPolicy": (
                        "识别页面级字体角色、候选字体、统一字号和粗细；同一 styleId"
                        " 必须使用完全相同的 fontFamily/fontSizePt/bold。"
                    ),
                    "iconPolicy": (
                        "逐个建立 icon-group 内的图标清单和稳定 ID。要求 icons 可编辑时，"
                        "每个图标必须有 type=icon 的重建对象；keep-raster、空 objects 或"
                        " reconstructionComplete=false 均视为未完成。"
                    ),
                    "foregroundQaPolicy": (
                        "当 foregroundImage 存在时，必须检查可编辑前景没有重复的"
                        "源文字/扁平栅格内容，且必需语义对象没有缺失；在 QA JSON 中"
                        "显式返回 foregroundPassed。"
                    ),
                },
                "analysisSchema": str(
                    (
                        SKILL_DIR
                        / "references"
                        / "agent-vision-analysis.schema.json"
                    ).resolve()
                ),
                "qaSchema": str(
                    (SKILL_DIR / "references" / "agent-visual-qa.schema.json").resolve()
                ),
                "analysisPages": analysis_requests,
                "qaPages": qa_requests,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Agent 视觉请求：{request_path}")
    print(f"待分析页：{', '.join(str(page) for page in selected) or '无'}")
    print(f"最终视觉复核页：1-{page_count}")
    print(f"将分析 JSON 写入：{json_dir}")


if __name__ == "__main__":
    main()
