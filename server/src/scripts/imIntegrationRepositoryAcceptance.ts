import { createHash, randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import {
  adminConfigurationRevisions, agentConversations, auditLogs, imBotBindings, imBots, imDeliveryLogs,
  imInboundMessages, imOutbox, projects, users,
} from '../db/schema.js'
import { imIntegrationRepository } from '../repositories/index.js'

async function main() {
  const marker = randomUUID()
  const userId = randomUUID()
  const projectId = randomUUID()
  const conversationId = randomUUID()
  const botId = randomUUID()
  const bindingId = randomUUID()
  const outboxIds = [randomUUID(), randomUUID()]
  const inboundIds = [randomUUID(), randomUUID()]
  const audit = (action: string, target: string, actorId = userId) => ({
    userId: actorId, userName: `IM仓储-${marker.slice(0, 8)}`, module: 'IM仓储验收', action, target,
  })
  await db.insert(users).values({
    id: userId, email: `im-repository-${marker}@example.invalid`, name: `IM仓储-${marker.slice(0, 8)}`,
    role: '系统管理员', department: 'Repository验收部', passwordHash: 'not-used',
  })
  await db.insert(projects).values({
    id: projectId, name: `IM仓储项目-${marker.slice(0, 8)}`, owner: `IM仓储-${marker.slice(0, 8)}`,
    ownerUserId: userId, createdBy: userId,
  })
  await db.insert(agentConversations).values({ id: conversationId, userId, projectId, title: 'IM仓储会话' })
  try {
    const bot = await imIntegrationRepository.createBotWithAudit({
      id: botId, platform: 'dingtalk', name: `im-repository-${marker}`,
      credentialCiphertext: 'acceptance-ciphertext', credentialHint: '••••test',
      credentialFingerprint: createHash('sha256').update(marker).digest('hex'), config: {}, enabled: true,
      connectionStatus: 'disconnected', createdBy: userId, updatedBy: userId,
    }, audit('创建机器人', botId))

    let rollbackRejected = false
    try {
      await imIntegrationRepository.updateBotWithAudit({
        botId, expectedVersion: bot.version, patch: { name: 'must-rollback', updatedBy: userId },
        confirmDisableImpact: true, updatedAt: new Date(),
        audit: audit('无效审计必须回滚', botId, randomUUID()),
      })
    } catch { rollbackRejected = true }
    const afterRollback = await imIntegrationRepository.findBot(botId)
    if (!rollbackRejected || afterRollback?.name === 'must-rollback' || afterRollback?.version !== bot.version) {
      throw new Error('bot mutation was not rolled back with failed audit')
    }

    const invalidBinding = await imIntegrationRepository.createBindingWithAudit({
      record: {
        id: randomUUID(), botId, externalConversationId: `invalid-${marker}`, userId,
        projectId, conversationId: randomUUID(), enabled: true, createdBy: userId, updatedBy: userId,
      },
      audit: audit('无效会话绑定', botId),
    })
    if (invalidBinding.status !== 'conversation_invalid') throw new Error('invalid conversation binding was accepted')

    const binding = await imIntegrationRepository.createBindingWithAudit({
      record: {
        id: bindingId, botId, externalConversationId: `group-${marker}`, userId,
        projectId, conversationId, enabled: true, createdBy: userId, updatedBy: userId,
      },
      audit: audit('创建绑定', bindingId),
    })
    if (binding.status !== 'ok') throw new Error(`binding fixture failed: ${binding.status}`)

    const payload = { message: 'repository idempotency' }
    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    const idempotencyKey = `im-repository:${marker}`
    const enqueue = (id: string) => imIntegrationRepository.enqueueMessageWithAudit({
      id, botId, bindingId, actorUserId: userId, actorIsAdmin: true, idempotencyKey, payloadHash, payload,
      successAudit: audit('创建发送任务', id), deniedAudit: audit('拒绝发送任务', id),
    })
    const enqueued = await Promise.all([enqueue(outboxIds[0]), enqueue(outboxIds[1])])
    if (enqueued.filter((item) => item.status === 'created').length !== 1
      || enqueued.filter((item) => item.status === 'existing').length !== 1) {
      throw new Error('parallel outbox idempotency did not produce one create and one replay')
    }
    const outboxId = enqueued.find((item) => 'record' in item)!.record.id

    const [claimsA, claimsB] = await Promise.all([
      imIntegrationRepository.claimOutboxBatch({ owner: `owner-a-${marker}`, limit: 1, leaseExpiresAt: new Date(Date.now() + 60_000) }),
      imIntegrationRepository.claimOutboxBatch({ owner: `owner-b-${marker}`, limit: 1, leaseExpiresAt: new Date(Date.now() + 60_000) }),
    ])
    const claims = [...claimsA, ...claimsB]
    if (claims.length !== 1 || claims[0].id !== outboxId) throw new Error('parallel SKIP LOCKED claim was not single winner')

    const wrongCompletion = await imIntegrationRepository.completeDelivery({
      outboxId, owner: 'wrong-owner', attempt: 1, ok: true, terminal: false,
      httpStatus: 200, durationMs: 1, error: null, nextAttemptAt: new Date(), completedAt: new Date(),
    })
    const logsBefore = await db.select().from(imDeliveryLogs).where(eq(imDeliveryLogs.outboxId, outboxId))
    if (wrongCompletion || logsBefore.length) throw new Error('lease-conflict completion wrote a delivery log')
    const completed = await imIntegrationRepository.completeDelivery({
      outboxId, owner: claims[0].leaseOwner, attempt: 1, ok: true, terminal: false,
      httpStatus: 200, durationMs: 2, error: null, nextAttemptAt: new Date(), completedAt: new Date(),
    })
    const [completedRow] = await db.select().from(imOutbox).where(eq(imOutbox.id, outboxId)).limit(1)
    const logsAfter = await db.select().from(imDeliveryLogs).where(eq(imDeliveryLogs.outboxId, outboxId))
    if (!completed || completedRow.status !== 'sent' || logsAfter.length !== 1) {
      throw new Error('delivery log and outbox completion did not commit atomically')
    }

    const inboundBase = {
      botId, bindingId, externalMessageId: `inbound-${marker}`, externalConversationId: `group-${marker}`,
      externalUserId: 'external-user', contentHash: payloadHash, payload, status: 'accepted', rejectionReason: null,
    }
    const inboundResults = await Promise.all([
      imIntegrationRepository.createInboundMessage({ id: inboundIds[0], ...inboundBase }),
      imIntegrationRepository.createInboundMessage({ id: inboundIds[1], ...inboundBase }),
    ])
    if (inboundResults.filter((status) => status === 'created').length !== 1
      || inboundResults.filter((status) => status === 'duplicate').length !== 1) {
      throw new Error('parallel inbound idempotency did not produce one create and one duplicate')
    }

    console.log(JSON.stringify({ ok: true, checks: [
      'bot-update-audit-failure-full-rollback',
      'binding-user-project-conversation-transaction-validation',
      'parallel-outbox-idempotency-one-create-one-replay',
      'parallel-outbox-skip-locked-single-claim',
      'delivery-log-and-outbox-atomic-completion',
      'parallel-inbound-message-idempotency-single-record',
    ] }))
  } finally {
    await db.delete(adminConfigurationRevisions).where(eq(adminConfigurationRevisions.createdBy, userId)).catch(() => undefined)
    await db.delete(imInboundMessages).where(eq(imInboundMessages.botId, botId)).catch(() => undefined)
    await db.delete(imDeliveryLogs).where(inArray(imDeliveryLogs.outboxId, outboxIds)).catch(() => undefined)
    await db.delete(imOutbox).where(eq(imOutbox.botId, botId)).catch(() => undefined)
    await db.delete(imBotBindings).where(eq(imBotBindings.botId, botId)).catch(() => undefined)
    await db.delete(imBots).where(eq(imBots.id, botId)).catch(() => undefined)
    await db.delete(auditLogs).where(eq(auditLogs.userId, userId)).catch(() => undefined)
    await db.delete(agentConversations).where(eq(agentConversations.id, conversationId)).catch(() => undefined)
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => undefined)
    await db.delete(users).where(eq(users.id, userId)).catch(() => undefined)
  }
}

await main().finally(async () => pool.end())
