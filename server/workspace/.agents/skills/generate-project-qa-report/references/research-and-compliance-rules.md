# Research, Accuracy, and Compliance Rules

## Contents

1. Research modes
2. Source hierarchy
3. Material-claim verification
4. Data definitions and freshness
5. Conflict handling
6. Legal, privacy, and copyright boundaries
7. Provenance requirements

## Research modes

### Supplied-materials-only

Use when the user prohibits browsing. Do not add external facts. Mark missing information and still generate counterquestions and a gap list.

### Adaptive research

Use by default when supplied information is insufficient and the user has not prohibited browsing:

1. identify a specific report-blocking gap;
2. formulate bounded research questions;
3. search primary sources first;
4. verify material claims;
5. record provenance;
6. map each claim to its evidence in the internal ledger;
7. stop when the decision need is met.

Do not broaden research into unrelated personal or company information.

### User-directed research

Follow requested markets, competitors, policies, dates, or source domains while retaining all accuracy and legality rules.

## Source hierarchy

Prefer:

1. government, regulator, exchange, court-publication system, statistics agency, standards body, patent/trademark authority, formal company filing, audited report;
2. industry association, research paper, official technical documentation, tender/award notice, certification, formal customer/supplier material;
3. accountable major financial/news publisher, professional database, established research institution;
4. industry articles or research summaries only as leads or secondary support;
5. social media/forums only as leads, or as clearly attributed first-person public statements that are corroborated.

Open and record the original page in the internal evidence ledger. Do not rely on a search result page, snippet, aggregator, or copied repost when the original is available.

## Material-claim verification

Treat these as material:

- market size/growth;
- financing, valuation, ownership;
- revenue, profit, orders, cash collection;
- customer, partnership, tender/award;
- product performance, ranking, installed base;
- IP, litigation, enforcement, penalties;
- policy, license, certification, regulatory status.

Verify with:

- one authoritative primary/professional original source; or
- two independent high-quality sources with compatible scope.

Multiple pages copying one article count as one source.

If only the company claims a fact, label it `[仅有公司单方口径]`.

## Data definitions and freshness

Before using a number, confirm:

- data year/quarter and publication date;
- calendar vs fiscal year;
- geographic scope;
- currency and FX date;
- tax-inclusive vs tax-exclusive;
- actual, budget, forecast, target, or intention;
- revenue, shipment, investment, terminal output, or another denominator;
- nominal vs inflation-adjusted.

Use current available information for company status, financing, management, customers, products, policies, law, regulation, and standards. Mark older figures as historical.

For market forecasts, state base year, forecast interval, source date, and calculation definition.

## Conflict handling

When sources disagree:

1. do not average;
2. retain both definitions;
3. compare scope, date, methodology, unit, and publisher;
4. prefer the more primary, authoritative, and current source;
5. mark unresolved differences `[多来源口径冲突]`.

Do not hide a conflict because one value better supports the thesis.

## Calculations and inference

Show formulas, inputs, assumptions, units, and sources. Mark inference explicitly:

> 基于【事实 1】和【事实 2】，项目团队判断【结论】。

Do not describe a calculated estimate as a reported fact.

## Legal and access boundaries

Use only:

- files the user is authorized to provide;
- public pages available without bypassing controls;
- connectors/databases the user has authorized;
- lawful government, company, academic, and professional information.

Never:

- bypass login, paywall, CAPTCHA, access controls, rate limits, or site restrictions;
- obtain, infer, or expose non-public trade secrets;
- use leaked, illicit, or unknown-origin data;
- collect irrelevant personal sensitive information;
- publish unsupported allegations;
- imply legal clearance or give a definitive legal opinion without qualified review.

For personal, litigation, enforcement, or negative-news claims:

- prefer official public records;
- use neutral language;
- distinguish allegation, investigation, filing, judgment, appeal, and final result;
- include dates and current status;
- omit irrelevant personal detail.

## Copyright

- Summarize and analyze; do not copy long passages.
- Quote only the short text necessary to support a point.
- Recreate charts from lawful data when reuse rights are unclear and record the data provenance in the internal evidence ledger.
- Record the existence of paywalled research but do not reproduce protected content.
- Do not use images without a lawful basis for reuse.

## Provenance requirements

Do not expose source lists, citation labels, Markdown links, raw URLs, or clickable external hyperlinks in the standard reader-facing report. Record every external fact in the internal evidence ledger with:

- publisher;
- page/document title;
- URL;
- publication date;
- data period;
- access date;
- supported claim;
- source grade.

Use [assets/source-register-template.md](../assets/source-register-template.md) for large source sets.

Create a cited reader-facing edition or deliver the source register only when the user explicitly requests it. Otherwise, use neutral attribution in the report only when needed to preserve a claim's status or boundary.

If a reliable source cannot be found, record `[尚无可核验证据]` or `[来源待核验]` in the working ledger. In the reader-facing report, state the missing proof directly, for example `尚无合同、验收或回款材料支持该判断`; do not write `公开信息未检索到` or narrate the search process. Never fill the gap from memory or plausibility.
