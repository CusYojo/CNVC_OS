import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { projectClassificationHistory, projects, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { classifyProject, createProject } from '../services/projectService.js'

const checks: string[] = []
assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/, '本验收仅允许在 FDE 隔离前缀运行')
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
function check(name: string, assertion: () => void) {
  assertion()
  checks.push(name)
}

await ensureSchema()
const marker = randomUUID().slice(0, 8)
const ownerId = randomUUID()
const leaderId = randomUUID()
const projectName = `FDE项目池验收-${marker}`

try {
  await db.insert(users).values([
    {
      id: ownerId,
      email: `fde-pool-owner-${marker}@example.invalid`,
      name: `项目负责人-${marker}`,
      role: '投资经理',
      department: 'FDE验收部',
      passwordHash: 'fde-project-pool-acceptance-not-for-login',
    },
    {
      id: leaderId,
      email: `fde-pool-leader-${marker}@example.invalid`,
      name: `投资总监-${marker}`,
      role: '投资总监',
      department: 'FDE验收部',
      passwordHash: 'fde-project-pool-acceptance-not-for-login',
    },
  ])
  await identityRepositories.users.synchronizeAdministrationBindings(ownerId, '投资经理', 'FDE验收部')
  await identityRepositories.users.synchronizeAdministrationBindings(leaderId, '投资总监', 'FDE验收部')

  const created = await createProject({
    name: projectName,
    owner: `项目负责人-${marker}`,
    ownerUserId: ownerId,
    collaborators: [],
    source: '验收授权登记',
  }, ownerId)
  check('authorized-project-registration-starts-in-project-pool', () => {
    assert.equal(created.classification, 'pool')
    assert.equal(created.lifecycle, 'active')
    assert.equal(created.stage, '入库')
    assert.equal(created.progress, 0)
  })

  const normal = await classifyProject({
    projectId: created.id,
    toClassification: 'normal',
    reason: '入库初筛完成',
    expectedVersion: created.version,
    userId: ownerId,
    requestId: `accept-intake-${marker}`,
  })
  check('project-lead-completes-intake-without-approval', () => {
    assert.equal(normal.classification, 'normal')
    assert.equal(normal.stage, '立项')
    assert.equal(normal.stageSource, '入库完成')
    assert.equal(normal.progress, 10)
  })

  const unauthorized = await classifyProject({
    projectId: normal.id,
    toClassification: 'key',
    reason: '普通成员不得升级重点项目',
    expectedVersion: normal.version,
    userId: ownerId,
  }).then(() => null, (error) => error)
  check('project-owner-cannot-upgrade-key-project-without-leadership-permission', () => {
    assert.equal(unauthorized?.code, 'PROJECT_CLASSIFICATION_FORBIDDEN')
  })

  const key = await classifyProject({
    projectId: normal.id,
    toClassification: 'key',
    reason: '领导确认列为重点推进项目',
    expectedVersion: normal.version,
    userId: leaderId,
    requestId: `accept-key-${marker}`,
  })
  check('authorized-leader-upgrades-normal-project-to-key', () => {
    assert.equal(key.classification, 'key')
    assert.equal(key.stage, normal.stage)
    assert.equal(key.lifecycle, normal.lifecycle)
  })

  const staleVersion = await classifyProject({
    projectId: key.id,
    toClassification: 'normal',
    reason: '使用过期版本调整分类',
    expectedVersion: normal.version,
    userId: leaderId,
  }).then(() => null, (error) => error)
  check('stale-project-version-cannot-overwrite-classification', () => {
    assert.equal(staleVersion?.code, 'BUSINESS_VERSION_CONFLICT')
  })

  const history = await db.select().from(projectClassificationHistory)
    .where(eq(projectClassificationHistory.projectId, key.id))
  check('classification-history-is-append-only-and-complete', () => {
    assert.deepEqual(history.map((row) => row.toClassification).sort(), ['key', 'normal', 'pool'])
    assert.ok(history.every((row) => row.reason.trim().length >= 2))
  })

  console.log(JSON.stringify({ ok: true, checks }))
} finally {
  await db.delete(projects).where(eq(projects.createdBy, ownerId)).catch(() => undefined)
  await db.delete(users).where(eq(users.id, ownerId)).catch(() => undefined)
  await db.delete(users).where(eq(users.id, leaderId)).catch(() => undefined)
  await pool.end()
}
