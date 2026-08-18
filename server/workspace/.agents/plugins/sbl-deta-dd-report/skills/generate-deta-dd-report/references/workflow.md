# Deta-style due-diligence workflow

## Stage gates

| Gate | Artifact | Pass condition | Correction target |
|---|---|---|---|
| G0 identity | `workflow_state.json` | target, investor, cutoff date, currency, round, output type are locked | complete or mark a provisional scope |
| G1 sources | `source_manifest.json`, `packets/` | every decision-critical file is parsed, versioned, hashed, and dated | OCR, repair, deduplicate, or obtain replacement |
| G2 facts | `facts.json` | material facts have entity, period, unit, scope, source, status | lower confidence, add RFI, or bind better evidence |
| G3 conflicts | `rulings.json` | conflicting ownership, financial, customer, valuation, and term facts are ruled or expressly open | apply source hierarchy and effective-date logic |
| G4 analysis | decision ledgers | technology, IP, customer stages, commercial mechanism, finance, transaction, and downside chains are complete | remove promotional claims; close causal breaks |
| G5 decision contract | `report.json` | structured decision, three-layer value logic, risk register, conditions and termination boundary are source-backed | repair decision logic before prose |
| G6 report | `report.json` | all 9 first-level, 28 second-level and 20-22 third-level headings match `structure-spec.md`; `2.4` retains 4-5 source-backed core members when available and orders core decision-makers first; five overview field lists match; conclusions are source-backed; internal work traces and exact repeated passages are absent | restore exact headings/fields, recover omitted fourth/fifth core members, reorder by investment relevance, then rewrite only affected content |
| G7 deterministic QA | `qc_report.json` | structure, arithmetic, evidence, contamination, decision contract, and must-cover checks pass | repair facts/models, not just wording |
| G8 red team | `red_team.json`, `revision_log.json` | default “do not invest” challenge is answered; all P0/P1 issues are closed or block release | change price, amount, staging, conditions, or conclusion |
| G9 score | `quality_scorecard.json` | score >= 85 and every hard gate is true | correct the lowest valid dimension first |
| G10 editorial | DOCX editorial audit | each material fact cluster has one full anchor; repetition and defensive-language budgets pass; `1.5` follows industry/base → technical differentiation → data moat → commercial validation → team, each value item completes fact–mechanism–implication, transaction protection stays in `7.2`, and the risk paragraph states one master commercialization risk plus transmission; numbered items use separate Word paragraphs; no `详见/参见/见章节` shortcut remains; conclusion stays three compressed paragraphs | rebuild the value sequence, run semantic compression, write the local conclusion directly, and relocate rather than delete material caveats |
| G11 structure/style | DOCX structure and style audits | `deta_structure_contract.py` passes; all eight `投行 - *` styles exist with correct bindings; one native `TOC \\o "1-3" \\h \\z \\u` field exists after the cover | restore exact labels/ordering/styles and rebuild the native automatic directory |
| G12 visual | refreshed DOCX/PDF/all-page PNGs | Microsoft Word has updated and saved all fields; TOC entry/link count covers every level-1/2/3 heading; page numbers and clicks work; no clipping, overlap, blank anomalies, missing glyphs, broken tables, or sample residue | refresh fields in Word, repair heading outline levels or TOC field, save, and rerender |

## Correction order

1. Evidence closure: repair P0/P1 ownership, finance, customer, IP/data, policy, and transaction gaps.
2. Decision logic: align value, downside, price, ownership, payment, conditions, and termination boundary.
3. Reader structure: build the anchor map, remove semantic as well as exact repetition, and use tables only for comparable records.
4. Value and tone: complete positive fact–mechanism–implication chains, relocate repeated caveats, and compress the conclusion.
5. Reader flow: put every numbered item in its own Word paragraph and replace cross-reference shortcuts with the shortest locally necessary fact or conclusion.
6. Layout: normalize the template and rerender.

Do not reverse this order to improve first impressions while decision-critical evidence remains open.

## Evidence hierarchy

Use this default order, adjusted for the question being decided:

1. signed and effective legal/transaction documents;
2. regulator, registry, tax, bank, and audited records;
3. accepted contract, invoice, collection, and delivery chain;
4. company system exports and contemporaneous operating records;
5. meeting minutes and attributable interviews;
6. business plans, presentations, forecasts, and oral claims;
7. public secondary sources.

Later is not automatically better. Prefer the source with the correct legal entity, effective date, accounting period, scope, and definition. Preserve unresolved conflicts.

## Review roles

- Fact controller: identity, source traceability, conflict rulings, and sample-contamination check.
- Business reviewer: product, customer stage, delivery, pricing, repeat purchase, supplier, and unit economics.
- Finance reviewer: statements, cash/bank reconciliation, forecast drivers, valuation, dilution, and returns.
- Legal/IP reviewer: ownership, related parties, licenses, code/data/IP chain, policy obligations, and conditions precedent.
- Red team: strongest contrary case, falsification indicators, downside loss, and transaction protection.
- Layout reviewer: named-style audit, template fidelity, fonts, sizes, tables,
  pagination, native automatic TOC existence, level-1/2/3 coverage, clickable
  links, refreshed page numbers, headers, footers, and all-page visual QA.
- Editorial reviewer: anchor ownership, semantic-cluster repetition, defensive
  phrase density, value-chain completeness and conclusion compression.

One agent may perform several roles, but each role must produce a distinct check result. Never let the same unsupported assertion validate itself.

## Priority and release logic

- P0: may change invest/do-not-invest, legality, price, ownership, return, or loss. Must close or block.
- P1: materially changes a thesis, forecast, customer validation, or major risk. Must close or be an explicit condition.
- P2: structure, traceability, or visible layout defect. Must close before clean delivery.
- P3: wording and minor polish. Fix after higher priorities.

`release_ready = all(hard_gates) and score >= 85 and open_P0 == 0 and open_P1 == 0 and open_P2 == 0 and visual_pass`.

## Current-model responsibility

The processor is deterministic. The current Claude Code model performs semantic extraction, conflict judgment, causal analysis, red-team review, drafting, and targeted revision. Do not call an external model gateway. The processor locks sources, checks schemas and arithmetic, normalizes the DOCX, and renders evidence for human/visual review.
