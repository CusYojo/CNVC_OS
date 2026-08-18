---
name: artifact-template-deta-2
description: "Create or polish a document using the Deta 德塔式上会尽调报告 2 template and its retained reference file. Use when the user selects this template, names Deta 德塔式上会尽调报告 2, explicitly invokes /sbl-deta-dd-report:artifact-template-deta-2, or asks to按德塔V5排版、优化上会尽调报告。"
---

# Deta 德塔式上会尽调报告 2

Create a document from this template. Keep the reference file unchanged.

## Workflow

1. Read `${CLAUDE_SKILL_DIR}/artifact-template.json` and resolve its paths relative to `${CLAUDE_SKILL_DIR}`.
2. Use `${CLAUDE_SKILL_DIR}/assets/reference.docx` as the retained template. Clone it to the output location before editing; never modify the bundled reference in place.
3. Read `references/style-spec.md`. Treat its eight named `投行 - *`
   styles as the sole typography authority.
4. Read `references/structure-spec.md`. Treat its 9 first-level, 28
   second-level, 20-22 third-level heading positions and five overview field
   lists as immutable template controls. Fixed labels are not prose and must
   not be paraphrased.
5. Read `references/editorial-spec.md`. Build the four-cluster anchor map and
   enforce its repetition, tone, value-chain and conclusion budgets.
6. Read `references/investment-value-spec.md`. Use its fixed five-part Deta
   investment-value sequence and master-risk form; keep transaction protection
   in `7.2`.
7. Treat the user's prompt and available sources as the content input. Do not
   invent facts merely to fill a template slot. When evidence is incomplete,
   use a conditional conclusion and state the unresolved control.
8. Build the decision chain before prose: verified base value, evidence-bounded
   growth option, transaction protection, material downside, and executable
   conditions.
9. Clone or import the reference instead of replacing its visual system with
   generic defaults. Bind applicable paragraphs to named styles; direct
   formatting is not a substitute.
10. Run the content-quality checks below, the Deta V5 structure/field audit,
   `${CLAUDE_SKILL_DIR}/../generate-deta-dd-report/scripts/editorial_quality_audit.py` and a
   named-style audit. Generate one native Word automatic directory after the
   cover with `TOC \\o "1-3" \\h \\z \\u`; update and save all fields in
   Microsoft Word, then render and inspect every page before returning the
   final artifact. A manual, empty, stale, non-clickable or incomplete
   directory blocks release.

## Content quality contract

- Keep the reference's exact 9 first-level and 28 second-level heading
  contract. Use 20-22 third-level headings: `2.4` has 3-5 consecutive dynamic
  people slots and must retain 4-5 members when that many decision-relevant
  core people are source-backed; the other third-level headings remain fixed.
  Never copy Deta names, people, customers, amounts, dates, or conclusions
  into another project.
- Keep the five overview tables' left-column labels verbatim and in order.
  `实际经营地址` is mandatory and must never become `实际经营安排`. Missing
  evidence is disclosed in the right-hand value, not by renaming the field.
  `注册地址` must reproduce the complete registered domicile shown on the latest
  business licence/registry evidence; province/city/district-only text is not a
  valid completed value. If evidence is absent, write `未提供，待核实` in the value
  cell instead of abbreviating the address.
- Keep the overview judgment to one or two sentences: verified operating
  basis, unverified growth driver, and required investment control.
- Render `1.5` in five company-value themes and in this order: industry
  position with paid commercial base; differentiated technical route;
  data/feedback-loop moat; customer or ecosystem commercial validation; team
  industrialization capability. Do not use transaction safety margin as one of
  the five items; old-share discount, staged payment, governance and downside
  protection belong in `7.2`.
- Give each value item a complete fact–mechanism–investment implication chain.
  Move recurring caveats to `主要风险` or chapter 8; do not interrupt every
  positive item with defensive wording.
- Write `1.5 主要风险` as one dominant commercialization, productization,
  repeat-purchase or valuation-realization risk plus its transmission through
  finance, customers, IP/data and manufacturing. Do not use a comma-only risk
  inventory.
- Separate `7.1 投资亮点` from `7.2 公司估值与投资方式`.
- Preserve the detailed internal risk register, but render the formal page
  with the exact Deta V5 columns `风险类别｜具体风险描述｜风险控制建议`.
  Fold priority, transmission, monitoring and unmet action into those cells.
- End with exactly three decision paragraphs: recommendation and rationale;
  amount/valuation/fully diluted ownership/payment; conditions precedent and
  suspension, repricing, or termination boundary.
- Anchor facts once: overview states the judgment, operating chapters hold
  evidence, the investment chapter holds calculations and terms, and the
  conclusion holds the decision.
- Treat paraphrased repetition as repetition. Keep the full technology chain
  in chapter 3, the full historical financial conflict in 6.2.3, the full
  transaction tuple in 7.2, and the full control logic in chapter 8.
- Keep `1.1 核心判断` to one uncertainty qualifier, keep `1.5 投资价值`
  free of defensive phrases, and allow at most two brief caveats across 7.1.
  Compress conclusion paragraph 3 to one parallel condition sentence plus one
  consequence sentence.
- State supported facts directly. Remove recurring `材料显示/尽调材料显示/未提供/
  未显示/以……为准` scaffolding from company, team, business and customer prose;
  centralize genuine gaps and verification actions in chapter 8 and conclusion
  paragraph 3. Retain the revenue-recognition finding in 6.2.3 and chapter 8.
- Render every numbered enumeration as separate Word paragraphs, one item per
  line, including items inside a table value cell. Never pack `1. ... 2. ...`
  into one paragraph or rely on manual line breaks.
- Do not use `详见/参见/见第X章/见X.X` as reader-facing placeholders. Each
  chapter must carry its own concise conclusion while the full analysis stays
  at the designated anchor.
- Follow the chapter-2 page contract in `references/structure-spec.md`: `2.1`,
  `2.2`, `2.6` and `2.7` are table-only; `2.3.1` has one quantified as-of ownership summary;
  `2.3.2` has no post-table risk paragraph; `2.4` begins directly with member
  biographies; and `2.5` headcount cells contain actual/planned numbers rather
  than reporting relationships.
  In `2.4`, rank founder/controller/chair/CEO first, then core technology,
  then product/commercial/operations/delivery leaders, followed by other key
  members. Never omit an evidenced fourth or fifth core person merely because
  the retained reference shows three people.
  In particular, remove `主要资料依据与使用边界` and its source table from
  the reader-facing report; source traceability remains in internal artifacts.
- Compare the draft against Deta V5 for both data granularity and analytical
  depth. Technology must explain module linkage and measurable validation;
  customer analysis must distinguish budget, procurement, acceptance and
  renewal; finance must expose the available statement/account detail; and
  valuation must connect price to verified operating evidence. Never invent
  detail merely to match reference length.

## Fidelity

Preserve page setup, sections, lists, tables, headers, footers, and recurring
page elements. Preserve the reference's margins, declaration header,
automatic page numbering, black-and-white table language, and cover
composition.

Normalize every table through the two-carrier contract in
`references/style-spec.md`: key-value tables shade only the first label column;
data tables shade and repeat the complete first row. Use the same Table Grid
base style, border weight, gray fills, cell margins, vertical alignment,
row-splitting rule and table-cell paragraph styles throughout. Run the
deterministic table-format audit after every material edit; visual similarity
alone is insufficient.

Use the named typography in `references/style-spec.md`: 黑体三号/四号/小四
for headings, 宋体小四 fixed 20 pt for body, 黑体小四 gray-centered table
headers, 宋体五号 fixed 16 pt notes, 黑体一号 TOC title, and 黑体二号 cover
title. Use landscape pages only for genuinely wide finance, forecast,
cap-table, valuation, or risk tables.

The delivered DOCX must contain a usable Microsoft Word automatic directory,
not only a “目录” title. It must cover all level-1/2/3 headings, retain
clickable hyperlinks, show refreshed page numbers, contain no Word field
errors, and remain editable/updatable as a native TOC field.

User instructions control requested content and explicit deviations. The retained reference controls layout and formatting where the user has not requested a change.
