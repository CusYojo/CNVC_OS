import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import type { RowDataPacket } from 'mysql2'
import { eq } from 'drizzle-orm'
import { db, pool } from '../src/db/client.js'
import { leads } from '../src/db/schema.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../src/db/config.js'
import {
  enqueueLeadScoreJob,
  startLeadScoreJobWorker,
  stopLeadScoreJobWorker,
} from '../src/services/leadScoreJobService.js'

const jobsTable = quoteMysqlIdentifier(mysqlTableName('lead_score_jobs'))

after(async () => {
  await stopLeadScoreJobWorker()
  await pool.end()
})

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`condition not reached within ${timeoutMs}ms`)
}

test('MySQL lead scoring queue claims once and persists deferred retry', async (t) => {
  const leadId = randomUUID()
  await db.insert(leads).values({
    id: leadId,
    name: `评分队列迁移测试项目-${leadId.slice(0, 8)}`,
    source: 'queue-migration-test',
    poolStatus: '成功',
  })
  t.after(async () => {
    await stopLeadScoreJobWorker()
    await db.delete(leads).where(eq(leads.id, leadId))
  })

  const scheduled = await Promise.all([
    enqueueLeadScoreJob(leadId, { snapshot: { status: 'queued', attempts: 0 } }),
    enqueueLeadScoreJob(leadId, { snapshot: { status: 'queued', attempts: 0 } }),
  ])
  assert.deepEqual([...scheduled].sort(), [false, true])
  const [snapshotRows] = await pool.query<Array<RowDataPacket & { status: string }>>(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(scoring, '$.scoreJob.status')) AS status
     FROM ${quoteMysqlIdentifier(mysqlTableName('leads'))} WHERE id=?`,
    [leadId],
  )
  assert.equal(snapshotRows[0]?.status, 'queued')

  let executions = 0
  await startLeadScoreJobWorker(async (claimedLeadId) => {
    assert.equal(claimedLeadId, leadId)
    executions += 1
    if (executions === 1) {
      return {
        status: 'retrying',
        nextAttemptAt: new Date(Date.now() + 300),
        error: 'transient fixture failure',
      }
    }
    return { status: 'done' }
  })

  await waitFor(async () => {
    const [rows] = await pool.query<Array<RowDataPacket & { status: string; execution_attempts: number; lease_owner: string | null }>>(
      `SELECT status, execution_attempts, lease_owner FROM ${jobsTable} WHERE lead_id=?`,
      [leadId],
    )
    return rows[0]?.status === 'done' && Number(rows[0].execution_attempts) === 2 && rows[0].lease_owner === null
  })
  assert.equal(executions, 2)
})
