import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import {
  agentConversations,
  agentMessageParts,
  agentMessages,
  chatConversations,
  users,
} from '../db/schema.js'
import {
  getJwAgentSnapshot,
  recoverInterruptedJwAgentSessions,
} from '../runtime/jwAgentRuntime.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function assertApplicationStopped() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 500)
  try {
    const response = await fetch('http://127.0.0.1:4100/api/health', { signal: controller.signal })
    if (response.ok) throw new Error('请先停止 4100 统一服务；恢复验收不能修改正在运行的流式会话')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('请先停止')) throw error
  } finally {
    clearTimeout(timeout)
  }
}

await assertApplicationStopped()
const marker = randomUUID()
const userId = randomUUID()
const conversationId = randomUUID()
const agentId = `jw-restart-${marker}`
const userMessageId = randomUUID()
const toolMessageId = randomUUID()

try {
  await db.insert(users).values({
    id: userId,
    email: `jw-restart-${marker}@example.invalid`,
    name: 'JW 重启恢复验收',
    role: '系统管理员',
    department: '测试',
    passwordHash: 'restart-recovery-not-for-login',
  })
  await db.insert(chatConversations).values({
    id: conversationId,
    userId,
    title: 'JW 重启恢复验收',
    scope: 'global',
    agentId,
    messages: [],
  })
  await db.insert(agentConversations).values({
    id: conversationId,
    userId,
    title: 'JW 重启恢复验收',
    scope: 'global',
    status: 'streaming',
    runtime: 'jw',
    externalSessionId: agentId,
    metadata: { sdkSessionId: `sdk-${marker}`, retained: 'yes' },
  })
  await db.insert(agentMessages).values([
    {
      id: userMessageId,
      conversationId,
      externalMessageId: `user-${marker}`,
      role: 'user',
      sequence: 0,
      content: '重启前已经持久化的问题',
      status: 'complete',
    },
    {
      id: toolMessageId,
      conversationId,
      externalMessageId: `tool-${marker}`,
      role: 'tool',
      sequence: 1,
      toolName: 'search_project_docs',
      toolInput: { query: '恢复测试' },
      status: 'running',
    },
  ])
  await db.insert(agentMessageParts).values([
    { messageId: userMessageId, partIndex: 0, type: 'text', content: '重启前已经持久化的问题' },
    {
      messageId: toolMessageId,
      partIndex: 0,
      type: 'dynamic-tool',
      payload: { toolName: 'search_project_docs', state: 'input-available', input: { query: '恢复测试' } },
    },
  ])

  const first = await recoverInterruptedJwAgentSessions()
  assert(first.conversations >= 1, 'streaming conversation was not recovered')
  assert(first.messages >= 1, 'running tool message was not interrupted')
  assert(first.parts >= 1, 'running tool part was not finalized')

  const [conversation] = await db.select().from(agentConversations)
    .where(eq(agentConversations.id, conversationId)).limit(1)
  assert(conversation?.status === 'idle', 'recovered conversation is not idle')
  assert(conversation.metadata?.retained === 'yes', 'existing conversation metadata was lost')
  assert(conversation.metadata?.recoveredAfterRestart === true, 'restart recovery audit marker is missing')
  assert(typeof conversation.metadata?.interruptedAt === 'string', 'restart interruption timestamp is missing')

  const [toolMessage] = await db.select().from(agentMessages)
    .where(eq(agentMessages.id, toolMessageId)).limit(1)
  assert(toolMessage?.status === 'interrupted', 'running tool message status was not interrupted')
  assert((toolMessage?.toolOutput as { error?: string })?.error === 'service_restart', 'tool interruption reason is missing')
  const [toolPart] = await db.select().from(agentMessageParts)
    .where(and(eq(agentMessageParts.messageId, toolMessageId), eq(agentMessageParts.partIndex, 0))).limit(1)
  assert((toolPart?.payload as { state?: string })?.state === 'output-error', 'tool part did not become an error result')

  const snapshot = await getJwAgentSnapshot(userId, agentId)
  assert(snapshot?.status === 'idle', 'snapshot did not recover to idle')
  assert(snapshot?.messages.length === 2, 'persisted restart snapshot message count differs')
  assert(snapshot.messages[0]?.role === 'user', 'message order was not preserved')
  const second = await recoverInterruptedJwAgentSessions()
  assert(second.conversations === 0 && second.messages === 0 && second.parts === 0, 'restart recovery is not idempotent')

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'streaming-conversation-recovery',
      'running-tool-interruption',
      'tool-part-finalization',
      'metadata-preservation',
      'mysql-snapshot-recovery',
      'message-order-preservation',
      'idempotent-recovery',
    ],
  }))
} finally {
  await db.delete(agentConversations).where(eq(agentConversations.id, conversationId)).catch(() => {})
  await db.delete(chatConversations).where(eq(chatConversations.id, conversationId)).catch(() => {})
  await db.delete(users).where(eq(users.id, userId)).catch(() => {})
  await pool.end()
}
