import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, leadScoreJobs, leads, users } from '../db/schema.js'
import { deleteLeadFromPublicPool, listLeads } from '../services/aiSummaryService.js'

const marker = `lead-delete-acceptance-${randomUUID()}`
const userId = randomUUID()
const leadId = randomUUID()

try {
  await db.insert(users).values({
    id: userId,
    email: `${marker}@example.invalid`,
    name: '线索删除验收管理员',
    role: '系统管理员',
    department: '验收部',
    passwordHash: marker,
  })
  await db.insert(leads).values({
    id: leadId,
    name: marker,
    source: '线索删除验收',
    poolStatus: '成功',
  })
  await db.insert(leadScoreJobs).values({ leadId, status: 'queued' })

  const deleted = await deleteLeadFromPublicPool(leadId, {
    userId,
    userName: '线索删除验收管理员',
  })
  assert.deepEqual(deleted, { id: leadId, name: marker, alreadyDeleted: false })

  const [stored] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1)
  assert.equal(stored?.poolStatus, '已删除')
  assert.equal((await listLeads({ keyword: marker })).total, 0)
  assert.equal((await db.select().from(leadScoreJobs).where(eq(leadScoreJobs.leadId, leadId))).length, 0)

  const audits = await db.select().from(auditLogs).where(and(
    eq(auditLogs.userId, userId),
    eq(auditLogs.action, '删除公共线索'),
  ))
  assert.equal(audits.length, 1)
  assert.match(String(audits[0]?.target), new RegExp(leadId))

  const repeated = await deleteLeadFromPublicPool(leadId, {
    userId,
    userName: '线索删除验收管理员',
  })
  assert.deepEqual(repeated, { id: leadId, name: marker, alreadyDeleted: true })
  const repeatedAudits = await db.select().from(auditLogs).where(and(
    eq(auditLogs.userId, userId),
    eq(auditLogs.action, '删除公共线索'),
  ))
  assert.equal(repeatedAudits.length, 1)

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'deletion-is-auditable-soft-delete',
      'deleted-lead-is-hidden-from-list-and-stats-query-boundary',
      'pending-score-job-is-removed',
      'repeated-delete-is-idempotent',
    ],
  }))
} finally {
  await db.delete(auditLogs).where(eq(auditLogs.userId, userId))
  await db.delete(leads).where(eq(leads.id, leadId))
  await db.delete(users).where(eq(users.id, userId))
  await pool.end()
}
