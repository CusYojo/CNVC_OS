import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { RowDataPacket } from 'mysql2'
import { db, pool } from '../../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../../db/config.js'
import {
  adminConfigurationRevisions, agentConversations, aiModelProviders, auditLogs, imBotBindings, imBots, imDeliveryLogs,
  imInboundMessages, imLeadPushRules, imOutbox, leads, projects,
} from '../../db/schema.js'
import type { ImIntegrationRepository } from '../imIntegrationRepository.js'
import { isMySqlDriverError, isRepositoryError, mapMySqlRepositoryError } from '../contracts.js'
import { createMySqlAgentConversationRepository } from './mysqlAgentConversationRepository.js'
import { createMySqlIdentityRepositoryContext } from './mysqlIdentityRepository.js'
import { configurationRevisionValues } from './configurationRevision.js'

export type MySqlImIntegrationExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]
const outboxTable = quoteMysqlIdentifier(mysqlTableName('im_outbox'))
const botTable = quoteMysqlIdentifier(mysqlTableName('im_bots'))

async function mapped<T>(operation: string, work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (error) {
    if (isRepositoryError(error)) throw error
    if (isMySqlDriverError(error)) throw mapMySqlRepositoryError(error, operation)
    throw error
  }
}

class MySqlImIntegrationRepository implements ImIntegrationRepository {
  constructor(private readonly executor: MySqlImIntegrationExecutor) {}

  async listSettingsData() {
    return mapped('im.listSettingsData', async () => {
      const identity = createMySqlIdentityRepositoryContext(this.executor)
      const conversations = createMySqlAgentConversationRepository(this.executor)
      const [bots, bindings, outbox, logs, users, projectRows, conversationRows] = await Promise.all([
        this.executor.select().from(imBots).orderBy(asc(imBots.platform), asc(imBots.name)),
        this.executor.select().from(imBotBindings).orderBy(desc(imBotBindings.updatedAt)),
        this.executor.select().from(imOutbox).orderBy(desc(imOutbox.createdAt)).limit(100),
        this.executor.select().from(imDeliveryLogs).orderBy(desc(imDeliveryLogs.createdAt)).limit(100),
        identity.users.listSafe(),
        this.executor.select({ id: projects.id, name: projects.name }).from(projects).orderBy(asc(projects.name)),
        conversations.listRecentAgents(500),
      ])
      return { bots, bindings, outbox, logs, users, projects: projectRows, conversations: conversationRows }
    })
  }

  async listLeadPushSettingsData() {
    return mapped('im.listLeadPushSettingsData', async () => {
      const [targets, rules, projectRows] = await Promise.all([
        this.executor.select({
          botId: imBots.id, botName: imBots.name, platform: imBots.platform,
          bindingId: imBotBindings.id, externalConversationId: imBotBindings.externalConversationId,
          userId: imBotBindings.userId, projectId: imBotBindings.projectId, department: imBotBindings.department,
        }).from(imBotBindings).innerJoin(imBots, eq(imBots.id, imBotBindings.botId)).where(and(
          eq(imBots.enabled, true), eq(imBotBindings.enabled, true),
        )).orderBy(asc(imBots.name), asc(imBotBindings.externalConversationId)),
        this.executor.select().from(imLeadPushRules).orderBy(desc(imLeadPushRules.updatedAt)),
        this.executor.select({ id: projects.id, name: projects.name }).from(projects).orderBy(asc(projects.name)),
      ])
      return { targets, rules, projects: projectRows }
    })
  }

  async findEnabledPushTarget(botId: string, bindingId: string) {
    return mapped('im.findEnabledPushTarget', async () => {
      const [target] = await this.executor.select({ binding: imBotBindings, bot: imBots }).from(imBotBindings)
        .innerJoin(imBots, eq(imBots.id, imBotBindings.botId)).where(and(
          eq(imBotBindings.id, bindingId), eq(imBotBindings.botId, botId),
          eq(imBotBindings.enabled, true), eq(imBots.enabled, true),
        )).limit(1)
      return target ?? null
    })
  }

  async findLatestOperationalAlert(bindingId: string) {
    return mapped('im.findLatestOperationalAlert', async () => {
      const [row] = await this.executor.select({
        id: imOutbox.id,
        status: imOutbox.status,
        createdAt: imOutbox.createdAt,
        payload: imOutbox.payload,
      }).from(imOutbox).where(and(
        eq(imOutbox.bindingId, bindingId),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${imOutbox.payload}, '$.kind')) = 'operational-alert'`,
      )).orderBy(desc(imOutbox.createdAt), desc(imOutbox.id)).limit(1)
      if (!row) return null
      const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? row.payload as Record<string, unknown> : {}
      const state: 'active' | 'recovered' = payload.state === 'recovered' ? 'recovered' : 'active'
      const alertCodes = Array.isArray(payload.alertCodes)
        ? payload.alertCodes.filter((value): value is string => typeof value === 'string').slice(0, 100)
        : []
      return {
        id: row.id,
        status: row.status,
        createdAt: new Date(row.createdAt),
        state,
        fingerprint: typeof payload.fingerprint === 'string' ? payload.fingerprint : '',
        alertCodes,
      }
    })
  }

  async enqueueOperationalAlert(input: Parameters<ImIntegrationRepository['enqueueOperationalAlert']>[0]) {
    return await this.enqueueSystemNotification(input)
  }

  async enqueueSystemNotification(input: Parameters<ImIntegrationRepository['enqueueSystemNotification']>[0]) {
    try {
      return await mapped('im.enqueueSystemNotification', () => db.transaction(async (tx) => {
        const [target] = await tx.select({ binding: imBotBindings, bot: imBots }).from(imBotBindings)
          .innerJoin(imBots, eq(imBots.id, imBotBindings.botId)).where(and(
            eq(imBotBindings.id, input.bindingId),
            eq(imBotBindings.enabled, true),
            eq(imBots.enabled, true),
          )).limit(1)
        if (!target) return { status: 'binding_disabled' as const }
        const [existing] = await tx.select().from(imOutbox).where(and(
          eq(imOutbox.botId, target.bot.id),
          eq(imOutbox.idempotencyKey, input.idempotencyKey),
        )).limit(1)
        if (existing) {
          if (existing.payloadHash !== input.payloadHash || existing.bindingId !== input.bindingId) {
            return { status: 'idempotency_conflict' as const }
          }
          return { status: 'existing' as const, record: existing }
        }
        await tx.insert(imOutbox).values({
          id: input.id,
          botId: target.bot.id,
          bindingId: input.bindingId,
          createdBy: null,
          idempotencyKey: input.idempotencyKey,
          payloadHash: input.payloadHash,
          payload: input.payload,
          status: 'pending',
        })
        await tx.insert(auditLogs).values(input.audit)
        const [record] = await tx.select().from(imOutbox).where(eq(imOutbox.id, input.id)).limit(1)
        if (!record) throw new Error('system notification outbox row cannot be reloaded')
        return { status: 'created' as const, record }
      }))
    } catch (error) {
      if (!isRepositoryError(error) || error.code !== 'CONFLICT') throw error
      const [existing] = await this.executor.select().from(imOutbox).where(and(
        eq(imOutbox.bindingId, input.bindingId),
        eq(imOutbox.idempotencyKey, input.idempotencyKey),
      )).limit(1)
      if (!existing || existing.payloadHash !== input.payloadHash || existing.bindingId !== input.bindingId) {
        return { status: 'idempotency_conflict' as const }
      }
      return { status: 'existing' as const, record: existing }
    }
  }

  async createLeadPushRuleWithAudit(record: Parameters<ImIntegrationRepository['createLeadPushRuleWithAudit']>[0], audit: Parameters<ImIntegrationRepository['createLeadPushRuleWithAudit']>[1]) {
    return mapped('im.createLeadPushRuleWithAudit', () => db.transaction(async (tx) => {
      const [target] = await tx.select({ binding: imBotBindings, bot: imBots }).from(imBotBindings)
        .innerJoin(imBots, eq(imBots.id, imBotBindings.botId)).where(and(
          eq(imBotBindings.id, record.bindingId), eq(imBotBindings.botId, record.botId),
          eq(imBotBindings.enabled, true), eq(imBots.enabled, true),
        )).limit(1)
      if (!target) return { status: 'target_forbidden' as const }
      if (target.binding.projectId && target.binding.projectId !== record.projectId) {
        return { status: 'project_mismatch' as const }
      }
      if (record.projectId) {
        const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, record.projectId)).limit(1)
        if (!project) return { status: 'project_invalid' as const }
      }
      await tx.insert(imLeadPushRules).values(record)
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'im', resourceType: 'im_lead_push_rule', resourceId: record.id,
        operation: 'create', sourceVersion: 0, snapshot: null, createdBy: audit.userId,
      }))
      await tx.insert(auditLogs).values(audit)
      const [created] = await tx.select().from(imLeadPushRules).where(eq(imLeadPushRules.id, record.id)).limit(1)
      if (!created) throw new Error('lead push rule cannot be reloaded')
      return { status: 'ok' as const, record: created }
    }))
  }

  async findLeadPushRule(ruleId: string) {
    return mapped('im.findLeadPushRule', async () => {
      const [row] = await this.executor.select().from(imLeadPushRules).where(eq(imLeadPushRules.id, ruleId)).limit(1)
      return row ?? null
    })
  }

  async updateLeadPushRuleWithAudit(input: Parameters<ImIntegrationRepository['updateLeadPushRuleWithAudit']>[0]) {
    return mapped('im.updateLeadPushRuleWithAudit', () => db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: imLeadPushRules.id }).from(imLeadPushRules).where(eq(imLeadPushRules.id, input.ruleId)).limit(1)
      if (!existing) return { status: 'not_found' as const }
      const [fullExisting] = await tx.select().from(imLeadPushRules).where(eq(imLeadPushRules.id, input.ruleId)).limit(1)
      const [target] = await tx.select({ binding: imBotBindings, bot: imBots }).from(imBotBindings)
        .innerJoin(imBots, eq(imBots.id, imBotBindings.botId)).where(and(
          eq(imBotBindings.id, fullExisting.bindingId), eq(imBotBindings.botId, fullExisting.botId),
          eq(imBotBindings.enabled, true), eq(imBots.enabled, true),
        )).limit(1)
      if (!target) return { status: 'target_forbidden' as const }
      const projectId = input.patch.projectId === undefined ? fullExisting.projectId : input.patch.projectId
      if (target.binding.projectId && target.binding.projectId !== projectId) return { status: 'project_mismatch' as const }
      if (projectId) {
        const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1)
        if (!project) return { status: 'project_invalid' as const }
      }
      const [result] = await tx.update(imLeadPushRules).set({ ...input.patch, updatedAt: input.updatedAt, version: sql`${imLeadPushRules.version} + 1` })
        .where(and(eq(imLeadPushRules.id, input.ruleId), eq(imLeadPushRules.version, input.expectedVersion)))
      if (result.affectedRows !== 1) return { status: 'conflict' as const }
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'im', resourceType: 'im_lead_push_rule', resourceId: input.ruleId,
        operation: 'update', sourceVersion: fullExisting.version, snapshot: { ...fullExisting }, createdBy: input.audit.userId,
      }))
      await tx.insert(auditLogs).values(input.audit)
      const [record] = await tx.select().from(imLeadPushRules).where(eq(imLeadPushRules.id, input.ruleId)).limit(1)
      return { status: 'ok' as const, record }
    }))
  }

  async deleteLeadPushRuleWithAudit(ruleId: string, audit: Parameters<ImIntegrationRepository['deleteLeadPushRuleWithAudit']>[1]) {
    return mapped('im.deleteLeadPushRuleWithAudit', () => db.transaction(async (tx) => {
      const [existing] = await tx.select().from(imLeadPushRules).where(eq(imLeadPushRules.id, ruleId)).limit(1)
      if (!existing) return false
      const [result] = await tx.delete(imLeadPushRules).where(eq(imLeadPushRules.id, ruleId))
      if (result.affectedRows !== 1) return false
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'im', resourceType: 'im_lead_push_rule', resourceId: ruleId,
        operation: 'delete', sourceVersion: existing.version, snapshot: { ...existing }, createdBy: audit.userId,
      }))
      await tx.insert(auditLogs).values(audit)
      return true
    }))
  }

  async findLeadPushDispatch(ruleId: string, leadId: string) {
    return mapped('im.findLeadPushDispatch', async () => {
      const [row] = await this.executor.select({ rule: imLeadPushRules, lead: leads, projectName: projects.name })
        .from(imLeadPushRules).innerJoin(leads, eq(leads.id, leadId))
        .leftJoin(projects, eq(projects.id, leads.convertedProjectId))
        .where(eq(imLeadPushRules.id, ruleId)).limit(1)
      return row ?? null
    })
  }

  async createBotWithAudit(record: Parameters<ImIntegrationRepository['createBotWithAudit']>[0], audit: Parameters<ImIntegrationRepository['createBotWithAudit']>[1]) {
    return mapped('im.createBotWithAudit', () => db.transaction(async (tx) => {
      await tx.insert(imBots).values(record)
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'im', resourceType: 'im_bot', resourceId: record.id,
        operation: 'create', sourceVersion: 0, snapshot: null, createdBy: audit.userId,
      }))
      await tx.insert(auditLogs).values(audit)
      const [created] = await tx.select().from(imBots).where(eq(imBots.id, record.id)).limit(1)
      if (!created) throw new Error('IM bot cannot be reloaded')
      return created
    }))
  }

  async findBot(botId: string) {
    return mapped('im.findBot', async () => {
      const [row] = await this.executor.select().from(imBots).where(eq(imBots.id, botId)).limit(1)
      return row ?? null
    })
  }

  async updateBotWithAudit(input: Parameters<ImIntegrationRepository['updateBotWithAudit']>[0]) {
    return mapped('im.updateBotWithAudit', () => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT ${imBots.id} FROM ${imBots} WHERE ${imBots.id}=${input.botId} FOR UPDATE`)
      const [existing] = await tx.select().from(imBots).where(eq(imBots.id, input.botId)).limit(1)
      if (!existing) return { status: 'not_found' as const }
      if (existing.version !== input.expectedVersion) return { status: 'conflict' as const }
      if (existing.enabled && input.patch.enabled === false && !input.confirmDisableImpact) {
        const [binding] = await tx.select({ id: imBotBindings.id }).from(imBotBindings)
          .where(and(eq(imBotBindings.botId, input.botId), eq(imBotBindings.enabled, true))).limit(1)
        const [outbox] = await tx.select({ id: imOutbox.id }).from(imOutbox).where(and(
          eq(imOutbox.botId, input.botId), sql`${imOutbox.status} IN ('pending','failed','sending')`,
        )).limit(1)
        if (binding || outbox) return { status: 'disable_confirmation_required' as const }
      }
      await tx.update(imBots).set({ ...input.patch, updatedAt: input.updatedAt, version: sql`${imBots.version} + 1` })
        .where(and(eq(imBots.id, input.botId), eq(imBots.version, input.expectedVersion)))
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'im', resourceType: 'im_bot', resourceId: input.botId,
        operation: 'update', sourceVersion: existing.version, snapshot: { ...existing }, createdBy: input.audit.userId,
      }))
      await tx.insert(auditLogs).values(input.audit)
      const [record] = await tx.select().from(imBots).where(eq(imBots.id, input.botId)).limit(1)
      return { status: 'ok' as const, record }
    }))
  }

  async recordBotTestWithAudit(input: Parameters<ImIntegrationRepository['recordBotTestWithAudit']>[0]) {
    return mapped('im.recordBotTestWithAudit', () => db.transaction(async (tx) => {
      const [result] = await tx.update(imBots).set({
        connectionStatus: input.ok ? 'connected' : 'error', lastConnectedAt: input.ok ? input.testedAt : null,
        lastError: input.ok ? null : input.error, updatedAt: input.testedAt,
      }).where(eq(imBots.id, input.botId))
      if (result.affectedRows !== 1) return false
      await tx.insert(auditLogs).values(input.audit)
      return true
    }))
  }

  async createBindingWithAudit(input: Parameters<ImIntegrationRepository['createBindingWithAudit']>[0]) {
    return mapped('im.createBindingWithAudit', () => db.transaction(async (tx) => {
      const identity = createMySqlIdentityRepositoryContext(tx)
      const conversations = createMySqlAgentConversationRepository(tx)
      const [bot] = await tx.select({ id: imBots.id }).from(imBots).where(eq(imBots.id, input.record.botId)).limit(1)
      if (!bot) return { status: 'bot_not_found' as const }
      const user = await identity.users.findById(input.record.userId)
      if (!user || user.status !== '启用') return { status: 'user_invalid' as const }
      if (input.record.projectId && !(await identity.permissions.findProjectById(input.record.projectId))) {
        return { status: 'project_invalid' as const }
      }
      if (input.record.conversationId) {
        const conversation = await conversations.findAgentById(input.record.conversationId)
        if (!conversation || conversation.userId !== input.record.userId
          || (input.record.projectId && conversation.projectId !== input.record.projectId)) {
          return { status: 'conversation_invalid' as const }
        }
      }
      await tx.insert(imBotBindings).values({ ...input.record, department: input.record.department || user.department })
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'im', resourceType: 'im_binding', resourceId: input.record.id,
        operation: 'create', sourceVersion: 0, snapshot: null, createdBy: input.audit.userId,
      }))
      await tx.insert(auditLogs).values(input.audit)
      const [record] = await tx.select().from(imBotBindings).where(eq(imBotBindings.id, input.record.id)).limit(1)
      return { status: 'ok' as const, record }
    }))
  }

  async updateBindingWithAudit(input: Parameters<ImIntegrationRepository['updateBindingWithAudit']>[0]) {
    return mapped('im.updateBindingWithAudit', () => db.transaction(async (tx) => {
      const [existing] = await tx.select().from(imBotBindings).where(eq(imBotBindings.id, input.bindingId)).limit(1)
      if (!existing) return { status: 'not_found' as const }
      const [result] = await tx.update(imBotBindings).set({ ...input.patch, updatedAt: input.updatedAt, version: sql`${imBotBindings.version} + 1` })
        .where(and(eq(imBotBindings.id, input.bindingId), eq(imBotBindings.version, input.expectedVersion)))
      if (result.affectedRows !== 1) return { status: 'conflict' as const }
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'im', resourceType: 'im_binding', resourceId: input.bindingId,
        operation: 'update', sourceVersion: existing.version, snapshot: { ...existing }, createdBy: input.audit.userId,
      }))
      await tx.insert(auditLogs).values(input.audit)
      const [record] = await tx.select().from(imBotBindings).where(eq(imBotBindings.id, input.bindingId)).limit(1)
      return { status: 'ok' as const, record }
    }))
  }

  async deleteBindingWithAudit(bindingId: string, audit: Parameters<ImIntegrationRepository['deleteBindingWithAudit']>[1]) {
    return mapped('im.deleteBindingWithAudit', () => db.transaction(async (tx) => {
      const [existing] = await tx.select().from(imBotBindings).where(eq(imBotBindings.id, bindingId)).limit(1)
      if (!existing) return 'not_found' as const
      const [rule] = await tx.select({ id: imLeadPushRules.id }).from(imLeadPushRules).where(eq(imLeadPushRules.bindingId, bindingId)).limit(1)
      if (rule) return 'has_push_rule' as const
      const [history] = await tx.select({ id: imOutbox.id }).from(imOutbox).where(eq(imOutbox.bindingId, bindingId)).limit(1)
      if (history) return 'has_history' as const
      const [result] = await tx.delete(imBotBindings).where(eq(imBotBindings.id, bindingId))
      if (result.affectedRows !== 1) return 'not_found' as const
      await tx.insert(adminConfigurationRevisions).values(configurationRevisionValues({
        domain: 'im', resourceType: 'im_binding', resourceId: bindingId,
        operation: 'delete', sourceVersion: existing.version, snapshot: { ...existing }, createdBy: audit.userId,
      }))
      await tx.insert(auditLogs).values(audit)
      return 'ok' as const
    }))
  }

  async enqueueMessageWithAudit(input: Parameters<ImIntegrationRepository['enqueueMessageWithAudit']>[0]) {
    try {
      return await mapped('im.enqueueMessageWithAudit', () => db.transaction(async (tx) => {
        const [target] = await tx.select({ binding: imBotBindings, bot: imBots }).from(imBotBindings)
          .innerJoin(imBots, eq(imBots.id, imBotBindings.botId)).where(and(
            eq(imBotBindings.id, input.bindingId), eq(imBotBindings.botId, input.botId),
          )).limit(1)
        if (!target || !target.binding.enabled || !target.bot.enabled) return { status: 'binding_disabled' as const }
        if (!input.actorIsAdmin && target.binding.userId !== input.actorUserId) {
          await tx.insert(auditLogs).values(input.deniedAudit)
          return { status: 'forbidden' as const }
        }
        const [existing] = await tx.select().from(imOutbox).where(and(
          eq(imOutbox.botId, input.botId), eq(imOutbox.idempotencyKey, input.idempotencyKey),
        )).limit(1)
        if (existing) {
          if (existing.payloadHash !== input.payloadHash || existing.bindingId !== input.bindingId) return { status: 'idempotency_conflict' as const }
          return { status: 'existing' as const, record: existing }
        }
        await tx.insert(imOutbox).values({
          id: input.id, botId: input.botId, bindingId: input.bindingId, createdBy: input.actorUserId,
          idempotencyKey: input.idempotencyKey, payloadHash: input.payloadHash, payload: input.payload, status: 'pending',
        })
        await tx.insert(auditLogs).values(input.successAudit)
        const [record] = await tx.select().from(imOutbox).where(eq(imOutbox.id, input.id)).limit(1)
        return { status: 'created' as const, record }
      }))
    } catch (error) {
      if (!isRepositoryError(error) || error.code !== 'CONFLICT') throw error
      const [existing] = await this.executor.select().from(imOutbox).where(and(
        eq(imOutbox.botId, input.botId), eq(imOutbox.idempotencyKey, input.idempotencyKey),
      )).limit(1)
      if (!existing || existing.payloadHash !== input.payloadHash || existing.bindingId !== input.bindingId) {
        return { status: 'idempotency_conflict' as const }
      }
      return { status: 'existing' as const, record: existing }
    }
  }

  async claimOutboxBatch(input: Parameters<ImIntegrationRepository['claimOutboxBatch']>[0]) {
    return mapped('im.claimOutboxBatch', async () => {
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        const [rows] = await connection.query<(RowDataPacket & { id: string; bot_id: string; payload: Record<string, unknown> | string; attempts: number })[]>(
          `SELECT o.* FROM ${outboxTable} o JOIN ${botTable} b ON b.id=o.bot_id
           WHERE b.enabled=1 AND o.next_attempt_at <= NOW(3)
             AND (o.status IN ('pending','failed') OR (o.status='sending' AND o.lease_expires_at IS NOT NULL AND o.lease_expires_at < NOW(3)))
             AND (o.lease_expires_at IS NULL OR o.lease_expires_at < NOW(3))
           ORDER BY o.next_attempt_at, o.created_at, o.id LIMIT ? FOR UPDATE SKIP LOCKED`, [input.limit],
        )
        if (rows.length) await connection.query(
          `UPDATE ${outboxTable} SET status='sending', lease_owner=?, lease_expires_at=?, attempts=attempts+1, updated_at=NOW(3) WHERE id IN (${rows.map(() => '?').join(',')})`,
          [input.owner, input.leaseExpiresAt, ...rows.map((row) => row.id)],
        )
        await connection.commit()
        return rows.map((row) => ({
          id: row.id, botId: row.bot_id,
          payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
          attempts: Number(row.attempts), leaseOwner: input.owner,
        }))
      } catch (error) {
        await connection.rollback()
        throw error
      } finally { connection.release() }
    })
  }

  async deferClaimForDisabledBot(input: Parameters<ImIntegrationRepository['deferClaimForDisabledBot']>[0]) {
    await mapped('im.deferClaimForDisabledBot', async () => {
      await this.executor.update(imOutbox).set({ status: 'failed', leaseOwner: null, leaseExpiresAt: null, lastError: '机器人已停用', nextAttemptAt: input.nextAttemptAt, updatedAt: input.updatedAt })
        .where(and(eq(imOutbox.id, input.outboxId), eq(imOutbox.leaseOwner, input.owner)))
    })
  }

  async findLatestDeliveryAt(botId: string) {
    return mapped('im.findLatestDeliveryAt', async () => {
      const [row] = await this.executor.select({ deliveredAt: sql<Date | null>`MAX(${imDeliveryLogs.createdAt})` })
        .from(imDeliveryLogs).innerJoin(imOutbox, eq(imOutbox.id, imDeliveryLogs.outboxId))
        .where(eq(imOutbox.botId, botId))
      return row?.deliveredAt ? new Date(row.deliveredAt) : null
    })
  }

  async deferClaimForRateLimit(input: Parameters<ImIntegrationRepository['deferClaimForRateLimit']>[0]) {
    await mapped('im.deferClaimForRateLimit', async () => {
      await this.executor.update(imOutbox).set({ status: 'pending', attempts: sql`GREATEST(0, ${imOutbox.attempts} - 1)`, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: input.nextAttemptAt, updatedAt: new Date() })
        .where(and(eq(imOutbox.id, input.outboxId), eq(imOutbox.leaseOwner, input.owner)))
    })
  }

  async completeDelivery(input: Parameters<ImIntegrationRepository['completeDelivery']>[0]) {
    return mapped('im.completeDelivery', () => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT ${imOutbox.id} FROM ${imOutbox} WHERE ${imOutbox.id}=${input.outboxId} AND ${imOutbox.leaseOwner}=${input.owner} FOR UPDATE`)
      const [owned] = await tx.select({ id: imOutbox.id }).from(imOutbox).where(and(eq(imOutbox.id, input.outboxId), eq(imOutbox.leaseOwner, input.owner))).limit(1)
      if (!owned) return false
      await tx.insert(imDeliveryLogs).values({
        outboxId: input.outboxId, attempt: input.attempt, status: input.ok ? 'sent' : 'failed',
        externalMessageId: input.externalMessageId, httpStatus: input.httpStatus,
        durationMs: input.durationMs, error: input.error,
      })
      await tx.update(imOutbox).set({
        status: input.ok ? 'sent' : input.terminal ? 'dead_letter' : 'failed', leaseOwner: null,
        leaseExpiresAt: null, lastError: input.error, sentAt: input.ok ? input.completedAt : null,
        nextAttemptAt: input.ok ? input.completedAt : input.nextAttemptAt, updatedAt: input.completedAt,
      }).where(and(eq(imOutbox.id, input.outboxId), eq(imOutbox.leaseOwner, input.owner)))
      return true
    }))
  }

  async findEnabledInboundBinding(botId: string, externalConversationId: string) {
    return mapped('im.findEnabledInboundBinding', async () => {
      const [row] = await this.executor.select().from(imBotBindings).where(and(
        eq(imBotBindings.botId, botId), eq(imBotBindings.externalConversationId, externalConversationId),
        eq(imBotBindings.enabled, true),
      )).limit(1)
      return row ?? null
    })
  }

  async findInboundMessage(botId: string, externalMessageId: string) {
    return mapped('im.findInboundMessage', async () => {
      const [row] = await this.executor.select().from(imInboundMessages).where(and(
        eq(imInboundMessages.botId, botId), eq(imInboundMessages.externalMessageId, externalMessageId),
      )).limit(1)
      return row ?? null
    })
  }

  async createInboundMessage(record: Parameters<ImIntegrationRepository['createInboundMessage']>[0]) {
    try {
      await this.executor.insert(imInboundMessages).values(record)
      return 'created' as const
    } catch (error) {
      const mappedError = isMySqlDriverError(error) ? mapMySqlRepositoryError(error, 'im.createInboundMessage') : error
      if (isRepositoryError(mappedError) && mappedError.code === 'CONFLICT') return 'duplicate' as const
      throw mappedError
    }
  }

  async updateInboundStatus(id: string, status: string, rejectionReason: string | null = null) {
    await mapped('im.updateInboundStatus', async () => {
      await this.executor.update(imInboundMessages).set({ status, rejectionReason }).where(eq(imInboundMessages.id, id))
    })
  }

  async findInboundMessageById(id: string) {
    return mapped('im.findInboundMessageById', async () => {
      const [row] = await this.executor.select().from(imInboundMessages).where(eq(imInboundMessages.id, id)).limit(1)
      return row ?? null
    })
  }
}

export function createMySqlImIntegrationRepository(executor: MySqlImIntegrationExecutor): ImIntegrationRepository {
  return new MySqlImIntegrationRepository(executor)
}

export const mysqlImIntegrationRepository = createMySqlImIntegrationRepository(db as unknown as MySqlImIntegrationExecutor)
