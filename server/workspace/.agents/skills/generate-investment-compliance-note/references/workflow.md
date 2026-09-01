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

## 3. Public-information cross-verification

Run a controlled public check by default. Read `public-information-verification.md`, build queries only from public entity identifiers, and keep confidential fund and transaction terms out of queries. Match the target by full legal name and unified social credit code before using any result.

Cover corporate registration, administrative penalties, credit/enforcement, litigation, intellectual property, licences/filings, and material public adverse information. Prefer direct government, judicial, regulatory, IP-office, filing, and company-official pages. Search results and commercial databases are discovery leads, not decisive proof.

Record the query cutoff date, sources, matched identifiers, access limitations, and conflicts in `public_verification.json`; validate it with `scripts/validate_public_verification.py`. Use “截至查询日，在列明公开渠道未发现……” for a supported negative check. Never convert an empty result set into “不存在”. An unresolved material public/internal conflict blocks delivery.

## 4. Fact ledger

For each material fact record: fact ID, domain, statement, entity, metric, value, unit, currency, period, basis, source ID and locator, confidence, status, conflict group, and notes.

Required domains are company, team, technology/product, commercial, financial, transaction, fund, policy/return-investment, related-party, governance, legal, and risk.

For team members, record company role, education or professional training, representative employers/projects/research results, professional direction, documented current company responsibility, and whether the role is current, proposed, part-time, dual-appointed, or contingent. Do not infer how an individual will help the project inside the biography; reserve the collective team-investment thesis for 投资理由. For products, record target users, pain point, functions, technical chain, maturity, signed delivery/revenue evidence, and any management-only performance claim.

## 5. Conflict adjudication

Never average conflicting values. Keep all candidates. Select a governing value only when a source hierarchy, signed definition, later formal amendment, or reproducible calculation supports it. Otherwise mark pending and use conservative wording in the report.

## 6. Compliance checks

“投资情形分析”不是目标公司尽调摘要，而是本次拟议交易的基金合规适用分析。判断对象是“本次交易方案 + 适用基金条款 + 交易实施后的基金状态”；输出要回答某项限制是否被触发、某项义务是否因投资而受影响。公司历史融资、一般经营风险和目标公司优劣只能作为背景，不能替代本次交易金额、结构、基金协议条款或投资后计算。

Evaluate these seven checks separately:

1. Investment restrictions: equity/new share/old share/SPV/loan/guarantee/real estate/securities/prohibited industries.
2. Return-investment obligation: eligible region, multiplier/base, completed amount, reserve projects, remaining investable capital, and headroom after this investment.
3. Related parties: target, controller, founders, directors, major shareholders, sellers, co-investors, fund, manager, LPs, and entrusted investor.
4. Investment direction: map products, revenue activity, and R&D to the fund agreement's permitted sectors—not merely to the company's marketing label.
5. Configuration: direct investment, SPV, sub-fund, old shares, cross-border vehicle, and any ratio or structural limits.
6. Concentration: denominator, applicable percentage, numerator before and after, affiliated-project aggregation, and follow-on reserve.
7. Other law/regulation issues: licences, data and privacy, IP/title, labour, tax, litigation, sanctions/export control, state-owned asset procedures, AML, and undisclosed side arrangements.

Keep the seven-item role map fixed. Item 1 must expressly address 投资限制／限制事项／禁止事项 rather than merely saying that a historical financing used equity. Item 2 must address return-investment impact after this investment. Item 3 must address the complete transaction-party perimeter. Item 4 maps supported business and revenue facts to the fund's permitted sectors. Item 5 tests direct investment, SPV, co-investment or other implementation layers against configuration rules. Item 6 states denominator, combined exposure, limit and post-investment headroom. Item 7 is the residual legal/regulatory prohibition check.

Before drafting, inspect the fund-agreement clauses, transaction terms, return-investment/concentration data, related-party materials and other decisive inputs. If any are missing, set `status: awaiting_user_input`, record the supplement request with `outcome: awaiting_response`, record `continuation_authorization.authorized: false`, ask the user in a blocking final response, and stop before authoring or build. Resume only when the user supplies the inputs or explicitly instructs the agent to continue with the available materials. For the latter, set `status: proceed_with_available_materials` and bind the exact authorization in `continuation_authorization` using `authorized: true`, `basis: explicit_user_instruction`, and a non-empty instruction. User silence is not authorization. Use `status: ready` when the clauses, transaction economics, dated calculations and review perimeter are complete. Reserve `status: blocked` and `blocking_issues` for unresolved material conflicts, known prohibited/non-compliant conditions or contradictory supplied data.

## 7. Drafting

Match the standard report's compact formal prose and separate two layers:

- Decision layer (visible DOCX): company facts, five positive investment reasons, executable investment plan, seven conclusion-first compliance checks, and one concise conditional conclusion.
- Audit layer (`content.json` notes and `open_issues`): conflicts, source hierarchy, evidence gaps, closing conditions, owners, and refresh requirements.
- Public audit layer (`public_verification.json`): entity matching, query scope, cutoff date, direct URLs, source type, access limitations, public/internal conflicts, and decision impact.

Draft in this order:

1. Write each compliance result first, using “符合／不涉及／不会导致／未发现” where supported.
2. Add only the shortest evidence or calculation needed to understand that result.
3. Place each hard condition once, in the item it governs; place operational follow-up in `open_issues`.
4. Write the five investment reasons as positive investment logic. Give each item a 15–34 compact-character summary title that states a project-specific thesis: concrete subject or capability, differentiating feature or mechanism, and investment implication. Category labels such as “技术方向与产业需求匹配”“产品与技术形成递进组合”“核心团队能力与产品路线对应” are not sufficient. Move every risk, “但” clause, and closing condition out of that section.
5. End with one conditional sentence. Do not append generic disclaimers or investment-return assurances.
6. Keep the seventh compliance item limited to the “other obvious legal/regulatory violation” judgment. Move closing-task lists to `open_issues`; let “必要尽调核验” in the final conclusion cover them collectively.
7. End the investment-plan section with one short reservation covering only investor/structure/equity/rights and the governing fund agreement, investment-committee resolution, and definitive documents.
8. Run a section-role placement pass: record the verified target legal name in `target_company.legal_name` and begin the first 公司简介 paragraph with that exact full name; use 公司/标的公司 afterward. Keep the rest of the profile business-first: formation/incubation, positioning, main business, products/technology, customers, operating stage, organization and broad commercial status. Cap-table ratios and control structure belong in the investment plan or compliance analysis. Exclude the legal representative, registered/paid-in/subscribed capital, licence identifiers, registry serials, revenue-recognition or invoicing/acceptance issues, cut-off/audit adjustments, collection/tax/accounting issues, and exact financial metrics from the visible profile. Permit exact metrics only under the explicit audited, user-requested and conflict-free `company_profile_financial_disclosure` exception. For every 核心团队 paragraph, populate `role_title` and `person_name`, begin with exact `role_title + person_name`, and only then describe education, representative experience/research, professional direction and documented current duties. Reject inferred project-help/company-fit tails and place the collective team thesis in 投资理由. Run these gates, the team coverage pass and the quantitative richness gate in `content-completeness.md` before build.
9. Run a decision-layer prose pass over 公司情况介绍、投资理由 and 投资计划. Remove attachment filenames, document dates/internal versions, paths/extensions and evidence-acquisition phrasing; state the supported fact directly and keep provenance in `source_ids`, notes or `open_issues`. Keep formal law/regulation titles when needed. Use 我方、本基金、指定基金主体、公司/标的公司 and 管理人 according to role; permit the full `closing.company` name only in the closing signature. Compliance-analysis review-perimeter language remains permitted when necessary.
10. Run an investment-scenario layer-separation pass. The seven visible items are the 可见决策层: each must contain a decision and its shortest rule/fact/calculation support, not instructions for the reviewer. Move “尚未确定／待明确／待补充／仍需／应结合……判断／应核对／核查后方可确定／不能测算／无法核对／不宜作出结论／最终仍应核实” and equivalent missing-input narration out of the visible report; that material belongs in `delivery_readiness`, notes or `open_issues`. A concrete condition that directly qualifies the result may remain once; an open-ended audit task may not. Missing evidence first pauses at `awaiting_user_input`; it produces a QA warning only after explicit authorization to continue. An actual material conflict or known non-compliance stops the build.

Keep promotional claims out of the compliance conclusion. Do not make an unconditional legal assurance merely to achieve a crisp tone.

## 8. Correction loop

Run three passes:

- Fact pass: entity, date, unit, valuation basis, ownership, formulas, and source bindings.
- Legal/compliance pass: overclaiming, missing conditions, related-party perimeter, return-investment and concentration denominators, old-share permissions.
- Public-verification pass: entity disambiguation, direct official source, cutoff date, forbidden confidential query terms, absolute no-risk wording, access limitations, and material conflicts.
- Editorial/template pass: visible template residue, hierarchy, numbering, font/size, page breaks, signature/date, and visual defects.
- Package-metadata pass: current title/subject/author/modifier/date in `docProps/core.xml`; no retained `docProps/custom.xml`, WPS/KSO save record, user identifier, stale `docProps/app.xml`, or dangling relationship/content-type declaration.
- Concision pass: defensive phrases in investment reasons, repeated caveats, an item-7 closing checklist, an overlong plan reservation, overlong compliance tails, and a multi-sentence conclusion.
- Content-completeness pass: company-profile placement and financial-boundary hygiene, one-person-per-paragraph team biographies, team dimension coverage, product maturity and commercial evidence, five fully reasoned investment reasons, and sample-calibrated section richness. Never pad with generic market language or duplicate facts merely to reach a count.
- Investment-thesis pass: each reason title is specific enough to stand alone, names the actual product/capability/evidence mechanism, and does not merely restate an evaluation category.
- Scenario-role pass: the seven 投资情形 items follow the standard role order and analyse the contemplated transaction and post-investment fund state; target-company history is never used as a substitute for fund or transaction inputs.
- Scenario-layer pass: the visible decision layer contains conclusion-first compliance analysis only; audit-process verbs, missing-input notices, calculation requests and refusal-to-conclude language are confined to the audit layer. A concrete one-time condition remains allowed when it directly limits the result.
- Decision-layer prose pass: the first 公司简介 paragraph begins with the full `target_company.legal_name`, then uses 公司/标的公司 and remains business-first without the legal representative or routine capital-registration fields; each 核心团队 paragraph begins with exact `role_title + person_name`, title first, and contains only objective biography/expertise/current-duty facts without an inferred project-benefit/company-fit tail; no licence identifiers or financial due-diligence findings appear in 公司简介, and no exact profile financial metrics appear without the narrow recorded exception; no attachment filenames, internal versions, paths, source-process narration or full `closing.company` issuer name appear in visible sections; internal party references use role terms; proposed, dual-appointed or contingent personnel use natural role/status wording without implying completed onboarding or predicting future contribution.
- Layout pass: A4 geometry, 2.54/3.175 cm margins, 黑体 title, 宋体 for all body scripts, bold main/subheadings, full numbered conclusion-lead bold boundaries, 360/auto line spacing, paragraph spacing, indentation, spaced Chinese date, and exactly two sample-derived transition paragraphs.

Pause when a decisive input is absent and ask the user. If the user explicitly authorizes use of the current packet, resume and deliver the standard DOCX with a bounded conditional conclusion while summarizing missing inputs outside the visible document. Permanently stop only for an unresolved material conflict, known prohibited/non-compliant condition, or contradictory supplied transaction/calculation data.

## 9. Semantic delivery gate

- A final compliance note is a decision document, not an evidence-gap notice. Each of the seven visible checks must begin with an affirmative result such as “符合／不涉及／不会导致／未发现”.
- A final compliance note must not narrate the unfinished audit inside the seven visible checks. “尚未确定／待明确／待补充／仍需／应结合……判断／应核对／核查后方可确定／不能测算／无法核对／不宜作出结论／最终仍应核实” and semantically equivalent process wording are hard failures. Put the underlying tasks in `open_issues`; if they are decisive, the formal build remains blocked.
- The single closing sentence must state concrete conditions and contain “原则上符合”. “暂无法形成结论／不能形成结论／无法判断／待定” are prohibited in a delivered compliance note.
- Request decisive evidence once before drafting. If it is not supplied and no known contrary fact exists, build the standard DOCX with a bounded “原则上符合” conclusion and keep the evidence limitation in the audit layer. Do not create a separate “internal draft” document class.
- A delivered online note must bind to a validated public-verification record. Limited public coverage is permitted only when disclosed and when it does not conceal a decisive unresolved conflict.
- Conditional wording cannot be used to fabricate a clause, amount, calculation or completed review. `awaiting_user_input` fails build. `proceed_with_available_materials` requires a recorded supplement request/outcome plus explicit continuation authorization and retains missing inputs and `pending` statuses in the audit layer. `blocked`, non-empty `blocking_issues`, material conflicts, known non-compliance or inconsistent supplied data also fail.

## 10. Content-completeness delivery gate

- `scripts/compliance_processor.py build` blocks a thin or mis-placed draft; `verify` records `content_completeness_status` and detailed `content_richness` metrics.
- Company profile must have the exact subsections 公司简介、核心团队、产品及技术. Its first profile paragraph must begin with `target_company.legal_name` and then prioritise business facts. It must not state the legal representative, registered/paid-in/subscribed capital, shareholder ownership ratios, voting-control ratios, cap-table changes, controlling-shareholder analysis, actual-controller analysis, financial due-diligence findings, or exact financial metrics without the explicit audited user-requested disclosure record.
- Prefer at least four evidence-backed member paragraphs and the bundled sample-calibrated richness level. Every disclosed member must still provide `role_title` and `person_name` and use the title-before-name opening. If fewer people are disclosed, request additional team evidence once, never invent biographies, and continue with the disclosed members; QA records a richness warning rather than creating a different document class.
- Passing the character floors never overrides evidence quality. Unsupported adjectives, repeated sentences, generic policy text, or audit caveats do not count as acceptable enrichment.
- `content_completeness_findings()` hard-fails a missing/mismatched target legal-name opening, visible licence identifiers, attachment/source narration, and any occurrence of the full `closing.company` issuer name in the four sections. The target legal name at the start of 公司简介 is expressly required and is not issuer-name leakage. Formal law/regulation titles may remain, and 投资情形分析 may identify the review perimeter when necessary.

## 11. Decisive-input delivery gate

- Do not treat the fund partnership agreement, return-investment ledger, concentration denominator/limit, finalized transaction economics, or related-party checklist as refreshable sidecars when any of them can reverse checks 1–6.
- `scripts/compliance_processor.py build` requires `delivery_readiness`, the supplement-request record and `continuation_authorization`. `awaiting_user_input` and incomplete packets without explicit authorization are errors. Incomplete components and `pending` compliance items are warnings only under a valid `proceed_with_available_materials`; explicit `blocked`, non-empty `blocking_issues`, unresolved material conflicts, known non-compliance and contradictory supplied data remain errors.
- Generate one standard 合规性说明/声明 document class. Keep the supplement list, evidence limitations, warnings, and responsibilities in the conversation and audit sidecars rather than adding an “internal preview” label to the DOCX.
