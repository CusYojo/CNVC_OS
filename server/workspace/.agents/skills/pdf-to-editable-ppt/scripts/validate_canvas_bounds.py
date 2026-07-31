#!/usr/bin/env python3
"""Validate that top-level PPTX objects remain inside the slide canvas."""
from __future__ import annotations

import argparse
import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS = {"p": P_NS, "a": A_NS}


def slide_number(path: str) -> int:
    match = re.search(r"slide(\d+)\.xml$", path)
    if not match:
        raise ValueError(path)
    return int(match.group(1))


def object_name(node: ET.Element) -> str:
    for path in (
        "./p:nvSpPr/p:cNvPr",
        "./p:nvPicPr/p:cNvPr",
        "./p:nvGraphicFramePr/p:cNvPr",
        "./p:nvCxnSpPr/p:cNvPr",
    ):
        value = node.find(path, NS)
        if value is not None:
            return value.attrib.get("name", "")
    return ""


def transform(node: ET.Element) -> tuple[int, int, int, int] | None:
    xfrm = (
        node.find("./p:spPr/a:xfrm", NS)
        or node.find("./p:xfrm", NS)
    )
    if xfrm is None:
        return None
    offset = xfrm.find("./a:off", NS)
    extent = xfrm.find("./a:ext", NS)
    if offset is None or extent is None:
        return None
    return (
        int(offset.attrib.get("x", 0)),
        int(offset.attrib.get("y", 0)),
        int(extent.attrib.get("cx", 0)),
        int(extent.attrib.get("cy", 0)),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pptx", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--tolerance-ratio", type=float, default=0.01)
    args = parser.parse_args()

    issues = []
    objects = 0
    with zipfile.ZipFile(args.pptx.expanduser().resolve()) as archive:
        presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
        size = presentation.find(".//p:sldSz", NS)
        if size is None:
            raise RuntimeError("presentation.xml 缺少 p:sldSz")
        slide_width = int(size.attrib["cx"])
        slide_height = int(size.attrib["cy"])
        tolerance_x = slide_width * max(0, args.tolerance_ratio)
        tolerance_y = slide_height * max(0, args.tolerance_ratio)
        slide_paths = sorted(
            (
                name
                for name in archive.namelist()
                if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
            ),
            key=slide_number,
        )
        for slide_path in slide_paths:
            page = slide_number(slide_path)
            slide = ET.fromstring(archive.read(slide_path))
            tree = slide.find(".//p:spTree", NS)
            if tree is None:
                continue
            for node in list(tree):
                if node.tag not in {
                    f"{{{P_NS}}}sp",
                    f"{{{P_NS}}}pic",
                    f"{{{P_NS}}}graphicFrame",
                    f"{{{P_NS}}}cxnSp",
                }:
                    continue
                frame = transform(node)
                if frame is None:
                    continue
                objects += 1
                x, y, width, height = frame
                overflow = {
                    "left": max(0, -x),
                    "top": max(0, -y),
                    "right": max(0, x + width - slide_width),
                    "bottom": max(0, y + height - slide_height),
                }
                if (
                    overflow["left"] > tolerance_x
                    or overflow["right"] > tolerance_x
                    or overflow["top"] > tolerance_y
                    or overflow["bottom"] > tolerance_y
                ):
                    issues.append(
                        {
                            "page": page,
                            "name": object_name(node),
                            "frame": {
                                "x": x,
                                "y": y,
                                "width": width,
                                "height": height,
                            },
                            "overflow": overflow,
                        }
                    )
    report = {
        "schemaVersion": "1.0",
        "pptx": str(args.pptx.expanduser().resolve()),
        "slideSize": {"width": slide_width, "height": slide_height},
        "toleranceRatio": args.tolerance_ratio,
        "objectCount": objects,
        "issues": issues,
        "passed": not issues,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if issues:
        raise RuntimeError(
            f"检测到 {len(issues)} 个对象越出画布，详见 {args.output}"
        )
    print(f"画布边界检查通过：{objects} 个对象；写入 {args.output}")


if __name__ == "__main__":
    main()
