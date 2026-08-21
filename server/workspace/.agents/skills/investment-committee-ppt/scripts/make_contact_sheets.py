#!/usr/bin/env python3
"""Build contact sheets from slide/page PNGs for whole-deck visual QA."""

from __future__ import annotations

import argparse
import math
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def natural_key(path: Path):
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name)]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--columns", type=int, default=4)
    parser.add_argument("--rows", type=int, default=3)
    parser.add_argument("--thumb-width", type=int, default=420)
    args = parser.parse_args()

    source = args.input_dir.resolve()
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    pages = sorted(
        [p for p in source.glob("*.png") if not p.name.lower().startswith("contact")],
        key=natural_key,
    )
    if not pages:
        raise SystemExit(f"No PNG pages found in {source}")

    cols, rows = args.columns, args.rows
    thumb_w = args.thumb_width
    thumb_h = round(thumb_w * 9 / 16)
    gap, label_h = 22, 28
    sheet_w = gap + cols * (thumb_w + gap)
    sheet_h = gap + rows * (thumb_h + label_h + gap)
    font = ImageFont.load_default()
    per_sheet = cols * rows

    for sheet_index in range(math.ceil(len(pages) / per_sheet)):
        sheet = Image.new("RGB", (sheet_w, sheet_h), "#E9E6DF")
        draw = ImageDraw.Draw(sheet)
        group = pages[sheet_index * per_sheet : (sheet_index + 1) * per_sheet]
        for index, page in enumerate(group):
            row, col = divmod(index, cols)
            x = gap + col * (thumb_w + gap)
            y = gap + row * (thumb_h + label_h + gap)
            with Image.open(page) as image:
                thumb = image.convert("RGB")
                thumb.thumbnail((thumb_w, thumb_h))
                canvas = Image.new("RGB", (thumb_w, thumb_h), "white")
                canvas.paste(thumb, ((thumb_w - thumb.width) // 2, (thumb_h - thumb.height) // 2))
                sheet.paste(canvas, (x, y))
            draw.text((x, y + thumb_h + 6), page.stem, fill="#202522", font=font)
        destination = output / f"contact-{sheet_index + 1:02d}.png"
        sheet.save(destination, quality=95)
        print(destination)


if __name__ == "__main__":
    main()
