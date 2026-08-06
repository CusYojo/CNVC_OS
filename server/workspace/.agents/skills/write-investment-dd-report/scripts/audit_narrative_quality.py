#!/usr/bin/env python3
"""Audit reader-facing report prose for repetitive, process-heavy AI-style writing."""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter
from pathlib import Path


PROSE_TYPES = {"paragraph", "bullet", "numbered_item", "callout"}
APPENDIX_HEADINGS = ("尽调缺口", "资料请求", "来源", "附件", "证据索引")
META_PHRASES = (
    "公开信息",
    "公开资料",
    "无法确认",
    "无法判断",
    "未披露",
    "未核验",
    "尚未验证",
    "待核实",
    "需核验",
    "进一步核验",
    "正式尽调",
    "本轮未取得",
)
GENERIC_PHRASES = (
    "具备一定基础",
    "形成产品矩阵",
    "持续赋能",
    "进一步提升",
    "具有重要意义",
    "值得关注的是",
    "机遇与挑战并存",
    "广阔发展前景",
    "整体风险可控",
    "成长确定性较强",
)
FORBIDDEN_DECISION_PHRASES = (
    "尚未形成可审议方案",
    "尚未得到财务和客户台账支持",
    "尚不能证明平台化收入质量",
)
BANNED_READER_PHRASES = (
    "本报告基于公开资料编制",
    "本报告基于公开可得资料编制",
    "未获取",
    "未披露",
    "未公开",
    "待定",
    "产品—市场匹配尚未确立",
    "产品-市场匹配尚未确立",
    "产品–市场匹配尚未确立",
    "当前阶段不具备形成投资结论的条件",
    "不具备形成投资结论",
    "公开信息未显示",
    "后续尽调需厘清",
    "后续尽调需要厘清",
    "需厘清的事项",
    "建议补充核心财务与运营数据后再评估报价",
    "尚不足以直接推导",
    "目前无法判断",
    "进入第二阶段专项尽调",
    "条件满足前不锁定股权价格",
    "值得继续跟进",
    "建议的经营里程碑",
    "建议的估值处理",
    "经营质量评价框架",
)
BANNED_READER_PATTERNS = (
    re.compile(r"建议.{0,40}(?:获取|补充).{0,60}(?:后|之后).{0,20}(?:再评估|再判断|再报价)"),
    re.compile(r"(?:公开信息|公开资料).{0,20}(?:没有|未见|未能发现).{0,40}(?:关联|客户|合同|融资|知识产权|财务)"),
)
WORKPAPER_MAIN_BODY_PHRASES = (
    "核查框架",
    "验证框架",
    "核查重点",
    "核查材料",
    "应取得数据",
    "需要回答的事实",
    "必须完成的勾稽",
    "完成标准",
    "底稿要求",
    "优先资料清单",
    "尽调工作流",
)
META_OPENERS = (
    "本报告",
    "公开信息",
    "公开资料",
    "根据公开",
    "由于未",
    "本轮未",
)
ENUMERATION = re.compile(r"(?:一是|二是|三是|四是|首先|其次|再次|最后)[，、：:]?")
SENTENCE_SPLIT = re.compile(r"[。！？!?；;]")
CHINESE = re.compile(r"[\u4e00-\u9fff]")


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError("report must contain a JSON object")
    return value


def visible_text(block: dict) -> str:
    label = str(block.get("label", "")).strip()
    text = str(block.get("text", "")).strip()
    return f"{label}：{text}" if label and text else text or label


def all_block_text(block: dict) -> str:
    parts: list[str] = []
    for key in ("title", "label", "text"):
        value = block.get(key)
        if isinstance(value, str):
            parts.append(value)
    headers = block.get("headers")
    if isinstance(headers, list):
        parts.extend(str(value) for value in headers)
    rows = block.get("rows")
    if isinstance(rows, list):
        for row in rows:
            if isinstance(row, list):
                parts.extend(str(value) for value in row)
    return "\n".join(parts)


def chinese_len(text: str) -> int:
    return len(CHINESE.findall(text))


def audit(report: dict) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    meta = report.get("meta", {}) if isinstance(report.get("meta"), dict) else {}
    blocks = report.get("blocks", [])
    if not isinstance(blocks, list):
        return ["blocks must be an array"], warnings

    current_level_one = ""
    appendix_mode = False
    chapter_first_prose: dict[str, str] = {}
    prose: list[tuple[int, str, str]] = []
    main_body_visible: list[str] = []
    reader_visible: list[str] = []
    normalized_seen: Counter[str] = Counter()

    for index, block in enumerate(blocks, 1):
        if not isinstance(block, dict):
            continue
        reader_visible.append(all_block_text(block))
        if block.get("type") == "heading" and block.get("level") == 1:
            current_level_one = str(block.get("title", "")).strip()
            appendix_mode = any(token in current_level_one for token in APPENDIX_HEADINGS)
            if not appendix_mode:
                main_body_visible.append(current_level_one)
            continue
        if not appendix_mode:
            main_body_visible.append(all_block_text(block))
        if block.get("type") not in PROSE_TYPES or appendix_mode or block.get("nature") == "gap":
            continue
        text = visible_text(block)
        if not text:
            continue
        prose.append((index, current_level_one, text))
        if current_level_one and current_level_one not in chapter_first_prose:
            chapter_first_prose[current_level_one] = text
        normalized = re.sub(r"[\s，。；：、,.!?！？;:]", "", text)
        if len(normalized) >= 24:
            normalized_seen[normalized] += 1

    joined = "\n".join(text for _, _, text in prose)
    all_visible = "\n".join(main_body_visible)
    reader_text = "\n".join(reader_visible)
    for phrase in BANNED_READER_PHRASES:
        count = reader_text.count(phrase)
        if count:
            errors.append(f"banned reader-facing phrase '{phrase}' appears {count} time(s)")
    for pattern in BANNED_READER_PATTERNS:
        matches = pattern.findall(reader_text)
        if matches:
            errors.append(
                f"banned missing-data/search-status construction '{pattern.pattern}' appears {len(matches)} time(s)"
            )
    if re.search(r"(?:^|\n)\s*(?:合格|不合格)\s*(?:$|\n)", reader_text):
        errors.append("standalone reader-facing quality label '合格/不合格' is not allowed")
    for phrase in FORBIDDEN_DECISION_PHRASES:
        count = all_visible.count(phrase)
        if count:
            errors.append(f"forbidden workpaper phrase '{phrase}' appears {count} time(s)")
    for phrase in WORKPAPER_MAIN_BODY_PHRASES:
        count = all_visible.count(phrase)
        if count:
            errors.append(f"workpaper phrase '{phrase}' appears {count} time(s) in the reader-facing main body")
    chars = max(chinese_len(joined), 1)
    scale = chars / 10000

    meta_counts = {phrase: joined.count(phrase) for phrase in META_PHRASES}
    meta_total = sum(meta_counts.values())
    meta_rate = meta_total / scale
    if chars >= 600 and meta_rate > 22:
        errors.append(
            f"process/caveat language is too dense: {meta_total} occurrence(s), "
            f"{meta_rate:.1f} per 10k Chinese characters"
        )
    repeat_limit = max(3, math.ceil(scale * 4))
    for phrase, count in meta_counts.items():
        if count > repeat_limit:
            warnings.append(f"reader-facing phrase '{phrase}' repeats {count} times; consolidate it")

    generic_hits = sum(joined.count(phrase) for phrase in GENERIC_PHRASES)
    if generic_hits > max(2, math.ceil(scale * 3)):
        warnings.append(f"generic investment wording appears {generic_hits} times; replace it with company-specific judgment")

    enumeration_hits = len(ENUMERATION.findall(joined))
    if chars >= 600 and enumeration_hits / scale > 10:
        warnings.append(
            f"formulaic enumeration is too frequent: {enumeration_hits} occurrence(s), "
            f"{enumeration_hits / scale:.1f} per 10k Chinese characters"
        )

    for chapter, text in chapter_first_prose.items():
        if text.startswith(META_OPENERS):
            warnings.append(f"chapter '{chapter}' opens with process/source language instead of an investment conclusion")

    for index, chapter, text in prose:
        length = chinese_len(text)
        if block_like_paragraph(text) and length > 260:
            warnings.append(f"blocks[{index}] in '{chapter or 'front matter'}' is {length} Chinese characters; split the paragraph")
        for sentence in SENTENCE_SPLIT.split(text):
            sentence_length = chinese_len(sentence)
            if sentence_length > 115:
                warnings.append(f"blocks[{index}] contains a {sentence_length}-character sentence; shorten the causal chain")
                break

    duplicates = [text for text, count in normalized_seen.items() if count > 1]
    if duplicates:
        errors.append(f"reader-facing prose contains {len(duplicates)} duplicated substantive paragraph(s)")

    report_type = str(meta.get("report_type", ""))
    if report_type == "screening" and chars > 18000:
        warnings.append(f"screening report has {chars} Chinese prose characters; shorten it to avoid filler")

    return errors, warnings


def block_like_paragraph(text: str) -> bool:
    return "\n" not in text and not re.match(r"^\d+[.、]", text)


def self_test() -> int:
    good = {
        "meta": {"report_type": "screening"},
        "blocks": [
            {"type": "heading", "level": 1, "title": "投资判断"},
            {"type": "paragraph", "nature": "analysis", "text": "公司当前收入底盘来自工业软件维护，新产品的投资价值取决于能否提高续费和交付人效。"},
            {"type": "paragraph", "nature": "analysis", "text": "现有客户样本显示采购需求真实，但项目仍需要较多现场实施，因此不能按纯SaaS公司定价。"},
        ],
    }
    bad_blocks = [{"type": "heading", "level": 1, "title": "投资判断"}]
    bad_blocks.extend(
        {"type": "paragraph", "nature": "analysis", "text": "公开资料无法确认该事项，正式尽调需进一步核验。"}
        for _ in range(35)
    )
    bad = {"meta": {"report_type": "screening"}, "blocks": bad_blocks}
    workpaper_bad = {
        "meta": {"report_type": "screening"},
        "blocks": [
            {"type": "heading", "level": 1, "title": "业务情况"},
            {"type": "table", "title": "客户核查框架", "headers": ["核查重点"], "rows": [["取得合同"]]},
        ],
    }
    user_example_bad = {
        "meta": {"report_type": "screening"},
        "blocks": [
            {"type": "heading", "level": 1, "title": "投资概要"},
            {
                "type": "paragraph",
                "nature": "analysis",
                "text": "本报告基于公开可得资料编制，未获取公司财务数据。当前阶段不具备形成投资结论的条件。",
            },
            {
                "type": "paragraph",
                "nature": "analysis",
                "text": "产品—市场匹配尚未确立，建议补充核心财务与运营数据后再评估报价。",
            },
            {
                "type": "paragraph",
                "nature": "analysis",
                "text": "公开信息未显示关联交易，实验室与公司的知识产权关系是后续尽调需厘清的事项。",
            },
        ],
    }
    good_errors, good_warnings = audit(good)
    bad_errors, bad_warnings = audit(bad)
    workpaper_errors, _ = audit(workpaper_bad)
    user_example_errors, _ = audit(user_example_bad)
    if (
        good_errors
        or good_warnings
        or not bad_errors
        or not bad_warnings
        or not workpaper_errors
        or len(user_example_errors) < 6
    ):
        print("ERROR: narrative audit self-test failed")
        return 1
    print("Narrative audit self-test: passed")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", nargs="?")
    parser.add_argument("--strict", action="store_true", help="Treat warnings as delivery-blocking")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if not args.report:
        parser.error("report is required unless --self-test is used")
    try:
        errors, warnings = audit(read_json(Path(args.report).resolve()))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}")
        return 1
    for item in warnings:
        print(f"WARNING: {item}")
    for item in errors:
        print(f"ERROR: {item}")
    print(f"Narrative quality audit: {len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors or (args.strict and warnings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
