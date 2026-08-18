import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import {
  aiCapabilities,
  aiCapabilityBindings,
  aiConversationCapabilities,
  adminConfigurationRevisions,
  aiModelProviders,
  aiModelRoutes,
  aiModels,
  auditLogs,
  projects,
} from '../../db/schema.js'
import type {
  AiConfigurationRepository,
  AiModelProviderRecord,
  AiModelRecord,
} from '../aiConfigurationRepository.js'
import { isMySqlDriverError, isRepositoryError, mapMySqlRepositoryError } from '../contracts.js'
import type { AuditRecord } from '../identityRepository.js'
import { configurationRevisionValues } from './configurationRevision.js'

export type MySqlAiConfigurationExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function mapped<T>(operation: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (isRepositoryError(error)) throw error
    if (isMySqlDriverError(error)) throw mapMySqlRepositoryError(error, operation)
    throw error
  }
}

async function lockDefaultModelDomain(tx: MySqlAiConfigurationExecutor) {
  await tx.execute(sql`SELECT ${aiModelProviders.id} FROM ${aiModelProviders} ORDER BY ${aiModelProviders.id} FOR UPDATE`)
}

class MySqlAiConfigurationRepository implements AiConfigurationRepository {
  constructor(private readonly executor: MySqlAiConfigurationExecutor) {}

  async listModelSettings() {
    return mapped('aiConfiguration.listModelSettings', async () => {
      const [providers, models, routes] = await Promise.all([
        this.executor.select().from(aiModelProviders).orderBy(asc(aiModelProviders.name)),
        this.executor.select().from(aiModels).orderBy(asc(aiModels.displayName)),
        this.executor.select().from(aiModelRoutes).orderBy(asc(aiModelRoutes.profileKey)),
      ])
      return { providers, models, routes }
    })
  }

  async createProviderWithAudit(
    input: Omit<AiModelProviderRecord,
      'version' | 'lastTestStatus' | 'lastTestError' | 'lastTestLatencyMs' | 'lastTestTraceId'
      | 'lastTestAt' | 'createdAt' | 'updatedAt'>,
    audit: AuditRecord,
  ) {
    return mapped('aiConfiguration.createProviderWithAudit', () => db.transaction(async (tx) => {
      await tx.insert(aiModelProviders).values(input)
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'model', resourceType: 'provider', resourceId: input.id,
        operation: 'create', sourceVersion: 0, snapshot: null, createdBy: audit.userId,
      }))
      await tx.insert(auditLogs).values(audit)
      const [created] = await tx.select().from(aiModelProviders).where(eq(aiModelProviders.id, input.id)).limit(1)
      if (!created) throw new Error('model provider cannot be reloaded after creation')
      return created
    }))
  }

  async updateProviderWithAudit(input: Parameters<AiConfigurationRepository['updateProviderWithAudit']>[0]) {
    return mapped('aiConfiguration.updateProviderWithAudit', () => db.transaction(async (tx) => {
      const [existing] = await tx.select().from(aiModelProviders)
        .where(eq(aiModelProviders.id, input.providerId)).limit(1)
      if (!existing) return { status: 'not_found' as const }
      const [result] = await tx.update(aiModelProviders).set({
        ...input.patch,
        updatedAt: input.updatedAt,
        version: sql`${aiModelProviders.version} + 1`,
      }).where(and(
        eq(aiModelProviders.id, input.providerId),
        eq(aiModelProviders.version, input.expectedVersion),
      ))
      if (result.affectedRows !== 1) return { status: 'conflict' as const }
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'model', resourceType: 'provider', resourceId: input.providerId,
        operation: 'update', sourceVersion: existing.version, snapshot: { ...existing }, createdBy: input.audit.userId,
      }))
      await tx.insert(auditLogs).values(input.audit)
      const [record] = await tx.select().from(aiModelProviders)
        .where(eq(aiModelProviders.id, input.providerId)).limit(1)
      return { status: 'ok' as const, record }
    }))
  }

  async deleteProviderWithAudit(input: Parameters<AiConfigurationRepository['deleteProviderWithAudit']>[0]) {
    return mapped('aiConfiguration.deleteProviderWithAudit', () => db.transaction(async (tx) => {
      const [existing] = await tx.select().from(aiModelProviders)
        .where(eq(aiModelProviders.id, input.providerId)).limit(1).for('update')
      if (!existing) return 'not_found' as const
      if (existing.version !== input.expectedVersion) return 'conflict' as const
      const models = await tx.select({ id: aiModels.id }).from(aiModels)
        .where(eq(aiModels.providerId, input.providerId)).limit(1)
      if (models.length) return 'has_models' as const
      const [result] = await tx.delete(aiModelProviders).where(and(
        eq(aiModelProviders.id, input.providerId),
        eq(aiModelProviders.version, input.expectedVersion),
      ))
      if (result.affectedRows !== 1) return 'conflict' as const
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'model', resourceType: 'provider', resourceId: input.providerId,
        operation: 'delete', sourceVersion: existing.version, snapshot: { ...existing }, createdBy: input.audit.userId,
      }))
      await tx.insert(auditLogs).values(input.audit)
      return 'ok' as const
    }))
  }

  async createModelWithAudit(input: Parameters<AiConfigurationRepository['createModelWithAudit']>[0]) {
    return mapped('aiConfiguration.createModelWithAudit', () => db.transaction(async (tx) => {
      const [provider] = await tx.select({ id: aiModelProviders.id }).from(aiModelProviders)
        .where(eq(aiModelProviders.id, input.record.providerId)).limit(1)
      if (!provider) return { status: 'provider_not_found' as const }
      if (input.record.isDefault) {
        await lockDefaultModelDomain(tx)
        const previousDefaults = await tx.select().from(aiModels).where(eq(aiModels.isDefault, true))
        for (const previous of previousDefaults) {
          await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
            domain: 'model', resourceType: 'model', resourceId: previous.id,
            operation: 'update', sourceVersion: previous.version, snapshot: { ...previous }, createdBy: input.audit.userId,
          }))
          await tx.update(aiModels).set({
            isDefault: false, updatedBy: input.audit.userId, updatedAt: input.updatedAt,
            version: sql`${aiModels.version} + 1`,
          }).where(and(eq(aiModels.id, previous.id), eq(aiModels.version, previous.version)))
        }
      }
      await tx.insert(aiModels).values(input.record)
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'model', resourceType: 'model', resourceId: input.record.id,
        operation: 'create', sourceVersion: 0, snapshot: null, createdBy: input.audit.userId,
      }))
      await tx.insert(auditLogs).values(input.audit)
      const [record] = await tx.select().from(aiModels).where(eq(aiModels.id, input.record.id)).limit(1)
      return { status: 'ok' as const, record }
    }))
  }

  async updateModelWithAudit(input: Parameters<AiConfigurationRepository['updateModelWithAudit']>[0]) {
    return mapped('aiConfiguration.updateModelWithAudit', () => db.transaction(async (tx) => {
      if (input.patch.isDefault) await lockDefaultModelDomain(tx)
      const [existing] = await tx.select().from(aiModels)
        .where(eq(aiModels.id, input.modelId)).limit(1).for('update')
      if (!existing) return { status: 'not_found' as const }
      if (existing.version !== input.expectedVersion) return { status: 'conflict' as const }
      if (input.patch.providerId) {
        const [provider] = await tx.select({ id: aiModelProviders.id }).from(aiModelProviders)
          .where(eq(aiModelProviders.id, input.patch.providerId)).limit(1)
        if (!provider) return { status: 'provider_not_found' as const }
      }
      if (input.patch.isDefault) {
        const previousDefaults = await tx.select().from(aiModels)
          .where(and(eq(aiModels.isDefault, true), sql`${aiModels.id} <> ${input.modelId}`))
        for (const previous of previousDefaults) {
          await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
            domain: 'model', resourceType: 'model', resourceId: previous.id,
            operation: 'update', sourceVersion: previous.version, snapshot: { ...previous }, createdBy: input.audit.userId,
          }))
          await tx.update(aiModels).set({
            isDefault: false, updatedBy: input.audit.userId, updatedAt: input.updatedAt,
            version: sql`${aiModels.version} + 1`,
          }).where(and(eq(aiModels.id, previous.id), eq(aiModels.version, previous.version)))
        }
      }
      const [result] = await tx.update(aiModels).set({
        ...input.patch,
        updatedAt: input.updatedAt,
        version: sql`${aiModels.version} + 1`,
      }).where(and(eq(aiModels.id, input.modelId), eq(aiModels.version, input.expectedVersion)))
      if (result.affectedRows !== 1) return { status: 'conflict' as const }
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'model', resourceType: 'model', resourceId: input.modelId,
        operation: 'update', sourceVersion: existing.version, snapshot: { ...existing }, createdBy: input.audit.userId,
      }))
      await tx.insert(auditLogs).values(input.audit)
      const [record] = await tx.select().from(aiModels).where(eq(aiModels.id, input.modelId)).limit(1)
      return { status: 'ok' as const, record }
    }))
  }

  async deleteModelWithAudit(input: Parameters<AiConfigurationRepository['deleteModelWithAudit']>[0]) {
    return mapped('aiConfiguration.deleteModelWithAudit', () => db.transaction(async (tx) => {
      const [existing] = await tx.select().from(aiModels)
        .where(eq(aiModels.id, input.modelId)).limit(1).for('update')
      if (!existing) return 'not_found' as const
      if (existing.version !== input.expectedVersion) return 'conflict' as const
      const references = await tx.select({ profileKey: aiModelRoutes.profileKey }).from(aiModelRoutes)
        .where(or(eq(aiModelRoutes.modelId, input.modelId), eq(aiModelRoutes.fallbackModelId, input.modelId))).limit(1)
      if (references.length) return 'referenced' as const

      let replacement: typeof existing | undefined
      if (existing.isDefault) {
        await lockDefaultModelDomain(tx)
        const [candidate] = await tx.select().from(aiModels)
          .where(and(eq(aiModels.enabled, true), sql`${aiModels.id} <> ${input.modelId}`))
          .orderBy(asc(aiModels.displayName)).limit(1).for('update')
        replacement = candidate
        if (replacement) {
          await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
            domain: 'model', resourceType: 'model', resourceId: replacement.id,
            operation: 'update', sourceVersion: replacement.version, snapshot: { ...replacement }, createdBy: input.audit.userId,
          }))
          await tx.update(aiModels).set({
            isDefault: true, updatedBy: input.audit.userId, updatedAt: new Date(),
            version: sql`${aiModels.version} + 1`,
          }).where(and(eq(aiModels.id, replacement.id), eq(aiModels.version, replacement.version)))
        }
      }

      const [result] = await tx.delete(aiModels).where(and(
        eq(aiModels.id, input.modelId),
        eq(aiModels.version, input.expectedVersion),
      ))
      if (result.affectedRows !== 1) return 'conflict' as const
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'model', resourceType: 'model', resourceId: input.modelId,
        operation: 'delete', sourceVersion: existing.version, snapshot: { ...existing }, createdBy: input.audit.userId,
      }))
      await tx.insert(auditLogs).values(input.audit)
      return 'ok' as const
    }))
  }

  async upsertRouteWithAudit(input: Parameters<AiConfigurationRepository['upsertRouteWithAudit']>[0]) {
    return mapped('aiConfiguration.upsertRouteWithAudit', () => db.transaction(async (tx) => {
      const ids = [input.modelId, input.fallbackModelId].filter(Boolean) as string[]
      const rows = await tx.select({ id: aiModels.id }).from(aiModels).where(inArray(aiModels.id, ids))
      if (rows.length !== ids.length) return { status: 'model_not_found' as const }
      const [existing] = await tx.select().from(aiModelRoutes)
        .where(eq(aiModelRoutes.profileKey, input.profileKey)).limit(1)
      if (existing && input.expectedVersion !== existing.version) return { status: 'conflict' as const }
      await tx.insert(aiModelRoutes).values({
        profileKey: input.profileKey,
        modelId: input.modelId,
        fallbackModelId: input.fallbackModelId,
        enabled: input.enabled,
        updatedBy: input.updatedBy,
      }).onDuplicateKeyUpdate({ set: {
        modelId: input.modelId,
        fallbackModelId: input.fallbackModelId,
        enabled: input.enabled,
        updatedBy: input.updatedBy,
        updatedAt: input.updatedAt,
        version: sql`${aiModelRoutes.version} + 1`,
      } })
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'model', resourceType: 'route', resourceId: input.profileKey,
        operation: existing ? 'update' : 'create', sourceVersion: existing?.version ?? 0,
        snapshot: existing ? { ...existing } : null, createdBy: input.updatedBy,
      }))
      await tx.insert(auditLogs).values(existing ? input.updateAudit : input.createAudit)
      const [record] = await tx.select().from(aiModelRoutes)
        .where(eq(aiModelRoutes.profileKey, input.profileKey)).limit(1)
      return { status: 'ok' as const, record }
    }))
  }

  async listEnabledModelsWithProviders() {
    return mapped('aiConfiguration.listEnabledModelsWithProviders', () => this.executor.select({
      model: aiModels,
      provider: aiModelProviders,
    }).from(aiModels).innerJoin(aiModelProviders, eq(aiModelProviders.id, aiModels.providerId))
      .where(and(eq(aiModels.enabled, true), eq(aiModelProviders.enabled, true)))
      .orderBy(asc(aiModels.displayName)))
  }

  async findModelWithProvider(modelId: string) {
    return mapped('aiConfiguration.findModelWithProvider', async () => {
      const [row] = await this.executor.select({ model: aiModels, provider: aiModelProviders })
        .from(aiModels).innerJoin(aiModelProviders, eq(aiModelProviders.id, aiModels.providerId))
        .where(eq(aiModels.id, modelId)).limit(1)
      return row ?? null
    })
  }

  async findEnabledRoute(profileKey: string) {
    return mapped('aiConfiguration.findEnabledRoute', async () => {
      const [row] = await this.executor.select().from(aiModelRoutes).where(and(
        eq(aiModelRoutes.profileKey, profileKey), eq(aiModelRoutes.enabled, true),
      )).limit(1)
      return row ?? null
    })
  }

  async findDefaultEnabledModelId() {
    return mapped('aiConfiguration.findDefaultEnabledModelId', async () => {
      const [row] = await this.executor.select({ id: aiModels.id }).from(aiModels)
        .where(and(eq(aiModels.enabled, true), eq(aiModels.isDefault, true))).limit(1)
      return row?.id ?? null
    })
  }

  async findEnabledModelIdsByKey(modelKey: string, limit = 2) {
    return mapped('aiConfiguration.findEnabledModelIdsByKey', async () => {
      const rows = await this.executor.select({ id: aiModels.id }).from(aiModels)
        .where(and(eq(aiModels.modelKey, modelKey), eq(aiModels.enabled, true)))
        .limit(Math.max(1, Math.min(10, Math.trunc(limit))))
      return rows.map((row) => row.id)
    })
  }

  async findProvider(providerId: string) {
    return mapped('aiConfiguration.findProvider', async () => {
      const [row] = await this.executor.select().from(aiModelProviders)
        .where(eq(aiModelProviders.id, providerId)).limit(1)
      return row ?? null
    })
  }

  async recordProviderTestWithAudit(input: Parameters<AiConfigurationRepository['recordProviderTestWithAudit']>[0]) {
    await mapped('aiConfiguration.recordProviderTestWithAudit', () => db.transaction(async (tx) => {
      await tx.update(aiModelProviders).set({
        lastTestStatus: input.ok ? 'succeeded' : 'failed',
        lastTestError: input.error,
        lastTestLatencyMs: input.latencyMs,
        lastTestTraceId: input.traceId,
        lastTestAt: input.testedAt,
        updatedAt: input.testedAt,
      }).where(eq(aiModelProviders.id, input.providerId))
      await tx.insert(auditLogs).values(input.audit)
    }))
  }

  async ensureBuiltinCapabilities(items: Parameters<AiConfigurationRepository['ensureBuiltinCapabilities']>[0]) {
    await mapped('aiConfiguration.ensureBuiltinCapabilities', () => db.transaction(async (tx) => {
      for (const item of items) {
        const [existing] = await tx.select({ id: aiCapabilities.id, source: aiCapabilities.source }).from(aiCapabilities).where(and(
          eq(aiCapabilities.kind, item.kind), eq(aiCapabilities.capabilityKey, item.capabilityKey),
        )).limit(1)
        // 管理员删除的内置能力保留为隐藏 tombstone，避免服务重启时被自动安装回来。
        // “同步内置目录”仍可显式恢复它。
        if (existing?.source === 'deleted') continue
        const capabilityId = existing?.id ?? item.capabilityId
        if (!existing) await tx.insert(aiCapabilities).values({
          id: capabilityId,
          kind: item.kind,
          capabilityKey: item.capabilityKey,
          name: item.name,
          description: item.description,
          source: 'builtin',
          packageVersion: item.packageVersion,
          config: item.config,
          toolNames: item.toolNames,
          dependencyNames: item.dependencyNames,
          allowedRoles: [],
        })
        const [binding] = await tx.select({ id: aiCapabilityBindings.id }).from(aiCapabilityBindings).where(and(
          eq(aiCapabilityBindings.capabilityId, capabilityId),
          eq(aiCapabilityBindings.scopeType, 'global'),
          eq(aiCapabilityBindings.scopeKey, '*'),
        )).limit(1)
        if (!binding) await tx.insert(aiCapabilityBindings).values({
          id: item.globalBindingId,
          capabilityId,
          scopeType: 'global',
          scopeKey: '*',
          enabled: true,
        })
      }
    }))
  }

  async syncBuiltinCapabilitiesWithAudit(
    input: Parameters<AiConfigurationRepository['syncBuiltinCapabilitiesWithAudit']>[0],
  ) {
    return mapped('aiConfiguration.syncBuiltinCapabilitiesWithAudit', () => db.transaction(async (tx) => {
      const existingByKey = new Map<string, typeof aiCapabilities.$inferSelect>()
      for (const item of input.items) {
        await tx.execute(sql`SELECT ${aiCapabilities.id} FROM ${aiCapabilities} WHERE ${aiCapabilities.kind}=${item.kind} AND ${aiCapabilities.capabilityKey}=${item.capabilityKey} FOR UPDATE`)
        const [existing] = await tx.select().from(aiCapabilities).where(and(
          eq(aiCapabilities.kind, item.kind), eq(aiCapabilities.capabilityKey, item.capabilityKey),
        )).limit(1)
        if (existing) {
          const restoringDeletedBuiltin = existing.source === 'deleted' && item.expectedVersion === undefined
          if (!restoringDeletedBuiltin && (item.expectedVersion === undefined || existing.version !== item.expectedVersion)) return 'conflict' as const
          existingByKey.set(`${item.kind}:${item.capabilityKey}`, existing)
        }
      }
      for (const item of input.items) {
        const existing = existingByKey.get(`${item.kind}:${item.capabilityKey}`)
        const capabilityId = existing?.id ?? item.capabilityId
        if (existing) {
          await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
            domain: 'capability', resourceType: 'capability', resourceId: existing.id,
            operation: 'update', sourceVersion: existing.version, snapshot: { ...existing }, createdBy: input.actorUserId,
          }))
          await tx.update(aiCapabilities).set({
            name: item.name,
            description: item.description,
            source: 'builtin',
            ...(existing.source === 'deleted' ? { enabled: true } : {}),
            packageVersion: item.packageVersion,
            config: item.config,
            toolNames: item.toolNames,
            dependencyNames: item.dependencyNames,
            updatedBy: input.actorUserId,
            updatedAt: input.updatedAt,
            version: sql`${aiCapabilities.version} + 1`,
          }).where(and(eq(aiCapabilities.id, existing.id), eq(aiCapabilities.version, existing.version)))
        } else {
          await tx.insert(aiCapabilities).values({
            id: capabilityId,
            kind: item.kind,
            capabilityKey: item.capabilityKey,
            name: item.name,
            description: item.description,
            source: 'builtin',
            packageVersion: item.packageVersion,
            config: item.config,
            toolNames: item.toolNames,
            dependencyNames: item.dependencyNames,
            allowedRoles: [],
            createdBy: input.actorUserId,
            updatedBy: input.actorUserId,
          })
          await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
            domain: 'capability', resourceType: 'capability', resourceId: capabilityId,
            operation: 'create', sourceVersion: 0, snapshot: null, createdBy: input.actorUserId,
          }))
        }
        const [binding] = await tx.select({ id: aiCapabilityBindings.id }).from(aiCapabilityBindings).where(and(
          eq(aiCapabilityBindings.capabilityId, capabilityId),
          eq(aiCapabilityBindings.scopeType, 'global'),
          eq(aiCapabilityBindings.scopeKey, '*'),
        )).limit(1)
        if (!binding) await tx.insert(aiCapabilityBindings).values({
          id: item.globalBindingId,
          capabilityId,
          scopeType: 'global',
          scopeKey: '*',
          enabled: true,
          createdBy: input.actorUserId,
          updatedBy: input.actorUserId,
        })
        if (!binding) await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
          domain: 'capability', resourceType: 'capability_binding', resourceId: item.globalBindingId,
          operation: 'create', sourceVersion: 0, snapshot: null, createdBy: input.actorUserId,
        }))
      }
      await tx.insert(auditLogs).values(input.audit)
      return 'ok' as const
    }))
  }

  async listCapabilitySettings() {
    return mapped('aiConfiguration.listCapabilitySettings', async () => {
      const [capabilities, bindings, projectRows] = await Promise.all([
        this.executor.select().from(aiCapabilities).where(ne(aiCapabilities.source, 'deleted'))
          .orderBy(asc(aiCapabilities.kind), asc(aiCapabilities.name)),
        this.executor.select().from(aiCapabilityBindings)
          .orderBy(asc(aiCapabilityBindings.scopeType), asc(aiCapabilityBindings.scopeKey)),
        this.executor.select({ id: projects.id, name: projects.name }).from(projects).orderBy(asc(projects.name)),
      ])
      return { capabilities, bindings, projects: projectRows }
    })
  }

  async findCapability(capabilityId: string) {
    return mapped('aiConfiguration.findCapability', async () => {
      const [record] = await this.executor.select().from(aiCapabilities)
        .where(and(eq(aiCapabilities.id, capabilityId), ne(aiCapabilities.source, 'deleted'))).limit(1)
      return record ?? null
    })
  }

  async findBuiltinCapability(kind: string, capabilityKey: string) {
    return mapped('aiConfiguration.findBuiltinCapability', async () => {
      const [record] = await this.executor.select().from(aiCapabilities).where(and(
        eq(aiCapabilities.kind, kind),
        eq(aiCapabilities.capabilityKey, capabilityKey),
        eq(aiCapabilities.source, 'builtin'),
      )).limit(1)
      return record ?? null
    })
  }

  async installUploadedPluginWithAudit(input: Parameters<AiConfigurationRepository['installUploadedPluginWithAudit']>[0]) {
    return mapped('aiConfiguration.installUploadedPluginWithAudit', () => db.transaction(async (tx) => {
      const [existing] = await tx.select().from(aiCapabilities).where(and(
        eq(aiCapabilities.kind, 'plugin'), eq(aiCapabilities.capabilityKey, input.record.capabilityKey),
      )).limit(1).for('update')

      if (existing) {
        await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
          domain: 'capability', resourceType: 'capability', resourceId: existing.id,
          operation: 'update', sourceVersion: existing.version, snapshot: { ...existing }, createdBy: input.audit.userId,
        }))
        await tx.update(aiCapabilities).set({
          name: input.record.name,
          description: input.record.description,
          source: 'uploaded',
          packageVersion: input.record.packageVersion,
          config: input.record.config,
          toolNames: input.record.toolNames,
          dependencyNames: input.record.dependencyNames,
          allowedRoles: input.record.allowedRoles,
          enabled: true,
          updatedBy: input.record.updatedBy,
          updatedAt: input.updatedAt,
          version: sql`${aiCapabilities.version} + 1`,
        }).where(eq(aiCapabilities.id, existing.id))
      } else {
        await tx.insert(aiCapabilities).values({
          ...input.record,
          source: 'uploaded',
          enabled: true,
        })
        await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
          domain: 'capability', resourceType: 'capability', resourceId: input.record.id,
          operation: 'create', sourceVersion: 0, snapshot: null, createdBy: input.audit.userId,
        }))
      }

      const capabilityId = existing?.id ?? input.record.id
      const [binding] = await tx.select({ id: aiCapabilityBindings.id }).from(aiCapabilityBindings).where(and(
        eq(aiCapabilityBindings.capabilityId, capabilityId),
        eq(aiCapabilityBindings.scopeType, 'global'),
        eq(aiCapabilityBindings.scopeKey, '*'),
      )).limit(1)
      if (!binding) {
        await tx.insert(aiCapabilityBindings).values({
          id: input.globalBindingId, capabilityId, scopeType: 'global', scopeKey: '*', enabled: true,
          createdBy: input.audit.userId, updatedBy: input.audit.userId,
        })
        await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
          domain: 'capability', resourceType: 'capability_binding', resourceId: input.globalBindingId,
          operation: 'create', sourceVersion: 0, snapshot: null, createdBy: input.audit.userId,
        }))
      }
      await tx.insert(auditLogs).values(input.audit)
      const [record] = await tx.select().from(aiCapabilities).where(eq(aiCapabilities.id, capabilityId)).limit(1)
      if (!record) throw new Error('uploaded plugin cannot be reloaded after installation')
      return record
    }))
  }

  async updateCapabilityWithAudit(input: Parameters<AiConfigurationRepository['updateCapabilityWithAudit']>[0]) {
    return mapped('aiConfiguration.updateCapabilityWithAudit', () => db.transaction(async (tx) => {
      const [existing] = await tx.select().from(aiCapabilities)
        .where(eq(aiCapabilities.id, input.capabilityId)).limit(1)
      if (!existing) return { status: 'not_found' as const }
      const [result] = await tx.update(aiCapabilities).set({
        ...input.patch,
        updatedAt: input.updatedAt,
        version: sql`${aiCapabilities.version} + 1`,
      }).where(and(
        eq(aiCapabilities.id, input.capabilityId),
        eq(aiCapabilities.version, input.expectedVersion),
      ))
      if (result.affectedRows !== 1) return { status: 'conflict' as const }
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'capability', resourceType: 'capability', resourceId: input.capabilityId,
        operation: 'update', sourceVersion: existing.version, snapshot: { ...existing }, createdBy: input.audit.userId,
      }))
      await tx.insert(auditLogs).values(input.audit)
      const [record] = await tx.select().from(aiCapabilities)
        .where(eq(aiCapabilities.id, input.capabilityId)).limit(1)
      return { status: 'ok' as const, record }
    }))
  }

  async deleteCapabilityWithAudit(input: Parameters<AiConfigurationRepository['deleteCapabilityWithAudit']>[0]) {
    return mapped('aiConfiguration.deleteCapabilityWithAudit', () => db.transaction(async (tx) => {
      const [existing] = await tx.select().from(aiCapabilities)
        .where(eq(aiCapabilities.id, input.capabilityId)).limit(1)
      if (!existing) return 'not_found' as const
      const [result] = existing.source === 'builtin'
        ? await tx.update(aiCapabilities).set({
          source: 'deleted', enabled: false, updatedBy: input.audit.userId, updatedAt: new Date(),
          version: sql`${aiCapabilities.version} + 1`,
        }).where(and(
          eq(aiCapabilities.id, input.capabilityId),
          eq(aiCapabilities.version, input.expectedVersion),
        ))
        : await tx.delete(aiCapabilities).where(and(
          eq(aiCapabilities.id, input.capabilityId),
          eq(aiCapabilities.version, input.expectedVersion),
        ))
      if (result.affectedRows !== 1) return 'conflict' as const
      if (existing.source === 'builtin') {
        await tx.delete(aiCapabilityBindings).where(eq(aiCapabilityBindings.capabilityId, input.capabilityId))
        await tx.delete(aiConversationCapabilities).where(eq(aiConversationCapabilities.capabilityId, input.capabilityId))
      }
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'capability', resourceType: 'capability', resourceId: input.capabilityId,
        operation: 'delete', sourceVersion: existing.version, snapshot: { ...existing }, createdBy: input.audit.userId,
      }))
      await tx.insert(auditLogs).values(input.audit)
      return 'ok' as const
    }))
  }

  async createCapabilityBindingWithAudit(
    input: Parameters<AiConfigurationRepository['createCapabilityBindingWithAudit']>[0],
  ) {
    return mapped('aiConfiguration.createCapabilityBindingWithAudit', () => db.transaction(async (tx) => {
      await tx.insert(aiCapabilityBindings).values(input.record)
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'capability', resourceType: 'capability_binding', resourceId: input.record.id,
        operation: 'create', sourceVersion: 0, snapshot: null, createdBy: input.audit.userId,
      }))
      await tx.insert(auditLogs).values(input.audit)
      const [record] = await tx.select().from(aiCapabilityBindings)
        .where(eq(aiCapabilityBindings.id, input.record.id)).limit(1)
      if (!record) throw new Error('capability binding cannot be reloaded after creation')
      return record
    }))
  }

  async updateCapabilityBindingWithAudit(
    input: Parameters<AiConfigurationRepository['updateCapabilityBindingWithAudit']>[0],
  ) {
    return mapped('aiConfiguration.updateCapabilityBindingWithAudit', () => db.transaction(async (tx) => {
      const [existing] = await tx.select().from(aiCapabilityBindings)
        .where(eq(aiCapabilityBindings.id, input.bindingId)).limit(1)
      if (!existing) return { status: 'not_found' as const }
      const [result] = await tx.update(aiCapabilityBindings).set({
        enabled: input.enabled,
        updatedBy: input.updatedBy,
        updatedAt: input.updatedAt,
        version: sql`${aiCapabilityBindings.version} + 1`,
      }).where(and(
        eq(aiCapabilityBindings.id, input.bindingId),
        eq(aiCapabilityBindings.version, input.expectedVersion),
      ))
      if (result.affectedRows !== 1) return { status: 'conflict' as const }
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'capability', resourceType: 'capability_binding', resourceId: input.bindingId,
        operation: 'update', sourceVersion: existing.version, snapshot: { ...existing }, createdBy: input.audit.userId,
      }))
      await tx.insert(auditLogs).values(input.audit)
      const [record] = await tx.select().from(aiCapabilityBindings)
        .where(eq(aiCapabilityBindings.id, input.bindingId)).limit(1)
      return { status: 'ok' as const, record }
    }))
  }

  async recordCapabilityTestWithAudit(
    input: Parameters<AiConfigurationRepository['recordCapabilityTestWithAudit']>[0],
  ) {
    return mapped('aiConfiguration.recordCapabilityTestWithAudit', () => db.transaction(async (tx) => {
      const [result] = await tx.update(aiCapabilities).set({
        lastTestStatus: input.status,
        lastTestError: input.error,
        lastTestLatencyMs: input.latencyMs,
        lastTestTraceId: input.traceId,
        lastTestAt: input.testedAt,
        updatedBy: input.actorUserId,
        updatedAt: input.testedAt,
      }).where(eq(aiCapabilities.id, input.capabilityId))
      if (result.affectedRows !== 1) return false
      await tx.insert(auditLogs).values(input.audit)
      return true
    }))
  }

  async listEnabledCapabilitiesAndBindings() {
    return mapped('aiConfiguration.listEnabledCapabilitiesAndBindings', async () => {
      const [capabilities, bindings] = await Promise.all([
        this.executor.select().from(aiCapabilities).where(and(
          eq(aiCapabilities.enabled, true), ne(aiCapabilities.source, 'deleted'),
        ))
          .orderBy(asc(aiCapabilities.kind), asc(aiCapabilities.name)),
        this.executor.select().from(aiCapabilityBindings).where(eq(aiCapabilityBindings.enabled, true)),
      ])
      return { capabilities, bindings }
    })
  }

  async listConversationCapabilityIds(conversationId: string, userId: string) {
    return mapped('aiConfiguration.listConversationCapabilityIds', async () => {
      const rows = await this.executor.select({ capabilityId: aiConversationCapabilities.capabilityId })
        .from(aiConversationCapabilities).where(and(
          eq(aiConversationCapabilities.conversationId, conversationId),
          eq(aiConversationCapabilities.userId, userId),
        ))
      return rows.map((row) => row.capabilityId)
    })
  }

  async replaceConversationCapabilities(
    input: Parameters<AiConfigurationRepository['replaceConversationCapabilities']>[0],
  ) {
    await mapped('aiConfiguration.replaceConversationCapabilities', () => db.transaction(async (tx) => {
      await tx.delete(aiConversationCapabilities).where(and(
        eq(aiConversationCapabilities.conversationId, input.conversationId),
        eq(aiConversationCapabilities.userId, input.userId),
      ))
      if (input.capabilityIds.length) await tx.insert(aiConversationCapabilities).values(
        input.capabilityIds.map((capabilityId) => ({
          conversationId: input.conversationId,
          capabilityId,
          userId: input.userId,
        })),
      )
    }))
  }
}

export function createMySqlAiConfigurationRepository(executor: MySqlAiConfigurationExecutor): AiConfigurationRepository {
  return new MySqlAiConfigurationRepository(executor)
}

export const mysqlAiConfigurationRepository = createMySqlAiConfigurationRepository(
  db as unknown as MySqlAiConfigurationExecutor,
)
