#!/usr/bin/env python3
"""Render a DOCX to page images and run basic visual-integrity checks."""

from __future__ import annotations

import argparse
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path

import fitz


def convert_with_word(docx: Path, work: Path) -> Path | None:
    if platform.system() != "Darwin" or not Path("/Applications/Microsoft Word.app").exists():
        return None
    osascript = shutil.which("osascript")
    if not osascript:
        return None
    pdf = work / f"{docx.stem}.pdf"
    script = r'''
on run argv
  set srcPath to item 1 of argv
  set outPath to item 2 of argv
  tell application "Microsoft Word"
    activate
    open srcPath
    delay 1
    set docRef to active document
    save as docRef file name outPath file format format PDF
    close docRef saving no
  end tell
end run
'''
    result = subprocess.run(
        [osascript, "-", str(docx), str(pdf)],
        input=script,
        capture_output=True,
        text=True,
        timeout=180,
    )
    return pdf if result.returncode == 0 and pdf.exists() else None


def convert(docx: Path, work: Path) -> tuple[Path, str]:
    word_pdf = convert_with_word(docx, work)
    if word_pdf is not None:
        return word_pdf, "Microsoft Word"
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise RuntimeError("neither Microsoft Word export nor LibreOffice/soffice is available")
    profile = work / "lo-profile"
    profile.mkdir(parents=True, exist_ok=True)
    command = [
        soffice,
        "--headless",
        f"-env:UserInstallation={profile.as_uri()}",
        "--convert-to",
        "pdf",
        "--outdir",
        str(work),
        str(docx),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip())
    pdf = work / f"{docx.stem}.pdf"
    if not pdf.exists():
        raise RuntimeError("LibreOffice did not create a PDF")
    return pdf, "LibreOffice"


def render(pdf: Path, output_dir: Path, dpi: int) -> tuple[int, list[str]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []
    zoom = dpi / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    with fitz.open(pdf) as document:
        for index, page in enumerate(document, 1):
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            image_path = output_dir / f"page-{index:03d}.png"
            pix.save(image_path)
            words = page.get_text("words")
            drawings = page.get_drawings()
            images = page.get_images(full=True)
            if not words and not drawings and not images:
                warnings.append(f"page {index} appears blank")
        return len(document), warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docx")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--emit-pdf")
    parser.add_argument("--dpi", type=int, default=150)
    args = parser.parse_args()
    docx = Path(args.docx).resolve()
    output_dir = Path(args.output_dir).resolve()
    try:
        with tempfile.TemporaryDirectory(prefix="dd-report-render-") as temp:
            pdf, renderer = convert(docx, Path(temp))
            pages, warnings = render(pdf, output_dir, args.dpi)
            if args.emit_pdf:
                target = Path(args.emit_pdf).resolve()
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(pdf, target)
                print(f"PDF: {target}")
        for warning in warnings:
            print(f"WARNING: {warning}")
        print(f"Renderer: {renderer}")
        print(f"Rendered {pages} page(s) to {output_dir}")
        print("Manual review required: inspect every PNG at 100% zoom.")
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError, fitz.FileDataError) as exc:
        print(f"ERROR: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
