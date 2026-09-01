#!/usr/bin/env python3
"""Render DOCX with Codex's canonical renderer and a valid LibreOffice Fontconfig."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

sys.dont_write_bytecode = True

from runtime_bootstrap import ensure_runtime


def version_key(path: Path) -> tuple[int, ...]:
    match = re.search(r"/documents/([^/]+)/", str(path))
    if not match:
        return ()
    return tuple(int(part) for part in re.findall(r"\d+", match.group(1)))


def find_renderer(explicit: Path | None) -> Path:
    if explicit is not None:
        renderer = explicit.expanduser().resolve()
        if renderer.is_file():
            return renderer
        raise FileNotFoundError(f"指定的render_docx.py不存在：{renderer}")

    roots = [
        Path.home() / ".codex/plugins/cache/openai-primary-runtime/documents",
        Path.home() / ".codex/plugins/cache/openai-bundled/documents",
    ]
    candidates = [
        path
        for root in roots
        for path in root.glob("*/skills/documents/render_docx.py")
        if path.is_file()
    ]
    if not candidates:
        raise FileNotFoundError("未找到文档技能的render_docx.py；可用--renderer显式指定")
    return max(candidates, key=version_key)


def find_fontconfig(explicit: Path | None) -> Path | None:
    if explicit is not None:
        config = explicit.expanduser().resolve()
        if config.is_file():
            return config
        raise FileNotFoundError(f"指定的Fontconfig文件不存在：{config}")

    inherited = os.environ.get("FONTCONFIG_FILE")
    if inherited and Path(inherited).is_file():
        return Path(inherited).resolve()

    runtime_root = Path.home() / ".cache/codex-runtimes"
    patterns = [
        "*/dependencies/native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/Resources/fontconfig/fonts.conf",
        "*/dependencies/native/libreoffice-headless/libreoffice/LibreOffice.app/Contents/Resources/fontconfig/fonts.conf",
    ]
    candidates = [path for pattern in patterns for path in runtime_root.glob(pattern) if path.is_file()]
    return max(candidates, key=lambda path: path.stat().st_mtime) if candidates else None


def page_number(path: Path) -> int:
    match = re.search(r"page-(\d+)\.png$", path.name)
    return int(match.group(1)) if match else 10**9


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_path", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--renderer", type=Path)
    parser.add_argument("--fontconfig-file", type=Path)
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    parser.add_argument("--dpi", type=int)
    parser.add_argument("--emit-pdf", action="store_true")
    parser.add_argument("--allow-existing-output", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--min-pages", type=int, default=1)
    parser.add_argument("--expect-pages", type=int)
    parser.add_argument("--require-text", action="append", default=[])
    args = parser.parse_args()

    input_path = args.input_path.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()
    if not input_path.is_file():
        print(f"输入文件不存在：{input_path}", file=sys.stderr)
        return 2
    if args.require_text and not args.emit_pdf:
        print("使用--require-text时必须同时使用--emit-pdf", file=sys.stderr)
        return 2
    if (
        output_dir.exists()
        and not args.allow_existing_output
        and any(output_dir.iterdir())
    ):
        print(f"输出目录非空，为避免混用旧渲染已拒绝：{output_dir}", file=sys.stderr)
        return 2

    ensure_runtime(("pypdf", "PIL", "pdf2image"))

    try:
        renderer = find_renderer(args.renderer)
        fontconfig = find_fontconfig(args.fontconfig_file)
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    command = [sys.executable, str(renderer), str(input_path), "--output_dir", str(output_dir)]
    for flag, value in (("--width", args.width), ("--height", args.height), ("--dpi", args.dpi)):
        if value is not None:
            command.extend([flag, str(value)])
    if args.emit_pdf:
        command.append("--emit_pdf")
    if args.verbose:
        command.append("--verbose")

    env = os.environ.copy()
    if fontconfig is not None:
        env["FONTCONFIG_FILE"] = str(fontconfig)
    print(f"RENDERER={renderer}")
    print(f"FONTCONFIG_FILE={fontconfig or 'not-found; inherited system configuration'}")
    completed = subprocess.run(command, env=env, check=False)
    if completed.returncode:
        return completed.returncode

    pages = sorted(output_dir.glob("page-*.png"), key=page_number)
    errors: list[str] = []
    if len(pages) < args.min_pages:
        errors.append(f"渲染页数少于下限：{len(pages)} < {args.min_pages}")
    if args.expect_pages is not None and len(pages) != args.expect_pages:
        errors.append(f"渲染页数不符合预期：{len(pages)} != {args.expect_pages}")

    pdf_path = output_dir / f"{input_path.stem}.pdf"
    extracted_chars = None
    if args.emit_pdf:
        if not pdf_path.is_file():
            errors.append(f"未生成中间PDF：{pdf_path}")
        else:
            try:
                from pypdf import PdfReader

                reader = PdfReader(str(pdf_path))
                text = "\n".join(page.extract_text() or "" for page in reader.pages)
                extracted_chars = len(text)
                if len(reader.pages) != len(pages):
                    errors.append(f"PDF与PNG页数不一致：{len(reader.pages)} != {len(pages)}")
                if "\ufffd" in text:
                    errors.append("PDF文本包含Unicode替换字符，疑似缺字或编码异常")
                for required in args.require_text:
                    if required not in text:
                        errors.append(f"PDF缺少必需文本：{required}")
            except Exception as exc:
                errors.append(f"PDF复核失败：{type(exc).__name__}: {exc}")

    summary = {
        "status": "pass" if not errors else "fail",
        "renderer": str(renderer),
        "fontconfig_file": str(fontconfig) if fontconfig else None,
        "pages": len(pages),
        "pdf": str(pdf_path) if args.emit_pdf else None,
        "pdf_extracted_chars": extracted_chars,
        "errors": errors,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
