---
name: generate-project-qa-report
description: Generate, revise, or stress-test professional project Q&A reports as polished Word documents (DOCX) with a Markdown companion, using sparse or extensive information supplied in the conversation, attachments, authorized databases/connectors, workspace files, or lawful public web sources, with internal evidence tracking, source-free reader-facing output by default, risk analysis, visual Word-page verification, and strict anti-fabrication controls. Use for investment, financing, due-diligence, internal screening, project review, partnership assessment, investor Q&A, or management-response materials.
---

# Generate Project Q&A Report

## Objective

Create a decision-useful project Q&A report rather than a generic FAQ. Convert fragmented materials into a traceable fact base, select the questions that can change a decision, answer them with evidence and boundaries, and surface unresolved gaps.

Default to a polished Chinese Word document with a Markdown companion. Stabilize and validate the Markdown first, then generate, render, and visually verify the DOCX before delivery.

## Host compatibility

Keep this Skill compatible with both Codex and Claude Code. Use only the portable Agent Skills frontmatter fields `name` and `description`; keep host-specific metadata in separate files such as `agents/openai.yaml`.

Resolve the directory containing this `SKILL.md` before running bundled scripts. In Claude Code, use `${CLAUDE_SKILL_DIR}`. In Codex, use the absolute Skill directory supplied by the host. Assign the resolved path to `QA_SKILL_DIR` and never assume that the current working directory is the Skill directory.

Read [references/runtime-compatibility.md](references/runtime-compatibility.md) when running under Claude Code, when the host has no document Skill, or when Python, Word, LibreOffice, fonts, or render tools are unavailable. Run `scripts/check_runtime.py` before first use in a new host environment.

## Required resources

Read resources progressively:

- Read [references/source-acquisition-rules.md](references/source-acquisition-rules.md) whenever inputs arrive through the conversation, attachments, databases, connectors, remote resources, or mixed channels.
- Read [references/structure-blueprint.md](references/structure-blueprint.md) to choose report length, modules, and question order.
- Read [references/section-writing-guide.md](references/section-writing-guide.md) when generating questions or drafting a report section.
- Read [references/research-and-compliance-rules.md](references/research-and-compliance-rules.md) whenever user information is incomplete, web research is used, or current market/company/legal facts matter.
- Read [references/evidence-and-quality-rules.md](references/evidence-and-quality-rules.md) before drafting and again during final QA.
- Read [references/format-guidelines.md](references/format-guidelines.md) when creating the final Markdown or converting it to a formatted document.
- If the host exposes a `documents` or equivalent DOCX Skill, read it completely before generating or validating the final DOCX. Otherwise follow [references/runtime-compatibility.md](references/runtime-compatibility.md) and use the bundled scripts plus an available native Word or LibreOffice rendering path.

Use templates in `assets/` as output skeletons. Do not treat placeholder content as evidence.
Use [scripts/render_qa_docx.py](scripts/render_qa_docx.py) for the standard Word layout unless the user supplies a different template or requests a materially different design. Generate a PDF only when the user explicitly requests one.

## Defaults

When the user does not specify:

- Use standard mode with 8-12 questions.
- Treat the audience as an internal investment or project-review team.
- Use adaptive research: start from user materials and research legal public sources when material gaps block important questions.
- Use customer and sensitive counterparty aliases.
- Produce a final DOCX under `output/docx/` in the current workspace and keep the validated Markdown companion in the current workspace.
- Use the `qa_cn_formal_a4` Word profile from [references/format-guidelines.md](references/format-guidelines.md): A4 portrait, exact formal margins, 20 pt body leading, 10.5 pt body text, 9 pt table text, justified paragraphs, and 9 pt headers/footers. Do not silently substitute Word defaults or a high-density memo profile.
- Use the exact H1 pattern `项目名称Q&A 报告`. Do not insert `标准版`, `内部`, `内部版`, a version number, a date, an audience label, or a confidentiality qualifier into the title unless the user explicitly requests that wording.
- Keep page furniture neutral: use `项目名称｜Q&A` in the running header and page numbering only in the footer. Never place `内部`, `内部资料`, `仅供内部使用`, or equivalent confidentiality labels in headers or footers unless the user explicitly requests them.
- Use a direct-Q&A layout: one report title followed immediately by continuously numbered Q&A sections.
- Do not add version/date metadata, an execution summary, a question list, a standalone information-gap section, a source appendix, or other front/back matter unless the user explicitly requests it.
- Do not add a standalone `结论：` paragraph, bold conclusion label, conclusion callout, or conclusion box under any question. Begin each answer directly with analysis, evidence, and boundaries.
- Keep the standard reader-facing report source-free: do not show source lists, source notes, citation labels, footnotes/endnotes, Markdown links, raw URLs, or clickable external hyperlinks. Preserve all provenance in the internal evidence ledger. Generate a cited edition or separate source register only when the user explicitly requests it.
- Keep evidence-acquisition language out of the reader-facing report. Do not write `公开信息`, `公开材料`, `公开资料`, `公开披露`, `公开报道`, `公开记录`, `公开检索`, `公开来源`, `根据公开…`, `从公开…`, or equivalent research-process narration. Write the claim or boundary directly, such as `公司已上线…`, `监管记录显示…`, `现有证据不能确认…`, or `尚无可核验材料证明…`. Preserve acquisition channel and provenance only in the internal evidence ledger.
- Use neutral attribution only when it is necessary to preserve claim status, such as `公司公告称`, `监管记录显示`, or `第三方研究认为`; do not append a publication title or URL.
- Integrate information gaps, evidence requests, and next actions into the relevant answer or the final decision question.
- Treat the project directory as an output location or optional source, not as the presumed material location.

Respect an explicit request to use only supplied materials or not browse.

## Workflow

### 1. Establish the assignment

Identify:

- project name and type;
- report purpose and target reader;
- concise, standard, deep-diligence, adversarial, or revision mode;
- source boundary;
- confidentiality and anonymization needs;
- requested output format and location.

Infer non-critical choices. Ask only when a missing choice would materially change the report.

### 2. Discover, inventory, and extract source materials

Follow [references/source-acquisition-rules.md](references/source-acquisition-rules.md). Discover sources in this order:

1. information typed or pasted in the current conversation;
2. files and links attached or explicitly referenced by the user;
3. authorized connected apps, databases, warehouses, APIs, or remote resources;
4. workspace/project-directory files only when the user identifies them or they are clearly in scope;
5. lawful public-web research for remaining researchable gaps.

Do not scan the current directory and assume every file belongs to the project.

Use the appropriate document, PDF, presentation, spreadsheet, database, or connector workflow when available. Preserve:

- source type and source system;
- source filename;
- page, slide, sheet, cell range, section, or URL;
- database/catalog/schema/table/view and query/filter description when applicable;
- query or retrieval time, row grain, date coverage, and truncation/completeness status;
- publication or document date;
- data period;
- original unit and currency.

For direct conversation input, record the source as `用户在当前对话中提供` and the conversation date.

Use read-only, bounded database queries. Inspect schemas before querying, select only required fields and periods, and do not retrieve credentials or unnecessary personal data.

Classify extracted information under company/team, industry/market, product/technology, customers/orders, financials/cash, governance/IP, and risks.

Do not silently reconcile conflicting sources. Record the conflict.

### 3. Assess information sufficiency

Classify the input:

- **Sufficient:** core questions have usable facts and evidence; perform only targeted verification.
- **Partially sufficient:** project logic is clear but market, competitor, company, or risk evidence is missing; perform adaptive public research.
- **Severely insufficient:** project identity, product, or requested decision cannot be determined; ask for the minimum blocking facts.

Create four internal lists: known, unknown, publicly researchable, and user-only. Research only the publicly researchable items.

### 4. Build a fact and evidence ledger

For each material claim record:

- topic and claim;
- fact, judgment, forecast, or calculation;
- source type and source system;
- source and locator;
- publisher and link for web sources;
- database object, query description, filters, row grain, and retrieval time for database sources;
- publication date, data period, and access date;
- original unit/currency;
- evidence grade A-D;
- verified, conflicting, stale, or unresolved status.

Use [assets/evidence-ledger-template.md](assets/evidence-ledger-template.md) when a durable ledger is useful.

Never draft a precise material number without a source or an explicit unresolved marker.

### 5. Research adaptively

When permitted and needed, follow [references/research-and-compliance-rules.md](references/research-and-compliance-rules.md).

Before searching the public web, use relevant user-authorized internal or connected data sources when available. Do not treat internal database data as public evidence; label its provenance and access boundary.

Prefer primary official sources. Verify material market, financing, financial, customer, performance, IP, litigation, regulatory, and policy claims with either:

- one authoritative primary/professional original source; or
- two independent high-quality sources with compatible definitions.

Do not treat search snippets, aggregators, copied articles, or multiple reposts as verification.

Use only public or authorized access. Do not bypass login, paywalls, CAPTCHAs, access controls, or site restrictions. Do not use leaked data, unknown-origin databases, trade secrets, or irrelevant personal sensitive information.

If reliable evidence does not exist, state `[尚无可核验证据]`, `[来源待核验]`, or `[仅有公司单方口径]` in the working draft. Prefer natural reader-facing prose such as `尚无合同、验收或回款材料证明该事项`; do not narrate the search process or invent a plausible value.

### 6. Define the project thesis

Write a one-sentence internal thesis:

> 公司为【客户】通过【产品/技术】解决【痛点】，依靠【核心壁垒】实现【商业价值】，当前处于【商业化阶段】。

If this sentence cannot be supported, refine the project definition or flag the gap before drafting.

### 7. Generate and rank the question pool

Generate 15-30 candidates across:

- industry and market;
- customer pain;
- product and technology;
- competitive advantage and alternatives;
- business model and productization;
- customers, orders, delivery, revenue, and cash collection;
- financial quality and funding;
- team, governance, IP, and compliance;
- valuation or transaction terms when relevant;
- risks, milestones, and growth.

Rank each question by decision impact, controversy, evidence availability, and project specificity. Keep high-impact questions even when evidence is weak; answer them as unresolved rather than deleting them.

Choose the final count for the selected report mode. Use the project-type routing in [references/structure-blueprint.md](references/structure-blueprint.md).

### 8. Draft the report

Start from [assets/qa-report-template.md](assets/qa-report-template.md), adapting rather than filling mechanically.

Default report shape:

```text
# 项目名称Q&A 报告
## Q1: ...
## Q2: ...
...
## Qn: risks, verification, milestones, and decision
```

Start Q1 immediately after the title. Do not insert metadata, an execution summary, a question list, a table of contents, a standalone conclusion, an information-gap appendix, or a source appendix unless explicitly requested.

Write each answer as a continuous decision-useful analysis:

1. begin directly with the relevant facts, reasoning, or evidence;
2. separate non-overlapping drivers where useful;
3. use traceable facts, cases, or calculations;
4. state counterarguments, limitations, and unresolved items;
5. explain the implication for the decision in the body or a natural closing paragraph.

Never emit `结论：`, `**结论：**`, `结论如下`, or an equivalent standalone conclusion paragraph. Do not merely rename the label. If a direct answer is needed, express it naturally inside the opening analysis paragraph rather than as a separate summary block.

Distinguish:

- intention from signed order;
- order from delivery;
- delivery from acceptance;
- acceptance from revenue recognition;
- revenue from cash collection;
- internal test from third-party validation;
- company target from external forecast;
- allegation, filing, judgment, and final legal outcome.

Write external claims without citation labels or links in the reader-facing report. Preserve publisher, title, URL, publication date, access date, and claim mapping in the internal evidence ledger. Include only decision-relevant dates, periods, calculations, and assumptions in the report body.

Do not describe how evidence was found. Remove phrases such as `公开信息显示`, `根据公开材料`, `从公开资料看`, `公开报道显示`, and `未检索到公开信息`. Replace them with claim-first language and a precise boundary: `公司已上线…`, `相关记录显示…`, `现有证据只能确认…`, `尚无合同、验收或流水支持…`.

### 9. Integrate gaps and source provenance

For each unresolved material issue, include within the relevant answer:

- information gap;
- why it matters;
- required evidence or interview;
- owner, if known;
- deadline, if known;
- decision impact.

When database/connector retrieval or web research is used, keep the source mapping in the internal evidence ledger and express only the verified claim, its status, and any necessary neutral attribution in the report. Do not expose source names, locators, URLs, or clickable links in the standard report.

Create a separate evidence ledger or source register only when the user explicitly requests it. Keep that register as a separate file rather than appending it to the direct-Q&A report. Deep-diligence mode still requires an internal working ledger, but it is not a reader-facing deliverable by default.

### 10. Validate

Review against [references/evidence-and-quality-rules.md](references/evidence-and-quality-rules.md).

Run:

```bash
python3 "$QA_SKILL_DIR/scripts/validate_qa_report.py" /absolute/path/to/report.md
```

This validates the default direct-Q&A contract. If the user explicitly requests metadata, summary, list, gap, or source sections, run:

```bash
python3 "$QA_SKILL_DIR/scripts/validate_qa_report.py" \
  /absolute/path/to/report.md --extended-sections
```

Resolve all errors. Review warnings; retain intentional unresolved markers only when clearly disclosed.

### 11. Generate and verify the Word document

After Markdown validation passes:

1. Generate the DOCX:

```bash
python3 "$QA_SKILL_DIR/scripts/render_qa_docx.py" \
  /absolute/path/to/report.md \
  /absolute/path/to/workspace/output/docx/report.docx
```

2. Reopen the DOCX structurally with `python-docx` and ZIP/XML inspection; confirm it has non-zero paragraphs, all Q headings, valid tables, explicit styles/numbering/table geometry, zero external hyperlinks, and no `结论：` label, Markdown link syntax, raw URL, source line, or placeholder token.
3. Render every page to PNG under `tmp/docx/`. Use the host's canonical document renderer when available; otherwise use the native Word or LibreOffice path defined in [references/runtime-compatibility.md](references/runtime-compatibility.md). Any temporary PDF created during rendering is a QA intermediate, not a deliverable.
4. Visually inspect every rendered page at 100% zoom. Use contact sheets only for navigation; inspect every page individually before final delivery.
5. Fix clipped text, broken tables, orphaned headings, unreadable Chinese glyphs, bad link labels, excess whitespace, or inconsistent page transitions; regenerate and re-render after every material fix.
6. Do not deliver the DOCX until the latest inspection shows zero visual defects.

Use the Markdown as the editable content source. Do not edit rendered page images to correct substantive report content.

Treat the `qa_cn_formal_a4` profile as a pass/fail requirement. Before delivery, compare the DOCX styles, OOXML geometry, and rendered pages against every row in the format profile; a visually clean DOCX is not sufficient if its margins, font sizes, line spacing, alignment, table typography, or header/footer placement are outside the specified values.

## Non-negotiable rules

- Never fabricate market size, customer, contract, order, revenue, cash, financing, performance, IP, legal, or regulatory data.
- Never convert intention, plan, management target, Demo, or internal test into a stronger status.
- Never hide source conflicts or average incompatible figures.
- Never copy long protected passages; summarize them and record provenance in the internal evidence ledger.
- Never include irrelevant personal sensitive data or unsupported negative allegations.
- Never run write, update, delete, DDL, or administrative database operations for report generation.
- Never query an unapproved data system or broaden a query beyond the project need.
- Never assume the current workspace contains the source material.
- Never expose evidence-acquisition or web-research narration in the standard reader-facing report; keep it in the internal evidence ledger.
- Prefer a visible gap over a polished invention.
- Mark every inference and forecast as such.

## Delivery

Lead with the final DOCX link, then provide the Markdown companion link and a short summary of:

- selected report mode and question count;
- whether external research was used;
- material unresolved gaps;
- Markdown validation result;
- DOCX page count and visual verification result.

Do not claim the report is fully verified when material C/D-grade evidence remains.
