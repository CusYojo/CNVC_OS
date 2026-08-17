import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, count, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { auditLogs, risks, users } from '../db/schema.js'
import { createRisk, listRisks, presentRisk, presentRisks, updateRisk } from '../services/riskService.js'
import { RiskCreateSchema, RiskPatchSchema } from '../routes/risks.js'

const checks: string[] = []
function check(name: string, assertion: () => void) {
  assertion()
  checks.push(name)
}

await ensureSchema()
const marker = randomUUID().slice(0, 8)
const userId = randomUUID()
const userName = `风险验收用户-${marker}`
const title = `风险持久化验收-${marker}`
const rollbackTitle = `风险回滚验收-${marker}`

try {
  await db.insert(users).values({
    id: userId,
    email: `risk-${marker}@example.invalid`,
    name: userName,
    role: '风险控制',
    department: '风险验收',
    passwordHash: 'risk-acceptance-not-for-login',
  })

  const created = await createRisk({
    projectId: null,
    projectName: '全局风险',
    type: '合规风险',
    level: '高',
    title,
    description: '验收输入的真实风险描述',
    source: '人工录入',
    status: '待处置',
    assignee: userName,
    detectedAt: new Date('2026-08-09T00:00:00+08:00'),
  }, userId, userName)
  const publicCreated = presentRisk(created)
  const statusOnlyPatch = RiskPatchSchema.parse({ status: '处理中', expectedVersion: publicCreated.version })
  const createDefaults = RiskCreateSchema.parse({
    projectName: '全局风险',
    type: '合规风险',
    description: '验收创建默认值',
    owner: userName,
    occurredAt: '2026-08-09',
  })
  check('risk-api-contract-maps-mysql-fields-and-legacy-status', () => {
    assert.equal(publicCreated.owner, userName)
    assert.equal(publicCreated.occurredAt, '2026-08-09')
    assert.equal(publicCreated.status, '待确认')
    assert.equal(publicCreated.description, '验收输入的真实风险描述')
    assert.deepEqual(statusOnlyPatch, { status: '处理中', expectedVersion: publicCreated.version })
    assert.equal(createDefaults.level, '中')
    assert.equal(createDefaults.status, '待确认')
  })

  const [createAudit] = await db.select().from(auditLogs).where(and(
    eq(auditLogs.userId, userId),
    eq(auditLogs.action, '新增风险'),
  )).limit(1)
  check('risk-create-persists-stable-assignee-and-real-actor-audit', () => {
    assert.equal(created.assigneeUserId, userId)
    assert.equal(createAudit?.userName, userName)
  })

  const updated = await updateRisk(created.id, { status: '处置中' }, userId, userName)
  const publicUpdated = presentRisk(updated)
  const refreshed = presentRisks(await listRisks())
  check('risk-update-and-refresh-use-authoritative-mysql-status', () => {
    assert.equal(publicUpdated.status, '处理中')
    assert.equal(publicUpdated.level, '高')
    assert.equal(refreshed.find((risk) => risk.id === created.id)?.status, '处理中')
    assert.equal(refreshed.find((risk) => risk.id === created.id)?.level, '高')
  })

  const rollbackError = await createRisk({
    projectId: null,
    projectName: '全局风险',
    type: '合规风险',
    title: rollbackTitle,
    description: '该风险应随审计失败回滚',
    assignee: userName,
  }, userId, '超'.repeat(100)).then(() => null, (error) => error)
  const [{ value: rollbackCount }] = await db.select({ value: count() }).from(risks)
    .where(eq(risks.title, rollbackTitle))
  check('risk-and-audit-transaction-rolls-back-on-audit-failure', () => {
    assert.ok(rollbackError)
    assert.equal(Number(rollbackCount), 0)
  })

  console.log(JSON.stringify({ ok: true, checks }))
} finally {
  await db.delete(auditLogs).where(eq(auditLogs.userId, userId)).catch(() => {})
  await db.delete(risks).where(eq(risks.createdBy, userId)).catch(() => {})
  await db.delete(users).where(eq(users.id, userId)).catch(() => {})
  await pool.end()
}
