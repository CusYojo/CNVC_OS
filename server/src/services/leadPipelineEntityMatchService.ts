import { createHash, randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import type { PoolConnection } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

export type LeadEntityMatchStatus = 'candidate' | 'ambiguous' | 'selected' | 'created' | 'rejected'
export type LeadEntityResolutionType = 'pending' | 'automatic' | 'manual' | 'created' | 'rejected'

export type LeadPipelineEntityMatchInput = {
  idempotencyKey: string
  eventId: string
  decisionId?: string | null
  reviewId?: string | null
  subjectType?: string | null
  subjectName: string
  matchType: string
  candidateLeadId?: string | null
  candidateName?: string | null
  candidateCompanyName?: string | null
  score?: number | null
  status: LeadEntityMatchStatus
  resolutionType?: LeadEntityResolutionType
  resolutionDecisionId?: string | null
  aliases?: string[]
  metadata?: Record<string, unknown>
}

type EntityMatchRow = RowDataPacket & {
  id: string
  match_key: string
  event_id: string
  decision_id: string | null
  review_id: string | null
  subject_type: string | null
  subject_name: string
  normalized_subject_name: string
  match_type: string
  candidate_lead_id: string | null
  candidate_name: string | null
  candidate_company_name: string | null
  score: number | null
  status: LeadEntityMatchStatus
  resolution_type: LeadEntityResolutionType
  resolution_decision_id: string | null
  aliases: string[] | string
  metadata: Record<string, unknown> | string
  created_at: Date
  resolved_at: Date | null
}

const matchesTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_entity_matches'))
const MATCH_STATUSES = new Set<LeadEntityMatchStatus>(['candidate', 'ambiguous', 'selected', 'created', 'rejected'])
const RESOLUTION_TYPES = new Set<LeadEntityResolutionType>(['pending', 'automatic', 'manual', 'created', 'rejected'])

function clean(value: unknown, maxLength: number) {
  return String(value ?? '').normalize('NFKC').replace(/\u0000/g, '').trim().slice(0, maxLength)
}

export function normalizeLeadEntitySubject(value: unknown) {
  return clean(value, 128).replace(/\s+/g, ' ').toLocaleLowerCase()
}

function normalizeJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item ?? null))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeJson(item)]))
  }
  return value
}

function canonicalJson(value: unknown) {
  return JSON.stringify(normalizeJson(value))
}

function parseJson<T>(value: T | string, fallback: T): T {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) as T } catch { return fallback }
}

async function withTransaction<T>(supplied: PoolConnection | undefined, task: (connection: PoolConnection) => Promise<T>) {
  if (supplied) return await task(supplied)
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const result = await task(connection)
    await connection.commit()
    return result
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

function publicMatch(row: EntityMatchRow) {
  return {
    id: row.id,
    eventId: row.event_id,
    decisionId: row.decision_id,
    reviewId: row.review_id,
    subjectType: row.subject_type,
    subjectName: row.subject_name,
    normalizedSubjectName: row.normalized_subject_name,
    matchType: row.match_type,
    candidateLeadId: row.candidate_lead_id,
    candidateName: row.candidate_name,
    candidateCompanyName: row.candidate_company_name,
    score: row.score == null ? null : Number(row.score),
    status: row.status,
    resolutionType: row.resolution_type,
    resolutionDecisionId: row.resolution_decision_id,
    aliases: parseJson(row.aliases, [] as string[]),
    metadata: parseJson(row.metadata, {} as Record<string, unknown>),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

export async function recordLeadPipelineEntityMatch(
  input: LeadPipelineEntityMatchInput,
  suppliedConnection?: PoolConnection,
) {
  const eventId = clean(input.eventId, 64)
  const subjectName = clean(input.subjectName, 128)
  const idempotencyKey = clean(input.idempotencyKey, 256)
  const status = input.status
  const resolutionType = input.resolutionType ?? 'pending'
  if (!eventId || !subjectName || idempotencyKey.length < 8) throw new Error('entity match event, subject and idempotency key are required')
  if (!MATCH_STATUSES.has(status) || !RESOLUTION_TYPES.has(resolutionType)) throw new Error('invalid entity match status or resolution type')
  const normalizedSubjectName = normalizeLeadEntitySubject(subjectName)
  const score = input.score == null ? null : Math.max(0, Math.min(10_000, Math.round(Number(input.score))))
  const record = {
    eventId,
    decisionId: clean(input.decisionId, 36) || null,
    reviewId: clean(input.reviewId, 36) || null,
    subjectType: clean(input.subjectType, 16) || null,
    subjectName,
    normalizedSubjectName,
    matchType: clean(input.matchType, 32),
    candidateLeadId: clean(input.candidateLeadId, 36) || null,
    candidateName: clean(input.candidateName, 128) || null,
    candidateCompanyName: clean(input.candidateCompanyName, 128) || null,
    score,
    status,
    resolutionType,
    resolutionDecisionId: clean(input.resolutionDecisionId, 36) || null,
    aliases: [...new Set((input.aliases ?? []).map((alias) => clean(alias, 128)).filter(Boolean))].sort(),
    metadata: normalizeJson(input.metadata ?? {}) as Record<string, unknown>,
  }
  if (!record.matchType) throw new Error('entity match type is required')
  const matchKey = createHash('sha256').update(`lead-entity-match-v1:${idempotencyKey}`).digest('hex')
  return await withTransaction(suppliedConnection, async (connection) => {
    await connection.query(
      `INSERT INTO ${matchesTable}
        (id, match_key, event_id, decision_id, review_id, subject_type, subject_name,
         normalized_subject_name, match_type, candidate_lead_id, candidate_name,
         candidate_company_name, score, status, resolution_type, resolution_decision_id,
         aliases, metadata, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), NOW(3), ?)
       ON DUPLICATE KEY UPDATE match_key=VALUES(match_key)`,
      [randomUUID(), matchKey, record.eventId, record.decisionId, record.reviewId, record.subjectType,
        record.subjectName, record.normalizedSubjectName, record.matchType, record.candidateLeadId,
        record.candidateName, record.candidateCompanyName, record.score, record.status,
        record.resolutionType, record.resolutionDecisionId, canonicalJson(record.aliases),
        canonicalJson(record.metadata), record.resolutionType === 'pending' ? null : new Date()],
    )
    const [rows] = await connection.query<EntityMatchRow[]>(
      `SELECT * FROM ${matchesTable} WHERE match_key=? LIMIT 1`,
      [matchKey],
    )
    const row = rows[0]
    if (!row) throw new Error('entity match insert did not return a row')
    const storedIdentity = canonicalJson({
      eventId: row.event_id,
      subjectName: row.subject_name,
      matchType: row.match_type,
      candidateLeadId: row.candidate_lead_id,
      status: row.status,
      resolutionType: row.resolution_type,
    })
    const requestedIdentity = canonicalJson({
      eventId: record.eventId,
      subjectName: record.subjectName,
      matchType: record.matchType,
      candidateLeadId: record.candidateLeadId,
      status: record.status,
      resolutionType: record.resolutionType,
    })
    if (storedIdentity !== requestedIdentity) throw new Error('entity match idempotency key collision')
    return publicMatch(row)
  })
}

export async function listLeadPipelineEntityMatches(eventIds: string[], suppliedConnection?: PoolConnection) {
  const ids = [...new Set(eventIds.map((eventId) => clean(eventId, 64)).filter(Boolean))]
  if (!ids.length) return []
  const query = async (connection: PoolConnection) => {
    const [rows] = await connection.query<EntityMatchRow[]>(
      `SELECT * FROM ${matchesTable} WHERE event_id IN (${ids.map(() => '?').join(',')})
       ORDER BY created_at ASC, id ASC`,
      ids,
    )
    return rows.map(publicMatch)
  }
  if (suppliedConnection) return await query(suppliedConnection)
  const connection = await pool.getConnection()
  try { return await query(connection) } finally { connection.release() }
}
