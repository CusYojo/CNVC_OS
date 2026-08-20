# Source Sufficiency and Report Routing

Choose the report type and length from the evidence actually available. Do not expand a thin evidence base into a nominally comprehensive report.

## 唯一模式映射

- `screening_public` → `report_type=screening`；
- `business_dd` → `report_type=business`；
- `financial_dd` → `report_type=financial`；
- `legal_dd` → `report_type=legal`；
- `technical_dd` → `report_type=technical`；
- `pre_ic` → `report_type=pre_ic`；
- `comprehensive_ic` → `report_type=comprehensive`。

`deta_v5_up_to_ic` 只允许用于 `pre_ic` 或 `comprehensive_ic`。不得把公开初筛或专项尽调包装成德塔完整上会结构。

## Routing test

### Comprehensive diligence

Use `comprehensive_ic` only when the P0 and comprehensive fields in [diligence-data-schema.md](diligence-data-schema.md) pass `audit_ic_completeness.py`: current capitalization and financing documents; audited or reconcilable financial records; customer or contract samples tied through delivery, acceptance, invoicing, and cash; material IP and compliance schedules; transaction terms; valuation and return model; and management access.

### Specialized diligence

Use `business`, `financial`, `legal`, or `technical` when the evidence is deep in that workstream but incomplete elsewhere. State the scope once in the front matter. Do not repeat the limitation in every chapter.

### Pre-IC

Use `pre_ic` when its P0 fields pass the field-level completeness gate and the document must synthesize a decision, pricing, structure, conditions and walk-away issues for an investment committee.

### Screening or public-information pre-diligence

Use `screening_public` when inputs are mainly public sources, a financing deck, media coverage, or unverified management statements. Prefer 8–18 substantive pages. Focus on:

- what the company actually appears to be;
- what is independently visible;
- the two or three questions that determine whether the project advances;
- a short, prioritized next-stage diligence list.

Keep the cover title fixed as “尽职调查报告”. Record the mode only in metadata and scope language, and never imply financial, legal, technical, customer or transaction verification that did not occur. `screening_public` may not use the Deta V5 up-to-IC template profile.

## Source sufficiency matrix

Before drafting, score each core area as `primary`, `management_only`, `public_only`, `conflicted`, or `absent`:

1. entity, ownership, and governance;
2. team and employment;
3. product and technical maturity;
4. customers, contracts, delivery, and collection;
5. historical financials and cash;
6. forecast and funding need;
7. IP, data, regulatory, and legal compliance;
8. valuation, terms, and exit.

Run `audit_ic_completeness.py` after scoring. Any unsupported P0 field blocks `pre_ic`/`comprehensive_ic`; do not rely on a broad area score to excuse a missing cap table, financial statement, customer cash bridge or transaction term. Record the route in working papers, not as repeated prose.

## Length discipline

- Let evidence determine length; do not let a mandatory chapter list create filler.
- Combine thin adjacent topics instead of producing a paragraph that only says information is unavailable.
- Put ordinary document requests in one appendix. Keep only thesis-changing gaps in the main body.
- A shorter report with a sharp conclusion is more professional than a long report dominated by caveats.
