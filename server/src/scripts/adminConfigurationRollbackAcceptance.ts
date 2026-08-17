import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import {
  adminConfigurationRevisions,
  aiCapabilities,
  aiCapabilityBindings,
  aiModelProviders,
  aiModelRoutes,
  aiModels,
  auditLogs,
  imBotBindings,
  imBots,
  imLeadPushRules,
  users,
} from '../db/schema.js'
import { decryptIntegrationCredential } from '../security/integrationCredentialCrypto.js'
import { decryptModelCredential } from '../security/modelCredentialCrypto.js'
import {
  createAiModel,
  createModelProvider,
  listModelConfigurationRevisions,
  rollbackModelConfigurationRevision,
  updateAiModel,
  updateModelProvider,
  upsertAiModelRoute,
} from '../services/aiModelSettingsService.js'
import {
  createCapabilityBinding,
  listCapabilityConfigurationRevisions,
  rollbackCapabilityConfigurationRevision,
  updateCapability,
  updateCapabilityBinding,
  type AiCapabilityActor,
} from '../services/aiCapabilityService.js'
import {
  createImBinding,
  createImBot,
  createLeadPushRule,
  deleteImBinding,
  deleteLeadPushRule,
  listImConfigurationRevisions,
  rollbackImConfigurationRevision,
  updateImBinding,
  updateImBot,
  updateLeadPushRule,
  type ImActor,
} from '../services/imIntegrationService.js'

const original = {
  NODE_ENV: process.env.NODE_ENV,
  MODEL_CREDENTIAL_ENCRYPTION_KEY: process.env.MODEL_CREDENTIAL_ENCRYPTION_KEY,
  INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY,
  IM_SAFE_MOCK_ENABLED: process.env.IM_SAFE_MOCK_ENABLED,
  MODEL_PROVIDER_ALLOWED_HOSTS: process.env.MODEL_PROVIDER_ALLOWED_HOSTS,
}
const marker = randomUUID().replaceAll('-', '')
const adminId = randomUUID()
const providerSecrets = [`provider-${randomUUID()}`, `provider-${randomUUID()}`]
const imSecrets = [`im-${randomUUID()}-secret-value`, `im-${randomUUID()}-secret-value`]
const ids = {
  provider: '', model: '', routeProfile: 'lead-enrichment' as const,
  capability: randomUUID(), capabilityBinding: '', bot: '', imBinding: '', rule: '',
}
let originalRoute: typeof aiModelRoutes.$inferSelect | null = null
const actor = {
  userId: adminId, userName: `配置回滚验收-${marker.slice(0, 8)}`, role: '系统管理员', department: '迁移验收部',
}
const modelActor = actor
const capabilityActor: AiCapabilityActor = actor
const imActor: ImActor = actor

function revisionBy(revisions: Awaited<ReturnType<typeof listModelConfigurationRevisions>>['revisions'], operation: string, sourceVersion: number) {
  const revision = revisions.find((item) => item.operation === operation && item.sourceVersion === sourceVersion)
  assert(revision, `missing ${operation} revision at source version ${sourceVersion}`)
  return revision
}

async function main() {
  process.env.NODE_ENV = 'development'
  process.env.MODEL_CREDENTIAL_ENCRYPTION_KEY = '91'.repeat(32)
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = '92'.repeat(32)
  process.env.IM_SAFE_MOCK_ENABLED = 'true'
  delete process.env.MODEL_PROVIDER_ALLOWED_HOSTS

  await db.insert(users).values({
    id: adminId,
    email: `configuration-rollback-${marker}@example.invalid`,
    name: actor.userName,
    role: actor.role,
    department: actor.department,
    passwordHash: 'not-used-by-configuration-rollback-acceptance',
    status: '启用',
  })

  const provider = await createModelProvider({
    name: `rollback-provider-${marker}`,
    protocol: 'openai-compatible',
    baseUrl: `https://rollback-${marker}.example.invalid/v1`,
    apiKey: providerSecrets[0],
    timeoutMs: 10_000,
    enabled: true,
  }, modelActor)
  ids.provider = provider.id
  const changedProvider = await updateModelProvider(provider.id, {
    expectedVersion: provider.version,
    name: `changed-provider-${marker}`,
    apiKey: providerSecrets[1],
  }, modelActor)
  const providerHistory = await listModelConfigurationRevisions('provider', provider.id, modelActor)
  const providerUpdateRevision = revisionBy(providerHistory.revisions, 'update', provider.version)
  const serializedProviderHistory = JSON.stringify(providerHistory)
  assert(!serializedProviderHistory.includes(providerSecrets[0]))
  assert(!serializedProviderHistory.includes(providerSecrets[1]))
  assert(!serializedProviderHistory.includes('snapshotCiphertext'))
  const rolledProvider = await rollbackModelConfigurationRevision({
    resourceType: 'provider', resourceId: provider.id, revisionId: providerUpdateRevision.id,
    expectedVersion: changedProvider.version,
  }, modelActor)
  assert.equal(rolledProvider.record.name, provider.name)
  assert.equal('credentialCiphertext' in rolledProvider.record, false)
  const [rawRolledProvider] = await db.select().from(aiModelProviders).where(eq(aiModelProviders.id, provider.id)).limit(1)
  assert.equal(decryptModelCredential(rawRolledProvider.credentialCiphertext!, provider.id), providerSecrets[0])
  await assert.rejects(rollbackModelConfigurationRevision({
    resourceType: 'provider', resourceId: provider.id, revisionId: providerUpdateRevision.id,
    expectedVersion: changedProvider.version,
  }, modelActor), (error: unknown) => (error as { code?: string }).code === 'CONFIGURATION_VERSION_CONFLICT')

  const model = await createAiModel({
    providerId: provider.id, modelKey: `rollback-model-${marker}`, displayName: `回滚模型-${marker.slice(0, 8)}`,
    contextWindow: 32_000, capabilityTags: ['chat'], allowedRoles: [], enabled: true, isDefault: false,
  }, modelActor)
  ids.model = model.id
  const changedModel = await updateAiModel(model.id, {
    expectedVersion: model.version, displayName: `已修改模型-${marker.slice(0, 8)}`, enabled: false,
  }, modelActor)
  const modelRevision = revisionBy((await listModelConfigurationRevisions('model', model.id, modelActor)).revisions, 'update', model.version)
  const rolledModel = await rollbackModelConfigurationRevision({
    resourceType: 'model', resourceId: model.id, revisionId: modelRevision.id, expectedVersion: changedModel.version,
  }, modelActor)
  assert.equal(rolledModel.record.displayName, model.displayName)
  assert.equal(rolledModel.record.enabled, true)

  ;[originalRoute] = await db.select().from(aiModelRoutes).where(eq(aiModelRoutes.profileKey, ids.routeProfile)).limit(1)
  const route = await upsertAiModelRoute({
    profileKey: ids.routeProfile, modelId: model.id, fallbackModelId: null, enabled: true,
    expectedVersion: originalRoute?.version,
  }, modelActor)
  const routeRevision = revisionBy(
    (await listModelConfigurationRevisions('route', ids.routeProfile, modelActor)).revisions,
    originalRoute ? 'update' : 'create', originalRoute?.version ?? 0,
  )
  const rolledRoute = await rollbackModelConfigurationRevision({
    resourceType: 'route', resourceId: ids.routeProfile, revisionId: routeRevision.id, expectedVersion: route.version,
  }, modelActor)
  if (originalRoute) assert.equal(rolledRoute.record.modelId, originalRoute.modelId)
  else assert.equal(rolledRoute.record.enabled, false)

  await db.insert(aiCapabilities).values({
    id: ids.capability, kind: 'skill', capabilityKey: `rollback-capability-${marker}`,
    name: `回滚能力-${marker.slice(0, 8)}`, description: 'configuration rollback acceptance fixture',
    source: 'builtin', packageVersion: 'acceptance', config: {}, toolNames: [], dependencyNames: [],
    allowedRoles: [], enabled: true, createdBy: adminId, updatedBy: adminId,
  })
  const changedCapability = await updateCapability(ids.capability, {
    expectedVersion: 1, name: `已修改能力-${marker.slice(0, 8)}`, enabled: false,
  }, capabilityActor)
  const capabilityRevision = revisionBy(
    (await listCapabilityConfigurationRevisions('capability', ids.capability, capabilityActor)).revisions as typeof providerHistory.revisions,
    'update', 1,
  )
  const rolledCapability = await rollbackCapabilityConfigurationRevision({
    resourceType: 'capability', resourceId: ids.capability,
    revisionId: capabilityRevision.id, expectedVersion: changedCapability.version,
  }, capabilityActor)
  assert.equal(rolledCapability.record.enabled, true)

  const capabilityBinding = await createCapabilityBinding({
    capabilityId: ids.capability, scopeType: 'department', department: actor.department, enabled: true,
  }, capabilityActor)
  ids.capabilityBinding = capabilityBinding.id
  const changedCapabilityBinding = await updateCapabilityBinding(capabilityBinding.id, {
    expectedVersion: capabilityBinding.version, enabled: false,
  }, capabilityActor)
  const capabilityBindingRevision = revisionBy(
    (await listCapabilityConfigurationRevisions('capability_binding', capabilityBinding.id, capabilityActor)).revisions as typeof providerHistory.revisions,
    'update', capabilityBinding.version,
  )
  const rolledCapabilityBinding = await rollbackCapabilityConfigurationRevision({
    resourceType: 'capability_binding', resourceId: capabilityBinding.id,
    revisionId: capabilityBindingRevision.id, expectedVersion: changedCapabilityBinding.version,
  }, capabilityActor)
  assert.equal(rolledCapabilityBinding.record.enabled, true)

  const bot = await createImBot({
    platform: 'dingtalk', name: `rollback-bot-${marker}`,
    credentials: { webhookUrl: 'mock://success', inboundSecret: imSecrets[0] }, enabled: true,
  }, imActor)
  ids.bot = bot.id
  const binding = await createImBinding({
    botId: bot.id, externalConversationId: `rollback-group-${marker}`, userId: adminId, enabled: true,
  }, imActor)
  ids.imBinding = binding.id
  const changedBot = await updateImBot(bot.id, {
    expectedVersion: bot.version, name: `changed-bot-${marker}`,
    credentials: { webhookUrl: 'mock://success', inboundSecret: imSecrets[1] },
  }, imActor)
  const botRevision = revisionBy(
    (await listImConfigurationRevisions('im_bot', bot.id, imActor)).revisions as typeof providerHistory.revisions,
    'update', bot.version,
  )
  await assert.rejects(rollbackImConfigurationRevision({
    resourceType: 'im_bot', resourceId: bot.id, revisionId: botRevision.id, expectedVersion: changedBot.version,
  }, imActor), (error: unknown) => (error as { code?: string }).code === 'CONFIGURATION_ROLLBACK_CONFIRMATION_REQUIRED')
  const rolledBot = await rollbackImConfigurationRevision({
    resourceType: 'im_bot', resourceId: bot.id, revisionId: botRevision.id,
    expectedVersion: changedBot.version, confirmImpact: true,
  }, imActor)
  assert.equal(rolledBot.record.name, bot.name)
  assert.equal('credentialCiphertext' in rolledBot.record, false)
  const [rawRolledBot] = await db.select().from(imBots).where(eq(imBots.id, bot.id)).limit(1)
  assert.equal(decryptIntegrationCredential(rawRolledBot.credentialCiphertext, bot.id).inboundSecret, imSecrets[0])

  const changedBinding = await updateImBinding(binding.id, {
    expectedVersion: binding.version, externalConversationId: `changed-group-${marker}`,
  }, imActor)
  const bindingRevision = revisionBy(
    (await listImConfigurationRevisions('im_binding', binding.id, imActor)).revisions as typeof providerHistory.revisions,
    'update', binding.version,
  )
  const rolledBinding = await rollbackImConfigurationRevision({
    resourceType: 'im_binding', resourceId: binding.id,
    revisionId: bindingRevision.id, expectedVersion: changedBinding.version,
  }, imActor)
  assert.equal(rolledBinding.record.externalConversationId, binding.externalConversationId)

  const rule = await createLeadPushRule({
    name: `rollback-rule-${marker}`, botId: bot.id, bindingId: binding.id,
    messageTemplate: '{name} / {companyName}', enabled: true,
  }, imActor)
  ids.rule = rule.id
  const changedRule = await updateLeadPushRule(rule.id, {
    expectedVersion: rule.version, name: `changed-rule-${marker}`, messageTemplate: '{name}',
  }, imActor)
  const ruleUpdateRevision = revisionBy(
    (await listImConfigurationRevisions('im_lead_push_rule', rule.id, imActor)).revisions as typeof providerHistory.revisions,
    'update', rule.version,
  )
  const rolledRule = await rollbackImConfigurationRevision({
    resourceType: 'im_lead_push_rule', resourceId: rule.id,
    revisionId: ruleUpdateRevision.id, expectedVersion: changedRule.version,
  }, imActor)
  assert.equal(rolledRule.record.name, rule.name)
  const rolledRuleVersion = Number(rolledRule.record.version)
  await deleteLeadPushRule(rule.id, imActor)
  const ruleDeleteRevision = revisionBy(
    (await listImConfigurationRevisions('im_lead_push_rule', rule.id, imActor)).revisions as typeof providerHistory.revisions,
    'delete', rolledRuleVersion,
  )
  const restoredRule = await rollbackImConfigurationRevision({
    resourceType: 'im_lead_push_rule', resourceId: rule.id,
    revisionId: ruleDeleteRevision.id, expectedVersion: 0,
  }, imActor)
  assert.equal(restoredRule.record.name, rule.name)
  await deleteLeadPushRule(rule.id, imActor)

  const rolledBindingVersion = Number(rolledBinding.record.version)
  await deleteImBinding(binding.id, imActor)
  const bindingDeleteRevision = revisionBy(
    (await listImConfigurationRevisions('im_binding', binding.id, imActor)).revisions as typeof providerHistory.revisions,
    'delete', rolledBindingVersion,
  )
  const restoredBinding = await rollbackImConfigurationRevision({
    resourceType: 'im_binding', resourceId: binding.id,
    revisionId: bindingDeleteRevision.id, expectedVersion: 0,
  }, imActor)
  assert.equal(restoredBinding.record.externalConversationId, binding.externalConversationId)

  const revisions = await db.select().from(adminConfigurationRevisions)
    .where(eq(adminConfigurationRevisions.createdBy, adminId))
  assert(revisions.length >= 20)
  assert(revisions.every((item) => /^[0-9a-f]{64}$/.test(item.snapshotSha256)))
  assert(revisions.filter((item) => item.snapshotCiphertext).every((item) => {
    const serialized = item.snapshotCiphertext || ''
    return !providerSecrets.some((secret) => serialized.includes(secret))
      && !imSecrets.some((secret) => serialized.includes(secret))
  }))
  const audits = await db.select().from(auditLogs).where(eq(auditLogs.userId, adminId))
  assert(audits.some((item) => item.action === '回滚模型配置'))
  assert(audits.some((item) => item.action === '回滚能力配置'))
  assert(audits.some((item) => item.action === '回滚 IM 配置'))
  assert(!JSON.stringify(audits).includes(providerSecrets[0]))
  assert(!JSON.stringify(audits).includes(imSecrets[0]))

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'model-provider-credential-update-encrypted-history-and-exact-rollback',
      'model-and-profile-route-versioned-rollback',
      'capability-and-binding-versioned-rollback',
      'im-bot-credential-rollback-requires-impact-confirmation',
      'im-binding-update-and-delete-restore',
      'im-lead-push-rule-update-and-delete-restore',
      'stale-rollback-version-rejected',
      'revision-api-excludes-snapshot-ciphertext-and-plaintext-secrets',
      'rollback-audit-chain-excludes-secret-values',
      'revision-snapshot-sha256-and-aes-gcm-integrity',
    ],
  }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  if (ids.routeProfile) {
    await db.delete(aiModelRoutes).where(eq(aiModelRoutes.profileKey, ids.routeProfile)).catch(() => undefined)
    if (originalRoute) await db.insert(aiModelRoutes).values(originalRoute).catch(() => undefined)
  }
  await db.delete(imLeadPushRules).where(eq(imLeadPushRules.id, ids.rule || randomUUID())).catch(() => undefined)
  await db.delete(imBotBindings).where(eq(imBotBindings.id, ids.imBinding || randomUUID())).catch(() => undefined)
  await db.delete(imBots).where(eq(imBots.id, ids.bot || randomUUID())).catch(() => undefined)
  await db.delete(aiCapabilityBindings).where(eq(aiCapabilityBindings.id, ids.capabilityBinding || randomUUID())).catch(() => undefined)
  await db.delete(aiCapabilities).where(eq(aiCapabilities.id, ids.capability)).catch(() => undefined)
  await db.delete(aiModels).where(eq(aiModels.id, ids.model || randomUUID())).catch(() => undefined)
  await db.delete(aiModelProviders).where(eq(aiModelProviders.id, ids.provider || randomUUID())).catch(() => undefined)
  await db.delete(adminConfigurationRevisions).where(eq(adminConfigurationRevisions.createdBy, adminId)).catch(() => undefined)
  await db.delete(auditLogs).where(eq(auditLogs.userId, adminId)).catch(() => undefined)
  await db.delete(users).where(eq(users.id, adminId)).catch(() => undefined)

  const residue = await Promise.all([
    db.select({ id: adminConfigurationRevisions.id }).from(adminConfigurationRevisions).where(eq(adminConfigurationRevisions.createdBy, adminId)),
    db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.userId, adminId)),
    db.select({ id: users.id }).from(users).where(eq(users.id, adminId)),
  ]).catch(() => [[], [], []] as const)
  if (residue.some((rows) => rows.length)) {
    console.error('[admin-configuration-rollback] fixture residue was not removed')
    process.exitCode = 1
  }

  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await pool.end()
})
