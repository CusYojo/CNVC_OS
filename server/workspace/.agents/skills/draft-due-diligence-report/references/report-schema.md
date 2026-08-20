# Report schema and content rules

Use `schema_version: 2` for new `report.json` artifacts. Version 2 requires the structured decision contract in `decision-contract.md`.

## Fixed first-level structure

1. `1、投资概要`
2. `2、公司概况`
3. `3、产品与技术`
4. `4、业务情况`
5. `5、行业和市场`
6. `6、未来发展规划`
7. `7、投资方案`
8. `8、风险提示与对策`
9. `投资结论及建议`

Use the exact Deta V5 second-level structure in `structure-spec.md`; project
facts do not authorize renaming or omitting a fixed heading or overview field.
If a fact is unavailable, retain the fixed slot and state the evidence status
in its value. The content responsibilities are:

- Investment overview: company, transaction, industry, business/management, value/risks.
- Company: basic data, history, shareholders/control, core team, organization, related parties, qualifications/legal compliance.
- Product/technology: concept, technical route, product matrix, applications, evolution, IP/data rights.
- Business: model/sales, customer validation, supplier/procurement/cost.
- Industry/market: trend/pain points and calibrated market/competition.
- Plan/finance: operating plan, actual historical finance, forecast and cash needs.
- Investment: `7.1 投资亮点`, `7.2 公司估值与投资方式`, and `7.3 退出方案`. Keep strengths separate from price, dilution, payment, and protection.
- Risks: retain priority, value transmission, monitoring trigger, pre-control
  and unmet action in the structured risk register, but render the formal
  Deta V5 page as `风险类别｜具体风险描述｜风险控制建议`. Fold monitoring
  and consequence details into the latter two cells without renaming columns.
- Conclusion: three paragraphs covering decision/rationale, amount/valuation/ownership/payment, and conditions/termination boundary.

Before prose, assign the four required fact-cluster anchors defined in
`editorial-spec.md`. The technology chain belongs to chapter 3, historical
finance and accounting conflicts to 6.2.3, the complete transaction tuple to
7.2, and risks/controls to chapter 8. Overview and conclusion are summaries,
not additional analysis locations.

Represent `2.4 核心团队介绍` as a `members` array ordered by investment
relevance. Capacity is five members. When four or five decision-relevant core
members are source-backed, retain all of them and render consecutive headings
`2.4.1` through `2.4.4/2.4.5`; do not stop at three because the reference has
three samples. Rank founder/controller/chair/CEO first, then core technology,
then product/commercial/operations/delivery leadership, then other material
members. Use three only when the evidence supports no fourth person; never
invent a person or promote an adviser/partner ahead of a full-time executive.

The five investment-overview field lists are exact. `实际经营地址` is a fixed
field and must never be rendered as `实际经营安排`. Likewise, do not replace
`投资方式`/`投资金额`/`投资估值` with merged or editorialized labels.

Before drafting prose, populate `decision`, `value_logic`, and `risk_register` exactly as defined in `decision-contract.md`. These internal objects are mandatory release controls, not reader-facing appendices.

In `report.json`, store the final section as `{"title": "投资结论及建议", "paragraphs": [p1, p2, p3]}`. Each item must be one nonempty paragraph and no fourth summary paragraph may follow. Include the exact second-level titles `7.1 投资亮点` and `7.2 公司估值与投资方式` in the investment section.

## `facts.json`

Store an array of objects. Required keys for material facts:

```json
{
  "id": "F-001",
  "category": "customer|financial|ownership|technology|legal|transaction|forecast|other",
  "statement": "fact stated without interpretation",
  "subject": "legal entity/product/customer",
  "period": "YYYY, YYYY-MM-DD, or as-of date",
  "unit": "CNY/万元/%/套/人/none",
  "scope": "consolidated/entity/project/contract",
  "status": "confirmed|management_claim|open|rejected",
  "confidence": "high|medium|low",
  "source_ids": ["S0001"],
  "source_locator": "page/sheet/paragraph/table",
  "conflict_group": null,
  "notes": "definition and boundary"
}
```

Every reported numeric fact must identify the number's object, period/date, unit, scope, and source. Do not fill missing history with zero.

## Customer stage

Use exactly one current stage per claim: lead, test, PoC, contract, delivery, acceptance, invoice, collection, repeat purchase. A later stage requires evidence for the preceding commercial chain or an explicit exception. Demand quantity, framework cooperation, and named-customer discussion do not become base-case revenue.

## Forecasting

Prefer driver formulas such as quantity x price x conversion factor. Recalculate revenue and gross margin. State management, base, and downside scenarios separately. Do not present management targets as verified results. Bind payment tranches to measurable operating and cash milestones when transaction terms authorize it.

## Financial coverage

Cover every available period since incorporation, including the latest interim period. Reconcile profit statement, balance sheet, cash flow or bank movements, tax, receivables, and major contracts where sources permit. If a cash-flow statement or bank reconciliation is missing, keep G5 false or conditional; do not hide the gap in a footnote.

## Reader-facing discipline

- Write formal investment-manager prose: fact, mechanism, implication, boundary.
- Use tables for repeated comparable records, not normal prose.
- Keep source IDs, scores, prompts, audit language, and internal reviewer instructions out of the DOCX.
- State material adverse facts and the strongest alternative explanation.
- Do not use generic praise, invented market share, unnamed “industry data”, or unsupported future certainty.
- Copy no Deta company name, person, customer, amount, date, or conclusion from the reference.
- Use information anchors: overview = conclusion; operating chapters = evidence; investment chapter = calculations and terms; risk chapter = adverse transmission and controls; conclusion = executable decision.
- Do not repeat an explanatory sentence or paragraph across chapters. Repeating a material number is allowed only when navigation or decision execution requires it.
- Apply the cluster repetition and language budgets in `editorial-spec.md`.
  A paraphrase that repeats the same technology chain, financial-conflict
  tuple or transaction tuple still counts as repetition.
- Write `1.5 投资价值` as five complete positive chains in the Deta V5 order:
  industry position and paid commercial base; differentiated technical route;
  data/feedback-loop moat; customer or ecosystem commercial validation; team
  capability. Put transaction protection in `7.2`, and put validation
  boundaries in `主要风险` or chapter 8 instead of ending every value item with
  a caveat. The `主要风险` paragraph must first identify the dominant
  commercialization/value-realization risk and then explain how other risk
  factors affect the revenue base, growth value and valuation.
- In the conclusion, use paragraph 3 for one parallel condition sentence and
  one consequence sentence. Do not restate the whole risk table.
