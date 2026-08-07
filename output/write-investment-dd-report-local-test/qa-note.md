# 本地技能测试QA记录

- Skill: `write-investment-dd-report`
- Test date: 2026-08-06
- Test mode: `technical_dd`
- Source sample: `docs/agent/尽调报告/佳量脑科学业务尽调报告6月.docx`
- Final DOCX: `佳量脑科学_技术专项尽调报告_本地测试.docx`

## Automated gates

- Runtime: passed after installing PyMuPDF into `/private/tmp/write-investment-dd-report-test-venv`.
- Evidence audit: 0 errors, 0 warnings.
- IC completeness audit: 0 errors, 0 warnings.
- Report content audit: 0 errors, 0 warnings.
- Strict narrative audit: 0 errors, 0 warnings.
- DOCX style audit: 0 errors, 0 warnings.
- Field inventory: 1 TOC field, 6 PAGE fields, `w:updateFields=true`.
- Chinese/English literal-space audit: no matches.

## Visual QA

- Renderer: LibreOffice with task-local Fontconfig aliases from `黑体` to `Heiti SC` and from `仿宋_GB2312` to `STFangsong`.
- Page count: 9.
- Pages reviewed: 1-9 individually at original resolution after the final report revision.
- Initial defect: LibreOffice could not resolve the exact template font names and rendered Chinese as missing-glyph boxes.
- Fix for QA: added task-local font aliases without modifying the DOCX font declarations.
- Content-density defect: the technical-risk page was too sparse; added a company-specific risk/transaction table and reran all gates.
- Final visual review: no clipping, overlap, split logical rows, isolated headings or missing page numbers. The final chapter is intentionally shorter as the natural report ending.

## Remaining compatibility item

- The headless renderer does not refresh the TOC result and therefore displays the template text `目录将在打开文档后自动更新` on page 2.
- WPS Office is installed, but automated screen capture failed in the local Computer Use bridge, so a WPS-native page-by-page export could not be recorded in this run.
- The DOCX retains a valid `TOC \\o "1-2" \\h \\z \\u` field and `w:updateFields=true`; opening and saving in Word/WPS should refresh the cached TOC.
- Overall status: functional pipeline pass; WPS-native TOC refresh and final pagination remain a manual compatibility check.
