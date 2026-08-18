import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { eq } from 'drizzle-orm'
import { db, pool } from '../src/db/client.js'
import { aiTasks, projects, users } from '../src/db/schema.js'
import { claimAiTaskForExecution } from '../src/services/aiTaskService.js'
import { mysqlIntegrationTestOptions } from './mysqlIntegrationTestSafety.js'

after(async () => await pool.end())

test('AI task lease permits exactly one concurrent claimant and reclaims only after expiry', mysqlIntegrationTestOptions, async (t) => {
  const marker = randomUUID()
  const [user] = await db.insert(users).values({
    email: `ai-task-lease-${marker}@example.invalid`,
    name: 'AI Task Lease Test',
    role: '系统管理员',
    passwordHash: marker,
  }).$returningId()
  const [project] = await db.insert(projects).values({
    name: `AI Task Lease Test ${marker}`,
    owner: 'AI Task Lease Test',
    createdBy: user.id,
  }).$returningId()
  const [task] = await db.insert(aiTasks).values({
    userId: user.id,
    projectId: project.id,
    type: 'project_qa',
    parameters: {},
    templateVersion: 'lease-test',
    idempotencyKey: marker,
  }).$returningId()
  t.after(async () => {
    await db.delete(aiTasks).where(eq(aiTasks.id, task.id))
    await db.delete(projects).where(eq(projects.id, project.id))
    await db.delete(users).where(eq(users.id, user.id))
  })

  const claims = await Promise.all([
    claimAiTaskForExecution(task.id),
    claimAiTaskForExecution(task.id),
  ])
  assert.deepEqual([...claims].sort(), [false, true])

  const [claimed] = await db.select().from(aiTasks).where(eq(aiTasks.id, task.id)).limit(1)
  assert.equal(claimed.status, 'running')
  assert.equal(claimed.executionAttempts, 1)
  assert.ok(claimed.leaseOwner)
  assert.ok(claimed.leaseExpiresAt && claimed.leaseExpiresAt.getTime() > Date.now())
  assert.equal(await claimAiTaskForExecution(task.id), false)

  await db.update(aiTasks).set({
    status: 'pending',
    leaseExpiresAt: new Date(Date.now() - 1_000),
  }).where(eq(aiTasks.id, task.id))
  assert.equal(await claimAiTaskForExecution(task.id), true)
  const [reclaimed] = await db.select().from(aiTasks).where(eq(aiTasks.id, task.id)).limit(1)
  assert.equal(reclaimed.executionAttempts, 2)
})
