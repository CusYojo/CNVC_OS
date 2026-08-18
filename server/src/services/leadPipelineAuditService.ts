import { createHash, randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import type { PoolConnection } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { redactSensitiveText } from '../security/redactSecrets.js'

export type LeadPipelineDecisionOutcome = 'accept' | 'reject' | 'review' | 'failed'

export type LeadPipelineEvidenceInput = {
  sourceId?: string | null
  sourceType: string
  locator?: string | null
  claim: string
  quote?: string | null
  sourceUrl?: string | null
  reliability?: string | null
  verificationStatus?: 'verified' | 'unverified' | 'conflicted' | 'unavailable'
  metadata?: Record<string, unknown>
}

export type LeadPipelineDecisionInput = {
  idempotencyKey: string
  eventId: string
  runId?: string | null
  parentDecisionId?: string | null
  decisionType: string
  outcome: LeadPipelineDecisionOutcome
  subjectType?: string | null
  subjectName?: string | null
  legalName?: string | null
  confidence?: number | null
  reason: string
  output?: Record<string, unknown>
  actorType: 'agent' | 'system' | 'user' | 'migration'
  actorId?: string | null
  evidence?: LeadPipelineEvidenceInput[]
}

type PromptRow = RowDataPacket & {
  id: string
  agent_profile: string
  prompt_version: string
  schema_version: string
  skill_version: string
  toolset_version: string
  prompt_hash: string
  configuration: Record<string, unknown> | string
}

type RunRow = RowDataPacket & {
  id: string
  run_key: string
  primary_event_id: string | null
  event_ids: string[] | string
  runtime: string
  agent_profile: string
  prompt_version_id: string | null
  model: string
  status: string
  attempt: number
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  tool_calls: number
  duration_ms: number | null
  cost_microusd: number | null
  error: string | null
  metadata: Record<string, unknown> | string
  started_at: Date
  finished_at: Date | null
}

type DecisionRow = RowDataPacket & {
  id: string
  decision_key: string
  event_id: string
  run_id: string | null
  parent_decision_id: string | null
  decision_type: string
  outcome: LeadPipelineDecisionOutcome
  subject_type: string | null
  subject_name: string | null
  legal_name: string | null
  confidence: number | null
  reason: string
  output: Record<string, unknown> | string
  actor_type: string
  actor_id: string | null
  created_at: Date
}

type ReviewRow = RowDataPacket & {
  id: string
  review_key: string
  event_id: string
  trigger_decision_id: string
  status: string
  reason: string
  assigned_user_id: string | null
  reviewer_user_id: string | null
  resolution_decision_id: string | null
  created_at: Date
  updated_at: Date
  resolved_at: Date | null
}

const rawTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_raw_events'))
const promptTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_prompt_versions'))
const runsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_runs'))
const decisionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_decisions'))
const evidenceTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_evidence'))
const reviewsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_reviews'))

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (Array.isArray(value)) return value.map((entry) => normalizeJson(entry ?? null))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeJson(entry)]))
  }
  return value
}

function canonicalJson(value: unknown) {
  return JSON.stringify(normalizeJson(value))
}

function parseObject(value: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof value !== 'string') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function parseStringArray(value: string[] | string): string[] {
  if (Array.isArray(value)) return value.map(String)
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\u0000/g, '').slice(0, maxLength)
}

function safeError(value: unknown) {
  return redactSensitiveText(value instanceof Error ? value.message : String(value ?? '')).slice(0, 8_000)
}

async function withTransaction<T>(
  supplied: PoolConnection | undefined,
  action: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  if (supplied) return await action(supplied)
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const result = await action(connection)
    await connection.commit()
    return result
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

function publicRun(row: RunRow) {
  return {
    id: row.id,
    runKey: row.run_key,
    primaryEventId: row.primary_event_id,
    eventIds: parseStringArray(row.event_ids),
    runtime: row.runtime,
    agentProfile: row.agent_profile,
    promptVersionId: row.prompt_version_id,
    model: row.model,
    status: row.status,
    attempt: Number(row.attempt),
    inputTokens: row.input_tokens == null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens == null ? null : Number(row.output_tokens),
    totalTokens: row.total_tokens == null ? null : Number(row.total_tokens),
    toolCalls: Number(row.tool_calls),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    costMicrousd: row.cost_microusd == null ? null : Number(row.cost_microusd),
    error: row.error,
    metadata: parseObject(row.metadata),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

function publicDecision(row: DecisionRow) {
  return {
    id: row.id,
    decisionKey: row.decision_key,
    eventId: row.event_id,
    runId: row.run_id,
    parentDecisionId: row.parent_decision_id,
    decisionType: row.decision_type,
    outcome: row.outcome,
    subjectType: row.subject_type,
    subjectName: row.subject_name,
    legalName: row.legal_name,
    confidence: row.confidence == null ? null : Number(row.confidence),
    reason: row.reason,
    output: parseObject(row.output),
    actorType: row.actor_type,
    actorId: row.actor_id,
    createdAt: row.created_at,
  }
}

export async function findLeadPipelineDecisionByIdempotencyKey(idempotencyKey: string) {
  const decisionKey = sha256(`lead-decision-v1:${idempotencyKey}`)
  const [rows] = await pool.query<DecisionRow[]>(
    `SELECT * FROM ${decisionsTable} WHERE decision_key=? LIMIT 1`,
    [decisionKey],
  )
  return rows[0] ? publicDecision(rows[0]) : null
}

export async function registerLeadPipelinePromptVersion(input: {
  agentProfile: string
  promptVersion: string
  schemaVersion: string
  skillVersion: string
  toolsetVersion: string
  prompt: string
  configuration?: Record<string, unknown>
}, suppliedConnection?: PoolConnection) {
  const contract = {
    agentProfile: clean(input.agentProfile, 64),
    promptVersion: clean(input.promptVersion, 64),
    schemaVersion: clean(input.schemaVersion, 64),
    skillVersion: clean(input.skillVersion, 64),
    toolsetVersion: clean(input.toolsetVersion, 64),
  }
  if (Object.values(contract).some((value) => !value)) throw new Error('lead pipeline prompt contract fields are required')
  const promptHash = sha256(String(input.prompt))
  const configuration = normalizeJson(input.configuration ?? {}) as Record<string, unknown>
  const id = sha256(canonicalJson({ version: 'lead-prompt-v1', ...contract, promptHash }))
  return await withTransaction(suppliedConnection, async (connection) => {
    await connection.query(
      `INSERT IGNORE INTO ${promptTable}
        (id, agent_profile, prompt_version, schema_version, skill_version, toolset_version,
         prompt_hash, configuration, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), NOW(3))`,
      [id, contract.agentProfile, contract.promptVersion, contract.schemaVersion,
        contract.skillVersion, contract.toolsetVersion, promptHash, canonicalJson(configuration)],
    )
    const [rows] = await connection.query<PromptRow[]>(
      `SELECT * FROM ${promptTable}
       WHERE agent_profile=? AND prompt_version=? AND schema_version=? AND skill_version=? AND toolset_version=?
       FOR UPDATE`,
      [contract.agentProfile, contract.promptVersion, contract.schemaVersion,
        contract.skillVersion, contract.toolsetVersion],
    )
    const row = rows[0]
    if (!row || row.id !== id || row.prompt_hash !== promptHash
      || canonicalJson(parseObject(row.configuration)) !== canonicalJson(configuration)) {
      throw new Error('lead pipeline prompt version is immutable; publish a new version instead')
    }
    return { id: row.id, ...contract, promptHash, configuration }
  })
}

export async function startLeadPipelineRun(input: {
  runKey?: string
  eventIds: string[]
  runtime: string
  agentProfile: string
  promptVersionId?: string | null
  model: string
  attempt?: number
  metadata?: Record<string, unknown>
  startedAt?: Date
}, suppliedConnection?: PoolConnection) {
  const eventIds = [...new Set(input.eventIds.map((value) => clean(value, 64)).filter(Boolean))]
  if (!eventIds.length) throw new Error('lead pipeline run requires at least one event')
  const runtime = clean(input.runtime, 32)
  const agentProfile = clean(input.agentProfile, 64)
  const model = clean(input.model, 128)
  if (!runtime || !agentProfile || !model) throw new Error('lead pipeline run runtime, profile and model are required')
  const runKey = sha256(`lead-run-v1:${input.runKey || randomUUID()}`)
  const metadata = normalizeJson(input.metadata ?? {}) as Record<string, unknown>
  return await withTransaction(suppliedConnection, async (connection) => {
    const [eventRows] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM ${rawTable} WHERE id IN (${eventIds.map(() => '?').join(',')})`, eventIds,
    )
    if (eventRows.length !== eventIds.length) throw new Error('lead pipeline run references a missing raw event')
    const id = randomUUID()
    await connection.query(
      `INSERT IGNORE INTO ${runsTable}
        (id, run_key, primary_event_id, event_ids, runtime, agent_profile, prompt_version_id,
         model, status, attempt, tool_calls, metadata, started_at, created_at)
       VALUES (?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, 'running', ?, 0, CAST(? AS JSON), ?, NOW(3))`,
      [id, runKey, eventIds[0], canonicalJson(eventIds), runtime, agentProfile,
        input.promptVersionId ?? null, model, Math.max(1, Math.round(input.attempt || 1)),
        canonicalJson(metadata), input.startedAt ?? new Date()],
    )
    const [rows] = await connection.query<RunRow[]>(`SELECT * FROM ${runsTable} WHERE run_key=? FOR UPDATE`, [runKey])
    const row = rows[0]
    if (!row || canonicalJson(parseStringArray(row.event_ids)) !== canonicalJson(eventIds)
      || row.runtime !== runtime || row.agent_profile !== agentProfile || row.model !== model
      || row.prompt_version_id !== (input.promptVersionId ?? null)
      || canonicalJson(parseObject(row.metadata)) !== canonicalJson(metadata)) {
      throw new Error('lead pipeline run idempotency collision')
    }
    return publicRun(row)
  })
}

export async function finishLeadPipelineRun(runId: string, input: {
  status: 'succeeded' | 'failed' | 'cancelled'
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  toolCalls?: number
  durationMs?: number | null
  costMicrousd?: number | null
  error?: unknown
  finishedAt?: Date
}, suppliedConnection?: PoolConnection) {
  return await withTransaction(suppliedConnection, async (connection) => {
    const [rows] = await connection.query<RunRow[]>(`SELECT * FROM ${runsTable} WHERE id=? FOR UPDATE`, [runId])
    const current = rows[0]
    if (!current) throw new Error(`lead pipeline run not found: ${runId}`)
    if (current.status !== 'running') {
      if (current.status !== input.status) throw new Error('lead pipeline run terminal status is immutable')
      const expected = [
        ['inputTokens', input.inputTokens, current.input_tokens],
        ['outputTokens', input.outputTokens, current.output_tokens],
        ['totalTokens', input.totalTokens, current.total_tokens],
        ['toolCalls', input.toolCalls, current.tool_calls],
        ['durationMs', input.durationMs, current.duration_ms],
        ['costMicrousd', input.costMicrousd, current.cost_microusd],
      ] as const
      if (expected.some(([, supplied, stored]) => supplied != null && Math.round(supplied) !== Number(stored))) {
        throw new Error('lead pipeline run terminal metrics are immutable')
      }
      return publicRun(current)
    }
    const integer = (value: number | null | undefined) => value == null || !Number.isFinite(value)
      ? null : Math.max(0, Math.round(value))
    const error = input.status === 'failed' ? safeError(input.error || 'lead pipeline run failed') : null
    await connection.query(
      `UPDATE ${runsTable} SET status=?, input_tokens=?, output_tokens=?, total_tokens=?,
         tool_calls=?, duration_ms=?, cost_microusd=?, error=?, finished_at=? WHERE id=?`,
      [input.status, integer(input.inputTokens), integer(input.outputTokens), integer(input.totalTokens),
        integer(input.toolCalls) ?? 0, integer(input.durationMs), integer(input.costMicrousd), error,
        input.finishedAt ?? new Date(), runId],
    )
    const [updated] = await connection.query<RunRow[]>(`SELECT * FROM ${runsTable} WHERE id=?`, [runId])
    return publicRun(updated[0])
  })
}

export async function recordLeadPipelineDecision(
  input: LeadPipelineDecisionInput,
  suppliedConnection?: PoolConnection,
) {
  const decisionType = clean(input.decisionType, 32)
  const reason = clean(input.reason, 8_000)
  const subjectName = clean(input.subjectName, 128) || null
  const subjectType = clean(input.subjectType, 16) || null
  const legalName = clean(input.legalName, 128) || null
  if (!decisionType || !reason) throw new Error('lead pipeline decision type and reason are required')
  if (input.outcome === 'accept' && (!subjectName || !(input.evidence?.length))) {
    throw new Error('accepted lead pipeline decision requires a subject and evidence')
  }
  const confidence = input.confidence == null || !Number.isFinite(input.confidence)
    ? null : Math.max(0, Math.min(100, Math.round(input.confidence)))
  const output = normalizeJson(input.output ?? {}) as Record<string, unknown>
  const decisionKey = sha256(`lead-decision-v1:${input.idempotencyKey}`)
  const evidence = input.evidence ?? []
  return await withTransaction(suppliedConnection, async (connection) => {
    const id = randomUUID()
    await connection.query(
      `INSERT IGNORE INTO ${decisionsTable}
        (id, decision_key, event_id, run_id, parent_decision_id, decision_type, outcome,
         subject_type, subject_name, legal_name, confidence, reason, output, actor_type, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, NOW(3))`,
      [id, decisionKey, input.eventId, input.runId ?? null, input.parentDecisionId ?? null,
        decisionType, input.outcome, subjectType, subjectName, legalName, confidence, reason,
        canonicalJson(output), input.actorType, clean(input.actorId, 64) || null],
    )
    const [rows] = await connection.query<DecisionRow[]>(
      `SELECT * FROM ${decisionsTable} WHERE decision_key=? FOR UPDATE`, [decisionKey],
    )
    const row = rows[0]
    if (!row || row.event_id !== input.eventId || row.run_id !== (input.runId ?? null)
      || row.parent_decision_id !== (input.parentDecisionId ?? null) || row.decision_type !== decisionType
      || row.outcome !== input.outcome || row.subject_type !== subjectType || row.subject_name !== subjectName
      || row.legal_name !== legalName || row.confidence !== confidence || row.reason !== reason
      || canonicalJson(parseObject(row.output)) !== canonicalJson(output)) {
      throw new Error('lead pipeline decision idempotency collision or immutable output mismatch')
    }
    for (let index = 0; index < evidence.length; index += 1) {
      const item = evidence[index]
      const claim = clean(item.claim, 8_000)
      const sourceType = clean(item.sourceType, 32)
      if (!claim || !sourceType) throw new Error('lead pipeline evidence claim and source type are required')
      const normalized = {
        sourceId: clean(item.sourceId, 2_000) || null,
        sourceType,
        locator: clean(item.locator, 2_000) || null,
        claim,
        quote: clean(item.quote, 8_000) || null,
        sourceUrl: clean(item.sourceUrl, 4_000) || null,
        reliability: clean(item.reliability, 16) || null,
        verificationStatus: item.verificationStatus ?? 'unverified',
        metadata: normalizeJson(item.metadata ?? {}) as Record<string, unknown>,
      }
      const evidenceKey = sha256(canonicalJson({ decisionKey, index, ...normalized }))
      await connection.query(
        `INSERT IGNORE INTO ${evidenceTable}
          (id, evidence_key, decision_id, event_id, source_id, source_type, locator, claim,
           quote, source_url, reliability, verification_status, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), NOW(3))`,
        [randomUUID(), evidenceKey, row.id, input.eventId, normalized.sourceId, normalized.sourceType,
          normalized.locator, normalized.claim, normalized.quote, normalized.sourceUrl,
          normalized.reliability, normalized.verificationStatus, canonicalJson(normalized.metadata)],
      )
    }
    return publicDecision(row)
  })
}

export async function openLeadPipelineReview(input: {
  idempotencyKey: string
  eventId: string
  triggerDecisionId: string
  reason: string
  assignedUserId?: string | null
}, suppliedConnection?: PoolConnection) {
  const reviewKey = sha256(`lead-review-v1:${input.idempotencyKey}`)
  const reason = clean(input.reason, 8_000)
  if (!reason) throw new Error('lead pipeline review reason is required')
  return await withTransaction(suppliedConnection, async (connection) => {
    await connection.query(
      `INSERT IGNORE INTO ${reviewsTable}
        (id, review_key, event_id, trigger_decision_id, status, reason, assigned_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, NOW(3), NOW(3))`,
      [randomUUID(), reviewKey, input.eventId, input.triggerDecisionId, reason, input.assignedUserId ?? null],
    )
    const [rows] = await connection.query<ReviewRow[]>(`SELECT * FROM ${reviewsTable} WHERE review_key=? FOR UPDATE`, [reviewKey])
    const row = rows[0]
    if (!row || row.event_id !== input.eventId) {
      throw new Error('lead pipeline review idempotency collision')
    }
    // A failed/retried pipeline pass may produce a new immutable screening
    // decision for the same event after the pending review was already opened.
    // Reuse that pending work item instead of rewriting its audit origin or
    // treating the legitimate retry as an idempotency collision.
    const retryMatchesPendingReview = row.status === 'pending'
      && (row.trigger_decision_id !== input.triggerDecisionId
        || row.reason !== reason
        || row.assigned_user_id !== (input.assignedUserId ?? null))
    if (!retryMatchesPendingReview
      && (row.trigger_decision_id !== input.triggerDecisionId
        || row.reason !== reason
        || row.assigned_user_id !== (input.assignedUserId ?? null))) {
      throw new Error('lead pipeline review idempotency collision')
    }
    return row
  })
}

export async function resolveLeadPipelineReview(input: {
  reviewId: string
  reviewerUserId: string
  idempotencyKey: string
  outcome: Exclude<LeadPipelineDecisionOutcome, 'failed'>
  subjectType?: string | null
  subjectName?: string | null
  legalName?: string | null
  confidence?: number | null
  reason: string
  output?: Record<string, unknown>
  evidence?: LeadPipelineEvidenceInput[]
}, suppliedConnection?: PoolConnection) {
  return await withTransaction(suppliedConnection, async (connection) => {
    const [rows] = await connection.query<ReviewRow[]>(`SELECT * FROM ${reviewsTable} WHERE id=? FOR UPDATE`, [input.reviewId])
    const review = rows[0]
    if (!review) throw new Error(`lead pipeline review not found: ${input.reviewId}`)
    if (review.status === 'resolved') {
      if (review.reviewer_user_id !== input.reviewerUserId) {
        throw new Error('lead pipeline review resolution is immutable')
      }
      const decision = await recordLeadPipelineDecision({
        idempotencyKey: input.idempotencyKey,
        eventId: review.event_id,
        parentDecisionId: review.trigger_decision_id,
        decisionType: 'manual_review',
        outcome: input.outcome,
        subjectType: input.subjectType,
        subjectName: input.subjectName,
        legalName: input.legalName,
        confidence: input.confidence,
        reason: input.reason,
        output: input.output,
        actorType: 'user',
        actorId: input.reviewerUserId,
        evidence: input.evidence,
      }, connection)
      if (decision.id !== review.resolution_decision_id) {
        throw new Error('lead pipeline review resolution is immutable')
      }
      return { review, decision }
    }
    if (review.status !== 'pending') throw new Error(`lead pipeline review cannot be resolved from ${review.status}`)
    const decision = await recordLeadPipelineDecision({
      idempotencyKey: input.idempotencyKey,
      eventId: review.event_id,
      parentDecisionId: review.trigger_decision_id,
      decisionType: 'manual_review',
      outcome: input.outcome,
      subjectType: input.subjectType,
      subjectName: input.subjectName,
      legalName: input.legalName,
      confidence: input.confidence,
      reason: input.reason,
      output: input.output,
      actorType: 'user',
      actorId: input.reviewerUserId,
      evidence: input.evidence,
    }, connection)
    await connection.query(
      `UPDATE ${reviewsTable} SET status='resolved', reviewer_user_id=?, resolution_decision_id=?,
         resolved_at=NOW(3), updated_at=NOW(3) WHERE id=?`,
      [input.reviewerUserId, decision.id, review.id],
    )
    const [updated] = await connection.query<ReviewRow[]>(`SELECT * FROM ${reviewsTable} WHERE id=?`, [review.id])
    return { review: updated[0], decision }
  })
}
