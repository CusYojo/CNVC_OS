#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import subprocess
import tempfile
from pathlib import Path

from runtime_environment import fontconfig_environment


def main() -> None:
    parser = argparse.ArgumentParser(
        description="使用 LibreOffice 和 Poppler 渲染 PPTX 全部页面。"
    )
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--render-dir", required=True, type=Path)
    parser.add_argument("--libreoffice", required=True)
    parser.add_argument("--pdftoppm", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    args = parser.parse_args()
    source = args.input.expanduser().resolve()
    render_dir = args.render_dir.expanduser().resolve()
    render_dir.mkdir(parents=True, exist_ok=True)
    for old in render_dir.glob("slide-*.png"):
        old.unlink()
    with tempfile.TemporaryDirectory(prefix="pdf-ppt-render-") as directory:
        temporary = Path(directory)
        profile = temporary / "lo-profile"
        profile.mkdir()
        environment = fontconfig_environment(
            args.libreoffice,
            temporary / "fontconfig-cache",
        )
        result = subprocess.run(
            [
                args.libreoffice,
                "--headless",
                f"-env:UserInstallation={profile.as_uri()}",
                "--convert-to",
                "pdf",
                "--outdir",
                str(temporary),
                str(source),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=args.timeout_seconds,
            env=environment,
        )
        if result.returncode:
            raise RuntimeError(
                "LibreOffice 渲染失败："
                + (result.stderr or result.stdout)[-4000:]
            )
        pdfs = list(temporary.glob("*.pdf"))
        if not pdfs:
            raise RuntimeError("LibreOffice 未生成用于视觉 QA 的 PDF")
        result = subprocess.run(
            [
                args.pdftoppm,
                "-png",
                "-r",
                "120",
                str(pdfs[0]),
                str(render_dir / "slide"),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=args.timeout_seconds,
            env=environment,
        )
        if result.returncode:
            raise RuntimeError(
                "Poppler 渲染失败："
                + (result.stderr or result.stdout)[-4000:]
            )
    renders = sorted(
        render_dir.glob("slide-*.png"),
        key=lambda item: int(re.search(r"(\d+)$", item.stem).group(1)),
    )
    if not renders:
        raise RuntimeError("未生成任何 PPTX 页面图片")
    print(f"已渲染 {len(renders)} 页到 {render_dir}")


if __name__ == "__main__":
    main()
