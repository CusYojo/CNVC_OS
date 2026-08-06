#!/usr/bin/env python3
"""将 DOCX 渲染为逐页 PNG；优先使用 Codex 渲染器，并兼容独立 Claude Code 环境。"""

from __future__ import annotations

import argparse
import glob
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def find_renderer() -> Path | None:
    candidates = sorted(
        glob.glob(
            str(
                Path.home()
                / ".codex/plugins/cache/openai-primary-runtime/documents/*/skills/documents/render_docx.py"
            )
        )
    )
    return Path(candidates[-1]) if candidates else None


def find_runtime_python() -> Path | None:
    """查找包含 Codex 标准渲染依赖的 Python。"""
    candidates = [
        Path.home()
        / ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3",
        Path(sys.executable),
    ]
    for candidate in candidates:
        if not candidate.exists():
            continue
        check = subprocess.run(
            [str(candidate), "-c", "import pdf2image"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if check.returncode == 0:
            return candidate
    return None


def find_executable(name: str, extra_candidates: list[Path]) -> Path | None:
    found = shutil.which(name)
    if found:
        return Path(found)
    return next((path for path in extra_candidates if path.exists()), None)


def find_soffice() -> Path | None:
    return find_executable(
        "soffice",
        [
            Path("/Applications/LibreOffice.app/Contents/MacOS/soffice"),
            Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice",
            Path("/usr/bin/libreoffice"),
            Path("/usr/local/bin/soffice"),
        ],
    )


def find_pdftoppm() -> Path | None:
    return find_executable(
        "pdftoppm",
        [
            Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm",
            Path("/usr/bin/pdftoppm"),
            Path("/usr/local/bin/pdftoppm"),
            Path("/opt/homebrew/bin/pdftoppm"),
        ],
    )


def font_dirs() -> list[Path]:
    candidates = [
        Path("/System/Library/Fonts"),
        Path("/System/Library/Fonts/Supplemental"),
        Path("/Library/Fonts"),
        Path.home() / "Library/Fonts",
        Path("/Applications/Microsoft Word.app/Contents/Resources/DFonts"),
        Path("/Applications/Microsoft Excel.app/Contents/Resources/DFonts"),
        Path("/Applications/Microsoft PowerPoint.app/Contents/Resources/DFonts"),
    ]
    return [p for p in candidates if p.exists()]


def build_fontconfig(path: Path, cache_dir: Path) -> None:
    dirs = "\n".join(f"  <dir>{p}</dir>" for p in font_dirs())
    xml = f"""<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
{dirs}
  <cachedir>{cache_dir}</cachedir>
  <config></config>
</fontconfig>
"""
    path.write_text(xml, encoding="utf-8")


def render_with_codex(
    docx: Path,
    output_dir: Path,
    renderer: Path,
    runtime_python: Path,
    env: dict[str, str],
    emit_pdf: bool,
    verbose: bool,
) -> int:
    cmd = [
        str(runtime_python),
        str(renderer),
        str(docx),
        "--output_dir",
        str(output_dir),
    ]
    if emit_pdf:
        cmd.append("--emit_pdf")
    if verbose:
        cmd.append("--verbose")
    return subprocess.run(cmd, env=env, check=False).returncode


def render_with_libreoffice(
    docx: Path,
    output_dir: Path,
    env: dict[str, str],
    emit_pdf: bool,
    verbose: bool,
) -> int:
    soffice = find_soffice()
    pdftoppm = find_pdftoppm()
    if soffice is None or pdftoppm is None:
        print(
            "错误：未找到可用的 DOCX 渲染器。请安装 LibreOffice 与 Poppler，"
            "或在 Codex 环境中使用标准文档渲染器。",
            file=sys.stderr,
        )
        return 2

    for old_page in output_dir.glob("page-*.png"):
        old_page.unlink()

    with tempfile.TemporaryDirectory(prefix="investment_qa_render_") as temp:
        temp_path = Path(temp)
        office_profile = temp_path / "office-profile"
        office_profile.mkdir()
        cmd = [
            str(soffice),
            "--headless",
            f"-env:UserInstallation={office_profile.as_uri()}",
            "--convert-to",
            "pdf",
            "--outdir",
            str(temp_path),
            str(docx),
        ]
        converted = subprocess.run(
            cmd,
            env=env,
            check=False,
            capture_output=not verbose,
            text=True,
        )
        if converted.returncode != 0:
            if not verbose:
                print(converted.stdout, file=sys.stderr)
                print(converted.stderr, file=sys.stderr)
            return converted.returncode

        pdf = temp_path / f"{docx.stem}.pdf"
        if not pdf.exists():
            print("错误：LibreOffice 未生成预期的 PDF 文件。", file=sys.stderr)
            return 3

        raster = subprocess.run(
            [
                str(pdftoppm),
                "-png",
                "-r",
                "150",
                str(pdf),
                str(output_dir / "page"),
            ],
            env=env,
            check=False,
        )
        if raster.returncode != 0:
            return raster.returncode
        if emit_pdf:
            shutil.copy2(pdf, output_dir / pdf.name)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docx", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--emit-pdf", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--renderer", type=Path)
    args = parser.parse_args()

    renderer = args.renderer.resolve() if args.renderer else find_renderer()
    runtime_python = find_runtime_python()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="investment_qa_fontconfig_") as temp:
        temp_path = Path(temp)
        cache = temp_path / "cache"
        cache.mkdir()
        config = temp_path / "fonts.conf"
        build_fontconfig(config, cache)
        env = os.environ.copy()
        env["FONTCONFIG_FILE"] = str(config)
        if sys.platform == "darwin":
            env["TMPDIR"] = "/private/tmp"
            env["TEMP"] = "/private/tmp"
            env["TMP"] = "/private/tmp"
        print("可用字体目录：")
        for item in font_dirs():
            print(f"- {item}")
        docx = args.docx.resolve()
        output_dir = args.output_dir.resolve()
        if renderer is not None and runtime_python is not None:
            return render_with_codex(
                docx,
                output_dir,
                renderer,
                runtime_python,
                env,
                args.emit_pdf,
                args.verbose,
            )
        print("未找到 Codex 标准渲染器，改用 LibreOffice + Poppler。")
        return render_with_libreoffice(
            docx,
            output_dir,
            env,
            args.emit_pdf,
            args.verbose,
        )


if __name__ == "__main__":
    raise SystemExit(main())
