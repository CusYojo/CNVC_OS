from __future__ import annotations

from copy import deepcopy
import hashlib
import re


STYLE_KEYS = (
    "font",
    "bold",
    "italic",
    "font_size",
    "color",
    "opacity",
    "direction",
)

BULLET_RE = re.compile(
    r"^\s*(?:[•●▪■◆◇·]|[-–—]\s|(?:\d+|[A-Za-z])[.)、]\s*)"
)
TERMINAL_RE = re.compile(r"[。！？；：.!?;:]\s*$")
NUMERIC_LABEL_RE = re.compile(r"^\s*[-+]?[\d,.%年月日亿元万美元]+(?:\s*[-–—]\s*[\d,.%]+)?\s*$")
CJK_RE = re.compile(r"[\u3400-\u9fff]")


def _horizontal(element):
    direction = element.get("direction") or (1.0, 0.0)
    return (
        abs(float(direction[0]) - 1.0) <= 0.02
        and abs(float(direction[1])) <= 0.02
    )


def _bbox_union(first, second):
    return [
        min(float(first[0]), float(second[0])),
        min(float(first[1]), float(second[1])),
        max(float(first[2]), float(second[2])),
        max(float(first[3]), float(second[3])),
    ]


def _width(element):
    bbox = element["bbox"]
    return max(0.0, float(bbox[2]) - float(bbox[0]))


def _style_run(element):
    return {
        "text": str(element.get("text") or ""),
        **{key: deepcopy(element.get(key)) for key in STYLE_KEYS},
    }


def _runs(element):
    runs = element.get("runs")
    if runs:
        return deepcopy(runs)
    return [_style_run(element)]


def _line_record(element):
    return {
        "text": str(element.get("text") or ""),
        "bbox": [float(value) for value in element["bbox"]],
        "origin": [float(value) for value in element.get("origin") or (0, 0)],
        **{key: deepcopy(element.get(key)) for key in STYLE_KEYS},
    }


def _source_lines(element):
    lines = element.get("source_lines")
    if lines:
        return deepcopy(lines)
    return [_line_record(element)]


def _normalized_text(elements):
    value = "".join(
        str(element.get("text") or "")
        for element in elements
        if element.get("kind") == "text"
    )
    return re.sub(r"\s+", "", value)


def _text_digest(elements):
    return hashlib.sha256(
        _normalized_text(elements).encode("utf-8")
    ).hexdigest()


def _character_inventory_digest(elements):
    characters = sorted(_normalized_text(elements))
    return hashlib.sha256("".join(characters).encode("utf-8")).hexdigest()


def _same_visual_line(previous, current):
    if not (_horizontal(previous) and _horizontal(current)):
        return False
    previous_origin = previous.get("origin") or (0, 0)
    current_origin = current.get("origin") or (0, 0)
    if abs(float(previous_origin[1]) - float(current_origin[1])) > 0.8:
        return False
    if (
        abs(float(previous["bbox"][1]) - float(current["bbox"][1])) > 1.0
        or abs(float(previous["bbox"][3]) - float(current["bbox"][3])) > 1.0
    ):
        return False
    gap = float(current["bbox"][0]) - float(previous["bbox"][2])
    font_size = max(
        float(previous.get("font_size") or 0),
        float(current.get("font_size") or 0),
        1.0,
    )
    return -0.5 <= gap <= max(4.0, font_size * 0.25)


def _merge_inline_runs(elements):
    merged = []
    for element in elements:
        current = deepcopy(element)
        if (
            merged
            and current.get("kind") == "text"
            and merged[-1].get("kind") == "text"
            and _same_visual_line(merged[-1], current)
        ):
            previous = merged[-1]
            previous_runs = _runs(previous)
            current_runs = _runs(current)
            previous["text"] = (
                str(previous.get("text") or "")
                + str(current.get("text") or "")
            )
            previous["bbox"] = _bbox_union(
                previous["bbox"], current["bbox"]
            )
            previous["runs"] = previous_runs + current_runs
            previous["source_element_count"] = int(
                previous.get("source_element_count") or 1
            ) + int(current.get("source_element_count") or 1)
            previous["source_lines"] = [_line_record(previous)]
            previous["source_lines"][0]["text"] = previous["text"]
            previous["source_lines"][0]["bbox"] = previous["bbox"]
            continue
        merged.append(current)
    return merged


def _is_bullet(text):
    return bool(BULLET_RE.match(str(text or "")))


def _is_short_standalone_label(text):
    value = re.sub(r"\s+", "", str(text or ""))
    if NUMERIC_LABEL_RE.match(value):
        return True
    return len(value) <= 4 and not TERMINAL_RE.search(value)


def _style_compatible(previous, current, mode):
    previous_size = float(previous.get("font_size") or 0)
    current_size = float(current.get("font_size") or 0)
    tolerance = max(
        0.75 if mode == "hybrid" else 1.25,
        max(previous_size, current_size) * (0.06 if mode == "hybrid" else 0.1),
    )
    if abs(previous_size - current_size) > tolerance:
        return False
    if previous.get("color") != current.get("color"):
        return False
    if mode == "hybrid":
        for key in ("font", "bold", "italic"):
            if previous.get(key) != current.get(key):
                return False
    return True


def _alignment(previous, current):
    previous_bbox = previous["bbox"]
    current_bbox = current["bbox"]
    font_size = max(
        float(previous.get("font_size") or 0),
        float(current.get("font_size") or 0),
        1.0,
    )
    previous_center = (float(previous_bbox[0]) + float(previous_bbox[2])) / 2
    current_center = (float(current_bbox[0]) + float(current_bbox[2])) / 2
    left = abs(float(previous_bbox[0]) - float(current_bbox[0])) <= max(
        3.0, font_size * 0.35
    )
    center = abs(previous_center - current_center) <= max(
        4.0, font_size * 0.5
    )
    right = abs(float(previous_bbox[2]) - float(current_bbox[2])) <= max(
        3.0, font_size * 0.35
    )
    overlap = max(
        0.0,
        min(float(previous_bbox[2]), float(current_bbox[2]))
        - max(float(previous_bbox[0]), float(current_bbox[0])),
    )
    overlap_ratio = overlap / max(
        1.0, min(_width(previous), _width(current))
    )
    if left and overlap_ratio >= 0.2:
        return "left"
    if center and overlap_ratio >= 0.35:
        return "center"
    if right and overlap_ratio >= 0.35:
        return "right"
    return None


def _last_source_line(element):
    return _source_lines(element)[-1]


def _can_merge_as_paragraph(previous, current, mode):
    previous_line = _last_source_line(previous)
    current_line = _last_source_line(current)
    if not (_horizontal(previous_line) and _horizontal(current_line)):
        return False, None
    if not _style_compatible(previous_line, current_line, mode):
        return False, None
    previous_text = str(previous_line.get("text") or "")
    current_text = str(current_line.get("text") or "")
    if _is_bullet(current_text):
        return False, None
    if (
        _is_short_standalone_label(previous_text)
        and _is_short_standalone_label(current_text)
    ):
        return False, None

    previous_origin = previous_line.get("origin") or (0, 0)
    current_origin = current_line.get("origin") or (0, 0)
    baseline_delta = float(current_origin[1]) - float(previous_origin[1])
    font_size = max(
        float(previous_line.get("font_size") or 0),
        float(current_line.get("font_size") or 0),
        1.0,
    )
    vertical_gap = (
        float(current_line["bbox"][1]) - float(previous_line["bbox"][3])
    )
    if not (
        font_size * 0.65 <= baseline_delta <= font_size * 2.1
        and -font_size * 0.3 <= vertical_gap <= font_size * 1.15
    ):
        return False, None

    alignment = _alignment(previous_line, current_line)
    if not alignment:
        if _is_bullet(previous_text):
            indentation = (
                float(current_line["bbox"][0])
                - float(previous_line["bbox"][0])
            )
            if 0 <= indentation <= font_size * 3:
                alignment = "left"
        if not alignment:
            return False, None

    source_line_count = int(previous.get("source_line_count") or 1)
    if source_line_count >= (12 if mode == "hybrid" else 20):
        return False, None
    return True, alignment


def _word_separator(previous_text, current_text):
    previous_value = str(previous_text or "").rstrip()
    current_value = str(current_text or "").lstrip()
    if not previous_value or not current_value:
        return ""
    if CJK_RE.search(previous_value[-1]) or CJK_RE.search(current_value[0]):
        return ""
    if previous_value.endswith("-"):
        return ""
    if previous_value[-1].isalnum() and current_value[0].isalnum():
        return " "
    return ""


def _line_separator(previous, current, line_break_mode, alignment):
    previous_line = _last_source_line(previous)
    current_line = _last_source_line(current)
    previous_text = str(previous_line.get("text") or "")
    current_text = str(current_line.get("text") or "")
    if line_break_mode == "preserve":
        return "\n", "preserved"
    if line_break_mode == "reflow":
        return _word_separator(previous_text, current_text), "soft"

    maximum_width = max(_width(previous_line), _width(current_line), 1.0)
    looks_wrapped = (
        alignment == "left"
        and not TERMINAL_RE.search(previous_text)
        and not _is_bullet(current_text)
        and _width(previous_line) >= maximum_width * 0.78
    )
    if looks_wrapped:
        return _word_separator(previous_text, current_text), "soft"
    return "\n", "hard"


def _append_separator(runs, separator):
    if not separator:
        return runs
    if not runs:
        return [{"text": separator}]
    runs[-1]["text"] = str(runs[-1].get("text") or "") + separator
    return runs


def _merge_paragraph(previous, current, separator, break_type):
    previous_source_lines = _source_lines(previous)
    current_source_lines = _source_lines(current)
    previous_runs = _append_separator(_runs(previous), separator)
    current_runs = _runs(current)
    previous["runs"] = previous_runs + current_runs
    previous["text"] = "".join(
        str(run.get("text") or "") for run in previous["runs"]
    )
    previous["bbox"] = _bbox_union(previous["bbox"], current["bbox"])
    previous["source_lines"] = previous_source_lines + current_source_lines
    previous["source_line_count"] = len(previous["source_lines"])
    previous["source_element_count"] = int(
        previous.get("source_element_count") or 1
    ) + int(current.get("source_element_count") or 1)
    previous["line_breaks"] = list(previous.get("line_breaks") or []) + [
        break_type
    ]
    previous["text_grouping"] = "paragraph"
    return previous


def _spatial_paragraph_order(elements, mode):
    """Build local top-to-bottom paragraph chains before sequential merging.

    OCR engines frequently return rows in detector order rather than reading
    order.  A global y/x sort also interleaves columns.  This greedy chain keeps
    each compatible column/card together while leaving unrelated labels alone.
    """
    remaining = [deepcopy(element) for element in elements]
    ordered = []
    remaining.sort(
        key=lambda element: (
            float((element.get("bbox") or [0, 0, 0, 0])[1]),
            float((element.get("bbox") or [0, 0, 0, 0])[0]),
            int(element.get("seqno") or 0),
        )
    )
    while remaining:
        current = remaining.pop(0)
        chain = [current]
        while remaining:
            candidates = []
            for index, candidate in enumerate(remaining):
                can_merge, alignment = _can_merge_as_paragraph(
                    chain[-1], candidate, mode
                )
                if not can_merge:
                    continue
                previous_bbox = _last_source_line(chain[-1])["bbox"]
                candidate_bbox = _last_source_line(candidate)["bbox"]
                vertical_distance = float(candidate_bbox[1]) - float(
                    previous_bbox[3]
                )
                horizontal_distance = abs(
                    float(candidate_bbox[0]) - float(previous_bbox[0])
                )
                alignment_penalty = {
                    "left": 0,
                    "center": 1,
                    "right": 2,
                }.get(alignment, 3)
                candidates.append(
                    (
                        max(0.0, vertical_distance),
                        horizontal_distance,
                        alignment_penalty,
                        index,
                    )
                )
            if not candidates:
                break
            _, _, _, best_index = min(candidates)
            chain.append(remaining.pop(best_index))
        ordered.extend(chain)
    return ordered


def _paragraph_candidate_count(elements, mode):
    candidates = 0
    ordered = sorted(
        (element for element in elements if element.get("kind") == "text"),
        key=lambda element: (
            float(element["bbox"][1]),
            float(element["bbox"][0]),
        ),
    )
    for previous in ordered:
        for current in ordered:
            if current is previous:
                continue
            if float(current["bbox"][1]) <= float(previous["bbox"][1]):
                continue
            can_merge, _ = _can_merge_as_paragraph(previous, current, mode)
            if can_merge:
                candidates += 1
                break
    return candidates


def group_text_elements(
    elements,
    *,
    mode="hybrid",
    line_break_mode="smart",
    page_number=None,
    order_mode="source",
):
    if mode not in {"line", "hybrid", "paragraph"}:
        raise ValueError(f"不支持的文字聚类模式：{mode}")
    if line_break_mode not in {"preserve", "smart", "reflow"}:
        raise ValueError(f"不支持的换行模式：{line_break_mode}")
    if order_mode not in {"source", "spatial"}:
        raise ValueError(f"不支持的阅读顺序模式：{order_mode}")

    source_elements = deepcopy(elements)
    source_text_count = sum(
        element.get("kind") == "text" for element in source_elements
    )
    source_digest = _text_digest(source_elements)
    source_inventory_digest = _character_inventory_digest(source_elements)
    if mode == "line":
        output = source_elements
        line_object_count = source_text_count
    else:
        inline_merged = _merge_inline_runs(source_elements)
        paragraph_candidates = _paragraph_candidate_count(
            inline_merged, mode
        )
        if order_mode == "spatial":
            inline_merged = _spatial_paragraph_order(
                inline_merged, mode
            )
        line_object_count = sum(
            element.get("kind") == "text" for element in inline_merged
        )
        output = []
        for element in inline_merged:
            current = deepcopy(element)
            if (
                output
                and current.get("kind") == "text"
                and output[-1].get("kind") == "text"
            ):
                can_merge, alignment = _can_merge_as_paragraph(
                    output[-1], current, mode
                )
                if can_merge:
                    separator, break_type = _line_separator(
                        output[-1],
                        current,
                        line_break_mode,
                        alignment,
                    )
                    output[-1] = _merge_paragraph(
                        output[-1], current, separator, break_type
                    )
                    continue
            output.append(current)
    if mode == "line":
        paragraph_candidates = 0

    output_text_count = sum(
        element.get("kind") == "text" for element in output
    )
    output_digest = _text_digest(output)
    output_inventory_digest = _character_inventory_digest(output)
    grouped = [
        element
        for element in output
        if (
            element.get("kind") == "text"
            and int(element.get("source_line_count") or 1) > 1
        )
    ]
    report = {
        "page": page_number,
        "mode": mode,
        "lineBreakMode": line_break_mode,
        "inputTextObjectCount": source_text_count,
        "lineObjectCount": line_object_count,
        "outputTextObjectCount": output_text_count,
        "textObjectReduction": source_text_count - output_text_count,
        "groupedParagraphCount": len(grouped),
        "groupedSourceLineCount": sum(
            int(element.get("source_line_count") or 1)
            for element in grouped
        ),
        "orderMode": order_mode,
        "paragraphCandidateCount": paragraph_candidates,
        "unmergedParagraphCandidateCount": max(
            0,
            paragraph_candidates
            - sum(
                max(
                    0,
                    int(element.get("source_line_count") or 1) - 1,
                )
                for element in grouped
            ),
        ),
        "sourceTextDigest": source_digest,
        "outputTextDigest": output_digest,
        "sourceCharacterInventoryDigest": source_inventory_digest,
        "outputCharacterInventoryDigest": output_inventory_digest,
        "contentPreserved": (
            source_digest == output_digest
            if order_mode == "source"
            else source_inventory_digest == output_inventory_digest
        ),
    }
    return output, report
