# Retained DOCX template contract

- Reference: `../artifact-template-deta-3/assets/reference.docx` relative to the generation skill directory.
- Canonical source SHA-256: `946037c5e23ba01d3d2fa482c5ef850be18c77300b214a0b05844a644387336e`
- Reference render: 7 A4 pages when Chinese font aliases are correctly resolved; 1 section; 35 non-empty body paragraphs; no tables, visible headers, visible footers, drawings, or content controls.
- Page geometry: A4 portrait, 8.27 × 11.69 in; margins L/R 2.8 cm, T/B 2.5 cm; one column; no different-first/even-odd header behaviour.
- Title role: centered; 黑体; 14 pt; black; 1.5 line spacing; no border or decoration.
- Main heading role: real Chinese-number numbering; 宋体 12 pt bold; 1.5 line spacing; keep-with-next; 12 pt before on the first main heading pattern.
- Subheading role: real parenthesized Arabic numbering; 宋体 12 pt non-bold; 1.5 line spacing; keep-with-next; approximately two-character first-line position.
- Body role: 宋体 12 pt; Times New Roman western text; black; non-bold; 1.5 line spacing (`360/auto`); justified; approximately two-character first-line indentation; 0 pt before/after.
- Numbered reason/compliance role: visible Arabic number plus bold conclusion lead, followed by normal-weight reasoning; 6 pt before, 0 pt after; no table packaging.
- Closing role: managing-company line and Chinese date on separate right-aligned lines; 宋体 12 pt; 30 pt before the company and 0 pt before the date.
- Numbering, styles, settings, theme, footnote/endnote definitions, embedded font part, font table, and package relationships are preserve-only. The processor starts from a copy of the reference and changes only `word/document.xml` content while retaining these parts.
- Slot sequence: title; four main sections; three company subsections; five investment-reason items; investment-plan paragraphs; seven compliance items; conditional conclusion; company; date.
- Company-introduction content gate: the visible report contains no unified social credit code or 18-character credit code; 公司简介 contains no registered, subscribed, paid-in, or paid-up capital field. Keep those facts in the audit layer when they remain relevant to closing or ownership verification.
- Fidelity gate: preserve page geometry and package parts; keep the source font names; reject blank spacer paragraphs, underline, italics, bold-role drift, alignment drift, spacing drift, or margin drift; render every final page with QA-only aliases `宋体 → Songti SC` and `黑体 → Heiti SC` when needed.
