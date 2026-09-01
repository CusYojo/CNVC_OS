# Content completeness and placement contract

This contract prevents avoidable thinness while allowing the standard compliance note to be generated from the materials actually supplied after the user authorizes that course. It is calibrated to the retained Deta 3 sample and enforced by `content_completeness_findings()` during both build and verify. Structural contamination remains an error; decisive missing inputs first produce `awaiting_user_input`, and become QA warnings only after explicit continuation authorization. Character counts exclude whitespace.

## Section-role placement

- 公司简介：begin the first paragraph with the verified full legal name recorded in `target_company.legal_name`, then use 公司/标的公司. Keep it business-first: formation/incubation background, business positioning, main business, product/technology system, target customers, operating stage, organization, and broad commercial status. Do not display the legal representative, registered capital, paid-in capital, subscribed capital, licence identifiers, registration numbers, long registry serials, financial due-diligence findings, or exact financial metrics by default. Keep routine registry facts in the audit layer; use them elsewhere only when they directly affect a compliance issue.
- 核心团队：one named person per paragraph. Store the company role/title in `role_title`, the name in `person_name`, and begin visible prose with their exact concatenation `role_title + person_name`: title first, name second, then education/professional training, representative employment/projects/research results, professional direction, and a documented current company responsibility when available. Examples: “公司联合创始人、CTO刘航欣，……” and “公司拟任首席科学家Abdulmotaleb El Saddik，……”. Name-first openings are not acceptable. State proposed, part-time, dual-appointment, adviser, or not-yet-onboard status exactly. Do not append an inferred statement about how the person can support, connect, strengthen or match the company/project. Put the team's collective investment relevance once in 投资理由.
- 产品及技术：target user and problem, core functions, technical chain, maturity, IP/technical evidence, commercial delivery, and the distinction between launched and in-development products.
- 投资计划：transaction amount, valuation, new/old shares, post-investment ownership, vehicle, payment, governance, use of proceeds, and one final-document reservation.
- 投资情形分析：the seven fund/legal conclusions, review perimeter, calculations, and material conditions.

投资情形分析的判断对象是本次拟议交易及交易后的基金状态，不是目标公司的历史融资或一般尽调风险。七项必须依次对应投资限制、返投影响、关联交易、投资方向、投资配置、投资集中度和其他法律监管事项。公司历史增资采取股权形式，不等于本基金本次交易当然符合投资限制或配置要求。

Company profile must not contain shareholder ownership percentages, voting-right percentages, cap-table changes, controlling-shareholder analysis, or actual-controller analysis. Move those facts to 投资计划 or the applicable compliance item. Do not repeat them merely to add detail.

Company profile must not contain a unified social credit code, business-licence number, registration number, organization code, credential number, or an 18-character registry identifier. Keep those values in the evidence ledger or audit sidecar. Prefer “成立于……，主要从事……” over a registry-field dump.

Company profile must not narrate financial due-diligence findings, including revenue-recognition, invoicing versus delivery/acceptance timing, cut-off or cross-period differences, audit adjustments, abnormal collections, or tax/accounting issues. Move them to notes, `open_issues`, or closing conditions. Exact revenue, profit, margin, receivables, and cash-flow figures are excluded by default. They are permitted only when the user explicitly requests profile disclosure, the figures are supported by audited or special-audit evidence, no material conflict exists, and `company_profile_financial_disclosure` records `allowed`, `user_requested`, `basis`, `no_material_conflict`, and source IDs. Supported stage-level wording such as “已形成初步商业化收入” remains acceptable.

## Team coverage gate

- At least four evidence-backed member paragraphs.
- At least 90 compact characters per member paragraph and at least 560 compact characters across the team subsection.
- Each paragraph must cover at least three of these four dimensions: role; education/professional training; representative employment/project experience; project-relevant technical, product, commercial, or management domain.
- If the evidence identifies fewer than four relevant people, do not invent biographies. Request more evidence once, continue with the disclosed people if nothing further is supplied, and record a richness warning outside the DOCX.
- Do not expose evidence-acquisition language in a member biography. Rewrite “公司资料记载的拟任首席科学家”“法律尽调载明其拟双聘”“当前按拟任状态表述” as natural role/status prose such as “拟任首席科学家”“拟以双聘方式提供服务”“任职安排尚待确认”, while preserving `status`, `source_ids` and unresolved timing in the audit layer.

## Decision-layer prose hygiene

- In 公司情况介绍、投资理由 and 投资计划, state supported facts directly. Do not expose attachment filenames, document dates, internal versions, paths, extensions, or source-process phrases such as “公司资料记载”“财务尽调资料显示”“根据《投资意向书（V2）》所列框架”“资本表所列” or “现阶段按某状态表述”.
- Keep evidence provenance in `source_ids`, notes and `open_issues`; these fields exist so the visible DOCX does not narrate how the drafter found each fact.
- Keep formal law/regulation titles when they are necessary to state the applicable rule. Internal attachment names, dates and versions remain in the audit layer even when the underlying fact is material.
- Begin 公司简介 with the target's full `target_company.legal_name`; afterward use 公司/标的公司 for the target. Use 我方 for the internal investment side, 本基金 for a determined fund, 指定基金主体 for an undetermined investment vehicle, and 管理人/基金管理人 for the legal role. The full issuer name from `closing.company` may appear only in the closing signature, never in the four visible sections. These are two different legal-name roles.
- 投资情形分析 may identify the review perimeter or evidence cutoff when necessary to qualify a legal conclusion.

## Richness floors

| Area | Enforced minimum |
| --- | ---: |
| 公司简介 | 150 compact characters |
| 核心团队 | 4 member paragraphs, 560 total characters, 90 per member |
| 产品及技术 | 2 paragraphs, 360 total characters |
| 投资理由 | exactly 5 numbered items, 80 per item, 500 total characters |
| 投资计划 | 330 total characters |
| 投资情形分析 | first 7 items, 70 per item, 600 total characters |

These are sample-calibrated evidence-density targets, not permission to pad. Prefer the retained sample's level of factual specificity when the source packet supports it. Falling below a target because evidence is unavailable produces a warning rather than a second document class; exceeding a target does not cure unsupported claims, wrong placement, repetitive prose, promotional language, or fabricated transaction calculations.

## Investment-reason title gate

- Split each numbered reason at the first `。` or `：`. The lead is its summary title.
- Keep the title between 15 and 34 compact characters, calibrated to the retained sample.
- Make the title a stand-alone investment thesis: name the project's actual product, capability, evidence or ecosystem mechanism and state why it matters.
- Reject category-only labels such as “技术方向与产业需求匹配”“产品与技术形成递进组合”“核心团队能力与产品路线对应”“产业落地与股权融资基础已经形成”.
- Keep the five titles mutually distinct; the body supplies the shortest supporting facts rather than repeating the title in generic language.

## Investment-scenario role gate

1. 投资限制事项：apply the fund's permitted/prohibited transaction rules to the current proposed structure.
2. 返投义务影响：show the dated post-investment return-investment calculation and headroom.
3. 关联交易：cover the final transaction parties, sellers/co-investors/vehicles, fund, manager and relevant LP perimeter.
4. 投资方向：map supported products, R&D and revenue activity to the fund-agreement sector definition.
5. 投资配置：test direct investment, SPV, co-investment, old-share or layered structures against allocation/configuration rules.
6. 投资集中度：show denominator, combined existing/proposed exposure, limit, post-investment ratio and headroom.
7. 其他法律监管事项：state whether a residual legal or regulatory prohibition blocks the investment; keep closing task lists in `open_issues`.

Passing prose requires both an explicit judgment lead and the correct item role. An affirmative sentence in the wrong role must fail.

## Investment-scenario decision-layer gate

- Treat each visible item as a completed decision-layer paragraph: result first, then the shortest applicable rule, current transaction fact or calculation, and post-investment result.
- Reject audit-process or missing-input wording anywhere in the first seven visible items, including “尚未确定”“待明确”“待补充”“仍需”“应结合……判断”“应核对”“核查后，方可确定”“不能测算”“无法核对”“不宜作出结论”“最终仍应核实” and semantic equivalents.
- Do not cure an evidence gap by replacing the prohibited phrase with an invented affirmative fact. Move the gap to `delivery_readiness`, notes or `open_issues`; pause at `awaiting_user_input`, then use a bounded decision-layer paragraph and global conditional conclusion only after the user explicitly authorizes continuation. Block permanently for an actual material conflict, known non-compliance or contradictory supplied data.
- Permit one result-specific concrete condition, such as “老股受让部分以基金合伙协议允许为前提” or “最终以关联关系核查表、投资决策文件及交易文件披露为准”. A condition is not permission to add a research instruction, a document request, or a calculation task.
- After the user explicitly authorizes work from an incomplete packet, generate the same standard DOCX. Keep unsupported statuses, authorization and supplement history in the audit sidecar; do not repeat evidence-gap caveats inside all seven visible items and do not label the DOCX as an internal preview.

## Acceptable enrichment

- Add concrete education, prior role, representative project, technical domain, user, function, maturity, contract, transaction term, formula, review perimeter, or source-qualified status in the section assigned to that fact. Financial periods and exact metrics belong in investment rationale, financial analysis, or the audit layer unless the narrow company-profile disclosure exception is satisfied.
- Reconcile contradictions and keep the governing source visible in `source_ids`, notes, or `open_issues`.
- Use audited or signed facts to replace generic claims. Keep management-only performance metrics explicitly attributed or omit them from the visible document.

## Unacceptable enrichment

- Repeating the same fact in several sections.
- Adding generic market size, policy slogans, “leading/first/unique” claims, or unverified customer names to reach a count.
- Moving shareholder ratios into 公司简介.
- Copying licence identifiers or registry serials into 公司简介.
- Starting 公司简介 with a target-company abbreviation instead of the verified `target_company.legal_name`.
- Adding the legal representative, registered capital, paid-in capital or subscribed capital to visible 公司简介 instead of keeping routine registry facts in the audit layer.
- Starting a 核心团队 biography with the person's name, omitting `role_title`/`person_name`, or failing to match the exact `role_title + person_name` prefix.
- Ending a 核心团队 biography with inferred project-benefit or company-fit language such as “使其能够统筹”“可支持/支撑/连接公司”“可为公司提供”“能够为合成数据平台……提供工程化支持”“有助于公司”“将补强公司” or “与公司产品路线具有对应/匹配关系”.
- Moving revenue-recognition, invoicing/acceptance timing, cut-off, audit-adjustment, collection, tax, or accounting issues into 公司简介.
- Adding exact revenue, profit, margin, receivables, or cash-flow figures to 公司简介 without the explicit audited user-requested disclosure record.
- Turning proposed appointments into current employment.
- Leaving evidence-acquisition meta-language in visible company, team, product or investment-reason prose.
- Exposing an attachment filename, internal date/version, local path or file extension in 公司情况介绍、投资理由 or 投资计划.
- Writing the full `closing.company` issuer/manager name in any of the four visible sections instead of using 我方、本基金、指定基金主体 or 管理人 according to role.
- Adding defensive caveats to 投资理由 or a closing checklist to item 7.
- Using broad investment-reason labels that could be copied unchanged to an unrelated project.
- Treating target-company historical financing as proof that the contemplated fund transaction satisfies investment restrictions, configuration or concentration rules.

`verify` must report `metrics.content_completeness_status = "pass"` and provide the full `metrics.content_richness` object before delivery. `evidence_richness_status = "limited"` is allowed when the limitation comes from unavailable source material and the supplement request plus explicit continuation authorization are recorded.
