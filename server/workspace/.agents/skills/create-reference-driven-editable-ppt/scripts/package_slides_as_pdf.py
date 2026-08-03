#!/usr/bin/env python3
"""Package full-slide raster images into a deterministic flattened PDF bridge."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

from PIL import Image
from pypdf import PdfReader
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def natural_key(path: Path) -> list[object]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name)]


def collect_slides(slides_dir: Path) -> list[Path]:
    slides = sorted(
        [path for path in slides_dir.iterdir() if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS],
        key=natural_key,
    )
    if not slides:
        raise ValueError(f"目录中没有支持的整页图片: {slides_dir}")
    return slides


def package(args: argparse.Namespace) -> dict:
    slides_dir = Path(args.slides_dir).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    manifest_path = (
        Path(args.manifest).expanduser().resolve()
        if args.manifest
        else output.parent / "pdf-bridge-manifest.json"
    )

    if not slides_dir.is_dir():
        raise FileNotFoundError(f"图片目录不存在: {slides_dir}")
    for target in (output, manifest_path):
        if target.exists():
            raise FileExistsError(f"为避免覆盖已有产物，目标必须不存在: {target}")

    slides = collect_slides(slides_dir)
    records: list[dict] = []
    base_ratio: float | None = None
    for index, slide in enumerate(slides, start=1):
        with Image.open(slide) as image:
            width, height = image.size
        if width <= 0 or height <= 0:
            raise ValueError(f"图片尺寸无效: {slide}")
        ratio = width / height
        if base_ratio is None:
            base_ratio = ratio
        elif abs(ratio - base_ratio) / base_ratio > args.aspect_tolerance:
            raise ValueError(
                f"第 {index} 页宽高比 {ratio:.6f} 与第 1 页 {base_ratio:.6f} 不一致"
            )
        records.append(
            {
                "page": index,
                "path": str(slide),
                "width_px": width,
                "height_px": height,
                "sha256": sha256(slide),
            }
        )

    assert base_ratio is not None
    page_width_pt = float(args.page_width_pt)
    page_height_pt = page_width_pt / base_ratio
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    pdf = canvas.Canvas(str(output), pagesize=(page_width_pt, page_height_pt), pageCompression=1)
    for slide in slides:
        pdf.drawImage(
            ImageReader(str(slide)),
            0,
            0,
            width=page_width_pt,
            height=page_height_pt,
            preserveAspectRatio=False,
            anchor="c",
            mask="auto",
        )
        pdf.showPage()
    pdf.save()

    reader = PdfReader(str(output))
    if len(reader.pages) != len(slides):
        raise RuntimeError("PDF 页数与输入图片数不一致")
    for index, page in enumerate(reader.pages, start=1):
        width = float(page.mediabox.width)
        height = float(page.mediabox.height)
        if abs(width - page_width_pt) > 0.1 or abs(height - page_height_pt) > 0.1:
            raise RuntimeError(f"第 {index} 页尺寸异常: {width} x {height}")
        if (page.extract_text() or "").strip():
            raise RuntimeError(f"第 {index} 页包含文本对象，PDF 桥接产物不再是纯扁平页")

    manifest = {
        "schema_version": "1.0",
        "producer": "create-reference-driven-editable-ppt/package_slides_as_pdf.py",
        "source_slides_dir": str(slides_dir),
        "page_count": len(slides),
        "page_width_pt": round(page_width_pt, 4),
        "page_height_pt": round(page_height_pt, 4),
        "aspect_ratio": round(base_ratio, 8),
        "flattened": True,
        "slides": records,
        "output_pdf": str(output),
        "output_pdf_sha256": sha256(output),
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {**manifest, "manifest": str(manifest_path)}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slides-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--manifest")
    parser.add_argument("--page-width-pt", type=float, default=960.0)
    parser.add_argument("--aspect-tolerance", type=float, default=0.01)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = package(args)
    except Exception as exc:  # CLI boundary
        print(json.dumps({"passed": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
