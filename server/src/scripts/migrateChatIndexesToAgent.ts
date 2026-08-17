import { eq, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { agentConversations, agentMessages, chatConversations } from '../db/schema.js'
import { ensureSchema } from '../db/migrate.js'

type LegacyMessage = {
  id?: unknown
  role?: unknown
  content?: unknown
  toolName?: unknown
  toolInput?: unknown
  toolOutput?: unknown
  thinking?: unknown
  createdAt?: unknown
  timestamp?: unknown
}

function messageDate(message: LegacyMessage, fallback: Date): Date {
  const value = message.createdAt ?? message.timestamp
  if (typeof value !== 'string' && typeof value !== 'number') return fallback
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? fallback : date
}

function textValue(value: unknown): string | null {
  if (value == null) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

await ensureSchema()
try {
  const legacyRows = await db.select().from(chatConversations).orderBy(chatConversations.createdAt)
  let migratedMessages = 0

  for (const legacy of legacyRows) {
    await db.insert(agentConversations).values({
      id: legacy.id,
      userId: legacy.userId!,
      projectId: legacy.projectId,
      title: legacy.title,
      scope: legacy.scope,
      status: 'closed',
      runtime: 'legacy-index',
      externalSessionId: legacy.agentId,
      legacySource: 'legacy_postgres',
      legacyConversationId: legacy.id,
      metadata: { projectName: legacy.projectName },
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
    }).onDuplicateKeyUpdate({
      set: {
        title: sql`VALUES(${agentConversations.title})`,
        projectId: sql`VALUES(${agentConversations.projectId})`,
        externalSessionId: sql`VALUES(${agentConversations.externalSessionId})`,
        updatedAt: sql`VALUES(${agentConversations.updatedAt})`,
      },
    })

    const messages = Array.isArray(legacy.messages) ? legacy.messages as LegacyMessage[] : []
    for (const [sequence, message] of messages.entries()) {
      const externalMessageId = typeof message.id === 'string' && message.id.trim()
        ? message.id.trim()
        : `legacy-${sequence}`
      const role = typeof message.role === 'string' && message.role.trim() ? message.role.trim() : 'assistant'
      await db.insert(agentMessages).values({
        conversationId: legacy.id,
        externalMessageId,
        role: role.slice(0, 16),
        sequence,
        content: textValue(message.content),
        toolName: typeof message.toolName === 'string' ? message.toolName.slice(0, 128) : null,
        toolInput: message.toolInput,
        toolOutput: message.toolOutput,
        thinking: textValue(message.thinking),
        createdAt: messageDate(message, legacy.createdAt),
      }).onDuplicateKeyUpdate({
        set: {
          content: sql`VALUES(${agentMessages.content})`,
          toolOutput: sql`VALUES(${agentMessages.toolOutput})`,
          thinking: sql`VALUES(${agentMessages.thinking})`,
        },
      })
      migratedMessages += 1
    }
  }

  const [conversationCount] = await db.select({ count: sql<number>`count(*)` }).from(agentConversations)
    .where(eq(agentConversations.legacySource, 'legacy_postgres'))
  const [messageCount] = await db.select({ count: sql<number>`count(*)` }).from(agentMessages)
  if (Number(conversationCount.count) !== legacyRows.length || Number(messageCount.count) < migratedMessages) {
    throw new Error('agent conversation normalization verification failed')
  }
  console.log(JSON.stringify({
    ok: true,
    legacyConversations: legacyRows.length,
    normalizedConversations: Number(conversationCount.count),
    normalizedMessages: migratedMessages,
  }))
} finally {
  await pool.end()
}
