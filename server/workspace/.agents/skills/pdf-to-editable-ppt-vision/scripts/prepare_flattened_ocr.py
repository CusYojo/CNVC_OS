#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import io
import json
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

from text_grouping import group_text_elements
from typography import load_typography_profile, normalize_deck_typography


SCRIPT_DIR = Path(__file__).resolve().parent


class ChineseArgumentParser(argparse.ArgumentParser):
    def format_help(self):
        return (
            super()
            .format_help()
            .replace("usage:", "用法：")
            .replace("optional arguments:", "可选参数：")
            .replace("options:", "选项：")
            .replace("show this help message and exit", "显示此帮助信息并退出")
        )


def load_cv2():
    try:
        import cv2
    except ImportError as exc:
        raise RuntimeError(
            "扁平化 OCR 模式需要 opencv-python-headless。"
            "请先在当前 Python 环境中安装，再重试。"
        ) from exc
    return cv2


def run(command):
    print("+", " ".join(str(part) for part in command), flush=True)
    subprocess.run([str(part) for part in command], check=True)


def run_capture(command):
    print("+", " ".join(str(part) for part in command), flush=True)
    result = subprocess.run(
        [str(part) for part in command],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(
            f"OCR 命令执行失败（退出码 {result.returncode}）：{detail}"
        )
    return result.stdout


def ordered_slide_images(render_dir):
    images = list(render_dir.glob("slide-*.png"))
    return sorted(images, key=lambda item: int(re.search(r"(\d+)$", item.stem).group(1)))


def point_in_region(x, y, region):
    return (
        region["x"] <= x <= region["x"] + region["width"]
        and region["y"] <= y <= region["y"] + region["height"]
    )


def load_rules(path):
    if not path:
        return {
            "replacements": {},
            "exclude_regions": {},
            "exclude_texts": {},
        }
    data = json.loads(path.read_text(encoding="utf-8"))
    return {
        "replacements": data.get("replacements", {}),
        "exclude_regions": data.get("exclude_regions", {}),
        "exclude_texts": data.get("exclude_texts", {}),
    }


def correct_text(text, replacements):
    value = text.strip()
    for before, after in replacements.items():
        value = value.replace(before, after)
    return value


def useful_row(row, minimum_confidence):
    text = row.get("text", "").strip()
    if not text:
        return False
    confidence = float(row.get("confidence") or 0)
    if confidence < minimum_confidence:
        return False
    if confidence < 0.45 and len(text) <= 2 and text not in {"AI", "OS"}:
        return False
    return True


def rgb_hex(values):
    r, g, b = [int(v) for v in values]
    if max(r, g, b) > 205:
        return "#17345E"
    return f"#{r:02X}{g:02X}{b:02X}"


def grouping_color_bucket(value):
    match = re.fullmatch(r"#?([0-9A-Fa-f]{6})", str(value or ""))
    if not match:
        return "#404040"
    color = match.group(1)
    r, g, b = (int(color[index:index + 2], 16) for index in (0, 2, 4))
    luminance = (r * 299 + g * 587 + b * 114) / 1000
    spread = max(r, g, b) - min(r, g, b)
    if spread <= 35:
        if luminance < 105:
            return "#404040"
        if luminance < 180:
            return "#808080"
        return "#D0D0D0"
    dominant = max(range(3), key=lambda index: (r, g, b)[index])
    return ("#804040", "#408040", "#4060A0")[dominant]


def group_ocr_text_items(
    text_items,
    mode,
    line_break_mode,
    page_number,
    order_mode="spatial",
):
    elements = []
    vertical_items = []
    for index, item in enumerate(text_items):
        if item.get("vertical"):
            vertical_items.append((index, item))
            continue
        left = float(item["left"])
        top = float(item["top"])
        width = float(item["width"])
        height = float(item["height"])
        original_run = {
            "text": str(item.get("text") or ""),
            "font": item.get("font"),
            "bold": bool(item.get("bold")),
            "italic": False,
            "font_size": float(item.get("font_size") or 10),
            "font_size_pt": float(
                item.get("font_size_pt")
                or item.get("font_size")
                or 10
            ),
            "style_id": item.get("style_id"),
            "color": item.get("color"),
            "opacity": 1.0,
            "direction": [1.0, 0.0],
        }
        elements.append(
            {
                "kind": "text",
                "seqno": index,
                "bbox": [left, top, left + width, top + height],
                "origin": [left, top + height * 0.82],
                "text": str(item.get("text") or ""),
                "font": item.get("font"),
                "bold": bool(item.get("bold")),
                "italic": False,
                # OCR 对同一段落的相邻行常会给出轻微不同的字号和颜色。
                # 聚类时使用稳定桶，渲染仍保留 runs 中的原始样式。
                "font_size": round(float(item.get("font_size") or 10) / 2) * 2,
                "font_size_pt": float(
                    item.get("font_size_pt")
                    or item.get("font_size")
                    or 10
                ),
                "color": grouping_color_bucket(item.get("color")),
                "opacity": 1.0,
                "direction": [1.0, 0.0],
                "confidence": float(item.get("confidence") or 0),
                "style_id": item.get("style_id"),
                "font_role": item.get("font_role"),
                "typography_calibrated": bool(
                    item.get("typography_calibrated")
                ),
                "runs": [original_run],
            }
        )

    grouped, report = group_text_elements(
        elements,
        mode=mode,
        line_break_mode=line_break_mode,
        page_number=page_number,
        order_mode=order_mode,
    )
    result = []
    for element in grouped:
        bbox = element["bbox"]
        source_lines = element.get("source_lines") or []
        runs = element.get("runs") or []
        first_run = runs[0] if runs else {}
        confidence_values = [
            float(line.get("confidence") or element.get("confidence") or 0)
            for line in source_lines
        ]
        result.append(
            {
                "text": str(element.get("text") or ""),
                "confidence": (
                    sum(confidence_values) / len(confidence_values)
                    if confidence_values
                    else float(element.get("confidence") or 0)
                ),
                "left": float(bbox[0]),
                "top": float(bbox[1]),
                "width": max(10.0, float(bbox[2]) - float(bbox[0])),
                "height": max(10.0, float(bbox[3]) - float(bbox[1])),
                "font_size": float(
                    first_run.get("font_size_pt")
                    or first_run.get("font_size")
                    or element.get("font_size")
                    or 10
                ),
                "font_size_pt": float(
                    first_run.get("font_size_pt")
                    or first_run.get("font_size")
                    or element.get("font_size")
                    or 10
                ),
                "color": first_run.get("color") or element.get("color"),
                "bold": bool(
                    first_run.get("bold", element.get("bold"))
                ),
                "font": first_run.get("font") or element.get("font"),
                "style_id": (
                    first_run.get("style_id")
                    or element.get("style_id")
                ),
                "font_role": element.get("font_role"),
                "typography_calibrated": bool(
                    element.get("typography_calibrated")
                    or first_run.get("font_size_pt")
                ),
                "vertical": False,
                "runs": runs,
                "source_lines": source_lines,
                "source_line_count": int(
                    element.get("source_line_count") or 1
                ),
                "line_breaks": element.get("line_breaks") or [],
                "text_grouping": element.get("text_grouping") or "line",
                "seqno": int(element.get("seqno") or 0),
            }
        )
    for index, item in vertical_items:
        result.append({**item, "seqno": index})
    result.sort(key=lambda item: int(item.get("seqno") or 0))
    return result, report


def compile_vision_ocr(binary_path):
    if sys.platform != "darwin":
        raise RuntimeError("Apple Vision OCR 只能在 macOS 上运行")
    swiftc = shutil.which("swiftc") or Path("/usr/bin/swiftc")
    if not Path(swiftc).exists():
        raise FileNotFoundError(
            "在 macOS 上使用 Apple Vision OCR 需要 swiftc。"
            "也可改用 Tesseract 或通过 --ocr-json-dir 提供 OCR JSON。"
        )
    run([swiftc, SCRIPT_DIR / "vision_ocr.swift", "-o", binary_path])


def has_swiftc():
    candidate = shutil.which("swiftc") or Path("/usr/bin/swiftc")
    return Path(candidate).exists()


def normalize_language_list(languages):
    return [item.strip() for item in languages.split(",") if item.strip()]


def tesseract_language_string(languages):
    aliases = {
        "zh-hans": "chi_sim",
        "zh-cn": "chi_sim",
        "zh-sg": "chi_sim",
        "zh-hant": "chi_tra",
        "zh-tw": "chi_tra",
        "zh-hk": "chi_tra",
        "en": "eng",
        "en-us": "eng",
        "en-gb": "eng",
        "ja": "jpn",
        "ja-jp": "jpn",
        "ko": "kor",
        "ko-kr": "kor",
    }
    values = []
    for language in normalize_language_list(languages):
        value = aliases.get(language.lower(), language)
        if value not in values:
            values.append(value)
    return "+".join(values or ["chi_sim", "eng"])


def ensure_tesseract_languages(executable, language_string):
    result = subprocess.run(
        [str(executable), "--list-langs"],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    if result.returncode:
        raise RuntimeError(
            "无法读取 Tesseract 语言列表："
            + ((result.stderr or result.stdout).strip() or "未知错误")
        )
    available = set(result.stdout.split())
    required = set(language_string.split("+"))
    missing = sorted(required - available)
    if missing:
        raise RuntimeError(
            "Tesseract 缺少 OCR 语言包：" + "、".join(missing)
        )


def join_ocr_words(words):
    if not words:
        return ""
    cjk = re.compile(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]")
    result = words[0]
    for word in words[1:]:
        separator = "" if cjk.search(result[-1:]) and cjk.search(word[:1]) else " "
        result += separator + word
    return result


def parse_tesseract_tsv(tsv_text, image_width, image_height):
    grouped = {}
    reader = csv.DictReader(io.StringIO(tsv_text), delimiter="\t")
    for row in reader:
        text = (row.get("text") or "").strip()
        if not text or row.get("level") != "5":
            continue
        try:
            confidence = max(0.0, float(row.get("conf") or 0)) / 100.0
            left = int(row["left"])
            top = int(row["top"])
            width = int(row["width"])
            height = int(row["height"])
        except (KeyError, TypeError, ValueError):
            continue
        if width <= 0 or height <= 0:
            continue
        key = (
            row.get("page_num"),
            row.get("block_num"),
            row.get("par_num"),
            row.get("line_num"),
        )
        group = grouped.setdefault(
            key,
            {
                "words": [],
                "confidence": [],
                "left": left,
                "top": top,
                "right": left + width,
                "bottom": top + height,
            },
        )
        group["words"].append(text)
        group["confidence"].append(confidence)
        group["left"] = min(group["left"], left)
        group["top"] = min(group["top"], top)
        group["right"] = max(group["right"], left + width)
        group["bottom"] = max(group["bottom"], top + height)

    rows = []
    for group in grouped.values():
        left = group["left"]
        top = group["top"]
        width = group["right"] - left
        height = group["bottom"] - top
        rows.append(
            {
                "text": join_ocr_words(group["words"]),
                "confidence": sum(group["confidence"]) / len(group["confidence"]),
                "x": left / image_width,
                "y": 1 - (top + height) / image_height,
                "width": width / image_width,
                "height": height / image_height,
            }
        )
    rows.sort(key=lambda row: (1 - row["y"] - row["height"], row["x"]))
    return rows


def row_pixel_rect(row, image_width, image_height):
    x0 = float(row["x"]) * image_width
    y0 = (
        1 - float(row["y"]) - float(row["height"])
    ) * image_height
    x1 = (float(row["x"]) + float(row["width"])) * image_width
    y1 = (1 - float(row["y"])) * image_height
    return x0, y0, x1, y1


def map_ccw_row_to_original(row, image_width, image_height):
    rotated_width = image_height
    rotated_height = image_width
    rx0, ry0, rx1, ry1 = row_pixel_rect(
        row, rotated_width, rotated_height
    )
    x0 = image_width - ry1
    x1 = image_width - ry0
    y0 = rx0
    y1 = rx1
    mapped = dict(row)
    mapped.update(
        {
            "x": max(0.0, x0 / image_width),
            "y": max(0.0, 1 - y1 / image_height),
            "width": max(0.0, (x1 - x0) / image_width),
            "height": max(0.0, (y1 - y0) / image_height),
            "orientation": "vertical",
        }
    )
    return mapped


def intersection_over_union(a, b, image_width, image_height):
    ax0, ay0, ax1, ay1 = row_pixel_rect(a, image_width, image_height)
    bx0, by0, bx1, by1 = row_pixel_rect(b, image_width, image_height)
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    intersection = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    if not intersection:
        return 0.0
    union = (
        max(0.0, ax1 - ax0) * max(0.0, ay1 - ay0)
        + max(0.0, bx1 - bx0) * max(0.0, by1 - by0)
        - intersection
    )
    return intersection / max(1.0, union)


def deduplicate_ocr_rows(rows, image_width, image_height):
    result = []
    for row in rows:
        normalized = re.sub(r"\s+", "", str(row.get("text") or ""))
        duplicate_index = next(
            (
                index
                for index, existing in enumerate(result)
                if normalized
                and normalized
                == re.sub(r"\s+", "", str(existing.get("text") or ""))
                and intersection_over_union(
                    row, existing, image_width, image_height
                )
                >= 0.45
            ),
            None,
        )
        if duplicate_index is None:
            result.append(dict(row))
            continue
        existing = result[duplicate_index]
        x0, y0, x1, y1 = row_pixel_rect(
            existing, image_width, image_height
        )
        rx0, ry0, rx1, ry1 = row_pixel_rect(
            row, image_width, image_height
        )
        x0, y0 = min(x0, rx0), min(y0, ry0)
        x1, y1 = max(x1, rx1), max(y1, ry1)
        existing.update(
            {
                "x": x0 / image_width,
                "y": 1 - y1 / image_height,
                "width": (x1 - x0) / image_width,
                "height": (y1 - y0) / image_height,
                "confidence": max(
                    float(existing.get("confidence") or 0),
                    float(row.get("confidence") or 0),
                ),
            }
        )
    return result


def merge_vertical_ocr_rows(
    original_rows,
    rotated_rows,
    image_width,
    image_height,
):
    merged = [dict(row, orientation=row.get("orientation", "horizontal")) for row in original_rows]
    for rotated_row in rotated_rows:
        candidate = map_ccw_row_to_original(
            rotated_row, image_width, image_height
        )
        pixel_width = float(candidate["width"]) * image_width
        pixel_height = float(candidate["height"]) * image_height
        if pixel_height < max(18.0, pixel_width * 1.25):
            continue
        overlaps = [
            (index, intersection_over_union(
                existing, candidate, image_width, image_height
            ))
            for index, existing in enumerate(merged)
        ]
        overlaps = [item for item in overlaps if item[1] >= 0.18]
        if not overlaps:
            merged.append(candidate)
            continue
        best_index, _ = max(overlaps, key=lambda item: item[1])
        existing = merged[best_index]
        existing_score = (
            float(existing.get("confidence") or 0)
            + min(30, len(str(existing.get("text") or ""))) * 0.01
        )
        candidate_score = (
            float(candidate.get("confidence") or 0)
            + min(30, len(str(candidate.get("text") or ""))) * 0.01
            + 0.08
        )
        if candidate_score >= existing_score:
            merged[best_index] = candidate
    merged.sort(
        key=lambda row: (
            1 - float(row["y"]) - float(row["height"]),
            float(row["x"]),
        )
    )
    return merged


def write_ccw_image(image_path, output_path):
    from PIL import Image

    with Image.open(image_path) as image:
        image.transpose(Image.Transpose.ROTATE_90).save(output_path)
        return image.size


def resolve_ocr_engine(requested, supplied_ocr_dir, tesseract):
    if supplied_ocr_dir:
        if requested not in {"auto", "json"}:
            raise ValueError("--ocr-json-dir 与显式 OCR 引擎冲突")
        return "json", None
    if requested == "json":
        raise ValueError("使用 json OCR 引擎时必须提供 --ocr-json-dir")
    if requested == "apple-vision":
        if sys.platform != "darwin" or not has_swiftc():
            raise RuntimeError("Apple Vision OCR 需要 macOS 和 swiftc")
        return requested, None
    tesseract_executable = tesseract or shutil.which("tesseract")
    if requested == "tesseract":
        if not tesseract_executable:
            raise FileNotFoundError(
                "未找到 Tesseract；请安装后加入 PATH，或通过 --tesseract 指定"
            )
        return requested, tesseract_executable
    if requested != "auto":
        raise ValueError(f"不支持的 OCR 引擎：{requested}")
    if sys.platform == "darwin" and has_swiftc():
        return "apple-vision", None
    if tesseract_executable:
        return "tesseract", tesseract_executable
    raise RuntimeError(
        "未找到可用 OCR 后端。macOS 可安装 Xcode Command Line Tools；"
        "Windows/Linux 可安装 Tesseract；也可通过 --ocr-json-dir 提供 OCR JSON。"
    )


def resolve_ocr_fonts(body_font, title_font):
    defaults = {
        "Darwin": ("Microsoft YaHei", "Songti SC"),
        "Windows": ("Microsoft YaHei", "Microsoft YaHei"),
        "Linux": ("Noto Sans CJK SC", "Noto Serif CJK SC"),
    }
    default_body, default_title = defaults.get(
        platform.system(), ("Microsoft YaHei", "Microsoft YaHei")
    )
    return (
        default_body if body_font == "auto" else body_font,
        default_title if title_font == "auto" else title_font,
    )


def create_ocr_json(
    images,
    ocr_dir,
    languages,
    engine,
    tesseract=None,
    tesseract_psm=11,
    supplied_ocr_dir=None,
    detect_vertical_text=False,
):
    ocr_dir.mkdir(parents=True, exist_ok=True)
    if engine == "json":
        for image_path in images:
            source = supplied_ocr_dir / f"{image_path.stem}.json"
            if not source.exists():
                raise FileNotFoundError(source)
            output = ocr_dir / source.name
            shutil.copy2(source, output)
            rotated_source = supplied_ocr_dir / f"{image_path.stem}-ccw.json"
            if detect_vertical_text and rotated_source.exists():
                from PIL import Image

                with Image.open(image_path) as image:
                    width, height = image.size
                original_rows = json.loads(output.read_text(encoding="utf-8"))
                rotated_rows = json.loads(
                    rotated_source.read_text(encoding="utf-8")
                )
                output.write_text(
                    json.dumps(
                        merge_vertical_ocr_rows(
                            original_rows,
                            rotated_rows,
                            width,
                            height,
                        ),
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )
        return

    if engine == "apple-vision":
        binary = ocr_dir / "vision-ocr"
        compile_vision_ocr(binary)
        for image_path in images:
            output = ocr_dir / f"{image_path.stem}.json"
            run([binary, image_path, output, languages])
            if detect_vertical_text:
                rotated_image = ocr_dir / f"{image_path.stem}-ccw.png"
                rotated_output = ocr_dir / f"{image_path.stem}-ccw.json"
                width, height = write_ccw_image(image_path, rotated_image)
                run([binary, rotated_image, rotated_output, languages])
                original_rows = json.loads(
                    output.read_text(encoding="utf-8")
                )
                rotated_rows = json.loads(
                    rotated_output.read_text(encoding="utf-8")
                )
                output.write_text(
                    json.dumps(
                        merge_vertical_ocr_rows(
                            original_rows,
                            rotated_rows,
                            width,
                            height,
                        ),
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )
        return

    if engine == "tesseract":
        from PIL import Image

        language_string = tesseract_language_string(languages)
        for image_path in images:
            with Image.open(image_path) as image:
                width, height = image.size
            tsv = run_capture(
                [
                    tesseract,
                    image_path,
                    "stdout",
                    "-l",
                    language_string,
                    "--psm",
                    str(tesseract_psm),
                    "tsv",
                ]
            )
            rows = parse_tesseract_tsv(tsv, width, height)
            if detect_vertical_text:
                rotated_image = ocr_dir / f"{image_path.stem}-ccw.png"
                write_ccw_image(image_path, rotated_image)
                with Image.open(rotated_image) as rotated:
                    rotated_width, rotated_height = rotated.size
                rotated_tsv = run_capture(
                    [
                        tesseract,
                        rotated_image,
                        "stdout",
                        "-l",
                        language_string,
                        "--psm",
                        str(tesseract_psm),
                        "tsv",
                    ]
                )
                rotated_rows = parse_tesseract_tsv(
                    rotated_tsv, rotated_width, rotated_height
                )
                rows = merge_vertical_ocr_rows(
                    rows, rotated_rows, width, height
                )
            output = ocr_dir / f"{image_path.stem}.json"
            output.write_text(
                json.dumps(rows, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        return

    raise ValueError(f"不支持的 OCR 引擎：{engine}")


def main():
    parser = ChineseArgumentParser(
        description="识别扁平化幻灯片渲染图中的文字，将其从背景移除并生成可编辑文字模型。"
    )
    parser.add_argument(
        "--source-render-dir", required=True, type=Path, help="源页面渲染图目录"
    )
    parser.add_argument(
        "--output-dir", required=True, type=Path, help="OCR 中间结果输出目录"
    )
    parser.add_argument(
        "--output-model", required=True, type=Path, help="可编辑文字模型输出路径"
    )
    parser.add_argument("--source-pdf", required=True, type=Path, help="源 PDF 文件")
    parser.add_argument(
        "--ocr-json-dir", type=Path, help="预先生成的 OCR JSON 文件目录"
    )
    parser.add_argument(
        "--ocr-engine",
        choices=("auto", "apple-vision", "tesseract", "json"),
        default="auto",
        help="OCR 后端；auto 在 macOS 优先 Apple Vision，在其他系统使用 Tesseract。",
    )
    parser.add_argument("--tesseract", help="Tesseract 可执行文件路径")
    parser.add_argument(
        "--tesseract-psm",
        type=int,
        default=11,
        help="Tesseract 页面分割模式，默认值：11。",
    )
    parser.add_argument(
        "--corrections", type=Path, help="文字修正和排除区域 JSON 文件"
    )
    parser.add_argument(
        "--languages", default="zh-Hans,en-US", help="OCR 语言列表，使用逗号分隔"
    )
    parser.add_argument(
        "--minimum-confidence", type=float, default=0.45, help="最低 OCR 置信度"
    )
    parser.add_argument(
        "--detect-vertical-text",
        action="store_true",
        help="额外旋转页面识别竖排文字，并映射回原始坐标。",
    )
    parser.add_argument(
        "--slide-width", type=float, default=1280, help="输出幻灯片宽度（像素）"
    )
    parser.add_argument(
        "--body-font",
        default="auto",
        help="OCR 正文字体；auto 会根据当前系统选择。",
    )
    parser.add_argument(
        "--title-font",
        default="auto",
        help="OCR 标题字体；auto 会根据当前系统选择。",
    )
    parser.add_argument(
        "--text-grouping",
        choices=("line", "hybrid", "paragraph"),
        default="hybrid",
        help="OCR 文字框粒度：line 逐行；hybrid 保守段落聚类（默认）；paragraph 扩大段落聚类。",
    )
    parser.add_argument(
        "--line-break-mode",
        choices=("preserve", "smart", "reflow"),
        default="preserve",
        help="合并段落内部的换行策略：preserve 保留模板换行（默认）；smart 识别软换行；reflow 尽量重排。",
    )
    parser.add_argument(
        "--text-grouping-report",
        type=Path,
        help="可选的 OCR 段落聚类报告输出路径。",
    )
    parser.add_argument(
        "--paragraph-order",
        choices=("source", "spatial"),
        default="spatial",
        help="段落阅读顺序；spatial 先按局部空间链聚类，避免双栏 OCR 顺序打断段落。",
    )
    parser.add_argument(
        "--typography-profile",
        type=Path,
        help="字体、字号角色和候选字号表 JSON；扁平化 PDF 要求精确字体时应显式提供。",
    )
    parser.add_argument(
        "--font-size-mode",
        choices=("raw", "normalized", "strict"),
        default="normalized",
        help="字号策略；normalized/strict 会将相同样式归一到同一字号，禁止逐 OCR 行漂移。",
    )
    parser.add_argument(
        "--typography-report",
        type=Path,
        help="可选的字体与字号归一化报告输出路径。",
    )
    args = parser.parse_args()

    import numpy as np

    cv2 = load_cv2()
    source_render_dir = args.source_render_dir.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()
    output_model = args.output_model.expanduser().resolve()
    source_pdf = args.source_pdf.expanduser().resolve()
    supplied_ocr_dir = (
        args.ocr_json_dir.expanduser().resolve() if args.ocr_json_dir else None
    )
    engine, tesseract = resolve_ocr_engine(
        args.ocr_engine, supplied_ocr_dir, args.tesseract
    )
    if engine == "tesseract":
        ensure_tesseract_languages(
            tesseract,
            tesseract_language_string(args.languages),
        )
    body_font, title_font = resolve_ocr_fonts(args.body_font, args.title_font)
    typography_profile = load_typography_profile(
        args.typography_profile.expanduser().resolve()
        if args.typography_profile
        else None
    )
    typography_profile.setdefault("fonts", {})
    typography_profile["fonts"].setdefault("body", body_font)
    typography_profile["fonts"].setdefault("title", title_font)
    print(
        f"OCR 后端：{engine}；正文字体：{body_font}；标题字体：{title_font}"
    )
    rules = load_rules(
        args.corrections.expanduser().resolve() if args.corrections else None
    )
    images = ordered_slide_images(source_render_dir)
    if not images:
        raise RuntimeError("未找到 slide-*.png 格式的源页面渲染图")

    clean_dir = output_dir / "clean-backgrounds"
    ocr_dir = output_dir / "ocr"
    clean_dir.mkdir(parents=True, exist_ok=True)
    create_ocr_json(
        images,
        ocr_dir,
        args.languages,
        engine,
        tesseract=tesseract,
        tesseract_psm=args.tesseract_psm,
        supplied_ocr_dir=supplied_ocr_dir,
        detect_vertical_text=args.detect_vertical_text,
    )

    pages = []
    grouping_reports = []
    for page_number, image_path in enumerate(images, 1):
        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f"无法读取 {image_path}")
        height, width = image.shape[:2]
        slide_width = float(args.slide_width)
        slide_height = slide_width * height / width
        rows = json.loads((ocr_dir / f"{image_path.stem}.json").read_text())
        rows = deduplicate_ocr_rows(rows, width, height)
        mask = np.zeros((height, width), dtype=np.uint8)
        text_items = []
        exclusions = rules["exclude_regions"].get(str(page_number), [])
        excluded_texts = set(
            rules["exclude_texts"].get(str(page_number), [])
        )

        for row in rows:
            if not useful_row(row, args.minimum_confidence):
                continue
            top_norm = 1 - float(row["y"]) - float(row["height"])
            center_x = float(row["x"]) + float(row["width"]) / 2
            center_y = top_norm + float(row["height"]) / 2
            if any(point_in_region(center_x, center_y, region) for region in exclusions):
                continue

            text = correct_text(row["text"], rules["replacements"])
            if text in excluded_texts:
                continue
            x0 = max(0, int(round(float(row["x"]) * width)))
            y0 = max(0, int(round(top_norm * height)))
            x1 = min(width, int(round((float(row["x"]) + float(row["width"])) * width)))
            y1 = min(height, int(round((1 - float(row["y"])) * height)))
            if x1 <= x0 or y1 <= y0:
                continue

            pad_x = max(2, int((x1 - x0) * 0.015))
            pad_y = max(2, int((y1 - y0) * 0.08))
            ax0, ay0 = max(0, x0 - pad_x), max(0, y0 - pad_y)
            ax1, ay1 = min(width, x1 + pad_x), min(height, y1 + pad_y)
            crop = image[ay0:ay1, ax0:ax1]
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
            _, glyph_mask = cv2.threshold(
                gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
            )
            pixels = crop[glyph_mask > 0]
            if pixels.size:
                bgr = np.median(pixels, axis=0)
                color = rgb_hex([bgr[2], bgr[1], bgr[0]])
            else:
                color = "#172033"
            mask[ay0:ay1, ax0:ax1] = 255

            left = float(row["x"]) * slide_width
            top = top_norm * slide_height
            item_width = float(row["width"]) * slide_width
            item_height = float(row["height"]) * slide_height
            vertical = row.get("orientation") == "vertical"
            if vertical:
                text = "\n".join(char for char in text if not char.isspace())
            font_basis = item_width if vertical else item_height
            # 96 px/in 坐标下，OCR 行高不能直接当作 PowerPoint point。
            # 先生成保守估计，再由 deck 级 typography 校准统一相同样式。
            font_size = max(7.0, min(72, font_basis * 0.74))
            is_title = top < slide_height * 0.14 and font_size >= 24
            text_items.append(
                {
                    "text": text,
                    "confidence": float(row["confidence"]),
                    "left": left,
                    "top": top,
                    "width": max(10, item_width),
                    "height": max(10, item_height),
                    "font_size": font_size,
                    "raw_font_size": font_size,
                    "color": color,
                    "bold": bool(is_title or (font_size >= 18 and len(text) <= 18)),
                    "font": title_font if is_title else body_font,
                    "vertical": vertical,
                }
            )

        cleaned = cv2.inpaint(image, mask, 5, cv2.INPAINT_TELEA)
        clean_path = clean_dir / f"{image_path.stem}-clean.png"
        cv2.imwrite(str(clean_path), cleaned)
        pages.append(
            {
                "number": page_number,
                "width": slide_width,
                "height": slide_height,
                "background": str(clean_path),
                "source_image": str(image_path),
                "text": text_items,
            }
        )
        print(
            f"{image_path.stem}：提取 {len(text_items)} 行 OCR，等待 deck 级字号校准与段落聚类"
        )

    typography_report = normalize_deck_typography(
        pages,
        profile=typography_profile,
        mode=args.font_size_mode,
    )
    if not typography_report.get("passed"):
        raise RuntimeError("字体与字号归一化失败")
    for page in pages:
        grouped_items, grouping_report = group_ocr_text_items(
            page["text"],
            args.text_grouping,
            args.line_break_mode,
            page["number"],
            order_mode=args.paragraph_order,
        )
        page["text"] = grouped_items
        grouping_reports.append(grouping_report)
        print(
            f"slide-{page['number']:02d}："
            f"{grouping_report['inputTextObjectCount']} 行 OCR 聚合为 "
            f"{len(grouped_items)} 个可编辑文字对象；"
            f"{grouping_report['groupedParagraphCount']} 个多行段落"
        )

    output_model.parent.mkdir(parents=True, exist_ok=True)
    output_model.write_text(
        json.dumps(
            {
                "source": str(source_pdf),
                "page_width": pages[0]["width"],
                "page_height": pages[0]["height"],
                "pages": pages,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    if args.text_grouping_report:
        report_path = args.text_grouping_report.expanduser().resolve()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(
                {
                    "schemaVersion": "1.0",
                    "passed": all(
                        report.get("contentPreserved")
                        for report in grouping_reports
                    ),
                    "mode": args.text_grouping,
                    "lineBreakMode": args.line_break_mode,
                    "paragraphOrder": args.paragraph_order,
                    "inputTextObjectCount": sum(
                        report["inputTextObjectCount"]
                        for report in grouping_reports
                    ),
                    "outputTextObjectCount": sum(
                        report["outputTextObjectCount"]
                        for report in grouping_reports
                    ),
                    "textObjectReduction": sum(
                        report["textObjectReduction"]
                        for report in grouping_reports
                    ),
                    "groupedParagraphCount": sum(
                        report["groupedParagraphCount"]
                        for report in grouping_reports
                    ),
                    "groupedSourceLineCount": sum(
                        report["groupedSourceLineCount"]
                        for report in grouping_reports
                    ),
                    "paragraphCandidateCount": sum(
                        report.get("paragraphCandidateCount", 0)
                        for report in grouping_reports
                    ),
                    "unmergedParagraphCandidateCount": sum(
                        report.get("unmergedParagraphCandidateCount", 0)
                        for report in grouping_reports
                    ),
                    "pages": grouping_reports,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    if args.typography_report:
        typography_report_path = (
            args.typography_report.expanduser().resolve()
        )
        typography_report_path.parent.mkdir(parents=True, exist_ok=True)
        typography_report_path.write_text(
            json.dumps(
                typography_report,
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    print(f"已写入 {output_model}")


if __name__ == "__main__":
    main()
