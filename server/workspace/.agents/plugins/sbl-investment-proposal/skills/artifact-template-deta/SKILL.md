---
name: artifact-template-deta
description: "使用批准的 Deta V7 Word 模板生成、润色或扩充正式中文投资提案。适用于根据项目 ZIP、目录、BP、财务表、会议纪要和交易材料生成投资提案，以及润色、优化已有投资提案；强制模板克隆、模板指纹校验、财务原文锁定、客观事实门禁和逐页视觉验收。"
---

# Deta 正式投资提案

Generate or polish a formal Chinese investment proposal. Treat the retained DOCX as the visual authority and the user's sources as the sole factual authority.

## Required resources

1. Read `artifact-template.json` and resolve its files relative to this directory.
2. Read `references/polishing-constraints.md`, `references/section-expansion-framework.md` and `references/visual-style-spec.md` in full.
3. Resolve the plugin root from `${CLAUDE_PLUGIN_ROOT}` when available; otherwise use the directory two levels above this `SKILL.md`. Read `<plugin-root>/assets/WORKFLOW.md` and run `<plugin-root>/scripts/deta_ic_processor.py --help` before execution.
4. Use the bundled Python controller for extraction, audit, template-cloned DOCX rendering and Word/LibreOffice verification. Do not call host-specific document plugins.
5. Resolve the approved template as `<plugin-root>/assets/德塔式精简工商字段投资提案_固定模板V7.docx`. Never substitute a blank document or an unapproved DOCX.

## Workflow

1. Lock `investment_entity_full_name`, `investment_entity_short_name`, `target_entity_full_name` and forbidden old investor names before drafting. Apply the binding to title, introduction, transaction terms, conclusion and signature.
2. Inventory sources and build a private fact ledger and conflict rulings. Use only confirmed facts in the formal proposal; never expose working papers or evidence inventories.
3. Expand sections through supported dimensions using `总体定义—构成拆解—实现方式—量化信息—当前状态`. Keep unsupported sections concise.
4. Keep the financial section cell-for-cell unchanged from its authoritative source. Do not recalculate, restyle values, add notes or include a cash-flow summary or return calculation.
5. Build the forecast by business with revenue, sales quantity and unit, average price, average cost and gross margin for five years. Place the table directly after the new-page forecast heading.
6. Apply `references/visual-style-spec.md`. Force the income statement and five-year revenue forecast to the identical type scale: header `黑体 9.5 pt`, body `宋体 9 pt`. Reject or override smaller per-project forecast font settings.
7. Render with Microsoft Word when available and inspect every page. Correct clipping, overflow, broken tables, orphan headings, abnormal blank pages and signature/date separation before release.

## Bundled Agent

- Start an archive run with `python <plugin-root>/scripts/deta_ic_processor.py init --input <project.zip> --reference <reference.pdf>`.
- Let the current Claude model populate the staged JSON artifacts according to `<plugin-root>/assets/WORKFLOW.md`; the controller never calls an external model gateway.
- Run `audit`, then `render --template <plugin-root>/assets/德塔式精简工商字段投资提案_固定模板V7.docx`, then `verify`. Never release a document that fails a hard gate or has not been inspected page by page.
- Require the render manifest to contain `template_enforced: true`, `renderer_mode: clone-approved-docx` and the approved SHA-256 `849a6e1ec86c9576f52332ffbf8dc048dea5d929daa438810f701c4e2116da15`.
- Stop immediately if the approved template is missing, its fingerprint differs, or the renderer attempts `Document()` without cloning the template.

## Content gates

- Use formal, concise professional Chinese and only confirmed facts, figures, forecasts and conclusions supplied by the user or authoritative source.
- Omit the unified social credit code and any 18-character credit code from `公司简介`, even when the source contains it; retain other supported corporate-registration facts.
- Do not add subjective evaluation, success factors, dependency analysis, industry comparisons or outlooks outside the authorized decision conclusion.
- Do not use source labels such as `项目组`, `专项核查`, `管理层列示`, `不同材料` or `投资团队`; `项目组认为` is permitted only as the decision subject in `六、结论`.
- Keep contracts, bank statements, ownership schedules and other evidence lists out of the final proposal.
- Write risk control as three to five concise `风险—应对措施：` paragraphs using only existing company measures or confirmed transaction arrangements.
- In recommendation mode, write one supported conclusion paragraph beginning with `综合考虑` and ending with implementation of the main plan under adequate risk control. Omit unsupported dimensions.

## Locked financial and forecast rules

- Balance sheet columns: `资产｜期末余额｜负债和所有者权益｜期末余额`.
- Income statement columns: `项目｜本年累计金额｜本期金额`.
- Forecast title: `营 业 收 ⼊ 五 年 预 测`; first header: `营业收入（税前）构成`.
- Each business includes revenue, `销售数量（计量单位）`, `平均单价（元）`, `平均成本（元）` and `毛利率`.
- The income statement and forecast table use the same fonts and sizes: header `黑体 9.5 pt` bold with light gray fill; body `宋体 9 pt`. Never shrink the forecast table below these sizes to keep it on one page.
- Do not place explanatory prose below the financial or forecast tables.

## Locked visual specification

- Page: 16.2 × 21.0 cm; margins top/bottom 1.5 cm and left/right 1.8 cm.
- Main title: 黑体 17 pt, bold, centered; Heading 1: 黑体 14 pt; Heading 2: 黑体 12 pt.
- Body: 宋体 10.5 pt, two-character first-line indent, 1.4 line spacing and 3.5 pt after.
- Table-cell paragraphs have no first-line indent. Keep all tables within the 7140 DXA text width and keep signature and date on the same page.

Return only the clean formal proposal unless the user separately requests internal artifacts.
