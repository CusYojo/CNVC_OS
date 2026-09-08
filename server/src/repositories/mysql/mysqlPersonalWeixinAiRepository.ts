import { createHash, randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'

import { db } from '../../db/client.js'
import { agentConversations, auditLogs, imBotBindings, imBots, roles, userRoles, users } from '../../db/schema.js'
import { encryptIntegrationCredential } from '../../security/integrationCredentialCrypto.js'
import { PERSONAL_WEIXIN_MODE } from '../../contracts/personalWeixinAiContract.js'
import type {
  PersonalWeixinAiRecord,
  PersonalWeixinAiRepository,
} from '../../services/personalWeixinAiService.js'

const personalBotCondition = sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(${imBots.config}, '$.ownershipMode'))=${PERSONAL_WEIXIN_MODE}`

function businessRoleCondition(userId: string) {
  return sql<boolean>`(EXISTS (SELECT 1 FROM ${userRoles} pur JOIN ${roles} pr ON pr.id=pur.role_id WHERE pur.user_id=${userId} AND pr.status='启用' AND pr.fde_category IS NOT NULL AND pr.fde_category<>'system_admin') OR (${users.role}<>'系统管理员' AND NOT EXISTS (SELECT 1 FROM ${userRoles} lur WHERE lur.user_id=${users.id})))`
}

function record(row: typeof imBots.$inferSelect): PersonalWeixinAiRecord {
  return {
    botId: row.id,
    version: row.version,
    enabled: row.enabled,
    config: row.config,
    lastConnectedAt: row.lastConnectedAt,
  }
}

function audit(actor: { userId: string; userName: string; ip?: string }, action: string, target: string) {
  return {
    userId: actor.userId,
    userName: actor.userName,
    module: '微信AI',
    action,
    target,
    ip: actor.ip,
    result: 'success',
  }
}

class MySqlPersonalWeixinAiRepository implements PersonalWeixinAiRepository {
  async eligibility(userId: string) {
    const [row] = await db.select({ allowed: businessRoleCondition(userId).mapWith(Boolean) })
      .from(users).where(and(eq(users.id, userId), eq(users.status, '启用'))).limit(1)
    const eligible = Boolean(row?.allowed)
    return { eligible, reason: eligible ? null : '当前账号不可用或仅有系统管理职责' }
  }

  async findForUser(userId: string) {
    const [row] = await db.select().from(imBots).where(and(
      eq(imBots.platform, 'wechat'),
      eq(imBots.createdBy, userId),
      personalBotCondition,
    )).limit(1)
    return row ? record(row) : null
  }

  async connect(input: Parameters<PersonalWeixinAiRepository['connect']>[0]) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT ${users.id} FROM ${users} WHERE ${users.id}=${input.actor.userId} FOR UPDATE`)
      const [owner] = await tx.select({
        id: users.id, department: users.department,
        allowed: businessRoleCondition(input.actor.userId).mapWith(Boolean),
      }).from(users)
        .where(and(eq(users.id, input.actor.userId), eq(users.status, '启用'))).limit(1)
      if (!owner?.allowed) throw Object.assign(new Error('当前账号不可用或仅有系统管理职责'), { code: 'PERSONAL_WEIXIN_FORBIDDEN', status: 403 })

      const [existing] = await tx.select().from(imBots).where(and(
        eq(imBots.platform, 'wechat'), eq(imBots.createdBy, input.actor.userId), personalBotCondition,
      )).limit(1)
      const botId = existing?.id ?? randomUUID()
      const connectedAt = new Date()
      const credentials = {
        transport: 'ilink', accountId: input.accountId, botToken: input.botToken, baseUrl: input.baseUrl,
        inboundSecret: createHash('sha256').update(`${randomUUID()}:${input.accountId}`).digest('hex'),
      }
      const encrypted = encryptIntegrationCredential(credentials, botId)
      const config = {
        ...(existing?.config ?? {}), transport: 'ilink', ownershipMode: PERSONAL_WEIXIN_MODE,
        accountId: input.accountId, accountUserId: input.accountUserId, connectedAt: connectedAt.toISOString(),
      }

      if (existing) {
        await tx.update(imBots).set({
          credentialCiphertext: encrypted.ciphertext, credentialHint: encrypted.hint,
          credentialFingerprint: encrypted.fingerprint, config, enabled: false,
          connectionStatus: 'disconnected', lastConnectedAt: null, lastError: null,
          updatedBy: input.actor.userId, updatedAt: connectedAt, version: sql`${imBots.version} + 1`,
        }).where(eq(imBots.id, botId))
      } else {
        await tx.insert(imBots).values({
          id: botId, platform: 'wechat', name: `个人微信 AI ${input.actor.userId.slice(0, 8)} ${botId.slice(0, 8)}`,
          credentialCiphertext: encrypted.ciphertext, credentialHint: encrypted.hint,
          credentialFingerprint: encrypted.fingerprint, config, enabled: false,
          connectionStatus: 'disconnected', createdBy: input.actor.userId, updatedBy: input.actor.userId,
        })
      }

      await tx.update(imBotBindings).set({ enabled: false, updatedBy: input.actor.userId, updatedAt: connectedAt, version: sql`${imBotBindings.version} + 1` })
        .where(and(eq(imBotBindings.botId, botId), eq(imBotBindings.enabled, true)))

      const externalConversationId = `${input.accountId}:${input.accountUserId}`
      const [previousBinding] = await tx.select().from(imBotBindings).where(and(
        eq(imBotBindings.botId, botId), eq(imBotBindings.externalConversationId, externalConversationId),
      )).limit(1)
      let conversationId = previousBinding?.conversationId ?? null
      if (!conversationId) {
        conversationId = randomUUID()
        await tx.insert(agentConversations).values({
          id: conversationId, userId: input.actor.userId, title: '微信 AI', scope: 'global',
          status: 'idle', runtime: 'jw', metadata: { source: 'weixin', ownershipMode: PERSONAL_WEIXIN_MODE },
        })
      }
      if (previousBinding) {
        await tx.update(imBotBindings).set({
          userId: input.actor.userId, conversationId, department: owner.department, enabled: true,
          updatedBy: input.actor.userId, updatedAt: connectedAt, version: sql`${imBotBindings.version} + 1`,
        }).where(eq(imBotBindings.id, previousBinding.id))
      } else {
        await tx.insert(imBotBindings).values({
          id: randomUUID(), botId, externalConversationId, userId: input.actor.userId,
          projectId: null, conversationId, department: owner.department, enabled: true,
          createdBy: input.actor.userId, updatedBy: input.actor.userId,
        })
      }
      await tx.update(imBots).set({
        enabled: true, connectionStatus: 'connected', lastConnectedAt: connectedAt,
        updatedBy: input.actor.userId, updatedAt: connectedAt,
      }).where(eq(imBots.id, botId))
      await tx.insert(auditLogs).values(audit(input.actor, '连接个人微信 AI', botId))
      const [connected] = await tx.select().from(imBots).where(eq(imBots.id, botId)).limit(1)
      if (!connected) throw new Error('个人微信 AI 连接后无法读取')
      return record(connected)
    })
  }

  async disconnect(input: Parameters<PersonalWeixinAiRepository['disconnect']>[0]) {
    return db.transaction(async (tx) => {
      const [existing] = await tx.select().from(imBots).where(and(
        eq(imBots.platform, 'wechat'), eq(imBots.createdBy, input.actor.userId), personalBotCondition,
      )).limit(1)
      if (!existing) return 'not_found' as const
      await tx.execute(sql`SELECT ${imBots.id} FROM ${imBots} WHERE ${imBots.id}=${existing.id} FOR UPDATE`)
      const [locked] = await tx.select().from(imBots).where(eq(imBots.id, existing.id)).limit(1)
      if (!locked) return 'not_found' as const
      if (locked.version !== input.expectedVersion) return 'conflict' as const
      const changedAt = new Date()
      await tx.update(imBotBindings).set({ enabled: false, updatedBy: input.actor.userId, updatedAt: changedAt, version: sql`${imBotBindings.version} + 1` })
        .where(and(eq(imBotBindings.botId, locked.id), eq(imBotBindings.enabled, true)))
      await tx.update(imBots).set({
        enabled: false, connectionStatus: 'disconnected', lastConnectedAt: null, lastError: null,
        updatedBy: input.actor.userId, updatedAt: changedAt, version: sql`${imBots.version} + 1`,
      }).where(and(eq(imBots.id, locked.id), eq(imBots.version, input.expectedVersion)))
      await tx.insert(auditLogs).values(audit(input.actor, '断开个人微信 AI', locked.id))
      const [updated] = await tx.select().from(imBots).where(eq(imBots.id, locked.id)).limit(1)
      if (!updated) return 'not_found' as const
      return { status: 'ok' as const, record: record(updated) }
    })
  }
}

export const mysqlPersonalWeixinAiRepository = new MySqlPersonalWeixinAiRepository()
