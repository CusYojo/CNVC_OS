import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import {
  agentConversations,
  adminConfigurationRevisions,
  auditLogs,
  imBotBindings,
  imBots,
  imDeliveryLogs,
  imInboundMessages,
  imLeadPushRules,
  imOutbox,
  leads,
  projects,
  users,
} from '../db/schema.js'
import { decryptIntegrationCredential } from '../security/integrationCredentialCrypto.js'
import {
  assertImAdmin,
  createImBinding,
  createImBot,
  createWeixinBotFromLogin,
  createLeadPushRule,
  deleteLeadPushRule,
  deleteImBinding,
  enqueueImMessage,
  dispatchLeadPushRule,
  listLeadPushSettings,
  listImSettings,
  processImOutboxBatch,
  routeImInboundMessage,
  testImBotConnection,
  updateImBot,
  updateLeadPushRule,
  validateImCredentials,
  type ImActor,
} from '../services/imIntegrationService.js'

const original = {
  NODE_ENV: process.env.NODE_ENV,
  INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY,
  IM_SAFE_MOCK_ENABLED: process.env.IM_SAFE_MOCK_ENABLED,
}
const marker = randomUUID().slice(0, 8)
const ids = {
  admin: randomUUID(), ordinary: randomUUID(), outsider: randomUUID(), project: randomUUID(), conversation: randomUUID(), lead: randomUUID(),
}
const admin: ImActor = { userId: ids.admin, userName: '机器人验收管理员', role: '系统管理员', department: '平台部' }
const ordinary: ImActor = { userId: ids.ordinary, userName: '机器人验收用户', role: '投资经理', department: '投资一部' }
const outsider: ImActor = { userId: ids.outsider, userName: '机器人验收外部用户', role: '投资经理', department: '投资二部' }
const botIds: string[] = []
const bindingIds: string[] = []
const ruleIds: string[] = []
const checks: string[] = []

async function rejectsCode(action: () => unknown | Promise<unknown>, code: string) {
  try { await action() } catch (error) { return (error as { code?: string }).code === code }
  return false
}

async function check(name: string, action: () => unknown | Promise<unknown>) {
  await action()
  checks.push(name)
}

async function main() {
  process.env.NODE_ENV = 'development'
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = '7c'.repeat(32)
  await check('safe-mock-is-explicitly-production-gated', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.IM_SAFE_MOCK_ENABLED
    assert.equal(await rejectsCode(() => validateImCredentials('dingtalk', {
      webhookUrl: 'mock://success', inboundSecret: `${randomUUID()}${randomUUID()}`,
    }), 'IM_WEBHOOK_FORBIDDEN'), true)
    process.env.IM_SAFE_MOCK_ENABLED = 'true'
    assert.equal(validateImCredentials('dingtalk', {
      webhookUrl: 'mock://success', inboundSecret: `${randomUUID()}${randomUUID()}`,
    }).webhookUrl, 'mock://success')
    process.env.NODE_ENV = 'development'
    delete process.env.IM_SAFE_MOCK_ENABLED
  })
  await db.insert(users).values([
    { id: ids.admin, email: `im-admin-${marker}@example.invalid`, name: admin.userName, role: admin.role, department: admin.department, passwordHash: 'not-used' },
    { id: ids.ordinary, email: `im-user-${marker}@example.invalid`, name: ordinary.userName, role: ordinary.role, department: ordinary.department, passwordHash: 'not-used' },
    { id: ids.outsider, email: `im-outsider-${marker}@example.invalid`, name: outsider.userName, role: outsider.role, department: outsider.department, passwordHash: 'not-used' },
  ])
  await db.insert(projects).values({
    id: ids.project, name: `IM 验收项目-${marker}`, owner: ordinary.userName,
    ownerUserId: ids.ordinary, createdBy: ids.ordinary,
  })
  await db.insert(agentConversations).values({
    id: ids.conversation, userId: ids.ordinary, projectId: ids.project,
    title: 'IM 验收会话', externalSessionId: `im-agent-${marker}`,
  })
  await db.insert(leads).values({
    id: ids.lead, name: `IM 验收线索-${marker}`, companyName: '验收公司',
    industry: '企业服务', poolStatus: '成功', score: 72, convertedProjectId: ids.project,
  })

  await check('system-or-operations-admin-required-at-service-boundary', async () => {
    assert.equal(await rejectsCode(() => Promise.resolve(assertImAdmin(ordinary)), 'ROLE_FORBIDDEN'), true)
  })

  await check('weixin-qr-login-creates-and-updates-encrypted-account', async () => {
    const accountId = `ilink-bot-${marker}`
    const first = await createWeixinBotFromLogin({
      accountId,
      accountUserId: `ilink-user-${marker}`,
      botToken: `${randomUUID()}${randomUUID()}`,
      baseUrl: 'https://ilinkai.weixin.qq.com',
    }, admin)
    botIds.push(first.id)
    assert.equal(first.platform, 'wechat')
    assert.equal(first.connectionStatus, 'connected')
    const refreshed = await createWeixinBotFromLogin({
      accountId: `${accountId}-refreshed`,
      accountUserId: `ilink-user-${marker}`,
      botToken: `${randomUUID()}${randomUUID()}`,
      baseUrl: 'https://ilinkai.weixin.qq.com',
    }, admin)
    assert.equal(refreshed.id, first.id)
    assert.equal(refreshed.config.accountId, `${accountId}-refreshed`)
  })

  const firstSecret = `${randomUUID()}${randomUUID()}`
  const successBot = await createImBot({
    platform: 'dingtalk', name: `钉钉验收-${marker}`,
    credentials: { webhookUrl: 'mock://success', inboundSecret: firstSecret },
    config: { rateLimitPerMinute: 120 }, enabled: true,
  }, admin)
  botIds.push(successBot.id)
  const failureBot = await createImBot({
    platform: 'feishu', name: `飞书验收-${marker}`,
    credentials: { webhookUrl: 'mock://failure', inboundSecret: `${randomUUID()}${randomUUID()}` },
    enabled: true,
  }, admin)
  botIds.push(failureBot.id)
  const recoveryBot = await createImBot({
    platform: 'wechat', name: `微信验收-${marker}`,
    credentials: { webhookUrl: 'mock://success', inboundSecret: `${randomUUID()}${randomUUID()}` },
    enabled: true,
  }, admin)
  botIds.push(recoveryBot.id)

  await check('credentials-encrypted-with-aad-and-list-is-masked', async () => {
    const [raw] = await db.select().from(imBots).where(eq(imBots.id, successBot.id)).limit(1)
    assert.equal(raw.credentialCiphertext.includes(firstSecret), false)
    assert.equal(decryptIntegrationCredential(raw.credentialCiphertext, raw.id).inboundSecret, firstSecret)
    assert.throws(() => decryptIntegrationCredential(raw.credentialCiphertext, failureBot.id), /无法解密/)
    const json = JSON.stringify(await listImSettings(admin))
    assert.equal(json.includes(firstSecret), false)
    assert.equal(json.includes('credentialCiphertext'), false)
    assert.equal(json.includes('credentialFingerprint'), false)
  })

  const binding = await createImBinding({
    botId: successBot.id, externalConversationId: `group-${marker}`,
    userId: ids.ordinary, projectId: ids.project, conversationId: ids.conversation,
  }, admin)
  bindingIds.push(binding.id)
  const failureBinding = await createImBinding({
    botId: failureBot.id, externalConversationId: `failure-${marker}`, userId: ids.ordinary,
  }, admin)
  bindingIds.push(failureBinding.id)
  const recoveryBinding = await createImBinding({
    botId: recoveryBot.id, externalConversationId: `recovery-${marker}`, userId: ids.ordinary,
  }, admin)
  bindingIds.push(recoveryBinding.id)

  await check('binding-requires-stable-user-project-and-conversation-match', async () => {
    assert.equal(await rejectsCode(() => createImBinding({
      botId: successBot.id, externalConversationId: `bad-${marker}`,
      userId: ids.outsider, projectId: ids.project, conversationId: ids.conversation,
    }, admin), 'IM_BINDING_CONVERSATION_INVALID'), true)
  })

  let firstOutboxId = ''
  await check('authorized-outbox-and-idempotency-conflict-boundary', async () => {
    const first = await enqueueImMessage({
      botId: successBot.id, bindingId: binding.id,
      idempotencyKey: `send-${marker}-0001`, message: '第一条验收消息',
    }, ordinary)
    firstOutboxId = first.id
    const replay = await enqueueImMessage({
      botId: successBot.id, bindingId: binding.id,
      idempotencyKey: `send-${marker}-0001`, message: '第一条验收消息',
    }, ordinary)
    assert.equal(replay.id, first.id)
    assert.equal(await rejectsCode(() => enqueueImMessage({
      botId: successBot.id, bindingId: binding.id,
      idempotencyKey: `send-${marker}-0001`, message: '不同内容',
    }, ordinary), 'IM_IDEMPOTENCY_CONFLICT'), true)
    assert.equal(await rejectsCode(() => enqueueImMessage({
      botId: successBot.id, bindingId: binding.id,
      idempotencyKey: `send-${marker}-outside`, message: '越权消息',
    }, outsider), 'IM_BINDING_FORBIDDEN'), true)
  })

  await check('outbox-success-log-rate-limit-and-finite-retry', async () => {
    await enqueueImMessage({
      botId: successBot.id, bindingId: binding.id,
      idempotencyKey: `send-${marker}-0002`, message: '第二条验收消息',
    }, ordinary)
    const firstRun = await processImOutboxBatch({ owner: `accept-${marker}`, limit: 10 })
    assert.equal(firstRun.sent, 1)
    assert.equal(firstRun.rateLimited, 1)
    // Advance only the isolated fixture timestamps instead of depending on host/DB clock jitter.
    await db.update(imDeliveryLogs).set({ createdAt: new Date(Date.now() - 2_000) })
      .where(eq(imDeliveryLogs.outboxId, firstOutboxId))
    await db.update(imOutbox).set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(and(eq(imOutbox.botId, successBot.id), eq(imOutbox.status, 'pending')))
    const secondRun = await processImOutboxBatch({ owner: `accept-${marker}-2`, limit: 10 })
    assert.equal(secondRun.sent, 1)
    const logs = await db.select().from(imDeliveryLogs).where(eq(imDeliveryLogs.outboxId, firstOutboxId))
    assert.equal(logs.length, 1)

    await enqueueImMessage({
      botId: failureBot.id, bindingId: failureBinding.id,
      idempotencyKey: `failure-${marker}`, message: '预期失败消息',
    }, ordinary)
    const failed = await processImOutboxBatch({ owner: `accept-failure-${marker}`, maxAttempts: 1 })
    assert.equal(failed.deadLetter, 1)
    const [dead] = await db.select().from(imOutbox).where(eq(imOutbox.botId, failureBot.id)).limit(1)
    assert.equal(dead.status, 'dead_letter')
    assert.equal((await processImOutboxBatch({ owner: `accept-failure-replay-${marker}`, maxAttempts: 1 })).claimed, 0)
  })

  await check('expired-sending-lease-is-recovered', async () => {
    const row = await enqueueImMessage({
      botId: recoveryBot.id, bindingId: recoveryBinding.id,
      idempotencyKey: `recovery-${marker}`, message: '租约恢复消息',
    }, ordinary)
    await db.update(imOutbox).set({
      status: 'sending', leaseOwner: 'crashed-owner', leaseExpiresAt: new Date(Date.now() - 60_000),
    }).where(eq(imOutbox.id, row.id))
    const recovered = await processImOutboxBatch({ owner: `recovery-owner-${marker}` })
    assert.equal(recovered.sent, 1)
    const [sent] = await db.select().from(imOutbox).where(eq(imOutbox.id, row.id)).limit(1)
    assert.equal(sent.status, 'sent')
  })

  await check('im-delivery-failure-isolated-from-core-and-subsequent-work', async () => {
    const [project] = await db.select().from(projects).where(eq(projects.id, ids.project)).limit(1)
    const [conversation] = await db.select().from(agentConversations)
      .where(eq(agentConversations.id, ids.conversation)).limit(1)
    const [recoveredDelivery] = await db.select().from(imOutbox)
      .where(and(eq(imOutbox.botId, recoveryBot.id), eq(imOutbox.status, 'sent'))).limit(1)
    assert.equal(project?.id, ids.project)
    assert.equal(conversation?.id, ids.conversation)
    assert.equal(recoveredDelivery?.status, 'sent')
    assert.equal((await listImSettings(admin)).bots.length >= 3, true)
  })

  await check('inbound-secret-route-and-replay-are-authorized-and-idempotent', async () => {
    assert.equal(await rejectsCode(() => routeImInboundMessage({
      botId: successBot.id, inboundSecret: `${randomUUID()}${randomUUID()}`,
      externalMessageId: `bad-secret-${marker}`, externalConversationId: `group-${marker}`, message: '不应投递',
    }, async () => undefined), 'IM_INBOUND_UNAUTHORIZED'), true)
    assert.equal(await rejectsCode(() => routeImInboundMessage({
      botId: successBot.id, inboundSecret: firstSecret,
      externalMessageId: `bad-route-${marker}`, externalConversationId: `unknown-${marker}`, message: '不应投递',
    }, async () => undefined), 'IM_INBOUND_ROUTE_FORBIDDEN'), true)
    let dispatches = 0
    const input = {
      botId: successBot.id, inboundSecret: firstSecret,
      externalMessageId: `inbound-${marker}`, externalConversationId: `group-${marker}`, message: '入站验收消息',
    }
    const first = await routeImInboundMessage(input, async (route) => {
      dispatches += 1
      assert.equal(route.userId, ids.ordinary)
      assert.equal(route.conversationId, ids.conversation)
      assert.equal(route.agentId, `im-agent-${marker}`)
    })
    assert.equal(first.status, 'dispatched')
    const replay = await routeImInboundMessage(input, async () => { dispatches += 1 })
    assert.equal(replay.duplicate, true)
    assert.equal(dispatches, 1)
  })

  await check('lead-pool-rules-reference-only-enabled-authorized-targets-and-dispatch-matched-leads', async () => {
    assert.equal(await rejectsCode(() => listLeadPushSettings(ordinary), 'ROLE_FORBIDDEN'), true)
    const settings = await listLeadPushSettings(admin)
    assert.equal(settings.targets.some((item) => item.bindingId === binding.id), true)
    const settingsJson = JSON.stringify(settings)
    assert.equal(settingsJson.includes(firstSecret), false)
    assert.equal(settingsJson.includes('credentialCiphertext'), false)
    const rule = await createLeadPushRule({
      name: `高分线索推送-${marker}`, botId: successBot.id, bindingId: binding.id,
      leadStatus: '成功', projectId: ids.project, minScore: 60,
      messageTemplate: '线索 {name} / {companyName} / {industry} / {status} / {score} / {projectName}',
    }, admin)
    ruleIds.push(rule.id)
    const task = await dispatchLeadPushRule({
      ruleId: rule.id, leadId: ids.lead, idempotencyKey: `lead-${marker}-0001`,
    }, admin)
    assert.equal(task.botId, successBot.id)
    const replay = await dispatchLeadPushRule({
      ruleId: rule.id, leadId: ids.lead, idempotencyKey: `lead-${marker}-0001`,
    }, admin)
    assert.equal(replay.id, task.id)
    const strictRule = await createLeadPushRule({
      name: `超高分线索推送-${marker}`, botId: successBot.id, bindingId: binding.id,
      leadStatus: '成功', projectId: ids.project, minScore: 90,
      messageTemplate: '{name} {score}',
    }, admin)
    ruleIds.push(strictRule.id)
    assert.equal(await rejectsCode(() => dispatchLeadPushRule({
      ruleId: strictRule.id, leadId: ids.lead, idempotencyKey: `lead-${marker}-strict`,
    }, admin), 'IM_PUSH_RULE_NOT_MATCHED'), true)
    const updated = await updateLeadPushRule(rule.id, {
      expectedVersion: rule.version, minScore: 70, enabled: true,
    }, admin)
    assert.equal(updated.minScore, 70)
  })

  await check('connection-credential-replacement-disable-impact-and-history-protection', async () => {
    const connection = await testImBotConnection(successBot.id, admin)
    assert.equal(connection.ok, true)
    const [current] = await db.select().from(imBots).where(eq(imBots.id, successBot.id)).limit(1)
    const replacementSecret = `${randomUUID()}${randomUUID()}`
    const replaced = await updateImBot(successBot.id, {
      expectedVersion: current.version,
      credentials: { webhookUrl: 'mock://success', inboundSecret: replacementSecret },
    }, admin)
    assert.equal(replaced.credentialMasked.endsWith('mock://success'.slice(-4)), true)
    assert.equal(await rejectsCode(() => updateImBot(successBot.id, {
      expectedVersion: replaced.version, enabled: false,
    }, admin), 'IM_DISABLE_CONFIRMATION_REQUIRED'), true)
    const disabled = await updateImBot(successBot.id, {
      expectedVersion: replaced.version, enabled: false, confirmDisableImpact: true,
    }, admin)
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.connectionStatus, 'disconnected')
    assert.equal(await rejectsCode(() => deleteImBinding(binding.id, admin), 'IM_BINDING_HAS_PUSH_RULE'), true)
    for (const ruleId of ruleIds) await deleteLeadPushRule(ruleId, admin)
    assert.equal(await rejectsCode(() => deleteImBinding(binding.id, admin), 'IM_BINDING_HAS_HISTORY'), true)
  })

  await check('configuration-connection-binding-and-send-actions-are-audited-without-secrets', async () => {
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.userId, ids.admin))
    const actions = new Set(rows.map((row) => row.action))
    assert.equal(actions.has('新增机器人'), true)
    assert.equal(actions.has('新增机器人绑定'), true)
    assert.equal(actions.has('测试机器人连接'), true)
    assert.equal(actions.has('替换机器人凭据'), true)
    const json = JSON.stringify(rows)
    assert.equal(json.includes(firstSecret), false)
    assert.equal(json.includes('inboundSecret'), false)
  })

  console.log(JSON.stringify({ ok: true, checks, count: checks.length }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  await db.delete(adminConfigurationRevisions).where(eq(adminConfigurationRevisions.createdBy, ids.admin)).catch(() => undefined)
  await db.delete(imInboundMessages).where(inArray(imInboundMessages.botId, botIds)).catch(() => undefined)
  if (ruleIds.length) await db.delete(imLeadPushRules).where(inArray(imLeadPushRules.id, ruleIds)).catch(() => undefined)
  const outboxRows = botIds.length
    ? await db.select({ id: imOutbox.id }).from(imOutbox).where(inArray(imOutbox.botId, botIds)).catch(() => [])
    : []
  const outboxIds = outboxRows.map((row) => row.id)
  if (outboxIds.length) await db.delete(imDeliveryLogs).where(inArray(imDeliveryLogs.outboxId, outboxIds)).catch(() => undefined)
  if (botIds.length) await db.delete(imOutbox).where(inArray(imOutbox.botId, botIds)).catch(() => undefined)
  if (bindingIds.length) await db.delete(imBotBindings).where(inArray(imBotBindings.id, bindingIds)).catch(() => undefined)
  if (botIds.length) await db.delete(imBots).where(inArray(imBots.id, botIds)).catch(() => undefined)
  await db.delete(agentConversations).where(eq(agentConversations.id, ids.conversation)).catch(() => undefined)
  await db.delete(leads).where(eq(leads.id, ids.lead)).catch(() => undefined)
  await db.delete(projects).where(eq(projects.id, ids.project)).catch(() => undefined)
  await db.delete(auditLogs).where(inArray(auditLogs.userId, [ids.admin, ids.ordinary, ids.outsider])).catch(() => undefined)
  await db.delete(users).where(inArray(users.id, [ids.admin, ids.ordinary, ids.outsider])).catch(() => undefined)
  if (original.NODE_ENV === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = original.NODE_ENV
  if (original.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY === undefined) delete process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
  else process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = original.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
  if (original.IM_SAFE_MOCK_ENABLED === undefined) delete process.env.IM_SAFE_MOCK_ENABLED
  else process.env.IM_SAFE_MOCK_ENABLED = original.IM_SAFE_MOCK_ENABLED
  await pool.end()
})
