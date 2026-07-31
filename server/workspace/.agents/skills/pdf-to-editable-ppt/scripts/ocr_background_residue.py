#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
from pathlib import Path

from prepare_flattened_ocr import (
    create_ocr_json,
    ensure_tesseract_languages,
    resolve_ocr_engine,
    tesseract_language_string,
)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="对最终去字背景重新运行独立 OCR，供文字残留门禁使用。"
    )
    parser.add_argument("--input-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument(
        "--ocr-engine",
        choices=("auto", "apple-vision", "tesseract"),
        default="auto",
    )
    parser.add_argument("--languages", default="zh-Hans,en-US")
    parser.add_argument("--tesseract")
    parser.add_argument("--tesseract-psm", type=int, default=11)
    args = parser.parse_args()

    images = sorted(
        args.input_dir.expanduser().resolve().glob("slide-*-clean.png"),
        key=lambda path: int(re.search(r"slide-(\d+)", path.name).group(1)),
    )
    if not images:
        raise RuntimeError("未找到 slide-*-clean.png 去字背景")
    output_dir = args.output_dir.expanduser().resolve()
    engine, tesseract = resolve_ocr_engine(
        args.ocr_engine,
        None,
        args.tesseract,
    )
    if engine == "tesseract":
        ensure_tesseract_languages(
            tesseract,
            tesseract_language_string(args.languages),
        )
    create_ocr_json(
        images,
        output_dir,
        args.languages,
        engine,
        tesseract=tesseract,
        tesseract_psm=args.tesseract_psm,
    )
    print(f"最终背景二次 OCR 完成：{len(images)} 页；{output_dir}")


if __name__ == "__main__":
    main()
