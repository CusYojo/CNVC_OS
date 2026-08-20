# IC decision and reader contract

Use this contract in `report.json` before drafting reader-facing prose. These fields are internal production controls; do not print field names, fact IDs, scores, or reviewer instructions in the DOCX.

## Structured decision object

```json
{
  "decision": {
    "recommendation": "invest|conditional_invest|do_not_invest",
    "core_judgment": "one or two sentences",
    "rationale_fact_ids": ["F-001"],
    "transaction": {
      "amount": "number and unit or expressly open",
      "valuation": "pre/post/secondary basis or expressly open",
      "fully_diluted_ownership": "percentage or expressly open",
      "payment": "tranches and objective release conditions"
    },
    "conditions_precedent": [
      {
        "id": "CP-001",
        "priority": "P0|P1",
        "condition": "objective completion test",
        "fact_ids": ["F-001"],
        "action_if_unmet": "suspend|reprice|remedy|terminate"
      }
    ],
    "termination_boundary": "facts or failures that stop the transaction"
  }
}
```

The conclusion must be exactly three reader-facing paragraphs:

1. recommendation, verified basis, unverified growth driver, and why the recommendation follows;
2. amount, valuation basis, fully diluted ownership, payment tranches, and measurable release conditions;
3. conditions precedent and the suspension, repricing, remedy, or termination consequence if unmet.

Do not replace a measurable threshold with “与经营情况挂钩”. Do not write a contractual consequence more strongly than the proposed or authorized transaction terms.

## Three-layer value logic

Store at least one item for each layer, or mark a layer `not_applicable` with a reason:

```json
{
  "value_logic": [
    {
      "layer": "verified_base|growth_option|transaction_protection",
      "claim": "investment claim",
      "fact_ids": ["F-001"],
      "mechanism": "how the fact creates value",
      "investment_implication": "effect on thesis, price, or ownership",
      "validation_boundary": "what remains unverified or would falsify the claim",
      "status": "supported|partially_supported|not_applicable"
    }
  ]
}
```

Use “base value” only for verified operations, assets, rights, or results. Treat management forecasts, demand expressions, early tests, and first deliveries as growth options until contract, acceptance, collection, and repeatability support a stronger status. Transaction protection reduces loss exposure; it does not turn an unsupported thesis into operating value.

The three layers are internal decision controls, not the reader-facing order
of `1.5`. Render `1.5` in five company-value themes: industry position and paid
commercial base; differentiated technical route; data/feedback-loop moat;
customer or ecosystem commercial validation; team capability. Render
transaction protection in `7.2 公司估值与投资方式` and, when needed, summarize
it briefly in `7.1` or conclusion paragraph 2. Never replace the team item with
old-share discount, staged payment or governance protection.

## Risk register

```json
{
  "risk_register": [
    {
      "id": "R-001",
      "priority": "P0|P1|P2|P3",
      "category": "risk name",
      "description": "specific adverse state",
      "value_transmission": "how it changes legality, revenue, cash, valuation, return, or loss",
      "monitoring_trigger": "metric, document, event, threshold, and period",
      "pre_control": "control required before investment/payment",
      "action_if_unmet": "suspend, reprice, remedy, compensate, or terminate",
      "fact_ids": ["F-001"]
    }
  ]
}
```

Keep all fields in the internal risk register. For the reader-facing Deta V5
report, render the exact three-column header
`风险类别｜具体风险描述｜风险控制建议`: order risks by internal priority,
but do not print P0/P1/P2/P3 codes. Include value transmission in the
description cell and consolidate monitoring trigger, pre-control and action if
unmet in the control-advice cell using normal reader-facing language.

- P0 changes legality, ownership, invest/do-not-invest, or a loss boundary.
- P1 materially changes the thesis, forecast, customer validation, delivery legality, or a payment tranche.
- Data rights/compliance remains P1 when a defect can block delivery or create liability.
- Manufacturing yield becomes P1 only when it materially supports valuation, forecast, or payment; otherwise keep it P2 and monitor it.

## Information anchors and repetition budget

- Investment overview: state the decision and its controlling facts once; do not reproduce the analysis.
- Company/product/business/finance chapters: hold the detailed evidence and limitations.
- Investment chapter: hold valuation calculations, ownership, payment, protection, and return scenarios.
- Risk chapter: hold adverse transmission, triggers, controls, and consequences.
- Conclusion: restate only the facts necessary to execute the decision.

Repeat a material number when navigation or decision execution requires it, but do not repeat the same explanatory sentence or paragraph. Consolidate definitions and calculations in one anchor location and use a short reference elsewhere.

Create an internal `anchor_map` before drafting. At minimum it must contain
`technology_chain`, `historical_finance_conflict`, `transaction_tuple`, and
`risk_controls`, with `full_anchor`, `allowed_summary_locations`, and
`forbidden_full_repeats`. Apply the quantitative budgets in
`editorial-spec.md`; semantic paraphrases count as repeats.

Reader-facing value items must lead with the supported fact, explain the value
mechanism, and end with the investment implication. Store validation boundaries
in the structured object, but consolidate recurring caveats in the overview
risk row and chapter 8 instead of appending them to every value item.

The reader-facing overview risk must be a thesis-level paragraph, not an
inventory. Start with the single dominant commercialization or value-realization
risk, then state how the most material supporting factors transmit into the
verified revenue base, growth option and valuation. Detailed triggers, controls
and consequences remain in chapter 8.

## Language calibration

- Confirmed fact: “已/为/截至”.
- Supported implication: “表明/说明/支持”.
- Bounded upside: “有望/具备潜力/在……条件下”.
- Unresolved risk: “可能/尚未/仍需验证”.
- Required control: “应/需/不得/暂停/终止”.

Do not soften conditions precedent with promotional language. Do not use absolute words in analytical prose unless the evidence or legal term is absolute.

Do not let caution become the dominant reader experience. Use no more than one
uncertainty qualifier in `1.1 核心判断`, none in the `1.5 投资价值` cell, and
two brief boundary cues across `7.1 投资亮点`. Concentrate mandatory controls
in chapter 8 and paragraph 3 of the conclusion.
