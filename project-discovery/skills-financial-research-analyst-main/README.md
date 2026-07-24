# Private-Market Financial Research Analyst Skill

An AI-powered skill customized for investment research teams that focus on **unlisted companies**
and primary-market opportunities. It helps screen startup, university, patent, paper, media,
financing, and technology-commercialization signals while filtering out pure secondary-market
noise.

## What This Skill Does

Once installed, your agent platform can help with:

**Private-Market Discovery**
- **Opportunity screening** - score unlisted company, startup, lab, patent, paper, and WeChat
  signals from 0-100.
- **Private-company briefs** - summarize why a target may be investable, what evidence exists,
  and what must be verified.
- **University / institute commercialization** - evaluate papers, patents, labs, grants,
  technology-transfer projects, and spinout potential.
- **Financing and milestone analysis** - interpret funding, customer, product, partnership,
  procurement, regulatory, and hiring signals.

This includes angel, seed, Pre-A, Series A, Series B, growth equity, PE, private placement, and
other unlisted-company financing signals. Because primary-market transactions often do not disclose
amount, valuation, cap table, revenue, or customer names, the skill treats missing terms as
**undisclosed / to verify**, not as automatic negative evidence.

**Deliverables**
- **Opportunity quick takes** - concise verdict, score, risks, and next actions.
- **Private-company memos** - structured investment-style memos for unlisted targets.
- **Batch screening tables** - rank many signals and identify what to contact, watch, or filter.
- **Diligence question lists** - targeted checks for ownership, IP, customers, cap table, and
  commercialization readiness.

## Secondary-Market Filter

This skill is not designed for public-stock research by default. It filters or down-ranks:

- Stock price movements, broker ratings, buy/sell/hold calls, EPS beats/misses.
- Listed-company earnings previews / digests when there is no private-company implication.
- Index, ETF, trading, and technical-analysis commentary.

Public-company information is kept only as context when it validates a private-market opportunity,
such as strategic investment, M&A appetite, public comparables, customer demand, supply-chain pull,
or IPO / exit pathway evidence.

## Installation

### Option 1: Build From Source

If you want to customize the skill to match your firm's standards and templates:

```bash
./scripts/build-skill.sh <version>
```

For example:

```bash
./scripts/build-skill.sh 1.0.0
```

Find the package at:

```bash
scripts/output/bigdata-financial-research-analyst_<version>.skill
```

### Option 2: Use As Local Reference

You can also use the Markdown files directly as analysis prompts, scoring rubrics, or templates
inside another application.

## Important Files

- `bigdata-financial-research-analyst/SKILL.md` - main routing and behavior rules.
- `bigdata-financial-research-analyst/references/private_company/main.md` - private-market
  filtering and scoring rubric.
- `bigdata-financial-research-analyst/assets/templates/opportunity-quick-take.md` - quick screen
  template.
- `bigdata-financial-research-analyst/assets/templates/private-company-memo.md` - full memo
  template.

## Requirements

The original skill expected Bigdata.com MCP tools for external financial data. This customized
version can also work with your own collected data, such as news crawlers, WeChat articles, arXiv,
patents, university technology-transfer pages, and financing news.

## License

See [LICENSE](LICENSE) for details.
