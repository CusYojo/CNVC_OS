# Q&A Report Format Guidelines

## Contents

1. Page and typography
2. Paragraph hierarchy
3. Page types
4. Tables and figures
5. Markdown rules
6. Word generation and verification
7. Final checks

## Page and typography

### `qa_cn_formal_a4` Word profile

Use the `standard_business_brief` document preset with the named override
`qa_cn_formal_a4`. The override below is the controlling profile for this Skill.
Treat every value as required, not approximate, and encode it in Word styles and
OOXML rather than relying on Word defaults.

| Setting | Required value |
|---|---:|
| Page | A4 portrait |
| Top margin | 27 mm |
| Bottom margin | 28 mm |
| Left margin | 31.8 mm |
| Right margin | 30 mm |
| Header distance | 14-16 mm |
| Footer distance | 15-17 mm |
| Columns | one |
| Body alignment | justified |
| Chinese punctuation | full-width |
| Latin letters and numbers | half-width |

Recommended formal style:

| Element | Chinese | Latin/numbers | Size | Style |
|---|---|---|---:|---|
| Main title | 宋体 | Times New Roman | 20 pt | bold, centered |
| Q heading | 黑体 or 宋体 | Arial/TNR | 14 pt | bold |
| Subheading | 黑体 or 宋体 | Arial/TNR | 11 pt | bold |
| Body | 仿宋 or 宋体 | Times New Roman | 10.5-11 pt | justified |
| Table body | 宋体 | Times New Roman | 9-10 pt | regular |
| Figure/table title | 宋体 | Times New Roman | 10.5 pt | bold, centered |
| Source/note | 宋体 | Times New Roman | 8.5-9 pt | gray |
| Header/footer | 宋体 | Times New Roman | 9 pt | centered |

Use no more than two Chinese typefaces. Avoid full-document KaiTi and body text below 10 pt.

The bundled Word builder maps `w:eastAsia` to `STFangsong` for regular Chinese
and `STHeiti` for bold Chinese, while mapping `w:ascii` and `w:hAnsi` to Times
New Roman. These PostScript names are used so that Word, WPS and the local
LibreOffice visual-QA renderer resolve the installed Chinese fonts consistently.
Do not fall back to a single CJK font for all Latin text.

## Paragraph hierarchy

Use one numbering system:

```text
Q1：核心问题
（1）论证维度
① 具体分点
- 证据或说明
```

Recommended spacing:

| Element | Line spacing | Before | After | Indent |
|---|---|---:|---:|---|
| Main title | fixed 24 pt | 0 | 18 pt | left 0, right 0, first line 0 |
| Q heading | fixed 21 pt | 12 pt | 6 pt | left 0, right 0, first line 0 |
| Subheading | fixed 18 pt | 8 pt | 4 pt | left 0, right 0, first line 0 |
| Body | fixed 20 pt | 0 | 0 | left 0, right 0, first line 2 Chinese characters |
| Bullet/numbered item | fixed 18 pt | 0 | 0 | left 27 pt, hanging 13.5 pt, right 0 |
| Table title | fixed 16 pt | 8 pt | 4 pt | left 0, right 0, first line 0 |
| Table body | fixed 14 pt | 0 | 0 | left 0, right 0, first line 0 |

Use 16-18 pt body line spacing only for an explicitly requested high-density internal memo.

The default renderer must use the evidence-oriented formal density: 10.5 pt body text with fixed 20 pt leading, 14 pt Q headings with fixed 21 pt leading, 11 pt subheadings with fixed 18 pt leading, 10.5 pt bullets with fixed 18 pt leading, and 9 pt table text with fixed 14 pt leading.

## Page types

### Direct-Q&A opening

Use one project Q&A title in the exact pattern `项目名称Q&A 报告`, then start Q1 immediately. Do not insert `标准版`, `内部`, `内部版`, a version number, a date, an audience label, or a confidentiality qualifier into the title unless the user explicitly requests that wording. Do not add version/date metadata, confidentiality blocks, an execution summary, a question list, or decorative hero images unless the user requests them.

### Standard Q&A page

Keep the reading sequence:

```text
Question
→ reasoning
→ evidence/table
→ boundary
→ decision implication
```

Avoid leaving a question heading alone at a page bottom.
Do not insert a standalone `结论：` paragraph, bold conclusion label, conclusion
callout, or conclusion box. Begin the answer directly with analysis.

### Evidence page

Use one primary reading task per page: market sizing, product matrix, competitor comparison, customer pipeline, cash collection, or timeline.

### Final Q&A

Use the last question to synthesize the core judgment, evidence, risk, verification conditions, and next action. Do not add a separate conclusion page unless requested.

## Headers, footers, and watermark

- Header: `项目名称｜Q&A`, 9 pt, optional 0.5 pt gray rule. Do not add a version number by default.
- Footer: page number only, aligned right.
- Do not place `内部`, `内部资料`, `仅供内部使用`, or equivalent confidentiality labels in headers or footers unless the user explicitly requests them.
- Place the header 14-16 mm from the top edge and the footer 15-17 mm from the bottom edge.
- Internal watermark is optional; omit it when it reduces readability.
- Hide the header on the opening page if desired, but keep page numbering consistent.

## Tables

- Use a blue-gray or 10%-15% gray header.
- Use 0.5 pt borders.
- Align text left, short labels center, numbers right.
- Repeat headers across pages.
- Do not split one record across pages when avoidable.
- Distinguish actual, budget, forecast, and intention.

Standard formats:

| Type | Format |
|---|---|
| Amount | `1,250 万元`, `2.3 亿元` |
| Percent | `32.7%` |
| Date | `2026-07-28` |
| Quarter | `2026Q3` |
| Missing | `-` |
| Forecast | add `E` or `预计` |

Use defined pipeline states: lead, requirement confirmed, Demo/POC, sample/test, bidding, signed contract/order, delivered, accepted, revenue recognized, collected, repurchased.

## Figures and images

- Use diagrams only for a relationship, process, comparison, or timeline.
- Keep flow diagrams under seven nodes and three colors.
- Build product matrices by product, scenario, and commercial stage.
- Recreate charts from lawful public data when reuse permission is unclear; record the data provenance in the internal evidence ledger.
- Do not use screenshots where an editable table is possible.
- Anonymize customer, contract, dashboard, and personal information.

## Markdown rules

- Use headings, lists, tables, and blockquotes semantically.
- Do not use spaces for visual indentation or blank lines for pagination.
- Encode paragraph indentation explicitly: body paragraphs use a two-Chinese-character first-line indent; titles, headings, captions, notes, and table-cell paragraphs use zero first-line, left, and right indents; list wrapping uses real Word numbering with a 27 pt left indent and 13.5 pt hanging indent.
- Do not include source lists, source notes, citation labels, Markdown links, raw URLs, or clickable external hyperlinks in the standard report.
- Keep source provenance in the internal evidence ledger; create a separate cited edition or source register only when the user explicitly requests it.
- Do not embed text-heavy images.

## Word generation and verification

- Use [../scripts/render_qa_docx.py](../scripts/render_qa_docx.py) for the standard A4 DOCX.
- Preserve the direct-Q&A structure; do not create a cover page, metadata page, contents page, execution summary, source appendix, or standalone conclusion unless explicitly requested.
- Ensure the standard DOCX contains no external hyperlink relationships and no visible URL text.
- Encode Chinese and Latin font mappings explicitly in the DOCX. Never deliver a document containing missing-glyph boxes.
- Prevent Q headings from being stranded at the bottom of a page.
- Repeat table headers across pages and keep body text readable at normal zoom.
- Reopen the DOCX with `python-docx` and ZIP/XML inspection; confirm every `Qn` heading, table, style, numbering definition, and page-number field is present, and confirm there are zero external hyperlinks.
- Use the canonical `render_docx.py` from the `documents` Skill to render every page to PNG; visually inspect every page at 100% zoom before delivery.
- Treat any PDF created by the DOCX renderer as a temporary QA intermediate. Do not deliver it unless the user explicitly requests PDF output.

## Final checks

- Ensure fonts and heading levels are consistent.
- Number questions, figures, tables, and appendices continuously.
- Give every table and chart a title, unit, and relevant date; keep its source mapping in the internal evidence ledger.
- Distinguish actual and forecast values visually and verbally.
- Omit version, date, and front-page confidentiality metadata by default.
- Include page numbering only in the default DOCX footer; omit internal-use or confidentiality wording.
- Remove internal comments and verify anonymization.
