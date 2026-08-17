import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { jobCoordinationTarget } from '../runtime/jobCoordinationTelemetry.js'
import {
  claimProjectScoreJobLease,
  enqueueProjectScoreJob,
  finishProjectScoreJobLease,
  getProjectScoreJob,
  recoverExpiredProjectScoreJobLeases,
} from '../services/projectScoreJobService.js'

const projectsTable = quoteMysqlIdentifier(mysqlTableName('projects'))
const jobsTable = quoteMysqlIdentifier(mysqlTableName('project_score_jobs'))
const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
const projectId = randomUUID()
const ownerA = `project-score-acceptance-a-${randomUUID()}`
const ownerB = `project-score-acceptance-b-${randomUUID()}`
const checks: string[] = []

function check(condition: unknown, name: string): asserts condition {
  if (!condition) throw new Error(`[project score lifecycle] failed: ${name}`)
  checks.push(name)
}

async function main() {
  await ensureSchema()
  await pool.query(
    `INSERT INTO ${projectsTable}
      (id, name, stage, owner, collaborators, risk_level, score, progress, tags, pinned, created_at, updated_at)
     VALUES (?, ?, '线索', '项目评分验收', JSON_ARRAY(), '低', 0, 0, JSON_ARRAY(), 0, NOW(3), NOW(3))`,
    [projectId, `项目评分租约验收-${projectId.slice(0, 8)}`],
  )
  try {
    const first = await enqueueProjectScoreJob(projectId)
    const duplicate = await enqueueProjectScoreJob(projectId)
    const queued = await getProjectScoreJob(projectId)
    check(first && !duplicate && queued?.status === 'queued', 'enqueue-is-persistent-and-idempotent')

    const [claimA, claimB] = await Promise.all([
      claimProjectScoreJobLease(ownerA, projectId),
      claimProjectScoreJobLease(ownerB, projectId),
    ])
    const claimed = claimA ?? claimB
    const winningOwner = claimA ? ownerA : ownerB
    check(Boolean(claimed) && Number(Boolean(claimA)) + Number(Boolean(claimB)) === 1, 'two-workers-receive-only-one-valid-lease')

    const wrongOwnerFinished = await finishProjectScoreJobLease(claimed!, { status: 'done' }, `${winningOwner}-wrong`)
    check(!wrongOwnerFinished && (await getProjectScoreJob(projectId))?.status === 'running', 'lease-owner-is-required-to-finish')

    const retryAt = new Date(Date.now() - 1_000)
    const retryFinished = await finishProjectScoreJobLease(claimed!, {
      status: 'retrying',
      nextAttemptAt: retryAt,
      error: 'temporary gateway failure',
    }, winningOwner)
    const retrying = await getProjectScoreJob(projectId)
    check(retryFinished && retrying?.status === 'retrying' && retrying.last_error === 'temporary gateway failure', 'retry-state-attempt-and-error-are-persistent')

    const retryLease = await claimProjectScoreJobLease(ownerA, projectId)
    check(retryLease?.status === 'running' && retryLease.execution_attempts === 2, 'due-retry-is-reclaimed-with-incremented-attempt')

    await pool.query(
      `UPDATE ${jobsTable} SET lease_expires_at=DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE project_id=?`,
      [projectId],
    )
    const recovered = await recoverExpiredProjectScoreJobLeases(projectId)
    const recoveredRow = await getProjectScoreJob(projectId)
    check(recovered === 1 && recoveredRow?.status === 'queued' && recoveredRow.last_error?.includes('lease expired'), 'restart-recovers-expired-running-lease')

    const finalLease = await claimProjectScoreJobLease(ownerB, projectId)
    check(finalLease?.execution_attempts === 3, 'recovered-job-can-be-claimed-again')
    const done = await finishProjectScoreJobLease(finalLease!, { status: 'done' }, ownerB)
    const completed = await getProjectScoreJob(projectId)
    check(done && completed?.status === 'done' && completed.lease_owner === null, 'completion-is-persistent-and-releases-lease')

    const rescored = await enqueueProjectScoreJob(projectId)
    const reset = await getProjectScoreJob(projectId)
    check(rescored && reset?.status === 'queued' && reset.execution_attempts === 0 && reset.last_error === null, 'explicit-rescore-resets-terminal-attempt-state')
  } finally {
    await pool.query(`DELETE FROM ${auditTable} WHERE target=?`, [jobCoordinationTarget('project-score', projectId)])
    await pool.query(`DELETE FROM ${projectsTable} WHERE id=?`, [projectId])
  }
  const [orphans] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) AS count FROM ${jobsTable} WHERE project_id=?`,
    [projectId],
  )
  check(Number(orphans[0]?.count || 0) === 0, 'project-delete-cascades-score-job')
  console.log(JSON.stringify({ ok: true, checks, count: checks.length }))
}

await main().finally(() => pool.end())
