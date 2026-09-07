import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { redactSensitiveText } from '../security/redactSecrets.js'
import {
  LEAD_ENRICHMENT_SCHEMA_VERSION,
  LEAD_ENRICHMENT_TERMINAL_TOPIC_STATUSES,
  leadDetailEnrichmentTopicApplies,
  leadEnrichmentRuntimePolicy,
  leadResearchWebEnrichmentEnabled,
  normalizePaperIdentity,
  topicRequiresConfirmedEntity,
  type LeadEntityStatus,
  type LeadEntityType,
  type LeadEnrichmentTopicKey,
} from './leadEnrichmentContract.js'
import { leadResearchTopicGaps, leadResearchTopicGapsByTopic } from './leadResearchProfileProjectionService.js'
import {
  freezeLeadEnrichmentSnapshot,
  excludeDeregisteredLeadFromPool,
  leadFactSubjectEntityType,
  persistLeadFact,
  recordLeadEnrichmentTopicPhase,
  refreshLeadEnrichmentProjection,
  validateLeadFactCandidate,
} from './leadEnrichmentService.js'
import { fetchLeadSourceDocument, sourceDocumentContainsQuote } from './leadSourceDocumentService.js'
import {
  enforceLeadTopicFactSetContract,
  leadTopicResearchContract,
  researchLeadTopicWithWeb,
} from './leadTopicWebResearchService.js'
import {
  classifyLeadEnrichmentError,
  isLeadEnrichmentProviderBudgetError,
  leadEnrichmentRetryDecision,
} from './leadEnrichmentRetryPolicy.js'
import { createLeadEnrichmentCircuitBreaker } from './leadEnrichmentCircuitBreaker.js'
import { classifyLeadWebEvidence } from './leadEvidenceClassificationService.js'
import { detectLeadCandidateFactConflicts } from './leadFactConflictDetectionService.js'
import { leadFactIdentityKey } from './leadFactInstanceKey.js'
import { leadSourceSupportsSubject } from './leadSourceSubjectMatchService.js'
import { readLeadTopicSearchCache, writeLeadTopicSearchCache } from './leadTopicSearchCacheService.js'
import { isLeadAgentRuntimeThrottleError } from './leadAgentRuntimeGuardService.js'

type JsonObject = Record<string, unknown>

type TopicLease = RowDataPacket & {
  id: string
  job_id: string
  lead_id: string
  entity_id: string | null
  entity_type: LeadEntityType
  entity_status: LeadEntityStatus
  topic_key: LeadEnrichmentTopicKey
  execution_attempts: number
  lease_owner: string | null
  job_created_at: Date
}

const topicRunsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_topic_runs'))
const jobsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_jobs'))
const conflictsTable = quoteMysqlIdentifier(mysqlTableName('lead_fact_conflicts'))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const scoreJobsTable = quoteMysqlIdentifier(mysqlTableName('lead_score_jobs'))
const entitiesTable = quoteMysqlIdentifier(mysqlTableName('lead_entities'))
const factsTable = quoteMysqlIdentifier(mysqlTableName('lead_facts'))
const snapshotsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_snapshots'))
const ratingHistoryTable = quoteMysqlIdentifier(mysqlTableName('lead_rating_history'))
const owner = `${hostname()}:${process.pid}:enrichment:${randomUUID().slice(0, 8)}`
const pollMs = Math.max(500, Number(process.env.LEAD_ENRICHMENT_POLL_MS) || 2_000)
const leaseSeconds = Math.max(60, Number(process.env.LEAD_ENRICHMENT_LEASE_SECONDS) || 600)
const concurrency = Math.max(1, Math.min(10, Number(process.env.LEAD_ENRICHMENT_CONCURRENCY) || 1))
const maxAttempts = Math.max(1, Math.min(5, Number(process.env.LEAD_ENRICHMENT_MAX_ATTEMPTS) || 3))
const processAfter = leadEnrichmentRuntimePolicy().processAfter
const triggerTypeFilter = String(process.env.LEAD_ENRICHMENT_TRIGGER_TYPE_FILTER ?? '').normalize('NFKC').trim()
if (triggerTypeFilter.length > 48) throw new Error('LEAD_ENRICHMENT_TRIGGER_TYPE_FILTER exceeds 48 characters')
const active = new Map<string, Promise<void>>()
let timer: NodeJS.Timeout | undefined
let started = false
let stopping = false
let polling: Promise<void> | undefined
let localThrottleUntilMs = 0
const gatewayCircuit = createLeadEnrichmentCircuitBreaker({
  failureThreshold: 5,
  cooldownMs: 60_000,
  billingCooldownMs: Math.max(60_000, Number(process.env.LEAD_ENRICHMENT_BILLING_COOLDOWN_MS) || 15 * 60_000),
})

function object(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {}
  } catch { return {} }
}

function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : ''
}

function estimatedTopicCostUsd(usage: unknown) {
  const normalized = object(usage)
  const inputRate = Number(process.env.LEAD_ENRICHMENT_INPUT_USD_PER_MILLION || 0)
  const outputRate = Number(process.env.LEAD_ENRICHMENT_OUTPUT_USD_PER_MILLION || 0)
  if (!(inputRate > 0 || outputRate > 0)) return null
  const inputTokens = Math.max(0, Number(normalized.inputTokens) || 0)
  const outputTokens = Math.max(0, Number(normalized.outputTokens) || 0)
  return Number(((inputTokens * inputRate + outputTokens * outputRate) / 1_000_000).toFixed(8))
}

function topicCostRatesConfigured() {
  return Number(process.env.LEAD_ENRICHMENT_INPUT_USD_PER_MILLION || 0) > 0
    || Number(process.env.LEAD_ENRICHMENT_OUTPUT_USD_PER_MILLION || 0) > 0
}

export async function recoverExpiredLeadEnrichmentLeases() {
  const [result] = await pool.query(
    `UPDATE ${topicRunsTable} tr JOIN ${jobsTable} j ON j.id=tr.job_id
     SET tr.status='retrying',tr.next_attempt_at=NOW(3),tr.lease_owner=NULL,tr.lease_expires_at=NULL,
         tr.metrics=JSON_SET(COALESCE(tr.metrics,JSON_OBJECT()),'$.lastLeaseDisposition','abandoned'),
         tr.last_error=CONCAT('abandoned: lease expired',IF(tr.last_error IS NULL,'',CONCAT(': ',LEFT(tr.last_error,512)))),tr.updated_at=NOW(3)
     WHERE j.schema_version=? AND (? IS NULL OR j.created_at>=?)
       AND tr.status='running' AND tr.lease_expires_at IS NOT NULL AND tr.lease_expires_at<NOW(3)`,
    [LEAD_ENRICHMENT_SCHEMA_VERSION, processAfter, processAfter],
  )
  await pool.query(
    `UPDATE ${jobsTable}
     SET status='queued',next_attempt_at=NOW(3),lease_owner=NULL,lease_expires_at=NULL,
         last_error=CONCAT('abandoned: job lease expired',IF(last_error IS NULL,'',CONCAT(': ',LEFT(last_error,512)))),updated_at=NOW(3)
     WHERE schema_version=? AND (? IS NULL OR created_at>=?)
       AND status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<NOW(3)`,
    [LEAD_ENRICHMENT_SCHEMA_VERSION, processAfter, processAfter],
  )
  return Number((result as { affectedRows?: number }).affectedRows || 0)
}

export async function quarantineProviderBudgetLeadEnrichmentRetries() {
  const [rows] = await pool.query<Array<RowDataPacket & {
    id: string; job_id: string; lead_id: string; last_error: string | null;
  }>>(
    `SELECT tr.id,tr.job_id,tr.lead_id,tr.last_error FROM ${topicRunsTable} tr
     JOIN ${jobsTable} j ON j.id=tr.job_id
     WHERE j.schema_version=? AND (? IS NULL OR j.created_at>=?)
       AND tr.status='retrying' AND tr.last_error IS NOT NULL`,
    [LEAD_ENRICHMENT_SCHEMA_VERSION, processAfter, processAfter],
  )
  const affected = rows.filter((row) => isLeadEnrichmentProviderBudgetError(new Error(row.last_error || '')))
  if (!affected.length) return 0
  await pool.query(
    `UPDATE ${topicRunsTable}
     SET status='dead_letter',next_attempt_at=NOW(3),lease_owner=NULL,lease_expires_at=NULL,
         metrics=JSON_SET(COALESCE(metrics,JSON_OBJECT()),'$.errorClass','budget',
           '$.automaticDisposition','provider_billing_dead_letter_on_startup'),
         completed_at=COALESCE(completed_at,NOW(3)),updated_at=NOW(3)
     WHERE status='retrying' AND id IN (${affected.map(() => '?').join(',')})`,
    affected.map((row) => row.id),
  )
  const jobs = [...new Map(affected.map((row) => [row.job_id, row])).values()]
  for (const row of jobs) {
    await refreshLeadEnrichmentProjection(row.lead_id, row.job_id)
    const [remaining] = await pool.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) count FROM ${topicRunsTable} WHERE job_id=? AND status NOT IN (${[...LEAD_ENRICHMENT_TERMINAL_TOPIC_STATUSES].map(() => '?').join(',')})`,
      [row.job_id, ...LEAD_ENRICHMENT_TERMINAL_TOPIC_STATUSES],
    )
    if (Number(remaining[0]?.count || 0) === 0) await freezeCompletedJob(row.job_id)
  }
  return affected.length
}

export async function claimLeadEnrichmentTopicLease(): Promise<TopicLease | null> {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<TopicLease[]>(
      `SELECT tr.id,tr.job_id,tr.lead_id,tr.topic_key,tr.execution_attempts,tr.lease_owner,j.entity_id,j.entity_type,j.entity_status,j.created_at job_created_at
       FROM ${topicRunsTable} tr JOIN ${jobsTable} j ON j.id=tr.job_id
       WHERE tr.status IN ('queued','retrying') AND tr.next_attempt_at<=NOW(3)
         AND (tr.lease_expires_at IS NULL OR tr.lease_expires_at<NOW(3))
         AND j.schema_version=?
         AND (? IS NULL OR j.created_at>=?)
         AND (?='' OR j.trigger_type=?)
         AND j.status IN ('queued','running')
         AND (j.lease_owner IS NULL OR j.lease_owner=? OR j.lease_expires_at<NOW(3))
         AND (j.entity_type<>'research' OR NOT EXISTS (
           SELECT 1 FROM ${topicRunsTable} active_research_topic
           WHERE active_research_topic.job_id=tr.job_id AND active_research_topic.status='running'
         ))
         AND (tr.topic_key='basic_profile' OR EXISTS (
           SELECT 1 FROM ${topicRunsTable} identity_run
           WHERE identity_run.job_id=tr.job_id AND identity_run.topic_key='basic_profile'
             AND identity_run.status IN ('completed','partial','missing','not_applicable','review','failed','dead_letter')
         ))
       ORDER BY j.priority,tr.next_attempt_at,tr.created_at
       LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [LEAD_ENRICHMENT_SCHEMA_VERSION, processAfter, processAfter, triggerTypeFilter, triggerTypeFilter, owner],
    )
    const row = rows[0]
    if (!row) { await connection.rollback(); return null }
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1_000)
    await connection.query(
      `UPDATE ${topicRunsTable}
       SET status='running',execution_attempts=execution_attempts+1,lease_owner=?,lease_expires_at=?,
           started_at=COALESCE(started_at,NOW(3)),last_error=NULL,updated_at=NOW(3) WHERE id=?`,
      [owner, leaseExpiresAt, row.id],
    )
    await connection.query(
      `UPDATE ${jobsTable}
       SET execution_attempts=execution_attempts+IF(status='queued',1,0),status='running',
           lease_owner=?,lease_expires_at=?,started_at=COALESCE(started_at,NOW(3)),updated_at=NOW(3) WHERE id=?`,
      [owner, leaseExpiresAt, row.job_id],
    )
    await connection.commit()
    await refreshLeadEnrichmentProjection(row.lead_id, row.job_id)
    return { ...row, execution_attempts: Number(row.execution_attempts || 0) + 1, lease_owner: owner }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally { connection.release() }
}

function paperDeterministicFacts(topicKey: LeadEnrichmentTopicKey, radarProfile: JsonObject) {
  const paperMeta = object(radarProfile.paperMeta)
  const sourceUrl = text(object(paperMeta.metadataSource).url || radarProfile.link || paperMeta.pdfUrl)
  if (!sourceUrl) return []
  const common = { sourceUrl, sourceType: 'paper_source', quote: '' }
  const title = text(paperMeta.titleOriginal || paperMeta.title)
  const authors = list(paperMeta.authors).map(text).filter(Boolean)
  const authorQuote = authors.join(', ')
  const affiliations = list(paperMeta.affiliations).map((item) => text(object(item).name || item)).filter(Boolean)
  if (topicKey === 'basic_profile') {
    return [
      ['paper.title', paperMeta.titleOriginal || paperMeta.title, title],
      ['paper.abstract', paperMeta.abstract, text(paperMeta.abstract).slice(0, 2_000)],
      ['paper.publication', {
        venue: paperMeta.venue, publishedAt: paperMeta.publishedAt, resourceType: paperMeta.resourceType,
        identity: normalizePaperIdentity({
          provider: object(paperMeta.metadataSource).provider,
          sourceName: radarProfile.sourceName,
          sourceId: radarProfile.sourceId,
          arxivId: paperMeta.arxivId,
          openAlexId: paperMeta.openAlexId,
          doi: paperMeta.doi,
          landingPageUrl: radarProfile.link,
          pdfUrl: paperMeta.pdfUrl,
        }),
      }, title],
    ].filter(([, value]) => Boolean(text(value) || (value && typeof value === 'object')))
      .map(([factKey, value, quote]) => ({ factKey: String(factKey), value, evidence: [{ ...common, quote: String(quote) }] }))
  }
  if (topicKey === 'team') {
    const values = [
      ['paper.authors', paperMeta.authors, authorQuote],
      ['paper.research_team', paperMeta.researchTeam, authorQuote],
      ['paper.author_contributions', paperMeta.authorContributions, authorQuote],
      ['paper.affiliations', paperMeta.affiliations, affiliations.join(', ')],
      ['paper.author_affiliations', paperMeta.authorAffiliations, authorQuote],
    ]
    return values.filter(([, value, quote]) => Boolean(text(quote)) && (Array.isArray(value) ? value.length > 0 : Object.keys(object(value)).length > 0))
      .map(([factKey, value, quote]) => ({ factKey: String(factKey), value, evidence: [{ ...common, quote: String(quote) }] }))
  }
  if (topicKey === 'technology_ip') {
    const rights = object(paperMeta.rights)
    const articleLicense = object(rights.articleLicense)
    const rightsQuote = text(articleLicense.label || articleLicense.license || articleLicense.url)
    return Object.keys(rights).length && rightsQuote ? [{
      factKey: 'paper.rights', value: rights,
      evidence: [{ ...common, quote: rightsQuote }],
    }] : []
  }
  if (topicKey === 'products') {
    const rights = object(paperMeta.rights)
    const artifacts = ['dataset', 'code', 'model'].flatMap((key) => object(rights[key]).url ? [{ type: key, ...object(rights[key]) }] : [])
    return artifacts.length ? [{
      factKey: 'research.artifacts', value: artifacts,
      evidence: [{ ...common, quote: text(object(artifacts[0]).url) }],
    }] : []
  }
  return []
}

async function finishTopic(lease: TopicLease, input: {
  status: 'completed' | 'partial' | 'missing' | 'not_applicable' | 'review'
  metrics: JsonObject
  promptVersion?: string
  model?: string
  toolsetVersion?: string
  queryPlan?: string[]
}) {
  await pool.query(
    `UPDATE ${topicRunsTable}
     SET status=?,prompt_version=COALESCE(?,prompt_version),model=COALESCE(?,model),
         toolset_version=COALESCE(?,toolset_version),query_plan=CAST(? AS JSON),
         metrics=JSON_MERGE_PATCH(COALESCE(metrics,JSON_OBJECT()),CAST(? AS JSON)),
         lease_owner=NULL,lease_expires_at=NULL,completed_at=NOW(3),updated_at=NOW(3)
     WHERE id=? AND status='running' AND lease_owner=?`,
    [input.status, input.promptVersion ?? null, input.model ?? null, input.toolsetVersion ?? null,
      JSON.stringify(input.queryPlan ?? []), JSON.stringify(input.metrics), lease.id, owner],
  )
  await refreshLeadEnrichmentProjection(lease.lead_id, lease.job_id)
  const [remaining] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) count FROM ${topicRunsTable} WHERE job_id=? AND status NOT IN (${[...LEAD_ENRICHMENT_TERMINAL_TOPIC_STATUSES].map(() => '?').join(',')})`,
    [lease.job_id, ...LEAD_ENRICHMENT_TERMINAL_TOPIC_STATUSES],
  )
  if (Number(remaining[0]?.count || 0) === 0) await freezeCompletedJob(lease.job_id)
}

async function recordTopicPhase(lease: TopicLease, phase: Parameters<typeof recordLeadEnrichmentTopicPhase>[0]['phase']) {
  const recorded = await recordLeadEnrichmentTopicPhase({ topicRunId: lease.id, leaseOwner: owner, phase })
  if (!recorded) {
    throw Object.assign(new Error('专题租约已失效，停止本次补全执行'), {
      code: 'LEAD_ENRICHMENT_LEASE_LOST', category: 'validation', retryable: false,
    })
  }
}

async function freezeCompletedJob(jobId: string) {
  try {
    await freezeLeadEnrichmentSnapshot(jobId)
  } catch (error) {
    if ((error as { code?: unknown }).code === 'LEAD_ENRICHMENT_JOB_INACTIVE') return
    throw error
  }
}

async function failTopic(lease: TopicLease, error: unknown) {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 4_000)
  const localThrottle = isLeadAgentRuntimeThrottleError(error)
  const decision = leadEnrichmentRetryDecision({
    error, executionAttempts: localThrottle ? Math.max(0, lease.execution_attempts - 1) : lease.execution_attempts, maxAttempts,
  })
  const retryAfterMs = Number((error as { retryAfterMs?: unknown }).retryAfterMs)
  const retrySeconds = localThrottle
    ? Math.max(15, Math.ceil(Number.isFinite(retryAfterMs) ? retryAfterMs / 1_000 : 15))
    : decision.retrySeconds
  if (localThrottle) localThrottleUntilMs = Math.max(localThrottleUntilMs, Date.now() + retrySeconds * 1_000)
  await pool.query(
    `UPDATE ${topicRunsTable}
     SET status=?,execution_attempts=GREATEST(0,execution_attempts-?),next_attempt_at=DATE_ADD(NOW(3),INTERVAL ? SECOND),lease_owner=NULL,lease_expires_at=NULL,
         last_error=?,metrics=JSON_SET(COALESCE(metrics,JSON_OBJECT()),'$.errorClass',?),
         completed_at=IF(?='dead_letter',NOW(3),NULL),updated_at=NOW(3)
     WHERE id=? AND status='running' AND lease_owner=?`,
    [decision.terminalStatus, localThrottle ? 1 : 0, retrySeconds, message, decision.errorClass,
      decision.terminalStatus, lease.id, owner],
  )
  await refreshLeadEnrichmentProjection(lease.lead_id, lease.job_id)
  if (!decision.retry) {
    const [remaining] = await pool.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) count FROM ${topicRunsTable} WHERE job_id=? AND status NOT IN (${[...LEAD_ENRICHMENT_TERMINAL_TOPIC_STATUSES].map(() => '?').join(',')})`,
      [lease.job_id, ...LEAD_ENRICHMENT_TERMINAL_TOPIC_STATUSES],
    )
    if (Number(remaining[0]?.count || 0) === 0) await freezeCompletedJob(lease.job_id)
  }
}

async function executeTopic(lease: TopicLease) {
  const topicStartedAt = Date.now()
  if (!leadDetailEnrichmentTopicApplies({ topicKey: lease.topic_key, entityType: lease.entity_type })) {
    await finishTopic(lease, {
      status: 'not_applicable',
      metrics: { reason: 'not_rendered_on_lead_detail', durationMs: Date.now() - topicStartedAt },
    })
    return
  }
  const [leadRows] = await pool.query<Array<RowDataPacket & {
    name: string; company_name: string | null; industry: string | null; summary: string | null;
    scoring: unknown; radar_profile: unknown; sources: unknown; pool_status: string
  }>>(`SELECT name,company_name,industry,summary,scoring,radar_profile,sources,pool_status FROM ${leadsTable} WHERE id=? LIMIT 1`, [lease.lead_id])
  const lead = leadRows[0]
  if (!lead || ['已删除', '已合并', '已注销', '已转专属项目'].includes(lead.pool_status)) {
    await finishTopic(lease, { status: 'missing', metrics: { reason: 'lead_not_active' } })
    return
  }
  await recordTopicPhase(lease, 'resolving_entity')
  const radarProfile = object(lead.radar_profile)
  const isResearch = text(radarProfile.channel) === '论文'
  const subjectId = lease.entity_id || lease.lead_id
  const [subjectEntityRows] = await pool.query<Array<RowDataPacket & {
    id: string; entity_type: string; canonical_name: string; status: string;
  }>>(
    `SELECT id,entity_type,canonical_name,status FROM ${entitiesTable} WHERE lead_id=?
     ORDER BY FIELD(status,'confirmed','claimed','inferred','ambiguous','missing'),created_at,id`,
    [lease.lead_id],
  )
  const subjectEntityByType = new Map<string, string>()
  for (const entity of subjectEntityRows) {
    if (!subjectEntityByType.has(entity.entity_type)) subjectEntityByType.set(entity.entity_type, entity.id)
  }
  const routedSubject = (factKey: string) => {
    const subjectType = leadFactSubjectEntityType({
      factKey, topicKey: lease.topic_key, primaryType: lease.entity_type,
      availableTypes: subjectEntityByType.keys() as Iterable<LeadEntityType>,
    })
    return { subjectType, subjectId: subjectEntityByType.get(subjectType) || subjectId }
  }
  let effectiveEntityStatus = lease.entity_status
  if (isResearch) {
    const paperMeta = object(radarProfile.paperMeta)
    const sourceStatus = normalizePaperIdentity({
      provider: object(paperMeta.metadataSource).provider,
      sourceName: radarProfile.sourceName,
      sourceId: radarProfile.sourceId,
      arxivId: paperMeta.arxivId,
      openAlexId: paperMeta.openAlexId,
      doi: paperMeta.doi,
      landingPageUrl: radarProfile.link,
      fullTextUrl: paperMeta.fullTextUrl,
      pdfUrl: paperMeta.pdfUrl,
    }).sourceStatus
    effectiveEntityStatus = sourceStatus === 'confirmed' ? 'confirmed' : 'ambiguous'
    await pool.query(`UPDATE ${jobsTable} SET entity_status=?,updated_at=NOW(3) WHERE id=?`, [effectiveEntityStatus, lease.job_id])
    if (lease.entity_id) await pool.query(`UPDATE ${entitiesTable} SET status=?,updated_at=NOW(3) WHERE id=?`, [effectiveEntityStatus, lease.entity_id])
  }
  if (topicRequiresConfirmedEntity(lease.topic_key) && ['ambiguous', 'missing'].includes(effectiveEntityStatus)) {
    await finishTopic(lease, {
      status: 'review',
      metrics: { reason: 'entity_confirmation_required', entityStatus: effectiveEntityStatus, durationMs: Date.now() - topicStartedAt },
    })
    return
  }
  await recordTopicPhase(lease, 'fetching')
  const deterministic = isResearch ? paperDeterministicFacts(lease.topic_key, radarProfile) : []
  let insertedFacts = 0
  let deterministicRejectedFactCount = 0
  for (const fact of deterministic) {
    let document: Awaited<ReturnType<typeof fetchLeadSourceDocument>>
    try {
      document = await fetchLeadSourceDocument({ url: fact.evidence[0].sourceUrl, leadId: lease.lead_id })
    } catch {
      continue
    }
    if (!sourceDocumentContainsQuote(document.text, fact.evidence[0].quote)) continue
    const factSubject = routedSubject(fact.factKey)
    const candidate = {
      leadId: lease.lead_id, topicRunId: lease.id, topicKey: lease.topic_key,
      subjectType: factSubject.subjectType, subjectId: factSubject.subjectId, factKey: fact.factKey, value: fact.value,
      evidenceLevel: 'E2', verificationStatus: 'verified', evidence: fact.evidence.map((evidence) => ({
        ...evidence, sourceDocumentId: document.id, sourceUrl: document.finalUrl,
        contentType: document.contentType, title: document.title, publisher: document.publisher,
        pageHash: document.contentHash, publishedAt: document.publishedAt, accessedAt: document.accessedAt,
        reliability: 'E2',
      })),
    } as const
    try { validateLeadFactCandidate(candidate) } catch {
      deterministicRejectedFactCount += 1
      continue
    }
    const persisted = await persistLeadFact(candidate)
    if (persisted.inserted || persisted.unchanged) insertedFacts += 1
  }
  await recordTopicPhase(lease, 'planning')
  const researchGaps = isResearch ? leadResearchTopicGaps(lease.topic_key, radarProfile) : []
  const researchGapsByTopic = isResearch ? leadResearchTopicGapsByTopic(radarProfile) : {}
  if (isResearch && !leadResearchWebEnrichmentEnabled({ jobCreatedAt: lease.job_created_at })) {
    await finishTopic(lease, {
      status: insertedFacts > 0 ? 'completed' : 'missing',
      metrics: {
        deterministicFacts: insertedFacts,
        deterministicRejectedFactCount,
        webResearch: 'disabled_or_before_cutoff',
        identifiedGaps: researchGaps,
        durationMs: Date.now() - topicStartedAt,
      },
      promptVersion: 'lead-research-deterministic-metadata-v1',
      queryPlan: [],
    })
    return
  }
  if (isResearch && researchGaps.length === 0 && insertedFacts > 0) {
    await finishTopic(lease, {
      status: 'completed',
      metrics: { deterministicFacts: insertedFacts, identifiedGaps: [], webResearch: 'gap_driven_skip', durationMs: Date.now() - topicStartedAt },
      promptVersion: 'lead-research-deterministic-metadata-v1',
      queryPlan: [],
    })
    return
  }
  let web: Awaited<ReturnType<typeof researchLeadTopicWithWeb>>
  const researchContract = leadTopicResearchContract(lease.topic_key, lease.entity_type)
  const primaryEntityName = text(subjectEntityRows.find((entity) => entity.id === lease.entity_id)?.canonical_name)
  const researchEntityType = lease.entity_type
  const researchIdentityTitle = isResearch
    ? text(object(radarProfile.paperMeta).titleOriginal || object(radarProfile.paperMeta).title || object(radarProfile.paperMeta).titleZh)
    : ''
  const subjectName = researchIdentityTitle || primaryEntityName
    || (lease.entity_type === 'company' ? text(lead.company_name) : text(lead.name))
    || text(lead.company_name)
  let cacheHit = false
  await recordTopicPhase(lease, 'searching')
  const cached = effectiveEntityStatus === 'confirmed'
    ? await readLeadTopicSearchCache<Awaited<ReturnType<typeof researchLeadTopicWithWeb>>>({
      topicKey: lease.topic_key, subjectName, entityType: researchEntityType,
      promptVersion: researchContract.promptVersion, queryPlan: researchContract.queries,
    })
    : null
  try {
    web = cached ?? await researchLeadTopicWithWeb({
      topicKey: lease.topic_key,
      subjectName,
      entityType: researchEntityType,
      existingContext: {
        name: lead.name, companyName: lead.company_name, industry: lead.industry, summary: lead.summary,
        radarProfile, sources: list(lead.sources).slice(0, 20), researchGapsByTopic,
      },
    })
    cacheHit = Boolean(cached)
    if (!cacheHit && effectiveEntityStatus === 'confirmed') {
      await writeLeadTopicSearchCache({
        topicKey: lease.topic_key, subjectName, entityType: researchEntityType,
        promptVersion: researchContract.promptVersion, queryPlan: researchContract.queries,
        model: web.model, result: web,
      })
    }
    gatewayCircuit.recordSuccess()
  } catch (error) {
    const errorClass = classifyLeadEnrichmentError(error)
    if (!isLeadAgentRuntimeThrottleError(error)) {
      gatewayCircuit.recordFailure(isLeadEnrichmentProviderBudgetError(error) ? 'billing' : errorClass)
    }
    throw error
  }
  const sourceDocuments = new Map<string, Awaited<ReturnType<typeof fetchLeadSourceDocument>>>()
  await recordTopicPhase(lease, 'fetching')
  let sourceFetchFailures = 0
  const candidateFacts = [
    ...web.facts.map((fact) => ({ ...fact, declaredConflictKey: '', conflictReason: '' })),
    ...web.conflicts.flatMap((conflict) => conflict.candidates.map((candidate) => ({
      ...candidate,
      factKey: conflict.factKey,
      instanceKey: conflict.instanceKey,
      declaredConflictKey: leadFactIdentityKey(conflict.factKey, conflict.instanceKey),
      conflictReason: conflict.reason,
    }))),
  ]
  const requestedSourceUrls = [...new Set(candidateFacts.flatMap((fact) => fact.sourceUrls))].slice(0, 10)
  for (const sourceUrl of requestedSourceUrls) {
    try {
      sourceDocuments.set(sourceUrl, await fetchLeadSourceDocument({ url: sourceUrl, leadId: lease.lead_id }))
    } catch {
      sourceFetchFailures += 1
    }
  }
  await recordTopicPhase(lease, 'extracting')
  const subjectAliases = [lead.company_name, lead.name].map(text).filter(Boolean)
  let subjectMismatchObserved = 0
  for (const fact of candidateFacts) {
    for (const sourceUrl of fact.sourceUrls) {
      const document = sourceDocuments.get(sourceUrl)
      const exactMatch = Boolean(document && fact.quote
        && sourceDocumentContainsQuote(document.text, fact.quote)
        && leadSourceSupportsSubject({ topicKey: lease.topic_key, sourceText: document.text, subjectAliases }))
      if (document && !exactMatch) subjectMismatchObserved += 1
    }
  }
  const factSetContract = enforceLeadTopicFactSetContract(lease.topic_key, candidateFacts)
  const groupValidatedFacts = factSetContract.facts
  const declaredConflictCounts = new Map<string, number>()
  for (const fact of groupValidatedFacts) if (fact.declaredConflictKey) {
    declaredConflictCounts.set(fact.declaredConflictKey, (declaredConflictCounts.get(fact.declaredConflictKey) || 0) + 1)
  }
  const validatedFacts = groupValidatedFacts.filter((fact) => (
    !fact.declaredConflictKey || Number(declaredConflictCounts.get(fact.declaredConflictKey) || 0) >= 2
  ))
  const explicitConflictEvidenceFailed = web.conflicts.some((conflict) => (
    Number(declaredConflictCounts.get(leadFactIdentityKey(conflict.factKey, conflict.instanceKey)) || 0) < 2
  ))
  const hostDetected = detectLeadCandidateFactConflicts(validatedFacts)
  const factsForPersistence = validatedFacts
  await recordTopicPhase(lease, 'validating')
  let validationRejected = 0
  let hostConflicts = 0
  let lowerPriorityRejected = 0
  for (const fact of factsForPersistence) {
    const evidence = fact.sourceUrls.map((sourceUrl) => {
      const document = sourceDocuments.get(sourceUrl)
      const exactMatch = Boolean(document && fact.quote
        && sourceDocumentContainsQuote(document.text, fact.quote)
        && leadSourceSupportsSubject({ topicKey: lease.topic_key, sourceText: document.text, subjectAliases }))
      if (document && exactMatch) {
        const classification = classifyLeadWebEvidence({ sourceUrl: document.finalUrl })
        return {
          sourceUrl: document.finalUrl, sourceDocumentId: document.id, sourceType: classification.sourceType,
          contentType: document.contentType, quote: fact.quote,
          title: document.title || web.sources.find((source) => source.url === sourceUrl)?.title || '',
          publisher: document.publisher, pageHash: document.contentHash, publishedAt: document.publishedAt,
          accessedAt: document.accessedAt, reliability: classification.evidenceLevel,
        }
      }
      return {
        sourceUrl, sourceDocumentId: null, sourceType: 'web_search', contentType: 'text/html', quote: fact.quote,
        title: web.sources.find((source) => source.url === sourceUrl)?.title || '',
        publisher: '', pageHash: '', publishedAt: null, accessedAt: new Date(), reliability: 'E3',
      }
    })
    const evidenceLevel = evidence.some((item) => item.reliability === 'E1') ? 'E1'
      : evidence.some((item) => item.reliability === 'E2') ? 'E2' : 'E3'
    let persisted
    try {
      const factSubject = routedSubject(fact.factKey)
      persisted = await persistLeadFact({
        leadId: lease.lead_id, topicRunId: lease.id, topicKey: lease.topic_key,
        subjectType: factSubject.subjectType, subjectId: factSubject.subjectId,
        factKey: fact.factKey, instanceKey: fact.instanceKey, value: fact.value, unit: fact.unit, currency: fact.currency,
        periodStart: fact.period, periodEnd: fact.period, scope: fact.scope,
        conflictReason: fact.conflictReason,
        acceptanceMode: 'web_hit', evidenceLevel, verificationStatus: 'verified', evidence,
      })
    } catch {
      validationRejected += 1
      continue
    }
    if (persisted.conflicted) hostConflicts += 1
    if (persisted.rejectedLowerPriority) lowerPriorityRejected += 1
    if ((persisted.inserted || persisted.unchanged) && !persisted.rejectedLowerPriority) insertedFacts += 1
    if (fact.factKey === 'registry.registration_status') {
      const status = text(fact.value)
      if (status && evidenceLevel !== 'E3') await pool.query(`UPDATE ${jobsTable} SET entity_status='confirmed',updated_at=NOW(3) WHERE id=?`, [lease.job_id])
      if (status && lease.entity_id && evidenceLevel !== 'E3') await pool.query(`UPDATE ${entitiesTable} SET status='confirmed',updated_at=NOW(3) WHERE id=?`, [lease.entity_id])
      if (evidenceLevel !== 'E3' && (await excludeDeregisteredLeadFromPool({
        leadId: lease.lead_id, registrationStatus: status, sourceUrl: evidence[0]?.sourceUrl || '',
      })).excluded) return
    }
  }
  const candidateFactCount = Number(web.candidateFactCount ?? web.facts.length)
  const acceptedCandidateFactCount = web.facts.length
    + web.conflicts.reduce((sum, conflict) => sum + conflict.candidates.length, 0)
  const contractRejectedFactCount = Number(web.contractRejectedFactCount ?? 0)
  const totalValidationRejected = validationRejected + contractRejectedFactCount + factSetContract.rejectedFactCount
  const candidateEvidenceFailed = candidateFactCount > 0 && validatedFacts.length === 0
  const status = hostDetected.conflicts.length || hostConflicts || candidateEvidenceFailed || explicitConflictEvidenceFailed ? 'review'
    : insertedFacts && (
      web.gaps.length > 0 || totalValidationRejected > 0 || lowerPriorityRejected > 0
      || validatedFacts.length < candidateFactCount
    ) ? 'partial'
      : insertedFacts ? 'completed'
        : 'missing'
  await finishTopic(lease, {
    status,
    promptVersion: web.promptVersion,
    model: web.model,
    toolsetVersion: 'responses-web-search-v1',
    queryPlan: [...researchContract.queries],
    metrics: {
      promptVersion: web.promptVersion, model: web.model, facts: insertedFacts,
      candidateFacts: candidateFactCount, validatedWebFacts: validatedFacts.length,
      validationRejected: totalValidationRejected,
      contractRejectedFactCount,
      factSetContractRejectedFactCount: factSetContract.rejectedFactCount,
      factSetContractReasons: factSetContract.reasons,
      evidenceRejectedFactCount: Math.max(0, acceptedCandidateFactCount - validatedFacts.length),
      subjectMismatchObserved,
      persistenceRejectedFactCount: validationRejected,
      deterministicRejectedFactCount,
      lowerPriorityRejected,
      candidateEvidenceFailed,
      gaps: web.gaps.length + Math.max(0, candidateFactCount - validatedFacts.length),
      conflicts: hostConflicts,
      hostDetectedConflicts: hostDetected.conflicts.length,
      declaredConflicts: web.conflicts.length,
      declaredConflictEvidenceFailed: explicitConflictEvidenceFailed ? 1 : 0,
      searchSources: web.sources.length, fetchedSources: sourceDocuments.size, sourceFetchFailures,
      sourceMetadataFallback: Boolean(web.sourceMetadataFallback),
      queryCount: cacheHit ? 0 : researchContract.queries.length,
      pageCount: sourceDocuments.size,
      durationMs: Date.now() - topicStartedAt,
      cacheHit,
      estimatedCostUsd: cacheHit ? 0 : estimatedTopicCostUsd(web.usage),
      usage: cacheHit ? null : web.usage,
      cachedUsage: cacheHit ? web.usage : null,
    },
  })
}

async function runLease(lease: TopicLease) {
  const promise = (async () => {
    try { await executeTopic(lease) } catch (error) { await failTopic(lease, error) }
    finally { active.delete(lease.id); if (!stopping) void poll() }
  })()
  active.set(lease.id, promise)
  await promise
}

function poll(): Promise<void> {
  if (!started || stopping) return Promise.resolve()
  if (!gatewayCircuit.canRequest()) return Promise.resolve()
  if (Date.now() < localThrottleUntilMs) return Promise.resolve()
  if (polling) return polling
  const current = (async () => {
    await recoverExpiredLeadEnrichmentLeases()
    let capacity = concurrency - active.size
    while (capacity > 0) {
      const lease = await claimLeadEnrichmentTopicLease()
      if (!lease) break
      void runLease(lease)
      capacity -= 1
    }
  })().catch((error) => console.error('[lead-enrichment] poll failed:', redactSensitiveText(error)))
  polling = current
  void current.finally(() => { if (polling === current) polling = undefined })
  return current
}

export async function startLeadEnrichmentWorker() {
  if (started || !leadEnrichmentRuntimePolicy().workerEnabled) return
  stopping = false
  started = true
  await recoverExpiredLeadEnrichmentLeases()
  const providerBudgetDeadLetters = await quarantineProviderBudgetLeadEnrichmentRetries()
  if (providerBudgetDeadLetters) {
    console.warn(`[lead-enrichment] quarantined provider-budget retries=${providerBudgetDeadLetters}`)
  }
  timer = setInterval(() => void poll(), pollMs)
  timer.unref()
  await poll()
  console.log(`[lead-enrichment] worker ready owner=${owner} concurrency=${concurrency}`)
}

export async function stopLeadEnrichmentWorker() {
  if (!started) return
  stopping = true
  if (timer) clearInterval(timer)
  timer = undefined
  if (polling) await polling.catch(() => undefined)
  await Promise.all([...active.values()].map((promise) => promise.catch(() => undefined)))
  started = false
}

export async function leadEnrichmentWorkerHealth() {
  try {
    const runtimePolicy = leadEnrichmentRuntimePolicy()
    const [rows] = await pool.query<Array<RowDataPacket & { queued: number; running: number; retrying: number; dead_letter: number }>>(
      `SELECT SUM(status='queued') queued,SUM(status='running') running,SUM(status='retrying') retrying,
              SUM(status='dead_letter') dead_letter FROM ${topicRunsTable}`,
    )
    return {
      name: 'mysql-lead-enrichment', ok: !runtimePolicy.workerEnabled || (started && !stopping),
      inProcess: true, enabled: runtimePolicy.workerEnabled, acceptNewJobs: runtimePolicy.acceptNewJobs,
      owner, active: active.size,
      triggerTypeFilter: triggerTypeFilter || null,
      processAfter: processAfter?.toISOString() || null,
      localThrottleUntil: localThrottleUntilMs > Date.now() ? new Date(localThrottleUntilMs).toISOString() : null,
      queued: Number(rows[0]?.queued || 0), running: Number(rows[0]?.running || 0),
      retrying: Number(rows[0]?.retrying || 0), deadLetter: Number(rows[0]?.dead_letter || 0),
      circuit: gatewayCircuit.snapshot(),
    }
  } catch (error) {
    return { name: 'mysql-lead-enrichment', ok: false, inProcess: true, error: redactSensitiveText(error) }
  }
}

export async function leadEnrichmentOperationalMetrics() {
  const [
    [topicRows], [factRows], [conflictRows], [snapshotRows], [scoreRows], [usageRows],
    [entityRows], [qualityRows], [leaseRows], [staleRows], [ratingRows], [paperRows], [paperQualityRows],
  ] = await Promise.all([
    pool.query<Array<RowDataPacket & { status: string; count: number }>>(
      `SELECT status,COUNT(*) count FROM ${topicRunsTable} GROUP BY status ORDER BY status`,
    ),
    pool.query<Array<RowDataPacket & { evidence_level: string; verification_status: string; count: number }>>(
      `SELECT evidence_level,verification_status,COUNT(*) count FROM ${factsTable}
       WHERE is_current=1 GROUP BY evidence_level,verification_status ORDER BY evidence_level,verification_status`,
    ),
    pool.query<Array<RowDataPacket & { status: string; severity: string; count: number }>>(
      `SELECT status,severity,COUNT(*) count FROM ${conflictsTable} GROUP BY status,severity ORDER BY status,severity`,
    ),
    pool.query<Array<RowDataPacket & { status: string; count: number }>>(
      `SELECT status,COUNT(*) count FROM ${snapshotsTable} GROUP BY status ORDER BY status`,
    ),
    pool.query<Array<RowDataPacket & { status: string; count: number }>>(
      `SELECT status,COUNT(*) count FROM ${scoreJobsTable} GROUP BY status ORDER BY status`,
    ),
    pool.query<Array<RowDataPacket & {
      topic_key: string; model: string | null; runs: number; query_count: number; page_count: number;
      input_tokens: number; output_tokens: number; duration_ms: number; estimated_cost_usd: number;
    }>>(
      `SELECT topic_key,model,COUNT(*) runs,
              SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(metrics,'$.queryCount')) AS UNSIGNED),0)) query_count,
              SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(metrics,'$.pageCount')) AS UNSIGNED),0)) page_count,
              SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(metrics,'$.usage.inputTokens')) AS UNSIGNED),0)) input_tokens,
              SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(metrics,'$.usage.outputTokens')) AS UNSIGNED),0)) output_tokens,
              SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(metrics,'$.durationMs')) AS UNSIGNED),0)) duration_ms,
              SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(metrics,'$.estimatedCostUsd')) AS DECIMAL(18,8)),0)) estimated_cost_usd
       FROM ${topicRunsTable} WHERE completed_at IS NOT NULL GROUP BY topic_key,model ORDER BY topic_key,model`,
    ),
    pool.query<Array<RowDataPacket & { entity_status: string; count: number }>>(
      `SELECT entity_status,COUNT(*) count FROM ${jobsTable} GROUP BY entity_status ORDER BY entity_status`,
    ),
    pool.query<Array<RowDataPacket & {
      runs: number; candidate_facts: number; validated_facts: number;
      contract_rejected: number; evidence_rejected: number; persistence_rejected: number;
      cache_hits: number; retry_attempts: number; average_queue_delay_ms: number;
    }>>(
      `SELECT COUNT(*) runs,
              SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(metrics,'$.candidateFacts')) AS UNSIGNED),0)) candidate_facts,
              SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(metrics,'$.validatedWebFacts')) AS UNSIGNED),0)) validated_facts,
              SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(metrics,'$.contractRejectedFactCount')) AS UNSIGNED),0)) contract_rejected,
              SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(metrics,'$.evidenceRejectedFactCount')) AS UNSIGNED),0)) evidence_rejected,
              SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(metrics,'$.persistenceRejectedFactCount')) AS UNSIGNED),0)) persistence_rejected,
              SUM(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(metrics,'$.cacheHit'))='true' THEN 1 ELSE 0 END) cache_hits,
              SUM(GREATEST(execution_attempts-1,0)) retry_attempts,
              AVG(CASE WHEN started_at IS NOT NULL THEN TIMESTAMPDIFF(MICROSECOND,created_at,started_at)/1000 ELSE NULL END) average_queue_delay_ms
       FROM ${topicRunsTable} WHERE completed_at IS NOT NULL`,
    ),
    pool.query<Array<RowDataPacket & { recovered: number; expired: number }>>(
      `SELECT SUM(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(metrics,'$.lastLeaseDisposition'))='abandoned' THEN 1 ELSE 0 END) recovered,
              SUM(CASE WHEN status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<NOW(3) THEN 1 ELSE 0 END) expired
       FROM ${topicRunsTable}`,
    ),
    pool.query<Array<RowDataPacket & { stale: number }>>(
      `SELECT COUNT(*) stale FROM ${leadsTable}
       WHERE JSON_UNQUOTE(JSON_EXTRACT(scoring,'$.ratingV3.status'))='stale'
         AND pool_status NOT IN ('已删除','已合并','已注销','已转专属项目')`,
    ),
    pool.query<Array<RowDataPacket & { ratings: number; rated_leads: number }>>(
      `SELECT COUNT(*) ratings,COUNT(DISTINCT lead_id) rated_leads FROM ${ratingHistoryTable}`,
    ),
    pool.query<Array<RowDataPacket & { provider: string; status: string; count: number }>>(
      `SELECT COALESCE(NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(subject_profile,'$.paper.identity.provider')),'null'),''),'unknown') provider,
              status,COUNT(*) count
       FROM ${snapshotsTable}
       WHERE JSON_EXTRACT(subject_profile,'$.paper') IS NOT NULL
      GROUP BY provider,status ORDER BY provider,status`,
    ),
    pool.query<Array<RowDataPacket & {
      total: number; affiliation_missing: number; article_rights_missing: number;
      abnormal_dates: number; supplement_mislinks: number;
    }>>(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN COALESCE(JSON_LENGTH(JSON_EXTRACT(subject_profile,'$.paper.metadata.affiliations')),0)=0 THEN 1 ELSE 0 END) affiliation_missing,
              SUM(CASE WHEN JSON_EXTRACT(subject_profile,'$.paper.metadata.rights.articleLicense') IS NULL THEN 1 ELSE 0 END) article_rights_missing,
              SUM(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(subject_profile,'$.paper.metadata.publicationDateStatus')) IN ('source_declared_future','review') THEN 1 ELSE 0 END) abnormal_dates,
              SUM(CASE WHEN JSON_SEARCH(subject_profile,'one','%补充材料%',NULL,'$.paper.identity.reviewReasons[*]') IS NOT NULL THEN 1 ELSE 0 END) supplement_mislinks
       FROM ${snapshotsTable} WHERE JSON_EXTRACT(subject_profile,'$.paper') IS NOT NULL`,
    ),
  ])
  const entityTotal = entityRows.reduce((sum, row) => sum + Number(row.count), 0)
  const ambiguousEntities = entityRows
    .filter((row) => ['ambiguous', 'missing'].includes(row.entity_status))
    .reduce((sum, row) => sum + Number(row.count), 0)
  const quality = qualityRows[0]
  const candidateFacts = Number(quality?.candidate_facts || 0)
  const rejectedFacts = Number(quality?.contract_rejected || 0)
    + Number(quality?.evidence_rejected || 0)
    + Number(quality?.persistence_rejected || 0)
  const completedRuns = Number(quality?.runs || 0)
  const terminalTopicCount = topicRows
    .filter((row) => LEAD_ENRICHMENT_TERMINAL_TOPIC_STATUSES.has(row.status as never))
    .reduce((sum, row) => sum + Number(row.count), 0)
  const successfulTopicCount = topicRows
    .filter((row) => ['completed', 'partial'].includes(row.status))
    .reduce((sum, row) => sum + Number(row.count), 0)
  const noResultTopicCount = topicRows
    .filter((row) => ['missing', 'not_applicable'].includes(row.status))
    .reduce((sum, row) => sum + Number(row.count), 0)
  return {
    generatedAt: new Date().toISOString(),
    costRatesConfigured: topicCostRatesConfigured(),
    topics: Object.fromEntries(topicRows.map((row) => [row.status, Number(row.count)])),
    facts: factRows.map((row) => ({ evidenceLevel: row.evidence_level, verificationStatus: row.verification_status, count: Number(row.count) })),
    conflicts: conflictRows.map((row) => ({ status: row.status, severity: row.severity, count: Number(row.count) })),
    snapshots: Object.fromEntries(snapshotRows.map((row) => [row.status, Number(row.count)])),
    scoreJobs: Object.fromEntries(scoreRows.map((row) => [row.status, Number(row.count)])),
    entityResolution: {
      statuses: Object.fromEntries(entityRows.map((row) => [row.entity_status, Number(row.count)])),
      total: entityTotal, ambiguousOrMissing: ambiguousEntities,
      ambiguousOrMissingRatio: entityTotal ? Number((ambiguousEntities / entityTotal).toFixed(4)) : 0,
    },
    validation: {
      candidateFacts, validatedFacts: Number(quality?.validated_facts || 0), rejectedFacts,
      contractRejected: Number(quality?.contract_rejected || 0),
      evidenceRejected: Number(quality?.evidence_rejected || 0),
      persistenceRejected: Number(quality?.persistence_rejected || 0),
      rejectionRate: candidateFacts ? Number((rejectedFacts / candidateFacts).toFixed(4)) : 0,
    },
    cache: {
      completedRuns, hits: Number(quality?.cache_hits || 0),
      hitRate: completedRuns ? Number((Number(quality?.cache_hits || 0) / completedRuns).toFixed(4)) : 0,
    },
    lifecycle: {
      terminalTopics: terminalTopicCount, successfulTopics: successfulTopicCount, noResultTopics: noResultTopicCount,
      successRate: terminalTopicCount ? Number((successfulTopicCount / terminalTopicCount).toFixed(4)) : 0,
      noResultRate: terminalTopicCount ? Number((noResultTopicCount / terminalTopicCount).toFixed(4)) : 0,
      retryAttempts: Number(quality?.retry_attempts || 0),
      averageQueueDelayMs: Number(Number(quality?.average_queue_delay_ms || 0).toFixed(2)),
      leaseRecovered: Number(leaseRows[0]?.recovered || 0),
      leasesCurrentlyExpired: Number(leaseRows[0]?.expired || 0),
      deadLetters: Number(Object.fromEntries(topicRows.map((row) => [row.status, Number(row.count)])).dead_letter || 0),
    },
    ratings: {
      stale: Number(staleRows[0]?.stale || 0),
      snapshotBoundResults: Number(ratingRows[0]?.ratings || 0),
      ratedLeads: Number(ratingRows[0]?.rated_leads || 0),
    },
    papers: {
      providers: paperRows.map((row) => ({ provider: row.provider, status: row.status, count: Number(row.count) })),
      total: Number(paperQualityRows[0]?.total || 0),
      affiliationMissing: Number(paperQualityRows[0]?.affiliation_missing || 0),
      articleRightsMissing: Number(paperQualityRows[0]?.article_rights_missing || 0),
      abnormalDates: Number(paperQualityRows[0]?.abnormal_dates || 0),
      supplementMislinks: Number(paperQualityRows[0]?.supplement_mislinks || 0),
    },
    usage: usageRows.map((row) => ({
      topicKey: row.topic_key, model: row.model, runs: Number(row.runs), queryCount: Number(row.query_count),
      pageCount: Number(row.page_count), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
      durationMs: Number(row.duration_ms), estimatedCostUsd: topicCostRatesConfigured() ? Number(row.estimated_cost_usd) : null,
    })),
  }
}
