import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { adminConfigurationRevisions, aiModelProviders, imBots, imOutbox, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { getFdeIntegrationSummary } from '../services/fdeIntegrationSummaryService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const marker = randomUUID(), adminId = randomUUID(), memberId = randomUUID()
const secretSentinel = `not-a-real-secret-${marker}`
try {
  await db.insert(users).values([
    { id: adminId, email: `integration-admin-${marker}@example.invalid`, name: '集成验收管理员', role: '系统管理员', passwordHash: 'not-for-login' },
    { id: memberId, email: `integration-member-${marker}@example.invalid`, name: '集成验收成员', role: '投资经理', passwordHash: 'not-for-login' },
  ])
  await identityRepositories.users.synchronizeAdministrationBindings(adminId, '系统管理员', '投资部')
  await identityRepositories.users.synchronizeAdministrationBindings(memberId, '投资经理', '投资部')
  const [provider] = await db.insert(aiModelProviders).values({ name: `未检测模型-${marker}`, baseUrl: 'https://example.invalid', credentialCiphertext: secretSentinel, lastTestStatus: null }).$returningId()
  const [bot] = await db.insert(imBots).values({ platform: 'wechat', name: `异常连接-${marker}`, credentialCiphertext: secretSentinel, credentialHint: 'synthetic', credentialFingerprint: '0'.repeat(64), config: { privateValue: secretSentinel }, enabled: false, connectionStatus: 'error' }).$returningId()
  await db.insert(adminConfigurationRevisions).values({ domain: 'ai', resourceType: 'provider', resourceId: provider.id, operation: 'update', sourceVersion: 1, snapshotCiphertext: secretSentinel, snapshotSha256: '0'.repeat(64), createdBy: adminId })
  const denied = await getFdeIntegrationSummary(memberId).then(() => null, (cause) => cause as { code: string })
  assert.equal(denied?.code, 'ROLE_FORBIDDEN')
  const before = await db.select({ total: sql<number>`COUNT(*)` }).from(imOutbox)
  const summary = await getFdeIntegrationSummary(adminId)
  assert.equal(summary.providers.find((item) => item.id === provider.id)!.lastTestStatus, null)
  assert.equal(summary.bots.find((item) => item.id === bot.id)!.connectionStatus, 'error')
  assert.equal(summary.database.provider, 'MySQL')
  assert.equal(summary.storage.probe, 'directory-access-only')
  assert.equal(JSON.stringify(summary).includes(secretSentinel), false)
  assert.equal(JSON.stringify(summary).includes('credentialCiphertext'), false)
  assert.equal(JSON.stringify(summary).includes('snapshotCiphertext'), false)
  assert.deepEqual(await db.select({ total: sql<number>`COUNT(*)` }).from(imOutbox), before)
  assert.equal((await db.select().from(imBots).where(eq(imBots.id, bot.id)))[0].credentialCiphertext, secretSentinel)
  console.log(JSON.stringify({ ok: true, checks: ['integration-summary-requires-real-system-permission', 'untested-and-error-states-not-fabricated-as-connected', 'no-credentials-config-or-snapshot-content-returned', 'refresh-does-not-change-settings-or-enqueue-messages'] }))
} finally { await pool.end() }
