# Quality Gates

## Contents

1. Content gate
2. Narrative gate
3. Quantitative gate
4. Decision gate
5. DOCX gate
6. Page-by-page visual gate
7. Final handoff

## 1. Content gate

- Correct legal entity, project, date, version, report type, currency, and confidentiality.
- No old-project names, logos, people, figures, sources, or template residue.
- No blank required headings, `TODO`, bracket placeholders, or empty conclusion tables.
- Every material factual assertion has an evidence ID or an explicit unverified label.
- Company claims, public facts, analyst estimates, judgments, and forecasts are visually and verbally distinct.
- Specialized legal, financial, technical, and customer findings appear in the integrated conclusion.
- Absolute or promotional language is removed or precisely scoped and evidenced.
- Evidence audit has zero errors. Every warning is either resolved or carried explicitly as a claim, conflict, or gap that does not support the recommendation or valuation.
- `diligence-data.json` exists and `audit_ic_completeness.py` has zero errors and zero warnings.
- Every P0 field for the selected mode is supported at the required source grade; no P0 field is deleted or replaced by an analytical framework.
- Every IC table has a recognized `semantic_role` and binds the relevant `data_field_ids`.

## 2. Narrative gate

- The report opens with the company's business essence, verified engine, investment wager, decisive uncertainties, and recommendation.
- Every level-one chapter begins with a conclusion rather than source or process language.
- Evidence IDs and status mechanics remain backstage; reader-facing limitations are precise, grouped, and decision-relevant.
- Routine document requests appear once in the diligence-gap appendix, not repeatedly in operating chapters.
- No main-body heading, table title, column or row describes analyst work such as “核查框架、验证框架、核查重点、底稿要求、资料清单、尽调工作流” or any completion standard.
- No substantive paragraph could be transferred unchanged to another company.
- No duplicated paragraphs, formulaic enumeration, repeated “公开资料/无法确认/需核验” constructions, generic praise, or unsupported precision remains.
- No search-status, missing-file or placeholder language remains, including “本报告基于公开资料编制、未获取、未披露、未公开、待定、公开信息未显示、产品—市场匹配尚未确立、建议补充数据后再评估报价、后续尽调需厘清”.
- No process conclusion or framework substitute remains, including“尚不足以直接推导”“进入第二阶段专项尽调”“条件满足前不锁定股权价格”“值得继续跟进”“建议的经营里程碑”“建议的估值处理”“经营质量评价框架”。
- Public-source-led reports pass `audit_public_research.py` with all eight areas, required field IDs, at least two distinct queries per area, atomic source claims and at least three primary or authoritative adopted sources.
- Paragraphs use natural sentence-length variation, one main idea, and a clear investment implication.
- Run `audit_narrative_quality.py report.json --strict` with zero errors and zero warnings.

## 3. Quantitative gate

- Units, periods, currencies, tax basis, gross/net, and consolidated/standalone scope are explicit.
- Totals, subtotals, percentages, and growth rates recalculate.
- Contract, delivery, acceptance, revenue, invoice, and cash schedules reconcile or the gap is explained.
- Historical actuals, management budget, and analyst forecasts are separated.
- Forecast drivers tie to customer, volume, price, capacity, adoption, milestone, cost, and cash assumptions.
- Downside/base/upside cases are internally consistent.
- Valuation comparables are normalized and outliers are explained.
- Dilution, preference stack, timing, MOIC, and IRR are modeled when relevant.

## 4. Decision gate

- Recommendation is invest, conditional invest, defer, or decline.
- Investment amount, valuation, structure, and ownership are stated when evidenced; otherwise the report states the present action—whether to quote, which valuation basis is permitted, and which condition opens price or term negotiations—without file-status language.
- Thesis points cite evidence and state remaining uncertainty.
- Material risks include probability, impact, trigger, control, and residual risk.
- Conditions precedent, post-closing covenants, responsible party, deadline, evidence, and remedy are actionable.
- Walk-away issues and diligence gaps that could reverse the decision are visible.

## 5. DOCX gate

- Run `audit_docx_style.py` with zero errors and zero warnings.
- Update TOC/page fields in Word when available.
- All visible paragraphs use the intended named style; body, headings, lists, captions, callouts, and table cells do not drift to default formatting.
- Body fonts, sizes, 1.5 line spacing, first-line indent, paragraph spacing, justification, and heading keep-with-next behavior match the retained specification.
- Table rows do not split across pages, header rows repeat, and fixed column widths remain inside the text measure.
- Six-column financial, cap-table and scenario schedules use a linked landscape section and return to portrait immediately afterward; page numbering must continue across the transition.

## 6. Page-by-page visual gate

- Render the latest DOCX with Microsoft Word when available and inspect every page at 100% zoom. A contact sheet may orient the review but cannot replace individual-page inspection.
- Check cover, every TOC page, every body page, every table and figure, all page transitions, and the final page.
- Confirm consistent font appearance,字号, line spacing, first-line indents, paragraph rhythm, heading hierarchy, table geometry, confidentiality header, footer number, and white-space balance.
- Reject ordinary body pages with less than roughly 25% effective content unless they are intentional chapter endings or required to keep a table row intact. Reflow consecutive sparse pages.
- Reject missing Chinese glyphs, overlap, clipping, table boundary hugging, split rows or captions, distorted images, awkward gaps, isolated headings, widows/orphans, or incorrect page numbers.
- Re-run the complete DOCX and visual gates after any change. Verify the final artifact, not an earlier render.
- Keep an internal QA note with renderer, page count, pages reviewed, defects found, fixes made, and final pass confirmation.

## 7. Final handoff

- Deliver the requested DOCX only unless the user requests evidence files or intermediates.
- State unresolved material gaps and any visual-render limitation.
- Never claim a fact was independently verified when only company material was reviewed.
