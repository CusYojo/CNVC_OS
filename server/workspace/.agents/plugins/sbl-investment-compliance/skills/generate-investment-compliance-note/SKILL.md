---
name: generate-investment-compliance-note
description: Generate, audit, revise, and visually verify Chinese equity-investment compliance notes from project ZIP archives or due-diligence directories. Use when a user asks to create a 项目投资合规性说明、基金投资合规审查说明、返投/关联交易/投资限制/集中度分析, especially when the output must follow the retained 标准项目投资合规性说明 Deta 3 DOCX template with identical page setup, fonts, sizes, numbering, and formal tone.
---

# Generate Investment Compliance Note

Produce a source-backed compliance note through a controlled evidence, drafting, correction, and render workflow. Use the sibling `/sbl-investment-compliance:artifact-template-deta-3` skill as the visual authority and keep its retained reference unchanged.

## Required inputs

- Accept one project ZIP archive or one extracted due-diligence directory.
- Resolve the bundled template relative to this skill at `../artifact-template-deta-3/assets/reference.docx`, unless the user explicitly supplies another standard.
- Obtain fund-specific parameters from the user's materials or the retained standard. Mark stale or absent values as refresh-required; never silently invent them.

## Workflow

1. Read [workflow.md](references/workflow.md) and [template-contract.md](references/template-contract.md).
2. Run `${CLAUDE_SKILL_DIR}/scripts/compliance_processor.py prepare INPUT --workdir RUN_DIR` with `python3`. Inspect `source_manifest.json`, `evidence_pack.md`, and extraction warnings.
3. Build a fact ledger before prose. Give signed transaction documents, official registrations, audited/special-audit reports, and fund agreements priority over management statements, business plans, and forecasts.
4. Resolve conflicts explicitly. Preserve the competing values, choose a governing value and basis, and move unresolved conflicts into `open_issues`.
5. Author `content.json` against [content-schema.json](references/content-schema.json). Keep the standard four-section sequence:
   - 公司情况介绍：公司简介、核心团队、产品及技术；
   - 投资理由：normally five concise, evidence-backed reasons;
   - 投资计划：valuation, amount, new/old shares, ownership, vehicle, payment, governance, and final-document caveats;
   - 投资情形分析：investment restrictions, return-investment obligation, related parties, investment direction, configuration, concentration, other law/regulation issues, and conclusion.
   Treat the visible DOCX as the decision layer and `open_issues` as the audit layer. The visible report must be Deta-style concise: conclusions first, positive reasons without defensive tails, and material conditions stated once in the most relevant compliance item or the final conclusion.
6. Attach `source_ids` to every factual block. Use `status: verified`, `management_stated`, `calculated`, or `pending`. Do not place source IDs in the visible report.
7. Run `python3 "${CLAUDE_SKILL_DIR}/scripts/compliance_processor.py" build --content content.json --output FINAL.docx --template TEMPLATE.docx`.
8. Run `python3 "${CLAUDE_SKILL_DIR}/scripts/compliance_processor.py" verify --content content.json --docx FINAL.docx --out qa.json`. Fix every error; assess warnings using [evaluation-checklist.md](references/evaluation-checklist.md).
9. Render the final DOCX to PDF with Microsoft Word or headless LibreOffice. When LibreOffice cannot resolve `宋体` or `黑体`, set `FONTCONFIG_FILE="${CLAUDE_SKILL_DIR}/assets/fonts.conf"` for the render command so the QA environment maps them to available CJK fonts; do not rename fonts in the DOCX. Convert the PDF pages to PNG with `pdftoppm`, inspect every page at 100%, and iterate.
10. Deliver the final DOCX together with `source_manifest.json`, `content.json`, and `qa.json` only when the user asks for audit sidecars. Otherwise deliver the DOCX and summarize material pending items.

## Factual guardrails

- Separate company facts from fund facts and transaction facts.
- State dates, units, currencies, pre/post-money bases, and fully diluted bases.
- Treat business plans, customer demand indications, forecasts, and management interviews as claims, not completed orders or audited results.
- Treat a related-party conclusion as conditional until the relationship checklist and final cap table are complete.
- Recalculate concentration and return-investment headroom after the proposed investment; show the formula in `content.json` notes.
- For an old-share purchase, confirm the fund agreement permits secondary acquisition and record the purchase price, seller, tax, and title-transfer conditions.
- Preserve uncertainty in the conclusion: use “原则上符合” only with stated completion conditions; never convert “未发现” into an absolute legal assurance.

## Deta concise-writing contract

- 公司情况介绍只陈述可支持的公司、团队、产品与技术事实。公司简介仅保留成立时间、注册地、法定代表人、主营业务及定位等决策相关信息；正式可见报告不得出现统一社会信用代码或 18 位信用代码，公司简介不得出现注册资本、认缴资本、实缴资本、实收资本或“实缴 + 金额”等工商登记字段。相关信息留在事实底稿或 `open_issues`，不得写入公司简介。不得在每段末尾附加“仍需核验”“以交割前为准”等尽调提醒。
- 投资理由原则上保持五点，每点只写一条正向匹配逻辑及必要证据。禁止使用“但”“仍需”“取决于”“适宜设置为”“交割前应”等转折或条件尾句。
- 投资计划集中写明金额、估值、增资与老股结构、分期原则和治理安排；末段保留语只出现一次，并压缩为“最终投资主体、交易结构、持股比例及投资人权利，以基金合伙协议、投委会决议和正式交易文件为准”一类短句。
- 七项投资情形分析均以“符合／不涉及／不会导致／未发现”类明确判断起句，再用一至两句给出依据。第一项涉及老股时，仅保留“老股受让部分以基金合伙协议允许为前提”这一必要条件；同一条件不得在正文重复出现。
- 第七项只判断是否存在其他明显违法违规情形，不在该项枚举外籍股东登记、持股平台出资、知识产权、数据、财务、政策返还或审批等交割核查清单。将明细移入 `open_issues`，由结尾“必要尽调核验”统一承接。
- 结尾只保留一个句号收束的条件性结论，宜控制在 120 个汉字以内，不再附加“不构成无条件放行”“不保证收益”等泛化免责句。
- 绝不为了简洁删除可能反转结论的硬条件。若条件较多，在正文仅作集中概括，并在 `open_issues` 保留逐项任务、证据缺口和责任归属。

## Layout contract

- Enforce A4 portrait with 2.5 cm top/bottom and 2.8 cm left/right margins, no header/footer content, and no blank spacer paragraphs.
- Use 黑体 14 pt, non-bold, centered for the document title; use 宋体 12 pt elsewhere and Times New Roman for western text and digits.
- Use bold left-aligned level-1 headings with 12 pt before; use non-bold left-aligned level-2 headings; keep both at 1.5 line spacing.
- Justify body text, use an approximately two-character first-line indent, 0 pt before/after, and 1.5 line spacing.
- Use 6 pt before numbered investment-reason and compliance items; bold only the number or conclusion lead, not the reasoning body.
- Right-align the company and Chinese date on separate lines; use 30 pt before the company and 0 pt before the date.
- Reject underlining, italics, incorrect alignment, incorrect bold roles, margin drift, blank spacer paragraphs, or line spacing other than `360/auto`.

## Revision gates

- Gate 1 — evidence: no decisive claim lacks a source or calculation trail.
- Gate 2 — compliance: all seven standard compliance checks have an explicit result and condition.
- Gate 3 — template fidelity: A4; 2.5/2.8 cm margins; font names and sizes; bold roles; alignment; 1.5 line spacing; paragraph spacing; numbering; and closing signature match the executable layout contract.
- Gate 4 — contamination: no template project name, amount, date, SPV, investor, or conclusion survives unintentionally.
- Gate 5 — visual QA: no clipping, overlap, broken pagination, missing glyphs, or isolated heading.
- Gate 6 — decision-layer concision: no credit code in the visible report; no registered/subscribed/paid-in capital field in 公司简介; no defensive tail in investment reasons; no repeated caveat; item 7 contains no closing checklist; the plan reservation and conclusion are each one concise sentence.

## Program interface

```bash
PYTHON_BIN=python3
SKILL_DIR="${CLAUDE_SKILL_DIR}"
PROCESSOR="$SKILL_DIR/scripts/compliance_processor.py"
FONTCONFIG_FILE="$SKILL_DIR/assets/fonts.conf"

"$PYTHON_BIN" "$PROCESSOR" prepare project.zip --workdir run
"$PYTHON_BIN" "$PROCESSOR" build --content run/content.json --output report.docx
"$PYTHON_BIN" "$PROCESSOR" verify --content run/content.json --docx report.docx --out run/qa.json
```

Use absolute paths for inputs, outputs, and run directories. Pass `FONTCONFIG_FILE="$FONTCONFIG_FILE"` to the LibreOffice render command when font aliases are required. Keep the original archive and retained template unchanged.
