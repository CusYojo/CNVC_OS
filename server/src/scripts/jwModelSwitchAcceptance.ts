import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import {
  agentConversations,
  agentMessageParts,
  agentMessages,
  aiModelProviders,
  aiModels,
  auditLogs,
  chatConversations,
  users,
} from '../db/schema.js'
import { hashPassword } from '../services/authService.js'
import {
  createAiModel,
  createModelProvider,
  listAvailableModels,
  resolveAiModelById,
} from '../services/aiModelSettingsService.js'
import {
  getJwAgentSnapshot,
  shutdownJwAgentRuntime,
  switchJwAgentModel,
} from '../runtime/jwAgentRuntime.js'

const original = {
  nodeEnv: process.env.NODE_ENV,
  encryptionKey: process.env.MODEL_CREDENTIAL_ENCRYPTION_KEY,
  allowedHosts: process.env.MODEL_PROVIDER_ALLOWED_HOSTS,
}
const marker = randomUUID()
const userId = randomUUID()
const otherUserId = randomUUID()
const conversationId = randomUUID()
const agentId = `jw-model-switch-${marker}`
const messageId = randomUUID()
let providerId = ''
let firstModelId = ''
let secondModelId = ''
let cleaned = false
const evidenceDir = path.resolve('.runtime/migration-evidence/jw-model-switch')

async function writeEvidence(report: Record<string, unknown>) {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const target = path.resolve(evidenceDir, 'report.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  await chmod(target, 0o600)
}

async function cleanup() {
  await shutdownJwAgentRuntime()
  await db.delete(agentConversations).where(eq(agentConversations.id, conversationId)).catch(() => undefined)
  await db.delete(chatConversations).where(eq(chatConversations.id, conversationId)).catch(() => undefined)
  if (firstModelId) await db.delete(aiModels).where(eq(aiModels.id, firstModelId)).catch(() => undefined)
  if (secondModelId) await db.delete(aiModels).where(eq(aiModels.id, secondModelId)).catch(() => undefined)
  if (providerId) await db.delete(aiModelProviders).where(eq(aiModelProviders.id, providerId)).catch(() => undefined)
  await db.delete(auditLogs).where(eq(auditLogs.userId, userId)).catch(() => undefined)
  await db.delete(users).where(eq(users.id, otherUserId)).catch(() => undefined)
  await db.delete(users).where(eq(users.id, userId)).catch(() => undefined)
  cleaned = true
}

try {
  process.env.NODE_ENV = 'development'
  process.env.MODEL_CREDENTIAL_ENCRYPTION_KEY = 'cd'.repeat(32)
  delete process.env.MODEL_PROVIDER_ALLOWED_HOSTS
  await ensureSchema()
  const passwordHash = await hashPassword(`Jw-model-switch-${marker}`)
  await db.insert(users).values([{
    id: userId,
    email: `jw-model-switch-${marker}@example.invalid`,
    name: 'JW 模型切换验收用户',
    role: '系统管理员',
    department: '迁移验收',
    passwordHash,
  }, {
    id: otherUserId,
    email: `jw-model-switch-other-${marker}@example.invalid`,
    name: 'JW 模型切换越权用户',
    role: '系统管理员',
    department: '迁移验收',
    passwordHash,
  }])
  const actor = { userId, userName: 'JW 模型切换验收用户', role: '系统管理员' }
  const provider = await createModelProvider({
    name: `jw-model-switch-provider-${marker}`,
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: `synthetic-model-key-${marker}`,
    timeoutMs: 5_000,
    enabled: true,
  }, actor)
  providerId = provider.id
  const first = await createAiModel({
    providerId,
    modelKey: `jw-switch-first-${marker}`,
    displayName: 'JW 切换验收模型一',
    contextWindow: 64_000,
    capabilityTags: ['chat'],
    allowedRoles: ['系统管理员'],
    enabled: true,
    isDefault: false,
  }, actor)
  firstModelId = first.id
  const second = await createAiModel({
    providerId,
    modelKey: `jw-switch-second-${marker}`,
    displayName: 'JW 切换验收模型二',
    contextWindow: 128_000,
    capabilityTags: ['chat'],
    allowedRoles: ['系统管理员'],
    enabled: true,
    isDefault: false,
  }, actor)
  secondModelId = second.id
  await db.insert(chatConversations).values({
    id: conversationId,
    userId,
    title: 'JW 模型切换验收',
    scope: 'global',
    agentId,
    messages: [],
  })
  await db.insert(agentConversations).values({
    id: conversationId,
    userId,
    title: 'JW 模型切换验收',
    scope: 'global',
    status: 'idle',
    runtime: 'jw',
    externalSessionId: agentId,
    modelId: firstModelId,
    metadata: { sdkSessionId: `sdk-model-switch-${marker}`, retained: 'yes', activeModel: first.modelKey },
  })
  await db.insert(agentMessages).values({
    id: messageId,
    conversationId,
    externalMessageId: `model-switch-message-${marker}`,
    role: 'assistant',
    sequence: 0,
    content: 'synthetic-history',
    status: 'complete',
  })
  await db.insert(agentMessageParts).values({
    messageId,
    partIndex: 0,
    type: 'text',
    content: 'synthetic-history',
  })

  assert.equal(await switchJwAgentModel({
    userId: otherUserId,
    userName: 'JW 模型切换越权用户',
    userRole: '系统管理员',
    agentId,
    modelId: secondModelId,
  }), null)
  await assert.rejects(switchJwAgentModel({
    userId,
    userName: actor.userName,
    userRole: actor.role,
    agentId,
    modelId: randomUUID(),
  }), (error: unknown) => (error as { code?: string }).code === 'MODEL_FORBIDDEN')
  await db.update(agentConversations).set({ status: 'streaming' }).where(eq(agentConversations.id, conversationId))
  await assert.rejects(switchJwAgentModel({
    userId,
    userName: actor.userName,
    userRole: actor.role,
    agentId,
    modelId: secondModelId,
  }), (error: unknown) => (error as { code?: string }).code === 'AGENT_MODEL_SWITCH_BUSY')
  await db.update(agentConversations).set({ status: 'idle' }).where(eq(agentConversations.id, conversationId))

  const switched = await switchJwAgentModel({
    userId,
    userName: actor.userName,
    userRole: actor.role,
    agentId,
    modelId: secondModelId,
  })
  assert.deepEqual(switched, { ok: true, modelId: secondModelId, disposed: false, unchanged: false })
  const [afterSwitch] = await db.select().from(agentConversations)
    .where(eq(agentConversations.id, conversationId)).limit(1)
  assert.equal(afterSwitch?.modelId, secondModelId)
  assert.equal(afterSwitch?.metadata?.sdkSessionId, `sdk-model-switch-${marker}`)
  assert.equal(afterSwitch?.metadata?.retained, 'yes')
  assert.equal(afterSwitch?.metadata?.activeModel, null)
  assert.equal(afterSwitch?.metadata?.modelChangedFrom, firstModelId)
  assert.equal(afterSwitch?.metadata?.modelChangedTo, secondModelId)
  assert.equal((await resolveAiModelById(afterSwitch!.modelId!, actor.role))?.model, second.modelKey)
  assert.equal((await listAvailableModels(actor.role)).some((model) => model.id === secondModelId), true)
  const snapshot = await getJwAgentSnapshot(userId, agentId)
  assert.equal(snapshot?.messages.length, 1)
  assert.equal(snapshot?.messages[0]?.parts.length, 1)
  assert.equal((await db.select().from(chatConversations).where(eq(chatConversations.id, conversationId))).length, 1)

  const unchanged = await switchJwAgentModel({
    userId,
    userName: actor.userName,
    userRole: actor.role,
    agentId,
    modelId: secondModelId,
  })
  assert.equal(unchanged?.unchanged, true)
  const fallback = await switchJwAgentModel({
    userId,
    userName: actor.userName,
    userRole: actor.role,
    agentId,
    modelId: null,
  })
  assert.equal(fallback?.modelId, null)

  await cleanup()
  const remaining = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)),
    db.select().from(users).where(eq(users.id, otherUserId)),
    db.select().from(chatConversations).where(eq(chatConversations.id, conversationId)),
    db.select().from(agentConversations).where(eq(agentConversations.id, conversationId)),
    db.select().from(aiModelProviders).where(eq(aiModelProviders.id, providerId)),
  ])
  assert.equal(remaining.reduce((total, rows) => total + rows.length, 0), 0)

  const checks = [
    'authorized-model-selection-validated-against-enabled-role-scoped-catalog',
    'cross-user-invalid-and-busy-switches-rejected',
    'selected-model-id-persists-for-next-runtime-session',
    'sdk-session-id-and-mysql-message-history-preserved',
    'runtime-active-model-cleared-until-next-model-init-event',
    'same-model-switch-is-idempotent',
    'environment-default-model-fallback-supported',
    'synthetic-provider-model-identity-and-conversation-cleaned',
    'mode: 0o600',
  ]
  await writeEvidence({ ok: true, generatedAt: new Date().toISOString(), checks, cleanup: { remainingRows: 0 } })
  console.log(JSON.stringify({ ok: true, checks }))
} finally {
  if (!cleaned) await cleanup()
  if (original.nodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = original.nodeEnv
  if (original.encryptionKey === undefined) delete process.env.MODEL_CREDENTIAL_ENCRYPTION_KEY
  else process.env.MODEL_CREDENTIAL_ENCRYPTION_KEY = original.encryptionKey
  if (original.allowedHosts === undefined) delete process.env.MODEL_PROVIDER_ALLOWED_HOSTS
  else process.env.MODEL_PROVIDER_ALLOWED_HOSTS = original.allowedHosts
  await pool.end()
}
