import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { isMySqlTransientTransactionError } from '../repositories/contracts.js'
import { redactSensitiveText } from '../security/redactSecrets.js'
import { currentRequestId } from '../runtime/structuredLogger.js'
import {
  recordJobCoordinationEventSafely,
  recordJobCoordinationEventsSafely,
} from '../runtime/jobCoordinationTelemetry.js'

export type LeadScoreExecutionResult = {
  status: 'done' | 'failed' | 'retrying' | 'discarded' | 'dead_letter'
  nextAttemptAt?: Date
  error?: string
}

type LeadScoreHandler = (leadId: string) => Promise<LeadScoreExecutionResult>

export type LeadScoreJobLease = RowDataPacket & {
  lead_id: string
  status: string
  execution_attempts: number
  manual_retry_count: number
  next_attempt_at: Date
  lease_owner: string | null
  lease_expires_at: Date | null
  last_error: string | null
  enrichment_snapshot_id: string | null
  snapshot_hash: string | null
  rating_schema_version: string | null
  request_mode: 'automatic' | 'manual' | 'dedicated_project'
}

const jobsTable = quoteMysqlIdentifier(mysqlTableName('lead_score_jobs'))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const auditLogsTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
const pollMs = readIntegerEnv('SCORE_JOB_POLL_MS', 1_000, 250)
const leaseSeconds = readIntegerEnv('SCORE_JOB_LEASE_SECONDS', 900, 30)
const concurrency = readIntegerEnv('SCORE_QUEUE_CONCURRENCY', 2, 1)
const active = new Map<string, Promise<void>>()
let handler: LeadScoreHandler | undefined
let pollTimer: NodeJS.Timeout | undefined
let pollingPromise: Promise<void> | undefined
let started = false
let stopping = false

function readIntegerEnv(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`)
  }
  return value
}

function errorText(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : error).slice(0, 8_000)
}

export type LeadScoreEnqueueOptions = {
  recovering?: boolean
  snapshot?: Record<string, unknown>
  manualRetry?: boolean
  manualRetryAudit?: { userId?: string | null; userName: string; target: string }
  automaticCircuitRecovery?: { target: string }
  enrichmentSnapshotId?: string
  snapshotHash?: string
  ratingSchemaVersion?: string
  requestMode?: 'automatic' | 'manual' | 'dedicated_project'
}

async function enqueueLeadScoreJobOnce(
  leadId: string,
  options: LeadScoreEnqueueOptions,
): Promise<boolean> {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<LeadScoreJobLease[]>(
      `SELECT * FROM ${jobsTable} WHERE lead_id=? FOR UPDATE`,
      [leadId],
    )
    const row = rows[0]
    const now = new Date()
    const terminalStatuses = new Set(['done', 'failed', 'discarded', 'dead_letter'])
    if (options.manualRetry && (!row || !['failed', 'dead_letter'].includes(row.status))) {
      await connection.rollback()
      return false
    }
    if (options.automaticCircuitRecovery && (
      !row
      || row.status !== 'dead_letter'
      || !/熔断|circuit/i.test(String(row.last_error || ''))
    )) {
      await connection.rollback()
      return false
    }
    if (!options.manualRetry && !options.automaticCircuitRecovery && row?.status === 'dead_letter') {
      await connection.rollback()
      await recordJobCoordinationEventSafely({
        domain: 'lead-score', entityId: leadId, event: 'duplicateSuppressed',
      })
      return false
    }
    const hasLiveLease = row?.lease_expires_at && new Date(row.lease_expires_at).getTime() >= now.getTime()
    const alreadyActive = row && (
      row.status === 'queued'
      || (row.status === 'running' && hasLiveLease)
      || (row.status === 'retrying' && new Date(row.next_attempt_at).getTime() > now.getTime())
    )
    if (alreadyActive) {
      await connection.rollback()
      await recordJobCoordinationEventSafely({
        domain: 'lead-score', entityId: leadId, event: 'duplicateSuppressed',
      })
      return false
    }
    if (row) {
      const resetAttempts = options.manualRetry || terminalStatuses.has(row.status)
      await connection.query(
        `UPDATE ${jobsTable}
         SET status='queued', next_attempt_at=NOW(3), lease_owner=NULL, lease_expires_at=NULL,
           execution_attempts=IF(?, 0, execution_attempts),
           manual_retry_count=manual_retry_count+IF(?, 1, 0),
           completed_at=NULL, dead_lettered_at=NULL, last_error=NULL,
           enrichment_snapshot_id=COALESCE(?,enrichment_snapshot_id),
           snapshot_hash=COALESCE(?,snapshot_hash),
           rating_schema_version=COALESCE(?,rating_schema_version),
           request_mode=COALESCE(?,request_mode),updated_at=NOW(3)
         WHERE lead_id=?`,
        [resetAttempts, options.manualRetry === true, options.enrichmentSnapshotId ?? null,
          options.snapshotHash ?? null, options.ratingSchemaVersion ?? null,
          options.requestMode ?? null, leadId],
      )
    } else {
      await connection.query(
        `INSERT INTO ${jobsTable}
          (lead_id,status,execution_attempts,next_attempt_at,enrichment_snapshot_id,snapshot_hash,
           rating_schema_version,request_mode,created_at,updated_at)
         VALUES (?, 'queued', 0, NOW(3), ?, ?, ?, ?, NOW(3), NOW(3))`,
        [leadId, options.enrichmentSnapshotId ?? null, options.snapshotHash ?? null,
          options.ratingSchemaVersion ?? null, options.requestMode ?? 'automatic'],
      )
    }
    if (options.snapshot) {
      await connection.query(
        `UPDATE ${leadsTable}
         SET scoring=JSON_SET(COALESCE(scoring, JSON_OBJECT()), '$.scoreJob', CAST(? AS JSON))
         WHERE id=?`,
        [JSON.stringify(options.snapshot), leadId],
      )
    }
    if (options.manualRetry && options.manualRetryAudit) {
      await connection.query(
        `INSERT INTO ${auditLogsTable}
          (id, user_id, user_name, module, action, target, result, request_id, created_at)
         VALUES (?, ?, ?, '项目获取池', '人工重试 AI 评分死信', ?, 'success', ?, NOW(3))`,
        [
          randomUUID(),
          options.manualRetryAudit.userId ?? null,
          options.manualRetryAudit.userName.trim().slice(0, 64) || '（系统）',
          options.manualRetryAudit.target,
          currentRequestId() ?? randomUUID(),
        ],
      )
    }
    if (options.automaticCircuitRecovery) {
      await connection.query(
        `INSERT INTO ${auditLogsTable}
          (id, user_id, user_name, module, action, target, result, request_id, created_at)
         VALUES (?, NULL, '（系统）', '项目获取池', '系统恢复 AI 评分熔断死信', ?, 'success', ?, NOW(3))`,
        [
          randomUUID(),
          options.automaticCircuitRecovery.target,
          currentRequestId() ?? randomUUID(),
        ],
      )
    }
    await connection.commit()
    if (started) void poll()
    return true
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

export async function enqueueLeadScoreJob(
  leadId: string,
  options: LeadScoreEnqueueOptions = {},
): Promise<boolean> {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await enqueueLeadScoreJobOnce(leadId, options)
    } catch (error) {
      if (!isMySqlTransientTransactionError(error) || attempt === maxAttempts) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 10))
    }
  }
  return false
}

export async function recoverExpiredLeadScoreJobLeases(): Promise<number> {
  const [expiredRows] = await pool.query<Array<RowDataPacket & { lead_id: string }>>(
    `SELECT lead_id FROM ${jobsTable}
     WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW(3)`,
  )
  const [result] = await pool.query(
    `UPDATE ${jobsTable}
     SET status='queued', next_attempt_at=NOW(3), lease_owner=NULL, lease_expires_at=NULL,
       last_error=CONCAT('lease expired before completion', IF(last_error IS NULL, '', CONCAT(': ', LEFT(last_error, 512)))),
       updated_at=NOW(3)
     WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW(3)`,
  )
  const recovered = Number((result as { affectedRows?: number }).affectedRows || 0)
  if (recovered > 0) await recordJobCoordinationEventsSafely({
    domain: 'lead-score',
    entityIds: expiredRows.slice(0, recovered).map((row) => row.lead_id),
    event: 'leaseRecovered',
  })
  return recovered
}

export async function getLeadScoreJobBinding(leadId: string) {
  const [rows] = await pool.query<Array<RowDataPacket & {
    enrichment_snapshot_id: string | null
    snapshot_hash: string | null
    rating_schema_version: string | null
  }>>(
    `SELECT enrichment_snapshot_id,snapshot_hash,rating_schema_version FROM ${jobsTable} WHERE lead_id=? LIMIT 1`,
    [leadId],
  )
  const row = rows[0]
  return row ? {
    enrichmentSnapshotId: row.enrichment_snapshot_id,
    snapshotHash: row.snapshot_hash,
    ratingSchemaVersion: row.rating_schema_version,
  } : null
}

export async function listCircuitDeadLetterLeadScoreIds(limit = 500): Promise<string[]> {
  const [rows] = await pool.query<Array<RowDataPacket & { lead_id: string }>>(
    `SELECT lead_id FROM ${jobsTable}
     WHERE status='dead_letter' AND (last_error LIKE '%熔断%' OR LOWER(last_error) LIKE '%circuit%')
     ORDER BY dead_lettered_at, updated_at
     LIMIT ${Math.max(1, Math.min(Math.floor(limit), 1_000))}`,
  )
  return rows.map((row) => row.lead_id)
}

export async function claimLeadScoreJobLease(workerOwner = owner): Promise<LeadScoreJobLease | null> {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<LeadScoreJobLease[]>(
      `SELECT * FROM ${jobsTable}
       WHERE status IN ('queued', 'retrying') AND next_attempt_at <= NOW(3)
         AND (lease_expires_at IS NULL OR lease_expires_at < NOW(3))
       ORDER BY next_attempt_at, created_at
       LIMIT 1 FOR UPDATE SKIP LOCKED`,
    )
    const row = rows[0]
    if (!row) {
      await connection.rollback()
      const [contendedRows] = await connection.query<Array<RowDataPacket & { lead_id: string }>>(
        `SELECT lead_id FROM ${jobsTable}
         WHERE status='running' AND lease_expires_at >= NOW(3)
           AND last_started_at >= NOW(3) - INTERVAL 5 SECOND
         ORDER BY last_started_at DESC LIMIT 1`,
      )
      if (contendedRows[0]) await recordJobCoordinationEventSafely({
        domain: 'lead-score', entityId: contendedRows[0].lead_id, event: 'leaseContention',
      })
      return null
    }
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1_000)
    await connection.query(
      `UPDATE ${jobsTable}
       SET status='running', execution_attempts=execution_attempts+1, lease_owner=?, lease_expires_at=?,
         last_started_at=NOW(3), last_error=NULL, updated_at=NOW(3)
       WHERE lead_id=?`,
      [workerOwner, leaseExpiresAt, row.lead_id],
    )
    await connection.commit()
    return { ...row, status: 'running', execution_attempts: Number(row.execution_attempts || 0) + 1, lease_owner: workerOwner, lease_expires_at: leaseExpiresAt }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

export async function finishLeadScoreJobLease(
  row: LeadScoreJobLease,
  result: LeadScoreExecutionResult,
  workerOwner = owner,
): Promise<boolean> {
  const status = result.status === 'failed' ? 'dead_letter' : result.status
  const nextAttemptAt = result.status === 'retrying'
    ? result.nextAttemptAt ?? new Date(Date.now() + 60_000)
    : new Date()
  const [updateResult] = await pool.query(
    `UPDATE ${jobsTable}
     SET status=?, next_attempt_at=?, lease_owner=NULL, lease_expires_at=NULL,
       completed_at=IF(? IN ('done','dead_letter','discarded'), NOW(3), NULL),
       dead_lettered_at=IF(?='dead_letter', NOW(3), NULL), last_error=?, updated_at=NOW(3)
     WHERE lead_id=? AND status='running' AND lease_owner=?`,
    [status, nextAttemptAt, status, status, result.error?.slice(0, 8_000) ?? null, row.lead_id, workerOwner],
  )
  const completed = Number((updateResult as { affectedRows?: number }).affectedRows || 0) === 1
  if (!completed) await recordJobCoordinationEventSafely({
    domain: 'lead-score', entityId: row.lead_id, event: 'staleCompletionRejected',
  })
  return completed
}

async function execute(row: LeadScoreJobLease): Promise<void> {
  let heartbeat: NodeJS.Timeout | undefined
  let nextPollDelayMs = 0
  const promise = (async () => {
    try {
      heartbeat = setInterval(() => {
        const expiresAt = new Date(Date.now() + leaseSeconds * 1_000)
        void pool.query(
          `UPDATE ${jobsTable} SET lease_expires_at=?, updated_at=NOW(3)
           WHERE lead_id=? AND status='running' AND lease_owner=?`,
          [expiresAt, row.lead_id, owner],
        ).catch((error) => console.error(`[lead-score-job] heartbeat failed lead=${row.lead_id}: ${errorText(error)}`))
      }, Math.max(10_000, Math.floor(leaseSeconds * 1_000 / 3)))
      const result = await handler!(row.lead_id)
      await finishLeadScoreJobLease(row, result)
      if (result.status === 'retrying') {
        // Leave one second for application/DB clock skew before the due-time claim.
        nextPollDelayMs = Math.max(0, (result.nextAttemptAt?.getTime() ?? Date.now()) - Date.now()) + 1_000
      }
      console.log(`[lead-score-job] ${result.status} lead=${row.lead_id}`)
    } catch (error) {
      await finishLeadScoreJobLease(row, { status: 'dead_letter', error: errorText(error) }).catch((finishError) => {
        console.error(`[lead-score-job] finish failed lead=${row.lead_id}: ${errorText(finishError)}`)
      })
      console.error(`[lead-score-job] failed lead=${row.lead_id}: ${errorText(error)}`)
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      active.delete(row.lead_id)
      if (!stopping) {
        setTimeout(() => void poll(), nextPollDelayMs)
      }
    }
  })()
  active.set(row.lead_id, promise)
  await promise
}

function poll(): Promise<void> {
  if (stopping || !started || !handler) return Promise.resolve()
  if (pollingPromise) return pollingPromise
  const current = (async () => {
    try {
      await recoverExpiredLeadScoreJobLeases()
      let capacity = concurrency - active.size
      while (capacity > 0) {
        const row = await claimLeadScoreJobLease()
        if (!row) break
        void execute(row)
        capacity -= 1
      }
    } catch (error) {
      console.error(`[lead-score-job] poll failed: ${errorText(error)}`)
    }
  })()
  pollingPromise = current
  return current.finally(() => {
    if (pollingPromise === current) pollingPromise = undefined
  })
}

export async function startLeadScoreJobWorker(scoreHandler: LeadScoreHandler): Promise<void> {
  if (started) return
  handler = scoreHandler
  stopping = false
  await recoverExpiredLeadScoreJobLeases()
  started = true
  pollTimer = setInterval(() => void poll(), pollMs)
  pollTimer.unref()
  await poll()
  console.log(`[lead-score-job] worker ready owner=${owner} concurrency=${concurrency}`)
}

export async function stopLeadScoreJobWorker(): Promise<void> {
  if (!started) return
  stopping = true
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = undefined
  let timeout: NodeJS.Timeout | undefined
  await Promise.race([
    (async () => {
      if (pollingPromise) await pollingPromise.catch(() => undefined)
      await Promise.all([...active.values()].map((promise) => promise.catch(() => undefined)))
    })(),
    new Promise((resolve) => {
      timeout = setTimeout(resolve, 20_000)
      timeout.unref()
    }),
  ])
  if (timeout) clearTimeout(timeout)
  started = false
  handler = undefined
}

export async function leadScoreJobHealth() {
  try {
    const [rows] = await pool.query<Array<RowDataPacket & { queued: number; running: number; retrying: number; failed: number; dead_letter: number }>>(
      `SELECT
        SUM(status='queued') AS queued,
        SUM(status='running') AS running,
        SUM(status='retrying') AS retrying,
        SUM(status='failed') AS failed,
        SUM(status='dead_letter') AS dead_letter
       FROM ${jobsTable}`,
    )
    return {
      name: 'mysql-lead-score-jobs', ok: started && !stopping, inProcess: true, owner,
      queued: Number(rows[0]?.queued || 0), running: Number(rows[0]?.running || 0),
      retrying: Number(rows[0]?.retrying || 0), failed: Number(rows[0]?.failed || 0),
      deadLetter: Number(rows[0]?.dead_letter || 0), active: active.size,
    }
  } catch (error) {
    return { name: 'mysql-lead-score-jobs', ok: false, inProcess: true, owner, error: errorText(error) }
  }
}
