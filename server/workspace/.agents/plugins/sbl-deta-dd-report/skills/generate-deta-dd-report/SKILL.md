---
name: generate-deta-dd-report
description: Generate, audit, revise, format, and visually verify evidence-backed Chinese equity-investment due-diligence reports from project ZIP archives or directories, using the retained Deta V5 DOCX as the visual authority and a structured IC decision contract for value, risk, transaction, conditions, and conclusion. Use for “根据尽调资料包生成尽调报告”, “按德塔V5排版”, “上会尽调报告”, “尽调报告核查订正”, “优化投资价值/风险/结论”, or when a reusable archive-to-DOCX due-diligence workflow is required.
---

# Generate Deta DD Report

Use the retained `assets/reference.docx` only as the design and narrative-pattern authority. Never copy Deta project facts into another company's report.

## Required resources

- Read `references/workflow.md` before starting any run.
- Read `references/report-schema.md` before drafting facts or report content.
- Read `references/structure-spec.md` before planning or drafting. It locks the
  Deta V5 chapter hierarchy and the retained high-value fields while applying
  the reviewer-approved carrier rules for prose and tables.
- Read `references/investment-value-spec.md` before drafting `1.5`, `7.1`,
  chapter 8 or the conclusion. It locks the Deta V5 investment-value sequence,
  the company-value/transaction-protection boundary and the master-risk form.
- Read `references/decision-contract.md` before building the investment thesis, risks, transaction recommendation, or conclusion.
- Read `references/editorial-spec.md` before drafting reader-facing prose. It
  defines the single-anchor map, repetition budgets, defensive-language
  budgets, complete value-chain test, and compressed conclusion form.
- Read `references/style-spec.md` before formatting or rendering.
- Use `${CLAUDE_SKILL_DIR}/scripts/deta_dd_processor.py` for intake, deterministic audits, Deta formatting, and rendering.
- Render with the bundled processor using Microsoft Word on macOS when available, otherwise headless LibreOffice plus Poppler; inspect every rendered page before release.

## Workflow

1. Initialize a run from one ZIP archive or directory:

   ```bash
   python3 "${CLAUDE_SKILL_DIR}/scripts/deta_dd_processor.py" init \
     --input /abs/project.zip \
     --run-dir /abs/run \
     --project "目标公司"
   ```

2. Inspect `source_manifest.json` and every critical parse failure. Repair OCR or spreadsheet extraction before analysis when a failed file could change ownership, revenue, cash, valuation, legality, or the investment conclusion.
3. Build `facts.json` and `rulings.json`. Give every material fact a source ID, subject, period/date, unit, scope, evidence status, and confidence. Resolve conflicting numbers by source hierarchy and effective date; never average conflicts.
4. Close evidence and conflict gates before editorial optimization. Build the decision chain: company identity, ownership and related parties, technology and IP, products, customer stage, suppliers/cost, historical financials, forecast drivers, transaction terms, downside, risks, and conditions precedent.
5. Populate the structured `decision`, `value_logic`, and `risk_register` objects defined in `references/decision-contract.md`. Before prose, build an `anchor_map` for technology chain, historical finance/conflicts, transaction structure, and risks/controls. Assign one full-analysis chapter to each cluster and a short role to every other appearance. Draft `report.json` with exactly the nine first-level sections in `references/report-schema.md`. Separate lead, test, PoC, contract, delivery, acceptance, invoice, collection, and repeat purchase. Do not treat pipeline demand as revenue.
   Before selecting people, ownership, related parties, customer subsections,
   technology routes or IP items, run the identity-and-stage gate:
   - distinguish legal voting control from beneficial/economic ownership and
     list every disclosed nominee holding;
   - bind each biography, title and credential to one named person; never infer
     identity from adjacent slide text or OCR order;
   - separate shareholders/management/controlled entities from subsidies,
     operating addresses and ordinary counterparties when building related
     parties and related transactions;
   - call an interaction a customer interview only when an attributable
     customer interview record exists; otherwise label the evidence as
     contract, project, delivery, acceptance, collection or management claim;
   - use the company's named technical route when source-backed, then map each
     module's input, method and output; do not replace it with a generic AI
     architecture;
   - render material patents and software copyrights as itemized records with
     name, number, date, status and inventors/owner, and flag nonemployee
     inventors or external contributions.
   Lock the 28 second-level headings, 20-22 third-level heading positions, and
   the retained overview fields/carriers in `references/structure-spec.md`. In particular,
   use `实际经营地址` exactly; never rename it to `实际经营安排`.
   `注册地址` must be copied in full from the latest business licence or
   current registry record, normally through street/town, road, number and room;
   a province/city/district-only value fails the structure gate. If the source is
   genuinely unavailable, retain the field and state `未提供，待核实` rather than
   silently shortening it.
   Treat `1.5 投资价值与风险` as a core decision chapter. Use the Deta V5
   sequence: industry position and paid commercial base; differentiated
   technical route; data/feedback-loop moat; customer/ecosystem commercial
   validation; team capability. Require five evidence-based value chains,
   each linking fact, mechanism, and investment implication, plus one
   master-risk paragraph. Keep discounted secondary shares, staged payment,
   governance and other transaction protection in `7.2`, not among the five
   company-value items. Require at least three
   substantive paragraphs in both `5.1.1 政策层面` and `5.1.2 市场层面`;
   explain commercial transmission and reachable demand instead of merely
   listing policies or a market-size table.
6. Run the deterministic audit. A false hard gate blocks a clean “pass”:

   ```bash
   python3 "${CLAUDE_SKILL_DIR}/scripts/deta_dd_processor.py" audit --run-dir /abs/run
   ```

7. Revise in this order: P0/P1 evidence and conflicts; decision logic and transaction controls; reader structure and exact-duplicate removal; wording and polish. Record each change in `revision_log.json` with issue, impact, source/recalculation, change, reviewer result, and status. Do not inflate the score by adding unsupported prose.
   Run a semantic compression pass before formatting: collapse repeated fact
   clusters to their anchors, move boundary language out of `1.5 投资价值`,
   and compress the conclusion's conditions to one parallel sentence plus one
   unmet consequence. Never delete a material risk; relocate it to the risk
   anchor.
   Run a source-attribution cleanup pass: state supported facts directly;
   remove recurring `材料显示/尽调材料显示/未提供/未显示/以……为准` scaffolding
   from operating prose; centralize genuine gaps and verification actions in
   chapter 8 and conclusion paragraph 3. Preserve the historical revenue-
   recognition finding in 6.2.3 and its matching chapter-8 control.
   Run a reader-flow pass: every numbered enumeration uses one real Word
   paragraph per item, including inside table cells. Do not concatenate
   `1. ... 2. ...` in one paragraph or simulate the list with manual line
   breaks. Remove `详见/参见/见第X章/见X.X` shortcuts from reader-facing prose;
   each section must state the fact or conclusion needed at its own level of
   detail without copying the full anchor analysis.
   Run a reference-depth pass against Deta V5. Match not only headings and
   styles but also each section's analytical responsibility and the
   reviewer-approved carrier:
   `2.1`, `2.2`, `2.6` and `2.7` are table-only; `2.3.1` starts with one as-of cap-table
   summary; `2.3.2` ends at the penetration table; `2.4` introduces 3-5 people
   directly and must use 4-5 slots when that many decision-relevant core
   members are source-backed; `2.5` uses actual/planned headcount rather than
   reporting lines. Order `2.4` members by investment relevance: founder,
   controller, chair or CEO first; CTO, chief scientist or core R&D lead next;
   product, commercial, sales, operations or delivery leaders next; then other
   material key members. Never truncate a source-backed fourth or fifth member
   to match the three-person reference, and never rank an adviser or partner
   ahead of a full-time core executive.
   use prose for `1.3`, `1.5` and `7.1`; remove the low-value `价值` column
   from `3.1` and `关键验证` from `4.1`; keep internal evidence labels
   out of the formal report. Compare data granularity and causal depth in technology, customer,
   financial and transaction sections. Add only evidence-supported detail.
   For `2.6`, match Deta V5 semantically as well as visually: render exactly
   `事项｜核验结果` with the rows `关联企业｜关联往来｜个人往来`. Do not
   substitute a general related-party identity list; distinguish enterprise
   transactions from balances with related natural persons and state the
   relevant as-of date and amount where available.
8. Build a working DOCX from `report.json` or a reviewed draft. Preserve
   source-backed facts and use Deta structure, not sample company text. Then
   apply the deterministic named-style normalization. The eight
   `投行 - *` styles in `references/style-spec.md` are the sole typography
   authority; never inherit obsolete FangSong/15 pt heading defaults from an
   older draft:

   ```bash
   python3 "${CLAUDE_SKILL_DIR}/scripts/deta_dd_processor.py" format \
     --input /abs/draft.docx \
     --output /abs/final.docx
   ```

   Audit the style bindings and native TOC structure before render. The
   formatter must create a real Word `TOC` field after the cover, not a manual
   list of headings and page numbers. It must cover outline levels 1-3, include
   clickable hyperlinks, and be marked for update in Word:

   ```bash
   python3 "${CLAUDE_SKILL_DIR}/scripts/investment_bank_styles.py" audit \
     --input /abs/final.docx --allow-unupdated-toc
   ```

   The same audit enforces the Deta V5 table system: all tables use the
   shared Table Grid geometry; key-value tables shade only their label column;
   data tables shade and repeat the complete first row; borders, cell margins,
   vertical alignment, row-splitting and table-cell paragraph styles are
   uniform. A visual resemblance without these deterministic properties does
   not pass.

   Audit the Deta V5 chapter and field contract:

   ```bash
   python3 "${CLAUDE_SKILL_DIR}/scripts/deta_structure_contract.py" audit --input /abs/final.docx
   ```

   Audit semantic repetition, tone and value completeness:

   ```bash
   python3 "${CLAUDE_SKILL_DIR}/scripts/editorial_quality_audit.py" --input /abs/final.docx
   ```

9. Render with Microsoft Word on macOS when available, otherwise headless LibreOffice. Microsoft Word must update all fields and the table of contents, save the refreshed DOCX, and only then export PDF. The processor converts the PDF with Poppler. Inspect every PNG at 100% zoom. Fix clipping, overlap, blank pages, broken tables, missing glyphs, TOC/page-number errors, and unexplained pagination drift:

   ```bash
   python3 "${CLAUDE_SKILL_DIR}/scripts/deta_dd_processor.py" verify \
     --docx /abs/final.docx \
     --output-dir /abs/qa \
     --word-native
   ```

   Then run the strict TOC/style audit without the pre-Word exception:

   ```bash
   python3 "${CLAUDE_SKILL_DIR}/scripts/investment_bank_styles.py" audit --input /abs/final.docx
   ```

   The strict audit must find one native `TOC \\o "1-3" \\h \\z \\u` field,
   a refreshed cached entry and hyperlink for every level-1/2/3 heading, no
   Word field error, and correct heading/page-number rendering. A missing,
   manual, empty, stale, non-clickable or partially populated directory blocks
   formal release.

10. Rerun content audit, style audit, and `verify` after every material
    revision. Deliver the DOCX only when all applicable gates pass, or label it
    “有条件稿/资料缺口稿” and state the unresolved evidence gates explicitly.

## Non-negotiable gates

- Do not invent facts, financial history, market shares, customer stages, transaction terms, or return assumptions.
- Do not copy Deta names, people, customers, amounts, conclusions, or dates.
- Do not release when a false hard gate is masked by a numeric score.
- Every formal report must contain a normal, usable Word automatic directory
  immediately after the cover. It must cover level-1 through level-3 headings,
  use clickable hyperlinks, refresh page numbers in Microsoft Word, and remain
  editable as a native TOC field. A static/manual directory, missing directory,
  stale page number, broken link, incomplete heading coverage or Word field
  error blocks clean release.
- Tie every material table and conclusion to facts in `facts.json`.
- Require every growth thesis to state its evidence boundary and falsification condition. Do not promote a demand expression, framework agreement, internal metric, or first delivery into verified repeatable revenue.
- Keep value and risk asymmetric but balanced: state the investable upside clearly, while preserving every P0/P1 control needed to make that upside investable.
- In `1.5`, follow the five-item Deta narrative order and keep each item about
  the company or its market position. Do not substitute transaction structure
  for team or operating capability. Write one dominant commercialization or
  value-realization risk, then explain how the supporting risk factors transmit
  into the revenue base, growth value and valuation; do not render a comma-only
  risk inventory.
- Keep data rights/compliance at P1 when a defect can block delivery or create liability. Elevate manufacturing yield to P1 only when it materially supports valuation, forecast, or payment.
- Enforce the anchor rule: overview = conclusion; operating chapters = evidence; investment chapter = calculations and terms; conclusion = decision. Exact repeated explanatory passages block clean release.
- Enforce semantic repetition budgets, not only exact-string deduplication:
  technology chain, core financial conflict and full transaction tuple must
  each have one complete anchor. More than two chapter-level full appearances
  of a cluster block clean release.
- Do not add a `核心判断` row to `1.1`; the overview is limited to the six
  retained company-identity fields. Keep `1.5 投资价值` positive and causal;
  move caveats to `主要风险` or chapter 8.
  Allow at most two short boundary cues across `7.1 投资亮点`.
- Require each value item to state fact basis, value mechanism and investment
  implication. Validation boundaries remain mandatory internally but must not
  interrupt every reader-facing value sentence.
- Require numbered items to be separate Word paragraphs with one item per
  line, including numbered content in overview tables. A packed numbered
  paragraph blocks clean release.
- Do not use `详见`, `参见`, `见第X章`, `见X.X` or equivalent cross-reference
  shortcuts in report prose. Write the necessary local conclusion directly;
  preserve the full analysis only at its designated information anchor.
- Recalculate cap table, valuation, dilution, forecast arithmetic, gross margin, MOIC, and IRR independently when used.
- Use the company's actual operating history. A company founded recently is not required to have nonexistent prior-year statements, but every available period since incorporation must be covered and any missing cash-flow/bank reconciliation must remain a formal gap.
- Keep internal fact IDs, scoring, source-ledger mechanics, and red-team notes out of the reader-facing report.
- Keep internal workflow labels out of the reader-facing report, including
  `尽调证据`, `核查结论`, `关键验证`, `当前证据`, `投资处理`
  and raw P0/P1/P2/P3 codes. Translate only the underlying fact, analysis or
  control into ordinary report language.
- Keep source mechanics out of reader-facing prose as well: direct factual
  statements are preferred to repeated `材料显示`. Non-anchor chapters may not
  carry diffuse missing-material or verification disclaimers; use chapter 8
  and conclusion paragraph 3 as their disclosure and action anchors.
- Keep the original archive and retained template byte-for-byte unchanged.
- Keep all formal tables on the two-carrier contract in `references/style-spec.md`.
  Never mix gray values, borders, cell margins, paragraph alignment, fixed row
  heights, or header behavior between sections. In particular, recognize the
  fixed two-column data-table headers before applying left-column key-value
  styling.
- Treat fixed chapter labels and the retained overview labels as template
  controls. The reviewer-approved carrier contract intentionally omits generic
  `发展阶段/核心判断` rows and converts `1.3`, `1.5`, and `7.1` to prose.
- Enforce the chapter-2 page contract in `references/structure-spec.md`.
  Table-only sections may not accumulate captions or analytical prose;
  shareholder summaries must quantify the as-of structure; team biographies
  must bind credentials to the correct person; organization headcount cells
  must contain counts or plans, never reporting relationships.
  Keep `2.6` and `2.7` to their single primary tables. Never expose the
  internal source manifest as `主要资料依据与使用边界` in the formal report.
- Allow consecutive dynamic people headings from `2.4.1` through `2.4.5`.
  The structure audit accepts 20-22 total third-level headings. Use 4-5 team
  slots whenever the source facts support them, retain 3 only when no fourth
  decision-relevant member is evidenced, and never invent a filler biography.
- Require `2.6` to use the Deta V5 four-row contract: header
  `事项｜核验结果`, followed by `关联企业`, `关联往来`, and `个人往来`.
  A shareholder/management roster is not a substitute for the two separate
  transaction tests.
- Do not confuse brevity with quality. For technology, customer, finance and
  valuation anchors, compare the draft with Deta V5 on object-period-unit-
  scope granularity and on fact-mechanism-implication-boundary depth. A short
  conclusion is acceptable only after the underlying anchor carries enough
  evidence for the decision.
- Reject ambiguous dates such as `报告期内`; use an exact year, date or
  as-of period. Use `备注` in financial tables only for material deviations,
  not a boilerplate conclusion on every row. Remove every standalone caption
  immediately above a table before visual QA; section headings and table
  headers must carry the context. In `3.6`, keep the reader-facing patent
  table to `专利名称｜申请号｜申请日｜发明人`, omit `权利状态`, and do not add a
  post-table interpretive paragraph about patent counts, non-employee
  inventors, or overseas technology ownership.
- In the formal reader-facing report, state supported facts directly. Never
  use `公司披露`, `管理层披露`, or the generic time marker `截至报告日`; use an
  exact date only when the conclusion genuinely depends on its as-of point.

## Output set

Keep the final DOCX concise for readers and the audit trail detailed for reviewers:

- final report DOCX;
- `source_manifest.json`, `facts.json`, `rulings.json`, `report.json`;
- `qc_report.json`, `revision_log.json`, and rendered QA directory.

Do not publish a clean final when the audit status is `blocked` or `conditional`.
