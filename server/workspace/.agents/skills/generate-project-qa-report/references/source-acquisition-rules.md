# Multi-Source Acquisition Rules

## Contents

1. Source-channel priority
2. Conversation input
3. Attachments and user-referenced files
4. Databases, warehouses, APIs, and connectors
5. Workspace files
6. Public web
7. Provenance and conflict rules
8. Access failure

## Source-channel priority

Build the source inventory from:

1. current conversation text and pasted tables;
2. attachments and explicitly referenced files/URLs;
3. user-authorized databases, warehouses, APIs, connected apps, and remote resources;
4. workspace files explicitly placed in scope;
5. lawful public-web sources for remaining gaps.

Do not presume the source material exists in the project directory. Keep source acquisition separate from output location.

Do not automatically read unrelated workspace files, browser history, connected apps, or databases.

## Conversation input

Treat information typed or pasted by the user as a source:

- record `用户在当前对话中提供`;
- record the conversation date;
- preserve the user's qualifiers, uncertainty, units, and time period;
- distinguish first-hand user statements from copied third-party text;
- do not upgrade a user claim to independently verified evidence.

If the user provides a table without clear column definitions, units, period, or status, infer only when safe and label the inference. Ask when the ambiguity can change the conclusion.

Do not place hidden reasoning, credentials, payment identifiers, direct personal contact details, or unrelated sensitive information into the report or evidence ledger.

## Attachments and user-referenced files

Use the exact attachments or referenced resources made available in the task. Apply the corresponding PDF, document, presentation, or spreadsheet workflow when available.

Record:

- original filename or resource title;
- page, section, slide, sheet, table, or cell range;
- document date and version;
- data period and unit;
- whether content is complete, truncated, redacted, or image-only.

When a file has no filesystem path, use the platform's attachment/resource access method. Do not require the user to move it into the project directory.

## Databases, warehouses, APIs, and connectors

Use a purpose-built connector, database tool, or authorized API before attempting indirect extraction.

### Authorization and scope

- Access only systems and datasets the user has authorized for the task.
- Use read-only operations.
- Never run insert, update, delete, merge, DDL, permission, administration, or export-to-public operations.
- Apply data minimization: query only necessary fields, entities, and periods.
- Do not retrieve credentials, tokens, secrets, or unrelated personal data.
- Respect row-level, column-level, regional, contractual, and confidentiality restrictions.

### Query workflow

1. Inspect available schema/resource metadata.
2. Identify the table/view grain, primary dimensions, measures, units, and date fields.
3. Define the report claim that the query will support.
4. Use bounded filters and deterministic ordering.
5. Check row count, nulls, duplicates, truncation, time coverage, and freshness.
6. Review returned rows before using aggregates.
7. Reconcile query results with user-supplied and public claims.

Prefer an existing governed metric or semantic definition. If no definition exists, state the calculation explicitly.

### Database provenance

Record:

- connector or source-system name;
- database/catalog, schema, and table/view;
- human-readable query purpose;
- SQL or query identifier when safe and useful;
- filters and excluded records;
- row grain and aggregation;
- query/retrieval timestamp;
- data coverage period;
- units, currency, and timezone;
- row count and truncation status;
- known access or completeness limitations.

Do not expose secrets, confidential SQL comments, personal identifiers, or infrastructure details that are not needed for review.

### Data quality

Before citing a database result, check:

- freshness and last updated time;
- missing or duplicate records;
- joins and grain consistency;
- denominator and exclusion definitions;
- timezone and fiscal/calendar periods;
- actual, forecast, target, and pipeline status;
- whether the result is complete or sampled.

If material data quality is uncertain, mark the claim `[数据质量待核验]` and describe the limitation.

## Workspace files

Use workspace files only when:

- the user names the file/directory;
- the task explicitly says the materials are in the workspace; or
- file names and current context make their scope unambiguous.

Do not recursively treat all files in the working directory as project evidence. Preserve unrelated user files and changes.

## Public web

Use public-web research only after inventorying user-provided and authorized sources, unless the user explicitly requests web-first research.

Follow [research-and-compliance-rules.md](research-and-compliance-rules.md). Public sources may validate or supplement internal information but do not automatically override governed internal data; compare definitions and dates.

## Provenance and conflict rules

Use source types:

- conversation;
- attachment/file;
- database/warehouse;
- authorized connector/API;
- public web;
- calculation/inference.

When sources conflict:

1. preserve both claims;
2. compare date, scope, definition, unit, and evidence grade;
3. do not silently prefer database, user, or web data;
4. explain the chosen basis;
5. retain unresolved conflicts in the gap list.

Treat internal data as authoritative only for the metric and scope it governs. Treat public records as authoritative only within their legal and reporting scope.

## Access failure

If a database, connector, attachment, or remote resource is unavailable:

- do not claim it was reviewed;
- record the access limitation;
- use other lawful sources where appropriate;
- ask the user for an export or authorization only when the missing source materially blocks the report;
- preserve the unresolved item rather than inventing data.
