from __future__ import annotations

from collections import defaultdict
from copy import deepcopy
import json
import math
import re
from pathlib import Path
from statistics import median


NUMERIC_RE = re.compile(r"^\s*[-+]?[\d,.%亿元万美元年月日—–\-]+\s*$")
DEFAULT_ROLE_LIMITS = {
    "cover-title": (22.0, 54.0),
    "page-title": (18.0, 40.0),
    "subtitle": (13.0, 28.0),
    "body": (9.0, 22.0),
    "label": (8.0, 20.0),
    "numeric": (8.0, 28.0),
    "footnote": (7.0, 13.0),
}


def load_typography_profile(path: Path | None) -> dict:
    if not path:
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("typography profile 必须是 JSON 对象")
    return data


def _color_bucket(value: str | None) -> str:
    match = re.fullmatch(r"#?([0-9A-Fa-f]{6})", str(value or ""))
    if not match:
        return "#404040"
    color = match.group(1)
    r, g, b = (int(color[index:index + 2], 16) for index in (0, 2, 4))
    luminance = (r * 299 + g * 587 + b * 114) / 1000
    spread = max(r, g, b) - min(r, g, b)
    if spread <= 42:
        if luminance < 95:
            return "neutral-dark"
        if luminance < 180:
            return "neutral-mid"
        return "neutral-light"
    dominant = max(range(3), key=lambda index: (r, g, b)[index])
    return ("accent-red", "accent-green", "accent-blue")[dominant]


def _role(item: dict, page_number: int, page_height: float) -> str:
    text = re.sub(r"\s+", "", str(item.get("text") or ""))
    top = float(item.get("top") or 0)
    raw = float(item.get("raw_font_size") or item.get("font_size") or 10)
    if top >= page_height * 0.88 or raw <= 9:
        return "footnote"
    if page_number == 1 and top < page_height * 0.45 and raw >= 22:
        return "cover-title"
    if top < page_height * 0.16 and raw >= 17:
        return "page-title"
    if NUMERIC_RE.match(text) and len(text) <= 16:
        return "numeric"
    if raw >= 18:
        return "subtitle"
    if len(text) >= 8:
        return "body"
    return "label"


def _cluster(values: list[tuple[int, float]]) -> list[list[tuple[int, float]]]:
    if not values:
        return []
    ordered = sorted(values, key=lambda item: item[1])
    clusters: list[list[tuple[int, float]]] = [[ordered[0]]]
    for item in ordered[1:]:
        previous = clusters[-1][-1][1]
        threshold = max(1.25, min(previous, item[1]) * 0.11)
        if item[1] - previous <= threshold:
            clusters[-1].append(item)
        else:
            clusters.append([item])
    return clusters


def _snap(value: float, palette: list[float] | None) -> float:
    if palette:
        return min(palette, key=lambda candidate: abs(candidate - value))
    return round(value * 2) / 2


def _role_limits(profile: dict, role: str) -> tuple[float, float]:
    configured = (profile.get("roleLimits") or {}).get(role)
    if (
        isinstance(configured, list)
        and len(configured) == 2
        and all(isinstance(value, (int, float)) for value in configured)
    ):
        return float(configured[0]), float(configured[1])
    return DEFAULT_ROLE_LIMITS[role]


def _role_font(profile: dict, role: str, fallback: str) -> str:
    fonts = profile.get("fonts") or {}
    if role in {"cover-title", "page-title", "subtitle"}:
        return str(fonts.get(role) or fonts.get("title") or fallback)
    return str(fonts.get(role) or fonts.get("body") or fallback)


def normalize_deck_typography(
    pages: list[dict],
    *,
    profile: dict | None = None,
    mode: str = "normalized",
) -> dict:
    if mode not in {"raw", "normalized", "strict"}:
        raise ValueError(f"不支持的字号模式：{mode}")
    profile = deepcopy(profile or {})
    palette = [
        float(value)
        for value in (profile.get("fontSizePalette") or [])
        if isinstance(value, (int, float))
    ]
    records: list[tuple[int, dict]] = []
    for page in pages:
        page_number = int(page["number"])
        page_height = float(page["height"])
        for item in page.get("text") or []:
            item["raw_font_size"] = float(
                item.get("raw_font_size") or item.get("font_size") or 10
            )
            item["font_role"] = _role(item, page_number, page_height)
            records.append((page_number, item))

    grouped: dict[tuple, list[tuple[int, float]]] = defaultdict(list)
    for index, (_, item) in enumerate(records):
        key = (
            item["font_role"],
            bool(item.get("bold")),
            _color_bucket(item.get("color")),
            bool(item.get("vertical")),
        )
        grouped[key].append((index, float(item["raw_font_size"])))

    style_reports = []
    style_counter = 0
    for base_key, values in sorted(grouped.items(), key=lambda item: str(item[0])):
        for cluster_values in _cluster(values):
            style_counter += 1
            role = base_key[0]
            raw_values = [value for _, value in cluster_values]
            configured_size = (profile.get("roleSizes") or {}).get(role)
            target = float(configured_size) if configured_size is not None else median(raw_values)
            low, high = _role_limits(profile, role)
            target = min(high, max(low, target))
            target = _snap(target, palette)
            style_id = f"typo-{style_counter:03d}"
            for record_index, _ in cluster_values:
                _, item = records[record_index]
                font = _role_font(profile, role, str(item.get("font") or "Noto Sans CJK SC"))
                final_size = (
                    float(item["raw_font_size"])
                    if mode == "raw"
                    else float(target)
                )
                item["font_size"] = final_size
                item["font_size_pt"] = final_size
                item["font"] = font
                item["style_id"] = style_id
                item["typography_calibrated"] = mode != "raw"
                for run in item.get("runs") or []:
                    run["font"] = font
                    run["font_size"] = final_size
                    run["font_size_pt"] = final_size
                    run["style_id"] = style_id
            style_reports.append(
                {
                    "styleId": style_id,
                    "role": role,
                    "font": _role_font(
                        profile,
                        role,
                        str(records[cluster_values[0][0]][1].get("font") or ""),
                    ),
                    "bold": bool(base_key[1]),
                    "colorBucket": base_key[2],
                    "objectCount": len(cluster_values),
                    "rawMinimum": min(raw_values),
                    "rawMaximum": max(raw_values),
                    "normalizedSizePt": target,
                }
            )

    exact_source_font = bool(profile.get("sourceFontVerified"))
    warnings = []
    if not exact_source_font:
        warnings.append(
            "扁平化 PDF 无法仅凭像素恢复精确字体家族；当前字体来自显式 profile 或平台候选。"
        )
    inconsistent = []
    for page in pages:
        for item in page.get("text") or []:
            if not math.isfinite(float(item.get("font_size_pt") or 0)):
                inconsistent.append(
                    {"page": page["number"], "text": item.get("text"), "reason": "invalid-size"}
                )
    return {
        "schemaVersion": "1.0",
        "mode": mode,
        "sourceFontVerified": exact_source_font,
        "profile": profile,
        "styleCount": len(style_reports),
        "textObjectCount": len(records),
        "styles": style_reports,
        "errors": inconsistent,
        "warnings": warnings,
        "passed": not inconsistent and (mode != "strict" or bool(records)),
    }
