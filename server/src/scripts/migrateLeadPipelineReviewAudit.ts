import { createHash } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import type { PoolConnection } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  finishLeadPipelineRun,
  openLeadPipelineReview,
  recordLeadPipelineDecision,
  registerLeadPipelinePromptVersion,
  startLeadPipelineRun,
} from '../services/leadPipelineAuditService.js'
import { prepareRadarAiCandidate, type RadarAiReviewDecision } from '../services/radarAiReviewService.js'

type LegacyReviewRow = RowDataPacket & {
  cache_key: string
  source_key: string
  content_hash: string
  prompt_version: string
  model: string
  status: 'accepted' | 'rejected' | 'review' | 'failed'
  decision: RadarAiReviewDecision | string
  attempts: number
  last_error: string | null
  created_at: Date
  updated_at: Date
}

type RawRow = RowDataPacket & {
  id: string
  payload: Record<string, unknown> | string
}

const apply = process.argv.includes('--apply')
const reviewsTable = quoteMysqlIdentifier(mysqlTableName('radar_ai_reviews'))
const rawTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_raw_events'))
const runsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_runs'))
const decisionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_decisions'))

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function sourceIdHash(value: string) {
  return sha256(value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase())
}

function objectValue(value: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof value !== 'string') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function matchingEvent(connection: PoolConnection, row: LegacyReviewRow) {
  const [candidates] = await connection.query<RawRow[]>(
    `SELECT id, payload FROM ${rawTable}
     WHERE source_type='radar' AND source_id_hash=? ORDER BY ingested_at DESC LIMIT 50`,
    [sourceIdHash(row.source_key)],
  )
  const matches = candidates.filter((candidate) => {
    const prepared = prepareRadarAiCandidate(objectValue(candidate.payload), row.model)
    return prepared.cacheKey === row.cache_key
      && prepared.contentHash === row.content_hash
      && prepared.promptVersion === row.prompt_version
  })
  return matches.length === 1 ? matches[0].id : null
}

async function migrateReview(row: LegacyReviewRow) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const eventId = await matchingEvent(connection, row)
    if (!eventId) {
      await connection.rollback()
      return 'unmatched' as const
    }
    const decisionValue = objectValue(row.decision as Record<string, unknown> | string) as unknown as RadarAiReviewDecision
    const prompt = await registerLeadPipelinePromptVersion({
      agentProfile: 'lead-subject-agent',
      promptVersion: row.prompt_version,
      schemaVersion: 'radar-subject-decision-v1',
      skillVersion: 'legacy-cache-import-v1',
      toolsetVersion: 'unknown-legacy-v1',
      prompt: `UNAVAILABLE_LEGACY_PROMPT:${row.prompt_version}`,
      configuration: {
        importedFrom: 'radar_ai_reviews',
        promptBodyAvailable: false,
        tokenAccountingAvailable: false,
      },
    }, connection)
    const run = await startLeadPipelineRun({
      runKey: `legacy-radar-ai-review:${row.cache_key}`,
      eventIds: [eventId],
      runtime: 'legacy-cache-import',
      agentProfile: 'lead-subject-agent',
      promptVersionId: prompt.id,
      model: row.model,
      attempt: Math.max(1, Number(row.attempts || 1)),
      startedAt: row.created_at,
      metadata: { importedFrom: 'radar_ai_reviews', cacheKey: row.cache_key },
    }, connection)
    const outcome = row.status === 'accepted'
      ? 'accept' as const
      : row.status === 'rejected'
        ? 'reject' as const
        : row.status === 'failed'
          ? 'failed' as const
          : 'review' as const
    const reason = String(decisionValue?.rejectReason || row.last_error || (outcome === 'accept'
      ? 'legacy radar subject review accepted and imported'
      : `legacy radar subject review: ${outcome}`))
    const evidence = decisionValue?.evidence ? [{
      sourceId: row.source_key,
      sourceType: 'radar',
      locator: 'legacy candidate source text',
      claim: outcome === 'accept'
        ? `原文支持主体 ${decisionValue.subjectName} 及其投资相关性`
        : reason,
      quote: decisionValue.evidence,
      verificationStatus: outcome === 'accept' ? 'verified' as const : 'unverified' as const,
      metadata: { contentHash: row.content_hash, legacyImport: true },
    }] : []
    const decision = await recordLeadPipelineDecision({
      idempotencyKey: `legacy-radar-ai-review:${row.cache_key}:${row.status}`,
      eventId,
      runId: run.id,
      decisionType: 'subject_identification',
      outcome,
      subjectType: decisionValue?.subjectType,
      subjectName: decisionValue?.subjectName,
      legalName: decisionValue?.legalName,
      confidence: Number(decisionValue?.confidence || 0) * 100,
      reason,
      output: objectValue(row.decision as Record<string, unknown> | string),
      actorType: 'migration',
      actorId: 'radar-ai-review-audit-v1',
      evidence,
    }, connection)
    if (outcome === 'review') {
      await openLeadPipelineReview({
        idempotencyKey: `legacy-radar-ai-review:${row.cache_key}`,
        eventId,
        triggerDecisionId: decision.id,
        reason,
      }, connection)
    }
    await finishLeadPipelineRun(run.id, {
      status: row.status === 'failed' ? 'failed' : 'succeeded',
      error: row.last_error,
      finishedAt: row.updated_at,
    }, connection)
    await connection.commit()
    return 'migrated' as const
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

async function main() {
  await ensureSchema()
  const [[reviewCountRows], [auditCountRows]] = await Promise.all([
    pool.query<Array<RowDataPacket & { count: number }>>(`SELECT COUNT(*) count FROM ${reviewsTable}`),
    pool.query<Array<RowDataPacket & { runs: number; decisions: number }>>(
      `SELECT (SELECT COUNT(*) FROM ${runsTable} WHERE runtime='legacy-cache-import') runs,
        (SELECT COUNT(*) FROM ${decisionsTable} WHERE actor_id='radar-ai-review-audit-v1') decisions`,
    ),
  ])
  const preview = {
    legacyReviews: Number(reviewCountRows[0]?.count || 0),
    existingImportedRuns: Number(auditCountRows[0]?.runs || 0),
    existingImportedDecisions: Number(auditCountRows[0]?.decisions || 0),
  }
  if (!apply) {
    console.log(JSON.stringify({ ok: true, mode: 'preview', ...preview }))
    return
  }
  const [rows] = await pool.query<LegacyReviewRow[]>(`SELECT * FROM ${reviewsTable} ORDER BY created_at, cache_key`)
  let migrated = 0
  let unmatched = 0
  for (const row of rows) {
    const result = await migrateReview(row)
    migrated += Number(result === 'migrated')
    unmatched += Number(result === 'unmatched')
  }
  console.log(JSON.stringify({ ok: true, mode: 'apply', ...preview, migrated, unmatched }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => await pool.end())

