#!/usr/bin/env python3
"""Validate the structure of a generated project Q&A Markdown report."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path


@dataclass
class Finding:
    level: str
    code: str
    message: str


Q_HEADING_RE = re.compile(r"^##\s+Q(\d+)[：:]\s*(.+?)\s*$", re.MULTILINE)
H2_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)
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


def validate(path: Path, extended_sections: bool = False) -> list[Finding]:
    findings: list[Finding] = []
    if not path.exists():
        return [Finding("error", "file_missing", f"File not found: {path}")]
    if not path.is_file():
        return [Finding("error", "not_file", f"Not a file: {path}")]

    text = path.read_text(encoding="utf-8")

    h1_match = re.search(r"^#\s+.+$", text, re.MULTILINE)
    if not h1_match:
        findings.append(Finding("error", "missing_h1", "Missing report H1 title."))
    else:
        h1_text = h1_match.group(0).strip()
        if not extended_sections and not TITLE_RE.fullmatch(h1_text):
            findings.append(
                Finding(
                    "error",
                    "invalid_title_pattern",
                    "Default report title must use the exact pattern '项目名称Q&A 报告'.",
                )
            )
        if not extended_sections and FORBIDDEN_TITLE_QUALIFIER_RE.search(h1_text):
            findings.append(
                Finding(
                    "error",
                    "forbidden_title_qualifier",
                    "Default title must not contain version, internal-use, audience, or confidentiality qualifiers.",
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
                        "Default report must start Q1 immediately after the H1 title.",
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
                        f"Direct-Q&A mode does not allow standalone {code.replace('_', ' ')} content.",
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
                    f"Default report must not contain reader-facing Markdown links; found {len(markdown_links)}.",
                )
            )
        if raw_urls:
            findings.append(
                Finding(
                    "error",
                    "unexpected_urls",
                    f"Default report must not contain raw or embedded URLs; found {len(raw_urls)}.",
                )
            )
        if source_lines:
            findings.append(
                Finding(
                    "error",
                    "unexpected_source_lines",
                    f"Default report must not contain source lines; found {len(source_lines)}.",
                )
            )
        evidence_narration = EVIDENCE_ACQUISITION_NARRATION_RE.findall(text)
        if evidence_narration:
            unique = sorted(set(evidence_narration))
            findings.append(
                Finding(
                    "error",
                    "evidence_acquisition_narration",
                    "Default report must state claims and evidence boundaries directly, without "
                    f"reader-facing research-process wording; found: {', '.join(unique[:8])}.",
                )
            )

    if not re.search(r"风险|反方|边界", text):
        findings.append(Finding("error", "missing_risk", "No risk, counterargument, or boundary content found."))

    sections = q_sections(text)
    if not sections:
        findings.append(Finding("error", "missing_questions", "No '## Qn：...' question headings found."))
    else:
        numbers = [number for number, _, _ in sections]
        expected = list(range(1, len(numbers) + 1))
        if numbers != expected:
            findings.append(
                Finding(
                    "error",
                    "question_numbering",
                    f"Question numbers must be continuous from 1; found {numbers}.",
                )
            )

        for number, title, body in sections:
            if CONCLUSION_LABEL_RE.search(body):
                findings.append(
                    Finding(
                        "error",
                        "unexpected_conclusion_label",
                        f"Q{number} '{title}' contains a standalone conclusion label; begin the analysis directly.",
                    )
                )
            if len(re.sub(r"\s+", "", body)) < 80:
                findings.append(
                    Finding("warning", "thin_answer", f"Q{number} '{title}' appears unusually short.")
                )

    placeholders = PLACEHOLDER_RE.findall(text)
    if placeholders:
        unique = sorted(set(placeholders))
        findings.append(
            Finding(
                "warning",
                "unresolved_markers",
                f"Found {len(placeholders)} unresolved placeholders/markers: {', '.join(unique[:8])}.",
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
                "Report mentions orders, revenue, and cash but may not explicitly distinguish their statuses.",
            )
        )

    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path, help="Path to the Markdown Q&A report")
    parser.add_argument("--json", action="store_true", help="Emit JSON findings")
    parser.add_argument(
        "--extended-sections",
        action="store_true",
        help="Allow explicitly requested metadata, summary, list, gap, source, or conclusion sections.",
    )
    args = parser.parse_args()

    findings = validate(args.report, extended_sections=args.extended_sections)
    errors = sum(item.level == "error" for item in findings)
    warnings = sum(item.level == "warning" for item in findings)

    if args.json:
        print(
            json.dumps(
                {
                    "report": str(args.report),
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
        print(f"Validation complete: {errors} error(s), {warnings} warning(s).")

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
