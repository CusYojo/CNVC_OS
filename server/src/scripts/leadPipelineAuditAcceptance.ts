import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { recordLeadPipelineRawEvent } from '../services/leadPipelineEventService.js'
import {
  recordLeadPipelineDecision,
  registerLeadPipelinePromptVersion,
  resolveLeadPipelineReview,
} from '../services/leadPipelineAuditService.js'
import {
  prepareRadarAiCandidate,
  reviewRadarCandidatesWithAi,
  type LeadSubjectAgentRunner,
} from '../services/radarAiReviewService.js'

const rawTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_raw_events'))
const itemsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_items'))
const transitionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_transitions'))
const promptTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_prompt_versions'))
const runsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_runs'))
const decisionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_decisions'))
const evidenceTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_evidence'))
const reviewsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_reviews'))
const radarReviewsTable = quoteMysqlIdentifier(mysqlTableName('radar_ai_reviews'))
const usersTable = quoteMysqlIdentifier(mysqlTableName('users'))

const checks: string[] = []
function check(condition: unknown, name: string, detail?: unknown) {
  assert.ok(condition, detail == null ? name : `${name}: ${JSON.stringify(detail)}`)
  checks.push(name)
}

async function main() {
  await Promise.all([ensureSchema(), ensureSchema(), ensureSchema()])
  check(true, 'concurrent-schema-initialization-serialized-by-mysql-lock')

  const suffix = randomUUID()
  const model = `audit-acceptance-${suffix}`
  const items = [{
    source: 'acceptance-radar',
    source_id: `accept-${suffix}`,
    source_group: '融资新闻',
    title: `审计星科技完成新一轮融资 ${suffix}`,
    summary: '审计星科技完成新一轮融资，产品已获得客户订单。',
  }, {
    source: 'acceptance-radar',
    source_id: `review-${suffix}`,
    source_group: '融资新闻',
    title: `复核云项目出现多主体信息 ${suffix}`,
    summary: '复核云项目与另一团队共同披露合作，主要投资主体仍需确认。',
  }, {
    source: 'acceptance-radar',
    source_id: `reject-${suffix}`,
    source_group: '行业新闻',
    title: `低价值候选缺少投资信号 ${suffix}`,
    summary: '低价值候选仅为行业活动报道，没有融资、客户或商业化信息。',
  }]
  const raw = await Promise.all(items.map(async (item) => await recordLeadPipelineRawEvent({
    sourceType: 'radar',
    sourceId: `${item.source}:${item.source_id}`,
    payload: item,
  })))
  const prepared = items.map((item) => prepareRadarAiCandidate(item, model))
  const agentRunner: LeadSubjectAgentRunner = async () => ({
    output: {
      reviews: [{
        candidateId: prepared[0].candidateId,
        decision: 'accept',
        subjectType: 'company',
        subjectName: '审计星科技',
        legalName: '',
        evidence: '审计星科技完成新一轮融资，产品已获得客户订单。',
        confidence: 0.93,
        rejectReason: '',
        translatedTitle: '',
        translatedSummary: '',
      }, {
        candidateId: prepared[1].candidateId,
        decision: 'review',
        subjectType: 'project',
        subjectName: '复核云项目',
        legalName: '',
        evidence: '复核云项目与另一团队共同披露合作，主要投资主体仍需确认。',
        confidence: 0.72,
        rejectReason: '多主体信息需人工复核',
        translatedTitle: '',
        translatedSummary: '',
      }, {
        candidateId: prepared[2].candidateId,
        decision: 'reject',
        subjectType: 'project',
        subjectName: '低价值候选',
        legalName: '',
        evidence: '低价值候选仅为行业活动报道，没有融资、客户或商业化信息。',
        confidence: 0.2,
        rejectReason: '没有可验证的投资相关信号',
        translatedTitle: '',
        translatedSummary: '',
      }],
    },
    runtime: 'claude-agent-sdk',
    usage: { inputTokens: 321, outputTokens: 45, totalTokens: 366 },
    durationMs: 42,
    costMicrousd: 1_234,
    toolCalls: 0,
    numTurns: 1,
    sessionId: `agent-session-${suffix}`,
  })

  const results = await reviewRadarCandidatesWithAi(items, {
    model,
    eventIds: raw.map((entry) => entry.event.id),
    agentRunner,
  })
  check(results[0].status === 'accepted' && results[1].status === 'review' && results[2].status === 'rejected',
    'accept-reject-review-model-results-pass-host-validation', results.map((entry) => entry.status))

  const [runRows] = await pool.query<Array<RowDataPacket & {
    id: string
    event_ids: string[] | string
    runtime: string
    status: string
    model: string
    input_tokens: number
    output_tokens: number
    total_tokens: number
    duration_ms: number
    tool_calls: number
    cost_microusd: number
  }>>(`SELECT * FROM ${runsTable} WHERE model=?`, [model])
  check(runRows.length === 1
    && runRows[0].runtime === 'claude-agent-sdk'
    && runRows[0].status === 'succeeded'
    && Number(runRows[0].input_tokens) === 321
    && Number(runRows[0].output_tokens) === 45
    && Number(runRows[0].total_tokens) === 366
    && Number(runRows[0].duration_ms) === 42
    && Number(runRows[0].tool_calls) === 0
    && Number(runRows[0].cost_microusd) === 1_234,
  'agent-run-persists-runtime-token-duration-cost-zero-tools-and-status', runRows)

  const [decisionRows] = await pool.query<Array<RowDataPacket & {
    id: string
    event_id: string
    run_id: string
    outcome: string
    subject_name: string | null
    confidence: number | null
    actor_type: string
  }>>(`SELECT * FROM ${decisionsTable} WHERE run_id=? ORDER BY created_at, id`, [runRows[0].id])
  check(decisionRows.length === 3
    && decisionRows.some((row) => row.outcome === 'accept' && row.subject_name === '审计星科技' && Number(row.confidence) === 93)
    && decisionRows.some((row) => row.outcome === 'review' && row.subject_name === '复核云项目' && Number(row.confidence) === 72)
    && decisionRows.some((row) => row.outcome === 'reject' && row.subject_name === '低价值候选' && Number(row.confidence) === 20),
  'accept-reject-review-decisions-persist-reason-confidence-and-agent-run', decisionRows)

  const [evidenceRows] = await pool.query<Array<RowDataPacket & {
    decision_id: string
    event_id: string
    quote: string
    verification_status: string
  }>>(`SELECT * FROM ${evidenceTable} WHERE event_id IN (${raw.map(() => '?').join(',')})`, raw.map((entry) => entry.event.id))
  check(evidenceRows.length === 3
    && evidenceRows.some((row) => row.verification_status === 'verified' && row.quote.includes('客户订单')),
  'point-of-decision-evidence-is-normalized-and-verifiable', evidenceRows)

  const [reviewRows] = await pool.query<Array<RowDataPacket & {
    id: string
    event_id: string
    trigger_decision_id: string
    status: string
  }>>(`SELECT * FROM ${reviewsTable} WHERE event_id=?`, [raw[1].event.id])
  check(reviewRows.length === 1 && reviewRows[0].status === 'pending'
    && decisionRows.some((row) => row.id === reviewRows[0].trigger_decision_id && row.outcome === 'review'),
  'review-outcome-creates-auditable-pending-review', reviewRows)

  await reviewRadarCandidatesWithAi(items, {
    model,
    eventIds: raw.map((entry) => entry.event.id),
    agentRunner: async () => { throw new Error('cache replay must not call Agent') },
  })
  const [[runCount], [decisionCount]] = await Promise.all([
    pool.query<Array<RowDataPacket & { count: number }>>(`SELECT COUNT(*) count FROM ${runsTable} WHERE model=?`, [model]),
    pool.query<Array<RowDataPacket & { count: number }>>(`SELECT COUNT(*) count FROM ${decisionsTable} WHERE run_id=?`, [runRows[0].id]),
  ])
  check(Number(runCount[0].count) === 1 && Number(decisionCount[0].count) === 3,
    'cache-replay-does-not-duplicate-run-or-agent-decisions')

  const failureItem = {
    source: 'acceptance-radar',
    source_id: `failure-${suffix}`,
    source_group: '融资新闻',
    title: `失败审计候选 ${suffix}`,
    summary: '失败审计候选用于验证模型错误的安全持久化。',
  }
  const failureModel = `${model}-failure`
  const failurePrepared = prepareRadarAiCandidate(failureItem, failureModel)
  const failureRaw = await recordLeadPipelineRawEvent({
    sourceType: 'radar',
    sourceId: `${failureItem.source}:${failureItem.source_id}`,
    payload: failureItem,
  })
  const failedResults = await reviewRadarCandidatesWithAi([failureItem], {
    model: failureModel,
    eventIds: [failureRaw.event.id],
    agentRunner: async () => {
      const error = new Error('password=AuditSecret123!') as Error & {
        retryable?: boolean
        leadRunMetrics?: Record<string, unknown>
      }
      error.retryable = true
      error.leadRunMetrics = {
        runtime: 'claude-agent-sdk',
        usage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 },
        durationMs: 17,
        costMicrousd: 99,
        toolCalls: 0,
        numTurns: 1,
        sessionId: `failed-agent-session-${suffix}`,
      }
      throw error
    },
  })
  const [failedRunRows] = await pool.query<Array<RowDataPacket & {
    runtime: string
    status: string
    error: string
    input_tokens: number
    tool_calls: number
    cost_microusd: number
  }>>(
    `SELECT runtime,status,error,input_tokens,tool_calls,cost_microusd FROM ${runsTable} WHERE model=? ORDER BY attempt`, [failureModel],
  )
  const [failedDecisionRows] = await pool.query<Array<RowDataPacket & { outcome: string; reason: string }>>(
    `SELECT outcome,reason FROM ${decisionsTable} WHERE event_id=?`, [failureRaw.event.id],
  )
  check(failedResults[0].status === 'failed'
    && failedRunRows.length === 3
    && failedRunRows.every((row) => row.runtime === 'claude-agent-sdk'
      && row.status === 'failed'
      && Number(row.input_tokens) === 7
      && Number(row.tool_calls) === 0
      && Number(row.cost_microusd) === 99
      && !row.error.includes('AuditSecret123'))
    && failedDecisionRows.length === 1
    && failedDecisionRows[0].outcome === 'failed'
    && !failedDecisionRows[0].reason.includes('AuditSecret123'),
  'each-failed-model-attempt-persists-redacted-error-and-final-decision', {
    result: failedResults[0].status,
    runs: failedRunRows.length,
    decisions: failedDecisionRows,
  })

  const [users] = await pool.query<Array<RowDataPacket & { id: string }>>(
    `SELECT id FROM ${usersTable} WHERE status='启用' ORDER BY id LIMIT 1`,
  )
  assert.ok(users[0]?.id, 'an enabled user is required for manual review acceptance')
  const resolutionKey = `manual-resolution-${suffix}`
  const resolved = await resolveLeadPipelineReview({
    reviewId: reviewRows[0].id,
    reviewerUserId: users[0].id,
    idempotencyKey: resolutionKey,
    outcome: 'reject',
    subjectType: 'project',
    subjectName: '复核云项目',
    confidence: 100,
    reason: '人工确认主要投资主体不唯一，拒绝自动入池',
    output: { reviewedByHuman: true },
  })
  check(resolved.review.status === 'resolved'
    && resolved.decision.parentDecisionId === reviewRows[0].trigger_decision_id
    && resolved.decision.actorType === 'user',
  'manual-resolution-appends-child-decision-and-preserves-agent-history', resolved)

  const repeated = await resolveLeadPipelineReview({
    reviewId: reviewRows[0].id,
    reviewerUserId: users[0].id,
    idempotencyKey: resolutionKey,
    outcome: 'reject',
    subjectType: 'project',
    subjectName: '复核云项目',
    confidence: 100,
    reason: '人工确认主要投资主体不唯一，拒绝自动入池',
    output: { reviewedByHuman: true },
  })
  check(repeated.decision.id === resolved.decision.id, 'manual-resolution-retry-is-idempotent')

  await assert.rejects(() => resolveLeadPipelineReview({
    reviewId: reviewRows[0].id,
    reviewerUserId: users[0].id,
    idempotencyKey: `conflict-${suffix}`,
    outcome: 'accept',
    subjectType: 'project',
    subjectName: '复核云项目',
    confidence: 100,
    reason: 'conflicting overwrite must fail',
    evidence: [{ sourceType: 'manual', claim: 'conflict' }],
  }), /immutable/)
  check(true, 'resolved-review-cannot-be-silently-overwritten')

  const promptVersion = `acceptance-prompt-${suffix}`
  const prompt = await registerLeadPipelinePromptVersion({
    agentProfile: 'acceptance-agent',
    promptVersion,
    schemaVersion: 'acceptance-schema-v1',
    skillVersion: 'acceptance-skill-v1',
    toolsetVersion: 'acceptance-tools-v1',
    prompt: 'immutable prompt body',
  })
  const promptAgain = await registerLeadPipelinePromptVersion({
    agentProfile: 'acceptance-agent',
    promptVersion,
    schemaVersion: 'acceptance-schema-v1',
    skillVersion: 'acceptance-skill-v1',
    toolsetVersion: 'acceptance-tools-v1',
    prompt: 'immutable prompt body',
  })
  check(prompt.id === promptAgain.id, 'prompt-skill-schema-toolset-version-registration-is-idempotent')
  await assert.rejects(() => registerLeadPipelinePromptVersion({
    agentProfile: 'acceptance-agent',
    promptVersion,
    schemaVersion: 'acceptance-schema-v1',
    skillVersion: 'acceptance-skill-v1',
    toolsetVersion: 'acceptance-tools-v1',
    prompt: 'mutated prompt body under same version',
  }), /immutable/)
  check(true, 'published-prompt-contract-cannot-mutate-in-place')

  await assert.rejects(() => recordLeadPipelineDecision({
    idempotencyKey: `invalid-accept-${suffix}`,
    eventId: raw[0].event.id,
    decisionType: 'subject_identification',
    outcome: 'accept',
    subjectType: 'company',
    subjectName: '无证据主体',
    confidence: 100,
    reason: 'must fail without evidence',
    actorType: 'agent',
    actorId: model,
  }), /requires a subject and evidence/)
  check(true, 'accepted-decision-without-evidence-is-rejected-before-write')

  const [orphanRows] = await pool.query<Array<RowDataPacket & {
    run_orphans: number
    decision_orphans: number
    evidence_orphans: number
    review_orphans: number
  }>>(`SELECT
    (SELECT COUNT(*) FROM ${runsTable} r LEFT JOIN ${rawTable} e ON e.id=r.primary_event_id WHERE e.id IS NULL) run_orphans,
    (SELECT COUNT(*) FROM ${decisionsTable} d LEFT JOIN ${rawTable} e ON e.id=d.event_id WHERE e.id IS NULL) decision_orphans,
    (SELECT COUNT(*) FROM ${evidenceTable} v LEFT JOIN ${decisionsTable} d ON d.id=v.decision_id WHERE d.id IS NULL) evidence_orphans,
    (SELECT COUNT(*) FROM ${reviewsTable} q LEFT JOIN ${decisionsTable} d ON d.id=q.trigger_decision_id WHERE d.id IS NULL) review_orphans`)
  check(Object.values(orphanRows[0]).every((value) => Number(value) === 0),
    'pipeline-audit-foreign-key-reconciliation-has-no-orphans', orphanRows[0])

  const allEventIds = [...raw.map((entry) => entry.event.id), failureRaw.event.id]
  const eventPlaceholders = allEventIds.map(() => '?').join(',')
  await pool.query(`DELETE FROM ${reviewsTable} WHERE event_id IN (${eventPlaceholders})`, allEventIds)
  await pool.query(`DELETE FROM ${evidenceTable} WHERE event_id IN (${eventPlaceholders})`, allEventIds)
  await pool.query(
    `DELETE FROM ${decisionsTable} WHERE event_id IN (${eventPlaceholders}) AND parent_decision_id IS NOT NULL`,
    allEventIds,
  )
  await pool.query(
    `DELETE FROM ${decisionsTable} WHERE event_id IN (${eventPlaceholders}) AND parent_decision_id IS NULL`,
    allEventIds,
  )
  await pool.query(`DELETE FROM ${runsTable} WHERE model IN (?, ?)`, [model, failureModel])
  const allCacheKeys = [...prepared.map((entry) => entry.cacheKey), failurePrepared.cacheKey]
  await pool.query(
    `DELETE FROM ${radarReviewsTable} WHERE cache_key IN (${allCacheKeys.map(() => '?').join(',')})`,
    allCacheKeys,
  )
  await pool.query(`DELETE FROM ${promptTable} WHERE id=?`, [prompt.id])
  await pool.query(`DELETE FROM ${transitionsTable} WHERE event_id IN (${eventPlaceholders})`, allEventIds)
  await pool.query(`DELETE FROM ${itemsTable} WHERE event_id IN (${eventPlaceholders})`, allEventIds)
  await pool.query(`DELETE FROM ${rawTable} WHERE id IN (${eventPlaceholders})`, allEventIds)

  console.log(JSON.stringify({ ok: true, checks, count: checks.length }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => await pool.end())
