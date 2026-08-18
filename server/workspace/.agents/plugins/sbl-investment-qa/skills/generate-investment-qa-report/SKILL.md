---
name: generate-investment-qa-report
description: Generate, audit, revise, render, and visually verify evidence-backed Chinese project Q&A reports for external fundraising narratives and internal investment decisions. Use for 项目QA、投委会问答、上会答辩、融资路演Q&A、尽调质询稿、德塔式项目Q&A or DOCX reports from BP/PDF/PPTX/DOCX/XLSX, interviews, financial records, customer evidence, and transaction files. It builds positive-first sector positioning, stage-correct benchmarks and business flywheels while preventing procurement-to-joint-development, intention-to-contract, management-statement-to-governance, and academic-result-to-company-IP overclaiming.
---

# Generate Investment Q&A Report

Produce a source-backed Chinese investment-committee Q&A through staged evidence, question design, drafting, correction, rendering, and page review. Write as the investment team that has completed diligence and formed a recommendation, not as an external adviser assigning work to the company. Use the current Claude Code model for reasoning and writing. Never call an external model gateway.

## Required resources

1. Read `references/workflow.md`, `references/content-contract.md`, `references/dual-use-narrative.md`, `references/question-design.md`, and `references/evaluation-checklist.md` in full. When a Deta-style reference is supplied or requested, also read `references/deta-qa-template.md`.
2. Use `references/content-schema.json` as the machine-readable artifact contract.
3. Run `python3 "${CLAUDE_SKILL_DIR}/scripts/qa_report_processor.py" --help` before the first execution.
4. Render the DOCX to PDF with Microsoft Word or headless LibreOffice, convert all PDF pages to images with Poppler, and inspect them page by page.

## Locked Deta DOCX format

Apply this profile whenever the user requests a Deta-style Q&A, supplies the retained Deta reference, or asks to keep the same structure or typography. Do not treat “Deta-style” as a loose visual preference.

- Set `qa_content.meta.narrative_mode` to `reference_faithful` and `qa_content.meta.format_profile` to `deta_qa_pdf` before audit or rendering, unless the user explicitly requests another format.
- Render only one centered title followed immediately by Q1. Use 6—9 continuous Q&A items. Start the first answer paragraph with “回答：”. Do not add an overview, abstract, cover, contents page, source note, table, header, footer, or page number.
- Use one A4 portrait section. Set top and bottom margins to 2.54 cm and left and right margins to 3.175 cm.
- Use `STKaiti` for Chinese text and Times New Roman for Latin text and numbers. Use 16 pt bold for the title and 11 pt for questions and answers. Make questions bold; keep answers regular with no first-line indent.
- Use exact 14.4 pt line spacing. Set title spacing after to 16 pt, question spacing before to 20.4 pt except Q1, question spacing after to 7.8 pt, and answer spacing after to 7.8 pt. Keep each question with its first answer paragraph.
- Treat these tokens as release gates. Run `verify`; reject the DOCX if its structure, fonts, sizes, margins, spacing, weight, indentation, or question-answer sequence differs. Then render and inspect every page in the target Mac font environment.

## Core boundary

- Lock `audience_mode` before question design. Default to `external_decision_qa`: this is a decision-facing Q&A, not an internal diligence memo. It contains mature conclusions and verified positive evidence only. Use `internal_decision_qa` only when the user explicitly asks for transaction protections, diligence gaps, downside cases, or internal execution terms.
- In `external_decision_qa`, remove risk questions from the question set itself. Do not ask about IP gaps, relocation compensation, staged payment, reserves, earn-outs, unresolved accounting definitions, or supplier dependence. Route those subjects to a separate transaction-plan or diligence appendix rather than hiding them in the answers.
- In `external_decision_qa`, ban internal narrator phrases (“经项目组核查”“项目组判断”“项目组支持”), valuation exclusions, staged payment, reserves, compensation, and withheld-payment language. Start with the business conclusion itself. End when the question has been answered; a concrete customer behavior is preferable to a generic sentence such as “公司具备明确投资价值”.
- In `external_decision_qa`, keep evidence status private. Write accepted diligence facts directly in the investment manager's voice; do not expose repetitive source qualifiers such as “据公司披露”“据管理层”“管理层表示”. A `management_stated` fact may be used only when the team has adopted it as a non-sensitive descriptive fact and it does not purport to prove a contract, acceptance, payment, governance, ownership or third-party-verified performance. Omit any statement that still needs attribution to remain accurate. Never convert an intention into an order or an internal metric into a third-party-verified result.
- Default to the `dual_use` narrative profile only when no controlling reference forbids front matter. Use `internal_ic` for a purely internal challenge memo. Use `reference_faithful` when a supplied Deta-style reference starts directly with Q1: keep the sector map private and distribute its reasoning into Q1/Q4/Q7 instead of displaying an overview.
- Set `report_stage` before drafting. Default to `final_recommendation`: diligence is complete and the project team is reporting its final investment conclusion upward. The visible Q&A contains conclusions, not approval process, future diligence, or post-investment work. Use `team_recommendation`, `internal_approved`, `terms_agreed`, or `signed_or_closing` only when the user explicitly asks for that process stage.
- Set `investment_stance` explicitly. For a report commissioned to support an active investment recommendation, default to `support`; objectivity means accurate facts and no overclaiming, not writing equal pro/con positions in the visible answer.
- Write external answers as spoken investment-manager responses, not mini analytical essays. Give the answer within the first one or two sentences, then keep only the facts and explanation needed for that question. Do not narrate the reasoning process or explain obvious implications to the audience.
- In `external_decision_qa`, frame questions around matters that can be answered with landed evidence: valuation support, customer validation, revenue quality, product value, technology and team execution. Keep adverse facts and competing explanations in private working papers unless the external audience explicitly raised them and a complete, verified answer is available.
- Answer each external question in 1—4 natural paragraphs. Set no minimum word count and do not equalize question lengths. What follows may use a comparison, a customer decision, a chronology, a mechanism or a concise set of facts. Do not force every answer through the same `conclusion → two customer examples → conclusion` skeleton. If the last paragraph only restates what the preceding paragraph has already proved, delete it. A concrete commercial result may be the final sentence; an explicit investment conclusion is not mandatory when the answer is already complete.
- Plan a `why_layer` only for questions that genuinely ask for a mechanism, customer decision or causal explanation. For a factual valuation, revenue or organization question, leave it empty when the evidence itself answers the question. Never invent a causal story to satisfy a planning field.
- Use enough traceable facts to prove the conclusion. Do not pad every answer to a fixed number of figures or repeatedly cite the same two customers as a pair. A question about one customer's decision should stay with that customer; a cross-customer comparison belongs only in the question that actually asks for it.
- In external mode, connect verified facts to the specific customer behavior or operating result asked about. Do not force every question through a full `事实→客户行为→收入→投资价值` chain when a shorter causal explanation answers it better. In internal mode, extend the chain to valuation, payment, reserves or termination actions when relevant.
- Preserve adverse facts and the strongest competing explanation in private planning. In external mode, move unresolved risks and transaction treatments to a separate internal appendix; do not conceal or falsify them, and do not volunteer them in the external Q&A.
- Never upgrade procurement into joint development, intention into contract, testing into acceptance, management statements into verified governance, or academic affiliation into company-owned IP. In external mode, omit unsupported claims; in internal mode, state the evidence limit and transaction treatment.
- Treat overseas foundation-model companies and late-stage domestic platforms as sector-ceiling references, not direct valuation comparables. State stage, round, scale and business-model differences before using them; anchor current pricing to the project’s own confirmed revenue, gross margin, cash collection and milestone evidence.
- Do not add a second commercialization/organization question when one already exists. Upgrade and rename the existing question instead. Keep the full report to 6—9 non-overlapping questions.
- Design questions from investment judgments, not by splicing two material data points into a prompt. External questions do not need a number. Use the best-fitting archetype from `references/question-design.md`, and let at least half of the questions remain meaningful without a numeric anchor. Choose paragraph breaks by meaning, not by a report-level variety quota.
- Keep concepts ordinary and precise. Prefer “同行估值说明赛道关注度”“形成可重复销售的产品” over invented phrases such as “资本上限”“平台飞轮”“成长锚”“治理资产” or “对称资本处理”.
- Do not begin visible paragraphs with a mini-heading plus a colon. External Q&A must contain no payment, reserve, compensation, earn-out or withheld-consideration paragraph; place those matters in the internal transaction plan.
- In external mode, begin with a complete substantive sentence, such as “当前4.5亿元投前估值有实际业务支撑” or “追觅继续采购，直接原因是首轮任务已经完成交付”. Do not use one-word openings such as “合理。”“能。”“具备。”“清晰。”. At the end, prefer “客户继续下单”“另一行业客户连续按月付费”“手套能够单独销售” over “已经形成基础”“具备明确能力”.
- Prefer concrete, established business terms: 收入、采购、交付、验收、回款、复购、成本、报价、客户任务、产品销售. Avoid coined or promotional abstractions such as 客户入口、高维数据积累、价值释放、成长锚、治理资产、平台飞轮、资本上限、生态闭环. Replace them with the underlying fact.
- Avoid polished meta-commentary that tells the audience how to interpret the evidence, such as “这个顺序比采购金额更能解释复购”“对估值最有分量的支撑是”. Put the weight on the fact itself: “先交付，再验收，然后扩品”“大衍当前的价格落在追觅复购和行之途按月采购上”.
- Give multi-factor answers an audible structure with “第一、第二、第三”. Each point may occupy its own paragraph when this improves clarity. Use this for valuation, customer quality, finance, product, organization and technology questions when two or more independent grounds are present. Keep single-case questions as plain prose. Write “第一，” rather than mini-headings such as “第一：收入基础”, and do not force every answer into three points.
- Vary the answer rhythm across the report. Use comparison, mechanism, a single-customer decision, cross-industry transfer, chronology or decision framing according to the question. Numbered answers may appear, but they must not exceed half of the report. In an eight- or nine-question report, use at least two paragraph counts; do not let more than half of the answers rely on the same named customer pair.
- Let sentence length follow the thought. A short sentence is useful only when a real decision point deserves emphasis; do not manufacture contrast, fragments or quotable endings. Read each answer aloud and revise only where the rhythm sounds unnatural.
- Keep the spoken register of an investment manager. Prefer plain complete sentences and ordinary transitions. Do not manufacture informality with slang, rhetorical hooks, sentence fragments or slogan-like lines.
- Prefer affirmative statements of verified business facts over defensive contrasts. Write “定价基于已落地收入和客户复购”“收入全部来自已履行项目” instead of “不是以远期设想定价”“不包含意向金额”. Use stronger verbs such as “证明了”“已降低” only when the underlying evidence demonstrates the claimed result; wording strength must never exceed evidence strength.
- Do not open a technology answer with a taxonomy such as “数据处理能力、仿真能力、交付能力”. Start with how the team turns existing tools into a customer outcome, then connect workflow, task result, payment and repeat purchase in natural prose. Use numbered points only when they clarify commercially distinct grounds, not merely to list technical modules.
- Ban process and advisory voice in external mode: “建议公司”“公司需要”“尚未完成”“仍需跟踪”“纳入投后”“提交审议”. Do not replace it with valuation exclusions or reserves; remove the topic from the external Q&A and route it to the internal appendix.
- Never claim “双方已约定” or “交易文件已明确” without signed evidence, in either mode.
- Keep working papers, fact IDs, source IDs, scores, revision logs, and audit language out of the visible DOCX.

## Workflow

1. Run `prepare` against the untouched archive or directory. Inspect every extraction warning in `source_manifest.json`; add OCR or conversion evidence before drafting when a material source failed.
2. Build `facts.json` before prose. Give signed documents, official registrations, audited reports, bank/contract evidence, and direct customer interviews more weight than BP claims or forecasts. Record object, period, unit, evidence state, and source IDs.
3. Build `rulings.json`. Preserve competing values, select the governing value with a reason, and blacklist rejected values. Do not silently average conflicts.
4. Build `qa_plan.json`. Define the three-class sector map and project position privately. Give every question a `question_archetype` and an `evidence_focus`; add `why_layer` only where the question requires a causal explanation. Assign each material fact a primary question. It may support one other question when necessary, but the same customer story must not become the default evidence for the report. External mode covers valuation/benchmark, customer validation, revenue quality, product/technology value and commercialization/organization; it excludes unresolved governance/IP and transaction mechanics. Internal mode may additionally cover governance/IP, payment schedule, reserves and termination conditions. Keep the report to 6—9 non-overlapping questions.
5. Build `qa_content.json`. Lock `report_stage` and `investment_stance` before prose. For Deta output, also lock `narrative_mode=reference_faithful` and `format_profile=deta_qa_pdf`; render the title and then Q1 directly. Add an execution overview only in `dual_use`. Use 1—4 internal paragraph roles according to the answer, but render no role labels. Match each item to one planned question and list every used fact ID privately.
6. Read the complete Q&A aloud before red-teaming it. Mark answers whose logic is too perfectly symmetrical, whose last line explains the evidence a second time, or whose tone shifts into slogans. Remove unnecessary connectors and polished restatements. Then red-team under a default “do not invest” hypothesis, record each issue and correction in `revision_log.json`, and close every P0/P1 issue.
7. Complete `quality_scorecard.json` using the fixed 100-point dimensions. Give credit only for analysis actually present in the text.
8. Run `audit`. Fix the underlying fact, ruling, plan, answer, or scorecard until it passes. Do not use `--allow-failed-audit` for a deliverable.
9. Run `render`, then `verify`. Export the DOCX to PDF with Microsoft Word or headless LibreOffice, convert it to PNG pages with `pdftoppm`, and inspect every page at 100%. Correct clipping, broken lines, isolated questions, abnormal whitespace, missing glyphs, or accidental headers/footers.
10. Deliver the clean DOCX. Deliver evidence and audit sidecars only when the user asks for them; otherwise summarize material unresolved boundaries in the handoff without exposing internal IDs.

## Program interface

```bash
PYTHON_BIN=python3
SKILL_DIR="${CLAUDE_SKILL_DIR}"
PROCESSOR="$SKILL_DIR/scripts/qa_report_processor.py"

"$PYTHON_BIN" "$PROCESSOR" prepare project.zip --workdir run
"$PYTHON_BIN" "$PROCESSOR" audit --artifacts run --out run/qa_audit.json
"$PYTHON_BIN" "$PROCESSOR" render --artifacts run --output 项目QA.docx
"$PYTHON_BIN" "$PROCESSOR" verify --artifacts run --docx 项目QA.docx --out run/qa_verify.json
```

Use absolute paths in actual runs. Keep the original source archive unchanged.

## Release gates

- Evidence: every decisive statement and every non-year number is traceable to a fact and source.
- Conflict: no rejected or stale value appears in an answer.
- Question design: 6—9 sharp, materially distinct questions. External mode contains only questions answerable with landed facts; internal mode may include adverse signals and transaction treatment.
- Answer quality: each answer is clear, natural, evidence-backed and decision-relevant; external answers state the business answer early, explain only the relevant “why”, contain no new diligence task or transaction mechanics, and stop when the question is complete. No length, paragraph-count or cadence quota may cause filler.
- Claim integrity: every sensitive positive statement has explicit fact support and an expression level consistent with the underlying evidence status.
- Semantic score: total at least 85/100; every dimension at least 60%; no hard failure.
- Revision: all P0/P1 items closed.
- Package: when Deta output is requested, every structure and typography token in “Locked Deta DOCX format” passes deterministic verification; otherwise use one A4 portrait section with no cover page, TOC, heading styles, tables, headers, footers, or page numbers.
- Visual: every page rendered and inspected; no clipping, overlap, unreadable text, missing glyph, or isolated question heading.

Never release a failed, skipped, or visually unreviewed document as a formal Q&A.
