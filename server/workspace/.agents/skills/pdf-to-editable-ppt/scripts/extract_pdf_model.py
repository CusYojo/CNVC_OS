from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from io import BytesIO
import json
import math
import re
from pathlib import Path

import fitz
from PIL import Image


INPUT_PDF = None
BUILD_DIR = None
ASSET_DIR = None
OUTPUT_JSON = None
SOURCE_RENDER_DIR = None
PDF_TO_SLIDE_SCALE = 4 / 3
WATERMARK_MODE = "auto"
WATERMARK_OPACITY_THRESHOLD = 0.45
CUSTOM_WATERMARK_TERMS = []
WATERMARK_REPORT = None

COMMON_WATERMARK_TERMS = (
    "保密资料",
    "内部资料",
    "仅供参考",
    "仅供投资人参考",
    "仅供基金投资人参考",
    "请勿外传",
    "未经授权",
    "机密",
    "样稿",
    "水印",
    "confidential",
    "draft",
    "watermark",
)


def point(value):
    return [round(float(value.x), 5), round(float(value.y), 5)]


def rect(value):
    return [round(float(x), 5) for x in value]


def color(value):
    if value is None:
        return None
    channels = [max(0, min(255, round(float(v) * 255))) for v in value[:3]]
    return "#" + "".join(f"{v:02X}" for v in channels)


def normalize_watermark_text(value):
    return re.sub(r"[\W_]+", "", str(value or "").lower(), flags=re.UNICODE)


def text_from_span(span):
    return (
        "".join(chr(char[0]) for char in span.get("chars") or ())
        .replace("\x00", "")
        .replace("\ufffd", "")
        .strip()
    )


def span_angle(span):
    direction = span.get("dir", (1.0, 0.0))
    return math.degrees(
        math.atan2(float(direction[1]), float(direction[0]))
    )


def watermark_features(
    span,
    page_rect,
    page_repeat_count,
    page_count,
    terms,
    explicit_terms,
):
    text = text_from_span(span)
    normalized = normalize_watermark_text(text)
    bbox = span.get("bbox") or (0, 0, 0, 0)
    width = max(0.0, float(bbox[2]) - float(bbox[0]))
    height = max(0.0, float(bbox[3]) - float(bbox[1]))
    page_width = max(1.0, float(page_rect.width))
    page_height = max(1.0, float(page_rect.height))
    raw_opacity = span.get("opacity")
    opacity = float(1.0 if raw_opacity is None else raw_opacity)
    angle = span_angle(span)
    area_ratio = (width * height) / (page_width * page_height)
    page_ratio = page_repeat_count / max(1, page_count)
    known_term = any(term and term in normalized for term in terms)
    explicit_term = any(term and term in normalized for term in explicit_terms)
    repeated = page_repeat_count >= max(2, math.ceil(page_count * 0.5))
    rotated = 8.0 <= abs(angle) <= 172.0
    large_font = float(span.get("size") or 0.0) >= max(30.0, page_height * 0.07)
    large_bbox = (
        area_ratio >= 0.08
        or width >= page_width * 0.45
        or height >= page_height * 0.35
    )
    low_opacity = opacity <= WATERMARK_OPACITY_THRESHOLD
    very_low_opacity = opacity <= min(0.25, WATERMARK_OPACITY_THRESHOLD)
    return {
        "text": text,
        "normalized": normalized,
        "opacity": opacity,
        "angle": angle,
        "bbox": [round(float(value), 5) for value in bbox],
        "area_ratio": area_ratio,
        "page_repeat_count": page_repeat_count,
        "page_ratio": page_ratio,
        "known_term": known_term,
        "explicit_term": explicit_term,
        "repeated": repeated,
        "rotated": rotated,
        "large_font": large_font,
        "large_bbox": large_bbox,
        "low_opacity": low_opacity,
        "very_low_opacity": very_low_opacity,
    }


def classify_watermark(features, mode):
    if mode == "keep" or not features["normalized"]:
        return False, []
    reasons = []
    visual_signal = (
        features["low_opacity"]
        or features["rotated"]
        or features["large_font"]
        or features["large_bbox"]
    )
    if features["explicit_term"]:
        reasons.append("user-specified-watermark-text")
    elif features["known_term"]:
        reasons.append("common-watermark-term")
    if features["repeated"]:
        reasons.append("repeated-across-pages")
    if features["low_opacity"]:
        reasons.append("low-opacity")
    if features["rotated"]:
        reasons.append("rotated")
    if features["large_font"] or features["large_bbox"]:
        reasons.append("large-overlay")

    if features["explicit_term"]:
        remove = True
    elif mode == "aggressive":
        remove = (
            features["known_term"]
            or (features["repeated"] and visual_signal)
            or (
                features["very_low_opacity"]
                and (features["rotated"] or features["large_bbox"])
            )
        )
    else:
        remove = (
            (features["known_term"] and visual_signal)
            or (
                features["repeated"]
                and (
                    features["low_opacity"]
                    or features["rotated"]
                    or (
                        features["large_bbox"]
                        and features["opacity"] <= 0.7
                    )
                )
            )
        )
    return remove, reasons


def scan_watermarks(doc, mode, custom_terms):
    page_occurrences = Counter()
    traces = []
    for page_index, page in enumerate(doc):
        page_seen = set()
        page_traces = list(page.get_texttrace())
        traces.append(page_traces)
        for span in page_traces:
            normalized = normalize_watermark_text(text_from_span(span))
            if normalized:
                page_seen.add(normalized)
        page_occurrences.update(page_seen)

    explicit_terms = tuple(
        normalize_watermark_text(term)
        for term in custom_terms
        if normalize_watermark_text(term)
    )
    terms = tuple(
        normalize_watermark_text(term)
        for term in (*COMMON_WATERMARK_TERMS, *custom_terms)
        if normalize_watermark_text(term)
    )
    removed = defaultdict(
        lambda: {
            "text": "",
            "pages": set(),
            "span_count": 0,
            "reasons": set(),
            "sample_opacity": None,
            "sample_angle": None,
            "sample_bbox": None,
        }
    )
    removed_keys = set()
    page_count = len(doc)
    for page_index, (page, page_traces) in enumerate(zip(doc, traces), 1):
        for span_index, span in enumerate(page_traces):
            normalized = normalize_watermark_text(text_from_span(span))
            features = watermark_features(
                span,
                page.rect,
                page_occurrences.get(normalized, 0),
                page_count,
                terms,
                explicit_terms,
            )
            is_watermark, reasons = classify_watermark(features, mode)
            if not is_watermark:
                continue
            removed_keys.add((page_index, span_index))
            entry = removed[normalized]
            entry["text"] = features["text"]
            entry["pages"].add(page_index)
            entry["span_count"] += 1
            entry["reasons"].update(reasons)
            entry["sample_opacity"] = round(features["opacity"], 4)
            entry["sample_angle"] = round(features["angle"], 2)
            entry["sample_bbox"] = features["bbox"]

    entries = []
    for normalized, entry in sorted(
        removed.items(), key=lambda item: (-item[1]["span_count"], item[0])
    ):
        entries.append(
            {
                "text": entry["text"],
                "normalized": normalized,
                "pages": sorted(entry["pages"]),
                "page_count": len(entry["pages"]),
                "span_count": entry["span_count"],
                "reasons": sorted(entry["reasons"]),
                "sample_opacity": entry["sample_opacity"],
                "sample_angle": entry["sample_angle"],
                "sample_bbox": entry["sample_bbox"],
            }
        )
    report = {
        "mode": mode,
        "opacity_threshold": WATERMARK_OPACITY_THRESHOLD,
        "page_count": page_count,
        "removed_span_count": len(removed_keys),
        "removed_unique_text_count": len(entries),
        "custom_terms": list(custom_terms),
        "entries": entries,
    }
    return traces, removed_keys, report


def serialize_item(item):
    kind = item[0]
    if kind == "l":
        return {"kind": "line", "p1": point(item[1]), "p2": point(item[2])}
    if kind == "c":
        return {
            "kind": "curve",
            "p1": point(item[1]),
            "c1": point(item[2]),
            "c2": point(item[3]),
            "p2": point(item[4]),
        }
    if kind == "re":
        return {"kind": "rect", "rect": rect(item[1]), "orientation": int(item[2])}
    if kind == "qu":
        quad = item[1]
        return {
            "kind": "quad",
            "points": [point(quad.ul), point(quad.ur), point(quad.lr), point(quad.ll)],
        }
    raise ValueError(f"不支持的绘图元素：{kind!r}")


def serialize_drawing(drawing):
    return {
        "kind": "drawing",
        "seqno": int(drawing["seqno"]),
        "bbox": rect(drawing["rect"]),
        "draw_type": drawing["type"],
        "fill": color(drawing.get("fill")),
        "stroke": color(drawing.get("color")),
        "fill_opacity": float(drawing.get("fill_opacity") or 1.0),
        "stroke_opacity": float(drawing.get("stroke_opacity") or 1.0),
        "stroke_width": float(drawing.get("width") or 0.0),
        "dashes": drawing.get("dashes") or "",
        "close_path": bool(drawing.get("closePath")),
        "even_odd": bool(drawing.get("even_odd")),
        "items": [serialize_item(item) for item in drawing["items"]],
    }


def bbox_distance(a, b):
    return sum(abs(float(a[i]) - float(b[i])) for i in range(4))


def image_seqnos(page):
    return [
        {"seqno": index, "bbox": list(entry[1]), "used": False}
        for index, entry in enumerate(page.get_bboxlog())
        if entry[0] == "fill-image"
    ]


def shade_seqnos(page):
    return [
        {"seqno": index, "bbox": list(entry[1]), "used": False}
        for index, entry in enumerate(page.get_bboxlog())
        if entry[0] == "fill-shade"
    ]


def find_display_entry(candidates, bbox, maximum_distance=3.0):
    unused = [candidate for candidate in candidates if not candidate["used"]]
    if not unused:
        return None
    best = min(unused, key=lambda candidate: bbox_distance(candidate["bbox"], bbox))
    if bbox_distance(best["bbox"], bbox) > maximum_distance:
        return None
    return best


def find_image_seqno(candidates, bbox):
    best = find_display_entry(candidates, bbox)
    if best is None:
        return 0
    best["used"] = True
    return int(best["seqno"])


def uniform_image_color(image_bytes, maximum_channel_range=3):
    if not image_bytes:
        return None
    try:
        with Image.open(BytesIO(image_bytes)) as source:
            image = source.convert("RGB")
            extrema = image.getextrema()
    except Exception:
        return None
    if any(high - low > maximum_channel_range for low, high in extrema):
        return None
    channels = [round((low + high) / 2) for low, high in extrema]
    return "#" + "".join(f"{value:02X}" for value in channels)


def fuse_uniform_shade_with_clip_path(
    elements,
    shade_candidates,
    block,
):
    shade = find_display_entry(shade_candidates, block["bbox"])
    if shade is None:
        return False
    fill = uniform_image_color(block.get("image", b""))
    if not fill:
        return False
    candidates = [
        element
        for element in elements
        if (
            element["kind"] == "drawing"
            and element["seqno"] > int(shade["seqno"])
            and element["seqno"] <= int(shade["seqno"]) + 2
            and bbox_distance(element["bbox"], block["bbox"]) <= 3.0
            and any(item["kind"] == "curve" for item in element["items"])
        )
    ]
    if not candidates:
        return False
    drawing = min(
        candidates,
        key=lambda element: (
            bbox_distance(element["bbox"], block["bbox"]),
            element["seqno"],
        ),
    )
    drawing["fill"] = fill
    drawing["fill_opacity"] = 1.0
    drawing["draw_type"] = (
        "fs" if "s" in drawing.get("draw_type", "") else "f"
    )
    drawing["shade_fused"] = True
    drawing["shade_seqno"] = int(shade["seqno"])
    shade["used"] = True
    return True


def font_props(font_name):
    clean = re.sub(r"^[A-Z]{6}\+", "", font_name or "")
    lowered = clean.lower()
    if "microsoftyahei" in lowered or "msyh" in lowered:
        family = "Microsoft YaHei"
    elif "arial" in lowered:
        family = "Arial"
    elif "simsun" in lowered:
        family = "SimSun"
    elif "kaiti" in lowered:
        family = "KaiTi"
    elif "segoeui" in lowered:
        family = "Segoe UI Symbol"
    elif "wingdings" in lowered:
        family = "Wingdings"
    elif "dengxian" in lowered:
        family = "DengXian"
    else:
        family = clean.replace("-Bold", "").replace("-Italic", "") or "Arial"
    return {
        "family": family,
        "bold": "bold" in lowered,
        "italic": "italic" in lowered or "oblique" in lowered,
    }


def serialize_text_line(span, chars):
    text = "".join(chr(char[0]) for char in chars)
    text = text.replace("\x00", "").replace("\ufffd", "")
    props = font_props(span.get("font", ""))
    char_boxes = [char[3] for char in chars]
    bbox = [
        min(box[0] for box in char_boxes),
        min(box[1] for box in char_boxes),
        max(box[2] for box in char_boxes),
        max(box[3] for box in char_boxes),
    ]
    return {
        "kind": "text",
        "seqno": int(span["seqno"]),
        "bbox": [round(float(x), 5) for x in bbox],
        "origin": [
            round(float(chars[0][2][0]), 5) if chars else 0,
            round(float(chars[0][2][1]), 5) if chars else 0,
        ],
        "text": text,
        "font": props["family"],
        "bold": props["bold"],
        "italic": props["italic"],
        "font_size": float(span["size"]),
        "color": color(span.get("color")),
        "opacity": float(
            1.0 if span.get("opacity") is None else span.get("opacity")
        ),
        "direction": [float(v) for v in span.get("dir", (1.0, 0.0))],
        "ascender": float(span.get("ascender") or 1.0),
        "descender": float(span.get("descender") or -0.25),
    }


def serialize_text(span):
    chars = span.get("chars") or ()
    if not chars:
        return []
    direction = span.get("dir", (1, 0))
    normal = (-float(direction[1]), float(direction[0]))

    def baseline_of(char):
        x, y = char[2]
        return float(x) * normal[0] + float(y) * normal[1]

    groups = []
    current = [chars[0]]
    baseline = baseline_of(chars[0])
    for char in chars[1:]:
        next_baseline = baseline_of(char)
        if abs(next_baseline - baseline) > 0.5:
            groups.append(current)
            current = [char]
            baseline = next_baseline
        else:
            current.append(char)
    groups.append(current)
    return [serialize_text_line(span, group) for group in groups]


def merge_adjacent_text_elements(elements):
    """Join PDF text runs that are visually one continuous styled line.

    WPS often emits a single Chinese heading as several consecutive text
    operators. Keeping every operator as an independent PowerPoint textbox
    exposes font-metric differences and creates visible gaps between runs.
    Runs are merged only when their typography, baseline, direction and color
    match and their PDF boxes nearly touch.
    """
    merged = []
    seen_text_signatures = set()
    style_keys = (
        "font",
        "bold",
        "italic",
        "font_size",
        "color",
        "opacity",
        "direction",
    )
    for element in elements:
        if element["kind"] == "text":
            signature = (
                element.get("text"),
                *(round(float(value), 3) for value in element.get("bbox", ())),
                *(round(float(value), 3) for value in element.get("origin", ())),
                *(
                    tuple(value) if isinstance(value := element.get(key), list) else value
                    for key in style_keys
                ),
            )
            if signature in seen_text_signatures:
                continue
            seen_text_signatures.add(signature)
        if merged and element["kind"] == "text" and merged[-1]["kind"] == "text":
            previous = merged[-1]
            same_style = all(previous.get(key) == element.get(key) for key in style_keys)
            same_line = (
                abs(previous["origin"][1] - element["origin"][1]) <= 0.8
                and abs(previous["bbox"][1] - element["bbox"][1]) <= 0.8
                and abs(previous["bbox"][3] - element["bbox"][3]) <= 0.8
            )
            gap = element["bbox"][0] - previous["bbox"][2]
            near = -0.5 <= gap <= max(4.0, float(element["font_size"]) * 0.2)
            horizontal = (
                abs(float(previous["direction"][0]) - 1.0) <= 0.01
                and abs(float(previous["direction"][1])) <= 0.01
            )
            if same_style and same_line and near and horizontal:
                previous["text"] += element["text"]
                previous["bbox"][2] = max(previous["bbox"][2], element["bbox"][2])
                previous["bbox"][3] = max(previous["bbox"][3], element["bbox"][3])
                continue
        merged.append(element)
    return merged


def write_image_asset(
    doc,
    page,
    page_no,
    block,
    info_by_number,
    smask_by_xref,
    clip_image_numbers,
):
    image_bytes = block.get("image", b"")
    extension = block.get("ext", "png")
    info = info_by_number.get(int(block.get("number", -1)))
    if int(block.get("number", -1)) in clip_image_numbers:
        source_render = Image.open(
            SOURCE_RENDER_DIR / f"slide-{page_no:02d}.png"
        ).convert("RGB")
        x0, y0, x1, y1 = block["bbox"]
        crop = source_render.crop(
            (
                round(x0 * PDF_TO_SLIDE_SCALE),
                round(y0 * PDF_TO_SLIDE_SCALE),
                round(x1 * PDF_TO_SLIDE_SCALE),
                round(y1 * PDF_TO_SLIDE_SCALE),
            )
        )
        from io import BytesIO

        buffer = BytesIO()
        crop.save(buffer, format="PNG")
        image_bytes = buffer.getvalue()
        extension = "png"
    elif info and info.get("xref"):
        xref = int(info["xref"])
        try:
            base = fitz.Pixmap(doc, xref)
            smask = int(smask_by_xref.get(xref, 0))
            # Recent PyMuPDF versions may return an RGB pixmap with an opaque
            # alpha channel even though the PDF image has a separate soft mask.
            # The mask constructor rejects color pixmaps that already contain
            # alpha, so remove that opaque channel before applying the real
            # mask. Otherwise the exception fallback writes the raw JPEG and
            # exposes its black mask background in PowerPoint.
            if smask:
                if base.alpha:
                    base = fitz.Pixmap(base, 0)
                mask = fitz.Pixmap(doc, smask)
                pixmap = fitz.Pixmap(base, mask)
                base = None
                mask = None
            else:
                pixmap = base
            if pixmap.colorspace and pixmap.colorspace.n > 3:
                pixmap = fitz.Pixmap(fitz.csRGB, pixmap)
            image_bytes = pixmap.tobytes("png")
            extension = "png"
        except Exception:
            pass
    asset_name = f"page-{page_no:02d}-image-{int(block.get('number', 0)):03d}.{extension}"
    asset_path = ASSET_DIR / asset_name
    asset_path.write_bytes(image_bytes)
    return asset_path


def serialize_image(
    doc,
    page,
    page_no,
    block,
    seqno,
    info_by_number,
    smask_by_xref,
    clip_image_numbers,
):
    asset_path = write_image_asset(
        doc,
        page,
        page_no,
        block,
        info_by_number,
        smask_by_xref,
        clip_image_numbers,
    )
    transform = [float(v) for v in block.get("transform", (1, 0, 0, 1, 0, 0))]
    a, b, c, d, _, _ = transform
    rotation = math.degrees(math.atan2(b, a)) if a or b else 0.0
    width = math.hypot(a, b)
    height = math.hypot(c, d)
    return {
        "kind": "image",
        "seqno": int(seqno),
        "bbox": [round(float(x), 5) for x in block["bbox"]],
        "asset": str(asset_path),
        "rotation": rotation,
        "display_width": width,
        "display_height": height,
        "content_type": f"image/{'jpeg' if asset_path.suffix.lower() in ('.jpg', '.jpeg') else asset_path.suffix.lower().lstrip('.')}",
    }


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


def main():
    global INPUT_PDF, BUILD_DIR, ASSET_DIR, OUTPUT_JSON, SOURCE_RENDER_DIR
    global WATERMARK_MODE, WATERMARK_OPACITY_THRESHOLD
    global CUSTOM_WATERMARK_TERMS, WATERMARK_REPORT
    parser = ChineseArgumentParser(
        description="从演示型 PDF 中提取可编辑文字、矢量路径和图片。"
    )
    parser.add_argument("--input", required=True, type=Path, help="源 PDF 文件")
    parser.add_argument(
        "--build-dir", required=True, type=Path, help="可写的工作目录"
    )
    parser.add_argument(
        "--source-render-dir",
        type=Path,
        help="由 Poppler 以 96 DPI 生成的页面渲染图目录，文件名格式为 slide-01.png、slide-02.png 等。",
    )
    parser.add_argument(
        "--output-model", type=Path, help="输出 JSON 模型路径"
    )
    parser.add_argument(
        "--watermark-mode",
        choices=("auto", "keep", "aggressive"),
        default="auto",
        help="水印处理模式：auto 默认安全去除；keep 完整保留；aggressive 扩大重复水印识别范围。",
    )
    parser.add_argument(
        "--keep-watermarks",
        action="store_true",
        help="保留全部水印；等同于 --watermark-mode keep。",
    )
    parser.add_argument(
        "--watermark-text",
        action="append",
        default=[],
        help="额外的水印文字或短语，可重复传入。",
    )
    parser.add_argument(
        "--watermark-opacity-threshold",
        type=float,
        default=0.45,
        help="自动水印识别的透明度阈值，默认值：0.45。",
    )
    parser.add_argument(
        "--watermark-report",
        type=Path,
        help="水印识别报告路径；默认写入构建目录 watermark-report.json。",
    )
    args = parser.parse_args()

    INPUT_PDF = args.input.expanduser().resolve()
    BUILD_DIR = args.build_dir.expanduser().resolve()
    ASSET_DIR = BUILD_DIR / "assets"
    OUTPUT_JSON = (
        args.output_model.expanduser().resolve()
        if args.output_model
        else BUILD_DIR / "pdf-model.json"
    )
    SOURCE_RENDER_DIR = (
        args.source_render_dir.expanduser().resolve()
        if args.source_render_dir
        else BUILD_DIR / "pdf-renders"
    )
    WATERMARK_MODE = "keep" if args.keep_watermarks else args.watermark_mode
    WATERMARK_OPACITY_THRESHOLD = max(
        0.0, min(1.0, float(args.watermark_opacity_threshold))
    )
    CUSTOM_WATERMARK_TERMS = [
        str(value).strip() for value in args.watermark_text if str(value).strip()
    ]
    WATERMARK_REPORT = (
        args.watermark_report.expanduser().resolve()
        if args.watermark_report
        else BUILD_DIR / "watermark-report.json"
    )

    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    if not INPUT_PDF.exists():
        raise FileNotFoundError(INPUT_PDF)
    doc = fitz.open(INPUT_PDF)
    doc.authenticate("")
    page_traces, removed_watermarks, watermark_report = scan_watermarks(
        doc, WATERMARK_MODE, CUSTOM_WATERMARK_TERMS
    )
    WATERMARK_REPORT.parent.mkdir(parents=True, exist_ok=True)
    WATERMARK_REPORT.write_text(
        json.dumps(watermark_report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        f"水印处理：{WATERMARK_MODE}，"
        f"识别并移除 {watermark_report['removed_span_count']} 个文字水印对象，"
        f"报告：{WATERMARK_REPORT}"
    )
    model = {
        "source": str(INPUT_PDF),
        "page_width": float(doc[0].rect.width),
        "page_height": float(doc[0].rect.height),
        "watermark_removal": {
            "mode": WATERMARK_MODE,
            "removed_span_count": watermark_report["removed_span_count"],
            "removed_unique_text_count": watermark_report[
                "removed_unique_text_count"
            ],
            "report": str(WATERMARK_REPORT),
        },
        "pages": [],
    }

    for page_index, page in enumerate(doc):
        page_no = page_index + 1
        elements = [serialize_drawing(drawing) for drawing in page.get_drawings()]
        shade_candidates = shade_seqnos(page)
        fused_shade_count = 0

        for span_index, span in enumerate(page_traces[page_index]):
            if (page_no, span_index) in removed_watermarks:
                continue
            for item in serialize_text(span):
                if item["text"]:
                    elements.append(item)

        candidates = image_seqnos(page)
        info_by_number = {
            int(info["number"]): info for info in page.get_image_info(xrefs=True)
        }
        skip_image_numbers = set()
        clip_image_numbers = set()
        image_infos = list(info_by_number.values())
        for info in image_infos:
            if int(info.get("xref") or 0) != 0:
                continue
            x0, y0, x1, y1 = info["bbox"]
            for parent in image_infos:
                px0, py0, px1, py1 = parent["bbox"]
                contained_in_masked_parent = (
                    int(parent.get("xref") or 0) != 0
                    and bool(parent.get("has-mask"))
                    and (px0, py0, px1, py1) != (x0, y0, x1, y1)
                    and px0 <= x0 + 0.5
                    and py0 <= y0 + 0.5
                    and px1 >= x1 - 0.5
                    and py1 >= y1 - 0.5
                )
                if contained_in_masked_parent:
                    # PyMuPDF exposes some soft-mask support images as extra
                    # inline image blocks. The parent xref already composites
                    # them; inserting these blocks separately creates opaque
                    # rectangles over the slide.
                    skip_image_numbers.add(int(info["number"]))
                    parent_area = max(0.0, (px1 - px0) * (py1 - py0))
                    if parent_area < 20000:
                        clip_image_numbers.add(int(parent["number"]))
                    break
        smask_by_xref = {
            int(image[0]): int(image[1]) for image in page.get_images(full=True)
        }
        for block in page.get_text("dict")["blocks"]:
            if block["type"] != 1 or not block.get("image"):
                continue
            if int(block.get("number", -1)) in skip_image_numbers:
                continue
            if fuse_uniform_shade_with_clip_path(
                elements,
                shade_candidates,
                block,
            ):
                fused_shade_count += 1
                continue
            seqno = find_image_seqno(candidates, block["bbox"])
            elements.append(
                serialize_image(
                    doc,
                    page,
                    page_no,
                    block,
                    seqno,
                    info_by_number,
                    smask_by_xref,
                    clip_image_numbers,
                )
            )

        elements.sort(key=lambda element: (element["seqno"], {"drawing": 0, "image": 1, "text": 2}[element["kind"]]))
        elements = merge_adjacent_text_elements(elements)
        model["pages"].append(
            {
                "number": page_no,
                "width": float(page.rect.width),
                "height": float(page.rect.height),
                "fused_shade_count": fused_shade_count,
                "elements": elements,
            }
        )
        print(
            f"第 {page_no:02d} 页："
            f"{sum(e['kind'] == 'text' for e in elements)} 个文字对象，"
            f"{sum(e['kind'] == 'drawing' for e in elements)} 个绘图对象，"
            f"{sum(e['kind'] == 'image' for e in elements)} 个图片对象，"
            f"{fused_shade_count} 个裁剪纯色填充已融合"
        )

    OUTPUT_JSON.write_text(
        json.dumps(model, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"已写入 {OUTPUT_JSON}")


if __name__ == "__main__":
    main()
