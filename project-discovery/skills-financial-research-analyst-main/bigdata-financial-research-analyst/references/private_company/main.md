# Private Company and Deal Screening

This workflow is the default for this skill. Use it for unlisted companies, startup financing
signals, university spinouts, lab commercialization opportunities, patents, arXiv papers, WeChat
articles, accelerator updates, government grants, customer pilots, product launches, and sector
themes that may lead to private-market investments.

## First decision: keep or filter

Classify each item before writing analysis:

| Decision | Use when | Output |
|----------|----------|--------|
| **Investable lead** | A concrete unlisted company / project / spinout vehicle exists or is likely; there is evidence of product, team, IP, customers, financing, or commercialization path | Score and memo |
| **Watchlist** | Signal is promising but entity / ownership / commercialization path is incomplete | Score, gaps, next checks |
| **Context** | Public-company, policy, academic, or sector information helps understand a private-market opportunity but is not itself a target | Keep as supporting context |
| **Filter / ignore** | Pure secondary-market content, no private entity, no investable implication, unverifiable repost, generic market commentary | Short reason only |

## Primary-market stages and disclosure reality

Treat angel, seed, Pre-A, Series A, Series B, Series C+, growth equity, PE, private placement,
and strategic minority investment into unlisted companies as primary-market signals.

Private-market information is often incomplete by design. Round amount, valuation, ownership,
cap table, use of proceeds, revenue, and customer names may be undisclosed. Missing disclosure is
not itself a weak-signal reason. Classify each field as:

| Status | Meaning |
|--------|---------|
| **Disclosed fact** | Directly stated by a reliable source |
| **Reasonable inference** | Not stated, but supported by concrete evidence; explain why |
| **Undisclosed / to verify** | Important but not public; list as diligence item |
| **Contradicted / unreliable** | Source conflict or likely inaccurate claim |

Do not invent financing amount, valuation, revenue, ownership, cap table, or investor names.
When information is not public, focus on proxy evidence: founder / lab quality, investor logo if
disclosed, hiring, customer pilots, product release, patent ownership, grants, procurement,
strategic partnerships, technical novelty, and repeatability of the business model.

## Secondary-market exclusion

Default-filter:

- Listed-stock price movement, valuation calls, broker ratings, earnings preview / digest, EPS,
  dividend, index, ETF, technical analysis, and trading-positioning content.
- Public-company news where the only implication is "stock may go up / down."

Allow only as context when it shows:

- Strategic investment / M&A / licensing / customer relationship with an unlisted company.
- Demand validation for a private technology category.
- Public comparable valuation or exit pathway.
- Supply-chain or procurement pull that benefits private targets.

## Evidence hierarchy

Prefer sources in this order:

1. First-party company / university / institute / regulator / patent / paper / procurement source.
2. Financing database, investor announcement, customer announcement, government project notice.
3. Reputable media with named facts.
4. Reposts, summaries, anonymous claims, or generic commentary.

Record the source type and confidence.

## Signal types and what to extract

| Signal type | Extract |
|-------------|---------|
| Financing | Round / stage if disclosed; amount, investors, valuation, use of funds, and prior rounds only when disclosed; otherwise mark undisclosed / to verify |
| Product / launch | Product, target customer, pricing / deployment, differentiation, status |
| Customer / pilot | Customer name, contract / pilot scope, repeatability, revenue evidence |
| Patent | Assignee, inventors, claims, ownership, commercialization relevance |
| Paper / arXiv | Authors, institutions, novelty, reproducibility, product path, likely spinout link |
| University achievement | Lab, PI, technology readiness, IP ownership, transfer status, industry partner |
| Grant / policy | Grant size, sponsor, eligibility, market pull, non-dilutive capital relevance |
| Hiring | Role cluster, location, seniority, expansion signal, product / go-to-market inference |
| Partnership | Partner quality, exclusivity, economics, strategic value, proof vs marketing |

## 0-100 signal scoring rubric

| Dimension | Weight | High score looks like |
|-----------|--------|-----------------------|
| Private-market fit and investability | 20 | Concrete unlisted target, plausible financing / deal path; undisclosed terms are handled as diligence gaps |
| Technology / product differentiation | 15 | Clear advantage, defensible IP / data / workflow, hard-to-copy capability |
| Founder / team / institution quality | 15 | Strong founder-market fit, leading lab, credible prior outcomes, top institution |
| Market size and urgency | 15 | Large painful market, budget owner exists, timing is improving |
| Traction / validation / partnerships | 15 | Customers, revenue, pilots, grants, top investors, strategic partners |
| Timing, policy, and financing window | 10 | Recent catalyst, policy tailwind, fundraising window, commercialization inflection |
| Source quality and verifiability | 10 | First-party or verifiable source, dated, specific, linkable |

Suggested labels:

- **80-100: High priority** - contact / diligence now.
- **60-79: Watchlist plus follow-up** - promising but has gaps.
- **40-59: Low priority** - monitor unless new validation appears.
- **0-39: Filter / weak signal** - not actionable.

## Memo structure

Use this order for single-target analysis:

1. Verdict: High priority / Watchlist / Low priority / Filter.
2. Signal score and top reasons.
3. Entity and source facts.
4. What changed and why it matters now.
5. Investment angle.
6. Commercialization and customer path.
7. Team / institution / investor quality.
8. Differentiation and moat.
9. Risks / disqualifiers.
10. Next diligence actions.

## Batch screening output

For multiple items, use a dense table:

| Verdict | Score | Target | Signal | Sector | Why it matters | Key risk | Next action | Source |
|---------|-------|--------|--------|--------|----------------|----------|-------------|--------|

Keep each row concise and avoid public-stock language.

## Diligence questions

When a signal is worth follow-up, generate targeted questions:

- What is the legal entity and ownership / cap table?
- Who owns the IP and are there exclusive licenses?
- What is the productization status and timeline?
- Who is the buyer and what budget does it replace or create?
- What customer evidence exists beyond pilots?
- What is the current financing status and use of proceeds?
- Which competitors or incumbents can block adoption?
- What regulatory, safety, data, or procurement constraints apply?
- What would disprove the thesis in 30-60 days?

## Output quality

Good private-market research should answer:

- Is there a concrete investable entity or only an interesting technology?
- Why is this signal timely?
- What evidence is first-party or independently verifiable?
- What is the shortest diligence path to confirm or reject the opportunity?
- What public-market information, if any, is only context?
