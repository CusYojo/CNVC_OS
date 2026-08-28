import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { adminConfigurationRevisions, aiModelProviders, aiModelRoutes, aiModels, auditLogs, roles, userRoles, users } from '../db/schema.js'
import { decryptModelCredential, encryptModelCredential } from '../security/modelCredentialCrypto.js'
import {
  createAiModel,
  createModelProvider,
  listAvailableModels,
  listModelSettings,
  normalizeModelProviderUrl,
  resolveAiModelRoute,
  testModelProvider,
  updateAiModel,
  updateModelProvider,
  upsertAiModelRoute,
} from '../services/aiModelSettingsService.js'
import { gatewayText } from '../services/inProcessAiWorkflowService.js'

const original = {
  NODE_ENV: process.env.NODE_ENV,
  MODEL_CREDENTIAL_ENCRYPTION_KEY: process.env.MODEL_CREDENTIAL_ENCRYPTION_KEY,
  MODEL_PROVIDER_ALLOWED_HOSTS: process.env.MODEL_PROVIDER_ALLOWED_HOSTS,
}
const userId = randomUUID()
let providerId = ''
let modelId = ''
let fallbackModelId = ''
const profileKey = 'ai-document' as const
let originalRoute: typeof aiModelRoutes.$inferSelect | null = null
const firstKey = `acceptance-first-${randomUUID()}`
const secondKey = `acceptance-second-${randomUUID()}`
const server = createServer((req, res) => {
  if (req.url === '/v1/models' && req.headers.authorization === `Bearer ${secondKey}`) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"data":[]}')
    return
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST' && req.headers.authorization === `Bearer ${secondKey}`) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"choices":[{"message":{"content":"database-routed-model-ok"}}]}')
    return
  }
  if (req.url === '/v1/responses' && req.method === 'POST' && req.headers.authorization === `Bearer ${secondKey}`) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"output_text":"database-routed-model-ok"}')
    return
  }
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end('{"error":"unauthorized"}')
})

try {
  process.env.NODE_ENV = 'development'
  process.env.MODEL_CREDENTIAL_ENCRYPTION_KEY = 'ab'.repeat(32)
  delete process.env.MODEL_PROVIDER_ALLOWED_HOSTS
  await ensureSchema()
  await db.insert(users).values({
    id: userId,
    email: `model-settings-acceptance-${userId}@invalid.local`,
    name: '模型设置验收用户',
    role: '系统管理员',
    department: '测试隔离',
    passwordHash: 'not-used-by-acceptance',
    status: '启用',
  })
  const actor = { userId, userName: '模型设置验收用户', role: '系统管理员' }
  const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, 'SYSTEM_ADMIN')).limit(1)
  assert(adminRole, '隔离验收库缺少系统管理员角色')
  await db.insert(userRoles).values({ userId, roleId: adminRole.id, isPrimary: true })
  const forbiddenActor = { ...actor, userId: randomUUID(), role: '投资经理' }

  const cryptoRoundTrip = encryptModelCredential(firstKey, 'crypto-round-trip')
  assert.equal(decryptModelCredential(cryptoRoundTrip.ciphertext, 'crypto-round-trip'), firstKey)
  assert.equal(cryptoRoundTrip.ciphertext.includes(firstKey), false)
  assert.throws(() => decryptModelCredential(cryptoRoundTrip.ciphertext, 'wrong-context'), /无法解密/)
  process.env.NODE_ENV = 'production'
  process.env.MODEL_PROVIDER_ALLOWED_HOSTS = 'approved.example.com'
  assert.throws(() => normalizeModelProviderUrl('http://approved.example.com/v1'), /HTTPS/)
  assert.throws(() => normalizeModelProviderUrl('https://unapproved.example.com/v1'), /允许列表/)
  process.env.NODE_ENV = 'development'
  delete process.env.MODEL_PROVIDER_ALLOWED_HOSTS

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const provider = await createModelProvider({
    name: `acceptance-provider-${userId}`,
    protocol: 'openai-compatible',
    baseUrl,
    apiKey: firstKey,
    timeoutMs: 5_000,
    enabled: true,
  }, actor)
  providerId = provider.id
  assert.equal('credentialCiphertext' in provider, false)
  assert.equal('credentialFingerprint' in provider, false)
  assert.equal(provider.credentialMasked, `••••${firstKey.slice(-4)}`)
  const [rawProvider] = await db.select().from(aiModelProviders).where(eq(aiModelProviders.id, providerId)).limit(1)
  assert(rawProvider.credentialCiphertext)
  assert.equal(rawProvider.credentialCiphertext.includes(firstKey), false)

  const replaced = await updateModelProvider(providerId, {
    expectedVersion: provider.version,
    apiKey: secondKey,
  }, actor)
  assert.equal(replaced.credentialMasked, `••••${secondKey.slice(-4)}`)
  const [replacedRaw] = await db.select().from(aiModelProviders).where(eq(aiModelProviders.id, providerId)).limit(1)
  assert.equal(decryptModelCredential(replacedRaw.credentialCiphertext!, providerId), secondKey)
  await assert.rejects(
    updateModelProvider(providerId, { expectedVersion: provider.version, enabled: false }, actor),
    /其他管理员修改/,
  )
  await assert.rejects(listModelSettings(forbiddenActor), /仅系统管理员或 AI 平台管理员/)

  const model = await createAiModel({
    providerId,
    modelKey: 'acceptance-model',
    displayName: '验收模型',
    contextWindow: 128_000,
    capabilityTags: ['chat', 'json'],
    allowedRoles: ['系统管理员'],
    enabled: true,
    isDefault: false,
  }, actor)
  modelId = model.id
  assert.equal((await listAvailableModels('系统管理员')).some((item) => item.id === modelId), true)
  assert.equal((await listAvailableModels('投资经理')).some((item) => item.id === modelId), false)
  const fallbackModel = await createAiModel({
    providerId,
    modelKey: 'acceptance-fallback-model',
    displayName: '验收备用模型',
    contextWindow: 64_000,
    capabilityTags: ['chat'],
    allowedRoles: ['系统管理员'],
    enabled: true,
    isDefault: false,
  }, actor)
  fallbackModelId = fallbackModel.id

  ;[originalRoute] = await db.select().from(aiModelRoutes).where(eq(aiModelRoutes.profileKey, profileKey)).limit(1)
  const route = await upsertAiModelRoute({
    profileKey,
    modelId,
    fallbackModelId,
    enabled: true,
    expectedVersion: originalRoute?.version,
  }, actor)
  assert.equal(route.modelId, modelId)
  const runtime = await resolveAiModelRoute(profileKey, '系统管理员')
  assert.equal(runtime?.model, 'acceptance-model')
  assert.equal(runtime?.apiKey, secondKey)
  assert.equal(runtime?.baseUrl, baseUrl)
  assert.equal(await gatewayText({ system: 'acceptance', prompt: 'route check' }), 'database-routed-model-ok')

  const connection = await testModelProvider(providerId, actor)
  assert.equal(connection.ok, true)
  assert.equal(connection.status, 200)
  assert.match(connection.traceId, /^[0-9a-f-]{36}$/)

  const settingsJson = JSON.stringify(await listModelSettings(actor))
  assert.equal(settingsJson.includes(firstKey), false)
  assert.equal(settingsJson.includes(secondKey), false)
  assert.equal(settingsJson.includes('credentialCiphertext'), false)
  assert.equal(settingsJson.includes('credentialFingerprint'), false)

  const disabled = await updateAiModel(modelId, { expectedVersion: model.version, enabled: false }, actor)
  assert.equal(disabled.enabled, false)
  assert.equal((await listAvailableModels('系统管理员')).some((item) => item.id === modelId), false)
  assert.equal((await resolveAiModelRoute(profileKey, '系统管理员'))?.model, 'acceptance-fallback-model')
  await updateAiModel(fallbackModelId, { expectedVersion: fallbackModel.version, enabled: false }, actor)
  assert.equal(await resolveAiModelRoute(profileKey, '系统管理员'), null)

  const audits = await db.select().from(auditLogs).where(eq(auditLogs.userId, userId))
  assert(audits.some((item) => item.action === '替换 Provider 凭据'))
  assert(audits.some((item) => item.action === '测试 Provider 连接'))
  assert.equal(JSON.stringify(audits).includes(firstKey), false)
  assert.equal(JSON.stringify(audits).includes(secondKey), false)

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'aes-256-gcm-credential-roundtrip-and-aad-binding',
      'production-provider-https-and-host-allowlist-enforced',
      'mysql-ciphertext-never-contains-plaintext-api-key',
      'provider-list-returns-mask-not-ciphertext-or-fingerprint',
      'credential-is-replace-only-with-optimistic-versioning',
      'system-or-ai-platform-admin-required',
      'enabled-model-role-filtering',
      'mysql-profile-route-resolves-server-side-credential',
      'document-runtime-uses-mysql-model-route',
      'server-side-provider-connection-test-is-traceable',
      'disabled-model-is-not-listed-and-route-falls-back',
      'model-provider-route-and-test-changes-are-audited-without-secrets',
    ],
  }))
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  await db.delete(adminConfigurationRevisions).where(eq(adminConfigurationRevisions.createdBy, userId)).catch(() => undefined)
  if (providerId) {
    await db.delete(aiModelRoutes).where(eq(aiModelRoutes.profileKey, profileKey)).catch(() => undefined)
    if (modelId) await db.delete(aiModels).where(eq(aiModels.id, modelId)).catch(() => undefined)
    if (fallbackModelId) await db.delete(aiModels).where(eq(aiModels.id, fallbackModelId)).catch(() => undefined)
    await db.delete(aiModelProviders).where(eq(aiModelProviders.id, providerId)).catch(() => undefined)
    if (originalRoute) await db.insert(aiModelRoutes).values(originalRoute).catch(() => undefined)
  }
  await db.delete(auditLogs).where(eq(auditLogs.userId, userId)).catch(() => undefined)
  await db.delete(users).where(eq(users.id, userId)).catch(() => undefined)
  if (original.NODE_ENV === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = original.NODE_ENV
  if (original.MODEL_CREDENTIAL_ENCRYPTION_KEY === undefined) delete process.env.MODEL_CREDENTIAL_ENCRYPTION_KEY
  else process.env.MODEL_CREDENTIAL_ENCRYPTION_KEY = original.MODEL_CREDENTIAL_ENCRYPTION_KEY
  if (original.MODEL_PROVIDER_ALLOWED_HOSTS === undefined) delete process.env.MODEL_PROVIDER_ALLOWED_HOSTS
  else process.env.MODEL_PROVIDER_ALLOWED_HOSTS = original.MODEL_PROVIDER_ALLOWED_HOSTS
  await pool.end()
}
