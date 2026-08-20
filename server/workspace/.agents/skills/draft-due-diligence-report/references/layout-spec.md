# Deta V5-Style DOCX Layout Specification

Use [deta-v5-template-contract.md](deta-v5-template-contract.md) as the visual and structural source of truth. The points below are the implementation checklist.

## Page system

- A4 portrait, 21.0 × 29.7 cm.
- Margins: left 2.20 cm, right 2.00 cm, top 2.00 cm, bottom 1.80 cm.
- Header distance 0.75 cm; footer distance 0.85 cm.
- Cover, TOC and body are separate sections with continuous page numbering from the cover.
- Header is centered 9 pt FangSong_GB2312 confidentiality text. Footer is a centered 9 pt page number.
- Use landscape sections only for wide financial, capitalization, customer or scenario schedules.

## Cover and front matter

- Company/legal entity and report title: separate centered lines, SimHei 22 pt bold.
- Author/institution and date: centered FangSong_GB2312 14 pt in the lower third.
- TOC: centered 18 pt SimHei title, Word-native field, dot leaders and page references. Default to two levels; include level 3 only when it does not create a sparse trailing TOC page.
- Glossary follows the TOC when the report uses product, financial or regulatory shorthand.

## Typography

- Body: FangSong_GB2312 12 pt, justified, 1.5 spacing, first-line indent 0.847 cm, 0 pt before/after.
- Level 1: SimHei 15 pt bold, 1.25 spacing, 12 pt before/6 pt after, keep with next, page break before.
- Level 2: SimHei 15 pt bold, 1.25 spacing, 8 pt before/4 pt after, keep with next.
- Level 3: SimHei 12 pt bold, 1.25 spacing, 6 pt before/2 pt after, keep with next.
- Level 4: SimHei 12 pt bold, 1.25 spacing, 4 pt before/2 pt after, keep with next.
- Table title/body: FangSong_GB2312 12 pt; title and header bold.
- Captions: FangSong_GB2312 10.5 pt centered.
- All text is black. Do not add decorative color unless the user requests a different visual identity.

## Tables and figures

- Portrait text measure: 16.80 cm / 9524 DXA. Use fixed table grids and content-based column ratios.
- Standard table headers use `#D9D9D9`; overview key labels use `#F2F2F2`.
- Borders are black 0.5 pt single lines; cell padding is about 0.19 cm horizontally and 0.13 cm vertically.
- Repeat standard table header rows; apply `cantSplit` to every logical row.
- Center short labels, dates and compact numbers; left-align narrative cells unless the Deta overview pattern calls for centered values.
- Keep titles/captions with the object. Do not reduce font size to force a table onto one page.

## Structural normalization

- Use named styles, outline levels, true TOC and PAGE fields, deterministic Arabic hierarchy numbering, fixed table grids and non-floating objects.
- Remove reference-company facts, logos, comments, custom XML and metadata from the sanitized template.
- Preserve the reference's visible system while repairing direct-format drift, broken heading semantics and excessive whitespace.

## Fidelity gates

- Page dimensions and margins match within 0.04 cm.
- Every semantic role matches its named font, size, line spacing, indent and spacing.
- Cover is page 1; header notice and footer page number are consistent across all sections.
- No placeholder, old-project residue, clipping, overflow, split table row, orphaned heading, isolated caption or unintentional blank page.
- No ordinary body page is less than roughly 25% occupied unless it is the natural end of a chapter and reflow would damage table integrity.
- Page count may vary with content. Never shrink type, margins or spacing to imitate the reference's exact pagination.
