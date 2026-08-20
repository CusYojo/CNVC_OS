#!/usr/bin/env python3
"""Render a DOCX to page images and run basic visual-integrity checks."""

from __future__ import annotations

import argparse
import html
import os
import platform
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

import fitz


def font_directories() -> list[Path]:
    configured = os.environ.get("AI_DD_SKILL_FONT_DIRS", "").split(os.pathsep)
    candidates = [
        *(Path(value) for value in configured if value),
        Path.home() / "Library/Fonts",
        Path("/Library/Fonts"),
        Path("/System/Library/Fonts"),
        Path("/System/Library/Fonts/Supplemental"),
        Path("/System/Library/AssetsV2/com_apple_MobileAsset_Font7/1821952872c81043711aab6910052b65da8edf2c.asset/AssetData"),
        Path("/System/Library/AssetsV2/com_apple_MobileAsset_Font7/eb257c12d1a51c8c661b89f30eec56cacf9b8987.asset/AssetData"),
        Path("/usr/share/fonts"),
        Path("/usr/local/share/fonts"),
    ]
    return list(dict.fromkeys(path for path in candidates if path.exists()))


def libreoffice_environment(work: Path) -> dict[str, str]:
    directories = font_directories()
    cache = work / "fontconfig-cache"
    cache.mkdir(parents=True, exist_ok=True)
    config = work / "fonts.conf"
    directory_xml = "\n".join(
        f"  <dir>{html.escape(str(directory))}</dir>" for directory in directories
    )
    config.write_text(
        "\n".join(
            [
                '<?xml version="1.0"?>',
                '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
                "<fontconfig>",
                directory_xml,
                f"  <cachedir>{html.escape(str(cache))}</cachedir>",
                '  <match target="pattern"><test name="family"><string>仿宋_GB2312</string></test><edit name="family" mode="prepend"><string>STFangsong</string></edit></match>',
                '  <match target="pattern"><test name="family"><string>仿宋</string></test><edit name="family" mode="prepend"><string>STFangsong</string></edit></match>',
                '  <match target="pattern"><test name="family"><string>黑体</string></test><edit name="family" mode="prepend"><string>STHeiti</string><string>Noto Sans CJK SC</string></edit></match>',
                "</fontconfig>",
            ]
        ),
        encoding="utf-8",
    )
    return {
        **os.environ,
        "FONTCONFIG_FILE": str(config),
        "FONTCONFIG_PATH": str(work),
        "SAL_FONTPATH": os.pathsep.join(map(str, directories)),
        "HOME": str(work),
        "TMPDIR": str(work),
    }


def source_cjk_count(docx: Path) -> int:
    with zipfile.ZipFile(docx) as archive:
        document_xml = archive.read("word/document.xml").decode("utf-8", "ignore")
    text = html.unescape("".join(re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", document_xml, re.S)))
    return len(re.findall(r"[\u3400-\u9fff]", text))


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
    # The server-side renderer must remain headless. On macOS, activating Word
    # through AppleScript can block indefinitely on a desktop prompt or first-run
    # dialog, which is unsuitable for a supervised background task. Prefer the
    # configured/bundled LibreOffice binary and keep Word only as a last-resort
    # compatibility fallback when no headless renderer exists.
    soffice = (
        os.environ.get("AI_DD_SOFFICE_BINARY")
        or os.environ.get("AI_QA_SOFFICE_BINARY")
        or os.environ.get("AI_PDF_TO_PPT_LIBREOFFICE")
        or shutil.which("soffice")
        or shutil.which("libreoffice")
    )
    if not soffice:
        word_pdf = convert_with_word(docx, work)
        if word_pdf is not None:
            return word_pdf, "Microsoft Word"
        raise RuntimeError("neither LibreOffice/soffice nor Microsoft Word export is available")
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
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=180,
        env=libreoffice_environment(work),
    )
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip())
    pdf = work / f"{docx.stem}.pdf"
    if not pdf.exists():
        raise RuntimeError("LibreOffice did not create a PDF")
    return pdf, "LibreOffice"


def render(pdf: Path, output_dir: Path, dpi: int) -> tuple[int, list[str], int, set[str]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []
    zoom = dpi / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    pdf_cjk_count = 0
    font_names: set[str] = set()
    with fitz.open(pdf) as document:
        for index, page in enumerate(document, 1):
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            image_path = output_dir / f"page-{index:03d}.png"
            pix.save(image_path)
            words = page.get_text("words")
            pdf_cjk_count += len(re.findall(r"[\u3400-\u9fff]", page.get_text("text")))
            font_names.update(
                str(font[3]) for font in page.get_fonts(full=True) if len(font) > 3
            )
            drawings = page.get_drawings()
            images = page.get_images(full=True)
            if not words and not drawings and not images:
                warnings.append(f"page {index} appears blank")
        return len(document), warnings, pdf_cjk_count, font_names


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
            pages, warnings, pdf_cjk_count, font_names = render(pdf, output_dir, args.dpi)
            expected_cjk_count = source_cjk_count(docx)
            if expected_cjk_count and pdf_cjk_count < max(8, int(expected_cjk_count * 0.5)):
                raise RuntimeError(
                    "rendered PDF lost Chinese glyphs "
                    f"({pdf_cjk_count}/{expected_cjk_count}); check FangSong/Heiti font mapping"
                )
            if expected_cjk_count and not any(
                re.search(r"(?:fang|song|hei|pingfang|noto.*cjk)", name, re.I)
                for name in font_names
            ):
                raise RuntimeError(
                    "rendered PDF did not use a recognized CJK font: "
                    + ", ".join(sorted(font_names))
                )
            if args.emit_pdf:
                target = Path(args.emit_pdf).resolve()
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(pdf, target)
                print(f"PDF: {target}")
        for warning in warnings:
            print(f"WARNING: {warning}")
        print(f"Renderer: {renderer}")
        print(f"Chinese glyph retention: {pdf_cjk_count}/{expected_cjk_count}")
        print(f"PDF fonts: {', '.join(sorted(font_names))}")
        print(f"Rendered {pages} page(s) to {output_dir}")
        print("Manual review required: inspect every PNG at 100% zoom.")
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError, fitz.FileDataError) as exc:
        print(f"ERROR: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
