import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { runLeadEnrichmentSnapshotPostCommit } from '../src/services/leadEnrichmentSnapshotPostCommit.js'
import {
  leadInvestmentProfileBackfillQualityFailures,
  leadInvestmentProfileProjectionQualityFailures,
} from '../src/services/leadInvestmentProfileBackfillQuality.js'
import { leadInvestmentProfileProjectionFingerprint } from '../src/services/leadInvestmentProfileProjectionService.js'

const root = resolve(import.meta.dirname, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

test('0092 profile base through 0095 research projection migrations stay aligned', () => {
  const journal = JSON.parse(read('drizzle/meta/_journal.json')) as { entries: Array<{ idx: number; tag: string }> }
  assert.deepEqual(journal.entries.at(-1), {
    idx: 95, version: '5', when: 1791791343000, tag: '0095_add_lead_research_profile_projections', breakpoints: true,
  })
  const migration = read('drizzle/0092_add_lead_investment_profiles.sql')
  const v4Migration = read('drizzle/0093_add_lead_enrichment_job_schema_version.sql')
  const ratingGuardMigration = read('drizzle/0094_guard_shared_lead_v4_auto_rating.sql')
  for (const field of ['schema_version', 'profile_payload', 'dictionary_binding', 'projection_version', 'customer_total_count']) {
    assert.match(v4Migration, new RegExp(field))
  }
  assert.match(ratingGuardMigration, /request_mode/)
  assert.match(ratingGuardMigration, /automatic V3 rating is disabled for shared-lead V4 snapshots/)
  assert.match(ratingGuardMigration, /lead-enrichment-v4-investment-profile/)
  assert.match(ratingGuardMigration, /BEFORE INSERT/)
  assert.match(ratingGuardMigration, /BEFORE UPDATE/)
  const scoringService = read('src/services/leadScoreJobService.ts')
  const scoringRoute = read('src/routes/meta.ts')
  assert.match(scoringService, /requestMode\?: 'automatic' \| 'manual' \| 'dedicated_project'/)
  assert.match(scoringRoute, /requestMode: 'manual'/)
  assert.match(scoringRoute, /requestMode: 'dedicated_project'/)
  for (const table of [
    'lead_institution_dictionary', 'lead_customer_dictionary', 'lead_industry_dictionary',
    'lead_academic_institution_dictionary', 'lead_investment_profile_projections',
  ]) assert.match(migration, new RegExp('CREATE TABLE `sbl_' + table + '`'))
  assert.match(migration, /highest_customer_stage/)
  assert.match(migration, /tier_b_customer_count/)
  assert.match(migration, /tier_c_customer_count/)
  assert.match(migration, /valuation_value/)
  assert.match(migration, /has_major_institution/)
  assert.match(migration, /dictionary_hash/)
  assert.match(migration, /`confidentiality` varchar\(16\) NOT NULL/)
  for (const constraint of [
    'ck_lead_customer_dictionary_tier',
    'ck_lead_customer_dictionary_confidentiality',
    'ck_lead_investment_profile_counts',
    'ck_lead_investment_profile_status',
    'ck_lead_investment_profile_customer_stage',
  ]) assert.match(migration, new RegExp(constraint))
  assert.match(migration, /`status` IN \('active','inactive'\)/)
  assert.match(migration, /`profile_status` IN \('verified','partial','conflicted','missing','not_applicable','stale'\)/)
  for (const column of [
    'product_route_search_text', 'production_stage_search_text',
    'academic_institution_search_text', 'academic_relation_search_text',
  ]) assert.match(migration, new RegExp(column))
  for (const index of [
    'idx_lead_investment_profiles_funding_sort',
    'idx_lead_investment_profiles_valuation_sort',
    'idx_lead_investment_profiles_updated_sort',
    'idx_lead_investment_profiles_customer_tier_a',
    'idx_lead_investment_profiles_customer_tier_b',
    'idx_lead_investment_profiles_customer_tier_c',
  ]) assert.match(migration, new RegExp(index))
  const schema = read('src/db/schema.ts')
  const runtime = read('src/db/migrate.ts')
  for (const table of [
    'lead_institution_dictionary', 'lead_customer_dictionary', 'lead_industry_dictionary',
    'lead_academic_institution_dictionary', 'lead_investment_profile_projections',
  ]) {
    assert.match(schema, new RegExp(`mysqlTable\\('${table}'`))
    assert.match(runtime, new RegExp(`'${table}'`))
  }
})

test('the main service verifies schema without applying DDL during startup', () => {
  const source = read('src/index.ts')
  assert.match(source, /import \{ assertSchemaReady \} from '\.\/db\/migrate\.js'/)
  assert.match(source, /await assertSchemaReady\(\)/)
  assert.doesNotMatch(source, /ensureSchema/)
})

test('backfill is preview by default and requires an explicit apply guard', () => {
  const source = read('src/scripts/backfillLeadInvestmentProfiles.ts')
  assert.match(source, /process\.argv\.includes\('--apply'\)/)
  assert.match(source, /ALLOW_LEAD_INVESTMENT_PROFILE_BACKFILL/)
  assert.match(source, /mode: 'preview'/)
  assert.match(source, /process\.argv\.includes\('--force'\)/)
  assert.match(source, /p\.profile_status='stale'/)
  assert.match(source, /refreshLeadInvestmentProfileProjection/)
})

test('backfill preview reports coverage, source volume, calls and risks while apply requires an auditable target set', () => {
  const source = read('src/scripts/backfillLeadInvestmentProfiles.ts')
  for (const field of ['never', 'stale', 'conflicted', 'ready', 'topics', 'sources', 'estimatedCalls', 'risks', 'canaryCandidates']) {
    assert.match(source, new RegExp(field))
  }
  for (const scenario of [
    'company', 'research', 'unfinanced', 'multiple_financing_rounds', 'valuation_conflict',
    'academic_commercialization', 'confidential_customer', 'verified_customer_action', 'ready_snapshot',
    'review_snapshot', 'coverage_fallback',
  ]) assert.match(source, new RegExp(`'${scenario}'`))
  assert.match(source, /apply requires --batch-id/)
  assert.match(source, /apply requires --lead-ids=<id,\.\.\.> or explicit --all-pending/)
  assert.match(source, /model: 0/)
  assert.match(source, /--canary-profiles/)
  assert.match(source, /previewLeadInvestmentProfileProjection/)
  assert.match(source, /publicLeadInvestmentProfile/)
  assert.match(source, /databaseWrites: 0/)
  assert.match(source, /eligibleSnapshotFacts/)
  assert.match(source, /investmentFactEligibility/)
  assert.match(source, /zeroHttpEligibleDimensions/)
  assert.match(source, /verifiedLeadCount/)
  assert.match(source, /evidenceBoundLeadCount/)
  assert.match(source, /httpEligible = investment-profile fact verified/)
  for (const dimension of ['industryProduct', 'institutions', 'academic', 'financing', 'valuation', 'customers']) {
    assert.match(source, new RegExp(`${dimension}:`))
  }
  assert.match(source, /verificationStatus !== 'verified'/)
  assert.match(source, /\^https\?:\\\/\\\//)
  assert.match(source, /mapInBatches\(candidatePool/)
  assert.match(source, /--reenrichment-targets/)
  assert.match(source, /selectReenrichmentTargets/)
  assert.match(source, /estimatedSearchCallsUpperBound/)
  assert.match(source, /Discovery dimensions are hypotheses, not verified facts/)
  assert.match(source, /reenrichment target preview does not authorize model calls/)
})

test('backfill apply fails closed when raw dimensions have no projection-eligible evidence', () => {
  const blocked = leadInvestmentProfileBackfillQualityFailures({
    facts: { raw: 2, verified: 1, evidenceBound: 1, httpEligible: 1 },
    dimensions: {
      industryProduct: { rawLeadCount: 1, verifiedLeadCount: 1, evidenceBoundLeadCount: 1, httpEligibleLeadCount: 1 },
      institutions: { rawLeadCount: 1, verifiedLeadCount: 0, evidenceBoundLeadCount: 0, httpEligibleLeadCount: 0 },
    },
  })
  assert.deepEqual(blocked, [
    'institutions: raw facts exist but no verified HTTP(S)-evidence-bound fact is eligible',
  ])
  assert.deepEqual(leadInvestmentProfileBackfillQualityFailures({
    facts: { raw: 1, verified: 1, evidenceBound: 1, httpEligible: 1 },
    dimensions: {
      financing: { rawLeadCount: 1, verifiedLeadCount: 1, evidenceBoundLeadCount: 1, httpEligibleLeadCount: 1 },
    },
  }), [])
  const source = read('src/scripts/backfillLeadInvestmentProfiles.ts')
  assert.match(source, /qualityBlockedTargets/)
  assert.match(source, /apply blocked by investment profile evidence quality gate/)
  assert.ok(source.indexOf('qualityBlockedTargets') < source.indexOf("open(receiptPath, 'wx')"))
})

test('backfill apply rejects evidence-shaped facts whose deterministic projection is still missing', () => {
  assert.deepEqual(leadInvestmentProfileProjectionQualityFailures(null), [
    'deterministic projection preview is unavailable',
  ])
  assert.deepEqual(leadInvestmentProfileProjectionQualityFailures({
    dataStatus: { verifiedDimensions: 0, status: 'missing' },
  }), ['deterministic projection preview has no verified investment-profile dimension'])
  assert.deepEqual(leadInvestmentProfileProjectionQualityFailures({
    dataStatus: { verifiedDimensions: 1, status: 'partial' },
  }), [])
  const source = read('src/scripts/backfillLeadInvestmentProfiles.ts')
  assert.match(source, /previewLeadInvestmentProfileProjection\(\{\s*leadId: row\.lead_id,\s*snapshotId: row\.snapshot_id/)
  assert.match(source, /leadInvestmentProfileProjectionQualityFailures\(preview\)/)
  assert.ok(source.indexOf('qualityBlockedTargets') < source.indexOf("open(receiptPath, 'wx')"))
})

test('backfill apply isolates per-lead failures and emits a nonzero recoverable batch receipt', () => {
  const source = read('src/scripts/backfillLeadInvestmentProfiles.ts')
  assert.match(source, /const succeeded:/)
  assert.match(source, /const failures:/)
  assert.match(source, /selected frozen snapshot is no longer available/)
  assert.match(source, /recovery: \{ retryLeadIds: failures\.map/)
  assert.match(source, /if \(failures\.length\) process\.exitCode = 1/)
  assert.match(source, /modelCalls: 0/)
})

test('backfill apply appends a durable per-lead NDJSON receipt for interruption recovery', () => {
  const source = read('src/scripts/backfillLeadInvestmentProfiles.ts')
  assert.match(source, /lead-investment-profile-backfill/)
  assert.match(source, /open\(receiptPath, 'wx'\)/)
  assert.match(source, /receiptFile\.sync\(\)/)
  assert.match(source, /appendReceipt\('batch_start'/)
  assert.match(source, /appendReceipt\('batch_targets'/)
  assert.match(source, /appendReceipt\('lead_succeeded'/)
  assert.match(source, /appendReceipt\('lead_failed'/)
  assert.match(source, /appendReceipt\('batch_complete'/)
  assert.match(source, /appendReceipt\('batch_aborted'/)
  assert.match(source, /batch receipt already exists/)
  assert.match(source, /--all-pending and --lead-ids are mutually exclusive target modes/)
  assert.match(source, /--force requires an explicit --lead-ids/)
  assert.match(source, /--batch-id must use 1-100 safe filename characters/)
})

test('a new snapshot marks the previous projection stale before replacement and refreshes after commit', () => {
  const source = read('src/services/leadEnrichmentService.ts')
  const staleAt = source.indexOf("SET profile_status='stale'")
  const commitAt = source.indexOf('await connection.commit()', staleAt)
  const releaseAt = source.indexOf('connection.release()', commitAt)
  const refreshAt = source.indexOf('runLeadEnrichmentSnapshotPostCommit', commitAt)
  assert.ok(staleAt > 0)
  assert.ok(commitAt > staleAt)
  assert.ok(releaseAt > commitAt)
  assert.ok(refreshAt > releaseAt)
  assert.match(source.slice(staleAt, commitAt), /snapshot_hash<>\?/)
  assert.match(source, /if \(!transactionCommitted\) await connection\.rollback\(\)/)
})

test('post-commit projection failures are recorded without turning a frozen snapshot into a topic retry', async () => {
  const calls: string[] = []
  const recorded: Array<{ step: string; message: string }> = []
  const result = await runLeadEnrichmentSnapshotPostCommit({ enqueueRating: true }, {
    refreshEnrichmentProjection: async () => { calls.push('enrichment') },
    refreshInvestmentProfileProjection: async () => {
      calls.push('investment')
      throw new Error('projection unavailable')
    },
    enqueueRating: async () => { calls.push('rating'); return false },
    recordFailures: async (failures) => { recorded.push(...failures) },
  })

  assert.deepEqual(calls, ['enrichment', 'investment', 'rating'])
  assert.equal(result.enrichmentProjectionRefreshed, true)
  assert.equal(result.investmentProfileRefreshed, false)
  assert.equal(result.autoScoreEnqueued, false)
  assert.deepEqual(result.failures.map((failure) => failure.step), ['investment_profile_projection'])
  assert.deepEqual(recorded, result.failures)
})

test('profile audit is read-only and checks snapshots, confidentiality, indexes and query plans', () => {
  const source = read('src/scripts/leadInvestmentProfileAudit.ts')
  assert.match(source, /invalid_snapshot_binding/)
  assert.match(source, /invalid_schema_version/)
  assert.match(source, /latest_snapshot_mismatch/)
  assert.match(source, /source_fact_snapshot_mismatch/)
  assert.match(source, /source_fact_without_http_evidence/)
  assert.match(source, /fresh_dictionary_mismatch/)
  assert.match(source, /p\.profile_status<>'stale'/)
  assert.match(source, /missingTableNames/)
  assert.match(source, /exposed_confidential_name/)
  assert.match(source, /d\.confidentiality<>'public'/)
  assert.match(source, /JSON_TABLE\(\s*COALESCE\(d\.aliases/)
  assert.match(source, /information_schema\.statistics/)
  assert.match(source, /information_schema\.table_constraints/)
  assert.match(source, /requiredCheckConstraints/)
  assert.match(source, /not_evaluable_empty_projection/)
  assert.match(source, /EXPLAIN SELECT lead_id/)
  assert.match(source, /customerTierPlans/)
  assert.match(source, /sortPlans/)
  assert.match(source, /databaseWrites: 0/)
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP)\b/i)
})

test('profile refresh is bound to frozen snapshot facts, evidence and dictionary version', () => {
  const source = read('src/services/leadInvestmentProfileProjectionService.ts')
  const dictionary = read('src/services/leadInvestmentProfileDictionary.ts')
  assert.match(source, /SELECT s\.id,s\.snapshot_hash,s\.schema_version,s\.status,s\.frozen_at,s\.subject_profile,s\.facts,s\.conflicts/)
  assert.match(source, /s\.schema_version=\?/)
  assert.match(source, /snapshot\.status !== 'ready' && snapshot\.status !== 'review'/)
  assert.match(source, /snapshotFactById/)
  assert.match(source, /snapshotEvidencePairs/)
  assert.match(source, /buildLeadInvestmentProfileDictionaries/)
  assert.match(source, /dictionary_hash/)
  assert.match(source, /profileConflictCount/)
  assert.match(source, /isLeadInvestmentProfileFactKey\(conflict\.factKey \?\? conflict\.fact_key\)/)
  assert.match(dictionary, /createHash\('sha256'\)/)
  assert.match(dictionary, /dictionary alias collision/)
  assert.doesNotMatch(source, /f\.is_current=1/)
  const previewReturn = source.indexOf('if (!persist) return { profile, write: null }')
  const projectionWrite = source.indexOf('await pool.query(', previewReturn)
  assert.ok(previewReturn > 0 && projectionWrite > previewReturn)
  assert.match(source, /export async function previewLeadInvestmentProfileProjection/)
})

test('projection input fingerprints make identical rebuilds a changed=false no-op', () => {
  const input = { schemaVersion: 'lead-investment-profile-v1', snapshotHash: 'snapshot-a', dictionaryHash: 'dictionary-a' }
  const fingerprint = leadInvestmentProfileProjectionFingerprint(input)
  assert.equal(fingerprint, leadInvestmentProfileProjectionFingerprint(input))
  assert.notEqual(fingerprint, leadInvestmentProfileProjectionFingerprint({ ...input, snapshotHash: 'snapshot-b' }))
  const source = read('src/services/leadInvestmentProfileProjectionService.ts')
  assert.match(source, /beforeFingerprint === afterFingerprint && existing\?\.profile_status !== 'stale'/)
  assert.match(source, /changed: false, beforeFingerprint, afterFingerprint/)
  const backfill = read('src/scripts/backfillLeadInvestmentProfiles.ts')
  assert.match(backfill, /refreshLeadInvestmentProfileProjectionWithReceipt/)
  assert.match(backfill, /changed: projectionReceipt!\.changed/)
  assert.match(backfill, /beforeFingerprint: projectionReceipt!\.beforeFingerprint/)
  assert.match(backfill, /afterFingerprint: projectionReceipt!\.afterFingerprint/)
})

test('profile projection excludes frozen facts without an HTTP or HTTPS evidence source', () => {
  const source = read('src/services/leadInvestmentProfileProjectionService.ts')
  assert.match(source, /SELECT id,fact_id,source_url FROM \$\{evidenceTable\}/)
  assert.match(source, /publicEvidenceFactIds/)
  assert.match(source, /\^https\?:\\\/\\\//)
  assert.match(source, /factRows\.filter\(\(row\) => publicEvidenceFactIds\.has\(row\.id\)\)/)
})

test('detail investment profile evidence is marked by the current projection snapshot without exposing source fact ids', () => {
  const enrichment = read('src/services/leadEnrichmentService.ts')
  const detail = read('../src/pages/LeadDetailPage.tsx')
  assert.match(enrichment, /JSON_CONTAINS\(profile\.source_fact_ids,JSON_QUOTE\(display_fact\.id\)\)/)
  assert.match(enrichment, /investmentProfileSource: Boolean\(row\.investment_profile_source\)/)
  assert.match(detail, /fact\.investmentProfileSource === true/)
  assert.doesNotMatch(detail, /sourceFactIds/)
})

test('browser fixture distinguishes candidate validation from the currently served build', () => {
  const source = read('src/scripts/leadPoolBrowserFixture.ts')
  assert.match(source, /process\.argv\.includes\('--served-build'\)/)
  assert.match(source, /process\.argv\.includes\('--source'\)/)
  assert.match(source, /--served-build and --source are mutually exclusive/)
  assert.match(source, /\.runtime\/build-candidate\.json/)
  assert.match(source, /\.runtime\/build-rollback\.json/)
  assert.match(source, /path\.resolve\(process\.cwd\(\), 'dist'\)/)
  assert.match(source, /mkdtemp/)
  assert.match(source, /sbl-lead-pool-browser-source-/)
  assert.match(source, /build: \{ outDir: distDir, emptyOutDir: true \}/)
  assert.match(source, /rm\(temporaryRoot, \{ recursive: true, force: true \}\)/)
  assert.match(source, /let closingPromise: Promise<void> \| null = null/)
  assert.match(source, /if \(closingPromise\) return closingPromise/)
  assert.match(source, /\.catch\(\(error\) =>/)
  assert.match(source, /buildSource: sourceBuild \? 'source' : servedBuild \? 'served' : 'candidate'/)
})

test('investment profile projection SQL columns, placeholders and bind values stay aligned', () => {
  const path = 'src/services/leadInvestmentProfileProjectionService.ts'
  const source = read(path)
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let checked = false
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments.length >= 2 && ts.isTemplateExpression(node.arguments[0])) {
      const statement = node.arguments[0].getText(sourceFile)
      if (statement.includes('INSERT INTO ${projectionsTable}')) {
        const parameters = node.arguments[1]
        assert.ok(ts.isArrayLiteralExpression(parameters), 'projection bind values must be an array literal')
        assert.equal((statement.match(/\?/g) ?? []).length, parameters.elements.length)
        checked = true
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  assert.equal(checked, true, 'investment profile projection INSERT was not inspected')
})

test('route, stage and academic filters use their semantic projection columns', () => {
  const projection = read('src/services/leadInvestmentProfileProjectionService.ts')
  const query = read('src/services/aiSummaryService.ts')
  for (const field of [
    'productRouteSearchText', 'productionStageSearchText',
    'academicInstitutionSearchText', 'academicRelationSearchText',
  ]) {
    assert.match(projection, new RegExp(field))
    assert.match(query, new RegExp(`leadInvestmentProfileProjections\\.${field}`))
  }
  assert.match(projection, /productionStageStatus === 'realized'/)
})

test('all customer tiers filter against full projection counts rather than truncated representatives', () => {
  const schema = read('src/db/schema.ts')
  const query = read('src/services/aiSummaryService.ts')
  for (const field of ['tierACustomerCount', 'tierBCustomerCount', 'tierCCustomerCount']) {
    assert.match(schema, new RegExp(field))
    assert.match(query, new RegExp(`${field}\\} > 0`))
  }
  assert.doesNotMatch(query, /JSON_SEARCH\([^\n]*customerRepresentatives[^\n]*tier/)
})

test('never and missing profile states remain separately filterable', () => {
  const query = read('src/services/aiSummaryService.ts')
  const contract = read('src/contracts/leadPoolQueryContract.ts')
  assert.match(contract, /'never', 'verified'/)
  assert.match(query, /profileStatus === 'never'/)
  assert.match(query, /isNull\(leadInvestmentProfileProjections\.leadId\)/)
  assert.match(query, /eq\(leadInvestmentProfileProjections\.profileStatus, options\.profileStatus\)/)
})

test('investment profile dictionaries have an audited, versioned and admin-only maintenance path', () => {
  const route = read('src/routes/systemAdministration.ts')
  const service = read('src/services/leadInvestmentProfileDictionaryService.ts')
  const page = read('../src/pages/SystemPage.tsx')
  assert.ok(route.indexOf('systemAdministrationRouter.use(requireSystemAdmin)')
    < route.indexOf("systemAdministrationRouter.get('/investment-profile-dictionaries'"))
  assert.match(route, /investment-profile-dictionaries\/institutions/)
  assert.match(route, /investment-profile-dictionaries\/customers/)
  assert.match(route, /investment-profile-dictionaries\/industries/)
  assert.match(route, /investment-profile-dictionaries\/academic-institutions/)
  assert.match(route, /expectedVersion: z\.number\(\)\.int\(\)\.positive\(\)/)
  assert.match(route, /reason: ruleReason/)
  assert.match(service, /INVESTMENT_DICTIONARY_ALIAS_CONFLICT/)
  assert.match(service, /current\.version !== input\.expectedVersion/)
  assert.match(service, /profileStatus: 'stale'/)
  assert.match(service, /identity\.audits\.append/)
  assert.match(service, /listPermissionCodes\(administrator\.id\)/)
  assert.match(page, /investment-profile-dictionaries\/institutions/)
  assert.match(page, /investment-profile-dictionaries\/customers/)
  assert.match(page, /investment-profile-dictionaries\/industries/)
  assert.match(page, /investment-profile-dictionaries\/academic-institutions/)
  assert.match(page, /确认为重点机构/)
  assert.match(page, /变更原因/)
  assert.match(page, /请选择已确认等级/)
  assert.match(page, /请选择保密要求/)
  assert.match(page, /expectedVersion: editing\.version/)
})
