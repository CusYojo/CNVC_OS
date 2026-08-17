import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { inArray, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { auditLogs, leads } from '../db/schema.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  claimLeadScoreJobLease,
  enqueueLeadScoreJob,
  finishLeadScoreJobLease,
  recoverExpiredLeadScoreJobLeases,
} from '../services/leadScoreJobService.js'
import { jobCoordinationTarget } from '../runtime/jobCoordinationTelemetry.js'

type JobRow = RowDataPacket & {
  lead_id: string
  status: string
  execution_attempts: number
  manual_retry_count: number
  next_attempt_at: Date
  lease_owner: string | null
  lease_expires_at: Date | null
  completed_at: Date | null
  dead_lettered_at: Date | null
  last_error: string | null
}

const jobsTable = quoteMysqlIdentifier(mysqlTableName('lead_score_jobs'))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const fixturePrefix = `评分任务生命周期验收-${randomUUID().slice(0, 8)}`
const checks: string[] = []
const fixtureIds: string[] = Array.from({ length: 6 }, () => randomUUID())

function snapshot(status: 'queued' | 'running' | 'retrying' | 'done' | 'dead_letter') {
  return {
    status,
    attempts: 0,
    maxAttempts: 1,
    retryCycles: 0,
    updatedAt: new Date().toISOString(),
  }
}

async function job(leadId: string): Promise<JobRow> {
  const [rows] = await pool.query<JobRow[]>(`SELECT * FROM ${jobsTable} WHERE lead_id=?`, [leadId])
  assert.ok(rows[0], `missing score job for ${leadId}`)
  return rows[0]
}

async function createFixtureLeads() {
  await db.insert(leads).values(fixtureIds.map((id, index) => ({
    id,
    name: `${fixturePrefix}-${index + 1}`,
    source: 'lead-score-lifecycle-acceptance',
    poolStatus: '成功',
  })))
}

async function cleanup() {
  // The acceptance owns every audit row whose target starts with its UUID-bearing prefix.
  await db.delete(auditLogs).where(sql`${auditLogs.target} LIKE ${`${fixturePrefix}%`}`)
  await db.delete(auditLogs).where(inArray(
    auditLogs.target,
    fixtureIds.map((id) => jobCoordinationTarget('lead-score', id)),
  ))
  await pool.query(`DELETE FROM ${leadsTable} WHERE id IN (${fixtureIds.map(() => '?').join(',')})`, fixtureIds)
}

async function main() {
  await ensureSchema()
  const [activeRows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) AS count FROM ${jobsTable} WHERE status IN ('queued','running','retrying')`,
  )
  assert.equal(Number(activeRows[0]?.count || 0), 0, 'acceptance requires an idle lead score queue')
  await createFixtureLeads()

  try {
    const [competitionId, queuedId, retryingId, expiredId, liveLeaseId, deadLetterId] = fixtureIds

    const enqueued = await Promise.all([
      enqueueLeadScoreJob(competitionId, { snapshot: snapshot('queued') }),
      enqueueLeadScoreJob(competitionId, { snapshot: snapshot('queued') }),
    ])
    assert.deepEqual([...enqueued].sort(), [false, true])
    let row = await job(competitionId)
    assert.equal(row.status, 'queued')
    assert.equal(row.execution_attempts, 0)
    assert.equal(row.lease_owner, null)
    checks.push('queued-state-and-idempotent-enqueue-persisted')

    const owners = [`worker-a-${randomUUID()}`, `worker-b-${randomUUID()}`]
    const claims = await Promise.all(owners.map((workerOwner) => claimLeadScoreJobLease(workerOwner)))
    const winners = claims.filter((claim) => claim?.lead_id === competitionId)
    assert.equal(winners.length, 1)
    const winner = winners[0]!
    row = await job(competitionId)
    assert.equal(row.status, 'running')
    assert.equal(row.execution_attempts, 1)
    assert.equal(row.lease_owner, winner.lease_owner)
    assert.ok(row.lease_expires_at)
    checks.push('two-workers-only-one-valid-lease')

    const retryAt = new Date(Date.now() + 60_000)
    assert.equal(await finishLeadScoreJobLease(winner, {
      status: 'retrying',
      nextAttemptAt: retryAt,
      error: 'transient acceptance failure',
    }, winner.lease_owner!), true)
    row = await job(competitionId)
    assert.equal(row.status, 'retrying')
    assert.equal(row.lease_owner, null)
    assert.match(row.last_error ?? '', /transient acceptance failure/)
    assert.ok(new Date(row.next_attempt_at).getTime() >= retryAt.getTime() - 1_000)
    checks.push('retry-time-attempt-and-error-persisted')

    await pool.query(`UPDATE ${jobsTable} SET next_attempt_at=NOW(3) - INTERVAL 1 SECOND WHERE lead_id=?`, [competitionId])
    const restartedClaim = await claimLeadScoreJobLease(`restart-worker-${randomUUID()}`)
    assert.equal(restartedClaim?.lead_id, competitionId)
    assert.equal(restartedClaim?.execution_attempts, 2)
    assert.equal(await finishLeadScoreJobLease(restartedClaim!, { status: 'done' }, restartedClaim!.lease_owner!), true)
    checks.push('due-retry-resumes-after-worker-restart')

    await enqueueLeadScoreJob(queuedId, { snapshot: snapshot('queued') })
    await enqueueLeadScoreJob(retryingId, { snapshot: snapshot('queued') })
    const retryingClaim = await claimLeadScoreJobLease(`pre-restart-worker-${randomUUID()}`)
    assert.ok(retryingClaim)
    const retryingLeadId = retryingClaim!.lead_id
    assert.ok([queuedId, retryingId].includes(retryingLeadId))
    await finishLeadScoreJobLease(retryingClaim!, {
      status: 'retrying',
      nextAttemptAt: new Date(Date.now() + 60_000),
      error: 'restart retry fixture',
    }, retryingClaim!.lease_owner!)
    const stillQueuedId = retryingLeadId === queuedId ? retryingId : queuedId
    await enqueueLeadScoreJob(expiredId, { snapshot: snapshot('queued') })
    await enqueueLeadScoreJob(liveLeaseId, { snapshot: snapshot('queued') })
    await pool.query(
      `UPDATE ${jobsTable}
       SET status='running', execution_attempts=1, lease_owner='crashed-worker',
         lease_expires_at=NOW(3) - INTERVAL 1 SECOND, last_error='before crash'
       WHERE lead_id=?`,
      [expiredId],
    )
    await pool.query(
      `UPDATE ${jobsTable}
       SET status='running', execution_attempts=1, lease_owner='live-worker',
         lease_expires_at=NOW(3) + INTERVAL 10 MINUTE
       WHERE lead_id=?`,
      [liveLeaseId],
    )
    await pool.query(`UPDATE ${jobsTable} SET next_attempt_at=NOW(3) - INTERVAL 1 SECOND WHERE lead_id=?`, [retryingLeadId])

    assert.ok(await recoverExpiredLeadScoreJobLeases() >= 1)
    row = await job(expiredId)
    assert.equal(row.status, 'queued')
    assert.equal(row.lease_owner, null)
    assert.match(row.last_error ?? '', /lease expired before completion/)
    checks.push('expired-running-lease-recovers-to-queue')

    const resumed = new Set<string>()
    for (let index = 0; index < 3; index += 1) {
      const claim = await claimLeadScoreJobLease(`post-restart-worker-${index}`)
      assert.ok(claim)
      resumed.add(claim!.lead_id)
      await finishLeadScoreJobLease(claim!, { status: 'done' }, claim!.lease_owner!)
    }
    assert.deepEqual(resumed, new Set([stillQueuedId, retryingLeadId, expiredId]))
    assert.equal((await job(liveLeaseId)).lease_owner, 'live-worker')
    checks.push('queued-running-retrying-recovery-rules-enforced')
    checks.push('live-lease-not-stolen-after-restart')

    await enqueueLeadScoreJob(deadLetterId, { snapshot: snapshot('queued') })
    const terminalClaim = await claimLeadScoreJobLease(`terminal-worker-${randomUUID()}`)
    assert.equal(terminalClaim?.lead_id, deadLetterId)
    await finishLeadScoreJobLease(terminalClaim!, {
      status: 'failed',
      error: 'automatic retry limit exhausted',
    }, terminalClaim!.lease_owner!)
    row = await job(deadLetterId)
    assert.equal(row.status, 'dead_letter')
    assert.ok(row.dead_lettered_at)
    assert.ok(row.completed_at)
    assert.match(row.last_error ?? '', /retry limit exhausted/)
    checks.push('retry-exhaustion-enters-persistent-dead-letter')

    assert.equal(await enqueueLeadScoreJob(deadLetterId, { snapshot: snapshot('queued') }), false)
    assert.equal((await job(deadLetterId)).status, 'dead_letter')
    checks.push('automatic-path-cannot-revive-dead-letter')

    assert.equal(await enqueueLeadScoreJob(deadLetterId, {
      manualRetry: true,
      snapshot: snapshot('queued'),
      manualRetryAudit: { userName: '生命周期验收', target: `${fixturePrefix}-6` },
    }), true)
    row = await job(deadLetterId)
    assert.equal(row.status, 'queued')
    assert.equal(row.execution_attempts, 0)
    assert.equal(row.manual_retry_count, 1)
    assert.equal(row.dead_lettered_at, null)
    assert.equal(row.last_error, null)
    const [leadRows] = await pool.query<Array<RowDataPacket & { status: string }>>(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(scoring, '$.scoreJob.status')) AS status FROM ${leadsTable} WHERE id=?`,
      [deadLetterId],
    )
    assert.equal(leadRows[0]?.status, 'queued')
    const [auditRows] = await pool.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) AS count FROM ${quoteMysqlIdentifier(mysqlTableName('audit_logs'))}
       WHERE action='人工重试 AI 评分死信' AND target=?`,
      [`${fixturePrefix}-6`],
    )
    assert.equal(Number(auditRows[0]?.count || 0), 1)
    checks.push('manual-retry-resets-cycle-and-is-audited-atomically')

    const manualClaim = await claimLeadScoreJobLease(`manual-worker-${randomUUID()}`)
    assert.equal(manualClaim?.lead_id, deadLetterId)
    await finishLeadScoreJobLease(manualClaim!, { status: 'done' }, manualClaim!.lease_owner!)
    assert.equal((await job(deadLetterId)).status, 'done')
    checks.push('manually-retried-dead-letter-can-complete')

    console.log(JSON.stringify({ ok: true, checks, count: checks.length }))
  } finally {
    await cleanup()
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
