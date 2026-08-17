import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import {
  agentConversations,
  adminConfigurationRevisions,
  aiCapabilities,
  aiCapabilityBindings,
  aiConversationCapabilities,
  aiModelProviders,
  aiModelRoutes,
  aiModels,
  auditLogs,
  projects,
  users,
} from '../db/schema.js'
import { aiConfigurationRepository } from '../repositories/index.js'

async function main() {
  const marker = randomUUID()
  const userId = randomUUID()
  const projectId = randomUUID()
  const conversationId = randomUUID()
  const providerId = randomUUID()
  const modelIds = [randomUUID(), randomUUID()]
  const capabilityId = randomUUID()
  const globalBindingId = randomUUID()
  const projectBindingId = randomUUID()
  const audit = (action: string, target: string, overrideUserId = userId) => ({
    userId: overrideUserId,
    userName: `配置仓储-${marker.slice(0, 8)}`,
    module: '配置仓储验收',
    action,
    target,
  })

  await db.insert(users).values({
    id: userId,
    email: `ai-configuration-repository-${marker}@example.invalid`,
    name: `配置仓储-${marker.slice(0, 8)}`,
    role: '系统管理员',
    department: 'Repository验收部',
    passwordHash: 'not-used-by-repository-acceptance',
  })
  await db.insert(projects).values({
    id: projectId,
    name: `配置仓储项目-${marker.slice(0, 8)}`,
    owner: `配置仓储-${marker.slice(0, 8)}`,
    ownerUserId: userId,
    createdBy: userId,
  })
  await db.insert(agentConversations).values({
    id: conversationId,
    userId,
    projectId,
    title: '配置仓储会话',
  })

  try {
    const provider = await aiConfigurationRepository.createProviderWithAudit({
      id: providerId,
      name: `repository-provider-${marker}`,
      protocol: 'openai-compatible',
      baseUrl: 'https://repository.invalid/v1',
      credentialCiphertext: 'acceptance-ciphertext',
      credentialHint: '••••test',
      credentialFingerprint: marker.replaceAll('-', '').slice(0, 64),
      timeoutMs: 10_000,
      enabled: true,
      createdBy: userId,
      updatedBy: userId,
    }, audit('创建 Provider', providerId))

    const invalidAuditUser = randomUUID()
    let auditRollbackRejected = false
    try {
      await aiConfigurationRepository.updateProviderWithAudit({
        providerId,
        expectedVersion: provider.version,
        patch: { name: 'must-rollback', updatedBy: userId },
        updatedAt: new Date(),
        audit: audit('无效审计应回滚', providerId, invalidAuditUser),
      })
    } catch {
      auditRollbackRejected = true
    }
    const providerAfterRollback = await aiConfigurationRepository.findProvider(providerId)
    if (!auditRollbackRejected || providerAfterRollback?.name === 'must-rollback' || providerAfterRollback?.version !== provider.version) {
      throw new Error('provider update was not rolled back when audit insertion failed')
    }

    for (const [index, modelId] of modelIds.entries()) {
      const created = await aiConfigurationRepository.createModelWithAudit({
        record: {
          id: modelId,
          providerId,
          modelKey: `repository-model-${marker}-${index}`,
          displayName: `配置仓储模型 ${index}`,
          contextWindow: 8_192,
          capabilityTags: ['chat'],
          allowedRoles: [],
          enabled: true,
          isDefault: false,
          createdBy: userId,
          updatedBy: userId,
        },
        audit: audit('创建模型', modelId),
        updatedAt: new Date(),
      })
      if (created.status !== 'ok') throw new Error('model fixture provider was not found')
    }
    const defaultResults = await Promise.all(modelIds.map((modelId) => aiConfigurationRepository.updateModelWithAudit({
      modelId,
      expectedVersion: 1,
      patch: { isDefault: true, updatedBy: userId },
      updatedAt: new Date(),
      audit: audit('并发设置默认模型', modelId),
    })))
    if (defaultResults.some((result) => result.status !== 'ok')) throw new Error('parallel default updates did not complete')
    const defaultRows = await db.select({ id: aiModels.id }).from(aiModels).where(and(
      inArray(aiModels.id, modelIds), eq(aiModels.isDefault, true),
    ))
    if (defaultRows.length !== 1) throw new Error('parallel default updates left multiple default models')

    const auditsBeforeInvalidRoute = await db.select({ id: auditLogs.id }).from(auditLogs)
      .where(eq(auditLogs.userId, userId))
    const invalidRoute = await aiConfigurationRepository.upsertRouteWithAudit({
      profileKey: `repository-${marker}`,
      modelId: randomUUID(),
      fallbackModelId: null,
      enabled: true,
      updatedBy: userId,
      createAudit: audit('创建无效路由', marker),
      updateAudit: audit('更新无效路由', marker),
      updatedAt: new Date(),
    })
    const auditsAfterInvalidRoute = await db.select({ id: auditLogs.id }).from(auditLogs)
      .where(eq(auditLogs.userId, userId))
    if (invalidRoute.status !== 'model_not_found' || auditsAfterInvalidRoute.length !== auditsBeforeInvalidRoute.length) {
      throw new Error('invalid model route created an audit or route mutation')
    }

    await aiConfigurationRepository.ensureBuiltinCapabilities([{
      capabilityId,
      globalBindingId,
      kind: 'skill',
      capabilityKey: `repository-skill-${marker}`,
      name: '配置仓储能力',
      description: 'Repository acceptance fixture',
      packageVersion: 'acceptance-v1',
      config: {},
      toolNames: [],
      dependencyNames: [],
    }])
    const capability = await aiConfigurationRepository.findCapability(capabilityId)
    if (!capability) throw new Error('capability fixture was not created')
    const updatedCapability = await aiConfigurationRepository.updateCapabilityWithAudit({
      capabilityId,
      expectedVersion: capability.version,
      patch: { enabled: false, updatedBy: userId },
      updatedAt: new Date(),
      audit: audit('停用能力', capabilityId),
    })
    const staleCapability = await aiConfigurationRepository.updateCapabilityWithAudit({
      capabilityId,
      expectedVersion: capability.version,
      patch: { enabled: true, updatedBy: userId },
      updatedAt: new Date(),
      audit: audit('过期版本不应写审计', capabilityId),
    })
    if (updatedCapability.status !== 'ok' || staleCapability.status !== 'conflict') {
      throw new Error('capability optimistic version boundary failed')
    }

    const binding = await aiConfigurationRepository.createCapabilityBindingWithAudit({
      record: {
        id: projectBindingId,
        capabilityId,
        scopeType: 'project',
        scopeKey: projectId,
        department: null,
        projectId,
        enabled: true,
        createdBy: userId,
        updatedBy: userId,
      },
      audit: audit('创建项目能力授权', projectBindingId),
    })
    const toggled = await aiConfigurationRepository.updateCapabilityBindingWithAudit({
      bindingId: projectBindingId,
      expectedVersion: binding.version,
      enabled: false,
      updatedBy: userId,
      updatedAt: new Date(),
      audit: audit('停用项目能力授权', projectBindingId),
    })
    const staleBinding = await aiConfigurationRepository.updateCapabilityBindingWithAudit({
      bindingId: projectBindingId,
      expectedVersion: binding.version,
      enabled: true,
      updatedBy: userId,
      updatedAt: new Date(),
      audit: audit('过期授权不应写审计', projectBindingId),
    })
    if (toggled.status !== 'ok' || staleBinding.status !== 'conflict') {
      throw new Error('capability binding optimistic version boundary failed')
    }

    await aiConfigurationRepository.replaceConversationCapabilities({
      conversationId,
      userId,
      capabilityIds: [capabilityId],
    })
    if ((await aiConfigurationRepository.listConversationCapabilityIds(conversationId, userId)).join() !== capabilityId) {
      throw new Error('conversation capability replacement did not commit')
    }
    await aiConfigurationRepository.replaceConversationCapabilities({ conversationId, userId, capabilityIds: [] })
    if ((await aiConfigurationRepository.listConversationCapabilityIds(conversationId, userId)).length) {
      throw new Error('conversation capability clear did not commit')
    }

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'provider-update-audit-failure-full-rollback',
        'parallel-default-model-single-winner-state',
        'invalid-route-reference-no-audit-or-mutation',
        'capability-optimistic-update-and-audit-transaction',
        'capability-binding-optimistic-update-and-audit-transaction',
        'conversation-capability-atomic-replacement',
      ],
    }))
  } finally {
    await db.delete(adminConfigurationRevisions).where(eq(adminConfigurationRevisions.createdBy, userId)).catch(() => undefined)
    await db.delete(aiConversationCapabilities).where(eq(aiConversationCapabilities.conversationId, conversationId)).catch(() => undefined)
    await db.delete(aiCapabilityBindings).where(inArray(aiCapabilityBindings.id, [globalBindingId, projectBindingId])).catch(() => undefined)
    await db.delete(aiCapabilities).where(eq(aiCapabilities.id, capabilityId)).catch(() => undefined)
    await db.delete(aiModelRoutes).where(eq(aiModelRoutes.profileKey, `repository-${marker}`)).catch(() => undefined)
    await db.delete(aiModels).where(inArray(aiModels.id, modelIds)).catch(() => undefined)
    await db.delete(aiModelProviders).where(eq(aiModelProviders.id, providerId)).catch(() => undefined)
    await db.delete(auditLogs).where(eq(auditLogs.userId, userId)).catch(() => undefined)
    await db.delete(agentConversations).where(eq(agentConversations.id, conversationId)).catch(() => undefined)
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => undefined)
    await db.delete(users).where(eq(users.id, userId)).catch(() => undefined)
  }
}

await main().finally(async () => pool.end())
