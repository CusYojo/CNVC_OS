#!/usr/bin/env python3
"""Check whether the host can validate, build, and visually verify QA DOCX files."""

from __future__ import annotations

import argparse
import importlib.util
import json
import platform
import shutil
import sys
from pathlib import Path


def module_available(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Return a non-zero status unless DOCX generation and a render path are ready.",
    )
    args = parser.parse_args()

    system = platform.system()
    word_path = Path("/Applications/Microsoft Word.app")
    pages_path = Path("/Applications/Pages.app")
    renderers = {
        "microsoft_word": system == "Darwin" and word_path.exists(),
        "pages": system == "Darwin" and pages_path.exists(),
        "soffice": bool(shutil.which("soffice")),
        "libreoffice": bool(shutil.which("libreoffice")),
    }
    rasterizers = {
        "pdftoppm": bool(shutil.which("pdftoppm")),
        "pymupdf": module_available("fitz"),
    }
    result = {
        "python": {
            "version": platform.python_version(),
            "supported": sys.version_info >= (3, 9),
        },
        "modules": {
            "python_docx": module_available("docx"),
            "pymupdf": rasterizers["pymupdf"],
        },
        "renderers": renderers,
        "rasterizers": rasterizers,
        "docx_generation_ready": (
            sys.version_info >= (3, 9) and module_available("docx")
        ),
        "visual_qa_path_available": any(renderers.values())
        and any(rasterizers.values()),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if args.strict and not (
        result["docx_generation_ready"] and result["visual_qa_path_available"]
    ):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
