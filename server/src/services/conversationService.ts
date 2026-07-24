import { randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { chatConversations } from '../db/schema.js'

export type ChatMessageRow = {
  id: string
  role: 'user' | 'assistant'
  content: string
  kind?: 'project-qa'
  metadata?: Record<string, unknown>
  sources?: string[]
  confidence?: number
  createdAt?: string
}

// 列出当前用户的会话（不含消息体，列表更轻）
export async function listConversations(userId: string) {
  const rows = await db.select().from(chatConversations)
    .where(eq(chatConversations.userId, userId))
    .orderBy(desc(chatConversations.updatedAt))
    .limit(100)
  return rows.map(({ messages, ...rest }) => ({
    ...rest,
    messageCount: Array.isArray(messages) ? messages.length : 0,
  }))
}

// 取单个会话（含全部消息）
export async function getConversation(userId: string, id: string) {
  const rows = await db.select().from(chatConversations)
    .where(and(eq(chatConversations.id, id), eq(chatConversations.userId, userId)))
    .limit(1)
  return rows[0]
}

export async function createConversation(userId: string, input: {
  title?: string; scope?: string; projectId?: string | null; projectName?: string | null; agentId?: string
}) {
  const [row] = await db.insert(chatConversations).values({
    userId,
    title: input.title || '新会话',
    scope: input.scope || 'project',
    projectId: input.projectId || null,
    projectName: input.projectName || null,
    // flue agent 实例 id：可由前端指定（迁移旧 localStorage 会话时保留其 conv-xxx），否则服务端生成
    agentId: input.agentId || `conv-${randomUUID()}`,
    messages: [],
  }).returning()
  return row
}

// 仅改标题（会话内容在 flue，不经本表）
export async function renameConversation(userId: string, id: string, title: string) {
  const [row] = await db.update(chatConversations)
    .set({ title: title.slice(0, 40), updatedAt: new Date() })
    .where(and(eq(chatConversations.id, id), eq(chatConversations.userId, userId)))
    .returning()
  return row
}

// 追加一批消息（通常一次追加一条 user + 一条 assistant），并可更新标题
export async function appendMessages(userId: string, id: string, newMessages: ChatMessageRow[], title?: string) {
  const conv = await getConversation(userId, id)
  if (!conv) return undefined
  const merged = [...(conv.messages as ChatMessageRow[]), ...newMessages]
  const patch: Record<string, unknown> = { messages: merged, updatedAt: new Date() }
  // 首条用户消息自动作为标题（会话仍是默认名时）
  if (title) patch.title = title.slice(0, 40)
  else if (conv.title === '新会话') {
    const firstUser = merged.find((m) => m.role === 'user')
    if (firstUser) patch.title = firstUser.content.slice(0, 40)
  }
  const [row] = await db.update(chatConversations).set(patch)
    .where(and(eq(chatConversations.id, id), eq(chatConversations.userId, userId)))
    .returning()
  return row
}

export async function deleteConversation(userId: string, id: string) {
  const res = await db.delete(chatConversations)
    .where(and(eq(chatConversations.id, id), eq(chatConversations.userId, userId)))
    .returning()
  return res.length > 0
}
