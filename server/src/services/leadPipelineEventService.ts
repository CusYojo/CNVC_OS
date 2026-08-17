import { createHash, randomUUID } from 'node:crypto'
import type { PoolConnection } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { redactSensitiveText } from '../security/redactSecrets.js'

export type LeadPipelineStatus = 'discovered' | 'ready' | 'review' | 'rejected' | 'failed'

export type LeadPipelineRawEventInput = {
  sourceType: string
  sourceId?: string | null
  payload: Record<string, unknown>
  sourceOccurredAt?: Date | string | null
}

export type LeadPipelineTransitionInput = {
  status: LeadPipelineStatus
  reason: string
  evidence?: unknown[]
  confidence?: number | null
  leadId?: string | null
  error?: string | null
  actorType: 'source' | 'agent' | 'system' | 'user' | 'migration'
  actorId?: string | null
}

type RawEventRow = RowDataPacket & {
  id: string
  source_type: string
  source_id: string | null
  source_id_hash: string | null
  content_hash: string
  idempotency_key: string
  payload: Record<string, unknown> | string
  source_occurred_at: Date | null
  ingested_at: Date
}

type PipelineItemRow = RowDataPacket & {
  event_id: string
  status: LeadPipelineStatus
  lead_id: string | null
  processing_attempts: number
  decision_reason: string | null
  evidence: unknown[] | string
  confidence: number | null
  last_error: string | null
  created_at: Date
  updated_at: Date
}

const rawTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_raw_events'))
const itemsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_items'))
const transitionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_transitions'))

const ALLOWED_TRANSITIONS: Record<LeadPipelineStatus, ReadonlySet<LeadPipelineStatus>> = {
  discovered: new Set(['ready', 'review', 'rejected', 'failed']),
  review: new Set(['ready', 'rejected', 'failed']),
  failed: new Set(['discovered', 'review', 'ready', 'rejected']),
  rejected: new Set(['review', 'ready']),
  ready: new Set(['review', 'failed']),
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedJsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (Array.isArray(value)) return value.map((entry) => normalizedJsonValue(entry ?? null))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizedJsonValue(entry)]))
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizedJsonValue(value))
}

function normalizedSourceType(value: string): string {
  const normalized = value.normalize('NFKC').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  if (!normalized || normalized.length > 32) throw new Error('lead pipeline sourceType must be 1-32 safe characters')
  return normalized
}

function normalizedSourceId(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ')
  return normalized || null
}

function parsedPayload(value: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof value !== 'string') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function parsedEvidence(value: unknown[] | string): unknown[] {
  if (Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function sourceDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function leadPipelineRawEventIdentity(input: LeadPipelineRawEventInput) {
  const sourceType = normalizedSourceType(input.sourceType)
  const sourceId = normalizedSourceId(input.sourceId)
  const payload = normalizedJsonValue(input.payload) as Record<string, unknown>
  const payloadJson = canonicalJson(payload)
  const contentHash = sha256(payloadJson)
  const sourceIdHash = sourceId ? sha256(sourceId.toLocaleLowerCase()) : null
  const idempotencyKey = sha256([
    'lead-pipeline-v1', sourceType, sourceIdHash ?? 'content-only', contentHash,
  ].join(':'))
  return { id: idempotencyKey, sourceType, sourceId, sourceIdHash, contentHash, idempotencyKey, payload, payloadJson }
}

function publicRaw(row: RawEventRow) {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceIdHash: row.source_id_hash,
    contentHash: row.content_hash,
    idempotencyKey: row.idempotency_key,
    payload: parsedPayload(row.payload),
    sourceOccurredAt: row.source_occurred_at,
    ingestedAt: row.ingested_at,
  }
}

function publicItem(row: PipelineItemRow) {
  return {
    eventId: row.event_id,
    status: row.status,
    leadId: row.lead_id,
    processingAttempts: Number(row.processing_attempts || 0),
    decisionReason: row.decision_reason,
    evidence: parsedEvidence(row.evidence),
    confidence: row.confidence == null ? null : Number(row.confidence),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
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

export async function recordLeadPipelineRawEvent(
  input: LeadPipelineRawEventInput,
  suppliedConnection?: PoolConnection,
) {
  const identity = leadPipelineRawEventIdentity(input)
  return await withTransaction(suppliedConnection, async (connection) => {
    await connection.query(
      `INSERT INTO ${rawTable}
        (id, source_type, source_id, source_id_hash, content_hash, idempotency_key,
         payload, source_occurred_at, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, NOW(3))
       ON DUPLICATE KEY UPDATE id=id`,
      [identity.id, identity.sourceType, identity.sourceId, identity.sourceIdHash,
        identity.contentHash, identity.idempotencyKey, identity.payloadJson,
        sourceDate(input.sourceOccurredAt)],
    )
    const [rawRows] = await connection.query<RawEventRow[]>(
      `SELECT * FROM ${rawTable} WHERE idempotency_key=? FOR UPDATE`,
      [identity.idempotencyKey],
    )
    const raw = rawRows[0]
    if (!raw
      || raw.id !== identity.id
      || raw.source_type !== identity.sourceType
      || raw.source_id_hash !== identity.sourceIdHash
      || raw.content_hash !== identity.contentHash
      || canonicalJson(parsedPayload(raw.payload)) !== identity.payloadJson) {
      throw new Error('lead pipeline raw event idempotency collision or immutable payload mismatch')
    }

    const [itemRows] = await connection.query<PipelineItemRow[]>(
      `SELECT * FROM ${itemsTable} WHERE event_id=? FOR UPDATE`,
      [identity.id],
    )
    let created = false
    if (!itemRows[0]) {
      await connection.query(
        `INSERT INTO ${itemsTable}
          (event_id, status, processing_attempts, evidence, created_at, updated_at)
         VALUES (?, 'discovered', 0, JSON_ARRAY(), NOW(3), NOW(3))`,
        [identity.id],
      )
      await connection.query(
        `INSERT INTO ${transitionsTable}
          (id, event_id, from_status, to_status, reason, evidence, confidence, actor_type, actor_id, created_at)
         VALUES (?, ?, NULL, 'discovered', 'raw event captured', JSON_ARRAY(), NULL, 'source', ?, NOW(3))`,
        [randomUUID(), identity.id, identity.sourceType],
      )
      created = true
    }
    const [currentRows] = await connection.query<PipelineItemRow[]>(
      `SELECT * FROM ${itemsTable} WHERE event_id=?`,
      [identity.id],
    )
    return { created, event: publicRaw(raw), item: publicItem(currentRows[0]) }
  })
}

// Migration/backfill path: preserve the exact single-event contract while reducing a batch
// from several round trips per row to a bounded set of set-based statements.
export async function recordLeadPipelineRawEventsBatch(
  inputs: LeadPipelineRawEventInput[],
  suppliedConnection?: PoolConnection,
) {
  if (!inputs.length) return []
  const ordered = inputs.map((input) => ({ input, identity: leadPipelineRawEventIdentity(input) }))
  const unique = [...new Map(ordered.map((entry) => [entry.identity.id, entry])).values()]
  return await withTransaction(suppliedConnection, async (connection) => {
    const rawPlaceholders = unique.map(() => '(?,?,?,?,?,?,CAST(? AS JSON),?,NOW(3))').join(',')
    await connection.query(
      `INSERT INTO ${rawTable}
        (id, source_type, source_id, source_id_hash, content_hash, idempotency_key,
         payload, source_occurred_at, ingested_at)
       VALUES ${rawPlaceholders}
       ON DUPLICATE KEY UPDATE id=id`,
      unique.flatMap(({ input, identity }) => [
        identity.id, identity.sourceType, identity.sourceId, identity.sourceIdHash,
        identity.contentHash, identity.idempotencyKey, identity.payloadJson,
        sourceDate(input.sourceOccurredAt),
      ]),
    )
    const ids = unique.map(({ identity }) => identity.id)
    const placeholders = ids.map(() => '?').join(',')
    const [rawRows] = await connection.query<RawEventRow[]>(
      `SELECT * FROM ${rawTable} WHERE id IN (${placeholders}) FOR UPDATE`,
      ids,
    )
    const rawById = new Map(rawRows.map((row) => [row.id, row]))
    for (const { identity } of unique) {
      const raw = rawById.get(identity.id)
      if (!raw
        || raw.source_type !== identity.sourceType
        || raw.source_id_hash !== identity.sourceIdHash
        || raw.content_hash !== identity.contentHash
        || canonicalJson(parsedPayload(raw.payload)) !== identity.payloadJson) {
        throw new Error('lead pipeline batch contains an idempotency collision or immutable payload mismatch')
      }
    }
    const [existingItems] = await connection.query<PipelineItemRow[]>(
      `SELECT * FROM ${itemsTable} WHERE event_id IN (${placeholders}) FOR UPDATE`,
      ids,
    )
    const existingIds = new Set(existingItems.map((row) => row.event_id))
    const createdIds = ids.filter((id) => !existingIds.has(id))
    if (createdIds.length) {
      await connection.query(
        `INSERT INTO ${itemsTable}
          (event_id, status, processing_attempts, evidence, created_at, updated_at)
         VALUES ${createdIds.map(() => "(?,'discovered',0,JSON_ARRAY(),NOW(3),NOW(3))").join(',')}`,
        createdIds,
      )
      const sourceTypeById = new Map(unique.map(({ identity }) => [identity.id, identity.sourceType]))
      await connection.query(
        `INSERT INTO ${transitionsTable}
          (id, event_id, from_status, to_status, reason, evidence, confidence, actor_type, actor_id, created_at)
         VALUES ${createdIds.map(() => "(?,?,NULL,'discovered','raw event captured',JSON_ARRAY(),NULL,'source',?,NOW(3))").join(',')}`,
        createdIds.flatMap((id) => [randomUUID(), id, sourceTypeById.get(id)]),
      )
    }
    const [itemRows] = await connection.query<PipelineItemRow[]>(
      `SELECT * FROM ${itemsTable} WHERE event_id IN (${placeholders})`,
      ids,
    )
    const itemById = new Map(itemRows.map((row) => [row.event_id, row]))
    return ordered.map(({ identity }) => ({
      created: createdIds.includes(identity.id),
      event: publicRaw(rawById.get(identity.id)!),
      item: publicItem(itemById.get(identity.id)!),
    }))
  })
}

export async function transitionLeadPipelineItem(
  eventId: string,
  input: LeadPipelineTransitionInput,
  suppliedConnection?: PoolConnection,
) {
  return await withTransaction(suppliedConnection, async (connection) => {
    const [rows] = await connection.query<PipelineItemRow[]>(
      `SELECT * FROM ${itemsTable} WHERE event_id=? FOR UPDATE`,
      [eventId],
    )
    const current = rows[0]
    if (!current) throw new Error(`lead pipeline item not found: ${eventId}`)
    const reason = input.reason.trim()
    if (!reason) throw new Error('lead pipeline transition reason is required')
    if (current.status === input.status) {
      return { changed: false, blocked: false, item: publicItem(current) }
    }
    // A formal lead must never be silently withdrawn by a later automatic run.
    if (current.status === 'ready' && input.status !== 'review') {
      return { changed: false, blocked: true, item: publicItem(current) }
    }
    if (!ALLOWED_TRANSITIONS[current.status].has(input.status)) {
      throw new Error(`invalid lead pipeline transition: ${current.status} -> ${input.status}`)
    }
    const evidence = normalizedJsonValue(input.evidence ?? []) as unknown[]
    const confidence = input.confidence == null
      ? null
      : Math.max(0, Math.min(100, Math.round(input.confidence)))
    const error = input.status === 'failed'
      ? redactSensitiveText(input.error || reason).slice(0, 8_000)
      : null
    const leadId = input.status === 'ready' ? input.leadId ?? current.lead_id : current.lead_id
    if (input.status === 'ready' && !leadId) throw new Error('ready lead pipeline transition requires leadId')
    await connection.query(
      `UPDATE ${itemsTable}
       SET status=?, lead_id=?, processing_attempts=processing_attempts+1,
         decision_reason=?, evidence=CAST(? AS JSON), confidence=?, last_error=?, updated_at=NOW(3)
       WHERE event_id=?`,
      [input.status, leadId, reason, canonicalJson(evidence), confidence, error, eventId],
    )
    await connection.query(
      `INSERT INTO ${transitionsTable}
        (id, event_id, from_status, to_status, reason, evidence, confidence, actor_type, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, NOW(3))`,
      [randomUUID(), eventId, current.status, input.status, reason, canonicalJson(evidence),
        confidence, input.actorType, input.actorId ?? null],
    )
    const [updatedRows] = await connection.query<PipelineItemRow[]>(
      `SELECT * FROM ${itemsTable} WHERE event_id=?`,
      [eventId],
    )
    return { changed: true, blocked: false, item: publicItem(updatedRows[0]) }
  })
}

export async function verifyLeadPipelineRawEvent(eventId: string) {
  const [rows] = await pool.query<RawEventRow[]>(`SELECT * FROM ${rawTable} WHERE id=?`, [eventId])
  const row = rows[0]
  if (!row) return { exists: false, valid: false }
  const identity = leadPipelineRawEventIdentity({
    sourceType: row.source_type,
    sourceId: row.source_id,
    payload: parsedPayload(row.payload),
    sourceOccurredAt: row.source_occurred_at,
  })
  return {
    exists: true,
    valid: identity.id === row.id
      && identity.idempotencyKey === row.idempotency_key
      && identity.contentHash === row.content_hash
      && identity.sourceIdHash === row.source_id_hash,
    event: publicRaw(row),
  }
}
