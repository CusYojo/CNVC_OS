import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { agentConversations, chatConversations, projects, users } from '../db/schema.js'
import { ensureSchema } from '../db/migrate.js'
import {
  assertNewJwConversationAllowed,
  resolveJwConversationRolloutPolicy,
} from '../config/jwConversationRolloutPolicy.js'
import { hashPassword } from '../services/authService.js'
import {
  appendMessages,
  createConversation,
  deleteConversation,
  getConversation,
} from '../services/conversationService.js'

const marker = randomUUID()
const originalGlobal = process.env.JW_GLOBAL_NEW_CONVERSATIONS_ENABLED
const originalProject = process.env.JW_PROJECT_NEW_CONVERSATIONS_ENABLED
let userId = ''
let projectId = ''
const conversationIds: string[] = []

function setRollout(globalEnabled: string, projectEnabled: string): void {
  process.env.JW_GLOBAL_NEW_CONVERSATIONS_ENABLED = globalEnabled
  process.env.JW_PROJECT_NEW_CONVERSATIONS_ENABLED = projectEnabled
}

function expectDisabled(scope: 'global' | 'project', code: string): void {
  assert.throws(
    () => assertNewJwConversationAllowed(scope),
    (error: unknown) => Boolean(error && typeof error === 'object'
      && (error as { status?: unknown }).status === 503
      && (error as { code?: unknown }).code === code),
  )
}

try {
  await ensureSchema()
  const passwordHash = await hashPassword(`rollout-${marker}`)
  const [user] = await db.insert(users).values({
    email: `jw-rollout-${marker}@example.invalid`,
    name: `JW灰度验收-${marker.slice(0, 8)}`,
    role: '系统管理员',
    department: '迁移验收',
    passwordHash,
  }).$returningId()
  userId = user.id
  const [project] = await db.insert(projects).values({
    name: `JW灰度项目-${marker}`,
    owner: `JW灰度验收-${marker.slice(0, 8)}`,
    collaborators: [],
    createdBy: userId,
  }).$returningId()
  projectId = project.id

  setRollout('false', 'false')
  expectDisabled('global', 'JW_GLOBAL_NEW_CONVERSATIONS_DISABLED')
  expectDisabled('project', 'JW_PROJECT_NEW_CONVERSATIONS_DISABLED')
  await assert.rejects(
    createConversation(userId, { scope: 'global', title: '应拒绝的全局会话' }),
    (error: unknown) => Boolean(error && typeof error === 'object'
      && (error as { code?: unknown }).code === 'JW_GLOBAL_NEW_CONVERSATIONS_DISABLED'),
  )
  await assert.rejects(
    createConversation(userId, { scope: 'project', projectId, title: '应拒绝的项目会话' }),
    (error: unknown) => Boolean(error && typeof error === 'object'
      && (error as { code?: unknown }).code === 'JW_PROJECT_NEW_CONVERSATIONS_DISABLED'),
  )

  setRollout('true', 'false')
  const independent = resolveJwConversationRolloutPolicy()
  assert.equal(independent.globalNewConversationsEnabled, true)
  assert.equal(independent.projectNewConversationsEnabled, false)
  assert.equal(independent.fallbackRuntime, null)
  const globalConversation = await createConversation(userId, { scope: 'global', title: '已开放全局会话' })
  conversationIds.push(globalConversation.id)
  await assert.rejects(
    createConversation(userId, { scope: 'project', projectId, title: '仍关闭项目会话' }),
    (error: unknown) => Boolean(error && typeof error === 'object'
      && (error as { code?: unknown }).code === 'JW_PROJECT_NEW_CONVERSATIONS_DISABLED'),
  )

  // 关闭新建后，既有 MySQL 会话仍可读取和追加兼容消息，证明开关不破坏历史恢复。
  setRollout('false', 'false')
  assert(await getConversation(userId, globalConversation.id))
  await appendMessages(userId, globalConversation.id, [{
    id: randomUUID(), role: 'user', content: '已有会话在关闭新建后仍可继续',
  }])
  const persisted = await getConversation(userId, globalConversation.id)
  assert.equal(Array.isArray(persisted?.messages) ? persisted.messages.length : 0, 1)

  setRollout('false', 'true')
  const projectConversation = await createConversation(userId, {
    scope: 'project', projectId, title: '已开放项目会话',
  })
  conversationIds.push(projectConversation.id)
  await assert.rejects(
    createConversation(userId, { scope: 'global', title: '仍关闭全局会话' }),
    (error: unknown) => Boolean(error && typeof error === 'object'
      && (error as { code?: unknown }).code === 'JW_GLOBAL_NEW_CONVERSATIONS_DISABLED'),
  )

  setRollout('yes', 'true')
  assert.throws(() => resolveJwConversationRolloutPolicy(), /JW_GLOBAL_NEW_CONVERSATIONS_ENABLED/)
  setRollout('true', '1')
  assert.throws(() => resolveJwConversationRolloutPolicy(), /JW_PROJECT_NEW_CONVERSATIONS_ENABLED/)

  const [conversationServiceSource, routeSource] = await Promise.all([
    readFile(path.resolve('server/src/services/conversationService.ts'), 'utf8'),
    readFile(path.resolve('server/src/routes/conversations.ts'), 'utf8'),
  ])
  assert.match(conversationServiceSource, /assertNewJwConversationAllowed\(scope\)/)
  assert.doesNotMatch(`${conversationServiceSource}\n${routeSource}`, /from\s+['"][^'"]*flue/i)
  assert.doesNotMatch(`${conversationServiceSource}\n${routeSource}`, /proxy_pass|localhost:\d+/i)

  const cleanupConversationIds = [...conversationIds]
  for (const id of cleanupConversationIds) await deleteConversation(userId, id)
  await db.delete(projects).where(eq(projects.id, projectId))
  await db.delete(users).where(eq(users.id, userId))
  const [remainingChat, remainingAgent, remainingProject, remainingUser] = await Promise.all([
    db.select({ id: chatConversations.id }).from(chatConversations).where(inArray(chatConversations.id, cleanupConversationIds)),
    db.select({ id: agentConversations.id }).from(agentConversations).where(inArray(agentConversations.id, cleanupConversationIds)),
    db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)),
    db.select({ id: users.id }).from(users).where(eq(users.id, userId)),
  ])
  assert.equal(remainingChat.length + remainingAgent.length + remainingProject.length + remainingUser.length, 0)
  conversationIds.length = 0
  projectId = ''
  userId = ''

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'global-and-project-new-conversation-admission-independent',
      'disabled-scope-fails-closed-with-503-code',
      'existing-mysql-conversation-readable-and-writable-after-new-admission-disabled',
      'invalid-boolean-rollout-config-rejected',
      'rollout-policy-has-no-fallback-runtime',
      'conversation-create-path-has-no-retired-runtime-import-or-proxy',
      'synthetic-user-project-conversations-cleaned',
    ],
  }))
} finally {
  if (originalGlobal === undefined) delete process.env.JW_GLOBAL_NEW_CONVERSATIONS_ENABLED
  else process.env.JW_GLOBAL_NEW_CONVERSATIONS_ENABLED = originalGlobal
  if (originalProject === undefined) delete process.env.JW_PROJECT_NEW_CONVERSATIONS_ENABLED
  else process.env.JW_PROJECT_NEW_CONVERSATIONS_ENABLED = originalProject
  for (const id of conversationIds) await deleteConversation(userId, id).catch(() => false)
  if (projectId) await db.delete(projects).where(eq(projects.id, projectId)).catch(() => undefined)
  if (userId) await db.delete(users).where(eq(users.id, userId)).catch(() => undefined)
  await pool.end()
}
