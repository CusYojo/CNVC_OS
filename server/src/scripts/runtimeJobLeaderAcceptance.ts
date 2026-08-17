import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { jobCoordinationTarget } from '../runtime/jobCoordinationTelemetry.js'
import {
  claimRuntimeJobLease,
  recoverExpiredRuntimeJobLeases,
  type RuntimeJobDefinition,
} from '../services/runtimeJobScheduler.js'

type JobRow = RowDataPacket & {
  lease_owner: string | null
  lease_expires_at: Date | null
  current_run_id: string | null
  last_status: string | null
  consecutive_failures: number
  next_run_at: Date
  lease_live: number
  is_due: number
}

type RunRow = RowDataPacket & {
  id: string
  status: string
  lease_owner: string
  finished_at: Date | null
  error: string | null
}

const jobsTable = quoteMysqlIdentifier(mysqlTableName('runtime_jobs'))
const runsTable = quoteMysqlIdentifier(mysqlTableName('runtime_job_runs'))
const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
const marker = randomUUID()
const jobId = `leader-accept-${marker}`
const task = `leader-accept-${marker}`
const owners = [`instance-a:${marker}`, `instance-b:${marker}`]
const checks: string[] = []

const definition: RuntimeJobDefinition = {
  id: jobId,
  task,
  enabled: true,
  scheduleKind: 'interval',
  intervalSeconds: 3_600,
  initialDelayMs: 0,
  timeoutMs: 30_000,
  run: async () => ({ acceptance: true }),
}

async function jobRow() {
  const [rows] = await pool.query<JobRow[]>(
    `SELECT *, lease_expires_at > NOW(3) AS lease_live, next_run_at <= NOW(3) AS is_due
     FROM ${jobsTable} WHERE id=?`,
    [jobId],
  )
  assert.ok(rows[0], 'acceptance runtime job is missing')
  return rows[0]
}

async function runRows() {
  const [rows] = await pool.query<RunRow[]>(
    `SELECT id, status, lease_owner, finished_at, error FROM ${runsTable} WHERE job_id=? ORDER BY created_at, id`,
    [jobId],
  )
  return rows
}

async function main() {
  await pool.query(
    `INSERT INTO ${jobsTable}
      (id, task, enabled, schedule_kind, interval_seconds, payload, next_run_at, created_at, updated_at)
     VALUES (?, ?, 1, 'interval', 3600, JSON_OBJECT(), DATE_SUB(NOW(3), INTERVAL 1 SECOND), NOW(3), NOW(3))`,
    [jobId, task],
  )
  try {
    const definitions = new Map([[jobId, definition]])
    const claims = await Promise.all(owners.map(async (claimant) => (
      await claimRuntimeJobLease(jobId, definitions, claimant)
    )))
    const winners = claims.filter((claim) => claim !== null)
    assert.equal(winners.length, 1, 'two instances claimed the same due runtime job')
    const winner = winners[0]!
    const afterClaim = await jobRow()
    const firstRuns = await runRows()
    assert.equal(afterClaim.lease_owner, winner.leaseOwner)
    assert.equal(afterClaim.current_run_id, winner.runId)
    assert.equal(Number(afterClaim.lease_live), 1)
    assert.equal(firstRuns.length, 1)
    assert.equal(firstRuns[0].status, 'running')
    assert.equal(firstRuns[0].lease_owner, winner.leaseOwner)
    checks.push('two-instances-only-one-runtime-job-lease-and-run')

    const duplicate = await claimRuntimeJobLease(jobId, definitions, `instance-c:${marker}`)
    assert.equal(duplicate, null, 'an active lease was claimed again in the same schedule cycle')
    assert.equal((await runRows()).length, 1)
    checks.push('active-cycle-cannot-create-a-duplicate-run')

    await pool.query(
      `UPDATE ${jobsTable} SET lease_expires_at=DATE_SUB(NOW(3), INTERVAL 1 SECOND), updated_at=NOW(3) WHERE id=?`,
      [jobId],
    )
    await recoverExpiredRuntimeJobLeases()
    const recovered = await jobRow()
    const abandonedRuns = await runRows()
    assert.equal(recovered.lease_owner, null)
    assert.equal(recovered.lease_expires_at, null)
    assert.equal(recovered.current_run_id, null)
    assert.equal(recovered.last_status, 'abandoned')
    assert.equal(Number(recovered.consecutive_failures), 1)
    assert.equal(Number(recovered.is_due), 1)
    assert.equal(abandonedRuns[0].status, 'abandoned')
    assert.ok(abandonedRuns[0].finished_at)
    assert.match(abandonedRuns[0].error || '', /lease expired before completion/)
    checks.push('expired-owner-is-abandoned-and-job-becomes-due')

    const takeover = await claimRuntimeJobLease(jobId, definitions, `instance-d:${marker}`)
    assert.ok(takeover, 'another instance could not take over the expired job')
    assert.notEqual(takeover.runId, winner.runId)
    assert.equal((await runRows()).length, 2)
    checks.push('another-instance-takes-over-with-a-new-audited-run')

    console.log(JSON.stringify({ ok: true, checks }))
  } finally {
    await pool.query(`DELETE FROM ${auditTable} WHERE target=?`, [jobCoordinationTarget('runtime-job', jobId)])
    await pool.query(`DELETE FROM ${jobsTable} WHERE id=?`, [jobId])
  }
}

await main().finally(async () => pool.end())
