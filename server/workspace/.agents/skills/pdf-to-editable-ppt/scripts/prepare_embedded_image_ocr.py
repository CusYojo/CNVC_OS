#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import re
import shutil
from pathlib import Path

from PIL import Image

from prepare_flattened_ocr import (
    ChineseArgumentParser,
    compile_vision_ocr,
    correct_text,
    create_ocr_json,
    join_ocr_words,
    load_cv2,
    load_rules,
    parse_tesseract_tsv,
    resolve_ocr_engine,
    resolve_ocr_fonts,
    run,
    run_capture,
    tesseract_language_string,
    useful_row,
)


def detect_cells(image, threshold, minimum_coverage):
    import numpy as np

    cv2 = load_cv2()
    mask = (np.min(image, axis=2) < threshold).astype(np.uint8) * 255
    contours, _ = cv2.findContours(
        mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    cells = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        coverage = cv2.contourArea(contour) / max(1, width * height)
        if (
            width < 30
            or height < 18
            or coverage < minimum_coverage
        ):
            continue
        cells.append(
            {
                "x": int(x),
                "y": int(y),
                "width": int(width),
                "height": int(height),
                "coverage": round(float(coverage), 4),
            }
        )
    cells.sort(key=lambda cell: (cell["y"], cell["x"]))
    return cells


def top_rect(row, width, height):
    x0 = max(0, int(round(float(row["x"]) * width)))
    y0 = max(
        0,
        int(
            round(
                (
                    1
                    - float(row["y"])
                    - float(row["height"])
                )
                * height
            )
        ),
    )
    x1 = min(
        width,
        int(
            round(
                (float(row["x"]) + float(row["width"]))
                * width
            )
        ),
    )
    y1 = min(
        height,
        int(round((1 - float(row["y"])) * height)),
    )
    return x0, y0, x1, y1


def center_in_cell(rect, cell):
    x0, y0, x1, y1 = rect
    center_x = (x0 + x1) / 2
    center_y = (y0 + y1) / 2
    return (
        cell["x"] <= center_x <= cell["x"] + cell["width"]
        and cell["y"] <= center_y <= cell["y"] + cell["height"]
    )


def cjk_join(values):
    values = [str(value).strip() for value in values if str(value).strip()]
    if not values:
        return ""
    cjk = re.compile(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]")
    text = values[0]
    for value in values[1:]:
        separator = "" if cjk.search(text[-1:]) and cjk.search(value[:1]) else " "
        text += separator + value
    return text


def cell_background_color(crop):
    import numpy as np

    pixels = crop.reshape(-1, 3)
    if not len(pixels):
        return [255, 255, 255]
    return [
        int(value)
        for value in np.median(pixels, axis=0)
    ]


def write_cell_crop(
    image,
    cell,
    output_path,
    *,
    vertical,
    scale=3,
):
    cv2 = load_cv2()
    x, y = cell["x"], cell["y"]
    width, height = cell["width"], cell["height"]
    inset = max(1, min(width, height) // 30)
    crop = image[
        y + inset : y + height - inset,
        x + inset : x + width - inset,
    ]
    if crop.size == 0:
        crop = image[y : y + height, x : x + width]
    if vertical:
        crop = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)
    crop = cv2.resize(
        crop,
        None,
        fx=scale,
        fy=scale,
        interpolation=cv2.INTER_CUBIC,
    )
    cv2.imwrite(str(output_path), crop)


def useful_cell_row(row, minimum_confidence):
    text = str(row.get("text", "")).strip()
    return bool(text) and float(row.get("confidence", 0)) >= minimum_confidence


def vertical_character_rects(image, cell):
    import numpy as np

    cv2 = load_cv2()
    x, y = cell["x"], cell["y"]
    width, height = cell["width"], cell["height"]
    inset = max(2, min(width, height) // 20)
    crop = image[
        y + inset : y + height - inset,
        x + inset : x + width - inset,
    ]
    if crop.size == 0:
        return []
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    background = float(np.median(gray))
    threshold = int(max(55, min(205, background * 0.78)))
    mask = (gray < threshold).astype(np.uint8) * 255
    mask = cv2.dilate(
        mask,
        cv2.getStructuringElement(cv2.MORPH_RECT, (2, 1)),
        iterations=1,
    )
    active = np.count_nonzero(mask, axis=1) >= max(2, crop.shape[1] // 22)
    runs = []
    start = None
    for row_index, value in enumerate(active.tolist() + [False]):
        if value and start is None:
            start = row_index
        elif not value and start is not None:
            if row_index - start >= 3:
                runs.append([start, row_index])
            start = None
    if not runs:
        return []
    merged = [runs[0]]
    expected_height = max(8, int(width * 0.42))
    for start, end in runs[1:]:
        previous = merged[-1]
        gap = start - previous[1]
        previous_height = previous[1] - previous[0]
        current_height = end - start
        if (
            previous_height < expected_height * 0.38
            or current_height < expected_height * 0.38
        ):
            previous[1] = end
        else:
            merged.append([start, end])
    rects = []
    for start, end in merged:
        segment = mask[start:end]
        columns = np.flatnonzero(np.count_nonzero(segment, axis=0))
        if not len(columns):
            continue
        left = max(0, int(columns[0]) - 2)
        right = min(crop.shape[1], int(columns[-1]) + 3)
        top = max(0, start - 2)
        bottom = min(crop.shape[0], end + 2)
        if bottom - top < 4 or right - left < 3:
            continue
        rects.append(
            (
                x + inset + left,
                y + inset + top,
                right - left,
                bottom - top,
            )
        )
    return rects


def write_character_crop(image, rect, output_path, scale=5):
    import numpy as np

    cv2 = load_cv2()
    x, y, width, height = rect
    pad = max(3, min(width, height) // 5)
    crop = image[
        max(0, y - pad) : min(image.shape[0], y + height + pad),
        max(0, x - pad) : min(image.shape[1], x + width + pad),
    ]
    side = max(crop.shape[0], crop.shape[1]) + pad * 2
    background = cell_background_color(crop)
    canvas = np.full((side, side, 3), background, dtype=np.uint8)
    top = (side - crop.shape[0]) // 2
    left = (side - crop.shape[1]) // 2
    canvas[top : top + crop.shape[0], left : left + crop.shape[1]] = crop
    canvas = cv2.resize(
        canvas,
        None,
        fx=scale,
        fy=scale,
        interpolation=cv2.INTER_CUBIC,
    )
    cv2.imwrite(str(output_path), canvas)


def ocr_vertical_characters(
    image,
    cell,
    output_dir,
    engine,
    languages,
    *,
    vision_binary=None,
    tesseract=None,
    minimum_confidence=0.2,
):
    characters = []
    rects = vertical_character_rects(image, cell)
    for index, rect in enumerate(rects):
        crop_path = output_dir / f"char-{index + 1:02d}.png"
        write_character_crop(image, rect, crop_path)
        rows = ocr_one_image(
            crop_path,
            engine,
            languages,
            vision_binary=vision_binary,
            tesseract=tesseract,
            tesseract_psm=10,
        )
        accepted = [
            row
            for row in rows
            if useful_cell_row(row, minimum_confidence)
        ]
        if accepted:
            characters.append(str(accepted[0]["text"]).strip())
        else:
            characters.append("")
    return "".join(characters), rects


def ocr_one_image(
    image_path,
    engine,
    languages,
    *,
    vision_binary=None,
    tesseract=None,
    tesseract_psm=7,
):
    if engine == "apple-vision":
        output = image_path.with_suffix(".json")
        if output.exists():
            return json.loads(output.read_text(encoding="utf-8"))
        run([vision_binary, image_path, output, languages])
        return json.loads(output.read_text(encoding="utf-8"))
    if engine == "tesseract":
        with Image.open(image_path) as image:
            width, height = image.size
        tsv = run_capture(
            [
                tesseract,
                image_path,
                "stdout",
                "-l",
                tesseract_language_string(languages),
                "--psm",
                str(tesseract_psm),
                "tsv",
            ]
        )
        return parse_tesseract_tsv(tsv, width, height)
    return []


def text_style_for_cell(
    text,
    cell,
    image_width,
    image_height,
    target,
    font,
    fill_bgr,
    vertical,
):
    target_width = cell["width"] / image_width * target["width"]
    target_height = cell["height"] / image_height * target["height"]
    compact_text = re.sub(r"\s+", "", text)
    length = max(1, len(compact_text))
    if vertical:
        font_size = min(
            target_width * 0.48,
            target_height / max(1.0, length * 0.92),
        )
    else:
        font_size = min(
            target_height * 0.56,
            target_width / max(1.0, length * 0.62),
        )
    brightness = (
        0.114 * fill_bgr[0]
        + 0.587 * fill_bgr[1]
        + 0.299 * fill_bgr[2]
    )
    return {
        "fontSize": round(max(8.0, min(34.0, font_size)), 2),
        "typeface": font,
        "color": "#FFFFFF" if brightness < 150 else "#202020",
        "bold": bool(brightness < 150),
        "alignment": "center",
        "verticalAlignment": "middle",
        "autoFit": "shrinkText",
        "wrap": "none",
        "lineSpacing": 0.9 if vertical else 1,
        "insets": {
            "left": 1,
            "right": 1,
            "top": 1,
            "bottom": 1,
        },
    }


def map_position(rect, image_width, image_height, target):
    x, y, width, height = rect
    return {
        "left": round(
            target["left"] + x / image_width * target["width"], 2
        ),
        "top": round(
            target["top"] + y / image_height * target["height"], 2
        ),
        "width": round(width / image_width * target["width"], 2),
        "height": round(height / image_height * target["height"], 2),
    }


def merge_overrides(base, slide_number, replacement, texts):
    slides = base.setdefault("slides", {})
    page = slides.setdefault(str(slide_number), {})
    page.setdefault("imageReplacements", []).append(replacement)
    page.setdefault("texts", []).extend(texts)
    return base


def main():
    parser = ChineseArgumentParser(
        description="清除富对象 PDF 内嵌图片中的栅格文字，并生成可编辑文字覆盖清单。"
    )
    parser.add_argument("--image", required=True, type=Path, help="内嵌图片资源")
    parser.add_argument("--source-pdf", required=True, type=Path, help="源 PDF")
    parser.add_argument("--slide-number", required=True, type=int, help="目标页码")
    parser.add_argument("--left", required=True, type=float)
    parser.add_argument("--top", required=True, type=float)
    parser.add_argument("--width", required=True, type=float)
    parser.add_argument("--height", required=True, type=float)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--output-overrides", required=True, type=Path)
    parser.add_argument("--base-overrides", type=Path)
    parser.add_argument("--source-asset-name")
    parser.add_argument("--corrections", type=Path)
    parser.add_argument(
        "--ocr-engine",
        choices=("auto", "apple-vision", "tesseract"),
        default="auto",
    )
    parser.add_argument("--languages", default="zh-Hans,en-US")
    parser.add_argument("--tesseract")
    parser.add_argument("--tesseract-psm", type=int, default=7)
    parser.add_argument("--minimum-confidence", type=float, default=0.3)
    parser.add_argument("--body-font", default="auto")
    parser.add_argument("--title-font", default="auto")
    parser.add_argument("--cell-threshold", type=int, default=245)
    parser.add_argument("--minimum-cell-coverage", type=float, default=0.85)
    parser.add_argument(
        "--disable-cell-aware",
        action="store_true",
        help="禁用矩形单元格检测，仅使用整图 OCR。",
    )
    args = parser.parse_args()

    import numpy as np

    cv2 = load_cv2()
    image_path = args.image.expanduser().resolve()
    source_pdf = args.source_pdf.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()
    output_overrides = args.output_overrides.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    source_dir = output_dir / "source"
    whole_ocr_dir = output_dir / "whole-ocr"
    cell_dir = output_dir / "cell-crops"
    source_dir.mkdir(parents=True, exist_ok=True)
    cell_dir.mkdir(parents=True, exist_ok=True)
    source_copy = source_dir / "slide-01.png"
    shutil.copy2(image_path, source_copy)

    engine, tesseract = resolve_ocr_engine(
        args.ocr_engine, None, args.tesseract
    )
    body_font, title_font = resolve_ocr_fonts(
        args.body_font, args.title_font
    )
    create_ocr_json(
        [source_copy],
        whole_ocr_dir,
        args.languages,
        engine,
        tesseract=tesseract,
        tesseract_psm=11,
        detect_vertical_text=True,
    )
    rows = json.loads(
        (whole_ocr_dir / "slide-01.json").read_text(encoding="utf-8")
    )
    rules = load_rules(
        args.corrections.expanduser().resolve()
        if args.corrections
        else None
    )
    correction_payload = {}
    if args.corrections:
        correction_payload = json.loads(
            args.corrections.expanduser().resolve().read_text(
                encoding="utf-8"
            )
        )
    cell_text = {
        str(key): str(value)
        for key, value in correction_payload.get("cell_text", {}).items()
    }
    free_text = {
        str(key): str(value)
        for key, value in correction_payload.get("free_text", {}).items()
    }
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"无法读取 {image_path}")
    image_height, image_width = image.shape[:2]
    cleaned = image.copy()
    cells = (
        []
        if args.disable_cell_aware
        else detect_cells(
            image,
            max(0, min(255, args.cell_threshold)),
            args.minimum_cell_coverage,
        )
    )
    target = {
        "left": args.left,
        "top": args.top,
        "width": args.width,
        "height": args.height,
    }

    vision_binary = None
    if engine == "apple-vision":
        vision_binary = output_dir / "vision-ocr"
        compile_vision_ocr(vision_binary)

    texts = []
    recognized_cells = 0
    unrecognized_cells = []
    recognized_cell_details = []
    for index, cell in enumerate(cells):
        x, y = cell["x"], cell["y"]
        width, height = cell["width"], cell["height"]
        crop = image[y : y + height, x : x + width]
        fill_bgr = cell_background_color(crop)
        cleaned[y : y + height, x : x + width] = np.array(
            fill_bgr, dtype=np.uint8
        )
        vertical = height > width * 1.25
        crop_path = cell_dir / f"cell-{index + 1:03d}.png"
        write_cell_crop(
            image,
            cell,
            crop_path,
            vertical=vertical,
        )
        cell_rows = ocr_one_image(
            crop_path,
            engine,
            args.languages,
            vision_binary=vision_binary,
            tesseract=tesseract,
            tesseract_psm=args.tesseract_psm,
        )
        accepted = [
            row
            for row in cell_rows
            if useful_cell_row(row, args.minimum_confidence)
        ]
        text = cjk_join(row["text"] for row in accepted)
        character_rects = []
        if vertical:
            character_dir = cell_dir / f"cell-{index + 1:03d}-chars"
            character_dir.mkdir(parents=True, exist_ok=True)
            character_text, character_rects = ocr_vertical_characters(
                image,
                cell,
                character_dir,
                engine,
                args.languages,
                vision_binary=vision_binary,
                tesseract=tesseract,
                minimum_confidence=max(0.15, args.minimum_confidence * 0.65),
            )
            if character_text:
                text = character_text
        if str(index + 1) in cell_text:
            text = cell_text[str(index + 1)].strip()
        text = correct_text(text, rules["replacements"])
        if not text:
            unrecognized_cells.append(
                {
                    "index": index + 1,
                    "bbox": cell,
                    "character_count": len(character_rects),
                }
            )
            continue
        recognized_cells += 1
        display_text = (
            "\n".join(char for char in text if not char.isspace())
            if vertical
            else text
        )
        texts.append(
            {
                "name": (
                    f"embedded-ocr-p{args.slide_number:02d}-"
                    f"cell-{index + 1:03d}"
                ),
                "position": map_position(
                    (x, y, width, height),
                    image_width,
                    image_height,
                    target,
                ),
                "text": display_text,
                "textStyle": text_style_for_cell(
                    text,
                    cell,
                    image_width,
                    image_height,
                    target,
                    title_font if fill_bgr[0] > 120 and fill_bgr[2] < 80 else body_font,
                    fill_bgr,
                    vertical,
                ),
            }
        )
        recognized_cell_details.append(
            {
                "index": index + 1,
                "bbox": cell,
                "text": text,
                "vertical": vertical,
                "character_count": len(character_rects),
            }
        )

    mask = np.zeros((image_height, image_width), dtype=np.uint8)
    outside_count = 0
    for row in rows:
        if not useful_row(row, args.minimum_confidence):
            continue
        rect = top_rect(row, image_width, image_height)
        if any(center_in_cell(rect, cell) for cell in cells):
            continue
        x0, y0, x1, y1 = rect
        if x1 <= x0 or y1 <= y0:
            continue
        text = correct_text(row["text"], rules["replacements"])
        if str(outside_count + 1) in free_text:
            text = free_text[str(outside_count + 1)].strip()
        vertical = row.get("orientation") == "vertical"
        display_text = (
            "\n".join(char for char in text if not char.isspace())
            if vertical
            else text
        )
        pad = max(2, min(x1 - x0, y1 - y0) // 12)
        mask[
            max(0, y0 - pad) : min(image_height, y1 + pad),
            max(0, x0 - pad) : min(image_width, x1 + pad),
        ] = 255
        position = map_position(
            (x0, y0, x1 - x0, y1 - y0),
            image_width,
            image_height,
            target,
        )
        font_basis = position["width"] if vertical else position["height"]
        texts.append(
            {
                "name": (
                    f"embedded-ocr-p{args.slide_number:02d}-"
                    f"free-{outside_count + 1:03d}"
                ),
                "position": position,
                "text": display_text,
                "textStyle": {
                    "fontSize": round(
                        max(8.0, min(36.0, font_basis * 0.82)), 2
                    ),
                    "typeface": body_font,
                    "color": "#202020",
                    "bold": False,
                    "alignment": "center",
                    "verticalAlignment": "middle",
                    "autoFit": "shrinkText",
                    "wrap": "none",
                    "lineSpacing": 0.9 if vertical else 1,
                    "insets": {
                        "left": 0,
                        "right": 0,
                        "top": 0,
                        "bottom": 0,
                    },
                },
            }
        )
        outside_count += 1

    if mask.any():
        cleaned = cv2.inpaint(cleaned, mask, 5, cv2.INPAINT_TELEA)
    clean_path = output_dir / "embedded-image-clean.png"
    cv2.imwrite(str(clean_path), cleaned)

    base = {"slides": {}}
    if args.base_overrides:
        base = json.loads(
            args.base_overrides.expanduser().resolve().read_text(
                encoding="utf-8"
            )
        )
    replacement = {
        "sourceAssetName": (
            args.source_asset_name or image_path.name
        ),
        "asset": str(clean_path),
        "contentType": "image/png",
        "alt": (
            f"第 {args.slide_number} 页内嵌图片，"
            "栅格文字已清除并替换为可编辑文本框"
        ),
    }
    result = merge_overrides(
        base,
        args.slide_number,
        replacement,
        texts,
    )
    output_overrides.parent.mkdir(parents=True, exist_ok=True)
    output_overrides.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    report = {
        "slide": args.slide_number,
        "image": str(image_path),
        "ocr_engine": engine,
        "detected_cell_count": len(cells),
        "recognized_cell_count": recognized_cells,
        "unrecognized_cell_count": len(unrecognized_cells),
        "outside_text_count": outside_count,
        "editable_text_count": len(texts),
        "recognized_cells": recognized_cell_details,
        "unrecognized_cells": unrecognized_cells,
        "clean_image": str(clean_path),
        "overrides": str(output_overrides),
    }
    report_path = output_dir / "embedded-ocr-report.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        f"检测 {len(cells)} 个文字单元格，识别 {recognized_cells} 个；"
        f"另识别 {outside_count} 个自由文字区域。"
    )
    print(f"已写入 {output_overrides}")
    print(f"报告：{report_path}")


if __name__ == "__main__":
    main()
