# Evidence Policy

## Contents

1. Evidence ledger
2. Status taxonomy
3. Commercial and technical state machines
4. Source hierarchy
5. Conflict handling
6. Writing rules

## 1. Evidence ledger

Create one `evidence.json` per project:

```json
{
  "project": {
    "name": "Project name",
    "legal_entity": "Exact legal entity",
    "cutoff_date": "YYYY-MM-DD",
    "currency": "CNY"
  },
  "facts": [
    {
      "id": "F001",
      "statement": "Exact, atomic fact",
      "entity": "Entity to which it applies",
      "period": "2025A or 2026-06-30",
      "unit": "CNY 10k / units / % / n.a.",
      "source": "/absolute/path/file.pdf#page=8",
      "source_type": "primary_document",
      "status": "verified",
      "materiality": "high",
      "conflicts": [],
      "notes": "Scope and limitations"
    }
  ]
}
```

Keep facts atomic. Split a sentence when its clauses have different sources or verification status.

## 2. Status taxonomy

- `verified`: supported by original or authoritative evidence inspected by the analyst.
- `third_party_confirmed`: confirmed by an identifiable independent counterparty or expert; record interview date and role.
- `public_fact`: supported by a current authoritative public source.
- `company_claim`: provided by management without sufficient independent verification.
- `analyst_estimate`: calculated from disclosed assumptions; preserve formula and sensitivity.
- `analyst_judgment`: reasoned interpretation; cite underlying facts.
- `unverified`: material assertion for which adequate evidence is absent.
- `conflicted`: credible sources disagree or internal records do not reconcile.

Never upgrade status because a claim appears in multiple company-controlled documents.

## 3. State machines

Commercial status must remain explicit:

`lead -> discussion -> non-binding intention -> framework agreement -> binding order -> delivery -> acceptance -> revenue recognition -> invoice -> cash collection -> repeat purchase`

Technical status must remain explicit:

`concept -> design -> simulation -> prototype -> internal test -> third-party test -> customer test -> qualification -> pilot production -> mass production -> stable field operation`

Regulatory and clinical status must remain explicit:

`research -> pre-submission -> application accepted -> review -> clinical trial -> primary endpoint -> approval/registration -> market access -> hospital adoption -> reimbursement -> commercial sales`

Do not collapse adjacent stages. State the exact date, scope, quantity, acceptance standard, and remaining condition.

## 4. Source hierarchy

Prefer, in order:

1. signed contracts, bank statements, invoices, acceptance records, audited ledgers, regulatory decisions, official registries, patent records, raw test reports;
2. identifiable customer/supplier/expert interviews and independently issued reports;
3. company operational systems, management accounts, board materials, formal written responses;
4. authoritative public databases and primary research publications;
5. company BP, marketing material, press releases, media summaries;
6. analyst assumptions.

For material market, policy, technical, clinical, valuation, or competitor data, record title, publisher, date, page/table, URL when public, geography, currency, and unit.

Before classifying an externally verifiable item as absent, search current official registries, regulator and court databases, patent/trademark records, government procurement and tender platforms, company disclosures, authoritative standards and primary research. Log the search terms, date and result. Public research can verify public facts but cannot stand in for private contracts, ledgers, customer lists, bank statements or cap-table instruments.

## 5. Conflict handling

For every conflict:

1. preserve both values and sources;
2. test entity, period, tax, currency, gross/net, consolidated/standalone, contract/revenue/cash, and forecast/actual differences;
3. determine which value is safe to use;
4. quantify decision impact;
5. add a diligence request or transaction condition when unresolved.

Never average incompatible facts.

## 6. Writing rules

- Attach evidence IDs to factual blocks in `report.json`.
- Label management targets and analyst forecasts explicitly.
- Use “截至[date]” for current status.
- Use `A`, `E`, and scenario labels consistently.
- State sample size and interview role for validation claims.
- Do not cite anonymous interviews as independent confirmation when identity and authority cannot be assessed.
- Keep unresolved issues in the internal evidence ledger and, when reader action requires it, one concise final “尽调缺口/资料请求” appendix. In the main body, state their valuation, transaction-condition, risk-trigger or recommendation consequence rather than the document request itself.
