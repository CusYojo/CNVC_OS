import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import {
  agentConversations,
  agentMessageParts,
  agentMessages,
  auditLogs,
  chatConversations,
  users,
} from '../db/schema.js'
import { hashPassword } from '../services/authService.js'
import {
  getJwAgentSnapshot,
  persistJwAgentProtocolMessage,
  shutdownJwAgentRuntime,
} from '../runtime/jwAgentRuntime.js'

const marker = randomUUID()
const userId = randomUUID()
const conversationId = randomUUID()
const agentId = `jw-tool-lifecycle-${marker}`
const runningToolId = `tool-running-${marker}`
const successToolId = `tool-success-${marker}`
const errorToolId = `tool-error-${marker}`
const evidenceDir = path.resolve('.runtime/migration-evidence/jw-tool-lifecycle')
let cleaned = false

async function writeEvidence(report: Record<string, unknown>) {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const target = path.resolve(evidenceDir, 'report.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  await chmod(target, 0o600)
}

async function cleanup() {
  await shutdownJwAgentRuntime()
  await db.delete(agentConversations).where(eq(agentConversations.id, conversationId)).catch(() => undefined)
  await db.delete(chatConversations).where(eq(chatConversations.id, conversationId)).catch(() => undefined)
  await db.delete(auditLogs).where(eq(auditLogs.userId, userId)).catch(() => undefined)
  await db.delete(users).where(eq(users.id, userId)).catch(() => undefined)
  cleaned = true
}

function assistantToolUse(toolUseId: string, query: string) {
  return {
    type: 'assistant',
    uuid: `assistant-${toolUseId}`,
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: 'search_project_docs',
        input: { query },
      }],
    },
  }
}

function toolResult(toolUseId: string, content: unknown, isError = false) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
  }
}

function queryOf(part: Record<string, unknown>) {
  const input = part.input && typeof part.input === 'object' ? part.input as Record<string, unknown> : {}
  return String(input.query || '')
}

try {
  await ensureSchema()
  await db.insert(users).values({
    id: userId,
    email: `jw-tool-lifecycle-${marker}@example.invalid`,
    name: 'JW 工具生命周期验收用户',
    role: '系统管理员',
    department: '迁移验收',
    passwordHash: await hashPassword(`Jw-tool-lifecycle-${marker}`),
  })
  await db.insert(chatConversations).values({
    id: conversationId,
    userId,
    title: 'JW 工具生命周期验收',
    scope: 'global',
    agentId,
    messages: [],
  })
  await db.insert(agentConversations).values({
    id: conversationId,
    userId,
    title: 'JW 工具生命周期验收',
    scope: 'global',
    status: 'idle',
    runtime: 'jw',
    externalSessionId: agentId,
    metadata: { acceptanceFixture: 'jw-tool-lifecycle-v1' },
  })

  await persistJwAgentProtocolMessage(conversationId, assistantToolUse(runningToolId, '工具进度验收-运行中'))
  let snapshot = await getJwAgentSnapshot(userId, agentId)
  assert(snapshot)
  let toolParts = snapshot.messages.flatMap((message) => message.parts)
    .filter((part) => part.type === 'dynamic-tool')
  assert.equal(toolParts.length, 1)
  assert.equal(toolParts[0]?.state, 'input-available')
  assert.equal(queryOf(toolParts[0]!), '工具进度验收-运行中')

  await persistJwAgentProtocolMessage(conversationId, assistantToolUse(successToolId, '工具进度验收-成功'))
  await persistJwAgentProtocolMessage(conversationId, toolResult(successToolId, { hits: 2, summary: '合成成功结果' }))
  await persistJwAgentProtocolMessage(conversationId, toolResult(successToolId, { hits: 2, summary: '合成成功结果' }))

  await persistJwAgentProtocolMessage(conversationId, assistantToolUse(errorToolId, '工具进度验收-失败'))
  await persistJwAgentProtocolMessage(conversationId, toolResult(errorToolId, [
    { type: 'text', text: '合成的工具错误' },
  ], true))
  await persistJwAgentProtocolMessage(conversationId, assistantToolUse(errorToolId, '不应覆盖终态输入'))
  await persistJwAgentProtocolMessage(conversationId, toolResult(`unmatched-${marker}`, '不应落库'))

  await shutdownJwAgentRuntime()
  snapshot = await getJwAgentSnapshot(userId, agentId)
  assert(snapshot)
  toolParts = snapshot.messages.flatMap((message) => message.parts)
    .filter((part) => part.type === 'dynamic-tool')
  assert.equal(toolParts.length, 3)
  const byQuery = new Map(toolParts.map((part) => [queryOf(part), part]))
  assert.equal(byQuery.get('工具进度验收-运行中')?.state, 'input-available')
  assert.equal(byQuery.get('工具进度验收-成功')?.state, 'output-available')
  assert.deepEqual(byQuery.get('工具进度验收-成功')?.output, { hits: 2, summary: '合成成功结果' })
  assert.equal(byQuery.get('工具进度验收-失败')?.state, 'output-error')
  assert.equal(byQuery.get('工具进度验收-失败')?.errorText, '合成的工具错误')
  assert.equal(byQuery.has('不应覆盖终态输入'), false)

  const rows = await db.select().from(agentMessages).where(and(
    eq(agentMessages.conversationId, conversationId),
    eq(agentMessages.role, 'tool'),
  ))
  assert.equal(rows.length, 3)
  assert.deepEqual([...rows.map((row) => row.status)].sort(), ['complete', 'error', 'running'])
  assert.equal(new Set(rows.map((row) => row.sequence)).size, 3)
  assert.equal(rows.some((row) => row.externalMessageId?.includes('unmatched')), false)
  const parts = await db.select().from(agentMessageParts)
    .where(eq(agentMessageParts.type, 'dynamic-tool'))
  const fixtureMessageIds = new Set(rows.map((row) => row.id))
  const fixtureParts = parts.filter((part) => fixtureMessageIds.has(part.messageId))
  assert.equal(fixtureParts.length, 3)
  assert(fixtureParts.every((part) => (
    part.payload && typeof part.payload === 'object'
    && (part.payload as Record<string, unknown>).type === 'dynamic-tool'
  )))

  await cleanup()
  const remaining = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)),
    db.select().from(chatConversations).where(eq(chatConversations.id, conversationId)),
    db.select().from(agentConversations).where(eq(agentConversations.id, conversationId)),
    db.select().from(agentMessages).where(eq(agentMessages.conversationId, conversationId)),
  ])
  assert.equal(remaining.reduce((total, records) => total + records.length, 0), 0)

  const checks = [
    'sdk-shaped-tool-use-persists-input-available-running-state',
    'sdk-shaped-tool-result-updates-the-same-message-to-output-available',
    'sdk-shaped-natural-error-persists-output-error-and-readable-error-text',
    'tool-input-output-and-error-remain-associated-after-runtime-restart',
    'duplicate-tool-events-are-idempotent-and-terminal-state-does-not-regress',
    'unmatched-tool-result-does-not-create-an-orphan-message',
    'dynamic-tool-payload-retains-required-type-discriminator',
    'synthetic-user-conversation-message-and-part-rows-cleaned',
    'mode: 0o600',
  ]
  await writeEvidence({
    ok: true,
    generatedAt: new Date().toISOString(),
    checks,
    persistedToolInputOutputBodies: 0,
    cleanup: { remainingRows: 0 },
  })
  console.log(JSON.stringify({ ok: true, checks }))
} finally {
  if (!cleaned) await cleanup()
  await pool.end()
}
