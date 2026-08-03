#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from openxml_runtime import analyze_pptx, write_json


def main() -> None:
    parser = argparse.ArgumentParser(description="使用公开 OpenXML 运行时分析 PPTX。")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    source = args.input.expanduser().resolve()
    report = analyze_pptx(source)
    write_json(
        args.output.expanduser().resolve(),
        {**report, "input": str(source), "runtime": "openxml-stdlib"},
    )
    object_count = sum(len(slide["objects"]) for slide in report["slides"])
    print(
        f"已分析 {report['slideCount']} 页、{object_count} 个对象：{args.output}"
    )


if __name__ == "__main__":
    main()
