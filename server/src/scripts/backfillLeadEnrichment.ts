import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { LEAD_ENRICHMENT_TOPIC_KEYS, initialTopicStates, normalizePaperIdentity } from '../services/leadEnrichmentContract.js'
import { enqueueLeadEnrichmentJob } from '../services/leadEnrichmentService.js'
import { companyRegistrationEligibility } from '../services/leadRegistry.js'

type JsonObject = Record<string, unknown>

const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const jobsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_jobs'))
const topicsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_topic_runs'))
const factsTable = quoteMysqlIdentifier(mysqlTableName('lead_facts'))
const snapshotsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_snapshots'))
const investmentProfilesTable = quoteMysqlIdentifier(mysqlTableName('lead_investment_profile_projections'))
const ratingHistoryTable = quoteMysqlIdentifier(mysqlTableName('lead_rating_history'))
const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
const args = new Set(process.argv.slice(2))
const applying = args.has('--apply')
const rollback = args.has('--rollback')
const reporting = args.has('--report')
const retrying = args.has('--retry')

const RETRYABLE_ERROR_CLASSES = ['network', 'rate_limit', 'model', 'parse', 'validation', 'unknown'] as const
type RetryableErrorClass = typeof RETRYABLE_ERROR_CLASSES[number]

function option(name: string, fallback = '') {
  const prefix = `--${name}=`
  return [...args].find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback
}

function object(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject
  if (typeof value !== 'string') return {}
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {} } catch { return {} }
}

function text(value: unknown) {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : ''
}

function positiveInteger(value: string, fallback: number, maximum: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback
}

function classify(row: { company_name: string | null; radar_profile: unknown }) {
  const radar = object(row.radar_profile)
  if (text(radar.channel) === '论文') return 'research' as const
  if (text(row.company_name)) return 'company' as const
  const subjectType = text(object(radar.aiSubjectReview).subjectType).toLowerCase()
  if (subjectType === 'team' || subjectType === 'project') return subjectType
  return 'unknown' as const
}

function registrationStatus(row: { scoring: unknown; radar_profile: unknown }) {
  return text(object(object(row.scoring).registry).registrationStatus)
    || text(object(object(row.radar_profile).registry).registrationStatus)
}

async function tableExists(table: string) {
  const raw = mysqlTableName(table)
  const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) count FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?`, [raw],
  )
  return Number(rows[0]?.count || 0) === 1
}

async function cancelBatch(batchId: string) {
  if (!batchId) throw new Error('--rollback requires --batch-id=<stable-id>')
  if (!await tableExists('lead_enrichment_jobs')) throw new Error('lead enrichment migration is not installed')
  const triggerType = `historical-backfill:${batchId}`
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [protectedRows] = await connection.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(DISTINCT j.id) count FROM ${jobsTable} j
       LEFT JOIN ${topicsTable} tr ON tr.job_id=j.id
       LEFT JOIN ${factsTable} f ON f.topic_run_id=tr.id
       LEFT JOIN ${snapshotsTable} s ON s.job_id=j.id
       WHERE j.trigger_type=? AND (f.id IS NOT NULL OR s.id IS NOT NULL)`, [triggerType],
    )
    const [topics] = await connection.query(
      `UPDATE ${topicsTable} tr JOIN ${jobsTable} j ON j.id=tr.job_id
       SET tr.status='missing',tr.last_error='cancelled by historical backfill rollback',
           tr.completed_at=NOW(3),tr.lease_owner=NULL,tr.lease_expires_at=NULL,tr.updated_at=NOW(3)
       WHERE j.trigger_type=? AND j.status IN ('queued','running')
         AND tr.status IN ('queued','retrying','running')`, [triggerType],
    )
    const [jobs] = await connection.query(
      `UPDATE ${jobsTable} SET status='rejected',last_error='cancelled by historical backfill rollback',
         completed_at=NOW(3),lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW(3)
       WHERE trigger_type=? AND status IN ('queued','running')`, [triggerType],
    )
    await connection.query(
      `INSERT INTO ${auditTable}(id,user_id,user_name,module,action,target,result,request_id,created_at)
       VALUES (?,NULL,'（系统）','项目获取池','取消历史补全批次',?,'success',?,NOW(3))`,
      [randomUUID(), JSON.stringify({ batchId, protectedJobs: Number(protectedRows[0]?.count || 0) }), randomUUID()],
    )
    await connection.commit()
    console.log(JSON.stringify({
      mode: 'rollback-scheduling-only', batchId,
      cancelledJobs: Number((jobs as { affectedRows?: number }).affectedRows || 0),
      cancelledTopics: Number((topics as { affectedRows?: number }).affectedRows || 0),
      protectedJobsWithFactsOrSnapshots: Number(protectedRows[0]?.count || 0),
      deletedFacts: 0, deletedSnapshots: 0,
    }, null, 2))
  } catch (error) {
    await connection.rollback()
    throw error
  } finally { connection.release() }
}

async function reportBatch(batchId: string) {
  if (!batchId) throw new Error('--report requires --batch-id=<stable-id>')
  if (!await tableExists('lead_enrichment_jobs')) throw new Error('lead enrichment migration is not installed')
  const triggerType = `historical-backfill:${batchId}`
  const [[jobRows], [topicRows], [factRows], [snapshotRows], [profileRows], [ratingRows], [deregisteredRows]] = await Promise.all([
    pool.query<Array<RowDataPacket & { status: string; count: number }>>(
      `SELECT status,COUNT(*) count FROM ${jobsTable} WHERE trigger_type=? GROUP BY status ORDER BY status`, [triggerType],
    ),
    pool.query<Array<RowDataPacket & { status: string; count: number; cancelled: number }>>(
      `SELECT tr.status,COUNT(*) count,
              SUM(CASE WHEN tr.last_error='cancelled by historical backfill rollback' THEN 1 ELSE 0 END) cancelled
       FROM ${topicsTable} tr JOIN ${jobsTable} j ON j.id=tr.job_id
       WHERE j.trigger_type=? GROUP BY tr.status ORDER BY tr.status`, [triggerType],
    ),
    pool.query<Array<RowDataPacket & { facts: number; leads: number }>>(
      `SELECT COUNT(DISTINCT f.id) facts,COUNT(DISTINCT f.lead_id) leads
       FROM ${factsTable} f JOIN ${topicsTable} tr ON tr.id=f.topic_run_id
       JOIN ${jobsTable} j ON j.id=tr.job_id WHERE j.trigger_type=?`, [triggerType],
    ),
    pool.query<Array<RowDataPacket & { snapshots: number; ready: number; review: number }>>(
      `SELECT COUNT(DISTINCT s.id) snapshots,
              COUNT(DISTINCT CASE WHEN s.status='ready' THEN s.id END) ready,
              COUNT(DISTINCT CASE WHEN s.status='review' THEN s.id END) review
       FROM ${snapshotsTable} s JOIN ${jobsTable} j ON j.id=s.job_id WHERE j.trigger_type=?`, [triggerType],
    ),
    pool.query<Array<RowDataPacket & { profiles: number }>>(
      `SELECT COUNT(DISTINCT p.lead_id) profiles FROM ${investmentProfilesTable} p
       JOIN ${jobsTable} j ON j.lead_id=p.lead_id WHERE j.trigger_type=?`, [triggerType],
    ),
    pool.query<Array<RowDataPacket & { ratings: number; leads: number }>>(
      `SELECT COUNT(DISTINCT rh.id) ratings,COUNT(DISTINCT rh.lead_id) leads
       FROM ${ratingHistoryTable} rh JOIN ${snapshotsTable} s ON s.id=rh.snapshot_id
       JOIN ${jobsTable} j ON j.id=s.job_id WHERE j.trigger_type=?`, [triggerType],
    ),
    pool.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(DISTINCT l.id) count FROM ${leadsTable} l JOIN ${jobsTable} j ON j.lead_id=l.id
       WHERE j.trigger_type=? AND l.pool_status='已注销'`, [triggerType],
    ),
  ])
  const topics = Object.fromEntries(topicRows.map((row) => [row.status, Number(row.count)]))
  const cancelled = topicRows.reduce((sum, row) => sum + Number(row.cancelled || 0), 0)
  const searched = topicRows
    .filter((row) => !['queued', 'not_applicable'].includes(row.status))
    .reduce((sum, row) => sum + Number(row.count) - Number(row.cancelled || 0), 0)
  console.log(JSON.stringify({
    mode: 'report-read-only', batchId,
    jobs: Object.fromEntries(jobRows.map((row) => [row.status, Number(row.count)])),
    topics,
    outcome: {
      searched,
      found: Number(topics.completed || 0) + Number(topics.partial || 0),
      missing: Math.max(0, Number(topics.missing || 0) - cancelled),
      review: Number(topics.review || 0),
      failed: Number(topics.failed || 0) + Number(topics.dead_letter || 0),
      notApplicable: Number(topics.not_applicable || 0),
      cancelled,
    },
    facts: { count: Number(factRows[0]?.facts || 0), leads: Number(factRows[0]?.leads || 0) },
    snapshots: {
      count: Number(snapshotRows[0]?.snapshots || 0), ready: Number(snapshotRows[0]?.ready || 0),
      review: Number(snapshotRows[0]?.review || 0),
    },
    profilesAvailable: Number(profileRows[0]?.profiles || 0),
    reRated: { results: Number(ratingRows[0]?.ratings || 0), leads: Number(ratingRows[0]?.leads || 0) },
    deregisteredEvicted: Number(deregisteredRows[0]?.count || 0),
    note: 'Read-only batch report; no task, fact, snapshot, rating or lead was changed.',
  }, null, 2))
}

function retryErrorClass(value: string) {
  const normalized = value.normalize('NFKC').trim().toLowerCase()
  if (normalized === 'all-retryable') return normalized
  if ((RETRYABLE_ERROR_CLASSES as readonly string[]).includes(normalized)) return normalized as RetryableErrorClass
  throw new Error('--retry requires --error-class=<network|rate_limit|model|parse|validation|unknown|all-retryable>; budget is never retried automatically')
}

type RetryTopicRow = RowDataPacket & {
  id: string
  job_id: string
  status: string
  execution_attempts: number
  metrics: unknown
  error_class: string
  snapshot_id: string | null
  pool_status: string
  scoring: unknown
  radar_profile: unknown
}

function batchRetryCandidates(rows: RetryTopicRow[], errorClass: RetryableErrorClass | 'all-retryable') {
  return rows.filter((row) => {
    if (row.snapshot_id) return false
    if (['已删除', '已合并', '已注销', '解析失败', '已转专属项目'].includes(text(row.pool_status))) return false
    if (!companyRegistrationEligibility(registrationStatus(row)).eligibleForLeadPool) return false
    return errorClass === 'all-retryable'
      ? (RETRYABLE_ERROR_CLASSES as readonly string[]).includes(row.error_class)
      : row.error_class === errorClass
  })
}

async function retryBatch(batchId: string, rawErrorClass: string, apply: boolean) {
  if (!batchId) throw new Error('--retry requires --batch-id=<stable-id>')
  const errorClass = retryErrorClass(rawErrorClass)
  if (!await tableExists('lead_enrichment_jobs')) throw new Error('lead enrichment migration is not installed')
  const triggerType = `historical-backfill:${batchId}`
  const connection = await pool.getConnection()
  try {
    if (apply) await connection.beginTransaction()
    const [rows] = await connection.query<RetryTopicRow[]>(
      `SELECT tr.id,tr.job_id,tr.status,tr.execution_attempts,tr.metrics,
              COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(tr.metrics,'$.errorClass')),''),'unknown') error_class,
              s.id snapshot_id,l.pool_status,l.scoring,l.radar_profile
       FROM ${topicsTable} tr
       JOIN ${jobsTable} j ON j.id=tr.job_id
       JOIN ${leadsTable} l ON l.id=j.lead_id
       LEFT JOIN ${snapshotsTable} s ON s.job_id=j.id
       WHERE j.trigger_type=? AND tr.status IN ('failed','dead_letter')
       ORDER BY tr.created_at,tr.id${apply ? ' FOR UPDATE' : ''}`,
      [triggerType],
    )
    const candidates = batchRetryCandidates(rows, errorClass)
    const candidateIds = new Set(candidates.map((row) => row.id))
    const matchingErrorRows = rows.filter((row) => errorClass === 'all-retryable'
      ? (RETRYABLE_ERROR_CLASSES as readonly string[]).includes(row.error_class)
      : row.error_class === errorClass)
    const protectedBySnapshot = matchingErrorRows.filter((row) => Boolean(row.snapshot_id)).length
    const inactiveOrDeregistered = matchingErrorRows.filter((row) => !row.snapshot_id && !candidateIds.has(row.id)).length
    const byErrorClass = Object.fromEntries(RETRYABLE_ERROR_CLASSES.map((key) => [
      key, rows.filter((row) => row.error_class === key).length,
    ]))
    const jobIds = [...new Set(candidates.map((row) => row.job_id))]

    if (apply) {
      const at = new Date().toISOString()
      for (const row of candidates) {
        const metrics = object(row.metrics)
        const previousRetries = Array.isArray(metrics.batchRetries) ? metrics.batchRetries : []
        metrics.batchRetries = [...previousRetries, {
          batchId, errorClass: row.error_class, requestedErrorClass: errorClass,
          previousStatus: row.status, attempts: Number(row.execution_attempts || 0), at,
        }]
        await connection.query(
          `UPDATE ${topicsTable}
           SET status='queued',next_attempt_at=NOW(3),lease_owner=NULL,lease_expires_at=NULL,
               last_error=NULL,completed_at=NULL,metrics=CAST(? AS JSON),updated_at=NOW(3)
           WHERE id=?`,
          [JSON.stringify(metrics), row.id],
        )
      }
      if (jobIds.length > 0) {
        await connection.query(
          `UPDATE ${jobsTable}
           SET status='queued',lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,completed_at=NULL,updated_at=NOW(3)
           WHERE id IN (${jobIds.map(() => '?').join(',')})`,
          jobIds,
        )
      }
      await connection.query(
        `INSERT INTO ${auditTable}(id,user_id,user_name,module,action,target,result,request_id,created_at)
         VALUES (?,NULL,'（系统）','项目获取池','按错误类型重试历史补全批次',?,'success',?,NOW(3))`,
        [randomUUID(), JSON.stringify({
          batchId, errorClass, requeuedTopics: candidates.length, requeuedJobs: jobIds.length,
          protectedBySnapshot, inactiveOrDeregistered,
        }), randomUUID()],
      )
      await connection.commit()
    }

    console.log(JSON.stringify({
      mode: apply ? 'retry-apply' : 'retry-preview', batchId, errorClass,
      failedTopicsByErrorClass: byErrorClass,
      eligibleTopics: candidates.length, affectedJobs: jobIds.length,
      protectedBySnapshot, inactiveOrDeregistered,
      budgetExcluded: rows.filter((row) => row.error_class === 'budget').length,
      note: apply
        ? 'Eligible failed topics were requeued; execution attempts were preserved and an audit event was appended.'
        : 'Read-only retry preview. Add --apply to requeue eligible topics; budget failures are never retried automatically.',
    }, null, 2))
  } catch (error) {
    if (apply) await connection.rollback()
    throw error
  } finally { connection.release() }
}

async function main() {
  const batchId = option('batch-id')
  if (batchId && (!/^[A-Za-z0-9._-]{1,28}$/.test(batchId))) {
    throw new Error('--batch-id must be 1-28 safe characters so the persisted trigger type is lossless')
  }
  if (retrying) return await retryBatch(batchId, option('error-class'), applying)
  if (rollback) return await cancelBatch(batchId)
  if (reporting) return await reportBatch(batchId)
  const limit = positiveInteger(option('limit'), applying ? 100 : 10_000, 10_000)
  const offset = positiveInteger(option('offset'), 0, 10_000_000)
  const priority = positiveInteger(option('priority'), 500, 1_000)
  const explicitLeadIdsRequested = [...args].some((arg) => arg.startsWith('--lead-ids='))
  const explicitLeadIds = [...new Set(option('lead-ids').split(',').map((value) => value.trim()).filter(Boolean))]
  if (explicitLeadIdsRequested && !explicitLeadIds.length) {
    throw new Error('--lead-ids was provided but empty; refusing to fall back to page mode')
  }
  if (applying && !explicitLeadIds.length && !args.has('--allow-page-selection')) {
    throw new Error('page-mode apply requires explicit --allow-page-selection acknowledgement')
  }
  if (explicitLeadIds.length > 100) throw new Error('--lead-ids accepts at most 100 explicit IDs per batch')
  if (explicitLeadIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id))) {
    throw new Error('--lead-ids contains an invalid UUID')
  }
  if (applying && !batchId) throw new Error('--apply requires --batch-id=<stable-id> for idempotent resume')
  if (applying && !await tableExists('lead_enrichment_jobs')) throw new Error('lead enrichment migration is not installed')

  const leadSelectionSql = explicitLeadIds.length
    ? `SELECT id,company_name,scoring,radar_profile,pool_status FROM ${leadsTable}
       WHERE id IN (${explicitLeadIds.map(() => '?').join(',')})
         AND pool_status NOT IN ('已删除','已合并','已注销','解析失败','已转专属项目')
       ORDER BY created_at,id`
    : `SELECT id,company_name,scoring,radar_profile,pool_status FROM ${leadsTable}
       WHERE pool_status NOT IN ('已删除','已合并','已注销','解析失败','已转专属项目')
       ORDER BY created_at,id LIMIT ? OFFSET ?`
  const [rows] = await pool.query<Array<RowDataPacket & {
    id: string; company_name: string | null;
    scoring: unknown; radar_profile: unknown; pool_status: string;
  }>>(leadSelectionSql, explicitLeadIds.length ? explicitLeadIds : [limit, offset])
  if (explicitLeadIds.length && rows.length !== explicitLeadIds.length) {
    throw new Error('--lead-ids includes a missing or inactive lead; no jobs were queued')
  }

  const summary = {
    candidatesRead: rows.length,
    eligible: 0,
    deregisteredExcluded: 0,
    entityTypes: { company: 0, project: 0, team: 0, research: 0, unknown: 0 },
    paperProviders: { arxiv: 0, openalex: 0, crossref: 0, publisher: 0, repository: 0, unknown: 0 },
    estimatedTopicRuns: 0,
    queuedJobs: 0,
    duplicateJobs: 0,
    skipped: 0,
  }
  for (const row of rows) {
    if (!companyRegistrationEligibility(registrationStatus(row)).eligibleForLeadPool) {
      summary.deregisteredExcluded += 1
      continue
    }
    const entityType = classify(row)
    summary.entityTypes[entityType] += 1
    summary.eligible += 1
    const radar = object(row.radar_profile)
    if (entityType === 'research') {
      const paperMeta = object(radar.paperMeta)
      const provider = normalizePaperIdentity({
        provider: object(paperMeta.metadataSource).provider, sourceName: radar.sourceName,
        sourceId: radar.sourceId, arxivId: paperMeta.arxivId, openAlexId: paperMeta.openAlexId,
        doi: paperMeta.doi, landingPageUrl: radar.link, pdfUrl: paperMeta.pdfUrl,
      }).provider
      summary.paperProviders[provider] += 1
    }
    const states = initialTopicStates({ entityType, hasCommercialCompany: Boolean(text(row.company_name)) })
    summary.estimatedTopicRuns += Object.values(states).filter((status) => status === 'queued').length
    if (!applying) continue
    const queued = await enqueueLeadEnrichmentJob({
      leadId: row.id,
      triggerType: `historical-backfill:${batchId}`,
      priority,
      idempotencyToken: batchId,
    })
    if (queued.queued) summary.queuedJobs += 1
    else if (queued.reason === 'duplicate') summary.duplicateJobs += 1
    else summary.skipped += 1
  }

  console.log(JSON.stringify({
    mode: applying ? 'apply' : 'preview',
    batchId: batchId || null,
    priority,
    target: explicitLeadIds.length ? { mode: 'explicit-lead-ids', leadIds: explicitLeadIds } : { mode: 'page', limit, offset },
    ...summary,
    estimatedSearchCallsUpperBound: summary.estimatedTopicRuns * 6,
    note: applying
      ? 'Idempotent batch queued; rerun with the same batch-id and page to resume safely.'
      : 'Read-only preview. No tasks, facts, snapshots or ratings were written.',
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}).finally(async () => await pool.end())
