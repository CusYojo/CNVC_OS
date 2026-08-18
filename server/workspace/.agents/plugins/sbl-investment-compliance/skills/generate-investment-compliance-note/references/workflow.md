# Evidence-driven compliance-note workflow

## 1. Intake and integrity

Hash the archive and every extracted file. Reject path traversal and symlink entries. Preserve the original archive. Record extraction failures, unreadable scans, shortcuts, nested archives, and password-protected files.

## 2. Source hierarchy

Use this order for disputed facts:

1. Signed or executed transaction and governance documents.
2. Government registration, licence, tax, litigation, and regulatory records.
3. Audited or special-audit financial reports and bank evidence.
4. Company ledgers, contracts, invoices, acceptance records, and payment records.
5. Legal/financial due-diligence reports.
6. Management interviews and meeting minutes.
7. Business plans, marketing decks, forecasts, and unsigned drafts.

The later-dated source does not automatically win. Prefer the source whose authority and definition govern the disputed fact.

## 3. Fact ledger

For each material fact record: fact ID, domain, statement, entity, metric, value, unit, currency, period, basis, source ID and locator, confidence, status, conflict group, and notes.

Required domains are company, team, technology/product, commercial, financial, transaction, fund, policy/return-investment, related-party, governance, legal, and risk.

## 4. Conflict adjudication

Never average conflicting values. Keep all candidates. Select a governing value only when a source hierarchy, signed definition, later formal amendment, or reproducible calculation supports it. Otherwise mark pending and use conservative wording in the report.

## 5. Compliance checks

Evaluate these seven checks separately:

1. Investment restrictions: equity/new share/old share/SPV/loan/guarantee/real estate/securities/prohibited industries.
2. Return-investment obligation: eligible region, multiplier/base, completed amount, reserve projects, remaining investable capital, and headroom after this investment.
3. Related parties: target, controller, founders, directors, major shareholders, sellers, co-investors, fund, manager, LPs, and entrusted investor.
4. Investment direction: map products, revenue activity, and R&D to the fund agreement's permitted sectors—not merely to the company's marketing label.
5. Configuration: direct investment, SPV, sub-fund, old shares, cross-border vehicle, and any ratio or structural limits.
6. Concentration: denominator, applicable percentage, numerator before and after, affiliated-project aggregation, and follow-on reserve.
7. Other law/regulation issues: licences, data and privacy, IP/title, labour, tax, litigation, sanctions/export control, state-owned asset procedures, AML, and undisclosed side arrangements.

## 6. Drafting

Match the standard report's compact formal prose and separate two layers:

- Decision layer (visible DOCX): company facts, five positive investment reasons, executable investment plan, seven conclusion-first compliance checks, and one concise conditional conclusion.
- Audit layer (`content.json` notes and `open_issues`): conflicts, source hierarchy, evidence gaps, closing conditions, owners, and refresh requirements.

Draft in this order:

1. Write each compliance result first, using “符合／不涉及／不会导致／未发现” where supported.
2. Add only the shortest evidence or calculation needed to understand that result.
3. Place each hard condition once, in the item it governs; place operational follow-up in `open_issues`.
4. Write the five investment reasons as positive investment logic. Move every risk, “但” clause, and closing condition out of that section.
5. End with one conditional sentence. Do not append generic disclaimers or investment-return assurances.
6. Keep the seventh compliance item limited to the “other obvious legal/regulatory violation” judgment. Move closing-task lists to `open_issues`; let “必要尽调核验” in the final conclusion cover them collectively.
7. End the investment-plan section with one short reservation covering only investor/structure/equity/rights and the governing fund agreement, investment-committee resolution, and definitive documents.
8. Keep registration identifiers out of the decision layer. Do not show a unified social credit code or any 18-character credit code anywhere in the visible report. In 公司简介, omit registered, subscribed, paid-in, and paid-up capital fields—including parenthetical “实缴 + 金额” disclosures—and retain them only in the fact ledger or `open_issues` when relevant.

Keep promotional claims out of the compliance conclusion. Do not make an unconditional legal assurance merely to achieve a crisp tone.

## 7. Correction loop

Run three passes:

- Fact pass: entity, date, unit, valuation basis, ownership, formulas, and source bindings.
- Legal/compliance pass: overclaiming, missing conditions, related-party perimeter, return-investment and concentration denominators, old-share permissions.
- Editorial/template pass: template residue, hierarchy, numbering, font/size, page breaks, signature/date, and visual defects.
- Concision pass: defensive phrases in investment reasons, repeated caveats, an item-7 closing checklist, an overlong plan reservation, overlong compliance tails, and a multi-sentence conclusion.
- Layout pass: A4 geometry, 2.5/2.8 cm margins, title/main/subheading/body/closing roles, Times New Roman western text, bold-role boundaries, 360/auto line spacing, paragraph spacing, indentation, alignment, and absence of blank spacer paragraphs.

Stop delivery when a decisive missing fact could reverse the compliance conclusion. Otherwise deliver a conditional conclusion and list the missing closing conditions.
