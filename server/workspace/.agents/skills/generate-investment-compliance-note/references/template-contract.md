# Retained DOCX template contract

- Reference: self-contained skill path `assets/reference.docx`, resolved from the compliance skill directory; no sibling skill or plugin is required.
- Canonical source SHA-256: `5b51cda592736fc3b2bfc69bcc75875f5588496d47f7a6b6691b21daae8b115e`
- Reference render: 8 A4 pages when Chinese font aliases are correctly resolved; 1 section; 35 non-empty body paragraphs plus 2 intentional blank transition paragraphs; no tables, visible headers, visible footers, drawings, or content controls.
- Page geometry: A4 portrait, 8.27 × 11.69 in; margins L/R 1.25 in (3.175 cm), T/B 1.00 in (2.54 cm); one column; no different-first/even-odd header behaviour.
- Title role: centered; 黑体 for ASCII/HAnsi/East Asia; 14 pt; black; 1.5 line spacing; no border or decoration.
- Main heading role: real Chinese-number numbering; 宋体 12 pt bold; 1.5 line spacing; keep-with-next; 12 pt before on the first main heading pattern.
- Subheading role: real parenthesized Arabic numbering; 宋体 12 pt bold; 1.5 line spacing; keep-with-next; 482-DXA first-line position.
- Body role: 宋体 12 pt for ASCII/HAnsi/East Asia; black; non-bold; 1.5 line spacing (`360/auto`); approximately two-character first-line indentation; 0 pt before/after.
- Numbered reason/compliance role: visible Arabic number plus the entire conclusion lead through the first `。` or `：` in bold, followed by normal-weight reasoning; 12 pt before, 0 pt after; no table packaging.
- Conclusion role: 宋体 12 pt; 12 pt before; 420-DXA first-line indent; normal weight.
- Closing role: managing-company line and spaced Chinese date on separate right-aligned lines; 宋体 12 pt; 12 pt before both lines; 300-DXA left indent and 420-DXA first-line indent; date format `YYYY年   M   月   D   日`.
- Blank transitions: preserve exactly one sample-derived blank paragraph before 投资情形分析 and one before the closing company line; reject any additional blank paragraph.
- Numbering, styles, settings, theme, footnote/endnote definitions, embedded font part, font table, and package relationships are preserve-only. The processor starts from a copy of the reference and changes only `word/document.xml` content while retaining these parts.
- Slot sequence: title; four main sections; three company subsections; five investment-reason items; investment-plan paragraphs; seven compliance items; conditional conclusion; company; date.
- Fidelity gate: preserve page geometry and package parts; keep the source font names; reject blank spacer paragraphs, underline, italics, bold-role drift, alignment drift, spacing drift, or margin drift; render every final page with QA-only aliases `宋体 → Songti SC` and `黑体 → Heiti SC` when needed.
