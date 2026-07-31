#!/usr/bin/env python3
from __future__ import annotations

import argparse
from datetime import date
import hashlib
import json
from pathlib import Path
import re
from typing import Any
from urllib.parse import urlparse


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
    "template_brand",
    "generic_decoration",
}
SUPPORTED_SCHEMA_VERSIONS = {"1.0", "1.1", "1.2", "1.3", "1.4"}
RESEARCH_SCHEMA_VERSIONS = {"1.3", "1.4"}
STRICT_SLOT_SCHEMA_VERSIONS = {"1.2", "1.3", "1.4"}
RELATIONSHIP_SCHEMA_VERSIONS = {"1.1", "1.2", "1.3", "1.4"}
PAGE_CLOSURE_SCHEMA_VERSIONS = {"1.4"}
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
        errors.append("1.3/1.4 版必须提供 researchPolicy")
        policy = {}
    if policy.get("enabled") is not True:
        errors.append("1.3/1.4 版 researchPolicy.enabled 必须为 true")
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
        errors.append("1.3/1.4 版 sources 必须是数组")
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
        errors.append("1.3/1.4 版 evidenceRegistry 必须是数组")
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
            errors.append(f"{prefix}1.3/1.4 版操作必须包含非空 evidenceIds")
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
                            f"{prefix}1.4 版未披露/待核实内容只能写入专用缺口页"
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
        if not str(item.get("reason", "")).strip():
            errors.append(f"{prefix}缺少 reason")
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
                    if operation.get("action") in TEXT_ACTIONS and not str(
                        operation.get("text", "")
                    ).strip():
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
            primary = operation.get("primaryShapeId")
            if primary is None:
                shape_ids = operation.get("shapeIds", [])
                primary = shape_ids[0] if shape_ids else None
            if shape_id != primary:
                return ""
            return operation.get("text") if isinstance(operation.get("text"), str) else None
    return None


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
        errors.append("1.4 版必须提供 contentPolicy")
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
        errors.append("1.4 版必须提供 residualPolicy")
        return {"required": True, "status": "missing"}
    forbidden_terms = policy.get("forbiddenTextTerms")
    required_terms = policy.get("requiredTextTerms")
    forbidden_media = policy.get("forbiddenMediaSha256")
    gap_only_terms = policy.get("gapOnlyTextTerms")
    gap_slides = policy.get("gapSlideNumbers")
    if not isinstance(forbidden_terms, list) or not all(
        isinstance(value, str) and value.strip() for value in forbidden_terms or []
    ):
        errors.append("residualPolicy.forbiddenTextTerms 必须是非空字符串数组")
        forbidden_terms = []
    normalized_forbidden = {str(value).strip() for value in forbidden_terms}
    for term in DEFAULT_FORBIDDEN_OPERATIONAL_TERMS:
        if term not in normalized_forbidden:
            errors.append(
                f"1.4 版 forbiddenTextTerms 必须包含后台缺口提示：{term}"
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
        errors.append("1.4 版 residualPolicy.ocrRequired 必须为 true")
    return {
        "required": True,
        "status": "passed" if len(errors) == initial_error_count else "failed",
        "forbiddenTextTerms": forbidden_terms,
        "requiredTextTerms": required_terms,
        "forbiddenMediaSha256": forbidden_media,
        "gapOnlyTextTerms": gap_only_terms,
        "gapSlideNumbers": gap_slides,
        "ocrRequired": policy.get("ocrRequired") is True,
    }


def validate_page_closures(
    manifest: dict[str, Any],
    objects: dict[tuple[int, int], dict[str, Any]],
    operations: list[dict[str, Any]],
    groups: dict[str, dict[str, Any]],
    errors: list[str],
) -> list[dict[str, Any]]:
    if str(manifest.get("schemaVersion", "")) not in PAGE_CLOSURE_SCHEMA_VERSIONS:
        return []
    raw_closures = manifest.get("pageClosures")
    if not isinstance(raw_closures, list):
        errors.append("1.4 版必须提供 pageClosures 数组")
        return []
    operations_by_slide: dict[int, set[int]] = {}
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
        errors.append("schemaVersion 必须为 1.0、1.1、1.2、1.3 或 1.4")
    if manifest.get("defaultAction") != "KEEP":
        errors.append("defaultAction 必须为 KEEP")
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
            if schema_version in PAGE_CLOSURE_SCHEMA_VERSIONS:
                if not isinstance(primary_shape_id, int):
                    errors.append(
                        f"{prefix}1.4 版 replace_text_group 必须包含 primaryShapeId"
                    )
                elif primary_shape_id not in target_ids:
                    errors.append(f"{prefix} primaryShapeId 必须属于 shapeIds")
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
            if not isinstance(operation.get("text"), str):
                errors.append(f"{prefix}文字替换必须包含字符串 text")
            elif operation.get("text") == "" and operation.get("allowEmpty") is not True:
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
                        f"{prefix}1.4 版图片替换必须声明 assetSha256"
                    )
                elif declared_asset_sha256 != actual_asset_sha256:
                    errors.append(f"{prefix} assetSha256 与图片文件不一致")
            asset_class = operation.get("assetClass")
            if asset_class not in ALLOWED_ASSET_CLASSES:
                errors.append(f"{prefix} assetClass 不受支持：{asset_class}")
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
    coverage_audit = validate_slot_coverage(
        assignments,
        shape_assignments,
        [op for op in operations if isinstance(op, dict)],
        groups,
        errors,
    )
    page_closure_audit = validate_page_closures(
        manifest,
        objects,
        [op for op in operations if isinstance(op, dict)],
        groups,
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
        "protectedObjectAudit": {
            "objects": protected_audit,
            "policy": "共享语义图标与固定视觉对象不进入替换操作",
        },
        "conversionHandoffAudit": handoff_audit,
        "researchEvidenceAudit": research_audit,
        "contentPolicyAudit": content_policy_audit,
        "residualPolicyAudit": residual_policy_audit,
        "pageClosureAudit": {
            "pages": page_closure_audit,
            "policy": "每个修改页的全部模板对象必须归入允许保留、授权目标或未分类；未分类必须为零",
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

    if report["passed"]:
        metrics = report["metrics"]
        print(
            "白名单校验通过："
            f"{metrics['authorizedTargetCount']} 个对象获授权，"
            f"{metrics['defaultKeptObjectCount']} 个对象默认保持不变，"
            f"{metrics['entityBindingCount']} 个实体关系已核对"
        )
        for warning in report["warnings"]:
            print("警告：", warning)
        print(f"已写入 {output}")
        print(
            "审计报告："
            f"{slot_report}；{typography_report}；"
            f"{binding_report}；{protected_report}；{handoff_report}；"
            f"{research_report}；{page_closure_report}；"
            f"{residual_policy_report}"
        )
    else:
        print("白名单校验失败：")
        for error in report["errors"]:
            print("-", error)
        print(f"已写入 {output}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
