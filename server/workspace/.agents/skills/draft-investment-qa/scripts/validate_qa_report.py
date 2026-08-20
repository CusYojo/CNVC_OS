#!/usr/bin/env python3
"""校验项目 Q&A Markdown 报告的结构和禁止项。"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional


@dataclass
class Finding:
    level: str
    code: str
    message: str


Q_HEADING_RE = re.compile(r"^##\s+Q(\d+)[：:]\s*(.+?)\s*$", re.MULTILINE)
H2_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)
H3_RE = re.compile(r"^###\s+(.+?)\s*$", re.MULTILINE)
TITLE_RE = re.compile(r"^#\s+(.+?)Q&A\s*报告\s*$")
FORBIDDEN_TITLE_QUALIFIER_RE = re.compile(
    r"标准版|内部版|内部|仅供内部|保密|版本|第\s*\d+\s*版|V\d+(?:\.\d+)*",
    re.IGNORECASE,
)
LIST_ITEM_RE = re.compile(r"^\s*(\d+)[.、]\s*(.+?)\s*$")
PLACEHOLDER_RE = re.compile(r"【[^】]+】|\[(?:待补充|来源待核验|仅有公司单方口径|尚无可核验证据|公开信息未检索到|多来源口径冲突|数据时点较旧|公司预测|项目团队判断)\]")
URL_RE = re.compile(r"https?://[^\s)>]+")
MARKDOWN_LINK_RE = re.compile(r"\[[^\]]+\]\((?:https?://|www\.)[^)]+\)")
SOURCE_LINE_RE = re.compile(
    r"^\s*(?:来源|资料来源|数据来源|参考资料|参考来源|Source)\s*[：:].*$",
    re.MULTILINE | re.IGNORECASE,
)
CONCLUSION_LABEL_RE = re.compile(
    r"^\s*(?:\*\*)?结论(?:如下)?[：:](?:\*\*)?",
    re.MULTILINE,
)
EVIDENCE_ACQUISITION_NARRATION_RE = re.compile(
    r"公开(?:信息|材料|资料|披露|报道|记录|检索|来源|证据)|"
    r"公开[\u4e00-\u9fffA-Za-z0-9／/·-]{0,12}(?:显示|表明|记载|列示|介绍|披露)|"
    r"已公开(?:建成|上线|发布|投用|签约|披露|展示)|"
    r"(?:根据|基于|从|通过|结合|经由)(?:现有)?公开[\u4e00-\u9fff]{0,8}|"
    r"未(?:能)?(?:查到|检索到|找到)(?:相关)?公开[\u4e00-\u9fff]{0,8}"
)
PERSONA_SELF_REFERENCE_RE = re.compile(
    r"作为(?:一名)?(?:资深)?投资(?:经理|人)|"
    r"从(?:资深)?投资(?:经理|人)(?:的)?(?:角度|视角)(?:来看|出发)?|"
    r"站在(?:资深)?投资(?:经理|人)(?:的)?(?:角度|立场)"
)
INVESTMENT_PERSPECTIVE_RE = re.compile(
    r"投资主线|投资价值|资本效率|现金消耗|下行|估值|回报|"
    r"决策影响|推进条件|暂缓条件|否决条件|里程碑"
)
DECISION_CONDITION_RE = re.compile(
    r"推进|附条件|暂缓|否决|决策条件|核验条件|里程碑|判断(?:升级|降级|反转)"
)
UNFINISHED_INVESTOR_LANGUAGE_RE = re.compile(
    r"建议|待(?:验证|核验|补充)|进一步(?:核验|验证)|后续需要|"
    r"下一步(?:需要|应)|仍需(?:核验|验证|补充|确认|取得|提供|检查|访谈|审查)|"
    r"需要(?:确认|核对|补充|提供|取得|验证|核验)|"
    r"应(?:取得|核查|验证|补充)|需(?:确认|核对|取得|验证|核验|检查)"
)
AUDIT_SELF_REFERENCE_RE = re.compile(
    r"本报告|由于(?:未披露|资料有限|信息有限)|公开证据|证据边界|"
    r"无法判断|无法获取|不作定量结论|不形成判断"
)
ECONOMIC_VARIABLE_RE = re.compile(
    r"获客|客单价|销售周期|转化率|续费|复购|收入|毛利|利润|现金|回款|"
    r"应收|营运资金|交付人天|实施人天|定制比例|经营杠杆|资本强度|"
    r"资本开支|融资依赖|稀释|定价权|切换成本|集中度|估值|期权价值|下行"
)
QUESTION_TENSION_RE = re.compile(
    r"能否|是否|为何|为什么|如何|还是|取决于|支撑|转化|意味着|约束|"
    r"影响|匹配|兑现|证明|高估|低估|形成|改变"
)
ANSWER_DEPTH_PATTERNS = (
    re.compile(r"客户|采购|付费|销售周期|转化|续费|复购|客单价|合同"),
    re.compile(r"交付|实施|人天|复用|产能|利用率|供应链|标准化|定制|规模"),
    re.compile(r"收入|毛利|利润|现金|回款|应收|营运资金|成本|资本开支|融资"),
    re.compile(r"投资主线|估值|折价|溢价|期权价值|推进|暂缓|否决|回报|稀释"),
    re.compile(r"证据|验收|测试|风险|边界|失效|反方|依赖|集中度|替代"),
)
PROFILE_QUESTION_RANGES = {
    "concise": (5, 7),
    "standard": (8, 12),
    "deep": (12, 20),
    "adversarial": (6, 12),
}
PROFILE_MIN_ANSWER_CHARS = {
    "concise": 160,
    "standard": 220,
    "deep": 260,
    "adversarial": 200,
}


def normalize_title(value: str) -> str:
    value = re.sub(r"[【】\[\]\s]", "", value)
    value = re.sub(r"[？?。；;：:]$", "", value)
    return value


def section_text(text: str, heading_pattern: str) -> str:
    match = re.search(heading_pattern, text, re.MULTILINE)
    if not match:
        return ""
    start = match.end()
    next_h2 = re.search(r"^##\s+", text[start:], re.MULTILINE)
    end = start + next_h2.start() if next_h2 else len(text)
    return text[start:end]


def q_sections(text: str) -> list[tuple[int, str, str]]:
    matches = list(Q_HEADING_RE.finditer(text))
    sections: list[tuple[int, str, str]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections.append((int(match.group(1)), match.group(2).strip(), text[match.end():end]))
    return sections


def validate(
    path: Path,
    extended_sections: bool = False,
    profile: str = "standard",
    native_terms: Optional[list[str]] = None,
    strict_investment: bool = False,
) -> list[Finding]:
    findings: list[Finding] = []
    native_terms = [term.strip() for term in (native_terms or []) if term.strip()]
    depth_level = "error" if strict_investment else "warning"
    if not path.exists():
        return [Finding("error", "file_missing", f"文件不存在：{path}")]
    if not path.is_file():
        return [Finding("error", "not_file", f"目标不是文件：{path}")]

    text = path.read_text(encoding="utf-8")

    h1_match = re.search(r"^#\s+.+$", text, re.MULTILINE)
    if not h1_match:
        findings.append(Finding("error", "missing_h1", "缺少报告一级标题。"))
    else:
        h1_text = h1_match.group(0).strip()
        if not extended_sections and not TITLE_RE.fullmatch(h1_text):
            findings.append(
                Finding(
                    "error",
                    "invalid_title_pattern",
                    "默认报告标题必须严格采用“项目名称Q&A 报告”格式。",
                )
            )
        if not extended_sections and FORBIDDEN_TITLE_QUALIFIER_RE.search(h1_text):
            findings.append(
                Finding(
                    "error",
                    "forbidden_title_qualifier",
                    "默认标题不得包含版本、内部使用、受众或保密限定词。",
                )
            )
        if not extended_sections:
            remainder = text[h1_match.end():]
            first_content = re.search(r"^\s*(\S.*)$", remainder, re.MULTILINE)
            first_line = first_content.group(1).strip() if first_content else ""
            if not re.match(r"^##\s+Q1[：:]", first_line):
                findings.append(
                    Finding(
                        "error",
                        "not_direct_qa",
                        "默认报告必须在一级标题后立即开始 Q1。",
                    )
                )

    if not extended_sections:
        forbidden_sections = [
            ("metadata", r"^>\s*(?:版本|日期|报告用途|保密级别|信息边界)[：:]"),
            ("execution_summary", r"^##\s+执行摘要\s*$"),
            ("question_list", r"^##\s+问题清单\s*$"),
            ("information_gaps", r"^##\s+信息缺口(?:与核验计划)?\s*$"),
            ("sources", r"^##\s+(?:数据来源|来源|数据来源与说明)\s*$"),
            ("standalone_conclusion", r"^##\s+结论与下一步\s*$"),
        ]
        for code, pattern in forbidden_sections:
            if re.search(pattern, text, re.MULTILINE):
                findings.append(
                    Finding(
                        "error",
                        f"unexpected_{code}",
                        f"直接问答模式不允许独立的 {code.replace('_', ' ')} 内容。",
                    )
                )

        markdown_links = MARKDOWN_LINK_RE.findall(text)
        raw_urls = URL_RE.findall(text)
        source_lines = SOURCE_LINE_RE.findall(text)
        if markdown_links:
            findings.append(
                Finding(
                    "error",
                    "unexpected_markdown_links",
                    f"默认报告不得包含读者可见的 Markdown 链接；发现 {len(markdown_links)} 处。",
                )
            )
        if raw_urls:
            findings.append(
                Finding(
                    "error",
                    "unexpected_urls",
                    f"默认报告不得包含原始或嵌入式 URL；发现 {len(raw_urls)} 处。",
                )
            )
        if source_lines:
            findings.append(
                Finding(
                    "error",
                    "unexpected_source_lines",
                    f"默认报告不得包含来源行；发现 {len(source_lines)} 处。",
                )
            )
        evidence_narration = EVIDENCE_ACQUISITION_NARRATION_RE.findall(text)
        if evidence_narration:
            unique = sorted(set(evidence_narration))
            findings.append(
                Finding(
                    "error",
                    "evidence_acquisition_narration",
                    "默认报告应直接陈述主张和证据边界，不得向读者描述取证或检索过程；"
                    f"发现：{', '.join(unique[:8])}。",
                )
            )

    if not re.search(r"风险|反方|边界", text):
        findings.append(Finding("error", "missing_risk", "未发现风险、反方观点或边界内容。"))

    persona_narration = PERSONA_SELF_REFERENCE_RE.findall(text)
    if persona_narration:
        findings.append(
            Finding(
                "error",
                "persona_self_reference",
                "报告应通过判断质量体现资深投资经理视角，不得在正文中自述角色身份。",
            )
        )

    if not INVESTMENT_PERSPECTIVE_RE.search(text):
        findings.append(
            Finding(
                depth_level,
                "missing_investment_perspective",
                "报告可能缺少明确的资本配置、下行风险或投资决策视角。",
            )
        )

    unfinished_language = UNFINISHED_INVESTOR_LANGUAGE_RE.findall(text)
    if unfinished_language:
        unique = sorted(set(unfinished_language))
        findings.append(
            Finding(
                depth_level,
                "unfinished_investor_language",
                "读者版应使用完成态投资语言，不得用材料索取或后续工作指令代替分析；"
                f"发现 {len(unfinished_language)} 处：{', '.join(unique[:8])}。",
            )
        )

    audit_self_reference = AUDIT_SELF_REFERENCE_RE.findall(text)
    if audit_self_reference:
        unique = sorted(set(audit_self_reference))
        findings.append(
            Finding(
                depth_level,
                "audit_self_reference",
                "读者版不得描述报告审计过程或用缺数免责声明代替经营判断；"
                f"发现：{', '.join(unique[:8])}。",
            )
        )

    sections = q_sections(text)
    if not sections:
        findings.append(Finding("error", "missing_questions", "未发现“## Qn：……”格式的问题标题。"))
    else:
        numbers = [number for number, _, _ in sections]
        expected = list(range(1, len(numbers) + 1))
        if numbers != expected:
            findings.append(
                Finding(
                    "error",
                    "question_numbering",
                    f"问题编号必须从 1 开始连续排列；当前为 {numbers}。",
                )
            )

        min_questions, max_questions = PROFILE_QUESTION_RANGES[profile]
        if not min_questions <= len(sections) <= max_questions:
            findings.append(
                Finding(
                    depth_level,
                    "question_count_profile",
                    f"{profile} 模式应包含 {min_questions}—{max_questions} 个问题；当前为 {len(sections)} 个。",
                )
            )

        thin_answers: list[str] = []
        depth_pass_count = 0
        for number, title, body in sections:
            if CONCLUSION_LABEL_RE.search(body):
                findings.append(
                    Finding(
                        "error",
                        "unexpected_conclusion_label",
                        f"Q{number}“{title}”包含独立结论标签；应直接开始分析。",
                    )
                )
            body_chars = len(re.sub(r"\s+", "", body))
            if body_chars < PROFILE_MIN_ANSWER_CHARS[profile]:
                thin_answers.append(f"Q{number}")
            category_count = sum(bool(pattern.search(body)) for pattern in ANSWER_DEPTH_PATTERNS)
            if category_count >= 3:
                depth_pass_count += 1

        if thin_answers:
            findings.append(
                Finding(
                    depth_level,
                    "thin_answer",
                    f"以下答案可能不足以完成投资因果推演：{', '.join(thin_answers)}。",
                )
            )

        depth_ratio = depth_pass_count / len(sections)
        if depth_ratio < 0.70:
            findings.append(
                Finding(
                    depth_level,
                    "shallow_answer_chain",
                    "完成至少三个分析层级的答案比例不足 70%；"
                    f"当前为 {depth_pass_count}/{len(sections)}。",
                )
            )

        if strict_investment and len(native_terms) < 3:
            findings.append(
                Finding(
                    "error",
                    "native_terms_required",
                    "严格投资门禁要求通过 --native-term 提供 3—7 个公司专属名词，且不能只提供公司名称。",
                )
            )
        elif native_terms:
            native_question_count = sum(
                any(term.casefold() in title.casefold() for term in native_terms)
                for _, title, _ in sections
            )
            native_ratio = native_question_count / len(sections)
            if native_ratio < 0.60:
                findings.append(
                    Finding(
                        depth_level,
                        "low_company_specificity",
                        "包含公司专属名词的问题比例不足 60%；"
                        f"当前为 {native_question_count}/{len(sections)}。",
                    )
                )

            controversy_count = sum(
                any(term.casefold() in title.casefold() for term in native_terms)
                and bool(ECONOMIC_VARIABLE_RE.search(title))
                and bool(QUESTION_TENSION_RE.search(title))
                for _, title, _ in sections
            )
            controversy_ratio = controversy_count / len(sections)
            if controversy_ratio < 0.50:
                findings.append(
                    Finding(
                        depth_level,
                        "low_investment_controversy",
                        "同时包含公司锚点、经济变量和决策张力的问题比例不足 50%；"
                        f"当前为 {controversy_count}/{len(sections)}。",
                    )
                )

        last_number, last_title, last_body = sections[-1]
        if not DECISION_CONDITION_RE.search(last_title + last_body):
            findings.append(
                Finding(
                    depth_level,
                    "missing_decision_conditions",
                    f"最后一问 Q{last_number}“{last_title}”可能缺少推进、暂缓、否决或判断反转条件。",
                )
            )

    repeated_h3 = [title for title, count in Counter(H3_RE.findall(text)).items() if count > 2]
    if repeated_h3:
        findings.append(
            Finding(
                depth_level,
                "repetitive_answer_template",
                "同一答案小标题重复超过两次，全文可能机械套用同一结构："
                f"{', '.join(repeated_h3[:6])}。",
            )
        )

    placeholders = PLACEHOLDER_RE.findall(text)
    if placeholders:
        unique = sorted(set(placeholders))
        findings.append(
            Finding(
                "warning",
                "unresolved_markers",
                f"发现 {len(placeholders)} 个未解决占位符或标记：{', '.join(unique[:8])}。",
            )
        )

    if re.search(r"订单.*收入.*回款|收入.*订单.*回款", text) and not re.search(
        r"订单.{0,80}(?:不等于|区别|区分).{0,80}(?:收入|回款)|"
        r"(?:订单|交付|验收|收入|回款).{0,30}(?:阶段|区分)",
        text,
        re.DOTALL,
    ):
        findings.append(
            Finding(
                "warning",
                "status_distinction",
                "报告提到订单、收入和回款，但可能没有明确区分各自状态。",
            )
        )

    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path, help="Markdown Q&A 报告路径")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出检查结果")
    parser.add_argument(
        "--profile",
        choices=sorted(PROFILE_QUESTION_RANGES),
        default="standard",
        help="报告模式，用于问题数量和答案密度门禁。",
    )
    parser.add_argument(
        "--native-term",
        action="append",
        default=[],
        help="公司专属产品、技术、案例、客户类型或战略矛盾；可重复传入 3—7 次。",
    )
    parser.add_argument(
        "--strict-investment",
        action="store_true",
        help="把投资深度警告升级为错误；最终交付前应启用。",
    )
    parser.add_argument(
        "--extended-sections",
        action="store_true",
        help="允许用户明确要求的元数据、摘要、清单、缺口、来源或结论章节。",
    )
    args = parser.parse_args()

    findings = validate(
        args.report,
        extended_sections=args.extended_sections,
        profile=args.profile,
        native_terms=args.native_term,
        strict_investment=args.strict_investment,
    )
    errors = sum(item.level == "error" for item in findings)
    warnings = sum(item.level == "warning" for item in findings)

    if args.json:
        print(
            json.dumps(
                {
                    "report": str(args.report),
                    "profile": args.profile,
                    "strict_investment": args.strict_investment,
                    "native_terms": args.native_term,
                    "errors": errors,
                    "warnings": warnings,
                    "findings": [asdict(item) for item in findings],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        for item in findings:
            print(f"[{item.level.upper()}] {item.code}: {item.message}")
        print(f"校验完成：{errors} 个错误，{warnings} 个警告。")

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
