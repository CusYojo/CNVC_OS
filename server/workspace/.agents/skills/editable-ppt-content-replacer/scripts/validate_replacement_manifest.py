#!/usr/bin/env python3
from __future__ import annotations

import argparse
from datetime import date
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import re
import struct
from typing import Any
import unicodedata
from urllib.parse import urlparse
import zlib


TEXT_ACTIONS = {"replace_text", "replace_text_group"}
CONTROLLED_ADDITIVE_ACTIONS = {"add_disclaimer_textbox"}
NATIVE_ACTIONS = {"replace_chart_data", "replace_table_data"}
STRUCTURAL_ACTIONS = {"delete_slot_group"}
ALLOWED_ACTIONS = (
    TEXT_ACTIONS
    | CONTROLLED_ADDITIVE_ACTIONS
    | NATIVE_ACTIONS
    | STRUCTURAL_ACTIONS
    | {
    "replace_image"
    }
)
ALLOWED_ASSET_CLASSES = {
    "company_logo",
    "person_photo",
    "product_screenshot",
    "customer_evidence",
    "company_specific_visual",
    "user_approved_visual",
}
PROTECTED_CLASSES = {
    "shared_semantic_icon",
    "fixed_visual",
    "template_background",
    "template_brand",
    "template_label",
    "generic_decoration",
}
GENERIC_TEMPLATE_LABELS = {
    "目录",
    "contents",
    "项目概览",
    "公司概况",
    "核心亮点",
    "行业分析",
    "市场分析",
    "产品与技术",
    "核心团队",
    "商业模式",
    "竞争格局",
    "财务分析",
    "财务预测",
    "融资情况",
    "估值分析",
    "投资建议",
    "风险提示",
    "退出路径",
    "免责声明",
    "数据来源",
    "investment proposal",
    "investment recommendation",
    "company overview",
    "market analysis",
    "industry analysis",
    "investment highlights",
    "risk factors",
    "disclaimer",
}
SUPPORTED_SCHEMA_VERSIONS = {"1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6"}
RESEARCH_SCHEMA_VERSIONS = {"1.3", "1.4", "1.5", "1.6"}
STRICT_SLOT_SCHEMA_VERSIONS = {"1.2", "1.3", "1.4", "1.5", "1.6"}
RELATIONSHIP_SCHEMA_VERSIONS = {"1.1", "1.2", "1.3", "1.4", "1.5", "1.6"}
PAGE_CLOSURE_SCHEMA_VERSIONS = {"1.4", "1.5", "1.6"}
CONTENT_SAFE_SCHEMA_VERSIONS = {"1.5", "1.6"}
BACKGROUND_LOCK_SCHEMA_VERSIONS = {"1.6"}
SOURCE_TYPES = {
    "user_material",
    "company_official",
    "regulatory_filing",
    "government",
    "academic",
    "industry_report",
    "reputable_media",
    "other",
}
PRIMARY_SOURCE_TYPES = {
    "user_material",
    "company_official",
    "regulatory_filing",
    "government",
    "academic",
}
WEB_SOURCE_TYPES = SOURCE_TYPES - {"user_material"}
EVIDENCE_VALUE_TYPES = {
    "user-provided",
    "official-fact",
    "corroborated-fact",
    "derived",
    "estimate",
    "unavailable",
}
EVIDENCE_STATUSES = {
    "verified",
    "single-source",
    "conflicting",
    "not-found",
}
UNAVAILABLE_LABELS = ("未披露", "待核实", "公开信息未检索到")
CAUTIOUS_LABELS = UNAVAILABLE_LABELS + ("存在差异", "口径不一致")
DEFAULT_FORBIDDEN_OPERATIONAL_TERMS = (
    "未提供公司官网",
    "缺少原始文件",
    "现有材料没有BP",
    "未提供公司资料",
)
GENERIC_KEEP_REASONS = {
    "固定视觉",
    "模板元素",
    "保持不变",
    "无需替换",
    "通用元素",
    "测试",
}


def slide_object_order(
    template_map: dict[str, Any],
) -> dict[tuple[int, int], int]:
    return {
        (int(slide.get("number", 0)), int(item.get("shapeId", 0))): index
        for slide in template_map.get("slides", [])
        if isinstance(slide, dict)
        for index, item in enumerate(slide.get("objects", []), 1)
        if isinstance(item, dict)
    }


def inferred_background_candidates(
    template_map: dict[str, Any],
) -> dict[tuple[int, int], dict[str, Any]]:
    candidates: dict[tuple[int, int], dict[str, Any]] = {}
    for slide in template_map.get("slides", []):
        if not isinstance(slide, dict):
            continue
        page = int(slide.get("number", 0))
        slide_width = float(slide.get("widthEmu", 0)) / 9525
        slide_height = float(slide.get("heightEmu", 0)) / 9525
        if page <= 0 or slide_width <= 0 or slide_height <= 0:
            continue
        for z_index, item in enumerate(slide.get("objects", []), 1):
            if not isinstance(item, dict):
                continue
            kind = str(item.get("kind", ""))
            if kind != "picture" and not kind.startswith("shape:"):
                continue
            try:
                x, y, width, height = [
                    float(value) for value in item.get("bbox", [])
                ]
            except (TypeError, ValueError):
                continue
            if width <= 0 or height <= 0:
                continue
            coverage = min(
                1.0, (width * height) / (slide_width * slide_height)
            )
            tolerance_x = slide_width * 0.025
            tolerance_y = slide_height * 0.025
            touches_left = x <= tolerance_x
            touches_right = x + width >= slide_width - tolerance_x
            touches_top = y <= tolerance_y
            touches_bottom = y + height >= slide_height - tolerance_y
            full_bleed = (
                width >= slide_width * 0.94
                and height >= slide_height * 0.94
                and touches_left
                and touches_right
                and touches_top
                and touches_bottom
            )
            horizontal_band = (
                width >= slide_width * 0.94
                and height >= slide_height * 0.08
                and touches_left
                and touches_right
                and (touches_top or touches_bottom)
            )
            vertical_band = (
                height >= slide_height * 0.94
                and width >= slide_width * 0.08
                and touches_top
                and touches_bottom
                and (touches_left or touches_right)
            )
            large_early_layer = z_index <= 8 and coverage >= 0.62
            reasons = []
            if full_bleed:
                reasons.append("full-bleed")
            if horizontal_band:
                reasons.append("edge-horizontal-band")
            if vertical_band:
                reasons.append("edge-vertical-band")
            if large_early_layer:
                reasons.append("large-early-layer")
            if not reasons:
                continue
            shape_id = int(item.get("shapeId", 0))
            if shape_id > 0:
                candidates[(page, shape_id)] = {
                    "slide": page,
                    "shapeId": shape_id,
                    "name": item.get("name", ""),
                    "kind": kind,
                    "bbox": item.get("bbox", []),
                    "coverage": round(coverage, 4),
                    "zIndex": z_index,
                    "reasons": reasons,
                }
    return candidates


def validate_background_policy(
    manifest: dict[str, Any],
    template_map: dict[str, Any],
    protected: dict[tuple[int, int], dict[str, Any]],
    groups: dict[str, dict[str, Any]],
    operations: list[dict[str, Any]],
    errors: list[str],
) -> dict[str, Any]:
    if str(manifest.get("schemaVersion", "")) not in BACKGROUND_LOCK_SCHEMA_VERSIONS:
        return {"required": False, "status": "not-required"}
    initial_error_count = len(errors)
    policy = manifest.get("backgroundPolicy")
    candidates = inferred_background_candidates(template_map)
    slides_without_signatures = [
        int(slide.get("number", 0))
        for slide in template_map.get("slides", [])
        if isinstance(slide, dict)
        and not isinstance(slide.get("backgroundSignatures"), dict)
    ]
    if slides_without_signatures:
        errors.append(
            "1.6 版 template-map 缺少母版/版式/幻灯片背景签名；"
            "请使用升级后的 analyze_template_openxml.py 重新分析："
            f"{slides_without_signatures}"
        )
    if not isinstance(policy, dict):
        errors.append("1.6 版必须提供 backgroundPolicy")
        return {
            "required": True,
            "status": "missing",
            "detectedCandidates": list(candidates.values()),
        }
    if policy.get("preserveTemplateBackground") is not True:
        errors.append(
            "backgroundPolicy.preserveTemplateBackground 必须为 true"
        )
    if policy.get("allowBackgroundDeletion") is not False:
        errors.append(
            "backgroundPolicy.allowBackgroundDeletion 必须为 false"
        )
    raw_decisions = policy.get("candidateDecisions")
    if not isinstance(raw_decisions, list):
        errors.append("backgroundPolicy.candidateDecisions 必须是数组")
        raw_decisions = []
    decisions: dict[tuple[int, int], dict[str, Any]] = {}
    supported_classes = {
        "template_background",
        "project_content_visual",
        "logo_backplate",
        "not_background",
    }
    supported_dispositions = {"preserve", "replace", "delete"}
    for index, decision in enumerate(raw_decisions, 1):
        prefix = f"第 {index} 个背景候选决定"
        if not isinstance(decision, dict):
            errors.append(f"{prefix}必须是对象")
            continue
        try:
            key = (
                int(decision.get("slide", 0)),
                int(decision.get("shapeId", 0)),
            )
        except (TypeError, ValueError):
            key = (0, 0)
        if key not in candidates:
            errors.append(
                f"{prefix}未对应自动识别的背景候选："
                f"slide={key[0]}, shapeId={key[1]}"
            )
        if key in decisions:
            errors.append(f"{prefix}重复登记背景候选")
        decisions[key] = decision
        classification = decision.get("classification")
        disposition = decision.get("disposition")
        reason = str(decision.get("reason", "")).strip()
        if classification not in supported_classes:
            errors.append(f"{prefix} classification 不受支持：{classification}")
        if disposition not in supported_dispositions:
            errors.append(f"{prefix} disposition 不受支持：{disposition}")
        if len(reason) < 8 or reason in GENERIC_KEEP_REASONS:
            errors.append(f"{prefix}必须提供具体、可复核的视觉判断理由")
        if classification == "template_background":
            if disposition != "preserve":
                errors.append(f"{prefix}模板背景只能 preserve")
            protected_item = protected.get(key)
            if (
                not protected_item
                or protected_item.get("classification") != "template_background"
            ):
                errors.append(
                    f"{prefix}模板背景必须同时登记为 "
                    "protectedObjects/template_background"
                )
        if classification == "not_background" and decision.get(
            "explicitVisualReview"
        ) is not True:
            errors.append(f"{prefix}标记为 not_background 必须完成显式视觉复核")

    missing = set(candidates) - set(decisions)
    extra = set(decisions) - set(candidates)
    if missing:
        errors.append(
            "backgroundPolicy 未逐一覆盖背景候选："
            + ", ".join(f"{page}:{shape_id}" for page, shape_id in sorted(missing))
        )
    if extra:
        errors.append(
            "backgroundPolicy 包含非候选对象："
            + ", ".join(f"{page}:{shape_id}" for page, shape_id in sorted(extra))
        )

    deleted_targets: set[tuple[int, int]] = set()
    replaced_targets: set[tuple[int, int]] = set()
    for operation in operations:
        if not isinstance(operation, dict):
            continue
        try:
            slide = int(operation.get("slide", 0))
        except (TypeError, ValueError):
            continue
        targets = {(slide, value) for value in shape_ids_for(operation, groups)}
        if operation.get("action") == "delete_slot_group":
            deleted_targets.update(targets)
        elif operation.get("action") == "replace_image":
            replaced_targets.update(targets)
    for key, candidate in candidates.items():
        decision = decisions.get(key, {})
        classification = decision.get("classification")
        disposition = decision.get("disposition")
        if key in deleted_targets and not (
            classification == "not_background"
            and disposition == "delete"
            and decision.get("explicitVisualReview") is True
        ):
            errors.append(
                f"第 {key[0]} 页 shapeId={key[1]} 是背景候选，"
                "不得通过通用槽位清理删除"
            )
        if disposition == "replace" and key not in replaced_targets:
            errors.append(
                f"第 {key[0]} 页 shapeId={key[1]} 声明替换但没有 replace_image 操作"
            )
        if disposition == "delete" and key not in deleted_targets:
            errors.append(
                f"第 {key[0]} 页 shapeId={key[1]} 声明删除但没有删除操作"
            )
        if disposition == "preserve" and (
            key in deleted_targets or key in replaced_targets
        ):
            errors.append(
                f"第 {key[0]} 页 shapeId={key[1]} 声明 preserve 却进入修改操作"
            )
        candidate["decision"] = decision
    return {
        "required": True,
        "status": "passed" if len(errors) == initial_error_count else "failed",
        "preserveTemplateBackground": policy.get(
            "preserveTemplateBackground"
        )
        is True,
        "allowBackgroundDeletion": policy.get("allowBackgroundDeletion"),
        "detectedCandidates": list(candidates.values()),
    }


def _paeth(a: int, b: int, c: int) -> int:
    estimate = a + b - c
    pa = abs(estimate - a)
    pb = abs(estimate - b)
    pc = abs(estimate - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _png_transparency_audit_uncached(path: Path) -> dict[str, Any]:
    try:
        from PIL import Image

        with Image.open(path) as image:
            if image.format != "PNG" or image.mode not in {"RGBA", "LA"}:
                return {
                    "passed": False,
                    "reason": "logo PNG 必须标准化为 RGBA 或灰度+Alpha",
                    "width": image.width,
                    "height": image.height,
                    "mode": image.mode,
                }
            alpha = image.getchannel("A")
            histogram = alpha.histogram()
            total = image.width * image.height
            transparent = sum(histogram[:250])
            border_width = max(1, round(min(image.width, image.height) * 0.02))
            border_crops = (
                alpha.crop((0, 0, image.width, border_width)),
                alpha.crop(
                    (0, image.height - border_width, image.width, image.height)
                ),
                alpha.crop((0, border_width, border_width, image.height - border_width)),
                alpha.crop(
                    (
                        image.width - border_width,
                        border_width,
                        image.width,
                        image.height - border_width,
                    )
                ),
            )
            border_histogram = [0] * 256
            border_total = 0
            for crop in border_crops:
                border_total += crop.width * crop.height
                for index, count in enumerate(crop.histogram()):
                    border_histogram[index] += count
            transparent_ratio = transparent / total if total else 0
            border_ratio = (
                sum(border_histogram[:250]) / border_total
                if border_total
                else 0
            )
            return {
                "passed": transparent_ratio >= 0.01 and border_ratio >= 0.25,
                "reason": (
                    "transparent-background"
                    if transparent_ratio >= 0.01 and border_ratio >= 0.25
                    else "检测到不透明矩形画布或透明边界不足"
                ),
                "width": image.width,
                "height": image.height,
                "transparentPixelRatio": round(transparent_ratio, 5),
                "transparentBorderRatio": round(border_ratio, 5),
                "decoder": "Pillow",
            }
    except (ImportError, OSError):
        pass

    data = path.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return {"passed": False, "reason": "not-png"}
    offset = 8
    width = height = bit_depth = color_type = interlace = 0
    compressed = bytearray()
    while offset + 12 <= len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        chunk_type = data[offset + 4 : offset + 8]
        chunk = data[offset + 8 : offset + 8 + length]
        offset += 12 + length
        if chunk_type == b"IHDR":
            (
                width,
                height,
                bit_depth,
                color_type,
                _compression,
                _filter,
                interlace,
            ) = struct.unpack(">IIBBBBB", chunk)
        elif chunk_type == b"IDAT":
            compressed.extend(chunk)
        elif chunk_type == b"IEND":
            break
    if bit_depth != 8 or color_type not in {4, 6}:
        return {
            "passed": False,
            "reason": "logo PNG 必须标准化为 8-bit 灰度+Alpha或RGBA",
            "width": width,
            "height": height,
            "bitDepth": bit_depth,
            "colorType": color_type,
        }
    channels = 2 if color_type == 4 else 4
    try:
        raw = zlib.decompress(bytes(compressed))
    except zlib.error as exc:
        return {"passed": False, "reason": f"PNG IDAT 解压失败：{exc}"}
    transparent = 0
    border_transparent = 0
    border_total = 0
    total = width * height
    pointer = 0
    border_width = max(1, round(min(width, height) * 0.02))

    def consume_pass(x0: int, y0: int, dx: int, dy: int) -> None:
        nonlocal pointer, transparent, border_transparent, border_total
        pass_width = max(0, (width - x0 + dx - 1) // dx)
        pass_height = max(0, (height - y0 + dy - 1) // dy)
        if pass_width == 0 or pass_height == 0:
            return
        row_bytes = pass_width * channels
        previous = bytearray(row_bytes)
        for row_index in range(pass_height):
            filter_type = raw[pointer]
            pointer += 1
            encoded = raw[pointer : pointer + row_bytes]
            pointer += row_bytes
            decoded = bytearray(row_bytes)
            for index, value in enumerate(encoded):
                left = decoded[index - channels] if index >= channels else 0
                up = previous[index]
                up_left = previous[index - channels] if index >= channels else 0
                if filter_type == 0:
                    predictor = 0
                elif filter_type == 1:
                    predictor = left
                elif filter_type == 2:
                    predictor = up
                elif filter_type == 3:
                    predictor = (left + up) // 2
                elif filter_type == 4:
                    predictor = _paeth(left, up, up_left)
                else:
                    raise ValueError(f"unsupported PNG filter {filter_type}")
                decoded[index] = (value + predictor) & 0xFF
            y = y0 + row_index * dy
            alpha_index = 1 if color_type == 4 else 3
            for pixel_index in range(pass_width):
                x = x0 + pixel_index * dx
                alpha = decoded[pixel_index * channels + alpha_index]
                is_transparent = alpha < 250
                transparent += int(is_transparent)
                if (
                    x < border_width
                    or y < border_width
                    or x >= width - border_width
                    or y >= height - border_width
                ):
                    border_total += 1
                    border_transparent += int(is_transparent)
            previous = decoded

    passes = (
        [(0, 0, 1, 1)]
        if interlace == 0
        else [
            (0, 0, 8, 8),
            (4, 0, 8, 8),
            (0, 4, 4, 8),
            (2, 0, 4, 4),
            (0, 2, 2, 4),
            (1, 0, 2, 2),
            (0, 1, 1, 2),
        ]
    )
    try:
        for args in passes:
            consume_pass(*args)
    except (IndexError, ValueError, zlib.error) as exc:
        return {"passed": False, "reason": f"PNG Alpha 解析失败：{exc}"}
    transparent_ratio = transparent / total if total else 0
    border_ratio = border_transparent / border_total if border_total else 0
    return {
        "passed": transparent_ratio >= 0.01 and border_ratio >= 0.25,
        "reason": (
            "transparent-background"
            if transparent_ratio >= 0.01 and border_ratio >= 0.25
            else "检测到不透明矩形画布或透明边界不足"
        ),
        "width": width,
        "height": height,
        "transparentPixelRatio": round(transparent_ratio, 5),
        "transparentBorderRatio": round(border_ratio, 5),
    }


PNG_TRANSPARENCY_CACHE: dict[
    tuple[str, int, int], dict[str, Any]
] = {}


def png_transparency_audit(path: Path) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    try:
        stat = resolved.stat()
    except OSError:
        return {"passed": False, "reason": "asset-missing"}
    key = (str(resolved), stat.st_size, stat.st_mtime_ns)
    if key not in PNG_TRANSPARENCY_CACHE:
        PNG_TRANSPARENCY_CACHE[key] = _png_transparency_audit_uncached(resolved)
    return dict(PNG_TRANSPARENCY_CACHE[key])


def overlapping_logo_companions(
    template_map: dict[str, Any],
    slide: int,
    shape_id: int,
) -> list[int]:
    order = slide_object_order(template_map)
    objects = object_index(template_map)
    target = objects.get((slide, shape_id))
    if not target:
        return []
    try:
        tx, ty, tw, th = [float(value) for value in target.get("bbox", [])]
    except (TypeError, ValueError):
        return []
    if tw <= 0 or th <= 0:
        return []
    target_area = tw * th
    target_z = order.get((slide, shape_id), 0)
    companions: list[int] = []
    for (page, candidate_id), candidate in objects.items():
        if page != slide or candidate_id == shape_id:
            continue
        if str(candidate.get("text", "")).strip():
            continue
        if candidate.get("kind") != "picture" and not str(
            candidate.get("kind", "")
        ).startswith("shape:"):
            continue
        try:
            x, y, width, height = [
                float(value) for value in candidate.get("bbox", [])
            ]
        except (TypeError, ValueError):
            continue
        area = width * height
        if area <= 0 or not 0.4 <= area / target_area <= 2.5:
            continue
        intersection_width = max(0.0, min(tx + tw, x + width) - max(tx, x))
        intersection_height = max(0.0, min(ty + th, y + height) - max(ty, y))
        overlap = intersection_width * intersection_height / min(target_area, area)
        z_distance = abs(order.get((page, candidate_id), 0) - target_z)
        if overlap >= 0.8 and z_distance <= 3:
            companions.append(candidate_id)
    return sorted(companions)


def validate_logo_operation(
    operation: dict[str, Any],
    operation_index: int,
    template_map: dict[str, Any],
    protected: dict[tuple[int, int], dict[str, Any]],
    deleted_targets: set[tuple[int, int]],
    asset: Path,
    errors: list[str],
) -> dict[str, Any]:
    prefix = f"第 {operation_index} 项公司 Logo"
    slide = int(operation.get("slide", 0))
    shape_id = int(operation.get("shapeId", 0))
    if operation.get("imageFitMode") != "contain":
        errors.append(f"{prefix} imageFitMode 必须为 contain")
    if operation.get("logoTransparencyValidated") is not True:
        errors.append(f"{prefix}必须设置 logoTransparencyValidated=true")
    transparency = png_transparency_audit(asset) if asset.exists() else {
        "passed": False,
        "reason": "asset-missing",
    }
    if not transparency.get("passed"):
        errors.append(
            f"{prefix}素材未通过透明底检查：{transparency.get('reason')}"
        )
    slot_policy = operation.get("logoSlotPolicy")
    if not isinstance(slot_policy, dict):
        errors.append(f"{prefix}必须提供 logoSlotPolicy")
        slot_policy = {}
    if slot_policy.get("backgroundMode") not in {
        "transparent",
        "preserve_template_backplate",
    }:
        errors.append(
            f"{prefix} backgroundMode 必须为 transparent 或 "
            "preserve_template_backplate"
        )
    raw_companions = slot_policy.get("companionObjects")
    if not isinstance(raw_companions, list):
        errors.append(f"{prefix} companionObjects 必须是数组")
        raw_companions = []
    declared: dict[int, dict[str, Any]] = {}
    for companion in raw_companions:
        if not isinstance(companion, dict):
            errors.append(f"{prefix} companionObjects 包含非对象")
            continue
        try:
            companion_id = int(companion.get("shapeId", 0))
        except (TypeError, ValueError):
            companion_id = 0
        if companion_id <= 0 or companion_id == shape_id:
            errors.append(f"{prefix} companionObjects 包含无效 shapeId")
            continue
        if companion_id in declared:
            errors.append(f"{prefix}重复登记 companion shapeId={companion_id}")
        declared[companion_id] = companion
        role = companion.get("role")
        disposition = companion.get("disposition")
        reason = str(companion.get("reason", "")).strip()
        if role not in {
            "old_company_backplate",
            "template_backplate",
            "mask_or_frame",
            "not_backplate",
        }:
            errors.append(f"{prefix} companion role 不受支持：{role}")
        if disposition not in {"delete", "preserve"}:
            errors.append(
                f"{prefix} companion disposition 只能为 delete 或 preserve"
            )
        if len(reason) < 8:
            errors.append(f"{prefix} companion 必须提供具体复核理由")
        key = (slide, companion_id)
        if role == "old_company_backplate":
            if disposition != "delete" or key not in deleted_targets:
                errors.append(
                    f"{prefix}旧公司 Logo 底板必须进入明确的完整槽位删除操作"
                )
        elif role in {"template_backplate", "mask_or_frame"}:
            if disposition != "preserve" or key not in protected:
                errors.append(
                    f"{prefix}{role} 必须 preserve 并登记为 protectedObjects"
                )
    detected = set(overlapping_logo_companions(template_map, slide, shape_id))
    missing = detected - set(declared)
    extra = set(declared) - detected
    if missing:
        errors.append(
            f"{prefix}未审查与 Logo 高重叠的相邻对象：{sorted(missing)}"
        )
    if extra:
        errors.append(
            f"{prefix}登记了不满足高重叠条件的 companion：{sorted(extra)}"
        )
    if slot_policy.get("backgroundMode") == "transparent":
        preserved_backplates = [
            item
            for item in declared.values()
            if item.get("role") in {"old_company_backplate", "template_backplate"}
            and item.get("disposition") == "preserve"
        ]
        if preserved_backplates:
            errors.append(
                f"{prefix}透明底模式不得保留独立 Logo 底板；"
                "如底板属于模板视觉，请改用 preserve_template_backplate"
            )
    return {
        "operationIndex": operation_index,
        "slide": slide,
        "shapeId": shape_id,
        "transparency": transparency,
        "detectedCompanionShapeIds": sorted(detected),
        "declaredCompanionShapeIds": sorted(declared),
        "backgroundMode": slot_policy.get("backgroundMode"),
    }


def normalized_visible_text(value: Any) -> str:
    return re.sub(
        r"\s+",
        " ",
        unicodedata.normalize("NFKC", str(value or "")).strip(),
    ).casefold()


def is_generic_template_label(value: Any) -> bool:
    text = normalized_visible_text(value)
    if not text:
        return False
    if text in GENERIC_TEMPLATE_LABELS:
        return True
    return bool(re.fullmatch(r"(?:p(?:age)?\.?\s*)?\d{1,3}", text))


def scalar_for_exact_comparison(value: Any, unit: Any = "") -> tuple[str, Any]:
    if isinstance(value, bool):
        return ("boolean", value)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return ("number", Decimal(str(value)))
        except InvalidOperation:
            pass
    text = normalized_visible_text(value).replace(",", "").replace("，", "")
    unit_text = normalized_visible_text(unit)
    if unit_text and text.endswith(unit_text):
        text = text[: -len(unit_text)].strip()
    text = re.sub(r"^[￥¥$€£]\s*", "", text)
    text = re.sub(r"\s*(?:%|％)$", "", text)
    if re.fullmatch(r"[-+]?(?:\d+(?:\.\d+)?|\.\d+)", text):
        try:
            return ("number", Decimal(text))
        except InvalidOperation:
            pass
    return ("text", text)


def fact_value_matches_bound_value(fact: dict[str, Any], bound_value: Any) -> bool:
    fact_type = str(fact.get("factType", ""))
    expected = (
        fact.get("rawValue")
        if fact.get("rawValue") is not None
        else fact.get("renderedValue")
    )
    if fact_type in {"number", "currency", "percentage"}:
        rendered_value = scalar_for_exact_comparison(expected, fact.get("unit", ""))
        bound = scalar_for_exact_comparison(bound_value, fact.get("unit", ""))
        if rendered_value == bound:
            return True
        if (
            fact_type == "percentage"
            and fact.get("rawValue") is None
            and rendered_value[0] == "number"
            and bound[0] == "number"
            and (
                "%" in str(fact.get("renderedValue", ""))
                or "％" in str(fact.get("renderedValue", ""))
                or str(fact.get("unit", "")).strip() in {"%", "％"}
            )
        ):
            return rendered_value[1] / Decimal("100") == bound[1]
        return False
    return scalar_for_exact_comparison(expected) == scalar_for_exact_comparison(
        bound_value
    )


def canonical_text(value: Any) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or ""))
    return re.sub(r"[\s\u200b-\u200d\ufeff,，]", "", normalized)


def numeric_tokens(value: Any) -> set[str]:
    normalized = unicodedata.normalize("NFKC", str(value or ""))
    normalized = re.sub(r"[\u200b-\u200d\ufeff]", "", normalized)
    pattern = re.compile(
        r"(?<![\w.])(?:[¥￥$€£])?\d[\d,，]*(?:\.\d+)?"
        r"(?:%|％|万元|亿元|万|亿|元|人|家|项|年|月|日|倍)?"
    )
    return {canonical_text(match.group(0)) for match in pattern.finditer(normalized)}


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.expanduser().resolve().read_text(encoding="utf-8"))


def object_index(template_map: dict[str, Any]) -> dict[tuple[int, int], dict[str, Any]]:
    result: dict[tuple[int, int], dict[str, Any]] = {}
    for fallback_number, slide in enumerate(template_map.get("slides", []), 1):
        slide_number = int(slide.get("number", fallback_number))
        for item in slide.get("objects", []):
            shape_id = item.get("shapeId")
            if shape_id is not None:
                result[(slide_number, int(shape_id))] = item
    return result


def normalize_asset(value: Any) -> Path:
    return Path(str(value or "")).expanduser().resolve()


def asset_paths(value: Any) -> tuple[Path, Path]:
    raw = Path(str(value or "")).expanduser()
    return raw, raw.resolve()


def valid_iso_date(value: Any) -> bool:
    try:
        date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return False
    return True


def valid_http_url(value: Any) -> bool:
    parsed = urlparse(str(value or ""))
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def validate_research_evidence(
    manifest: dict[str, Any],
    operations: list[dict[str, Any]],
    errors: list[str],
) -> dict[str, Any]:
    schema_version = str(manifest.get("schemaVersion", ""))
    required = schema_version in RESEARCH_SCHEMA_VERSIONS
    audit: dict[str, Any] = {
        "required": required,
        "status": "not-required",
        "policy": manifest.get("researchPolicy"),
        "sources": [],
        "evidence": [],
        "operationMappings": [],
    }
    if not required:
        return audit

    initial_error_count = len(errors)
    policy = manifest.get("researchPolicy")
    if not isinstance(policy, dict):
        errors.append("1.3 及以上版本必须提供 researchPolicy")
        policy = {}
    if policy.get("enabled") is not True:
        errors.append("1.3 及以上版本 researchPolicy.enabled 必须为 true")
    if not valid_iso_date(policy.get("asOfDate")):
        errors.append("researchPolicy.asOfDate 必须是 YYYY-MM-DD")
    minimum_sources = policy.get("minimumIndependentSources", 2)
    if not isinstance(minimum_sources, int) or minimum_sources < 2:
        errors.append("minimumIndependentSources 必须是不小于 2 的整数")
        minimum_sources = 2
    if policy.get("unresolvedPolicy") not in {
        "mark-not-disclosed-or-delete-optional",
        "mark-pending-verification-or-delete-optional",
    }:
        errors.append("researchPolicy.unresolvedPolicy 不受支持")

    raw_sources = manifest.get("sources")
    if not isinstance(raw_sources, list):
        errors.append("1.3 及以上版本 sources 必须是数组")
        raw_sources = []
    sources: dict[str, dict[str, Any]] = {}
    for index, source in enumerate(raw_sources, 1):
        prefix = f"第 {index} 个来源"
        if not isinstance(source, dict):
            errors.append(f"{prefix}必须是对象")
            continue
        source_id = str(source.get("sourceId", "")).strip()
        source_type = source.get("sourceType")
        if not source_id:
            errors.append(f"{prefix}缺少 sourceId")
            continue
        if source_id in sources:
            errors.append(f"{prefix} sourceId 重复：{source_id}")
            continue
        sources[source_id] = source
        if source_type not in SOURCE_TYPES:
            errors.append(f"{prefix} sourceType 不受支持：{source_type}")
        for field in ("title", "publisher", "accessedDate"):
            if not str(source.get(field, "")).strip():
                errors.append(f"{prefix}缺少非空字段 {field}")
        if not valid_iso_date(source.get("accessedDate")):
            errors.append(f"{prefix} accessedDate 必须是 YYYY-MM-DD")
        published_date = source.get("publishedDate")
        if published_date and not valid_iso_date(published_date):
            errors.append(f"{prefix} publishedDate 必须是 YYYY-MM-DD")
        if source_type in WEB_SOURCE_TYPES and not valid_http_url(
            source.get("url")
        ):
            errors.append(f"{prefix}网络来源必须提供有效 http/https URL")
        if source_type == "user_material" and not str(
            source.get("locator", "")
        ).strip():
            errors.append(f"{prefix}用户材料必须提供 locator 页码或文件定位")
        audit["sources"].append(
            {
                "sourceId": source_id,
                "sourceType": source_type,
                "title": source.get("title"),
                "publisher": source.get("publisher"),
                "url": source.get("url"),
                "accessedDate": source.get("accessedDate"),
                "status": "registered",
            }
        )

    raw_evidence = manifest.get("evidenceRegistry")
    if not isinstance(raw_evidence, list):
        errors.append("1.3 及以上版本 evidenceRegistry 必须是数组")
        raw_evidence = []
    evidence: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(raw_evidence, 1):
        prefix = f"第 {index} 条证据"
        if not isinstance(item, dict):
            errors.append(f"{prefix}必须是对象")
            continue
        evidence_id = str(item.get("evidenceId", "")).strip()
        if not evidence_id:
            errors.append(f"{prefix}缺少 evidenceId")
            continue
        if evidence_id in evidence:
            errors.append(f"{prefix} evidenceId 重复：{evidence_id}")
            continue
        evidence[evidence_id] = item
        for field in ("claim", "confidence", "asOfDate"):
            if not str(item.get(field, "")).strip():
                errors.append(f"{prefix}缺少非空字段 {field}")
        semantic_keys = item.get("semanticKeys")
        if not isinstance(semantic_keys, list) or not semantic_keys:
            errors.append(f"{prefix} semanticKeys 必须是非空数组")
            semantic_keys = []
        elif len(set(semantic_keys)) != len(semantic_keys):
            errors.append(f"{prefix} semanticKeys 不得重复")
        elif any(not str(value).strip() for value in semantic_keys):
            errors.append(f"{prefix} semanticKeys 不能包含空值")
        if not valid_iso_date(item.get("asOfDate")):
            errors.append(f"{prefix} asOfDate 必须是 YYYY-MM-DD")
        value_type = item.get("valueType")
        status = item.get("status")
        materiality = item.get("materiality")
        if value_type not in EVIDENCE_VALUE_TYPES:
            errors.append(f"{prefix} valueType 不受支持：{value_type}")
        if status not in EVIDENCE_STATUSES:
            errors.append(f"{prefix} status 不受支持：{status}")
        if materiality not in {"basic", "material"}:
            errors.append(f"{prefix} materiality 必须为 basic 或 material")
        if item.get("confidence") not in {"high", "medium", "low"}:
            errors.append(f"{prefix} confidence 不受支持")
        source_ids = item.get("sourceIds")
        if not isinstance(source_ids, list):
            errors.append(f"{prefix} sourceIds 必须是数组")
            source_ids = []
        elif len(set(source_ids)) != len(source_ids):
            errors.append(f"{prefix} sourceIds 不得重复")
        linked_sources: list[dict[str, Any]] = []
        for source_id in source_ids:
            source = sources.get(str(source_id))
            if not source:
                errors.append(f"{prefix}引用不存在的 sourceId={source_id}")
            else:
                linked_sources.append(source)

        if value_type == "unavailable":
            if status != "not-found":
                errors.append(f"{prefix} unavailable 必须设置 status=not-found")
        elif not linked_sources:
            errors.append(f"{prefix}非 unavailable 证据必须引用至少一个来源")

        if value_type == "user-provided" and not any(
            source.get("sourceType") == "user_material"
            for source in linked_sources
        ):
            errors.append(f"{prefix} user-provided 必须引用 user_material")
        if value_type == "official-fact" and not any(
            source.get("sourceType") in PRIMARY_SOURCE_TYPES - {"user_material"}
            for source in linked_sources
        ):
            errors.append(f"{prefix} official-fact 必须引用官方或一手来源")
        if value_type == "corroborated-fact":
            publishers = {
                str(source.get("publisher", "")).strip().casefold()
                for source in linked_sources
                if str(source.get("publisher", "")).strip()
            }
            if len(publishers) < minimum_sources:
                errors.append(
                    f"{prefix} corroborated-fact 至少需要 "
                    f"{minimum_sources} 个独立发布方"
                )
        if value_type == "derived" and not str(item.get("formula", "")).strip():
            errors.append(f"{prefix} derived 必须记录 formula")
        if value_type == "estimate":
            assumptions = item.get("assumptions")
            if not isinstance(assumptions, list) or not any(
                str(value).strip() for value in assumptions
            ):
                errors.append(f"{prefix} estimate 必须记录非空 assumptions")
        if materiality == "material" and value_type not in {
            "unavailable",
            "user-provided",
        }:
            has_primary = any(
                source.get("sourceType")
                in PRIMARY_SOURCE_TYPES - {"user_material"}
                for source in linked_sources
            )
            publishers = {
                str(source.get("publisher", "")).strip().casefold()
                for source in linked_sources
                if str(source.get("publisher", "")).strip()
            }
            if not has_primary and len(publishers) < minimum_sources:
                errors.append(
                    f"{prefix}重大数据必须有官方一手来源，或至少 "
                    f"{minimum_sources} 个独立可信发布方"
                )
        audit["evidence"].append(
            {
                "evidenceId": evidence_id,
                "claim": item.get("claim"),
                "valueType": value_type,
                "materiality": materiality,
                "status": status,
                "sourceIds": source_ids,
                "semanticKeys": semantic_keys,
                "confidence": item.get("confidence"),
                "statusLabel": "registered",
            }
        )

    for index, operation in enumerate(operations, 1):
        if not isinstance(operation, dict):
            continue
        prefix = f"第 {index} 项"
        if operation.get("action") == "add_disclaimer_textbox":
            audit["operationMappings"].append(
                {
                    "operationIndex": index,
                    "slide": operation.get("slide"),
                    "role": operation.get("role"),
                    "evidenceIds": operation.get("evidenceIds", []),
                    "status": "system-responsibility-statement",
                }
            )
            continue
        evidence_ids = operation.get("evidenceIds")
        if not isinstance(evidence_ids, list) or not evidence_ids:
            errors.append(f"{prefix}1.3 及以上版本操作必须包含非空 evidenceIds")
            evidence_ids = []
        elif len(set(evidence_ids)) != len(evidence_ids):
            errors.append(f"{prefix} evidenceIds 不得重复")
        linked_evidence: list[dict[str, Any]] = []
        for evidence_id in evidence_ids:
            item = evidence.get(str(evidence_id))
            if not item:
                errors.append(f"{prefix}引用不存在的 evidenceId={evidence_id}")
            else:
                linked_evidence.append(item)
        operation_text = str(operation.get("text", ""))
        qualifier = str(operation.get("displayQualifier", ""))
        visible_text = f"{operation_text} {qualifier}"
        operation_semantic_key = str(
            operation.get("semanticKey", "")
        ).strip()
        for item in linked_evidence:
            supported_keys = {
                str(value).strip()
                for value in item.get("semanticKeys", [])
                if str(value).strip()
            }
            if operation_semantic_key not in supported_keys:
                errors.append(
                    f"{prefix}证据 {item.get('evidenceId')} 不支持 "
                    f"semanticKey={operation_semantic_key}"
                )
        if any(item.get("valueType") == "estimate" for item in linked_evidence):
            if not any(label in visible_text for label in ("估算", "测算")):
                errors.append(
                    f"{prefix}估算数据必须在可见文字或 displayQualifier 中标注估算/测算"
                )
        if any(item.get("status") == "conflicting" for item in linked_evidence):
            if not any(label in visible_text for label in CAUTIOUS_LABELS):
                errors.append(
                    f"{prefix}来源存在冲突，必须显示待核实、存在差异或口径不一致"
                )
        unavailable = [
            item
            for item in linked_evidence
            if item.get("valueType") == "unavailable"
        ]
        if unavailable:
            if operation.get("action") == "delete_slot_group":
                pass
            elif operation.get("action") in TEXT_ACTIONS:
                if not any(label in operation_text for label in UNAVAILABLE_LABELS):
                    errors.append(
                        f"{prefix}未检索到证据时只能显示未披露/待核实/"
                        "公开信息未检索到，或删除完整可选槽位"
                    )
                if schema_version in PAGE_CLOSURE_SCHEMA_VERSIONS:
                    gap_slides = {
                        int(value)
                        for value in (
                            manifest.get("residualPolicy", {}).get(
                                "gapSlideNumbers",
                                [],
                            )
                            if isinstance(manifest.get("residualPolicy"), dict)
                            else []
                        )
                    }
                    if int(operation.get("slide", 0)) not in gap_slides:
                        errors.append(
                            f"{prefix}1.4/1.5 版未披露/待核实内容只能写入专用缺口页"
                        )
            else:
                errors.append(
                    f"{prefix}未检索到证据不能支持图片、图表或表格替换"
                )
        audit["operationMappings"].append(
            {
                "operationIndex": index,
                "slide": operation.get("slide"),
                "role": operation.get("role"),
                "evidenceIds": evidence_ids,
                "status": "mapped" if linked_evidence else "unmapped",
            }
        )
    audit["status"] = (
        "passed" if len(errors) == initial_error_count else "failed"
    )
    return audit


def style_snapshot(target: dict[str, Any]) -> dict[str, Any]:
    snapshot = {
        "bbox": target.get("bbox"),
        "textStyle": target.get("textStyle"),
        "kind": target.get("kind"),
        "role": target.get("role"),
        "zIndex": target.get("zIndex"),
    }
    digest = hashlib.sha256(
        json.dumps(snapshot, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return {"fingerprint": digest, **snapshot}


def derived_text_capacity(target: dict[str, Any]) -> tuple[int, int]:
    bbox = target.get("bbox") or [0, 0, 0, 0]
    width = float(bbox[2]) if len(bbox) >= 4 else 0
    height = float(bbox[3]) if len(bbox) >= 4 else 0
    font_size = float(
        target.get("textStyle", {}).get("run", {}).get("fontSize", 0) or 0
    )
    original = str(target.get("text", ""))
    original_lines = max(1, original.count("\n") + 1)
    if width <= 0 or height <= 0 or font_size <= 0:
        original_chars = len(original.replace("\n", ""))
        return max(1, max(original_chars + 4, int(original_chars * 1.2))), original_lines
    font_px = font_size * 96 / 72
    max_lines = max(1, int(height / max(1.0, font_px * 1.15)))
    chars_per_line = max(1, int(width / max(1.0, font_px * 0.9)))
    return max_lines * chars_per_line, max_lines


def validate_conversion_handoff(
    manifest: dict[str, Any],
    template_map: dict[str, Any],
    errors: list[str],
) -> dict[str, Any]:
    initial_error_count = len(errors)
    schema_version = str(manifest.get("schemaVersion", ""))
    source_mode = manifest.get("sourceMode")
    audit: dict[str, Any] = {
        "sourceMode": source_mode,
        "required": (
            schema_version in STRICT_SLOT_SCHEMA_VERSIONS
            and source_mode == "pdf-converted"
        ),
        "status": "not-required",
    }
    if schema_version not in STRICT_SLOT_SCHEMA_VERSIONS:
        return audit
    if source_mode not in {"pdf-converted", "native-pptx"}:
        errors.append("1.2 及以上版本必须设置 sourceMode=pdf-converted 或 native-pptx")
        audit["status"] = "invalid-source-mode"
        return audit
    if source_mode == "native-pptx":
        audit["status"] = "native-pptx"
        return audit

    raw_path = Path(str(manifest.get("conversionHandoff", ""))).expanduser()
    if not raw_path.is_absolute():
        errors.append("PDF 转换底稿必须提供绝对路径 conversionHandoff")
        audit["status"] = "missing"
        return audit
    handoff_path = raw_path.resolve()
    if not handoff_path.exists():
        errors.append(f"conversionHandoff 不存在：{handoff_path}")
        audit["status"] = "missing"
        return audit
    try:
        handoff = json.loads(handoff_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"conversionHandoff 无法读取：{exc}")
        audit["status"] = "unreadable"
        return audit

    audit.update(
        {
            "path": str(handoff_path),
            "producerSkill": handoff.get("producerSkill"),
            "watermarkQaPassed": handoff.get("watermarkQaPassed") is True,
            "editabilityReviewPassed": handoff.get("editabilityReviewPassed")
            is True,
            "readyForContentReplacement": handoff.get(
                "readyForContentReplacement"
            )
            is True,
            "unresolvedEditablePages": handoff.get(
                "unresolvedEditablePages", []
            ),
            "pathBinding": handoff.get("pathBinding", "exact"),
            "pathRebased": False,
        }
    )
    if handoff.get("producerSkill") != "pdf-to-editable-ppt":
        errors.append("conversionHandoff 不是由 pdf-to-editable-ppt 生成")
    template_pptx = Path(str(manifest.get("templatePptx", ""))).expanduser().resolve()
    handoff_pptx = Path(str(handoff.get("templatePptx", ""))).expanduser().resolve()
    if handoff_pptx != template_pptx:
        if handoff.get("pathBinding") == "sha256":
            audit["pathRebased"] = True
            audit["originalTemplatePptx"] = str(handoff_pptx)
            audit["currentTemplatePptx"] = str(template_pptx)
        else:
            errors.append("conversionHandoff 的 templatePptx 与替换模板不一致")
    expected_sha = str(manifest.get("templateSha256", ""))
    if handoff.get("templateSha256") != expected_sha:
        errors.append("conversionHandoff 的模板 SHA-256 与替换清单不一致")
    if handoff.get("templateSha256") != template_map.get("sha256"):
        errors.append("conversionHandoff 的模板 SHA-256 与对象地图不一致")
    if handoff.get("watermarkQaPassed") is not True:
        errors.append("PDF 转换底稿未通过最终水印交接验收")
    if handoff.get("watermarkPolicy") == "keep":
        errors.append("PDF 转换底稿保留了水印，不能进入内容替换")
    if handoff.get("editabilityReviewPassed") is not True:
        errors.append("PDF 转换底稿仍有未复核的大面积内嵌图片")
    unresolved = handoff.get("unresolvedEditablePages") or []
    if unresolved:
        errors.append(f"PDF 转换底稿仍有未元素化页面：{unresolved}")
    if handoff.get("readyForContentReplacement") is not True:
        errors.append("conversionHandoff 未授权进入内容替换阶段")
    qa_report_path = Path(str(handoff.get("watermarkQaReport", ""))).expanduser()
    relative_report = str(
        handoff.get("watermarkQaReportRelative", "")
    ).strip()
    relative_report_valid = False
    if relative_report and handoff.get("pathBinding") == "sha256":
        relative_path = Path(relative_report)
        candidate = (handoff_path.parent / relative_path).resolve()
        try:
            inside_handoff_dir = candidate.is_relative_to(
                handoff_path.parent.resolve()
            )
        except AttributeError:
            inside_handoff_dir = (
                handoff_path.parent.resolve() in candidate.parents
            )
        if (
            not relative_path.is_absolute()
            and inside_handoff_dir
            and candidate.is_file()
        ):
            qa_report_path = candidate
            relative_report_valid = True
            audit["watermarkQaReportRebased"] = (
                candidate
                != Path(
                    str(handoff.get("watermarkQaReport", ""))
                ).expanduser()
            )
    if audit.get("pathRebased") and not relative_report_valid:
        errors.append(
            "迁移后的 conversionHandoff 缺少交接目录内的有效水印 QA 相对报告"
        )
    if not qa_report_path.is_absolute() or not qa_report_path.is_file():
        errors.append("conversionHandoff 缺少有效 watermarkQaReport")
    else:
        expected_qa_sha = str(
            handoff.get("watermarkQaReportSha256", "")
        ).strip()
        actual_qa_sha = hashlib.sha256(qa_report_path.read_bytes()).hexdigest()
        if handoff.get("schemaVersion") == "1.1" and not expected_qa_sha:
            errors.append("1.1 版 conversionHandoff 缺少水印 QA 报告 SHA-256")
        elif expected_qa_sha and expected_qa_sha != actual_qa_sha:
            errors.append("watermarkQaReport 的 SHA-256 与交接证书不一致")
        try:
            qa_report = json.loads(qa_report_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            qa_report = {}
        if qa_report.get("passed") is not True:
            errors.append("watermarkQaReport 未通过")
    editability_report_path = Path(
        str(handoff.get("editabilityReport", ""))
    ).expanduser()
    relative_editability = str(
        handoff.get("editabilityReportRelative", "")
    ).strip()
    relative_editability_valid = False
    if relative_editability and handoff.get("pathBinding") == "sha256":
        relative_path = Path(relative_editability)
        candidate = (handoff_path.parent / relative_path).resolve()
        try:
            inside_handoff_dir = candidate.is_relative_to(
                handoff_path.parent.resolve()
            )
        except AttributeError:
            inside_handoff_dir = (
                handoff_path.parent.resolve() in candidate.parents
            )
        if (
            not relative_path.is_absolute()
            and inside_handoff_dir
            and candidate.is_file()
        ):
            editability_report_path = candidate
            relative_editability_valid = True
            audit["editabilityReportRebased"] = True
    if audit.get("pathRebased") and not relative_editability_valid:
        errors.append(
            "迁移后的 conversionHandoff 缺少交接目录内的有效可编辑性相对报告"
        )
    if (
        handoff.get("schemaVersion") == "1.1"
        and (
            not editability_report_path.is_absolute()
            or not editability_report_path.is_file()
        )
    ):
        errors.append("1.1 版 conversionHandoff 缺少有效 editabilityReport")
    elif editability_report_path.is_file():
        expected_editability_sha = str(
            handoff.get("editabilityReportSha256", "")
        ).strip()
        actual_editability_sha = hashlib.sha256(
            editability_report_path.read_bytes()
        ).hexdigest()
        if handoff.get("schemaVersion") == "1.1" and not expected_editability_sha:
            errors.append("1.1 版 conversionHandoff 缺少可编辑性报告 SHA-256")
        elif (
            expected_editability_sha
            and expected_editability_sha != actual_editability_sha
        ):
            errors.append("editabilityReport 的 SHA-256 与交接证书不一致")
    audit["status"] = (
        "passed" if len(errors) == initial_error_count else "failed"
    )
    return audit


def slot_group_index(
    manifest: dict[str, Any],
    objects: dict[tuple[int, int], dict[str, Any]],
    errors: list[str],
) -> tuple[dict[str, dict[str, Any]], dict[tuple[int, int], str], list[dict[str, Any]]]:
    groups: dict[str, dict[str, Any]] = {}
    shape_membership: dict[tuple[int, int], str] = {}
    audit: list[dict[str, Any]] = []
    raw_groups = manifest.get("slotGroups", [])
    if not isinstance(raw_groups, list):
        errors.append("slotGroups 必须是数组")
        return groups, shape_membership, audit
    for index, group in enumerate(raw_groups, 1):
        prefix = f"第 {index} 个槽位组"
        if not isinstance(group, dict):
            errors.append(f"{prefix}必须是对象")
            continue
        group_id = str(group.get("slotGroupId", "")).strip()
        if not group_id:
            errors.append(f"{prefix}缺少 slotGroupId")
            continue
        if group_id in groups:
            errors.append(f"{prefix} slotGroupId 重复：{group_id}")
            continue
        groups[group_id] = group
        try:
            slide = int(group.get("slide", 0))
        except (TypeError, ValueError):
            slide = 0
        if slide <= 0:
            errors.append(f"{prefix} slide 必须是正整数")
        shape_ids = group.get("shapeIds")
        content_ids = group.get("contentShapeIds")
        decoration_ids = group.get("decorationShapeIds")
        if not isinstance(shape_ids, list) or not shape_ids:
            errors.append(f"{prefix} shapeIds 必须是非空数组")
            shape_ids = []
        if not isinstance(content_ids, list):
            errors.append(f"{prefix} contentShapeIds 必须是数组")
            content_ids = []
        if not isinstance(decoration_ids, list):
            errors.append(f"{prefix} decorationShapeIds 必须是数组")
            decoration_ids = []
        try:
            shape_set = {int(value) for value in shape_ids}
            content_set = {int(value) for value in content_ids}
            decoration_set = {int(value) for value in decoration_ids}
        except (TypeError, ValueError):
            errors.append(f"{prefix} shapeIds 只能包含整数")
            shape_set, content_set, decoration_set = set(), set(), set()
        if len(shape_set) != len(shape_ids):
            errors.append(f"{prefix} shapeIds 不得重复")
        if content_set & decoration_set:
            errors.append(f"{prefix}内容对象与装饰对象不得重叠")
        if content_set | decoration_set != shape_set:
            errors.append(
                f"{prefix} contentShapeIds 与 decorationShapeIds 的并集必须等于 shapeIds"
            )
        if group.get("layoutPolicy") != "preserve-grid":
            errors.append(f"{prefix} layoutPolicy 必须为 preserve-grid")
        for shape_id in shape_set:
            key = (slide, shape_id)
            if key not in objects:
                errors.append(f"{prefix}未找到第 {slide} 页 shapeId={shape_id}")
            if key in shape_membership:
                errors.append(
                    f"{prefix} shapeId={shape_id} 已属于槽位组 "
                    f"{shape_membership[key]}"
                )
            shape_membership[key] = group_id
        audit.append(
            {
                "slotGroupId": group_id,
                "slide": slide,
                "groupType": group.get("groupType"),
                "optional": group.get("optional") is True,
                "shapeIds": sorted(shape_set),
                "contentShapeIds": sorted(content_set),
                "decorationShapeIds": sorted(decoration_set),
                "status": "declared",
            }
        )
    return groups, shape_membership, audit


def protected_object_index(
    manifest: dict[str, Any],
    objects: dict[tuple[int, int], dict[str, Any]],
    errors: list[str],
) -> tuple[dict[tuple[int, int], dict[str, Any]], list[dict[str, Any]]]:
    protected: dict[tuple[int, int], dict[str, Any]] = {}
    audit: list[dict[str, Any]] = []
    raw_items = manifest.get("protectedObjects", [])
    if not isinstance(raw_items, list):
        errors.append("protectedObjects 必须是数组")
        return protected, audit
    for index, item in enumerate(raw_items, 1):
        prefix = f"第 {index} 个保护对象"
        if not isinstance(item, dict):
            errors.append(f"{prefix}必须是对象")
            continue
        try:
            slide = int(item.get("slide", 0))
            shape_id = int(item.get("shapeId", 0))
        except (TypeError, ValueError):
            slide, shape_id = 0, 0
        key = (slide, shape_id)
        classification = item.get("classification")
        if slide <= 0 or shape_id <= 0:
            errors.append(f"{prefix}必须包含有效 slide 和 shapeId")
        elif key not in objects:
            errors.append(f"{prefix}未找到第 {slide} 页 shapeId={shape_id}")
        elif key in protected:
            errors.append(f"{prefix}重复保护第 {slide} 页 shapeId={shape_id}")
        if classification not in PROTECTED_CLASSES:
            errors.append(f"{prefix} classification 不受支持：{classification}")
        reason = str(item.get("reason", "")).strip()
        if not reason:
            errors.append(f"{prefix}缺少 reason")
        if str(manifest.get("schemaVersion", "")) in CONTENT_SAFE_SCHEMA_VERSIONS:
            if len(reason) < 8 or reason in GENERIC_KEEP_REASONS:
                errors.append(f"{prefix}必须写明具体、可复核的保护理由")
            target = objects.get(key, {})
            if (
                str(target.get("text", "")).strip()
                and classification in {"fixed_visual", "generic_decoration"}
            ):
                errors.append(
                    f"{prefix}包含可见文字，不能分类为 {classification}；"
                    "请使用 template_label、template_brand 或内容槽"
                )
            if str(target.get("text", "")).strip() and classification == "template_brand":
                errors.append(
                    f"{prefix}可见文字不能作为 template_brand 原样保留；"
                    "新项目品牌文字必须通过内容槽替换"
                )
            if (
                str(target.get("text", "")).strip()
                and classification == "template_label"
                and not is_generic_template_label(target.get("text"))
            ):
                errors.append(
                    f"{prefix}文字不是封闭词表中的通用模板标签；"
                    "项目相关或中性正文必须替换、删除或绑定证据"
                )
        protected[key] = item
        audit.append(
            {
                "slide": slide,
                "shapeId": shape_id,
                "classification": classification,
                "reason": item.get("reason"),
                "status": "locked",
            }
        )
    return protected, audit


def slot_assignment_index(
    manifest: dict[str, Any],
    objects: dict[tuple[int, int], dict[str, Any]],
    groups: dict[str, dict[str, Any]],
    protected: dict[tuple[int, int], dict[str, Any]],
    errors: list[str],
) -> tuple[
    dict[str, dict[str, Any]],
    dict[tuple[int, int], str],
    list[dict[str, Any]],
]:
    assignments: dict[str, dict[str, Any]] = {}
    shape_assignments: dict[tuple[int, int], str] = {}
    audit: list[dict[str, Any]] = []
    raw_assignments = manifest.get("slotAssignments", [])
    if not isinstance(raw_assignments, list):
        errors.append("slotAssignments 必须是数组")
        return assignments, shape_assignments, audit
    referenced_groups: dict[str, str] = {}
    for index, assignment in enumerate(raw_assignments, 1):
        prefix = f"第 {index} 个槽位分配"
        if not isinstance(assignment, dict):
            errors.append(f"{prefix}必须是对象")
            continue
        assignment_id = str(assignment.get("assignmentId", "")).strip()
        if not assignment_id:
            errors.append(f"{prefix}缺少 assignmentId")
            continue
        if assignment_id in assignments:
            errors.append(f"{prefix} assignmentId 重复：{assignment_id}")
            continue
        assignments[assignment_id] = assignment
        try:
            slide = int(assignment.get("slide", 0))
            shape_ids = [int(value) for value in assignment.get("shapeIds", [])]
            expected_ids = [
                int(value)
                for value in assignment.get("expectedContentShapeIds", [])
            ]
        except (TypeError, ValueError):
            slide, shape_ids, expected_ids = 0, [], []
            errors.append(f"{prefix}页码和对象编号必须是整数")
        if slide <= 0 or not shape_ids:
            errors.append(f"{prefix}必须包含有效 slide 和非空 shapeIds")
        if len(set(shape_ids)) != len(shape_ids):
            errors.append(f"{prefix} shapeIds 不得重复")
        if not set(expected_ids).issubset(set(shape_ids)):
            errors.append(f"{prefix} expectedContentShapeIds 必须属于 shapeIds")
        semantic_key = str(assignment.get("semanticKey", "")).strip()
        semantic_role = str(assignment.get("semanticRole", "")).strip()
        requirement = assignment.get("requirement")
        disposition = assignment.get("disposition")
        if not semantic_key or not semantic_role:
            errors.append(f"{prefix}缺少 semanticKey 或 semanticRole")
        if requirement == "required" and disposition != "replace":
            errors.append(f"{prefix}必填槽位只能使用 disposition=replace")
        elif requirement == "optional" and disposition not in {"replace", "delete"}:
            errors.append(f"{prefix}可选槽位只能替换或整组删除")
        elif requirement in {"shared", "template"} and disposition != "keep":
            errors.append(f"{prefix}共享/模板槽位必须保持不变")
        elif requirement not in {"required", "optional", "shared", "template"}:
            errors.append(f"{prefix} requirement 不受支持：{requirement}")
        if disposition == "replace" and not expected_ids:
            errors.append(f"{prefix}替换槽位必须声明 expectedContentShapeIds")
        group_id = str(assignment.get("slotGroupId", "")).strip()
        if group_id:
            group = groups.get(group_id)
            if not group:
                errors.append(f"{prefix}未找到 slotGroupId={group_id}")
            else:
                if int(group.get("slide", 0)) != slide:
                    errors.append(f"{prefix}与 slotGroupId={group_id} 不在同一页")
                group_ids = {int(value) for value in group.get("shapeIds", [])}
                if set(shape_ids) != group_ids:
                    errors.append(
                        f"{prefix} shapeIds 必须完整覆盖槽位组 {group_id}"
                    )
                if group_id in referenced_groups:
                    errors.append(
                        f"{prefix}槽位组 {group_id} 已由 "
                        f"{referenced_groups[group_id]} 分配"
                    )
                referenced_groups[group_id] = assignment_id
                if disposition == "delete" and group.get("optional") is not True:
                    errors.append(f"{prefix}只能删除 optional=true 的槽位组")
        elif disposition == "delete":
            errors.append(f"{prefix}删除槽位必须提供 slotGroupId")

        for shape_id in shape_ids:
            key = (slide, shape_id)
            if key not in objects:
                errors.append(f"{prefix}未找到第 {slide} 页 shapeId={shape_id}")
            if key in shape_assignments:
                errors.append(
                    f"{prefix}对象已由 {shape_assignments[key]} 分配"
                )
            shape_assignments[key] = assignment_id
            if key in protected and requirement not in {"shared", "template"}:
                errors.append(f"{prefix}受保护对象只能作为共享/模板槽位保持不变")
        audit.append(
            {
                "assignmentId": assignment_id,
                "slide": slide,
                "slotGroupId": group_id or None,
                "semanticKey": semantic_key,
                "semanticRole": semantic_role,
                "requirement": requirement,
                "disposition": disposition,
                "shapeIds": shape_ids,
                "expectedContentShapeIds": expected_ids,
                "status": "declared",
            }
        )
    if manifest.get("schemaVersion") in STRICT_SLOT_SCHEMA_VERSIONS:
        for group_id in groups:
            if group_id not in referenced_groups:
                errors.append(f"槽位组 {group_id} 未进入 slotAssignments 覆盖清单")
    return assignments, shape_assignments, audit


def validate_slot_coverage(
    assignments: dict[str, dict[str, Any]],
    shape_assignments: dict[tuple[int, int], str],
    operations: list[dict[str, Any]],
    groups: dict[str, dict[str, Any]],
    errors: list[str],
) -> list[dict[str, Any]]:
    operations_by_target: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for operation in operations:
        if not isinstance(operation, dict):
            continue
        try:
            slide = int(operation.get("slide", 0))
        except (TypeError, ValueError):
            continue
        for shape_id in shape_ids_for(operation, groups):
            operations_by_target.setdefault((slide, shape_id), []).append(operation)

    audit: list[dict[str, Any]] = []
    for assignment_id, assignment in assignments.items():
        slide = int(assignment.get("slide", 0))
        disposition = assignment.get("disposition")
        expected_ids = [
            int(value)
            for value in assignment.get("expectedContentShapeIds", [])
        ]
        shape_ids = [int(value) for value in assignment.get("shapeIds", [])]
        missing: list[int] = []
        unexpected: list[int] = []
        blank: list[int] = []
        if disposition == "replace":
            for shape_id in expected_ids:
                target_ops = operations_by_target.get((slide, shape_id), [])
                if not target_ops:
                    missing.append(shape_id)
                    continue
                for operation in target_ops:
                    if (
                        operation.get("action") in TEXT_ACTIONS
                        and not str(
                            operation_text_for_shape(operation, shape_id) or ""
                        ).strip()
                    ):
                        blank.append(shape_id)
        elif disposition == "delete":
            for shape_id in shape_ids:
                target_ops = operations_by_target.get((slide, shape_id), [])
                if not any(
                    operation.get("action") == "delete_slot_group"
                    for operation in target_ops
                ):
                    missing.append(shape_id)
        elif disposition == "keep":
            for shape_id in shape_ids:
                if operations_by_target.get((slide, shape_id)):
                    unexpected.append(shape_id)
        if missing:
            errors.append(
                f"槽位分配 {assignment_id} 缺少内容或完整删除操作：{missing}"
            )
        if blank:
            errors.append(
                f"槽位分配 {assignment_id} 的必填文字为空：{sorted(set(blank))}"
            )
        if unexpected:
            errors.append(
                f"槽位分配 {assignment_id} 应保持不变但被修改：{unexpected}"
            )
        audit.append(
            {
                "assignmentId": assignment_id,
                "slide": slide,
                "semanticKey": assignment.get("semanticKey"),
                "disposition": disposition,
                "missingShapeIds": missing,
                "blankShapeIds": sorted(set(blank)),
                "unexpectedShapeIds": unexpected,
                "status": (
                    "covered"
                    if not missing and not blank and not unexpected
                    else "failed"
                ),
            }
        )
    return audit


def shape_ids_for(
    operation: dict[str, Any], groups: dict[str, dict[str, Any]]
) -> list[int]:
    action = operation.get("action")
    if action == "replace_text_group":
        try:
            return [int(value) for value in operation.get("shapeIds", [])]
        except (TypeError, ValueError):
            return []
    if action == "delete_slot_group":
        group = groups.get(str(operation.get("slotGroupId", "")))
        if not group:
            return []
        try:
            return [int(value) for value in group.get("shapeIds", [])]
        except (TypeError, ValueError):
            return []
    shape_id = operation.get("shapeId")
    return [int(shape_id)] if isinstance(shape_id, int) else []


def operation_text_for_shape(
    operation: dict[str, Any], shape_id: int
) -> str | None:
    if operation.get("action") == "replace_text" and operation.get("shapeId") == shape_id:
        return operation.get("text") if isinstance(operation.get("text"), str) else None
    if operation.get("action") == "replace_text_group":
        if shape_id in operation.get("shapeIds", []):
            if operation.get("groupMode") in {"fragment-map", "line-reflow"}:
                for fragment in operation.get("fragmentTexts", []):
                    if (
                        isinstance(fragment, dict)
                        and fragment.get("shapeId") == shape_id
                        and isinstance(fragment.get("text"), str)
                    ):
                        return fragment["text"]
                return None
            primary = operation.get("primaryShapeId")
            if primary is None:
                shape_ids = operation.get("shapeIds", [])
                primary = shape_ids[0] if shape_ids else None
            if shape_id != primary:
                return ""
            return operation.get("text") if isinstance(operation.get("text"), str) else None
    return None


def resolve_operation_path(operation: dict[str, Any], path: str) -> Any:
    if not re.fullmatch(
        r"[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\]|\.[A-Za-z_][A-Za-z0-9_]*)*",
        path,
    ):
        raise ValueError("unsupported path")
    tokens = re.findall(r"([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]", path)
    current: Any = operation
    for name, index in tokens:
        if name:
            if not isinstance(current, dict) or name not in current:
                raise ValueError("missing key")
            current = current[name]
        else:
            if not isinstance(current, list):
                raise ValueError("not a list")
            current = current[int(index)]
    return current


def validate_entity_bindings(
    manifest: dict[str, Any],
    objects: dict[tuple[int, int], dict[str, Any]],
    groups: dict[str, dict[str, Any]],
    operations: list[dict[str, Any]],
    errors: list[str],
    require_relationships: bool,
) -> list[dict[str, Any]]:
    strict_identity = (
        str(manifest.get("schemaVersion", "")) in PAGE_CLOSURE_SCHEMA_VERSIONS
    )
    raw_bindings = manifest.get("entityBindings", [])
    if not isinstance(raw_bindings, list):
        errors.append("entityBindings 必须是数组")
        return []
    bindings: dict[str, dict[str, Any]] = {}
    image_targets: dict[tuple[int, int], str] = {}
    label_targets: dict[tuple[int, int], str] = {}
    asset_entities: dict[str, str] = {}
    audit: list[dict[str, Any]] = []
    image_operations = {
        (int(op.get("slide", 0)), int(op.get("shapeId", 0))): op
        for op in operations
        if op.get("action") == "replace_image"
        and isinstance(op.get("shapeId"), int)
    }
    text_operations = [
        op for op in operations if op.get("action") in TEXT_ACTIONS
    ]

    for index, binding in enumerate(raw_bindings, 1):
        prefix = f"第 {index} 个实体绑定"
        if not isinstance(binding, dict):
            errors.append(f"{prefix}必须是对象")
            continue
        binding_id = str(binding.get("bindingId", "")).strip()
        entity_id = str(binding.get("entityId", "")).strip()
        entity_type = binding.get("entityType")
        display_name = str(binding.get("displayName", "")).strip()
        if not binding_id:
            errors.append(f"{prefix}缺少 bindingId")
            continue
        if binding_id in bindings:
            errors.append(f"{prefix} bindingId 重复：{binding_id}")
            continue
        bindings[binding_id] = binding
        if not entity_id or not display_name:
            errors.append(f"{prefix} entityId 和 displayName 不能为空")
        if entity_type not in {
            "person",
            "product",
            "customer",
            "case",
            "company",
            "institution",
        }:
            errors.append(f"{prefix} entityType 不受支持：{entity_type}")
        entity_role = str(binding.get("entityRole", "")).strip()
        if strict_identity and entity_type in {"company", "institution"}:
            expected_roles = (
                {"target_company", "competitor", "customer"}
                if entity_type == "company"
                else {"investment_institution"}
            )
            if entity_role not in expected_roles:
                errors.append(
                    f"{prefix} entityRole 与 {entity_type} 不匹配：{entity_role}"
                )
        try:
            slide = int(binding.get("slide", 0))
            image_shape_id = int(binding.get("imageShapeId", 0))
        except (TypeError, ValueError):
            slide, image_shape_id = 0, 0
        image_key = (slide, image_shape_id)
        target = objects.get(image_key)
        if target is None:
            errors.append(
                f"{prefix}未找到图片目标：第 {slide} 页 shapeId={image_shape_id}"
            )
        elif target.get("kind") != "picture":
            errors.append(f"{prefix}图片目标不是 picture")
        if image_key in image_targets:
            errors.append(
                f"{prefix}图片槽已绑定给 {image_targets[image_key]}，不得重复绑定"
            )
        image_targets[image_key] = binding_id

        raw_asset, asset = asset_paths(binding.get("asset"))
        if not raw_asset.is_absolute() or not asset.exists():
            errors.append(f"{prefix} asset 不存在或不是绝对路径：{asset}")
        asset_key = str(asset)
        previous_entity = asset_entities.get(asset_key)
        if previous_entity and previous_entity != entity_id:
            errors.append(
                f"{prefix}同一素材已绑定给实体 {previous_entity}，不得再绑定给 {entity_id}"
            )
        asset_entities[asset_key] = entity_id

        group_id = str(binding.get("slotGroupId", "")).strip()
        group_shape_ids: set[int] | None = None
        if group_id:
            group = groups.get(group_id)
            if not group:
                errors.append(f"{prefix}未找到 slotGroupId={group_id}")
            elif int(group.get("slide", 0)) != slide:
                errors.append(f"{prefix}实体绑定与槽位组不在同一页")
            else:
                group_shape_ids = {int(value) for value in group.get("shapeIds", [])}
                if image_shape_id not in group_shape_ids:
                    errors.append(f"{prefix}图片槽不属于 slotGroupId={group_id}")

        labels = binding.get("labelBindings")
        if not isinstance(labels, list) or not labels:
            errors.append(f"{prefix} labelBindings 必须是非空数组")
            labels = []
        has_identity_name = False
        resolved_labels: list[dict[str, Any]] = []
        for label_index, label in enumerate(labels, 1):
            label_prefix = f"{prefix}第 {label_index} 个标签"
            if not isinstance(label, dict):
                errors.append(f"{label_prefix}必须是对象")
                continue
            try:
                shape_id = int(label.get("shapeId", 0))
            except (TypeError, ValueError):
                shape_id = 0
            label_key = (slide, shape_id)
            label_type = label.get("labelType")
            expected_text = str(label.get("expectedText", ""))
            if label_key in label_targets:
                errors.append(
                    f"{label_prefix}文字槽已绑定给 {label_targets[label_key]}"
                )
            label_targets[label_key] = binding_id
            label_target = objects.get(label_key)
            if label_target is None:
                errors.append(
                    f"{label_prefix}未找到第 {slide} 页 shapeId={shape_id}"
                )
            elif not str(label_target.get("kind", "")).startswith("shape:"):
                errors.append(f"{label_prefix}目标不是可编辑文字形状")
            if group_shape_ids is not None and shape_id not in group_shape_ids:
                errors.append(f"{label_prefix}不属于 slotGroupId={group_id}")
            if label_type in {"name", "product_name", "company_name"}:
                has_identity_name = True
                if expected_text.strip() != display_name:
                    errors.append(
                        f"{label_prefix} expectedText 必须与 displayName 完全一致"
                    )
            matching_texts = [
                operation_text_for_shape(op, shape_id)
                for op in text_operations
                if int(op.get("slide", 0)) == slide
            ]
            matching_texts = [value for value in matching_texts if value is not None]
            if not matching_texts:
                errors.append(f"{label_prefix}没有对应的文字替换操作")
            elif expected_text not in matching_texts:
                errors.append(
                    f"{label_prefix}期望文字“{expected_text}”与实际替换文字不一致"
                )
            resolved_labels.append(
                {
                    "shapeId": shape_id,
                    "labelType": label_type,
                    "expectedText": expected_text,
                    "matched": expected_text in matching_texts,
                }
            )
        required_name_type = {
            "person": "name",
            "product": "product_name",
            "company": "company_name",
            "institution": "company_name",
        }.get(str(entity_type), "")
        if entity_type in {"person", "product", "company", "institution"} and not has_identity_name:
            errors.append(f"{prefix}必须包含 {required_name_type} 标签绑定")

        image_operation = image_operations.get(image_key)
        if image_operation is None:
            errors.append(f"{prefix}没有对应的 replace_image 操作")
        else:
            if image_operation.get("bindingId") != binding_id:
                errors.append(f"{prefix}图片操作的 bindingId 不匹配")
            operation_asset = normalize_asset(image_operation.get("asset"))
            if operation_asset != asset:
                errors.append(f"{prefix}图片操作与实体绑定使用了不同素材")
            expected_class = (
                "person_photo"
                if entity_type == "person"
                else "product_screenshot"
                if entity_type == "product"
                else "company_logo"
            )
            if entity_type in {"person", "product", "company", "institution"} and image_operation.get(
                "assetClass"
            ) != expected_class:
                errors.append(
                    f"{prefix}{entity_type} 必须使用 assetClass={expected_class}"
                )
        audit.append(
            {
                "bindingId": binding_id,
                "entityId": entity_id,
                "entityType": entity_type,
                "entityRole": entity_role or None,
                "displayName": display_name,
                "slide": slide,
                "slotGroupId": group_id or None,
                "imageShapeId": image_shape_id,
                "asset": str(asset),
                "labels": resolved_labels,
                "status": "resolved" if image_operation is not None else "unresolved",
            }
        )

    for index, operation in enumerate(operations, 1):
        if operation.get("action") != "replace_image":
            continue
        asset_class = operation.get("assetClass")
        binding_id = str(operation.get("bindingId", "")).strip()
        if require_relationships and asset_class in {
            "person_photo",
            "product_screenshot",
        }:
            if not binding_id:
                errors.append(
                    f"第 {index} 项人物/产品图片替换必须包含 bindingId"
                )
            elif binding_id not in bindings:
                errors.append(f"第 {index} 项引用了不存在的 bindingId={binding_id}")
        elif binding_id and binding_id not in bindings:
            errors.append(f"第 {index} 项引用了不存在的 bindingId={binding_id}")
        if strict_identity and asset_class == "company_logo":
            if not binding_id:
                errors.append(
                    f"第 {index} 项公司 Logo 替换必须包含 bindingId"
                )
            elif binding_id not in bindings:
                errors.append(f"第 {index} 项引用了不存在的 bindingId={binding_id}")
    return audit


def validate_content_safety_model(
    manifest: dict[str, Any],
    template_map: dict[str, Any],
    operations: list[dict[str, Any]],
    errors: list[str],
) -> dict[str, Any]:
    """Validate the 1.5/1.6 identity, fact, slide-brief, and safety contract."""
    if str(manifest.get("schemaVersion", "")) not in CONTENT_SAFE_SCHEMA_VERSIONS:
        return {"required": False, "status": "not-required"}
    initial_error_count = len(errors)
    objects = object_index(template_map)
    sources = {
        str(item.get("sourceId")): item
        for item in manifest.get("sources", [])
        if isinstance(item, dict) and item.get("sourceId")
    }
    evidence = {
        str(item.get("evidenceId")): item
        for item in manifest.get("evidenceRegistry", [])
        if isinstance(item, dict) and item.get("evidenceId")
    }

    identity = manifest.get("projectIdentity")
    if not isinstance(identity, dict):
        errors.append("1.5/1.6 版必须提供 projectIdentity")
        identity = {}
    for field in ("legalName", "region"):
        if not str(identity.get(field, "")).strip():
            errors.append(f"projectIdentity.{field} 不能为空")
    if identity.get("identityStatus") != "verified":
        errors.append("projectIdentity.identityStatus 必须为 verified")
    if identity.get("confidence") != "high":
        errors.append("项目实体锁定必须达到 confidence=high 后才能编辑")
    identity_source_ids = identity.get("sourceIds")
    if not isinstance(identity_source_ids, list) or not identity_source_ids:
        errors.append("projectIdentity.sourceIds 必须是非空数组")
        identity_source_ids = []
    for source_id in identity_source_ids:
        if str(source_id) not in sources:
            errors.append(f"projectIdentity 引用不存在的 sourceId={source_id}")
    project_name = str(manifest.get("projectName", "")).strip()
    legal_name = str(identity.get("legalName", "")).strip()
    aliases = {
        str(value).strip()
        for value in identity.get("aliases", [])
        if str(value).strip()
    }
    if project_name and project_name not in ({legal_name} | aliases):
        errors.append("projectName 必须等于 projectIdentity.legalName 或其 aliases")
    identity_evidence_ids = identity.get("identityEvidenceIds")
    if not isinstance(identity_evidence_ids, list) or not identity_evidence_ids:
        errors.append("projectIdentity.identityEvidenceIds 必须是非空数组")
        identity_evidence_ids = []
    identity_names = {legal_name, *aliases} - {""}
    for evidence_id in identity_evidence_ids:
        item = evidence.get(str(evidence_id))
        if not item:
            errors.append(
                f"projectIdentity 引用不存在的 identityEvidenceId={evidence_id}"
            )
            continue
        claim = canonical_text(item.get("claim", ""))
        if not any(canonical_text(name) in claim for name in identity_names):
            errors.append(
                f"身份事实 {evidence_id} 的 claim 未明确包含目标公司名称"
            )
        if item.get("status") != "verified":
            errors.append(f"身份事实 {evidence_id} 必须为 verified")
        if not set(map(str, item.get("sourceIds", []))) & set(
            map(str, identity_source_ids)
        ):
            errors.append(
                f"身份事实 {evidence_id} 未引用 projectIdentity.sourceIds"
            )
    domains = {
        str(value).strip().lower().removeprefix("www.")
        for value in identity.get("officialDomains", [])
        if str(value).strip()
    }
    linked_identity_sources = [
        sources.get(str(source_id), {}) for source_id in identity_source_ids
    ]
    if domains:
        matched_domain = False
        for source in linked_identity_sources:
            if source.get("sourceType") != "company_official":
                continue
            host = urlparse(str(source.get("url", ""))).hostname or ""
            host = host.lower().removeprefix("www.")
            if any(host == domain or host.endswith("." + domain) for domain in domains):
                matched_domain = True
        if not matched_domain:
            errors.append(
                "projectIdentity.officialDomains 必须匹配一个已登记的 company_official 来源"
            )
    elif not identity.get("identifiers") or not any(
        source.get("sourceType") == "user_material"
        for source in linked_identity_sources
    ):
        errors.append(
            "没有官网时必须提供 identifiers，并引用用户原始身份材料"
        )

    fingerprint = manifest.get("templateFingerprint")
    if not isinstance(fingerprint, dict):
        errors.append("1.5/1.6 版必须提供 templateFingerprint")
        fingerprint = {}
    if fingerprint.get("reviewed") is not True:
        errors.append("templateFingerprint.reviewed 必须为 true")
    old_terms = [
        str(value).strip()
        for value in fingerprint.get("oldProjectTerms", [])
        if str(value).strip()
    ]
    if not old_terms:
        errors.append("templateFingerprint.oldProjectTerms 不能为空")
    old_numbers = [
        str(value).strip()
        for value in fingerprint.get("oldProjectNumericTokens", [])
        if str(value).strip()
    ]
    old_media = [
        str(value).strip()
        for value in fingerprint.get("oldProjectMediaSha256", [])
        if str(value).strip()
    ]
    template_numeric_candidates: set[str] = set()
    for slide in template_map.get("slides", []):
        for item in slide.get("objects", []):
            template_numeric_candidates.update(numeric_tokens(item.get("text", "")))
            data = item.get("data")
            if isinstance(data, dict):
                template_numeric_candidates.update(
                    numeric_tokens(
                        json.dumps(data.get("values", []), ensure_ascii=False)
                    )
                )
    for note in template_map.get("noteTexts", []):
        if isinstance(note, dict):
            template_numeric_candidates.update(numeric_tokens(note.get("text", "")))
    numeric_decisions = fingerprint.get("numericDecisions")
    if not isinstance(numeric_decisions, list):
        errors.append("templateFingerprint.numericDecisions 必须是数组")
        numeric_decisions = []
    decided_numbers: dict[str, dict[str, Any]] = {}
    for index, decision in enumerate(numeric_decisions, 1):
        if not isinstance(decision, dict):
            errors.append(f"第 {index} 个 numericDecision 必须是对象")
            continue
        token = canonical_text(decision.get("token", ""))
        if not token or token in decided_numbers:
            errors.append(f"第 {index} 个 numericDecision token 为空或重复")
            continue
        decided_numbers[token] = decision
        if decision.get("disposition") not in {
            "old_project",
            "template_neutral",
            "template_index",
        }:
            errors.append(f"第 {index} 个 numericDecision 尚未完成处置")
        if len(str(decision.get("reason", "")).strip()) < 4:
            errors.append(f"第 {index} 个 numericDecision 缺少具体理由")
    if set(decided_numbers) != template_numeric_candidates:
        errors.append(
            "numericDecisions 必须覆盖模板全部数字候选；"
            f"缺少 {sorted(template_numeric_candidates - set(decided_numbers))}，"
            f"多出 {sorted(set(decided_numbers) - template_numeric_candidates)}"
        )
    decided_old_numbers = {
        token
        for token, decision in decided_numbers.items()
        if decision.get("disposition") == "old_project"
    }
    if {canonical_text(value) for value in old_numbers} != decided_old_numbers:
        errors.append(
            "oldProjectNumericTokens 必须与 numericDecisions 中的 old_project 完全一致"
        )

    media_decisions = fingerprint.get("mediaDecisions")
    if not isinstance(media_decisions, list):
        errors.append("templateFingerprint.mediaDecisions 必须是数组")
        media_decisions = []
    decided_media: dict[str, dict[str, Any]] = {}
    for index, decision in enumerate(media_decisions, 1):
        if not isinstance(decision, dict):
            errors.append(f"第 {index} 个 mediaDecision 必须是对象")
            continue
        digest = str(decision.get("sha256", "")).strip()
        if not re.fullmatch(r"[0-9a-f]{64}", digest) or digest in decided_media:
            errors.append(f"第 {index} 个 mediaDecision 哈希无效或重复")
            continue
        decided_media[digest] = decision
        if decision.get("disposition") not in {"old_project", "template_neutral"}:
            errors.append(f"第 {index} 个 mediaDecision 尚未完成处置")
        if len(str(decision.get("reason", "")).strip()) < 6:
            errors.append(f"第 {index} 个 mediaDecision 缺少具体理由")
    template_media = {
        str(value) for value in template_map.get("mediaIds", []) if str(value)
    }
    if set(decided_media) != template_media:
        errors.append(
            "mediaDecisions 必须覆盖模板全部媒体哈希；"
            f"缺少 {len(template_media - set(decided_media))} 个，"
            f"多出 {len(set(decided_media) - template_media)} 个"
        )
    decided_old_media = {
        digest
        for digest, decision in decided_media.items()
        if decision.get("disposition") == "old_project"
    }
    if set(old_media) != decided_old_media:
        errors.append(
            "oldProjectMediaSha256 必须与 mediaDecisions 中的 old_project 完全一致"
        )
    residual = manifest.get("residualPolicy", {})
    if isinstance(residual, dict):
        missing_terms = set(old_terms) - {
            str(value).strip()
            for value in residual.get("forbiddenTextTerms", [])
        }
        missing_numbers = {canonical_text(value) for value in old_numbers} - {
            canonical_text(value)
            for value in residual.get("forbiddenNumericTokens", [])
        }
        missing_media = set(old_media) - {
            str(value).strip()
            for value in residual.get("forbiddenMediaSha256", [])
        }
        if missing_terms:
            errors.append(
                f"旧项目文字指纹未全部进入 residualPolicy：{sorted(missing_terms)}"
            )
        if missing_numbers:
            errors.append(
                f"旧项目数字指纹未全部进入 residualPolicy：{sorted(missing_numbers)}"
            )
        if missing_media:
            errors.append(
                f"旧项目媒体指纹未全部进入 residualPolicy：{sorted(missing_media)}"
            )

    raw_facts = manifest.get("facts")
    if not isinstance(raw_facts, list) or not raw_facts:
        errors.append("1.5/1.6 版 facts 必须是非空数组")
        raw_facts = []
    facts: dict[str, dict[str, Any]] = {}
    for index, fact in enumerate(raw_facts, 1):
        prefix = f"第 {index} 个项目事实"
        if not isinstance(fact, dict):
            errors.append(f"{prefix}必须是对象")
            continue
        fact_key = str(fact.get("factKey", "")).strip()
        semantic_key = str(fact.get("semanticKey", "")).strip()
        if not fact_key:
            errors.append(f"{prefix}缺少 factKey")
            continue
        if fact_key in facts:
            errors.append(f"{prefix} factKey 重复：{fact_key}")
            continue
        facts[fact_key] = fact
        if not semantic_key:
            errors.append(f"{prefix}缺少 semanticKey")
        if fact.get("renderedValue") is None:
            errors.append(f"{prefix}缺少 renderedValue")
        fact_type = fact.get("factType")
        if fact_type in {"number", "currency", "percentage"}:
            if not str(fact.get("unit", "")).strip():
                errors.append(f"{prefix}数值事实必须提供 unit")
            if not str(fact.get("period", "")).strip() and not str(
                fact.get("asOfDate", "")
            ).strip():
                errors.append(f"{prefix}数值事实必须提供 period 或 asOfDate")
        fact_evidence = fact.get("evidenceIds")
        if not isinstance(fact_evidence, list) or not fact_evidence:
            errors.append(f"{prefix} evidenceIds 必须是非空数组")
            fact_evidence = []
        for evidence_id in fact_evidence:
            item = evidence.get(str(evidence_id))
            if not item:
                errors.append(f"{prefix}引用不存在的 evidenceId={evidence_id}")
            elif semantic_key not in {
                str(value).strip() for value in item.get("semanticKeys", [])
            }:
                errors.append(
                    f"{prefix}证据 {evidence_id} 不支持 semanticKey={semantic_key}"
                )
        if fact.get("status") == "unavailable" and fact.get("materiality") != "material":
            errors.append(f"{prefix}非重大缺失事实不应进入成稿事实库，应删除可选槽位")

    raw_briefs = manifest.get("slideBriefs")
    if not isinstance(raw_briefs, list):
        errors.append("1.5/1.6 版必须提供 slideBriefs 数组")
        raw_briefs = []
    briefs: dict[int, dict[str, Any]] = {}
    budget_by_shape: dict[tuple[int, int], dict[str, Any]] = {}
    for index, brief in enumerate(raw_briefs, 1):
        prefix = f"第 {index} 个页面内容方案"
        if not isinstance(brief, dict):
            errors.append(f"{prefix}必须是对象")
            continue
        try:
            slide = int(brief.get("slide", 0))
        except (TypeError, ValueError):
            slide = 0
        if slide <= 0:
            errors.append(f"{prefix} slide 必须是正整数")
            continue
        if slide in briefs:
            errors.append(f"{prefix}页码重复：{slide}")
        briefs[slide] = brief
        for field in ("objective", "conclusion"):
            if not str(brief.get(field, "")).strip():
                errors.append(f"{prefix}缺少 {field}")
        allowed_facts = {
            str(value).strip()
            for value in brief.get("allowedFactKeys", [])
            if str(value).strip()
        }
        unknown_facts = allowed_facts - set(facts)
        if unknown_facts:
            errors.append(f"{prefix}引用不存在的 factKey：{sorted(unknown_facts)}")
        for budget in brief.get("shapeBudgets", []):
            if not isinstance(budget, dict):
                errors.append(f"{prefix} shapeBudgets 包含非对象")
                continue
            try:
                shape_id = int(budget.get("shapeId", 0))
                max_chars = int(budget.get("maxChars", -1))
                max_lines = int(budget.get("maxLines", 0))
            except (TypeError, ValueError):
                errors.append(f"{prefix} shapeBudget 数值无效")
                continue
            if shape_id <= 0 or max_chars < 0 or max_lines <= 0:
                errors.append(f"{prefix} shapeBudget 必须给出有效容量")
            target = objects.get((slide, shape_id))
            if target is None:
                errors.append(f"{prefix} shapeBudget 引用不存在的 shapeId={shape_id}")
            elif not str(target.get("kind", "")).startswith("shape:"):
                errors.append(f"{prefix} shapeBudget 只能用于文字形状")
            else:
                derived_chars, derived_lines = derived_text_capacity(target)
                if max_chars > derived_chars or max_lines > derived_lines:
                    errors.append(
                        f"{prefix} shapeId={shape_id} 容量预算超过模板推导上限 "
                        f"({derived_chars} 字/{derived_lines} 行)"
                    )
            budget_by_shape[(slide, shape_id)] = budget
    expected_slides = set(range(1, int(template_map.get("slideCount", 0)) + 1))
    if set(briefs) != expected_slides:
        errors.append(
            "1.5/1.6 版 slideBriefs 必须覆盖全部页面；"
            f"缺少 {sorted(expected_slides - set(briefs))}，"
            f"多出 {sorted(set(briefs) - expected_slides)}"
        )

    for index, operation in enumerate(operations, 1):
        if not isinstance(operation, dict):
            continue
        prefix = f"第 {index} 项"
        action = operation.get("action")
        if action == "add_disclaimer_textbox":
            continue
        slide = int(operation.get("slide", 0))
        brief = briefs.get(slide, {})
        semantic_key = str(operation.get("semanticKey", "")).strip()
        allowed_semantics = {
            str(value).strip()
            for value in brief.get("allowedSemanticKeys", [])
            if str(value).strip()
        }
        if semantic_key not in allowed_semantics:
            errors.append(
                f"{prefix} semanticKey={semantic_key} 未获第 {slide} 页内容方案授权"
            )
        fact_keys = operation.get("factKeys")
        if not isinstance(fact_keys, list) or not fact_keys:
            errors.append(f"{prefix}1.5 版操作必须包含非空 factKeys")
            fact_keys = []
        allowed_fact_keys = {
            str(value).strip()
            for value in brief.get("allowedFactKeys", [])
            if str(value).strip()
        }
        for fact_key in fact_keys:
            fact = facts.get(str(fact_key))
            if not fact:
                errors.append(f"{prefix}引用不存在的 factKey={fact_key}")
                continue
            if str(fact_key) not in allowed_fact_keys:
                errors.append(
                    f"{prefix} factKey={fact_key} 未获第 {slide} 页内容方案授权"
                )
            if fact.get("semanticKey") != semantic_key:
                errors.append(
                    f"{prefix} factKey={fact_key} 的 semanticKey 与操作不一致"
                )
            if fact.get("status") == "unavailable" and action != "delete_slot_group":
                gap_slides = {
                    int(value)
                    for value in residual.get("gapSlideNumbers", [])
                }
                if slide not in gap_slides:
                    errors.append(f"{prefix}缺失事实只能删除槽位或写入专用缺口页")
        if action in TEXT_ACTIONS:
            if operation.get("groupMode") in {"fragment-map", "line-reflow"}:
                visible_payload = "\n".join(
                    str(item.get("text", ""))
                    for item in operation.get("fragmentTexts", [])
                    if isinstance(item, dict)
                )
            else:
                visible_payload = str(operation.get("text", ""))
            normalized_payload = re.sub(r"[\s,，]", "", visible_payload)
            for fact_key in fact_keys:
                fact = facts.get(str(fact_key), {})
                if fact.get("status") == "unavailable":
                    continue
                rendered = re.sub(
                    r"[\s,，]", "", str(fact.get("renderedValue", ""))
                )
                if rendered and rendered not in normalized_payload:
                    errors.append(
                        f"{prefix}最终文字未包含 factKey={fact_key} 的 renderedValue"
                    )
        if action in TEXT_ACTIONS:
            capacity = operation.get("capacityCheck")
            if not isinstance(capacity, dict) or capacity.get("reviewed") is not True:
                errors.append(f"{prefix}1.5 版文字操作必须完成 capacityCheck")
            else:
                text_values = [operation_text_for_shape(operation, shape_id) or ""
                               for shape_id in shape_ids_for(operation, {})]
                max_chars = int(capacity.get("maxChars", -1))
                max_lines = int(capacity.get("maxLines", 0))
                if max((len(value.replace("\n", "")) for value in text_values), default=0) > max_chars:
                    errors.append(f"{prefix}替换文字超过 capacityCheck.maxChars")
                if max((value.count("\n") + 1 for value in text_values), default=1) > max_lines:
                    errors.append(f"{prefix}替换文字超过 capacityCheck.maxLines")
            operation_shape_ids = shape_ids_for(operation, {})
            for shape_id in operation_shape_ids:
                budget = budget_by_shape.get((slide, shape_id))
                if budget is None:
                    errors.append(
                        f"{prefix}第 {slide} 页 shapeId={shape_id} 缺少页面容量预算"
                    )
                    continue
                replacement = operation_text_for_shape(operation, shape_id) or ""
                if len(replacement.replace("\n", "")) > int(
                    budget.get("maxChars", -1)
                ):
                    errors.append(
                        f"{prefix}shapeId={shape_id} 超过 slideBrief.maxChars"
                    )
                if replacement.count("\n") + 1 > int(budget.get("maxLines", 0)):
                    errors.append(
                        f"{prefix}shapeId={shape_id} 超过 slideBrief.maxLines"
                    )
            if isinstance(capacity, dict) and operation_shape_ids:
                budgets = [
                    budget_by_shape.get((slide, shape_id), {})
                    for shape_id in operation_shape_ids
                ]
                allowed_chars = min(
                    (int(item.get("maxChars", -1)) for item in budgets),
                    default=-1,
                )
                allowed_lines = min(
                    (int(item.get("maxLines", 0)) for item in budgets),
                    default=0,
                )
                if int(capacity.get("maxChars", -1)) > allowed_chars:
                    errors.append(f"{prefix}capacityCheck.maxChars 超过页面预算")
                if int(capacity.get("maxLines", 0)) > allowed_lines:
                    errors.append(f"{prefix}capacityCheck.maxLines 超过页面预算")
            if (
                action == "replace_text_group"
                and operation.get("groupMode") == "composite-box"
                and operation_shape_ids
            ):
                primary_id = int(operation.get("primaryShapeId", 0))
                boxes = [
                    objects.get((slide, shape_id), {}).get("bbox", [0, 0, 0, 0])
                    for shape_id in operation_shape_ids
                ]
                left = min(float(box[0]) for box in boxes)
                top = min(float(box[1]) for box in boxes)
                right = max(float(box[0]) + float(box[2]) for box in boxes)
                bottom = max(float(box[1]) + float(box[3]) for box in boxes)
                primary_box = objects.get((slide, primary_id), {}).get(
                    "bbox", [0, 0, 0, 0]
                )
                primary_left = float(primary_box[0])
                primary_top = float(primary_box[1])
                primary_right = primary_left + float(primary_box[2])
                primary_bottom = primary_top + float(primary_box[3])
                tolerance = max(1.0, 0.02 * max(right - left, bottom - top))
                if (
                    primary_left > left + tolerance
                    or primary_top > top + tolerance
                    or primary_right < right - tolerance
                    or primary_bottom < bottom - tolerance
                ):
                    errors.append(
                        f"{prefix}composite-box 主形状不是覆盖碎片组的完整文本槽"
                    )
        if action in NATIVE_ACTIONS:
            bindings = operation.get("dataBindings")
            if not isinstance(bindings, list) or not bindings:
                errors.append(f"{prefix}原生图表/表格操作必须提供 dataBindings")
            else:
                bound = {
                    str(item.get("factKey"))
                    for item in bindings
                    if isinstance(item, dict)
                }
                if bound != set(map(str, fact_keys)):
                    errors.append(
                        f"{prefix} dataBindings 与 factKeys 必须完全一致"
                    )
                bound_paths = {
                    str(item.get("path"))
                    for item in bindings
                    if isinstance(item, dict)
                }
                if len(bound_paths) != len(bindings):
                    errors.append(f"{prefix} dataBindings.path 不得重复")
                expected_paths: set[str] = set()
                if action == "replace_table_data":
                    for row_index, row in enumerate(operation.get("values", [])):
                        if isinstance(row, list):
                            expected_paths.update(
                                f"values[{row_index}][{column_index}]"
                                for column_index in range(len(row))
                            )
                else:
                    expected_paths.update(
                        f"categories[{index}]"
                        for index, _ in enumerate(operation.get("categories", []))
                    )
                    for series_index, series in enumerate(
                        operation.get("series", [])
                    ):
                        if not isinstance(series, dict):
                            continue
                        expected_paths.add(f"series[{series_index}].name")
                        expected_paths.update(
                            f"series[{series_index}].values[{value_index}]"
                            for value_index, _ in enumerate(
                                series.get("values", [])
                            )
                        )
                if bound_paths != expected_paths:
                    errors.append(
                        f"{prefix} dataBindings 必须覆盖全部数据路径；"
                        f"缺少 {sorted(expected_paths - bound_paths)}，"
                        f"多出 {sorted(bound_paths - expected_paths)}"
                    )
                for binding_index, binding in enumerate(bindings, 1):
                    if not isinstance(binding, dict):
                        errors.append(
                            f"{prefix}第 {binding_index} 个 dataBinding 必须是对象"
                        )
                        continue
                    fact_key = str(binding.get("factKey", ""))
                    path = str(binding.get("path", ""))
                    if fact_key not in facts:
                        continue
                    try:
                        bound_value = resolve_operation_path(operation, path)
                    except (ValueError, IndexError):
                        errors.append(
                            f"{prefix} dataBinding 路径无法解析：{path}"
                        )
                        continue
                    if not fact_value_matches_bound_value(
                        facts[fact_key], bound_value
                    ):
                        errors.append(
                            f"{prefix} dataBinding {path} 与 "
                            f"factKey={fact_key} 的 renderedValue 不精确相等"
                        )

    object_policy = manifest.get("objectPolicy")
    expected_object_policy = {
        "fixedVisualAction": "keep",
        "projectSpecificAction": "replace-or-delete",
        "unknownObjectAction": "fail",
        "fullDeckClosureRequired": True,
    }
    if not isinstance(object_policy, dict):
        errors.append("1.5/1.6 版必须提供 objectPolicy")
    else:
        for key, value in expected_object_policy.items():
            if object_policy.get(key) != value:
                errors.append(f"objectPolicy.{key} 必须为 {value!r}")
    visual_policy = manifest.get("visualQaPolicy")
    required_visual_flags = (
        "renderAllSlides",
        "checkOverflow",
        "checkOverlap",
        "checkImageCrop",
        "checkEmptySlots",
        "checkRepeatedBoilerplate",
    )
    if str(manifest.get("schemaVersion", "")) in BACKGROUND_LOCK_SCHEMA_VERSIONS:
        required_visual_flags += (
            "checkTemplateBackgroundFidelity",
            "checkLogoBackgroundArtifacts",
        )
    if not isinstance(visual_policy, dict):
        errors.append("1.5/1.6 版必须提供 visualQaPolicy")
    else:
        for field in required_visual_flags:
            if visual_policy.get(field) is not True:
                errors.append(f"visualQaPolicy.{field} 必须为 true")

    return {
        "required": True,
        "status": "passed" if len(errors) == initial_error_count else "failed",
        "projectIdentity": identity,
        "templateFingerprint": fingerprint,
        "factCount": len(facts),
        "slideBriefCount": len(briefs),
    }


def validate_content_density(
    manifest: dict[str, Any],
    template_map: dict[str, Any],
    operations: list[dict[str, Any]],
    errors: list[str],
) -> dict[str, Any]:
    """Validate per-slide research coverage without rewarding unsupported filler."""
    policy = manifest.get("contentDensityPolicy")
    if policy is None:
        return {
            "required": False,
            "status": "not-enabled",
            "policy": None,
            "pages": [],
        }
    initial_error_count = len(errors)
    if not isinstance(policy, dict):
        errors.append("contentDensityPolicy 必须是对象")
        return {
            "required": True,
            "status": "failed",
            "policy": policy,
            "pages": [],
        }
    if policy.get("enabled") is not True:
        errors.append("contentDensityPolicy.enabled 必须为 true")

    slide_count = int(template_map.get("slideCount", 0))
    expected_slides = set(range(1, slide_count + 1))

    def slide_set(field: str) -> set[int]:
        raw = policy.get(field)
        if not isinstance(raw, list):
            errors.append(f"contentDensityPolicy.{field} 必须是数组")
            return set()
        try:
            result = {int(value) for value in raw}
        except (TypeError, ValueError):
            errors.append(f"contentDensityPolicy.{field} 只能包含整数页码")
            return set()
        if len(result) != len(raw):
            errors.append(f"contentDensityPolicy.{field} 页码不得重复")
        invalid = result - expected_slides
        if invalid:
            errors.append(
                f"contentDensityPolicy.{field} 包含无效页码：{sorted(invalid)}"
            )
        return result

    substantive = slide_set("substantiveSlideNumbers")
    excluded = slide_set("excludedSlideNumbers")
    external = slide_set("externalContextSlideNumbers")
    overlap = substantive & excluded
    if overlap:
        errors.append(f"正文页与豁免页不得重叠：{sorted(overlap)}")
    if substantive | excluded != expected_slides:
        errors.append(
            "contentDensityPolicy 必须将全部页面划分为正文页或豁免页；"
            f"缺少 {sorted(expected_slides - (substantive | excluded))}"
        )
    if not external.issubset(substantive):
        errors.append(
            "externalContextSlideNumbers 必须是 substantiveSlideNumbers 的子集"
        )

    numeric_defaults = {
        "minimumContentItemsPerSubstantiveSlide": (6, 4, 12),
        "minimumEvidenceItemsPerSubstantiveSlide": (2, 2, 8),
        "minimumResearchQueriesPerSubstantiveSlide": (1, 1, 5),
        "minimumWebSourcesPerExternalContextSlide": (1, 1, 4),
    }
    limits: dict[str, int] = {}
    for field, (default, minimum, maximum) in numeric_defaults.items():
        value = policy.get(field, default)
        if (
            not isinstance(value, int)
            or value < minimum
            or value > maximum
        ):
            errors.append(
                f"contentDensityPolicy.{field} 必须是 "
                f"{minimum}–{maximum} 的整数"
            )
            value = default
        limits[field] = value
    max_utilization = policy.get("maxTextCapacityUtilization", 0.85)
    if (
        not isinstance(max_utilization, (int, float))
        or not 0.5 <= float(max_utilization) <= 0.9
    ):
        errors.append(
            "contentDensityPolicy.maxTextCapacityUtilization 必须在 0.5–0.9"
        )
        max_utilization = 0.85
    if policy.get("thinSlideAction") != "research-or-restructure":
        errors.append(
            "contentDensityPolicy.thinSlideAction 必须为 research-or-restructure"
        )
    if policy.get("requireClaimDiversity") is not True:
        errors.append("contentDensityPolicy.requireClaimDiversity 必须为 true")

    briefs = {
        int(item.get("slide", 0)): item
        for item in manifest.get("slideBriefs", [])
        if isinstance(item, dict) and isinstance(item.get("slide"), int)
    }
    budget_by_shape: dict[tuple[int, int], int] = {}
    for slide, brief in briefs.items():
        for budget in brief.get("shapeBudgets", []):
            if not isinstance(budget, dict):
                continue
            try:
                shape_id = int(budget.get("shapeId", 0))
                max_chars = int(budget.get("maxChars", 0))
            except (TypeError, ValueError):
                continue
            if shape_id > 0 and max_chars > 0:
                budget_by_shape[(slide, shape_id)] = max_chars
    evidence = {
        str(item.get("evidenceId")): item
        for item in manifest.get("evidenceRegistry", [])
        if isinstance(item, dict) and item.get("evidenceId")
    }
    sources = {
        str(item.get("sourceId")): item
        for item in manifest.get("sources", [])
        if isinstance(item, dict) and item.get("sourceId")
    }
    operation_semantics: dict[int, set[str]] = {}
    text_utilization: dict[int, list[dict[str, Any]]] = {}
    for operation in operations:
        if not isinstance(operation, dict):
            continue
        action = operation.get("action")
        if action in {"delete_slot_group", "add_disclaimer_textbox"}:
            continue
        try:
            slide = int(operation.get("slide", 0))
        except (TypeError, ValueError):
            continue
        semantic_key = str(operation.get("semanticKey", "")).strip()
        if semantic_key:
            operation_semantics.setdefault(slide, set()).add(semantic_key)
        density_semantics = {
            str(value).strip()
            for value in briefs.get(slide, {}).get(
                "contentItemSemanticKeys",
                [],
            )
            if str(value).strip()
        }
        if (
            action in TEXT_ACTIONS
            and slide in substantive
            and semantic_key in density_semantics
        ):
            capacity = operation.get("capacityCheck")
            if not isinstance(capacity, dict):
                continue
            for shape_id in shape_ids_for(operation, {}):
                try:
                    max_chars = budget_by_shape.get(
                        (slide, shape_id),
                        int(capacity.get("maxChars", 0)),
                    )
                except (TypeError, ValueError):
                    max_chars = 0
                text_value = operation_text_for_shape(operation, shape_id) or ""
                used_chars = len(text_value.replace("\n", ""))
                utilization = used_chars / max_chars if max_chars > 0 else 1.0
                text_utilization.setdefault(slide, []).append(
                    {
                        "shapeId": shape_id,
                        "usedChars": used_chars,
                        "maxChars": max_chars,
                        "utilization": round(utilization, 4),
                    }
                )
                if utilization > float(max_utilization):
                    errors.append(
                        f"第 {slide} 页 shapeId={shape_id} 文字容量使用率 "
                        f"{utilization:.0%} 超过 {float(max_utilization):.0%}；"
                        "请精简、拆分或重构页面"
                    )

    page_audit: list[dict[str, Any]] = []
    for slide in sorted(expected_slides):
        brief = briefs.get(slide, {})
        expected_type = "substantive" if slide in substantive else None
        slide_type = brief.get("slideType")
        research_queries = [
            str(value).strip()
            for value in brief.get("researchQueries", [])
            if str(value).strip()
        ]
        evidence_ids = [
            str(value).strip()
            for value in brief.get("evidenceIds", [])
            if str(value).strip()
        ]
        content_keys = [
            str(value).strip()
            for value in brief.get("contentItemSemanticKeys", [])
            if str(value).strip()
        ]
        allowed_semantics = {
            str(value).strip()
            for value in brief.get("allowedSemanticKeys", [])
            if str(value).strip()
        }
        page_errors_before = len(errors)

        if slide in substantive:
            if slide_type != expected_type:
                errors.append(f"第 {slide} 页 slideType 必须为 substantive")
            if brief.get("densityStatus") != "ready":
                errors.append(f"第 {slide} 页 densityStatus 必须为 ready")
            if len(research_queries) < limits[
                "minimumResearchQueriesPerSubstantiveSlide"
            ]:
                errors.append(
                    f"第 {slide} 页检索问题不足，至少需要 "
                    f"{limits['minimumResearchQueriesPerSubstantiveSlide']} 个"
                )
            if len(evidence_ids) < limits[
                "minimumEvidenceItemsPerSubstantiveSlide"
            ]:
                errors.append(
                    f"第 {slide} 页证据项不足，至少需要 "
                    f"{limits['minimumEvidenceItemsPerSubstantiveSlide']} 个"
                )
            if len(content_keys) < limits[
                "minimumContentItemsPerSubstantiveSlide"
            ]:
                errors.append(
                    f"第 {slide} 页有效内容项不足，至少需要 "
                    f"{limits['minimumContentItemsPerSubstantiveSlide']} 个"
                )
            if not str(brief.get("pageResearchSummary", "")).strip():
                errors.append(f"第 {slide} 页缺少 pageResearchSummary")
            if len(set(evidence_ids)) != len(evidence_ids):
                errors.append(f"第 {slide} 页 evidenceIds 不得重复")
            if len(set(content_keys)) != len(content_keys):
                errors.append(f"第 {slide} 页 contentItemSemanticKeys 不得重复")
            for evidence_id in evidence_ids:
                if evidence_id not in evidence:
                    errors.append(
                        f"第 {slide} 页引用不存在的 evidenceId={evidence_id}"
                    )
            undeclared = set(content_keys) - allowed_semantics
            if undeclared:
                errors.append(
                    f"第 {slide} 页内容项未进入 allowedSemanticKeys："
                    f"{sorted(undeclared)}"
                )
            unused = set(content_keys) - operation_semantics.get(slide, set())
            if unused:
                errors.append(
                    f"第 {slide} 页内容项没有对应替换操作：{sorted(unused)}"
                )
            if policy.get("requireClaimDiversity") is True:
                distinct_claims = {
                    str(evidence.get(evidence_id, {}).get("claim", "")).strip()
                    for evidence_id in evidence_ids
                    if str(evidence.get(evidence_id, {}).get("claim", "")).strip()
                }
                if len(distinct_claims) < limits[
                    "minimumEvidenceItemsPerSubstantiveSlide"
                ]:
                    errors.append(
                        f"第 {slide} 页证据陈述缺乏多样性，不能用同一陈述重复凑数"
                    )
        else:
            if slide_type not in {"cover", "section", "closing"}:
                errors.append(
                    f"第 {slide} 页是密度豁免页，slideType 必须为 "
                    "cover、section 或 closing"
                )
            if brief.get("densityStatus") != "exempt":
                errors.append(f"第 {slide} 页 densityStatus 必须为 exempt")

        linked_source_ids = {
            str(source_id)
            for evidence_id in evidence_ids
            for source_id in evidence.get(evidence_id, {}).get("sourceIds", [])
        }
        web_source_ids = {
            source_id
            for source_id in linked_source_ids
            if sources.get(source_id, {}).get("sourceType") in WEB_SOURCE_TYPES
        }
        if slide in external:
            if brief.get("externalContextRequired") is not True:
                errors.append(f"第 {slide} 页 externalContextRequired 必须为 true")
            if len(web_source_ids) < limits[
                "minimumWebSourcesPerExternalContextSlide"
            ]:
                errors.append(
                    f"第 {slide} 页外部环境内容至少需要 "
                    f"{limits['minimumWebSourcesPerExternalContextSlide']} 个网络来源"
                )

        page_audit.append(
            {
                "slide": slide,
                "slideType": slide_type,
                "densityStatus": brief.get("densityStatus"),
                "contentItemCount": len(content_keys),
                "evidenceItemCount": len(evidence_ids),
                "researchQueryCount": len(research_queries),
                "webSourceCount": len(web_source_ids),
                "externalContextRequired": slide in external,
                "textCapacity": text_utilization.get(slide, []),
                "status": (
                    "passed" if len(errors) == page_errors_before else "failed"
                ),
            }
        )

    return {
        "required": True,
        "status": "passed" if len(errors) == initial_error_count else "failed",
        "policy": policy,
        "pages": page_audit,
    }


def validate_content_policy(
    manifest: dict[str, Any],
    errors: list[str],
) -> dict[str, Any]:
    initial_error_count = len(errors)
    required = str(manifest.get("schemaVersion", "")) in PAGE_CLOSURE_SCHEMA_VERSIONS
    policy = manifest.get("contentPolicy")
    if not required:
        return {"required": False, "status": "not-required"}
    if not isinstance(policy, dict):
        errors.append("1.4/1.5/1.6 版必须提供 contentPolicy")
        return {"required": True, "status": "missing"}
    expected = {
        "optionalMissingAction": "delete-slot-group",
        "requiredMissingAction": "dedicated-gap-slide-only",
        "unavailableWebsiteAction": "omit-slot",
        "forbidOperationalPlaceholders": True,
    }
    for field, value in expected.items():
        if policy.get(field) != value:
            errors.append(f"contentPolicy.{field} 必须为 {value!r}")
    return {
        "required": True,
        "status": "passed" if len(errors) == initial_error_count else "failed",
        "policy": policy,
    }


def validate_residual_policy(
    manifest: dict[str, Any],
    errors: list[str],
) -> dict[str, Any]:
    initial_error_count = len(errors)
    required = str(manifest.get("schemaVersion", "")) in PAGE_CLOSURE_SCHEMA_VERSIONS
    policy = manifest.get("residualPolicy")
    if not required:
        return {"required": False, "status": "not-required"}
    if not isinstance(policy, dict):
        errors.append("1.4/1.5/1.6 版必须提供 residualPolicy")
        return {"required": True, "status": "missing"}
    forbidden_terms = policy.get("forbiddenTextTerms")
    required_terms = policy.get("requiredTextTerms")
    forbidden_media = policy.get("forbiddenMediaSha256")
    gap_only_terms = policy.get("gapOnlyTextTerms")
    gap_slides = policy.get("gapSlideNumbers")
    forbidden_numbers = policy.get("forbiddenNumericTokens", [])
    if not isinstance(forbidden_terms, list) or not all(
        isinstance(value, str) and value.strip() for value in forbidden_terms or []
    ):
        errors.append("residualPolicy.forbiddenTextTerms 必须是非空字符串数组")
        forbidden_terms = []
    normalized_forbidden = {str(value).strip() for value in forbidden_terms}
    for term in DEFAULT_FORBIDDEN_OPERATIONAL_TERMS:
        if term not in normalized_forbidden:
            errors.append(
                f"1.4/1.5 版 forbiddenTextTerms 必须包含后台缺口提示：{term}"
            )
    if not isinstance(required_terms, list) or not all(
        isinstance(value, str) and value.strip() for value in required_terms or []
    ):
        errors.append("residualPolicy.requiredTextTerms 必须是非空字符串数组")
        required_terms = []
    project_name = str(manifest.get("projectName", "")).strip()
    if project_name and project_name not in {str(v).strip() for v in required_terms}:
        errors.append("residualPolicy.requiredTextTerms 必须包含 projectName")
    if not isinstance(forbidden_media, list) or not all(
        isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value)
        for value in forbidden_media or []
    ):
        errors.append(
            "residualPolicy.forbiddenMediaSha256 必须是 SHA-256 字符串数组"
        )
        forbidden_media = []
    if not isinstance(gap_only_terms, list) or not all(
        isinstance(value, str) and value.strip() for value in gap_only_terms or []
    ):
        errors.append("residualPolicy.gapOnlyTextTerms 必须是字符串数组")
        gap_only_terms = []
    if not isinstance(gap_slides, list) or not all(
        isinstance(value, int) and value > 0 for value in gap_slides or []
    ):
        errors.append("residualPolicy.gapSlideNumbers 必须是正整数数组")
        gap_slides = []
    if policy.get("ocrRequired") is not True:
        errors.append("1.4/1.5 版 residualPolicy.ocrRequired 必须为 true")
    if str(manifest.get("schemaVersion", "")) in CONTENT_SAFE_SCHEMA_VERSIONS:
        if not isinstance(forbidden_numbers, list) or not all(
            isinstance(value, str) and value.strip()
            for value in forbidden_numbers
        ):
            errors.append("1.5 版 forbiddenNumericTokens 必须是字符串数组")
            forbidden_numbers = []
        if policy.get("scanEmbeddedData") is not True:
            errors.append("1.5 版 residualPolicy.scanEmbeddedData 必须为 true")
    return {
        "required": True,
        "status": "passed" if len(errors) == initial_error_count else "failed",
        "forbiddenTextTerms": forbidden_terms,
        "requiredTextTerms": required_terms,
        "forbiddenMediaSha256": forbidden_media,
        "gapOnlyTextTerms": gap_only_terms,
        "gapSlideNumbers": gap_slides,
        "forbiddenNumericTokens": forbidden_numbers,
        "scanEmbeddedData": policy.get("scanEmbeddedData") is True,
        "ocrRequired": policy.get("ocrRequired") is True,
    }


def validate_page_closures(
    manifest: dict[str, Any],
    objects: dict[tuple[int, int], dict[str, Any]],
    operations: list[dict[str, Any]],
    groups: dict[str, dict[str, Any]],
    slide_count: int,
    errors: list[str],
) -> list[dict[str, Any]]:
    if str(manifest.get("schemaVersion", "")) not in PAGE_CLOSURE_SCHEMA_VERSIONS:
        return []
    raw_closures = manifest.get("pageClosures")
    if not isinstance(raw_closures, list):
        errors.append("1.4/1.5/1.6 版必须提供 pageClosures 数组")
        return []
    operations_by_slide: dict[int, set[int]] = {}
    registered_evidence_ids = {
        str(item.get("evidenceId"))
        for item in manifest.get("evidenceRegistry", [])
        if isinstance(item, dict) and item.get("evidenceId")
    }
    protected_decisions = {
        (int(item.get("slide", 0)), int(item.get("shapeId", 0))): item
        for item in manifest.get("protectedObjects", [])
        if isinstance(item, dict)
    }
    for operation in operations:
        if operation.get("action") in CONTROLLED_ADDITIVE_ACTIONS:
            continue
        try:
            slide = int(operation.get("slide", 0))
        except (TypeError, ValueError):
            continue
        operations_by_slide.setdefault(slide, set()).update(
            shape_ids_for(operation, groups)
        )
    closures: dict[int, dict[str, Any]] = {}
    audit: list[dict[str, Any]] = []
    for index, closure in enumerate(raw_closures, 1):
        prefix = f"第 {index} 个页面闭环"
        if not isinstance(closure, dict):
            errors.append(f"{prefix}必须是对象")
            continue
        try:
            slide = int(closure.get("slide", 0))
            reviewed = {int(value) for value in closure.get("reviewedShapeIds", [])}
            allowed_keep = {
                int(value) for value in closure.get("allowedKeepShapeIds", [])
            }
            targets = {int(value) for value in closure.get("targetShapeIds", [])}
            unknown = {int(value) for value in closure.get("unknownShapeIds", [])}
        except (TypeError, ValueError):
            errors.append(f"{prefix}包含无效 shapeId")
            continue
        if slide <= 0:
            errors.append(f"{prefix} slide 必须是正整数")
            continue
        if slide in closures:
            errors.append(f"{prefix}页码重复：{slide}")
        closures[slide] = closure
        actual = {shape_id for page, shape_id in objects if page == slide}
        expected_targets = operations_by_slide.get(slide, set())
        failures: list[str] = []
        if reviewed != actual:
            failures.append(
                f"reviewedShapeIds 未覆盖整页；缺少 {sorted(actual - reviewed)}，"
                f"多出 {sorted(reviewed - actual)}"
            )
        if targets != expected_targets:
            failures.append(
                f"targetShapeIds 与操作不一致；缺少 {sorted(expected_targets - targets)}，"
                f"多出 {sorted(targets - expected_targets)}"
            )
        if unknown:
            failures.append(f"仍有未分类对象：{sorted(unknown)}")
        if allowed_keep & targets:
            failures.append(
                f"allowedKeepShapeIds 与 targetShapeIds 重叠："
                f"{sorted(allowed_keep & targets)}"
            )
        if allowed_keep | targets | unknown != reviewed:
            failures.append("保留、目标和未分类对象的并集必须等于 reviewedShapeIds")
        if str(manifest.get("schemaVersion", "")) in CONTENT_SAFE_SCHEMA_VERSIONS:
            decisions = closure.get("keepDecisions")
            if not isinstance(decisions, list):
                failures.append("1.5 版必须提供 keepDecisions")
                decisions = []
            decision_ids: set[int] = set()
            for decision in decisions:
                if not isinstance(decision, dict):
                    failures.append("keepDecisions 包含非对象")
                    continue
                try:
                    decision_id = int(decision.get("shapeId", 0))
                except (TypeError, ValueError):
                    decision_id = 0
                if decision_id <= 0:
                    failures.append("keepDecisions 包含无效 shapeId")
                    continue
                if decision_id in decision_ids:
                    failures.append(f"keepDecisions 重复 shapeId={decision_id}")
                decision_ids.add(decision_id)
                decision_reason = str(decision.get("reason", "")).strip()
                if not decision_reason:
                    failures.append(f"shapeId={decision_id} 缺少具体 keep reason")
                elif (
                    len(decision_reason) < 8
                    or decision_reason in GENERIC_KEEP_REASONS
                ):
                    failures.append(
                        f"shapeId={decision_id} 的 keep reason 过于笼统"
                    )
                classification = decision.get("classification")
                target_object = objects.get((slide, decision_id), {})
                if (
                    target_object.get("kind") in {"chart", "table"}
                    and classification != "evidence_backed_context"
                ):
                    failures.append(
                        f"shapeId={decision_id} 是原生数据对象，"
                        "只能作为 evidence_backed_context 保留"
                    )
                if (
                    str(target_object.get("text", "")).strip()
                    and classification in {"fixed_visual", "generic_decoration"}
                ):
                    failures.append(
                        f"shapeId={decision_id} 包含可见文字，"
                        f"不能分类为 {classification}"
                    )
                if (
                    str(target_object.get("text", "")).strip()
                    and classification == "template_brand"
                ):
                    failures.append(
                        f"shapeId={decision_id} 的可见文字不能作为 template_brand 保留"
                    )
                if (
                    str(target_object.get("text", "")).strip()
                    and classification == "template_label"
                    and not is_generic_template_label(target_object.get("text"))
                ):
                    failures.append(
                        f"shapeId={decision_id} 不是封闭词表中的通用模板标签"
                    )
                if classification == "evidence_backed_context":
                    decision_evidence_ids = decision.get("evidenceIds")
                    if (
                        not isinstance(decision_evidence_ids, list)
                        or not decision_evidence_ids
                    ):
                        failures.append(
                            f"shapeId={decision_id} 的证据上下文缺少 evidenceIds"
                        )
                    else:
                        missing_evidence = {
                            str(value) for value in decision_evidence_ids
                        } - registered_evidence_ids
                        if missing_evidence:
                            failures.append(
                                f"shapeId={decision_id} 引用不存在的 evidenceIds："
                                f"{sorted(missing_evidence)}"
                            )
                elif classification not in PROTECTED_CLASSES:
                    failures.append(
                        f"shapeId={decision_id} 的 keep classification 不受支持"
                    )
                else:
                    protected_item = protected_decisions.get((slide, decision_id))
                    if (
                        not protected_item
                        or protected_item.get("classification") != classification
                    ):
                        failures.append(
                            f"shapeId={decision_id} 的保留决定未与 protectedObjects "
                            "同分类登记"
                        )
            if decision_ids != allowed_keep:
                failures.append(
                    "keepDecisions 必须逐一覆盖 allowedKeepShapeIds；"
                    f"缺少 {sorted(allowed_keep - decision_ids)}，"
                    f"多出 {sorted(decision_ids - allowed_keep)}"
                )
        for failure in failures:
            errors.append(f"{prefix}{failure}")
        audit.append(
            {
                "slide": slide,
                "reviewedShapeCount": len(reviewed),
                "allowedKeepShapeCount": len(allowed_keep),
                "targetShapeCount": len(targets),
                "unknownShapeIds": sorted(unknown),
                "status": "passed" if not failures else "failed",
            }
        )
    modified_slides = set(operations_by_slide)
    if str(manifest.get("schemaVersion", "")) in CONTENT_SAFE_SCHEMA_VERSIONS:
        expected_slides = set(range(1, slide_count + 1))
        missing_closures = expected_slides - set(closures)
        extra_closures = set(closures) - expected_slides
        if missing_closures:
            errors.append(
                f"1.5/1.6 版全部页面都必须闭环：缺少 {sorted(missing_closures)}"
            )
        if extra_closures:
            errors.append(f"pageClosures 包含不存在页面：{sorted(extra_closures)}")
    else:
        missing_closures = modified_slides - set(closures)
        extra_closures = set(closures) - modified_slides
        if missing_closures:
            errors.append(f"修改页缺少页面闭环：{sorted(missing_closures)}")
        if extra_closures:
            errors.append(f"pageClosures 包含未修改页面：{sorted(extra_closures)}")
    return audit


def validate_manifest(
    manifest: dict[str, Any], template_map: dict[str, Any]
) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    objects = object_index(template_map)
    schema_version = str(manifest.get("schemaVersion", ""))

    if schema_version not in SUPPORTED_SCHEMA_VERSIONS:
        errors.append(
            "schemaVersion 必须为 1.0、1.1、1.2、1.3、1.4、1.5 或 1.6"
        )
    expected_default = (
        "FAIL_UNCLASSIFIED_CONTENT"
        if schema_version in CONTENT_SAFE_SCHEMA_VERSIONS
        else "KEEP"
    )
    if manifest.get("defaultAction") != expected_default:
        errors.append(
            f"{schema_version or '当前'} 版 defaultAction 必须为 {expected_default}"
        )
    if not str(manifest.get("projectName", "")).strip():
        errors.append("projectName 不能为空")
    template_pptx = Path(str(manifest.get("templatePptx", ""))).expanduser()
    if not template_pptx.is_absolute():
        errors.append("templatePptx 必须是绝对路径")
    elif not template_pptx.exists():
        errors.append(f"templatePptx 不存在：{template_pptx}")
    expected_sha = str(manifest.get("templateSha256", ""))
    map_sha = str(template_map.get("sha256", ""))
    if expected_sha and expected_sha != map_sha:
        errors.append("replacement-manifest 与 template-map 的 SHA-256 不一致")

    handoff_audit = validate_conversion_handoff(
        manifest, template_map, errors
    )
    groups, shape_membership, slot_audit = slot_group_index(
        manifest, objects, errors
    )
    protected, protected_audit = protected_object_index(
        manifest, objects, errors
    )
    for key, group_id in shape_membership.items():
        if key in protected:
            errors.append(
                f"受保护对象第 {key[0]} 页 shapeId={key[1]} "
                f"不得进入可删除槽位组 {group_id}"
            )
    assignments, shape_assignments, assignment_audit = slot_assignment_index(
        manifest, objects, groups, protected, errors
    )
    content_policy_audit = validate_content_policy(manifest, errors)
    residual_policy_audit = validate_residual_policy(manifest, errors)

    operations = manifest.get("operations")
    if not isinstance(operations, list):
        errors.append("operations 必须是数组")
        operations = []
    declared_deleted_shape_keys: set[tuple[int, int]] = set()
    for operation in operations:
        if (
            not isinstance(operation, dict)
            or operation.get("action") != "delete_slot_group"
        ):
            continue
        try:
            operation_slide = int(operation.get("slide", 0))
        except (TypeError, ValueError):
            continue
        declared_deleted_shape_keys.update(
            (operation_slide, shape_id)
            for shape_id in shape_ids_for(operation, groups)
        )

    seen: set[tuple[int, int]] = set()
    replaced_text = 0
    added_disclaimer_textboxes = 0
    replaced_images = 0
    deleted_targets = 0
    text_object_count = sum(1 for item in objects.values() if item.get("text"))
    image_object_count = sum(
        1 for item in objects.values() if item.get("kind") == "picture"
    )
    typography_audit: list[dict[str, Any]] = []
    deletion_audit: list[dict[str, Any]] = []
    logo_audit: list[dict[str, Any]] = []

    for index, operation in enumerate(operations, 1):
        prefix = f"第 {index} 项"
        if not isinstance(operation, dict):
            errors.append(f"{prefix}必须是对象")
            continue
        action = operation.get("action")
        if action not in ALLOWED_ACTIONS:
            errors.append(f"{prefix} action 不受支持：{action}")
            continue
        try:
            slide = int(operation.get("slide", 0))
        except (TypeError, ValueError):
            slide = 0
        if slide <= 0:
            errors.append(f"{prefix} slide 必须是正整数")
        for field in ("role", "reason", "sourceNote"):
            if not str(operation.get(field, "")).strip():
                errors.append(f"{prefix}缺少非空字段 {field}")
        if action not in STRUCTURAL_ACTIONS and operation.get(
            "fitPolicy", "preserve"
        ) != "preserve":
            errors.append(f"{prefix} fitPolicy 必须为 preserve")

        target_ids = shape_ids_for(operation, groups)
        if action == "replace_text_group" and len(target_ids) < 2:
            errors.append(f"{prefix} replace_text_group 至少需要两个 shapeIds")
        if action == "replace_text_group":
            primary_shape_id = operation.get("primaryShapeId")
            if schema_version == "1.4":
                if not isinstance(primary_shape_id, int):
                    errors.append(
                        f"{prefix}1.4 版 replace_text_group 必须包含 primaryShapeId"
                    )
                elif primary_shape_id not in target_ids:
                    errors.append(f"{prefix} primaryShapeId 必须属于 shapeIds")
            elif schema_version in CONTENT_SAFE_SCHEMA_VERSIONS:
                group_mode = operation.get("groupMode")
                if group_mode not in {
                    "fragment-map",
                    "line-reflow",
                    "composite-box",
                }:
                    errors.append(f"{prefix}1.5 版必须声明有效 groupMode")
                if group_mode == "composite-box":
                    if not isinstance(primary_shape_id, int):
                        errors.append(
                            f"{prefix}composite-box 必须包含 primaryShapeId"
                        )
                    elif primary_shape_id not in target_ids:
                        errors.append(f"{prefix} primaryShapeId 必须属于 shapeIds")
                else:
                    fragments = operation.get("fragmentTexts")
                    if not isinstance(fragments, list):
                        errors.append(f"{prefix}{group_mode} 必须提供 fragmentTexts")
                        fragments = []
                    fragment_ids = [
                        item.get("shapeId")
                        for item in fragments
                        if isinstance(item, dict)
                    ]
                    if len(fragment_ids) != len(set(fragment_ids)):
                        errors.append(f"{prefix} fragmentTexts 的 shapeId 不得重复")
                    if set(fragment_ids) != set(target_ids):
                        errors.append(
                            f"{prefix} fragmentTexts 必须逐一覆盖 shapeIds"
                        )
                    if any(
                        not isinstance(item.get("text"), str)
                        for item in fragments
                        if isinstance(item, dict)
                    ):
                        errors.append(f"{prefix} fragmentTexts.text 必须是字符串")
        elif action == "delete_slot_group":
            group_id = str(operation.get("slotGroupId", "")).strip()
            group = groups.get(group_id)
            if not group:
                errors.append(f"{prefix}未找到 slotGroupId={group_id}")
            else:
                if int(group.get("slide", 0)) != slide:
                    errors.append(f"{prefix}槽位组页码与操作页码不一致")
                if group.get("optional") is not True:
                    errors.append(f"{prefix}只能删除 optional=true 的完整槽位组")
                if operation.get("missingContent") is not True:
                    errors.append(f"{prefix}删除槽位组必须设置 missingContent=true")
                deletion_audit.append(
                    {
                        "operationIndex": index,
                        "slotGroupId": group_id,
                        "slide": slide,
                        "shapeIds": target_ids,
                        "reason": operation.get("reason"),
                        "status": "authorized-complete-group-delete",
                    }
                )
                deleted_targets += len(target_ids)
        elif len(target_ids) != 1:
            errors.append(f"{prefix}缺少有效 shapeId")

        if action in CONTROLLED_ADDITIVE_ACTIONS:
            shape_id = target_ids[0] if len(target_ids) == 1 else 0
            key = (slide, shape_id)
            if slide != int(template_map.get("slideCount", 0)):
                errors.append(f"{prefix}责任声明文本框只能添加到最后一页")
            if operation.get("role") != "责任声明":
                errors.append(f"{prefix}受控新增文本框 role 必须为责任声明")
            if operation.get("name") != "references.disclaimer.generated":
                errors.append(
                    f"{prefix}受控新增文本框 name 必须为 "
                    "references.disclaimer.generated"
                )
            if not str(operation.get("semanticKey", "")).endswith(
                ".generated.disclaimer"
            ):
                errors.append(f"{prefix}责任声明 semanticKey 不符合约定")
            if not str(operation.get("text", "")).strip():
                errors.append(f"{prefix}责任声明 text 不能为空")
            if operation.get("styleLock") != "controlled-disclaimer":
                errors.append(
                    f"{prefix}责任声明 styleLock 必须为 controlled-disclaimer"
                )
            if shape_id <= 0:
                errors.append(f"{prefix}责任声明 shapeId 必须为正整数")
            elif key in objects:
                errors.append(f"{prefix}责任声明 shapeId={shape_id} 已被模板占用")
            elif key in seen:
                errors.append(f"{prefix}重复新增第 {slide} 页 shapeId={shape_id}")
            seen.add(key)
            bbox = operation.get("bbox")
            valid_bbox = (
                isinstance(bbox, list)
                and len(bbox) == 4
                and all(isinstance(value, (int, float)) for value in bbox)
                and all(float(value) >= 0 for value in bbox)
                and float(bbox[2]) > 0
                and float(bbox[3]) > 0
            )
            if not valid_bbox:
                errors.append(f"{prefix}责任声明 bbox 必须是有效的四项像素数组")
            else:
                slide_map = next(
                    (
                        item
                        for item in template_map.get("slides", [])
                        if int(item.get("number", 0)) == slide
                    ),
                    {},
                )
                width_px = float(slide_map.get("widthEmu", 0)) / 9525
                height_px = float(slide_map.get("heightEmu", 0)) / 9525
                if width_px and float(bbox[0]) + float(bbox[2]) > width_px + 1:
                    errors.append(f"{prefix}责任声明文本框超出页面宽度")
                if height_px and float(bbox[1]) + float(bbox[3]) > height_px + 1:
                    errors.append(f"{prefix}责任声明文本框超出页面高度")
            font_size = operation.get("fontSize")
            if not isinstance(font_size, (int, float)) or not 8 <= float(
                font_size
            ) <= 18:
                errors.append(f"{prefix}责任声明字号必须在 8–18 pt")
            if not str(operation.get("fontFace", "")).strip():
                errors.append(f"{prefix}责任声明 fontFace 不能为空")
            if not re.fullmatch(
                r"[0-9A-Fa-f]{6}",
                str(operation.get("fontColor", "")),
            ):
                errors.append(f"{prefix}责任声明 fontColor 必须为六位十六进制颜色")
            added_disclaimer_textboxes += 1
            continue

        target_objects: list[dict[str, Any]] = []
        for shape_id in target_ids:
            key = (slide, shape_id)
            if schema_version in STRICT_SLOT_SCHEMA_VERSIONS:
                assignment_id = shape_assignments.get(key)
                if not assignment_id:
                    errors.append(
                        f"{prefix}目标第 {slide} 页 shapeId={shape_id} "
                        "未进入 slotAssignments"
                    )
                else:
                    expected_semantic = str(
                        assignments[assignment_id].get("semanticKey", "")
                    )
                    actual_semantic = str(
                        operation.get("semanticKey", "")
                    ).strip()
                    if not actual_semantic:
                        errors.append(f"{prefix}1.2 及以上版本操作必须包含 semanticKey")
                    elif actual_semantic != expected_semantic:
                        errors.append(
                            f"{prefix} semanticKey={actual_semantic} 与槽位 "
                            f"{assignment_id} 的 {expected_semantic} 不一致"
                        )
            if key in protected:
                protected_item = protected[key]
                errors.append(
                    f"{prefix}试图修改受保护对象：第 {slide} 页 shapeId={shape_id} "
                    f"({protected_item.get('classification')})"
                )
            if key in seen:
                errors.append(f"{prefix}重复修改第 {slide} 页 shapeId={shape_id}")
            seen.add(key)
            target = objects.get(key)
            if target is None:
                errors.append(f"{prefix}未找到第 {slide} 页 shapeId={shape_id}")
            else:
                target_objects.append(target)

        if action in TEXT_ACTIONS:
            replaced_text += len(target_ids)
            if schema_version in RELATIONSHIP_SCHEMA_VERSIONS and operation.get(
                "styleLock"
            ) != "exact":
                errors.append(f"{prefix}1.1 及以上文字操作必须设置 styleLock=exact")
            group_mode = operation.get("groupMode")
            uses_fragment_text = (
                action == "replace_text_group"
                and group_mode in {"fragment-map", "line-reflow"}
            )
            if not uses_fragment_text:
                if not isinstance(operation.get("text"), str):
                    errors.append(f"{prefix}文字替换必须包含字符串 text")
                elif (
                    operation.get("text") == ""
                    and operation.get("allowEmpty") is not True
                ):
                    errors.append(f"{prefix}清空文字必须显式设置 allowEmpty=true")
            for shape_id in target_ids:
                target = objects.get((slide, shape_id))
                if target is None:
                    continue
                if not str(target.get("kind", "")).startswith("shape:"):
                    errors.append(f"{prefix}文字目标不是普通可编辑形状")
                    continue
                original_text = str(target.get("text", ""))
                replacement_text = (
                    operation_text_for_shape(operation, shape_id) or ""
                )
                original_lines = max(1, original_text.count("\n") + 1)
                replacement_lines = max(1, replacement_text.count("\n") + 1)
                if (
                    original_text
                    and original_lines != replacement_lines
                    and operation.get("allowLineCountChange") is not True
                ):
                    warnings.append(
                        f"{prefix}替换前后行数不同（{original_lines}→"
                        f"{replacement_lines}），应人工调整换行并核对排版"
                    )
                if (
                    original_text
                    and len(replacement_text.replace("\n", ""))
                    > max(8, len(original_text.replace("\n", "")) * 1.25)
                ):
                    warnings.append(
                        f"{prefix}新文字明显长于原文字，字体字号不得改变，"
                        "应先精简内容或调整人工换行"
                    )
                typography_audit.append(
                    {
                        "operationIndex": index,
                        "slide": slide,
                        "shapeId": shape_id,
                        "styleLock": operation.get("styleLock", "legacy-preserve"),
                        "originalLineCount": original_lines,
                        "replacementLineCount": replacement_lines,
                        "templateStyle": style_snapshot(target),
                        "status": "locked",
                    }
                )
                group_id = shape_membership.get((slide, shape_id))
                if (
                    replacement_text == ""
                    and group_id
                    and groups[group_id].get("optional") is True
                ):
                    warnings.append(
                        f"{prefix}正在清空可选槽位 {group_id} 的单个文字对象；"
                        "若该槽位无对应内容，应改用 delete_slot_group 删除完整槽位"
                    )

        elif action == "replace_image":
            replaced_images += 1
            raw_asset, asset = asset_paths(operation.get("asset"))
            if not raw_asset.is_absolute():
                errors.append(f"{prefix}图片 asset 必须是绝对路径")
            elif not asset.exists():
                errors.append(f"{prefix}图片 asset 不存在：{asset}")
            elif schema_version in PAGE_CLOSURE_SCHEMA_VERSIONS:
                actual_asset_sha256 = hashlib.sha256(asset.read_bytes()).hexdigest()
                declared_asset_sha256 = str(
                    operation.get("assetSha256", "")
                ).strip()
                if not re.fullmatch(r"[0-9a-f]{64}", declared_asset_sha256):
                    errors.append(
                        f"{prefix}1.4/1.5 版图片替换必须声明 assetSha256"
                    )
                elif declared_asset_sha256 != actual_asset_sha256:
                    errors.append(f"{prefix} assetSha256 与图片文件不一致")
            asset_class = operation.get("assetClass")
            if asset_class not in ALLOWED_ASSET_CLASSES:
                errors.append(f"{prefix} assetClass 不受支持：{asset_class}")
            logo_like_operation = bool(
                re.search(
                    r"(?:^|[._\-\s])logo(?:$|[._\-\s])|标志|标识",
                    " ".join(
                        [
                            str(operation.get("semanticKey", "")),
                            str(operation.get("role", "")),
                            str(operation.get("reason", "")),
                        ]
                    ),
                    flags=re.IGNORECASE,
                )
            )
            if (
                schema_version in BACKGROUND_LOCK_SCHEMA_VERSIONS
                and logo_like_operation
                and asset_class != "company_logo"
            ):
                errors.append(
                    f"{prefix}语义上属于 Logo，assetClass 必须为 company_logo，"
                    "不得用 company_specific_visual 绕过透明底与底板门禁"
                )
            if not (
                operation.get("companySpecific") is True
                or operation.get("explicitUserApproval") is True
            ):
                errors.append(
                    f"{prefix}图片替换必须是公司专属素材，或具有 explicitUserApproval=true"
                )
            for target in target_objects:
                if target.get("kind") != "picture":
                    errors.append(f"{prefix}图片目标不是 picture")
                if target.get("role") == "icon":
                    if not (
                        operation.get("allowIconSlotReplacement") is True
                        and operation.get("explicitUserApproval") is True
                    ):
                        errors.append(
                            f"{prefix}候选图标默认复用；确需替换时必须同时设置 "
                            "allowIconSlotReplacement=true 和 explicitUserApproval=true"
                        )
                    else:
                        warnings.append(
                            f"{prefix}将替换候选图标，请核对该对象不是共享语义图标"
                        )
            if schema_version in CONTENT_SAFE_SCHEMA_VERSIONS:
                if operation.get("imageFitMode") not in {
                    "contain",
                    "cover",
                    "preserve-crop",
                }:
                    errors.append(f"{prefix}1.5 版图片替换必须声明 imageFitMode")
                if operation.get("aspectRatioValidated") is not True:
                    errors.append(f"{prefix}1.5 版图片替换必须完成宽高比核对")
                if (
                    operation.get("imageFitMode") in {"contain", "cover"}
                    and operation.get("fitPreparedAsset") is not True
                ):
                    errors.append(
                        f"{prefix}contain/cover 素材必须先按原图片框比例预处理，"
                        "并设置 fitPreparedAsset=true"
                    )
            if (
                schema_version in BACKGROUND_LOCK_SCHEMA_VERSIONS
                and (asset_class == "company_logo" or logo_like_operation)
                and asset.exists()
            ):
                logo_audit.append(
                    validate_logo_operation(
                        operation,
                        index,
                        template_map,
                        protected,
                        declared_deleted_shape_keys,
                        asset,
                        errors,
                    )
                )

        elif action == "replace_chart_data":
            for target in target_objects:
                if target.get("kind") != "chart":
                    errors.append(f"{prefix}图表数据目标不是原生 chart")
            categories = operation.get("categories")
            series = operation.get("series")
            if not isinstance(categories, list) or not categories:
                errors.append(f"{prefix}图表 categories 必须是非空数组")
            if not isinstance(series, list) or not series:
                errors.append(f"{prefix}图表 series 必须是非空数组")
            else:
                for series_index, item in enumerate(series, 1):
                    if not isinstance(item, dict) or not str(
                        item.get("name", "")
                    ).strip():
                        errors.append(f"{prefix}第 {series_index} 个系列缺少 name")
                        continue
                    values = item.get("values")
                    if not isinstance(values, list):
                        errors.append(
                            f"{prefix}第 {series_index} 个系列 values 必须是数组"
                        )
                    elif categories and len(values) != len(categories):
                        errors.append(
                            f"{prefix}第 {series_index} 个系列长度与 categories 不一致"
                        )
                    elif any(
                        not isinstance(value, (int, float)) for value in values
                    ):
                        errors.append(f"{prefix}图表 values 只能包含数字")

        elif action == "replace_table_data":
            for target in target_objects:
                if target.get("kind") != "table":
                    errors.append(f"{prefix}表格数据目标不是原生 table")
            values = operation.get("values")
            if not isinstance(values, list) or not values:
                errors.append(f"{prefix}表格 values 必须是非空二维数组")
            elif any(not isinstance(row, list) for row in values):
                errors.append(f"{prefix}表格 values 必须是二维数组")
            else:
                widths = {len(row) for row in values}
                if len(widths) != 1 or 0 in widths:
                    errors.append(f"{prefix}表格每一行必须具有相同的非零列数")

    binding_audit = validate_entity_bindings(
        manifest,
        objects,
        groups,
        [op for op in operations if isinstance(op, dict)],
        errors,
        require_relationships=schema_version in RELATIONSHIP_SCHEMA_VERSIONS,
    )
    research_audit = validate_research_evidence(
        manifest,
        [op for op in operations if isinstance(op, dict)],
        errors,
    )
    content_safety_audit = validate_content_safety_model(
        manifest,
        template_map,
        [op for op in operations if isinstance(op, dict)],
        errors,
    )
    content_density_audit = validate_content_density(
        manifest,
        template_map,
        [op for op in operations if isinstance(op, dict)],
        errors,
    )
    coverage_audit = validate_slot_coverage(
        assignments,
        shape_assignments,
        [op for op in operations if isinstance(op, dict)],
        groups,
        errors,
    )
    background_audit = validate_background_policy(
        manifest,
        template_map,
        protected,
        groups,
        [op for op in operations if isinstance(op, dict)],
        errors,
    )
    page_closure_audit = validate_page_closures(
        manifest,
        objects,
        [op for op in operations if isinstance(op, dict)],
        groups,
        int(template_map.get("slideCount", 0)),
        errors,
    )

    if added_disclaimer_textboxes > 1:
        errors.append("每份 PPTX 最多允许新增一个受控责任声明文本框")
    if text_object_count and replaced_text / text_object_count > 0.8:
        warnings.append("文字替换超过模板文字对象的80%，请确认不是无差别清空或改写")
    if image_object_count and replaced_images / image_object_count > 0.35:
        warnings.append("图片替换超过模板图片对象的35%，必须逐项核对是否均为公司专属素材")

    return {
        "passed": not errors,
        "errors": errors,
        "warnings": warnings,
        "metrics": {
            "templateObjectCount": len(objects),
            "templateTextObjectCount": text_object_count,
            "templateImageObjectCount": image_object_count,
            "authorizedOperationCount": len(operations),
            "authorizedTargetCount": len(seen),
            "authorizedTextTargetCount": replaced_text,
            "authorizedAddedDisclaimerTextBoxCount": added_disclaimer_textboxes,
            "authorizedImageTargetCount": replaced_images,
            "authorizedDeletedTargetCount": deleted_targets,
            "protectedObjectCount": len(protected),
            "slotGroupCount": len(groups),
            "slotAssignmentCount": len(assignments),
            "entityBindingCount": len(binding_audit),
            "sourceCount": len(research_audit.get("sources", [])),
            "evidenceCount": len(research_audit.get("evidence", [])),
            "pageClosureCount": len(page_closure_audit),
            "defaultKeptObjectCount": max(
                0,
                len(objects) - sum(key in objects for key in seen),
            ),
        },
        "slotAudit": {
            "groups": slot_audit,
            "deletions": deletion_audit,
            "assignments": assignment_audit,
            "coverage": coverage_audit,
        },
        "typographyAudit": {
            "locks": typography_audit,
            "policy": "字体、字号、颜色、坐标、尺寸和层级保持模板值",
        },
        "assetBindingAudit": {
            "bindings": binding_audit,
            "policy": "人物/产品图片必须与姓名、职务、产品名或型号槽位显式绑定",
        },
        "logoAudit": {
            "operations": logo_audit,
            "policy": (
                "公司 Logo 使用可验证透明底素材；"
                "高重叠相邻对象必须逐项识别为模板底板、旧公司底板或遮罩"
            ),
        },
        "backgroundAudit": background_audit,
        "protectedObjectAudit": {
            "objects": protected_audit,
            "policy": "共享语义图标与固定视觉对象不进入替换操作",
        },
        "conversionHandoffAudit": handoff_audit,
        "researchEvidenceAudit": research_audit,
        "contentPolicyAudit": content_policy_audit,
        "residualPolicyAudit": residual_policy_audit,
        "contentSafetyAudit": content_safety_audit,
        "contentDensityAudit": content_density_audit,
        "pageClosureAudit": {
            "pages": page_closure_audit,
            "policy": (
                "1.5 版全部页面对象必须闭环；旧版修改页对象必须闭环；"
                "未分类必须为零"
            ),
        },
    }


def write_json(path: Path, payload: dict[str, Any]) -> Path:
    output = path.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="校验可编辑PPT内容替换白名单。")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--template-map", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()

    manifest = load_json(args.manifest)
    template_map = load_json(args.template_map)
    report = validate_manifest(manifest, template_map)
    output = write_json(args.report, report)
    report_dir = output.parent
    slot_report = write_json(
        report_dir / "slot-usage-report.json", report["slotAudit"]
    )
    typography_report = write_json(
        report_dir / "typography-fidelity-report.json",
        report["typographyAudit"],
    )
    binding_report = write_json(
        report_dir / "asset-binding-report.json", report["assetBindingAudit"]
    )
    protected_report = write_json(
        report_dir / "protected-object-report.json",
        report["protectedObjectAudit"],
    )
    background_report = write_json(
        report_dir / "background-lock-report.json",
        report["backgroundAudit"],
    )
    logo_report = write_json(
        report_dir / "logo-transparency-report.json",
        report["logoAudit"],
    )
    handoff_report = write_json(
        report_dir / "conversion-handoff-audit.json",
        report["conversionHandoffAudit"],
    )
    research_report = write_json(
        report_dir / "research-evidence-report.json",
        report["researchEvidenceAudit"],
    )
    page_closure_report = write_json(
        report_dir / "page-closure-report.json",
        report["pageClosureAudit"],
    )
    residual_policy_report = write_json(
        report_dir / "residual-policy-report.json",
        report["residualPolicyAudit"],
    )
    content_safety_report = write_json(
        report_dir / "content-safety-report.json",
        report["contentSafetyAudit"],
    )
    content_density_report = write_json(
        report_dir / "content-density-report.json",
        report["contentDensityAudit"],
    )

    if report["passed"]:
        metrics = report["metrics"]
        keep_label = (
            "个对象经全页闭环允许保留"
            if str(manifest.get("schemaVersion", "")) in {"1.5", "1.6"}
            else "个对象默认保持不变"
        )
        print(
            "白名单校验通过："
            f"{metrics['authorizedTargetCount']} 个对象获授权，"
            f"{metrics['defaultKeptObjectCount']} {keep_label}，"
            f"{metrics['entityBindingCount']} 个实体关系已核对"
        )
        for warning in report["warnings"]:
            print("警告：", warning)
        print(f"已写入 {output}")
        print(
            "审计报告："
            f"{slot_report}；{typography_report}；"
            f"{binding_report}；{protected_report}；{background_report}；"
            f"{logo_report}；{handoff_report}；"
            f"{research_report}；{page_closure_report}；"
            f"{residual_policy_report}；{content_safety_report}；"
            f"{content_density_report}"
        )
    else:
        print("白名单校验失败：")
        for error in report["errors"]:
            print("-", error)
        print(f"已写入 {output}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
