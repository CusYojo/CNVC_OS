import type { RowDataPacket } from 'mysql2'
import { mkdir, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pool } from '../db/client.js'
import { mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import type { LeadEnrichmentTopicKey } from '../services/leadEnrichmentContract.js'
import {
  previewLeadInvestmentProfileProjection,
  publicLeadInvestmentProfile,
  refreshLeadInvestmentProfileProjectionWithReceipt,
} from '../services/leadInvestmentProfileProjectionService.js'
import { isLeadInvestmentProfileFactKey } from '../services/leadInvestmentProfileService.js'
import {
  leadInvestmentProfileBackfillQualityFailures,
  leadInvestmentProfileProjectionQualityFailures,
} from '../services/leadInvestmentProfileBackfillQuality.js'

const apply = process.argv.includes('--apply')
const force = process.argv.includes('--force')
const allPending = process.argv.includes('--all-pending')
const canaryProfiles = process.argv.includes('--canary-profiles')
const reenrichmentTargets = process.argv.includes('--reenrichment-targets')
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1]
const limit = Math.min(10_000, Math.max(1, Number.parseInt(limitArg || '500', 10) || 500))
const batchId = process.argv.find((arg) => arg.startsWith('--batch-id='))?.slice('--batch-id='.length).trim() || ''
const leadIds = [...new Set((process.argv.find((arg) => arg.startsWith('--lead-ids='))?.slice('--lead-ids='.length) || '')
  .split(',').map((value) => value.trim()).filter(Boolean))]
const snapshotsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_snapshots'))
const profilesTable = quoteMysqlIdentifier(mysqlTableName('lead_investment_profile_projections'))

const CANARY_SCENARIOS = [
  'company', 'research', 'unfinanced', 'multiple_financing_rounds', 'valuation_conflict',
  'academic_commercialization', 'confidential_customer', 'verified_customer_action', 'ready_snapshot',
  'review_snapshot', 'coverage_fallback',
] as const
type CanaryScenario = typeof CANARY_SCENARIOS[number]

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function objectValue(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

function arrayValue(value: unknown): Array<Record<string, unknown>> {
  const parsed = jsonValue(value)
  return Array.isArray(parsed)
    ? parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : []
}

function factKey(value: Record<string, unknown>): string {
  return String(value.factKey ?? value.fact_key ?? '').trim()
}

function factEvidenceIds(fact: Record<string, unknown>): string[] {
  const values = Array.isArray(fact.evidenceIds) ? fact.evidenceIds
    : Array.isArray(fact.evidence_ids) ? fact.evidence_ids : []
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))]
}

function factHasBoundEvidence(fact: Record<string, unknown>, evidenceIndex: Record<string, unknown>): boolean {
  return factEvidenceIds(fact).some((evidenceId) => Object.keys(objectValue(evidenceIndex[evidenceId])).length > 0)
}

function factHasHttpEvidence(fact: Record<string, unknown>, evidenceIndex: Record<string, unknown>): boolean {
  return factEvidenceIds(fact).some((evidenceId) => {
    const evidence = objectValue(evidenceIndex[evidenceId])
    const sourceUrl = String(evidence.sourceUrl ?? evidence.source_url ?? '').trim()
    return /^https?:\/\//i.test(sourceUrl)
  })
}

function eligibleSnapshotFacts(row: { facts: unknown; evidence_index: unknown }) {
  const evidenceIndex = objectValue(row.evidence_index)
  return arrayValue(row.facts).filter((fact) => {
    if (fact.verificationStatus !== 'verified' && fact.verification_status !== 'verified') return false
    return factHasHttpEvidence(fact, evidenceIndex)
  })
}

const ELIGIBILITY_DIMENSIONS = {
  industryProduct: /^(?:industry\.|profile\.industry$|product\.|profile\.product$|technology\.route$|production\.stage$)/,
  institutions: /^financing\.(?:investors|lead_investor|investor_role)$/,
  academic: /^(?:team\.(?:institution|institution_relation|department_lab|institution_period)|technology\.transfer_status)$/,
  financing: /^(?:financing\.(?:status|round|date|amount|currency)|transaction\.(?:round|date|currency))$/,
  valuation: /^transaction\.(?:valuation|pre_money|post_money)$/,
  customers: /^(?:customer\.|contract\.|order\.|delivery\.|cash_collection\.)/,
} as const
type EligibilityDimension = keyof typeof ELIGIBILITY_DIMENSIONS

const REENRICHMENT_TOPICS: Record<EligibilityDimension, readonly LeadEnrichmentTopicKey[]> = {
  industryProduct: ['products', 'technology_ip', 'industrialization'],
  institutions: ['financing'],
  academic: ['team', 'technology_ip'],
  financing: ['financing'],
  valuation: ['financing', 'transaction_exit'],
  customers: ['customers_contracts'],
}

function dimensionsForFactKey(key: string): EligibilityDimension[] {
  return (Object.entries(ELIGIBILITY_DIMENSIONS) as Array<[EligibilityDimension, RegExp]>)
    .filter(([, matcher]) => matcher.test(key))
    .map(([dimension]) => dimension)
}

function investmentFactEligibility(rows: Array<{ lead_id: string; facts: unknown; evidence_index: unknown }>) {
  type KeyCounter = {
    rawFacts: number; verifiedFacts: number; evidenceBoundFacts: number; httpEligibleFacts: number;
    rawLeads: Set<string>; verifiedLeads: Set<string>; evidenceBoundLeads: Set<string>; httpEligibleLeads: Set<string>;
  }
  const byKey = new Map<string, KeyCounter>()
  const dimensions = Object.fromEntries(Object.keys(ELIGIBILITY_DIMENSIONS).map((dimension) => [dimension, {
    rawLeads: new Set<string>(),
    verifiedLeads: new Set<string>(),
    evidenceBoundLeads: new Set<string>(),
    httpEligibleLeads: new Set<string>(),
  }])) as Record<keyof typeof ELIGIBILITY_DIMENSIONS, {
    rawLeads: Set<string>; verifiedLeads: Set<string>; evidenceBoundLeads: Set<string>; httpEligibleLeads: Set<string>;
  }>
  let rawFacts = 0
  let verifiedFacts = 0
  let evidenceBoundFacts = 0
  let httpEligibleFacts = 0

  for (const row of rows) {
    const evidenceIndex = objectValue(row.evidence_index)
    for (const fact of arrayValue(row.facts)) {
      const key = factKey(fact)
      if (!isLeadInvestmentProfileFactKey(key)) continue
      const verified = fact.verificationStatus === 'verified' || fact.verification_status === 'verified'
      const evidenceBound = verified && factHasBoundEvidence(fact, evidenceIndex)
      const httpEligible = verified && factHasHttpEvidence(fact, evidenceIndex)
      const counter = byKey.get(key) ?? {
        rawFacts: 0,
        verifiedFacts: 0,
        evidenceBoundFacts: 0,
        httpEligibleFacts: 0,
        rawLeads: new Set<string>(),
        verifiedLeads: new Set<string>(),
        evidenceBoundLeads: new Set<string>(),
        httpEligibleLeads: new Set<string>(),
      }
      counter.rawFacts += 1
      counter.rawLeads.add(row.lead_id)
      rawFacts += 1
      if (verified) {
        counter.verifiedFacts += 1
        counter.verifiedLeads.add(row.lead_id)
        verifiedFacts += 1
      }
      if (evidenceBound) {
        counter.evidenceBoundFacts += 1
        counter.evidenceBoundLeads.add(row.lead_id)
        evidenceBoundFacts += 1
      }
      if (httpEligible) {
        counter.httpEligibleFacts += 1
        counter.httpEligibleLeads.add(row.lead_id)
        httpEligibleFacts += 1
      }
      byKey.set(key, counter)
      for (const dimension of dimensionsForFactKey(key)) {
        dimensions[dimension].rawLeads.add(row.lead_id)
        if (verified) dimensions[dimension].verifiedLeads.add(row.lead_id)
        if (evidenceBound) dimensions[dimension].evidenceBoundLeads.add(row.lead_id)
        if (httpEligible) dimensions[dimension].httpEligibleLeads.add(row.lead_id)
      }
    }
  }

  const dimensionCoverage = Object.fromEntries(Object.entries(dimensions).map(([dimension, counts]) => [dimension, {
    rawLeadCount: counts.rawLeads.size,
    verifiedLeadCount: counts.verifiedLeads.size,
    evidenceBoundLeadCount: counts.evidenceBoundLeads.size,
    httpEligibleLeadCount: counts.httpEligibleLeads.size,
  }])) as Record<keyof typeof ELIGIBILITY_DIMENSIONS, {
    rawLeadCount: number; verifiedLeadCount: number; evidenceBoundLeadCount: number; httpEligibleLeadCount: number;
  }>
  return {
    definition: 'httpEligible = investment-profile fact verified in latest snapshot and bound to at least one HTTP(S) evidence entry',
    scope: 'selected pending latest snapshots after limit and explicit lead filters',
    scopedLeadCount: new Set(rows.map((row) => row.lead_id)).size,
    facts: { raw: rawFacts, verified: verifiedFacts, evidenceBound: evidenceBoundFacts, httpEligible: httpEligibleFacts },
    dimensions: dimensionCoverage,
    zeroHttpEligibleDimensions: Object.entries(dimensionCoverage)
      .filter(([, counts]) => counts.httpEligibleLeadCount === 0)
      .map(([dimension]) => dimension),
    byKey: [...byKey.entries()].map(([key, counts]) => ({
      key,
      rawFacts: counts.rawFacts,
      verifiedFacts: counts.verifiedFacts,
      evidenceBoundFacts: counts.evidenceBoundFacts,
      httpEligibleFacts: counts.httpEligibleFacts,
      rawLeadCount: counts.rawLeads.size,
      verifiedLeadCount: counts.verifiedLeads.size,
      evidenceBoundLeadCount: counts.evidenceBoundLeads.size,
      httpEligibleLeadCount: counts.httpEligibleLeads.size,
    })).sort((left, right) => right.rawFacts - left.rawFacts || left.key.localeCompare(right.key)),
  }
}

function selectReenrichmentTargets<T extends {
  lead_id: string; snapshot_id: string; facts: unknown; evidence_index: unknown;
}>(rows: T[], maximum = 10) {
  const candidates = rows.map((row) => {
    const evidenceIndex = objectValue(row.evidence_index)
    const raw = Object.fromEntries(Object.keys(ELIGIBILITY_DIMENSIONS).map((dimension) => [dimension, 0])) as Record<
      EligibilityDimension, number
    >
    const eligible = { ...raw }
    const rawKeys = new Set<string>()
    for (const fact of arrayValue(row.facts)) {
      const key = factKey(fact)
      if (!isLeadInvestmentProfileFactKey(key)) continue
      rawKeys.add(key)
      const httpEligible = (fact.verificationStatus === 'verified' || fact.verification_status === 'verified')
        && factHasHttpEvidence(fact, evidenceIndex)
      for (const dimension of dimensionsForFactKey(key)) {
        raw[dimension] += 1
        if (httpEligible) eligible[dimension] += 1
      }
    }
    const recoverableDimensions = (Object.keys(raw) as EligibilityDimension[])
      .filter((dimension) => raw[dimension] > 0 && eligible[dimension] === 0)
    const currentEligibleDimensions = (Object.keys(raw) as EligibilityDimension[])
      .filter((dimension) => eligible[dimension] > 0)
    const discoveryDimensions: EligibilityDimension[] = raw.academic === 0
      && [...rawKeys].some((key) => /^team\.(?:member|founder|cofounder)$/.test(key)) ? ['academic'] : []
    const targetDimensions = [...new Set([...recoverableDimensions, ...discoveryDimensions])]
    const recommendedTopics = [...new Set(targetDimensions.flatMap((dimension) => REENRICHMENT_TOPICS[dimension]))]
    return {
      leadId: row.lead_id,
      snapshotId: row.snapshot_id,
      recoverableDimensions,
      discoveryDimensions,
      currentEligibleDimensions,
      recommendedTopics,
      rawInvestmentFactKeyCount: rawKeys.size,
      score: recoverableDimensions.length * 100 + discoveryDimensions.length * 20 + rawKeys.size,
    }
  }).filter((candidate) => candidate.recommendedTopics.length > 0)
    .sort((left, right) => right.score - left.score || left.leadId.localeCompare(right.leadId))

  const selected = new Map<string, typeof candidates[number]>()
  for (const dimension of Object.keys(ELIGIBILITY_DIMENSIONS) as EligibilityDimension[]) {
    const candidate = candidates.find((item) => (
      item.recoverableDimensions.includes(dimension) || item.discoveryDimensions.includes(dimension)
    ))
    if (candidate) selected.set(candidate.leadId, candidate)
  }
  for (const candidate of candidates) {
    if (selected.size >= maximum) break
    selected.set(candidate.leadId, candidate)
  }
  return [...selected.values()].slice(0, maximum).map(({ score: _score, ...candidate }) => candidate)
}

function canaryScenarios(row: {
  snapshot_status: string; subject_profile: unknown; facts: unknown; evidence_index: unknown; conflicts: unknown;
}): CanaryScenario[] {
  const subject = objectValue(row.subject_profile)
  const facts = eligibleSnapshotFacts(row)
  const conflicts = arrayValue(row.conflicts)
  const keys = facts.map(factKey)
  const textFor = (key: string) => facts.filter((fact) => factKey(fact) === key)
    .map((fact) => JSON.stringify(fact.value ?? '')).join(' ')
  const financingInstances = new Set(facts.filter((fact) => factKey(fact) === 'financing.round')
    .map((fact) => String(fact.instanceKey ?? fact.instance_key ?? '').trim()).filter(Boolean))
  const scenarios: CanaryScenario[] = []
  if (subject.entityType === 'research') scenarios.push('research')
  else scenarios.push('company')
  if (/未融资|无融资|not funded/i.test(textFor('financing.status'))) scenarios.push('unfinanced')
  if (financingInstances.size >= 2) scenarios.push('multiple_financing_rounds')
  if (conflicts.some((conflict) => /^transaction\.(?:valuation|pre_money|post_money)$/.test(factKey(conflict)))) {
    scenarios.push('valuation_conflict')
  }
  if (keys.includes('team.institution') && (
    keys.includes('technology.transfer_status')
    || /成果转化|技术转让|专利许可|孵化|commerciali[sz]ation|technology transfer/i.test(textFor('team.institution_relation'))
  )) scenarios.push('academic_commercialization')
  if (/保密|受限|confidential|restricted/i.test(textFor('customer.confidentiality'))) scenarios.push('confidential_customer')
  if (keys.some((key) => /^(?:customer\.(?:pilot|trial|formal|framework_agreement|repurchase)|contract\.|order\.|delivery\.|cash_collection\.)/.test(key))) {
    scenarios.push('verified_customer_action')
  }
  if (row.snapshot_status === 'ready') scenarios.push('ready_snapshot')
  else if (row.snapshot_status === 'review') scenarios.push('review_snapshot')
  return scenarios
}

function selectCanaryCandidates<T extends {
  lead_id: string; snapshot_id: string; snapshot_status: string; subject_profile: unknown; facts: unknown;
  evidence_index: unknown; conflicts: unknown;
}>(rows: T[], minimum = 5, maximum = 10) {
  const firstByScenario = new Map<CanaryScenario, T>()
  for (const row of rows) {
    for (const scenario of canaryScenarios(row)) if (!firstByScenario.has(scenario)) firstByScenario.set(scenario, row)
  }
  const selected = new Map<string, {
    leadId: string; snapshotId: string; scenarios: CanaryScenario[]; eligibleFactCount: number;
  }>()
  for (const scenario of CANARY_SCENARIOS) {
    if (scenario === 'coverage_fallback') continue
    const row = firstByScenario.get(scenario)
    if (!row) continue
    const current = selected.get(row.lead_id) ?? {
      leadId: row.lead_id,
      snapshotId: row.snapshot_id,
      scenarios: [],
      eligibleFactCount: eligibleSnapshotFacts(row).length,
    }
    current.scenarios.push(scenario)
    selected.set(row.lead_id, current)
  }
  if (selected.size < minimum) {
    const coverageRanked = [...rows].sort((left, right) => (
      eligibleSnapshotFacts(right).length - eligibleSnapshotFacts(left).length
      || left.lead_id.localeCompare(right.lead_id)
    ))
    for (const row of coverageRanked) {
      if (selected.size >= minimum) break
      if (selected.has(row.lead_id)) continue
      selected.set(row.lead_id, {
        leadId: row.lead_id,
        snapshotId: row.snapshot_id,
        scenarios: [...new Set([...canaryScenarios(row), 'coverage_fallback' as const])],
        eligibleFactCount: eligibleSnapshotFacts(row).length,
      })
    }
  }
  return [...selected.values()].slice(0, maximum)
}

async function mapInBatches<T, R>(items: T[], worker: (item: T) => Promise<R>, batchSize = 4): Promise<R[]> {
  const results: R[] = []
  for (let index = 0; index < items.length; index += batchSize) {
    results.push(...await Promise.all(items.slice(index, index + batchSize).map(worker)))
  }
  return results
}

if (apply && process.env.ALLOW_LEAD_INVESTMENT_PROFILE_BACKFILL !== 'true') {
  throw new Error('apply requires ALLOW_LEAD_INVESTMENT_PROFILE_BACKFILL=true')
}
if (apply && !batchId) throw new Error('apply requires --batch-id=<auditable batch id>')
if (batchId && !/^[A-Za-z0-9._-]{1,100}$/.test(batchId)) throw new Error('--batch-id must use 1-100 safe filename characters')
if (apply && !leadIds.length && !allPending) throw new Error('apply requires --lead-ids=<id,...> or explicit --all-pending')
if (leadIds.length > 1_000) throw new Error('--lead-ids accepts at most 1000 explicit targets')
if (allPending && leadIds.length) throw new Error('--all-pending and --lead-ids are mutually exclusive target modes')
if (force && !leadIds.length) throw new Error('--force requires an explicit --lead-ids=<id,...> target set')
if (apply && canaryProfiles) throw new Error('--canary-profiles is a preview-only option')
if (apply && reenrichmentTargets) throw new Error('--reenrichment-targets is a preview-only option')

async function main() {
  const latestSnapshotWhere = `s.id=(
  SELECT s2.id FROM ${snapshotsTable} s2
  WHERE s2.lead_id=s.lead_id AND s2.status IN ('ready','review')
  ORDER BY s2.created_at DESC,s2.id DESC LIMIT 1
)`
const [coverageRows] = await pool.query<Array<RowDataPacket & {
  total: number; never_count: number; stale_count: number; conflicted_count: number; ready_count: number;
  review_snapshot_count: number; topic_state_entries: number; snapshot_fact_count: number; evidence_source_count: number;
}>>(
  `SELECT COUNT(*) AS total,
          SUM(p.lead_id IS NULL) AS never_count,
          SUM(p.lead_id IS NOT NULL AND (p.snapshot_hash<>s.snapshot_hash OR p.profile_status='stale')) AS stale_count,
          SUM(p.lead_id IS NOT NULL AND p.snapshot_hash=s.snapshot_hash AND p.profile_status='conflicted') AS conflicted_count,
          SUM(p.lead_id IS NOT NULL AND p.snapshot_hash=s.snapshot_hash AND p.profile_status NOT IN ('stale','conflicted')) AS ready_count,
          SUM(s.status='review') AS review_snapshot_count,
          SUM(COALESCE(JSON_LENGTH(s.topic_states),0)) AS topic_state_entries,
          SUM(COALESCE(JSON_LENGTH(s.facts),0)) AS snapshot_fact_count,
          SUM(COALESCE(JSON_LENGTH(s.evidence_index),0)) AS evidence_source_count
   FROM ${snapshotsTable} s
   LEFT JOIN ${profilesTable} p ON p.lead_id=s.lead_id
   WHERE ${latestSnapshotWhere}`,
)
const coverage = coverageRows[0]
const explicitLeadFilter = leadIds.length ? ` AND s.lead_id IN (${leadIds.map(() => '?').join(',')})` : ''

const [rows] = await pool.query<Array<RowDataPacket & {
  lead_id: string; snapshot_id: string; snapshot_hash: string; current_snapshot_hash: string | null;
  current_profile_status: string | null; snapshot_status: string; subject_profile: unknown; facts: unknown;
  evidence_index: unknown; conflicts: unknown;
}>>(
  `SELECT s.lead_id,s.id AS snapshot_id,s.snapshot_hash,p.snapshot_hash AS current_snapshot_hash,
          p.profile_status AS current_profile_status,s.status AS snapshot_status,s.subject_profile,s.facts,s.evidence_index,s.conflicts
   FROM ${snapshotsTable} s
   LEFT JOIN ${profilesTable} p ON p.lead_id=s.lead_id
   WHERE ${latestSnapshotWhere}
     AND (? OR p.lead_id IS NULL OR p.snapshot_hash<>s.snapshot_hash OR p.profile_status='stale')
     ${explicitLeadFilter}
   ORDER BY s.created_at,s.id
   LIMIT ?`,
  [force, ...leadIds, limit],
)

if (!apply) {
  const coverageSummary = {
    total: Number(coverage?.total || 0),
    never: Number(coverage?.never_count || 0),
    stale: Number(coverage?.stale_count || 0),
    conflicted: Number(coverage?.conflicted_count || 0),
    ready: Number(coverage?.ready_count || 0),
  }
  const eligibility = investmentFactEligibility(rows)
  const reenrichment = reenrichmentTargets ? (() => {
    const targets = selectReenrichmentTargets(rows)
    const estimatedTopicRuns = targets.reduce((sum, target) => sum + target.recommendedTopics.length, 0)
    return {
      mode: 'read-only-target-plan',
      databaseWrites: 0,
      modelCallsExecuted: 0,
      candidateCount: targets.length,
      estimatedTopicRuns,
      estimatedSearchCallsUpperBound: estimatedTopicRuns * 6,
      note: 'Targets are recommendations only. Discovery dimensions are hypotheses, not verified facts; execution requires a separate authorized workflow.',
      targets,
    }
  })() : undefined
  const candidatePool = selectCanaryCandidates(rows, canaryProfiles ? Math.min(50, rows.length) : 5, canaryProfiles ? 50 : 10)
  const previewedCandidates = canaryProfiles ? await mapInBatches(candidatePool, async (candidate) => {
    const profile = await previewLeadInvestmentProfileProjection({
      leadId: candidate.leadId,
      snapshotId: candidate.snapshotId,
    })
    const publicProfile = profile ? publicLeadInvestmentProfile(profile) : null
    const actualScenarios = candidate.scenarios.filter((scenario) => (
      ['company', 'research', 'ready_snapshot', 'review_snapshot', 'coverage_fallback'].includes(scenario)
    ))
    if (/未融资|无融资|not funded/i.test(publicProfile?.financing.status ?? '')) actualScenarios.push('unfinanced')
    if (Number(publicProfile?.financing.completedRoundCount ?? 0) >= 2) actualScenarios.push('multiple_financing_rounds')
    if (candidate.scenarios.includes('valuation_conflict') && Number(publicProfile?.dataStatus.conflictCount ?? 0) > 0) {
      actualScenarios.push('valuation_conflict')
    }
    if (publicProfile?.academicLinks.some((link) => link.commercialization)) actualScenarios.push('academic_commercialization')
    if (publicProfile?.customers.representatives.some((customer) => customer.anonymized)) actualScenarios.push('confidential_customer')
    if (Number(publicProfile?.customers.verifiedCount ?? 0) > 0) actualScenarios.push('verified_customer_action')
    return {
      ...candidate,
      scenarios: [...new Set(actualScenarios)],
      profile: publicProfile,
    }
  }, 4) : []
  const canaryProfilePreviews = canaryProfiles ? previewedCandidates.sort((left, right) => (
    Number(right.profile?.dataStatus.verifiedDimensions ?? 0) - Number(left.profile?.dataStatus.verifiedDimensions ?? 0)
    || Number(right.profile?.dataStatus.conflictCount ?? 0) - Number(left.profile?.dataStatus.conflictCount ?? 0)
    || right.eligibleFactCount - left.eligibleFactCount
    || left.leadId.localeCompare(right.leadId)
  )).slice(0, 5) : undefined
  const canaryCandidates = canaryProfilePreviews?.map(({ profile, ...candidate }) => ({
    ...candidate,
    quality: {
      verifiedDimensions: profile?.dataStatus.verifiedDimensions ?? 0,
      conflictCount: profile?.dataStatus.conflictCount ?? 0,
      status: profile?.dataStatus.status ?? 'missing',
    },
  })) ?? candidatePool
  console.log(JSON.stringify({
    mode: 'preview',
    databaseWrites: 0,
    database: mysqlConfig.database,
    tablePrefix: mysqlConfig.tablePrefix,
    limit,
    force,
    targetMode: leadIds.length ? 'explicit_lead_ids' : 'pending',
    explicitLeadIds: leadIds,
    coverage: coverageSummary,
    topics: {
      reviewSnapshots: Number(coverage?.review_snapshot_count || 0),
      terminalTopicStateEntries: Number(coverage?.topic_state_entries || 0),
    },
    sources: {
      frozenFacts: Number(coverage?.snapshot_fact_count || 0),
      frozenEvidenceEntries: Number(coverage?.evidence_source_count || 0),
    },
    eligibility,
    reenrichment,
    estimatedCalls: { model: 0, projectionWritesIfApplied: rows.length },
    risks: [
      '0092 migration and controlled dictionaries must exist before apply',
      'client taxonomy and confidentiality policy must be confirmed before business backfill',
      ...(rows.length >= limit ? ['preview reached limit; target set may be truncated'] : []),
      ...(Number(coverage?.review_snapshot_count || 0) > 0 ? ['review snapshots require conflict-aware acceptance'] : []),
      ...(eligibility.zeroHttpEligibleDimensions.length ? [
        `latest snapshots have zero HTTP-eligible facts for dimensions: ${eligibility.zeroHttpEligibleDimensions.join(', ')}`,
      ] : []),
      ...(reenrichmentTargets ? ['reenrichment target preview does not authorize model calls, job enqueueing or database writes'] : []),
    ],
    pending: rows.length,
    canaryCandidates,
    canaryProfilePreviews,
    sample: rows.slice(0, 20).map((row) => ({
      leadId: row.lead_id,
      snapshotId: row.snapshot_id,
      snapshotChanged: Boolean(row.current_snapshot_hash && row.current_snapshot_hash !== row.snapshot_hash),
      reason: row.current_profile_status === 'stale'
        ? 'stale'
        : row.current_snapshot_hash && row.current_snapshot_hash !== row.snapshot_hash ? 'snapshot_changed' : 'missing',
    })),
  }, null, 2))
  return
}

const succeeded: Array<{
  leadId: string; snapshotId: string; snapshotHash: string; changed: boolean;
  beforeFingerprint: string | null; afterFingerprint: string;
}> = []
const failures: Array<{ leadId: string; snapshotId: string; error: string }> = []
const qualityBlockedTargets = (await mapInBatches(rows, async (row) => {
  const eligibilityReasons = leadInvestmentProfileBackfillQualityFailures(investmentFactEligibility([row]))
  const preview = await previewLeadInvestmentProfileProjection({
    leadId: row.lead_id,
    snapshotId: row.snapshot_id,
  })
  const reasons = [...eligibilityReasons, ...leadInvestmentProfileProjectionQualityFailures(preview)]
  return reasons.length ? [{ leadId: row.lead_id, snapshotId: row.snapshot_id, reasons }] : []
}, 4)).flat()
if (qualityBlockedTargets.length) {
  const sample = qualityBlockedTargets.slice(0, 10)
    .map((target) => `${target.leadId}[${target.reasons.join('; ')}]`).join(', ')
  throw new Error(`apply blocked by investment profile evidence quality gate for ${qualityBlockedTargets.length} target(s): ${sample}`)
}
const receiptDirectory = resolve(process.cwd(), 'outputs', 'lead-investment-profile-backfill')
const receiptPath = resolve(receiptDirectory, `${batchId}.ndjson`)
await mkdir(receiptDirectory, { recursive: true })
let receiptFile: FileHandle
try {
  receiptFile = await open(receiptPath, 'wx')
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
    throw new Error(`batch receipt already exists; use a new --batch-id or inspect ${receiptPath} for recovery`)
  }
  throw error
}
const appendReceipt = async (type: string, payload: Record<string, unknown>) => {
  await receiptFile.appendFile(`${JSON.stringify({ type, batchId, at: new Date().toISOString(), ...payload })}\n`, 'utf8')
  await receiptFile.sync()
}
const selectedTargets = rows.map((row) => ({
  leadId: row.lead_id,
  snapshotId: row.snapshot_id,
  snapshotHash: row.snapshot_hash,
  currentSnapshotHash: row.current_snapshot_hash,
  currentProfileStatus: row.current_profile_status,
}))
try {
  await appendReceipt('batch_start', {
    database: mysqlConfig.database,
    tablePrefix: mysqlConfig.tablePrefix,
    attempted: rows.length,
    targetMode: leadIds.length ? 'explicit_lead_ids' : 'all_pending',
    explicitLeadIds: leadIds,
    limit,
    force,
    modelCalls: 0,
  })
  await appendReceipt('batch_targets', { targets: selectedTargets })
  for (const row of rows) {
    let projectionSucceeded = false
    let projectionError: unknown
    let projectionReceipt: { changed: boolean; beforeFingerprint: string | null; afterFingerprint: string } | null = null
    try {
      const projection = await refreshLeadInvestmentProfileProjectionWithReceipt({ leadId: row.lead_id, snapshotId: row.snapshot_id })
      if (!projection) throw new Error('selected frozen snapshot is no longer available')
      projectionReceipt = projection.write
      projectionSucceeded = true
    } catch (error) {
      projectionError = error
    }
    if (projectionSucceeded) {
      const result = {
        leadId: row.lead_id,
        snapshotId: row.snapshot_id,
        snapshotHash: row.snapshot_hash,
        changed: projectionReceipt!.changed,
        beforeFingerprint: projectionReceipt!.beforeFingerprint,
        afterFingerprint: projectionReceipt!.afterFingerprint,
      }
      succeeded.push(result)
      await appendReceipt('lead_succeeded', result)
    } else {
      const failure = {
        leadId: row.lead_id,
        snapshotId: row.snapshot_id,
        error: (projectionError instanceof Error ? projectionError.message : String(projectionError)).slice(0, 2_000),
      }
      failures.push(failure)
      await appendReceipt('lead_failed', failure)
    }
  }
  await appendReceipt('batch_complete', {
    attempted: rows.length,
    completed: succeeded.length,
    changed: succeeded.filter((result) => result.changed).length,
    unchanged: succeeded.filter((result) => !result.changed).length,
    failed: failures.length,
    retryLeadIds: failures.map((failure) => failure.leadId),
  })
  console.log(JSON.stringify({
    mode: 'apply', batchId, attempted: rows.length, completed: succeeded.length, failed: failures.length, limit, force,
    changed: succeeded.filter((result) => result.changed).length,
    unchanged: succeeded.filter((result) => !result.changed).length,
    targetMode: leadIds.length ? 'explicit_lead_ids' : 'all_pending',
    explicitLeadIds: leadIds,
    modelCalls: 0,
    succeeded,
    failures,
    recovery: { retryLeadIds: failures.map((failure) => failure.leadId) },
    receiptPath,
  }, null, 2))
  if (failures.length) process.exitCode = 1
} catch (error) {
  await appendReceipt('batch_aborted', {
    completed: succeeded.length,
    failed: failures.length,
    error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
  }).catch(() => undefined)
  throw error
} finally {
  await receiptFile.close()
}
}

await main().finally(async () => pool.end())
