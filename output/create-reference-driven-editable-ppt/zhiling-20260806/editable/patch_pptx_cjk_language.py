#!/usr/bin/env python3
"""Set East Asian run language in generated PPTX slide XML without changing layout."""

from __future__ import annotations

import argparse
import tempfile
import zipfile
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    source = Path(args.input).resolve()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temp_dir:
        temp = Path(temp_dir)
        with zipfile.ZipFile(source) as archive:
            archive.extractall(temp)
        for slide_xml in (temp / "ppt" / "slides").glob("slide*.xml"):
            value = slide_xml.read_text(encoding="utf-8")
            value = value.replace('lang="en-US"', 'lang="zh-CN"')
            slide_xml.write_text(value, encoding="utf-8")
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(temp.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(temp))


if __name__ == "__main__":
    main()
