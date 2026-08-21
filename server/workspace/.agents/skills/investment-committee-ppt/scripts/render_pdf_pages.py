#!/usr/bin/env python3
"""Render a PDF to page PNGs with Poppler, including Codex runtime discovery."""

from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path


def find_pdftoppm(explicit: Path | None) -> Path:
    if explicit:
        candidate = explicit.resolve()
        if candidate.exists():
            return candidate
        raise FileNotFoundError(candidate)
    on_path = shutil.which("pdftoppm")
    if on_path:
        return Path(on_path)
    runtime_root = Path.home() / ".cache" / "codex-runtimes" / "codex-primary-runtime" / "dependencies"
    candidates = list(runtime_root.glob("native/poppler/**/pdftoppm.exe"))
    if candidates:
        return candidates[0]
    raise FileNotFoundError("pdftoppm not found; install Poppler or pass --pdftoppm")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--dpi", type=int, default=160)
    parser.add_argument("--prefix", default="slide")
    parser.add_argument("--pdftoppm", type=Path)
    args = parser.parse_args()

    pdf = args.pdf.resolve()
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    binary = find_pdftoppm(args.pdftoppm)
    prefix = output / args.prefix
    command = [str(binary), "-png", "-r", str(args.dpi), str(pdf), str(prefix)]
    subprocess.run(command, check=True)
    pages = sorted(output.glob(f"{args.prefix}-*.png"))
    if not pages:
        raise RuntimeError("Poppler completed but produced no PNG pages")
    print(f"Rendered {len(pages)} pages to {output}")


if __name__ == "__main__":
    main()
