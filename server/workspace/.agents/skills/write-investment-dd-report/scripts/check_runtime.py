#!/usr/bin/env python3
"""Check the portable runtime required by the investment DD skill."""

from __future__ import annotations

import argparse
import importlib.util
import json
import platform
import shutil
import subprocess
import sys
from pathlib import Path


MIN_PYTHON = (3, 10)
REQUIRED_MODULES = {
    "docx": "python-docx",
    "fitz": "PyMuPDF",
    "lxml": "lxml",
}


def installed_font_families() -> str:
    fc_list = shutil.which("fc-list")
    if not fc_list:
        return ""
    try:
        result = subprocess.run(
            [fc_list, ":", "family"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        return result.stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def inspect_runtime() -> dict:
    modules = {
        module: importlib.util.find_spec(module) is not None
        for module in REQUIRED_MODULES
    }
    word = (
        platform.system() == "Darwin"
        and Path("/Applications/Microsoft Word.app").exists()
        and shutil.which("osascript") is not None
    )
    libreoffice = shutil.which("soffice") or shutil.which("libreoffice")
    renderer = "Microsoft Word" if word else ("LibreOffice" if libreoffice else "")
    font_families = installed_font_families()
    fangsong = any(name.casefold() in font_families.casefold() for name in (
        "STFangsong", "FangSong", "仿宋",
    ))
    heiti = any(name.casefold() in font_families.casefold() for name in (
        "STHeiti", "SimHei", "Heiti SC", "黑体", "Noto Sans CJK SC",
    ))
    return {
        "python": sys.executable,
        "python_version": platform.python_version(),
        "python_supported": sys.version_info >= MIN_PYTHON,
        "modules": modules,
        "renderer": renderer,
        "fonts": {"fangsong": fangsong, "heiti": heiti},
        "platform": platform.platform(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = parser.parse_args()
    result = inspect_runtime()
    missing = [
        package
        for module, package in REQUIRED_MODULES.items()
        if not result["modules"][module]
    ]
    errors: list[str] = []
    if not result["python_supported"]:
        errors.append("Python 3.10 or later is required")
    if missing:
        errors.append("missing Python package(s): " + ", ".join(missing))
    if not result["renderer"]:
        errors.append("Microsoft Word export or LibreOffice/soffice is required")
    if not result["fonts"]["fangsong"]:
        errors.append("FangSong/STFangsong font is required for body text")
    if not result["fonts"]["heiti"]:
        errors.append("Heiti/SimHei font is required for headings")

    if args.json:
        result["errors"] = errors
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"Python: {result['python']} ({result['python_version']})")
        for module, installed in result["modules"].items():
            package = REQUIRED_MODULES[module]
            print(f"Module {module} ({package}): {'ok' if installed else 'missing'}")
        print(f"Renderer: {result['renderer'] or 'missing'}")
        print(f"Font FangSong: {'ok' if result['fonts']['fangsong'] else 'missing'}")
        print(f"Font Heiti: {'ok' if result['fonts']['heiti'] else 'missing'}")
        for error in errors:
            print(f"ERROR: {error}")
        if not errors:
            print("Runtime check: passed")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
