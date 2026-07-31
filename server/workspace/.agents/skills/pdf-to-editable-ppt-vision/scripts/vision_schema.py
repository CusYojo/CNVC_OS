#!/usr/bin/env python3
"""Small dependency-free validators for the agent vision JSON contracts."""
from __future__ import annotations

from typing import Any


REGION_TYPES = {
    "flowchart", "table", "chart", "matrix", "icon-group", "photo",
    "screenshot", "illustration", "decoration", "watermark", "text-block",
    "unknown",
}
ACTIONS = {"semantic-rebuild", "ocr-text", "keep-raster", "review", "ignore"}
OBJECT_TYPES = {"shape", "text", "connector", "icon", "table", "chart"}
ISSUE_SEVERITIES = {"info", "warning", "error", "blocking"}


def _fail(path: str, message: str) -> None:
    raise ValueError(f"{path}: {message}")


def _object(value: Any, path: str) -> dict:
    if not isinstance(value, dict):
        _fail(path, "必须是对象")
    return value


def _array(value: Any, path: str) -> list:
    if not isinstance(value, list):
        _fail(path, "必须是数组")
    return value


def _string(value: Any, path: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        _fail(path, "必须是非空字符串")
    return value


def _number(value: Any, path: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(path, "必须是数值")
    result = float(value)
    if not minimum <= result <= maximum:
        _fail(path, f"必须位于 {minimum}..{maximum}")
    return result


def _boolean(value: Any, path: str) -> bool:
    if not isinstance(value, bool):
        _fail(path, "必须是布尔值")
    return value


def _keys(value: dict, path: str, required: set[str], allowed: set[str]) -> None:
    missing = required - set(value)
    if missing:
        _fail(path, f"缺少字段：{', '.join(sorted(missing))}")
    extra = set(value) - allowed
    if extra:
        _fail(path, f"存在未声明字段：{', '.join(sorted(extra))}")


def _bbox(value: Any, path: str) -> None:
    items = _array(value, path)
    if len(items) != 4:
        _fail(path, "必须包含 [x, y, width, height]")
    x, y, width, height = [
        _number(item, f"{path}[{index}]", 0, 1)
        for index, item in enumerate(items)
    ]
    if width <= 0 or height <= 0:
        _fail(path, "width 和 height 必须大于 0")
    if x + width > 1.000001 or y + height > 1.000001:
        _fail(path, "边界框不得越出归一化页面")


def _line(value: Any, path: str) -> None:
    item = _object(value, path)
    _keys(
        item,
        path,
        set(),
        {"style", "fill", "color", "width", "transparency", "dash"},
    )
    for key in ("style", "fill", "color", "dash"):
        if key in item:
            _string(item[key], f"{path}.{key}")
    if "width" in item:
        _number(item["width"], f"{path}.width", 0, 100)
    if "transparency" in item:
        _number(item["transparency"], f"{path}.transparency", 0, 100)


def _arrow(value: Any, path: str) -> None:
    item = _object(value, path)
    _keys(item, path, {"type"}, {"type", "width", "length"})
    _string(item["type"], f"{path}.type")
    for key in ("width", "length"):
        if key in item:
            _string(item[key], f"{path}.{key}")


def _text_style(value: Any, path: str) -> None:
    item = _object(value, path)
    allowed = {
        "fontSize", "typeface", "color", "bold", "italic", "alignment",
        "verticalAlignment", "autoFit", "wrap", "rotation", "insets",
    }
    _keys(item, path, set(), allowed)
    if "fontSize" in item:
        _number(item["fontSize"], f"{path}.fontSize", 1, 400)
    if "rotation" in item:
        _number(item["rotation"], f"{path}.rotation", -360, 360)
    for key in (
        "typeface", "color", "alignment", "verticalAlignment", "autoFit", "wrap",
    ):
        if key in item:
            _string(item[key], f"{path}.{key}")
    for key in ("bold", "italic"):
        if key in item:
            _boolean(item[key], f"{path}.{key}")
    if "insets" in item:
        insets = _object(item["insets"], f"{path}.insets")
        _keys(
            insets,
            f"{path}.insets",
            set(),
            {"top", "right", "bottom", "left"},
        )
        for key, inset in insets.items():
            _number(inset, f"{path}.insets.{key}", 0, 500)


def _vision_object(value: Any, path: str) -> None:
    item = _object(value, path)
    object_type = _string(item.get("type"), f"{path}.type")
    if object_type not in OBJECT_TYPES:
        _fail(f"{path}.type", f"不支持的对象类型 {object_type!r}")
    common = {"id", "name", "type", "bbox"}
    required = {"id", "type", "bbox"}
    per_type = {
        "shape": {
            "geometry", "fill", "line", "text", "textEvidenceId", "textStyle",
        },
        "text": {"text", "textEvidenceId", "textStyle"},
        "connector": {
            "from", "to", "kind", "fromSide", "toSide", "line",
            "head", "tail", "cap", "join",
        },
        "icon": {"mode", "geometry", "fill", "line", "asset", "svg", "parts"},
        "table": {
            "verifiedData", "values", "fontSize", "fontFace", "color",
            "fill", "border", "margin",
        },
        "chart": {
            "verifiedData", "chartType", "categories", "series", "hasLegend",
            "showValue", "holeSize",
        },
    }[object_type]
    if object_type == "connector":
        required |= {"from", "to"}
    _keys(item, path, required, common | per_type)
    _string(item["id"], f"{path}.id")
    _bbox(item["bbox"], f"{path}.bbox")
    for key in ("name", "geometry", "fill", "text", "textEvidenceId", "kind",
                "fromSide", "toSide", "cap", "join", "mode", "asset", "svg",
                "chartType", "fontFace", "color"):
        if key in item:
            _string(item[key], f"{path}.{key}", allow_empty=key == "text")
    for key in ("from", "to"):
        if key in item:
            _string(item[key], f"{path}.{key}")
    if "line" in item:
        _line(item["line"], f"{path}.line")
    for key in ("head", "tail"):
        if key in item:
            _arrow(item[key], f"{path}.{key}")
    if "textStyle" in item:
        _text_style(item["textStyle"], f"{path}.textStyle")
    for key in ("verifiedData", "hasLegend", "showValue"):
        if key in item:
            _boolean(item[key], f"{path}.{key}")
    for key in ("values", "series", "categories", "parts"):
        if key in item:
            _array(item[key], f"{path}.{key}")


def _typography(value: Any, path: str) -> None:
    item = _object(value, path)
    _keys(
        item,
        path,
        set(),
        {"sourceFontVerified", "bodyFontCandidates", "titleFontCandidates", "styles"},
    )
    if "sourceFontVerified" in item:
        _boolean(item["sourceFontVerified"], f"{path}.sourceFontVerified")
    for key in ("bodyFontCandidates", "titleFontCandidates"):
        if key in item:
            for index, candidate in enumerate(_array(item[key], f"{path}.{key}")):
                _string(candidate, f"{path}.{key}[{index}]")
    for index, style_value in enumerate(_array(item.get("styles", []), f"{path}.styles")):
        style_path = f"{path}.styles[{index}]"
        style = _object(style_value, style_path)
        _keys(
            style,
            style_path,
            {"styleId", "fontSizePt", "bold"},
            {"styleId", "role", "fontFamily", "fontSizePt", "bold", "italic", "color"},
        )
        _string(style["styleId"], f"{style_path}.styleId")
        for key in ("role", "fontFamily", "color"):
            if key in style:
                _string(style[key], f"{style_path}.{key}")
        _number(style["fontSizePt"], f"{style_path}.fontSizePt", 5, 400)
        _boolean(style["bold"], f"{style_path}.bold")
        if "italic" in style:
            _boolean(style["italic"], f"{style_path}.italic")


def validate_analysis_payload(payload: Any) -> dict:
    root = _object(payload, "$")
    if "analysis" in root:
        _keys(root, "$", {"analysis"}, {"analysis"})
        root = _object(root["analysis"], "$.analysis")
        path = "$.analysis"
    else:
        path = "$"
    _keys(
        root,
        path,
        {"pageType", "confidence", "regions"},
        {"pageType", "confidence", "typography", "regions"},
    )
    _string(root["pageType"], f"{path}.pageType")
    _number(root["confidence"], f"{path}.confidence", 0, 1)
    if "typography" in root:
        _typography(root["typography"], f"{path}.typography")
    for index, region_value in enumerate(_array(root["regions"], f"{path}.regions")):
        region_path = f"{path}.regions[{index}]"
        region = _object(region_value, region_path)
        _keys(
            region,
            region_path,
            {
                "id", "type", "bbox", "recommendedAction", "confidence",
                "reconstructionComplete", "objects",
            },
            {
                "id", "type", "bbox", "recommendedAction", "confidence",
                "reconstructionComplete", "objects", "summary", "coverFill",
                "expectedObjectCount", "sourceImageElementIndex", "notes",
            },
        )
        _string(region["id"], f"{region_path}.id")
        region_type = _string(region["type"], f"{region_path}.type")
        if region_type not in REGION_TYPES:
            _fail(f"{region_path}.type", f"不支持的区域类型 {region_type!r}")
        _bbox(region["bbox"], f"{region_path}.bbox")
        action = _string(
            region["recommendedAction"],
            f"{region_path}.recommendedAction",
        )
        if action not in ACTIONS:
            _fail(
                f"{region_path}.recommendedAction",
                f"不支持的动作 {action!r}",
            )
        _number(region["confidence"], f"{region_path}.confidence", 0, 1)
        _boolean(
            region["reconstructionComplete"],
            f"{region_path}.reconstructionComplete",
        )
        for key in ("summary", "coverFill", "notes"):
            if key in region:
                _string(region[key], f"{region_path}.{key}", allow_empty=True)
        for key in ("expectedObjectCount", "sourceImageElementIndex"):
            if key in region:
                value = region[key]
                if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                    _fail(f"{region_path}.{key}", "必须是非负整数")
        objects = _array(region["objects"], f"{region_path}.objects")
        for object_index, object_value in enumerate(objects):
            _vision_object(
                object_value,
                f"{region_path}.objects[{object_index}]",
            )
    return root


def validate_qa_payload(payload: Any) -> dict:
    root = _object(payload, "$")
    if "review" in root:
        _keys(root, "$", {"review"}, {"review"})
        root = _object(root["review"], "$.review")
        path = "$.review"
    else:
        path = "$"
    _keys(
        root,
        path,
        {"passed", "confidence", "issues", "summary"},
        {"passed", "confidence", "issues", "summary", "foregroundPassed"},
    )
    _boolean(root["passed"], f"{path}.passed")
    _number(root["confidence"], f"{path}.confidence", 0, 1)
    _string(root["summary"], f"{path}.summary", allow_empty=True)
    if "foregroundPassed" in root:
        _boolean(root["foregroundPassed"], f"{path}.foregroundPassed")
    for index, issue_value in enumerate(_array(root["issues"], f"{path}.issues")):
        issue_path = f"{path}.issues[{index}]"
        issue = _object(issue_value, issue_path)
        _keys(
            issue,
            issue_path,
            {"type", "severity", "description"},
            {"type", "severity", "description", "bbox", "objectId"},
        )
        _string(issue["type"], f"{issue_path}.type")
        severity = _string(issue["severity"], f"{issue_path}.severity")
        if severity not in ISSUE_SEVERITIES:
            _fail(f"{issue_path}.severity", f"不支持的严重程度 {severity!r}")
        _string(issue["description"], f"{issue_path}.description")
        if "bbox" in issue:
            _bbox(issue["bbox"], f"{issue_path}.bbox")
        if "objectId" in issue:
            _string(issue["objectId"], f"{issue_path}.objectId")
    return root
