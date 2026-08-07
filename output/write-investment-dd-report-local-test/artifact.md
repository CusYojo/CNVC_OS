# 模板执行契约

- Reference: `/Users/lh/Documents/cybernaut-dist/server/workspace/.agents/skills/write-investment-dd-report/assets/deta-v5-dd-template.docx`
- SHA-256: `e8c77b1a88f8c4ec5756162b5514909695175941b68b0cb92f6d7e511b6031da`
- Baseline render: 3 pages, 3 portrait sections.
- Evidence paths: `template-reference-render/` and `template-style-evidence.json`.
- Preserve-only: section geometry, named styles, numbering definitions, header/footer parts, PAGE and TOC fields, relationships and template markers not selected for replacement.

## Page system

- A4 portrait, left 2.20 cm, right 2.00 cm, top 2.00 cm, bottom 1.80 cm.
- Header distance 0.75 cm; footer distance 0.85 cm.
- Cover, TOC and body use separate new-page sections with continuous page numbering.
- The cover has no confidentiality header; subsequent sections preserve the template header/footer behavior.

## Typography and components

- Cover company name and report title use the retained centered title block.
- Body uses the retained FangSong_GB2312 12 pt style with 1.5 line spacing and first-line indent.
- Heading levels use the retained SimHei hierarchy and deterministic Arabic numbering.
- Key-value tables use a grey label column; analytical tables use grey headers, fixed grids and non-splitting rows.
- The TOC and page numbers remain Word fields and `w:updateFields` must remain enabled.

## Slot map

- `[[PROJECT_NAME]]`: replace with the project or legal-entity name.
- `[[REPORT_TITLE]]`: replace only with `尽职调查报告`.
- `[[AUTHOR]]`: replace with the report author.
- `[[REPORT_DATE]]`: replace with the report date.
- `[[REPORT_BODY]]`: replace with the ordered report blocks; all other package parts remain preserved.

## Fidelity gates

- The source template must retain the recorded SHA-256.
- No old-project content, unresolved markers, missing page numbers, clipped text or split logical table rows.
- LibreOffice on this Mac does not resolve the exact SimHei/FangSong_GB2312 font names consistently; final compatibility review therefore also uses the installed WPS Office.
