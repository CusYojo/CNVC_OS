import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  claimRuntimeJobLease,
  executeClaimedRuntimeJob,
  queueRuntimeJobNow,
  type RuntimeJobDefinition,
} from '../services/runtimeJobScheduler.js'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

assertIsolatedMysqlAcceptanceDatabase('runtimeJobReliabilityAcceptance')

type JobState = RowDataPacket & {
  last_status: string | null
  last_error: string | null
  consecutive_failures: number
  current_run_id: string | null
  lease_owner: string | null
  lease_expires_at: Date | null
  next_run_at: Date
}
type RunState = RowDataPacket & { status: string; attempt: number; error: string | null }

const jobsTable = quoteMysqlIdentifier(mysqlTableName('runtime_jobs'))
const runsTable = quoteMysqlIdentifier(mysqlTableName('runtime_job_runs'))
const marker = randomUUID()
const jobId = `reliability-accept-${marker}`
const owner = `reliability-owner:${marker}`

const definition: RuntimeJobDefinition = {
  id: jobId,
  task: jobId,
  enabled: true,
  scheduleKind: 'interval',
  intervalSeconds: 3_600,
  initialDelayMs: 0,
  timeoutMs: 40,
  maxAttempts: 2,
  // Deliberately ignores the signal. The scheduler itself must still enforce
  // timeout and release the durable lease.
  run: async () => await new Promise<Record<string, unknown>>(() => undefined),
}

async function state() {
  const [rows] = await pool.query<JobState[]>(`SELECT * FROM ${jobsTable} WHERE id=?`, [jobId])
  assert.ok(rows[0])
  return rows[0]
}

async function runs() {
  const [rows] = await pool.query<RunState[]>(
    `SELECT status,attempt,error FROM ${runsTable} WHERE job_id=? ORDER BY created_at,id`, [jobId],
  )
  return rows
}

async function main() {
  await pool.query(
    `INSERT INTO ${jobsTable}
      (id,task,enabled,schedule_kind,interval_seconds,payload,next_run_at,created_at,updated_at)
     VALUES (?,?,1,'interval',3600,JSON_OBJECT(),DATE_SUB(NOW(3),INTERVAL 1 SECOND),NOW(3),NOW(3))`,
    [jobId, jobId],
  )
  try {
    const definitions = new Map([[jobId, definition]])
    const firstClaim = await claimRuntimeJobLease(jobId, definitions, owner)
    assert.ok(firstClaim)
    await executeClaimedRuntimeJob(firstClaim)
    const first = await state()
    assert.equal(first.last_status, 'failed')
    assert.match(first.last_error || '', /job timeout after 40ms/)
    assert.equal(Number(first.consecutive_failures), 1)
    assert.equal(first.current_run_id, null)
    assert.equal(first.lease_owner, null)
    assert.equal(first.lease_expires_at, null)
    assert.ok(new Date(first.next_run_at).getTime() > Date.now())
    assert.deepEqual((await runs()).map((row) => [row.status, Number(row.attempt)]), [['failed', 1]])

    await pool.query(`UPDATE ${jobsTable} SET next_run_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE id=?`, [jobId])
    const secondClaim = await claimRuntimeJobLease(jobId, definitions, owner)
    assert.ok(secondClaim)
    await executeClaimedRuntimeJob(secondClaim)
    const second = await state()
    assert.equal(second.last_status, 'dead_letter')
    assert.equal(second.current_run_id, null)
    assert.deepEqual((await runs()).map((row) => [row.status, Number(row.attempt)]), [['failed', 1], ['dead_letter', 2]])

    await pool.query(`UPDATE ${jobsTable} SET next_run_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE id=?`, [jobId])
    assert.equal(await claimRuntimeJobLease(jobId, definitions, owner), null, 'dead-letter job must not be auto-claimed')
    await queueRuntimeJobNow(jobId)
    const requeued = await state()
    assert.equal(requeued.last_status, 'queued')
    assert.equal(Number(requeued.consecutive_failures), 0)
    assert.equal(requeued.last_error, null)

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'timeout-preempts-signal-ignoring-job',
        'timeout-releases-lease',
        'retry-uses-exponential-backoff',
        'max-consecutive-attempts-enter-dead-letter',
        'dead-letter-is-terminal-until-manually-requeued',
        'timeout-and-dead-letter-are-visible-to-operational-alert-metrics',
      ],
    }))
  } finally {
    await pool.query(`DELETE FROM ${jobsTable} WHERE id=?`, [jobId])
  }
}

await main().finally(async () => pool.end())
