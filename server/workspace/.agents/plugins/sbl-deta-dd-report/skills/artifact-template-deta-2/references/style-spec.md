# Deta V5 investment-banking style contract

The named style system below is the typography authority. The retained
`assets/reference.docx` remains authoritative for page geometry, headers,
footers, black-and-white table language, and cover composition.

## Page system

- A4 portrait: 21.001 x 29.7 cm; left 2.2 cm, right 2.0 cm, top 2.0 cm, bottom 1.799 cm.
- Header distance 0.75 cm; footer distance 0.85 cm.
- Use landscape only for genuinely wide finance, forecast, cap-table, or valuation tables.
- Reference landscape pattern A: 29.7 x 21.001 cm; left 1.799 cm, right 2.0 cm, top 2.2 cm, bottom 2.0 cm.
- Reference landscape pattern B: left/right 1.649 cm, top 1.85 cm, bottom 1.649 cm.
- Keep the declaration header and automatic centered page number.

## Named typography

| Style | Purpose | Required parameters |
|---|---|---|
| 投行 - 一级标题 | 1、2、3 等一级章节及投资结论 | 黑体三号（16 pt），加粗，段前 1.5 行，段前分页 |
| 投行 - 二级标题 | 1.1 等二级章节 | 黑体四号（14 pt），加粗，段前 0.8 行 |
| 投行 - 三级标题 | 2.3.1 等三级模块 | 黑体小四（12 pt），加粗，段前 0.5 行 |
| 投行 - 正文标准 | 正文段落及表格正文 | 宋体小四（12 pt），首行缩进 2 字符，固定 20 磅；表格内取消首行缩进 |
| 投行 - 表格表头 | 语义表头或两列表格左侧标签 | 黑体小四（12 pt），加粗，灰底，水平及垂直居中 |
| 投行 - 注释小字 | 备注、说明、测算口径 | 宋体五号（10.5 pt），固定 16 磅 |
| 投行 - 目录标题 | “目录” | 黑体一号（26 pt），加粗居中 |
| 投行 - 封面标题 | 首页报告主标题 | 黑体二号（22 pt），加粗居中 |

- Use Chinese font names in `w:eastAsia`: 黑体 and 宋体. Use SimHei and
  SimSun only for ASCII/HAnsi compatibility.
- Set heading outline levels to 0/1/2 so the automatic TOC remains valid.
- Treat a section break that already starts a page as satisfying the 一级标题
  page-break rule; do not create a blank page.
- Remove every `w:lastRenderedPageBreak` layout-cache marker before applying
  the new heading pagination. It is not an author-entered break and may create
  a pure blank page when retained beside a new `pageBreakBefore`.
- Remove empty spacer paragraphs immediately before a paginated 一级标题 unless
  they contain a section break or object. A spacer that flows after a full-page
  table can otherwise consume one invisible page before the title break.
- Run `python3 "${CLAUDE_SKILL_DIR}/../generate-deta-dd-report/scripts/investment_bank_styles.py" audit` after formatting. Missing
  named styles or incorrectly bound headings/table headers block delivery.

## Automatic directory

- Every formal report must place a Microsoft Word native automatic directory
  after the cover and before the first first-level chapter. A manual list of
  headings and page numbers is not an acceptable substitute.
- Use exactly one `TOC \\o "1-3" \\h \\z \\u` field. The field must cover all
  paragraphs bound to `投行 - 一级标题`, `投行 - 二级标题` and
  `投行 - 三级标题`; `\\h` must remain enabled so every entry is clickable.
- Bind the visible “目录” paragraph to `投行 - 目录标题`. Keep every heading's
  outline level at 0/1/2 so Word can rebuild the directory after later edits.
- Set `w:updateFields` to true. During final Microsoft Word verification,
  update all fields, update the table of contents, save the refreshed DOCX,
  and then export PDF. The delivered DOCX must contain refreshed cached entries
  and page numbers, not only a dirty field waiting for the recipient to update.
- The strict audit must compare the number of level-1/2/3 headings with cached
  TOC entries and hyperlinks. Missing, empty, static, stale, non-clickable or
  incomplete directories and any “未找到目录项” Word error block release.
- `--allow-unupdated-toc` is permitted only for the pre-Word structural audit.
  Never use it for final delivery approval.

## Tables

- Use one shared `Table Grid` base style for every formal table. Center the
  table between page margins and use 0.5 pt black single borders for all outer
  and inner rules.
- Use one of exactly two carriers. A key-value table has no header row: shade
  every first-column label `F2F2F2` and leave every value cell unshaded. A data
  table shades the complete first row `D9D9D9`, leaves all body cells
  unshaded, repeats that first row across pages, and never shades the first
  body column merely because the table has two columns.
- The fixed two-column data-table headers are `事项｜核验结果`, `场景｜解决问题`,
  `事项｜截至报告日情况`, `主要成本项｜金额/合同`, and `退出路径｜实现条件`.
  All other two-column overview/basic/legal tables are key-value tables.
- Use table cell margins `top 0 / left 108 / bottom 0 / right 108` DXA, center
  text vertically, prohibit row splitting, and never set a fixed row height.
- Use 12 pt Songti body text with exact 20 pt line spacing. Use the named
  `投行 - 表格表头` style for every shaded cell and `投行 - 正文标准` for
  every body cell, with first-line indent cancelled inside tables.
- Do not use standalone captions immediately above tables in the formal report.
  Carry the context in the section heading, table header, or necessary prose,
  and remove any centered bold caption paragraph before visual QA.
- Center label cells, header rows, first-column row labels, dates, numbers and
  short status fields. Left-align narrative or multi-line body cells. Do not
  justify table body text.
- For the risk register, allocate the most width to value transmission and control/consequence fields. Keep priority and short monitoring thresholds compact; use landscape when five columns cannot remain legible at 12 pt.
- Keep P0/P1/P2/P3 inside the internal risk register.  The formal risk table
  uses plain Chinese category names ordered by importance.
- Never shrink dense text below the reference scale to force a table onto one page; revise content or use a documented landscape pattern.
- Run `python3 "${CLAUDE_SKILL_DIR}/../generate-deta-dd-report/scripts/investment_bank_styles.py" audit` after formatting. Mixed table
  carriers, wrong gray fills, nonuniform borders or margins, fixed row heights,
  missing repeat headers, or incorrectly bound table-cell styles block delivery.

## Content density

- Keep company identity overview to decision-useful facts; do not add generic
  development-stage or core-judgment rows when they do not improve the decision.
- Use five decision-bearing value items; keep validation boundaries in the separate risk paragraph rather than interrupting each positive chain.
- Keep the conclusion to exactly three paragraphs and avoid introducing new facts there.
- If a table cell becomes a mini-essay, compress it to decision-bearing phrases and move supporting analysis to the anchored operating chapter.

## Visual gates

Inspect every page at 100% zoom. Fail on missing Chinese glyphs, clipping, overlap, unexpected blank pages, orphan headings, broken/overwide tables, a missing/manual/empty/stale/non-clickable/incomplete TOC, wrong page numbers, missing header, leftover sample facts, or stray cover text.

LibreOffice may substitute Chinese fonts. That is an engine limitation, not
permission to change the required Word font. Use Microsoft Word native
rendering for final fidelity validation on macOS.
