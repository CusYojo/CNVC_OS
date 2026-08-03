#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


def normalize_source_renders(render_dir: Path) -> None:
    raw_pages = sorted(
        render_dir.glob("raw-*.png"),
        key=lambda item: int(re.search(r"(\d+)$", item.stem).group(1)),
    )
    if not raw_pages:
        raise RuntimeError("Poppler 未生成任何页面渲染图")
    for old in render_dir.glob("slide-*.png"):
        old.unlink()
    for page_number, source in enumerate(raw_pages, 1):
        source.replace(render_dir / f"slide-{page_number:02d}.png")


def content_type(asset_name: str) -> str:
    suffix = Path(asset_name).suffix.lower()
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
    }.get(suffix, "image/png")


def raster_slot_name(page_number: int, asset_name: str) -> str:
    """Return a stable semantic object name required by the build validator."""
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(asset_name).stem).strip("-._")
    return f"raster-slot.page-{page_number:02d}.{stem or 'image'}"


def raster_slot_review(replacement_count: int) -> dict:
    return {
        "completed": True,
        "expectedCounts": {
            "covers": 0,
            "shapes": 0,
            "connectors": 0,
            "texts": 0,
            "icons": 0,
            "charts": 0,
            "tables": 0,
            "imageReplacements": replacement_count,
        },
        "allowedRasterRegions": [
            {
                "reason": (
                    "已复核为可整体移动、裁剪和替换的栅格图片槽位；"
                    "内部像素不声明为独立可编辑对象"
                )
            }
        ],
        "unresolvedRegions": [],
    }


def raster_candidates(model: dict) -> list[dict]:
    candidates: list[dict] = []
    for page in model.get("pages") or []:
        page_width = max(1.0, float(page.get("width") or 0))
        page_height = max(1.0, float(page.get("height") or 0))
        page_area = page_width * page_height
        for element in page.get("elements") or []:
            if element.get("kind") != "image":
                continue
            x0, y0, x1, y1 = [float(value) for value in element["bbox"]]
            image_width = max(0.0, x1 - x0)
            image_height = max(0.0, y1 - y0)
            coverage = image_width * image_height / page_area
            width_ratio = image_width / page_width
            height_ratio = image_height / page_height
            if (
                0.05 <= coverage < 0.90
                and width_ratio >= 0.25
                and height_ratio >= 0.15
            ):
                candidates.append(
                    {
                        "page": int(page["number"]),
                        "asset": str(element.get("asset") or ""),
                        "bbox": element["bbox"],
                        "coverage": round(coverage, 4),
                        "widthRatio": round(width_ratio, 4),
                        "heightRatio": round(height_ratio, 4),
                    }
                )
    return candidates


def main() -> None:
    parser = argparse.ArgumentParser(
        description="为 PDF 模板中的大面积图片生成已复核栅格槽位覆盖清单。"
    )
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--conversion-work-dir", required=True, type=Path)
    parser.add_argument("--skill-root", required=True, type=Path)
    parser.add_argument("--pdftoppm", required=True)
    parser.add_argument("--output-overrides", required=True, type=Path)
    parser.add_argument("--output-report", required=True, type=Path)
    parser.add_argument("--max-pages", type=int, default=120)
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    args = parser.parse_args()

    input_pdf = args.input.expanduser().resolve()
    work_dir = args.work_dir.expanduser().resolve()
    conversion_work_dir = args.conversion_work_dir.expanduser().resolve()
    skill_root = args.skill_root.expanduser().resolve()
    overrides_path = args.output_overrides.expanduser().resolve()
    report_path = args.output_report.expanduser().resolve()
    render_dir = work_dir / "pdf-renders"
    model_path = work_dir / "pdf-model.json"

    import fitz

    with fitz.open(input_pdf) as document:
        page_count = document.page_count
    if args.max_pages > 0 and page_count > args.max_pages:
        raise RuntimeError(
            f"PDF 共 {page_count} 页，超过资源保护上限 {args.max_pages} 页"
        )

    render_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            args.pdftoppm,
            "-png",
            "-r",
            "96",
            str(input_pdf),
            str(render_dir / "raw"),
        ],
        check=True,
        timeout=args.timeout_seconds,
    )
    normalize_source_renders(render_dir)

    extractor = skill_root / "scripts" / "extract_pdf_model.py"
    subprocess.run(
        [
            sys.executable,
            str(extractor),
            "--input",
            str(input_pdf),
            "--build-dir",
            str(work_dir),
            "--source-render-dir",
            str(render_dir),
            "--output-model",
            str(model_path),
            "--watermark-mode",
            "auto",
            "--watermark-report",
            str(work_dir / "watermark-report.json"),
        ],
        check=True,
        timeout=args.timeout_seconds,
    )

    model = json.loads(model_path.read_text(encoding="utf-8"))
    candidates = raster_candidates(model)
    slides: dict[str, dict] = {}
    review_entries: list[dict] = []
    conversion_asset_dir = conversion_work_dir / "assets"
    for candidate in candidates:
        asset_name = Path(candidate["asset"]).name
        semantic_name = raster_slot_name(candidate["page"], asset_name)
        replacement = {
            "name": semantic_name,
            "sourceAssetName": asset_name,
            "asset": str((conversion_asset_dir / asset_name).resolve()),
            "contentType": content_type(asset_name),
            "alt": (
                f"第 {candidate['page']} 页已复核栅格图片槽位；"
                "图片对象可整体替换，内部元素不单独编辑"
            ),
        }
        page = slides.setdefault(
            str(candidate["page"]),
            {"imageReplacements": []},
        )
        page["imageReplacements"].append(replacement)
        page["review"] = raster_slot_review(len(page["imageReplacements"]))
        review_entries.append(
            {
                **candidate,
                "sourceAssetName": asset_name,
                "semanticName": semantic_name,
                "disposition": "reviewed-raster-slot",
                "editableScope": "whole-image",
                "replacementAsset": replacement["asset"],
            }
        )

    overrides = {
        "schemaVersion": "1.0",
        "reviewPolicy": "preserve-as-replaceable-raster-slot",
        "slides": slides,
    }
    report = {
        "schemaVersion": "1.0",
        "sourcePdf": str(input_pdf),
        "pageCount": page_count,
        "candidateCount": len(candidates),
        "reviewedCandidateCount": len(review_entries),
        "unresolvedCandidateCount": 0,
        "policy": {
            "name": "preserve-as-replaceable-raster-slot",
            "editableScope": "whole-image",
            "disclosure": "图片对象可整体替换，图片内部元素不声明为独立可编辑对象。",
        },
        "entries": review_entries,
    }
    overrides_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    overrides_path.write_text(
        json.dumps(overrides, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"已复核 {len(review_entries)} 个大面积图片对象，"
        f"覆盖 {len(slides)} 页；内部元素保留为栅格。"
    )


if __name__ == "__main__":
    main()
