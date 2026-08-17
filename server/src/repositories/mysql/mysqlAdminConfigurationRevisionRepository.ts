import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
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
  imOutbox,
} from '../../db/schema.js'
import {
  configurationRevisionContext,
  decryptConfigurationRevisionSnapshot,
} from '../../security/configurationRevisionCrypto.js'
import type {
  AdminConfigurationRevisionRepository,
  AdminConfigurationRollbackResult,
  ConfigurationRevisionResourceType,
} from '../adminConfigurationRevisionRepository.js'
import { isMySqlDriverError, isRepositoryError, mapMySqlRepositoryError } from '../contracts.js'
import { configurationRevisionValues } from './configurationRevision.js'

type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Snapshot = Record<string, unknown>

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`invalid configuration revision field: ${field}`)
  return value
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : stringValue(value, field)
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`invalid configuration revision field: ${field}`)
  return value
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`invalid configuration revision field: ${field}`)
  return value
}

function nullableNumber(value: unknown, field: string): number | null {
  return value === null ? null : numberValue(value, field)
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`invalid configuration revision field: ${field}`)
  }
  return [...value]
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid configuration revision field: ${field}`)
  }
  return value as Record<string, unknown>
}

function dateValue(value: unknown, field: string): Date {
  const parsed = new Date(stringValue(value, field))
  if (!Number.isFinite(parsed.getTime())) throw new Error(`invalid configuration revision field: ${field}`)
  return parsed
}

function asSnapshot(record: unknown): Snapshot {
  return { ...(record as Record<string, unknown>) }
}

async function mapped<T>(operation: string, work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (error) {
    if (isRepositoryError(error)) throw error
    if (isMySqlDriverError(error)) throw mapMySqlRepositoryError(error, operation)
    throw error
  }
}

function domainAllowsResource(domain: string, resourceType: ConfigurationRevisionResourceType): boolean {
  if (domain === 'model') return ['provider', 'model', 'route'].includes(resourceType)
  if (domain === 'capability') return ['capability', 'capability_binding'].includes(resourceType)
  if (domain === 'im') return ['im_bot', 'im_binding', 'im_lead_push_rule'].includes(resourceType)
  return false
}

async function loadCurrent(tx: Executor, resourceType: ConfigurationRevisionResourceType, resourceId: string): Promise<Snapshot | null> {
  switch (resourceType) {
    case 'provider': return (await tx.select().from(aiModelProviders).where(eq(aiModelProviders.id, resourceId)).limit(1))[0] ?? null
    case 'model': return (await tx.select().from(aiModels).where(eq(aiModels.id, resourceId)).limit(1))[0] ?? null
    case 'route': return (await tx.select().from(aiModelRoutes).where(eq(aiModelRoutes.profileKey, resourceId)).limit(1))[0] ?? null
    case 'capability': return (await tx.select().from(aiCapabilities).where(eq(aiCapabilities.id, resourceId)).limit(1))[0] ?? null
    case 'capability_binding': return (await tx.select().from(aiCapabilityBindings).where(eq(aiCapabilityBindings.id, resourceId)).limit(1))[0] ?? null
    case 'im_bot': return (await tx.select().from(imBots).where(eq(imBots.id, resourceId)).limit(1))[0] ?? null
    case 'im_binding': return (await tx.select().from(imBotBindings).where(eq(imBotBindings.id, resourceId)).limit(1))[0] ?? null
    case 'im_lead_push_rule': return (await tx.select().from(imLeadPushRules).where(eq(imLeadPushRules.id, resourceId)).limit(1))[0] ?? null
  }
}

async function lockCurrent(tx: Executor, resourceType: ConfigurationRevisionResourceType, resourceId: string): Promise<void> {
  const table = {
    provider: aiModelProviders,
    model: aiModels,
    route: aiModelRoutes,
    capability: aiCapabilities,
    capability_binding: aiCapabilityBindings,
    im_bot: imBots,
    im_binding: imBotBindings,
    im_lead_push_rule: imLeadPushRules,
  }[resourceType]
  const identifier = resourceType === 'route' ? aiModelRoutes.profileKey : (table as typeof aiModelProviders).id
  await tx.select({ value: identifier }).from(table as typeof aiModelProviders)
    .where(eq(identifier, resourceId)).for('update')
}

async function disableCreated(
  tx: Executor,
  resourceType: ConfigurationRevisionResourceType,
  resourceId: string,
  expectedVersion: number,
  actorUserId: string,
  updatedAt: Date,
): Promise<Snapshot | null> {
  const values = { enabled: false, updatedBy: actorUserId, updatedAt, version: sql`version + 1` }
  switch (resourceType) {
    case 'provider': await tx.update(aiModelProviders).set({ ...values, version: sql`${aiModelProviders.version} + 1` }).where(and(eq(aiModelProviders.id, resourceId), eq(aiModelProviders.version, expectedVersion))); break
    case 'model': await tx.update(aiModels).set({ ...values, version: sql`${aiModels.version} + 1` }).where(and(eq(aiModels.id, resourceId), eq(aiModels.version, expectedVersion))); break
    case 'route': await tx.update(aiModelRoutes).set({ ...values, version: sql`${aiModelRoutes.version} + 1` }).where(and(eq(aiModelRoutes.profileKey, resourceId), eq(aiModelRoutes.version, expectedVersion))); break
    case 'capability': await tx.update(aiCapabilities).set({ ...values, version: sql`${aiCapabilities.version} + 1` }).where(and(eq(aiCapabilities.id, resourceId), eq(aiCapabilities.version, expectedVersion))); break
    case 'capability_binding': await tx.update(aiCapabilityBindings).set({ ...values, version: sql`${aiCapabilityBindings.version} + 1` }).where(and(eq(aiCapabilityBindings.id, resourceId), eq(aiCapabilityBindings.version, expectedVersion))); break
    case 'im_bot': await tx.update(imBots).set({ ...values, connectionStatus: 'disconnected', lastConnectedAt: null, lastError: null, version: sql`${imBots.version} + 1` }).where(and(eq(imBots.id, resourceId), eq(imBots.version, expectedVersion))); break
    case 'im_binding': await tx.update(imBotBindings).set({ ...values, version: sql`${imBotBindings.version} + 1` }).where(and(eq(imBotBindings.id, resourceId), eq(imBotBindings.version, expectedVersion))); break
    case 'im_lead_push_rule': await tx.update(imLeadPushRules).set({ ...values, version: sql`${imLeadPushRules.version} + 1` }).where(and(eq(imLeadPushRules.id, resourceId), eq(imLeadPushRules.version, expectedVersion))); break
  }
  return loadCurrent(tx, resourceType, resourceId)
}

async function restoreExisting(
  tx: Executor,
  resourceType: ConfigurationRevisionResourceType,
  resourceId: string,
  expectedVersion: number,
  snapshot: Snapshot,
  actorUserId: string,
  updatedAt: Date,
): Promise<Snapshot | null> {
  switch (resourceType) {
    case 'provider':
      await tx.update(aiModelProviders).set({
        name: stringValue(snapshot.name, 'name'), protocol: stringValue(snapshot.protocol, 'protocol'),
        baseUrl: stringValue(snapshot.baseUrl, 'baseUrl'), credentialCiphertext: nullableString(snapshot.credentialCiphertext, 'credentialCiphertext'),
        credentialHint: nullableString(snapshot.credentialHint, 'credentialHint'), credentialFingerprint: nullableString(snapshot.credentialFingerprint, 'credentialFingerprint'),
        timeoutMs: numberValue(snapshot.timeoutMs, 'timeoutMs'), enabled: booleanValue(snapshot.enabled, 'enabled'),
        updatedBy: actorUserId, updatedAt, version: sql`${aiModelProviders.version} + 1`,
      }).where(and(eq(aiModelProviders.id, resourceId), eq(aiModelProviders.version, expectedVersion)))
      break
    case 'model':
      if (booleanValue(snapshot.isDefault, 'isDefault')) {
        await tx.select({ id: aiModelProviders.id }).from(aiModelProviders).orderBy(aiModelProviders.id).for('update')
        const previousDefaults = await tx.select().from(aiModels)
          .where(and(eq(aiModels.isDefault, true), sql`${aiModels.id} <> ${resourceId}`))
        for (const previous of previousDefaults) {
          await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
            domain: 'model', resourceType: 'model', resourceId: previous.id,
            operation: 'rollback', sourceVersion: previous.version, snapshot: { ...previous }, createdBy: actorUserId,
          }))
          await tx.update(aiModels).set({
            isDefault: false, updatedBy: actorUserId, updatedAt,
            version: sql`${aiModels.version} + 1`,
          }).where(and(eq(aiModels.id, previous.id), eq(aiModels.version, previous.version)))
        }
      }
      await tx.update(aiModels).set({
        providerId: stringValue(snapshot.providerId, 'providerId'), modelKey: stringValue(snapshot.modelKey, 'modelKey'),
        displayName: stringValue(snapshot.displayName, 'displayName'), contextWindow: nullableNumber(snapshot.contextWindow, 'contextWindow'),
        capabilityTags: stringArray(snapshot.capabilityTags, 'capabilityTags'), allowedRoles: stringArray(snapshot.allowedRoles, 'allowedRoles'),
        enabled: booleanValue(snapshot.enabled, 'enabled'), isDefault: booleanValue(snapshot.isDefault, 'isDefault'),
        updatedBy: actorUserId, updatedAt, version: sql`${aiModels.version} + 1`,
      }).where(and(eq(aiModels.id, resourceId), eq(aiModels.version, expectedVersion)))
      break
    case 'route':
      await tx.update(aiModelRoutes).set({
        modelId: stringValue(snapshot.modelId, 'modelId'), fallbackModelId: nullableString(snapshot.fallbackModelId, 'fallbackModelId'),
        enabled: booleanValue(snapshot.enabled, 'enabled'), updatedBy: actorUserId, updatedAt,
        version: sql`${aiModelRoutes.version} + 1`,
      }).where(and(eq(aiModelRoutes.profileKey, resourceId), eq(aiModelRoutes.version, expectedVersion)))
      break
    case 'capability':
      await tx.update(aiCapabilities).set({
        name: stringValue(snapshot.name, 'name'), description: nullableString(snapshot.description, 'description'),
        source: stringValue(snapshot.source, 'source'), packageVersion: stringValue(snapshot.packageVersion, 'packageVersion'),
        config: objectValue(snapshot.config, 'config'), toolNames: stringArray(snapshot.toolNames, 'toolNames'),
        dependencyNames: stringArray(snapshot.dependencyNames, 'dependencyNames'), allowedRoles: stringArray(snapshot.allowedRoles, 'allowedRoles'),
        enabled: booleanValue(snapshot.enabled, 'enabled'), updatedBy: actorUserId, updatedAt,
        version: sql`${aiCapabilities.version} + 1`,
      }).where(and(eq(aiCapabilities.id, resourceId), eq(aiCapabilities.version, expectedVersion)))
      break
    case 'capability_binding':
      await tx.update(aiCapabilityBindings).set({
        enabled: booleanValue(snapshot.enabled, 'enabled'), updatedBy: actorUserId, updatedAt,
        version: sql`${aiCapabilityBindings.version} + 1`,
      }).where(and(eq(aiCapabilityBindings.id, resourceId), eq(aiCapabilityBindings.version, expectedVersion)))
      break
    case 'im_bot':
      await tx.update(imBots).set({
        name: stringValue(snapshot.name, 'name'), credentialCiphertext: stringValue(snapshot.credentialCiphertext, 'credentialCiphertext'),
        credentialHint: stringValue(snapshot.credentialHint, 'credentialHint'), credentialFingerprint: stringValue(snapshot.credentialFingerprint, 'credentialFingerprint'),
        config: objectValue(snapshot.config, 'config'), enabled: booleanValue(snapshot.enabled, 'enabled'),
        connectionStatus: 'disconnected', lastConnectedAt: null, lastError: null,
        updatedBy: actorUserId, updatedAt, version: sql`${imBots.version} + 1`,
      }).where(and(eq(imBots.id, resourceId), eq(imBots.version, expectedVersion)))
      break
    case 'im_binding':
      await tx.update(imBotBindings).set({
        externalConversationId: stringValue(snapshot.externalConversationId, 'externalConversationId'),
        enabled: booleanValue(snapshot.enabled, 'enabled'), updatedBy: actorUserId, updatedAt,
        version: sql`${imBotBindings.version} + 1`,
      }).where(and(eq(imBotBindings.id, resourceId), eq(imBotBindings.version, expectedVersion)))
      break
    case 'im_lead_push_rule':
      await tx.update(imLeadPushRules).set({
        name: stringValue(snapshot.name, 'name'), leadStatus: nullableString(snapshot.leadStatus, 'leadStatus'),
        projectId: nullableString(snapshot.projectId, 'projectId'), minScore: nullableNumber(snapshot.minScore, 'minScore'),
        messageTemplate: stringValue(snapshot.messageTemplate, 'messageTemplate'), enabled: booleanValue(snapshot.enabled, 'enabled'),
        updatedBy: actorUserId, updatedAt, version: sql`${imLeadPushRules.version} + 1`,
      }).where(and(eq(imLeadPushRules.id, resourceId), eq(imLeadPushRules.version, expectedVersion)))
      break
  }
  return loadCurrent(tx, resourceType, resourceId)
}

async function restoreDeleted(
  tx: Executor,
  resourceType: ConfigurationRevisionResourceType,
  resourceId: string,
  sourceVersion: number,
  snapshot: Snapshot,
  actorUserId: string,
  updatedAt: Date,
): Promise<Snapshot | null> {
  const createdAt = dateValue(snapshot.createdAt, 'createdAt')
  if (resourceType === 'im_binding') {
    await tx.insert(imBotBindings).values({
      id: resourceId, botId: stringValue(snapshot.botId, 'botId'),
      externalConversationId: stringValue(snapshot.externalConversationId, 'externalConversationId'),
      userId: stringValue(snapshot.userId, 'userId'), projectId: nullableString(snapshot.projectId, 'projectId'),
      conversationId: nullableString(snapshot.conversationId, 'conversationId'), department: nullableString(snapshot.department, 'department'),
      enabled: booleanValue(snapshot.enabled, 'enabled'), version: sourceVersion + 1,
      createdBy: nullableString(snapshot.createdBy, 'createdBy'), updatedBy: actorUserId, createdAt, updatedAt,
    })
  } else if (resourceType === 'im_lead_push_rule') {
    await tx.insert(imLeadPushRules).values({
      id: resourceId, name: stringValue(snapshot.name, 'name'), botId: stringValue(snapshot.botId, 'botId'),
      bindingId: stringValue(snapshot.bindingId, 'bindingId'), leadStatus: nullableString(snapshot.leadStatus, 'leadStatus'),
      projectId: nullableString(snapshot.projectId, 'projectId'), minScore: nullableNumber(snapshot.minScore, 'minScore'),
      messageTemplate: stringValue(snapshot.messageTemplate, 'messageTemplate'), enabled: booleanValue(snapshot.enabled, 'enabled'),
      version: sourceVersion + 1, createdBy: nullableString(snapshot.createdBy, 'createdBy'), updatedBy: actorUserId,
      createdAt, updatedAt,
    })
  } else {
    return null
  }
  return loadCurrent(tx, resourceType, resourceId)
}

class MySqlAdminConfigurationRevisionRepository implements AdminConfigurationRevisionRepository {
  async list(input: Parameters<AdminConfigurationRevisionRepository['list']>[0]) {
    return mapped('adminConfigurationRevision.list', async () => {
      if (!domainAllowsResource(input.domain, input.resourceType)) return []
      const rows = await db.select({
        id: adminConfigurationRevisions.id,
        domain: adminConfigurationRevisions.domain,
        resourceType: adminConfigurationRevisions.resourceType,
        resourceId: adminConfigurationRevisions.resourceId,
        operation: adminConfigurationRevisions.operation,
        sourceVersion: adminConfigurationRevisions.sourceVersion,
        snapshotSha256: adminConfigurationRevisions.snapshotSha256,
        snapshotCiphertext: adminConfigurationRevisions.snapshotCiphertext,
        createdBy: adminConfigurationRevisions.createdBy,
        createdAt: adminConfigurationRevisions.createdAt,
      }).from(adminConfigurationRevisions).where(and(
        eq(adminConfigurationRevisions.domain, input.domain),
        eq(adminConfigurationRevisions.resourceType, input.resourceType),
        eq(adminConfigurationRevisions.resourceId, input.resourceId),
      )).orderBy(desc(adminConfigurationRevisions.createdAt), desc(adminConfigurationRevisions.id))
        .limit(Math.max(1, Math.min(100, input.limit ?? 50)))
      return rows.map(({ snapshotCiphertext, ...row }) => ({
        ...row,
        domain: row.domain as typeof input.domain,
        resourceType: row.resourceType as ConfigurationRevisionResourceType,
        snapshotAvailable: Boolean(snapshotCiphertext),
      }))
    })
  }

  async rollback(input: Parameters<AdminConfigurationRevisionRepository['rollback']>[0]): Promise<AdminConfigurationRollbackResult> {
    return mapped('adminConfigurationRevision.rollback', () => db.transaction(async (tx) => {
      if (!domainAllowsResource(input.domain, input.resourceType)) return { status: 'not_found' as const }
      const [revision] = await tx.select().from(adminConfigurationRevisions).where(and(
        eq(adminConfigurationRevisions.id, input.revisionId),
        eq(adminConfigurationRevisions.domain, input.domain),
        eq(adminConfigurationRevisions.resourceType, input.resourceType),
        eq(adminConfigurationRevisions.resourceId, input.resourceId),
      )).limit(1)
      if (!revision) return { status: 'not_found' as const }
      if (input.resourceType === 'model') {
        await tx.select({ id: aiModelProviders.id }).from(aiModelProviders).orderBy(aiModelProviders.id).for('update')
      }
      await lockCurrent(tx, input.resourceType, input.resourceId)
      const current = await loadCurrent(tx, input.resourceType, input.resourceId)
      if (!current) {
        if (input.expectedVersion !== 0 || revision.operation !== 'delete' || !revision.snapshotCiphertext) {
          return { status: 'resource_not_found' as const }
        }
        const snapshot = decryptConfigurationRevisionSnapshot(
          input.domain,
          configurationRevisionContext(revision as Parameters<typeof configurationRevisionContext>[0]),
          revision.snapshotCiphertext,
          revision.snapshotSha256,
        )
        const restored = await restoreDeleted(tx, input.resourceType, input.resourceId, revision.sourceVersion, snapshot, input.actorUserId, input.updatedAt)
        if (!restored) return { status: 'dependency_invalid' as const }
        await tx.insert(auditLogs).values(input.audit)
        return { status: 'ok' as const, record: restored }
      }
      const currentVersion = numberValue(current.version, 'version')
      if (currentVersion !== input.expectedVersion) return { status: 'conflict' as const }
      if (input.resourceType === 'im_bot' && booleanValue(current.enabled, 'enabled') && !input.confirmImpact) {
        const [binding] = await tx.select({ id: imBotBindings.id }).from(imBotBindings)
          .where(and(eq(imBotBindings.botId, input.resourceId), eq(imBotBindings.enabled, true))).limit(1)
        const [outbox] = await tx.select({ id: imOutbox.id }).from(imOutbox).where(and(
          eq(imOutbox.botId, input.resourceId), sql`${imOutbox.status} IN ('pending','failed','sending')`,
        )).limit(1)
        if (binding || outbox) return { status: 'impact_confirmation_required' as const }
      }
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: input.domain,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        operation: 'rollback',
        sourceVersion: currentVersion,
        snapshot: current,
        createdBy: input.actorUserId,
      }))
      let restored: Snapshot | null
      if (!revision.snapshotCiphertext) {
        restored = await disableCreated(tx, input.resourceType, input.resourceId, currentVersion, input.actorUserId, input.updatedAt)
      } else {
        const snapshot = decryptConfigurationRevisionSnapshot(
          input.domain,
          configurationRevisionContext(revision as Parameters<typeof configurationRevisionContext>[0]),
          revision.snapshotCiphertext,
          revision.snapshotSha256,
        )
        restored = await restoreExisting(tx, input.resourceType, input.resourceId, currentVersion, snapshot, input.actorUserId, input.updatedAt)
      }
      if (!restored) return { status: 'resource_not_found' as const }
      await tx.insert(auditLogs).values(input.audit)
      return { status: 'ok' as const, record: restored }
    }))
  }
}

export const mysqlAdminConfigurationRevisionRepository: AdminConfigurationRevisionRepository
  = new MySqlAdminConfigurationRevisionRepository()
