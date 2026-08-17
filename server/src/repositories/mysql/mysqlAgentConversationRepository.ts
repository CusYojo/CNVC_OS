import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from '../../db/client.js'
import {
  agentConversations,
  agentMessageParts,
  agentMessages,
  chatConversations,
} from '../../db/schema.js'
import { isMySqlDriverError, isRepositoryError, mapMySqlRepositoryError } from '../contracts.js'
import type {
  AgentConversationRecord,
  AgentConversationRepository,
  AgentMessageRecord,
  ChatConversationRecord,
  CreateConversationPairInput,
  SaveAgentMessageInput,
} from '../agentConversationRepository.js'

export type MySqlAgentExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function mapped<T>(operation: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (isRepositoryError(error)) throw error
    if (isMySqlDriverError(error)) throw mapMySqlRepositoryError(error, operation)
    throw error
  }
}

class MySqlAgentConversationRepository implements AgentConversationRepository {
  constructor(private readonly executor: MySqlAgentExecutor) {}

  async listChatsForUser(userId: string, limit = 100) {
    return mapped('agent.listChatsForUser', () => this.executor.select().from(chatConversations)
      .where(eq(chatConversations.userId, userId))
      .orderBy(desc(chatConversations.updatedAt), desc(chatConversations.id))
      .limit(Math.max(1, Math.min(1_000, Math.trunc(limit)))))
  }

  async findChatByIdForUser(userId: string, conversationId: string) {
    return mapped('agent.findChatByIdForUser', async () => {
      const [row] = await this.executor.select().from(chatConversations).where(and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.userId, userId),
      )).limit(1)
      return row ?? null
    })
  }

  async findChatByAgentForUser(userId: string, agentId: string) {
    return mapped('agent.findChatByAgentForUser', async () => {
      const [row] = await this.executor.select().from(chatConversations).where(and(
        eq(chatConversations.userId, userId),
        eq(chatConversations.agentId, agentId),
      )).limit(1)
      return row ?? null
    })
  }

  async findAgentById(conversationId: string) {
    return mapped('agent.findAgentById', async () => {
      const [row] = await this.executor.select().from(agentConversations)
        .where(eq(agentConversations.id, conversationId)).limit(1)
      return row ?? null
    })
  }

  async findOwnedAgentById(userId: string, conversationId: string) {
    return mapped('agent.findOwnedAgentById', async () => {
      const [row] = await this.executor.select().from(agentConversations).where(and(
        eq(agentConversations.id, conversationId), eq(agentConversations.userId, userId),
      )).limit(1)
      return row ?? null
    })
  }

  async findAgentModels(conversationIds: string[]) {
    if (!conversationIds.length) return []
    return mapped('agent.findAgentModels', () => this.executor.select({
      id: agentConversations.id,
      modelId: agentConversations.modelId,
    }).from(agentConversations).where(inArray(agentConversations.id, conversationIds)))
  }

  async listRecentAgents(limit = 500) {
    return mapped('agent.listRecentAgents', () => this.executor.select().from(agentConversations)
      .orderBy(desc(agentConversations.updatedAt), desc(agentConversations.id))
      .limit(Math.max(1, Math.min(5_000, Math.trunc(limit)))))
  }

  async ensureAgentFromChat(chat: ChatConversationRecord): Promise<AgentConversationRecord> {
    return mapped('agent.ensureAgentFromChat', async () => {
      const existing = await this.findAgentById(chat.id)
      if (existing) return existing
      await this.executor.insert(agentConversations).values({
        id: chat.id,
        userId: chat.userId!,
        projectId: chat.projectId,
        title: chat.title,
        scope: chat.scope,
        status: 'idle',
        runtime: 'jw',
        externalSessionId: chat.agentId,
        legacySource: 'legacy_postgres',
        legacyConversationId: chat.id,
        metadata: { projectName: chat.projectName },
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      }).onDuplicateKeyUpdate({ set: { externalSessionId: chat.agentId } })
      const created = await this.findAgentById(chat.id)
      if (!created) throw new Error('agent conversation cannot be reloaded after creation')
      return created
    })
  }

  async createConversationPair(input: CreateConversationPairInput) {
    return mapped('agent.createConversationPair', () => db.transaction(async (tx) => {
      const repository = createMySqlAgentConversationRepository(tx)
      await tx.insert(chatConversations).values({
        id: input.id,
        userId: input.userId,
        title: input.title,
        scope: input.scope,
        projectId: input.projectId,
        projectName: input.projectName,
        agentId: input.externalSessionId,
        messages: [],
      })
      await tx.insert(agentConversations).values({
        id: input.id,
        userId: input.userId,
        projectId: input.projectId,
        title: input.title,
        scope: input.scope,
        status: 'idle',
        runtime: 'jw',
        externalSessionId: input.externalSessionId,
        legacySource: 'chat_index',
        legacyConversationId: input.id,
        modelId: input.modelId,
        metadata: { projectName: input.projectName },
      })
      const row = await repository.findChatByIdForUser(input.userId, input.id)
      if (!row) throw new Error('chat conversation cannot be reloaded after creation')
      return row
    }))
  }

  async renameConversationPair(userId: string, conversationId: string, title: string) {
    return mapped('agent.renameConversationPair', () => db.transaction(async (tx) => {
      const now = new Date()
      await tx.update(chatConversations).set({ title, updatedAt: now }).where(and(
        eq(chatConversations.id, conversationId), eq(chatConversations.userId, userId),
      ))
      await tx.update(agentConversations).set({ title, updatedAt: now }).where(and(
        eq(agentConversations.id, conversationId), eq(agentConversations.userId, userId),
      ))
      return createMySqlAgentConversationRepository(tx).findChatByIdForUser(userId, conversationId)
    }))
  }

  async appendChatMessages(userId: string, conversationId: string, messages: unknown[], title?: string) {
    return mapped('agent.appendChatMessages', () => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT ${chatConversations.id} FROM ${chatConversations}
        WHERE ${chatConversations.id}=${conversationId} AND ${chatConversations.userId}=${userId} FOR UPDATE`)
      const repository = createMySqlAgentConversationRepository(tx)
      const current = await repository.findChatByIdForUser(userId, conversationId)
      if (!current) return null
      await tx.update(chatConversations).set({
        messages: [...current.messages, ...messages],
        ...(title ? { title } : {}),
        updatedAt: new Date(),
      }).where(and(eq(chatConversations.id, conversationId), eq(chatConversations.userId, userId)))
      return repository.findChatByIdForUser(userId, conversationId)
    }))
  }

  async deleteConversationPair(userId: string, conversationId: string) {
    return mapped('agent.deleteConversationPair', () => db.transaction(async (tx) => {
      const [deleted] = await tx.delete(agentConversations).where(and(
        eq(agentConversations.id, conversationId), eq(agentConversations.userId, userId),
      ))
      const [chatDeleted] = await tx.delete(chatConversations).where(and(
        eq(chatConversations.id, conversationId), eq(chatConversations.userId, userId),
      ))
      return deleted.affectedRows === 1 || chatDeleted.affectedRows === 1
    }))
  }

  async findMessageByExternalId(conversationId: string, externalMessageId: string) {
    return mapped('agent.findMessageByExternalId', async () => {
      const [row] = await this.executor.select().from(agentMessages).where(and(
        eq(agentMessages.conversationId, conversationId),
        eq(agentMessages.externalMessageId, externalMessageId),
      )).limit(1)
      return row ?? null
    })
  }

  async saveMessage(input: SaveAgentMessageInput): Promise<AgentMessageRecord> {
    return mapped('agent.saveMessage', () => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT ${agentConversations.id} FROM ${agentConversations}
        WHERE ${agentConversations.id}=${input.conversationId} FOR UPDATE`)
      const repository = createMySqlAgentConversationRepository(tx)
      const found = await repository.findMessageByExternalId(input.conversationId, input.externalMessageId)
      if (found && input.preserveTerminalStatus && ['complete', 'error', 'interrupted'].includes(found.status)) {
        return found
      }
      let messageId: string
      if (!found) {
        messageId = randomUUID()
        const [last] = await tx.select({ sequence: agentMessages.sequence }).from(agentMessages)
          .where(eq(agentMessages.conversationId, input.conversationId))
          .orderBy(desc(agentMessages.sequence)).limit(1)
        await tx.insert(agentMessages).values({
          id: messageId,
          conversationId: input.conversationId,
          externalMessageId: input.externalMessageId,
          role: input.role,
          sequence: last ? last.sequence + 1 : 0,
          content: input.content ?? null,
          thinking: input.thinking ?? null,
          toolName: input.toolName ?? null,
          toolInput: input.toolInput,
          toolOutput: input.toolOutput,
          status: input.status || 'complete',
        })
      } else {
        messageId = found.id
        await tx.update(agentMessages).set({
          content: input.content ?? found.content,
          thinking: input.thinking ?? found.thinking,
          toolName: input.toolName ?? found.toolName,
          toolInput: input.toolInput ?? found.toolInput,
          toolOutput: input.toolOutput ?? found.toolOutput,
          status: input.status || found.status,
        }).where(eq(agentMessages.id, messageId))
        await tx.delete(agentMessageParts).where(eq(agentMessageParts.messageId, messageId))
      }
      if (input.parts?.length) await tx.insert(agentMessageParts).values(input.parts.map((part, partIndex) => ({
        messageId: messageId!,
        partIndex,
        type: part.type,
        content: part.content ?? null,
        payload: part.payload,
      })))
      await tx.update(agentConversations).set({ updatedAt: new Date() })
        .where(eq(agentConversations.id, input.conversationId))
      const saved = await repository.findMessageByExternalId(input.conversationId, input.externalMessageId)
      if (!saved) throw new Error('agent message cannot be reloaded after save')
      return saved
    }))
  }

  async listMessagesWithParts(conversationId: string) {
    return mapped('agent.listMessagesWithParts', async () => {
      const messages = await this.executor.select().from(agentMessages)
        .where(eq(agentMessages.conversationId, conversationId))
        .orderBy(asc(agentMessages.sequence), asc(agentMessages.id))
      const messageIds = messages.map((message) => message.id)
      const parts = messageIds.length
        ? await this.executor.select().from(agentMessageParts).where(inArray(agentMessageParts.messageId, messageIds))
          .orderBy(asc(agentMessageParts.messageId), asc(agentMessageParts.partIndex))
        : []
      const byMessage = new Map<string, typeof parts>()
      for (const part of parts) byMessage.set(part.messageId, [...(byMessage.get(part.messageId) || []), part])
      return messages.map((message) => ({ message, parts: byMessage.get(message.id) || [] }))
    })
  }

  async mergeConversationState(conversationId: string, status: string, metadataPatch = {}) {
    return mapped('agent.mergeConversationState', () => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT ${agentConversations.id} FROM ${agentConversations}
        WHERE ${agentConversations.id}=${conversationId} FOR UPDATE`)
      const repository = createMySqlAgentConversationRepository(tx)
      const current = await repository.findAgentById(conversationId)
      if (!current) return null
      await tx.update(agentConversations).set({
        status,
        runtime: 'jw',
        metadata: { ...current.metadata, ...metadataPatch },
        updatedAt: new Date(),
      }).where(eq(agentConversations.id, conversationId))
      return repository.findAgentById(conversationId)
    }))
  }

  async updateModelForOwner(input: {
    conversationId: string; userId: string; modelId: string | null
    metadataPatch: Record<string, unknown>; updatedAt: Date
  }) {
    return mapped('agent.updateModelForOwner', async () => {
      const [updated] = await this.executor.update(agentConversations).set({
        modelId: input.modelId,
        metadata: input.metadataPatch,
        updatedAt: input.updatedAt,
      }).where(and(
        eq(agentConversations.id, input.conversationId),
        eq(agentConversations.userId, input.userId),
      ))
      return updated.affectedRows === 1
    })
  }

  async interruptRunningTools(input: {
    conversationId: string; reason: string; interruptedAt: Date; partErrorText: string
  }) {
    return mapped('agent.interruptRunningTools', () => db.transaction(async (tx) => {
      const running = await tx.select({ id: agentMessages.id }).from(agentMessages).where(and(
        eq(agentMessages.conversationId, input.conversationId), eq(agentMessages.status, 'running'),
      ))
      if (!running.length) return 0
      await interruptMessages(tx, running.map((message) => message.id), input)
      return running.length
    }))
  }

  async recoverStreamingSessions(input: {
    interruptedAt: Date; partErrorText: string
    metadataFor: (conversation: AgentConversationRecord) => Record<string, unknown>
  }) {
    return mapped('agent.recoverStreamingSessions', () => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT ${agentConversations.id} FROM ${agentConversations}
        WHERE ${agentConversations.status}='streaming' FOR UPDATE`)
      const stale = await tx.select().from(agentConversations).where(eq(agentConversations.status, 'streaming'))
      if (!stale.length) return { conversations: 0, messages: 0, parts: 0 }
      for (const conversation of stale) await tx.update(agentConversations).set({
        status: 'idle', metadata: input.metadataFor(conversation), updatedAt: input.interruptedAt,
      }).where(eq(agentConversations.id, conversation.id))
      const conversationIds = stale.map((conversation) => conversation.id)
      const running = await tx.select({ id: agentMessages.id }).from(agentMessages).where(and(
        inArray(agentMessages.conversationId, conversationIds), eq(agentMessages.status, 'running'),
      ))
      if (!running.length) return { conversations: stale.length, messages: 0, parts: 0 }
      const result = await interruptMessages(tx, running.map((message) => message.id), {
        reason: 'service_restart', interruptedAt: input.interruptedAt, partErrorText: input.partErrorText,
      })
      return { conversations: stale.length, messages: running.length, parts: result.parts }
    }))
  }
}

async function interruptMessages(
  tx: MySqlAgentExecutor,
  messageIds: string[],
  input: { reason: string; interruptedAt: Date; partErrorText: string },
) {
  const parts = await tx.select({ id: agentMessageParts.id, payload: agentMessageParts.payload })
    .from(agentMessageParts).where(and(
      inArray(agentMessageParts.messageId, messageIds), eq(agentMessageParts.type, 'dynamic-tool'),
    ))
  for (const part of parts) {
    const payload = part.payload && typeof part.payload === 'object' ? part.payload as Record<string, unknown> : {}
    await tx.update(agentMessageParts).set({
      payload: { ...payload, state: 'output-error', errorText: input.partErrorText },
    }).where(eq(agentMessageParts.id, part.id))
  }
  await tx.update(agentMessages).set({
    status: 'interrupted',
    toolOutput: { error: input.reason, interruptedAt: input.interruptedAt.toISOString() },
  }).where(inArray(agentMessages.id, messageIds))
  return { parts: parts.length }
}

export function createMySqlAgentConversationRepository(executor: MySqlAgentExecutor): AgentConversationRepository {
  return new MySqlAgentConversationRepository(executor)
}

export const mysqlAgentConversationRepository = createMySqlAgentConversationRepository(
  db as unknown as MySqlAgentExecutor,
)
