import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { agentConversations, agentMessageParts, agentMessages, chatConversations, users } from '../db/schema.js'
import { agentConversationRepository } from '../repositories/index.js'
import { hashPassword } from '../services/authService.js'

async function main() {
  const marker = randomUUID()
  const [user] = await db.insert(users).values({
    email: `agent-repository-${marker}@example.invalid`,
    name: `Agent仓储-${marker.slice(0, 8)}`,
    role: '投资经理',
    department: 'Repository验收部',
    passwordHash: await hashPassword(`Agent-Repo-A9!-${marker}`),
  }).$returningId()
  const conversationId = randomUUID()
  const failedConversationId = randomUUID()
  try {
    const created = await agentConversationRepository.createConversationPair({
      id: conversationId,
      userId: user.id,
      title: 'Agent Repository 验收',
      scope: 'global',
      projectId: null,
      projectName: null,
      externalSessionId: `agent-${marker}`,
      modelId: null,
    })
    if (created.id !== conversationId || !await agentConversationRepository.findAgentById(conversationId)) {
      throw new Error('conversation pair did not commit atomically')
    }

    const failed = await agentConversationRepository.createConversationPair({
      id: failedConversationId,
      userId: user.id,
      title: '应回滚会话',
      scope: 'global',
      projectId: null,
      projectName: null,
      externalSessionId: `rollback-${marker}`,
      modelId: 'x'.repeat(200),
    }).then(() => null, (error: unknown) => error)
    if (!failed) throw new Error('invalid agent row did not fail')
    const [partialChat] = await db.select({ id: chatConversations.id }).from(chatConversations)
      .where(eq(chatConversations.id, failedConversationId)).limit(1)
    if (partialChat) throw new Error('failed pair creation left a partial chat index')

    const writes = await Promise.all(Array.from({ length: 12 }, (_, index) => (
      agentConversationRepository.saveMessage({
        conversationId,
        externalMessageId: `parallel:${index}`,
        role: index % 2 ? 'assistant' : 'user',
        content: `message-${index}`,
        parts: [{ type: 'text', content: `message-${index}` }],
      })
    )))
    const sequences = writes.map((row) => row.sequence).sort((a, b) => a - b)
    if (sequences.some((sequence, index) => sequence !== index)) {
      throw new Error(`parallel sequence allocation is not contiguous: ${sequences.join(',')}`)
    }

    await Promise.all([
      agentConversationRepository.appendChatMessages(user.id, conversationId, [{ marker: 'left' }]),
      agentConversationRepository.appendChatMessages(user.id, conversationId, [{ marker: 'right' }]),
    ])
    const chatAfterAppend = await agentConversationRepository.findChatByIdForUser(user.id, conversationId)
    const markers = new Set(chatAfterAppend?.messages.map((item) => (item as { marker?: string }).marker))
    if (!markers.has('left') || !markers.has('right') || chatAfterAppend?.messages.length !== 2) {
      throw new Error('concurrent chat index append lost a message')
    }

    await agentConversationRepository.saveMessage({
      conversationId,
      externalMessageId: 'tool:stable',
      role: 'tool',
      toolName: 'stable_tool',
      status: 'running',
      parts: [{ type: 'dynamic-tool', payload: { type: 'dynamic-tool', state: 'input-available' } }],
    })
    await agentConversationRepository.saveMessage({
      conversationId,
      externalMessageId: 'tool:stable',
      role: 'tool',
      toolName: 'stable_tool',
      status: 'complete',
      toolOutput: { ok: true },
      parts: [{ type: 'dynamic-tool', payload: { type: 'dynamic-tool', state: 'output-available' } }],
    })
    await agentConversationRepository.saveMessage({
      conversationId,
      externalMessageId: 'tool:stable',
      role: 'tool',
      status: 'running',
      preserveTerminalStatus: true,
      parts: [{ type: 'dynamic-tool', payload: { type: 'dynamic-tool', state: 'input-available' } }],
    })
    const stableTool = await agentConversationRepository.findMessageByExternalId(conversationId, 'tool:stable')
    const stableSnapshot = await agentConversationRepository.listMessagesWithParts(conversationId)
    const stableParts = stableSnapshot.find(({ message }) => message.id === stableTool?.id)?.parts || []
    if (
      stableTool?.status !== 'complete'
      || (stableParts[0]?.payload as { state?: string })?.state !== 'output-available'
    ) throw new Error('replayed tool_use regressed a terminal tool state')

    await Promise.all([
      agentConversationRepository.mergeConversationState(conversationId, 'idle', { patchLeft: marker }),
      agentConversationRepository.mergeConversationState(conversationId, 'idle', { patchRight: marker }),
    ])
    const merged = await agentConversationRepository.findAgentById(conversationId)
    if (merged?.metadata.patchLeft !== marker || merged.metadata.patchRight !== marker) {
      throw new Error('concurrent metadata merge lost a committed patch')
    }

    await agentConversationRepository.saveMessage({
      conversationId,
      externalMessageId: 'tool:interrupt',
      role: 'tool',
      toolName: 'interrupt_tool',
      status: 'running',
      parts: [{ type: 'dynamic-tool', payload: { type: 'dynamic-tool', state: 'input-available' } }],
    })
    const interrupted = await agentConversationRepository.interruptRunningTools({
      conversationId,
      reason: 'acceptance_stop',
      interruptedAt: new Date(),
      partErrorText: '验收中断',
    })
    const interruptedTool = await agentConversationRepository.findMessageByExternalId(conversationId, 'tool:interrupt')
    const interruptedSnapshot = await agentConversationRepository.listMessagesWithParts(conversationId)
    const interruptedPart = interruptedSnapshot.find(({ message }) => message.id === interruptedTool?.id)?.parts[0]
    if (
      interrupted !== 1
      || interruptedTool?.status !== 'interrupted'
      || (interruptedPart?.payload as { state?: string })?.state !== 'output-error'
    ) throw new Error('tool interruption did not update message and part atomically')

    const persistedMessages = await db.select().from(agentMessages)
      .where(eq(agentMessages.conversationId, conversationId))
    const uniqueExternalIds = new Set(persistedMessages.map((message) => message.externalMessageId))
    if (persistedMessages.length !== uniqueExternalIds.size) throw new Error('message replay created duplicate rows')

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'conversation-pair-atomic-commit',
        'conversation-pair-failure-rollback',
        'parallel-message-sequence-serialization',
        'parallel-chat-index-append-no-lost-update',
        'external-message-idempotent-terminal-replay',
        'concurrent-metadata-merge-no-lost-update',
        'tool-message-part-atomic-interruption',
      ],
    }))
  } finally {
    await db.delete(agentConversations).where(eq(agentConversations.id, conversationId))
    await db.delete(chatConversations).where(eq(chatConversations.id, conversationId))
    await db.delete(chatConversations).where(eq(chatConversations.id, failedConversationId))
    await db.delete(users).where(eq(users.id, user.id))
  }
}

await main().finally(async () => pool.end())
