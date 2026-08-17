import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { redactSensitiveText } from '../security/redactSecrets.js'
import {
  recordJobCoordinationEventSafely,
  recordJobCoordinationEventsSafely,
} from '../runtime/jobCoordinationTelemetry.js'

export type ProjectScoreExecutionResult = {
  status: 'done' | 'retrying' | 'dead_letter'
  nextAttemptAt?: Date
  error?: string
}

type ProjectScoreHandler = (
  projectId: string,
  executionAttempt: number,
) => Promise<ProjectScoreExecutionResult>

export type ProjectScoreJobLease = RowDataPacket & {
  project_id: string
  status: 'queued' | 'running' | 'retrying' | 'done' | 'dead_letter'
  execution_attempts: number
  next_attempt_at: Date
  lease_owner: string | null
  lease_expires_at: Date | null
  last_error: string | null
}

const jobsTable = quoteMysqlIdentifier(mysqlTableName('project_score_jobs'))
const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
const pollMs = readIntegerEnv('PROJECT_SCORE_JOB_POLL_MS', 1_000, 250, 60_000)
const leaseSeconds = readIntegerEnv('PROJECT_SCORE_JOB_LEASE_SECONDS', 900, 30, 7_200)
const concurrency = readIntegerEnv('PROJECT_SCORE_QUEUE_CONCURRENCY', 1, 1, 16)
const active = new Map<string, Promise<void>>()
let handler: ProjectScoreHandler | undefined
let pollTimer: NodeJS.Timeout | undefined
let pollingPromise: Promise<void> | undefined
let started = false
let stopping = false

function readIntegerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 8_000)
}

export async function getProjectScoreJob(projectId: string): Promise<ProjectScoreJobLease | null> {
  const [rows] = await pool.query<ProjectScoreJobLease[]>(
    `SELECT * FROM ${jobsTable} WHERE project_id=? LIMIT 1`,
    [projectId],
  )
  return rows[0] ?? null
}

export async function enqueueProjectScoreJob(projectId: string): Promise<boolean> {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<ProjectScoreJobLease[]>(
      `SELECT * FROM ${jobsTable} WHERE project_id=? FOR UPDATE`,
      [projectId],
    )
    const row = rows[0]
    const now = Date.now()
    const liveLease = row?.lease_expires_at && new Date(row.lease_expires_at).getTime() >= now
    if (row && (
      row.status === 'queued'
      || (row.status === 'running' && liveLease)
      || (row.status === 'retrying' && new Date(row.next_attempt_at).getTime() > now)
    )) {
      await connection.rollback()
      await recordJobCoordinationEventSafely({
        domain: 'project-score', entityId: projectId, event: 'duplicateSuppressed',
      })
      return false
    }
    if (row) {
      await connection.query(
        `UPDATE ${jobsTable}
         SET status='queued', execution_attempts=0, next_attempt_at=NOW(3),
           lease_owner=NULL, lease_expires_at=NULL, last_started_at=NULL,
           completed_at=NULL, dead_lettered_at=NULL, last_error=NULL, updated_at=NOW(3)
         WHERE project_id=?`,
        [projectId],
      )
    } else {
      await connection.query(
        `INSERT INTO ${jobsTable}
          (project_id, status, execution_attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, 'queued', 0, NOW(3), NOW(3), NOW(3))`,
        [projectId],
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

export async function recoverExpiredProjectScoreJobLeases(projectId?: string): Promise<number> {
  const [expiredRows] = await pool.query<Array<RowDataPacket & { project_id: string }>>(
    `SELECT project_id FROM ${jobsTable}
     WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW(3)
       ${projectId ? 'AND project_id=?' : ''}`,
    projectId ? [projectId] : [],
  )
  const [result] = await pool.query(
    `UPDATE ${jobsTable}
     SET status='queued', next_attempt_at=NOW(3), lease_owner=NULL, lease_expires_at=NULL,
       last_error=CONCAT('lease expired before completion', IF(last_error IS NULL, '', CONCAT(': ', LEFT(last_error, 512)))),
       updated_at=NOW(3)
     WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW(3)
       ${projectId ? 'AND project_id=?' : ''}`,
    projectId ? [projectId] : [],
  )
  const recovered = Number((result as { affectedRows?: number }).affectedRows || 0)
  if (recovered > 0) await recordJobCoordinationEventsSafely({
    domain: 'project-score',
    entityIds: expiredRows.slice(0, recovered).map((row) => row.project_id),
    event: 'leaseRecovered',
  })
  return recovered
}

export async function claimProjectScoreJobLease(
  workerOwner = owner,
  projectId?: string,
): Promise<ProjectScoreJobLease | null> {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<ProjectScoreJobLease[]>(
      `SELECT * FROM ${jobsTable}
       WHERE status IN ('queued','retrying') AND next_attempt_at <= NOW(3)
         AND (lease_expires_at IS NULL OR lease_expires_at < NOW(3))
         ${projectId ? 'AND project_id=?' : ''}
       ORDER BY next_attempt_at, created_at
       LIMIT 1 FOR UPDATE SKIP LOCKED`,
      projectId ? [projectId] : [],
    )
    const row = rows[0]
    if (!row) {
      await connection.rollback()
      const [contendedRows] = await connection.query<Array<RowDataPacket & { project_id: string }>>(
        `SELECT project_id FROM ${jobsTable}
         WHERE status='running' AND lease_expires_at >= NOW(3)
           AND last_started_at >= NOW(3) - INTERVAL 5 SECOND
           ${projectId ? 'AND project_id=?' : ''}
         ORDER BY last_started_at DESC LIMIT 1`,
        projectId ? [projectId] : [],
      )
      if (contendedRows[0]) await recordJobCoordinationEventSafely({
        domain: 'project-score', entityId: contendedRows[0].project_id, event: 'leaseContention',
      })
      return null
    }
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1_000)
    await connection.query(
      `UPDATE ${jobsTable}
       SET status='running', execution_attempts=execution_attempts+1, lease_owner=?,
         lease_expires_at=?, last_started_at=NOW(3), last_error=NULL, updated_at=NOW(3)
       WHERE project_id=?`,
      [workerOwner, leaseExpiresAt, row.project_id],
    )
    await connection.commit()
    return {
      ...row,
      status: 'running',
      execution_attempts: Number(row.execution_attempts || 0) + 1,
      lease_owner: workerOwner,
      lease_expires_at: leaseExpiresAt,
    }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

export async function finishProjectScoreJobLease(
  row: ProjectScoreJobLease,
  result: ProjectScoreExecutionResult,
  workerOwner = owner,
): Promise<boolean> {
  const nextAttemptAt = result.status === 'retrying'
    ? result.nextAttemptAt ?? new Date(Date.now() + 60_000)
    : new Date()
  const [updateResult] = await pool.query(
    `UPDATE ${jobsTable}
     SET status=?, next_attempt_at=?, lease_owner=NULL, lease_expires_at=NULL,
       completed_at=IF(? IN ('done','dead_letter'), NOW(3), NULL),
       dead_lettered_at=IF(?='dead_letter', NOW(3), NULL),
       last_error=?, updated_at=NOW(3)
     WHERE project_id=? AND status='running' AND lease_owner=?`,
    [
      result.status,
      nextAttemptAt,
      result.status,
      result.status,
      result.error?.slice(0, 8_000) ?? null,
      row.project_id,
      workerOwner,
    ],
  )
  const completed = Number((updateResult as { affectedRows?: number }).affectedRows || 0) === 1
  if (!completed) await recordJobCoordinationEventSafely({
    domain: 'project-score', entityId: row.project_id, event: 'staleCompletionRejected',
  })
  return completed
}

async function execute(row: ProjectScoreJobLease): Promise<void> {
  let heartbeat: NodeJS.Timeout | undefined
  const promise = (async () => {
    try {
      heartbeat = setInterval(() => {
        const expiresAt = new Date(Date.now() + leaseSeconds * 1_000)
        void pool.query(
          `UPDATE ${jobsTable} SET lease_expires_at=?, updated_at=NOW(3)
           WHERE project_id=? AND status='running' AND lease_owner=?`,
          [expiresAt, row.project_id, owner],
        ).catch((error) => console.error(`[project-score-job] heartbeat failed project=${row.project_id}: ${safeError(error)}`))
      }, Math.max(10_000, Math.floor(leaseSeconds * 1_000 / 3)))
      const result = await handler!(row.project_id, row.execution_attempts)
      await finishProjectScoreJobLease(row, result)
      console.log(`[project-score-job] ${result.status} project=${row.project_id}`)
    } catch (error) {
      await finishProjectScoreJobLease(row, { status: 'dead_letter', error: safeError(error) }).catch((finishError) => {
        console.error(`[project-score-job] finish failed project=${row.project_id}: ${safeError(finishError)}`)
      })
      console.error(`[project-score-job] failed project=${row.project_id}: ${safeError(error)}`)
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      active.delete(row.project_id)
      if (!stopping) void poll()
    }
  })()
  active.set(row.project_id, promise)
  await promise
}

function poll(): Promise<void> {
  if (stopping || !started || !handler) return Promise.resolve()
  if (pollingPromise) return pollingPromise
  const current = (async () => {
    try {
      await recoverExpiredProjectScoreJobLeases()
      let capacity = concurrency - active.size
      while (capacity > 0) {
        const row = await claimProjectScoreJobLease()
        if (!row) break
        void execute(row)
        capacity -= 1
      }
    } catch (error) {
      console.error(`[project-score-job] poll failed: ${safeError(error)}`)
    }
  })()
  pollingPromise = current
  return current.finally(() => {
    if (pollingPromise === current) pollingPromise = undefined
  })
}

export async function startProjectScoreJobWorker(scoreHandler: ProjectScoreHandler): Promise<void> {
  if (started) return
  handler = scoreHandler
  stopping = false
  await recoverExpiredProjectScoreJobLeases()
  started = true
  pollTimer = setInterval(() => void poll(), pollMs)
  pollTimer.unref()
  await poll()
  console.log(`[project-score-job] worker ready owner=${owner} concurrency=${concurrency}`)
}

export async function stopProjectScoreJobWorker(): Promise<void> {
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

export async function projectScoreJobHealth() {
  try {
    const [rows] = await pool.query<Array<RowDataPacket & {
      queued: number
      running: number
      retrying: number
      dead_letter: number
    }>>(
      `SELECT
        SUM(status='queued') AS queued,
        SUM(status='running') AS running,
        SUM(status='retrying') AS retrying,
        SUM(status='dead_letter') AS dead_letter
       FROM ${jobsTable}`,
    )
    return {
      name: 'mysql-project-score-jobs',
      ok: started && !stopping,
      inProcess: true,
      owner,
      queued: Number(rows[0]?.queued || 0),
      running: Number(rows[0]?.running || 0),
      retrying: Number(rows[0]?.retrying || 0),
      deadLetter: Number(rows[0]?.dead_letter || 0),
      active: active.size,
    }
  } catch (error) {
    return { name: 'mysql-project-score-jobs', ok: false, inProcess: true, owner, error: safeError(error) }
  }
}
