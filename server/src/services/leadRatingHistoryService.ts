import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { LEAD_RATING_V3_SCHEMA_VERSION } from './leadRatingV3Service.js'

const historyTable = quoteMysqlIdentifier(mysqlTableName('lead_rating_history'))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const auditLogsTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))

function jsonValue(value: unknown) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function object(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
}

function ratingScore(result: Record<string, unknown>) {
  const ratingV3 = object(result.ratingV3)
  const computed = object(ratingV3.computed)
  for (const candidate of [computed.score, result.total]) {
    const value = typeof candidate === 'string' || typeof candidate === 'number' ? Number(candidate) : Number.NaN
    if (Number.isFinite(value) && value >= 0 && value <= 100) return value
  }
  throw Object.assign(new Error('历史评级没有可恢复的0-100分值'), { code: 'RATING_HISTORY_INVALID_RESULT' })
}

export async function listLeadRatingHistory(input: {
  leadId: string
  page?: number
  pageSize?: number
}) {
  const page = Math.max(1, Math.floor(input.page || 1))
  const pageSize = Math.max(1, Math.min(50, Math.floor(input.pageSize || 10)))
  const offset = (page - 1) * pageSize
  const [countRows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) count FROM ${historyTable} WHERE lead_id=?`, [input.leadId],
  )
  const [rows] = await pool.query<Array<RowDataPacket & {
    id: string; snapshot_id: string; snapshot_hash: string; rating_schema_version: string;
    workflow: string; prompt_version: string; model: string; status: string; result: unknown;
    completed_at: Date; created_at: Date;
  }>>(
    `SELECT id,snapshot_id,snapshot_hash,rating_schema_version,workflow,prompt_version,model,status,result,
            completed_at,created_at
     FROM ${historyTable} WHERE lead_id=? ORDER BY completed_at DESC,id DESC LIMIT ? OFFSET ?`,
    [input.leadId, pageSize, offset],
  )
  const total = Number(countRows[0]?.count || 0)
  return {
    leadId: input.leadId, page, pageSize, total, hasMore: offset + rows.length < total,
    ratings: rows.map((row) => ({
      id: row.id, snapshotId: row.snapshot_id, snapshotHash: row.snapshot_hash,
      ratingSchemaVersion: row.rating_schema_version, workflow: row.workflow,
      promptVersion: row.prompt_version, model: row.model, status: row.status,
      result: jsonValue(row.result), completedAt: row.completed_at, createdAt: row.created_at,
    })),
  }
}

export async function restoreLeadRatingHistory(input: {
  leadId: string
  historyId: string
  reason: string
  actor: { userId: string; userName: string }
}) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [leadRows] = await connection.query<Array<RowDataPacket & { id: string; scoring: unknown }>>(
      `SELECT id,scoring FROM ${leadsTable} WHERE id=? FOR UPDATE`, [input.leadId],
    )
    if (!leadRows[0]) throw Object.assign(new Error('线索不存在'), { code: 'LEAD_NOT_FOUND' })
    const [historyRows] = await connection.query<Array<RowDataPacket & {
      id: string; snapshot_id: string; snapshot_hash: string; rating_schema_version: string;
      status: string; result: unknown; completed_at: Date;
    }>>(
      `SELECT id,snapshot_id,snapshot_hash,rating_schema_version,status,result,completed_at
       FROM ${historyTable} WHERE id=? AND lead_id=? FOR UPDATE`,
      [input.historyId, input.leadId],
    )
    const history = historyRows[0]
    if (!history) throw Object.assign(new Error('历史评级不存在或不属于该线索'), { code: 'RATING_HISTORY_NOT_FOUND' })
    if (history.rating_schema_version !== LEAD_RATING_V3_SCHEMA_VERSION || history.status !== 'ready') {
      throw Object.assign(new Error('仅允许恢复已完成的V3历史评级'), { code: 'RATING_HISTORY_NOT_RESTORABLE' })
    }
    const historicalResult = object(history.result)
    const currentScoring = object(leadRows[0].scoring)
    const score = ratingScore(historicalResult)
    const restoredAt = new Date().toISOString()
    const restoredScoring: Record<string, unknown> = {
      ...historicalResult,
      ...(currentScoring.registry ? { registry: currentScoring.registry } : {}),
      ratingV3: {
        ...object(historicalResult.ratingV3),
        status: 'ready',
        snapshotId: history.snapshot_id,
        snapshotHash: history.snapshot_hash,
        restoredFromHistoryId: history.id,
        restoredAt,
        restoredBy: input.actor.userName,
        restoreReason: input.reason,
      },
    }
    delete restoredScoring.dataQualityV1
    await connection.query(
      `UPDATE ${leadsTable} SET scoring=CAST(? AS JSON),score=? WHERE id=?`,
      [JSON.stringify(restoredScoring), score, input.leadId],
    )
    await connection.query(
      `INSERT INTO ${auditLogsTable}
        (id,user_id,user_name,module,action,target,result,request_id,created_at)
       VALUES (?,?,?,'共享线索','恢复历史V3评分',?,'success',?,NOW(3))`,
      [randomUUID(), input.actor.userId, input.actor.userName,
        JSON.stringify({ leadId: input.leadId, historyId: history.id, snapshotId: history.snapshot_id, reason: input.reason }),
        randomUUID()],
    )
    await connection.commit()
    return {
      restored: true, leadId: input.leadId, historyId: history.id,
      snapshotId: history.snapshot_id, snapshotHash: history.snapshot_hash,
      ratingSchemaVersion: history.rating_schema_version, score, restoredAt,
    }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally { connection.release() }
}
