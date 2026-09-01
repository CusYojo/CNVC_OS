#!/usr/bin/env python3
"""Validate the final DOCX/PDF delivery pair and rendered PDF page count."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import zipfile

from pypdf import PdfReader


def validate(docx: Path, pdf: Path, render_dir: Path | None) -> dict[str, object]:
    errors: list[str] = []
    metrics: dict[str, object] = {}

    if not docx.is_file():
        errors.append(f"DOCX不存在：{docx}")
    elif docx.suffix.lower() != ".docx":
        errors.append(f"DOCX扩展名错误：{docx.name}")
    else:
        try:
            with zipfile.ZipFile(docx) as archive:
                if "word/document.xml" not in archive.namelist():
                    errors.append("DOCX缺少word/document.xml")
        except (OSError, zipfile.BadZipFile) as exc:
            errors.append(f"DOCX不可读：{exc}")

    if not pdf.is_file():
        errors.append(f"PDF不存在：{pdf}")
    elif pdf.suffix.lower() != ".pdf":
        errors.append(f"PDF扩展名错误：{pdf.name}")

    if docx.stem != pdf.stem:
        errors.append(f"主文件名不一致：{docx.stem!r} != {pdf.stem!r}")

    page_count = 0
    if pdf.is_file():
        metrics["pdf_bytes"] = pdf.stat().st_size
        if pdf.stat().st_size == 0:
            errors.append("PDF为空文件")
        else:
            try:
                reader = PdfReader(str(pdf))
                if reader.is_encrypted:
                    errors.append("PDF已加密，无法验收")
                page_count = len(reader.pages)
                metrics["pdf_pages"] = page_count
                if page_count < 1:
                    errors.append("PDF没有页面")
            except Exception as exc:  # pypdf raises several parser-specific errors
                errors.append(f"PDF不可读：{exc}")

    if render_dir is not None:
        if not render_dir.is_dir():
            errors.append(f"PDF渲染目录不存在：{render_dir}")
        else:
            rendered = sorted(render_dir.glob("*.png"))
            metrics["rendered_png_pages"] = len(rendered)
            if page_count and len(rendered) != page_count:
                errors.append(
                    f"PDF页数与渲染图数量不一致：{page_count}页 != {len(rendered)}张"
                )

    return {"status": "pass" if not errors else "fail", "errors": errors, "metrics": metrics}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("docx", type=Path)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--render-dir", type=Path)
    args = parser.parse_args()

    report = validate(args.docx.resolve(), args.pdf.resolve(), args.render_dir.resolve() if args.render_dir else None)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
