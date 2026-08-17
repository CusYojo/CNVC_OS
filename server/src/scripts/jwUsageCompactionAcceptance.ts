import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { agentConversations, chatConversations, users } from '../db/schema.js'
import { ensureSchema } from '../db/migrate.js'
import { hashPassword } from '../services/authService.js'
import {
  getJwAgentSnapshot,
  persistJwRuntimeEvent,
  projectJwRuntimeMetadata,
  shutdownJwAgentRuntime,
} from '../runtime/jwAgentRuntime.js'

const marker = randomUUID()
const userId = randomUUID()
const conversationId = randomUUID()
const agentId = `jw-usage-${marker}`
const evidenceDir = path.resolve('.runtime/migration-evidence/jw-usage-compaction')
let cleaned = false

async function writeEvidence(report: Record<string, unknown>): Promise<void> {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const target = path.resolve(evidenceDir, 'report.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  await chmod(target, 0o600)
}

async function cleanup(): Promise<void> {
  await shutdownJwAgentRuntime()
  await db.delete(agentConversations).where(eq(agentConversations.id, conversationId)).catch(() => undefined)
  await db.delete(chatConversations).where(eq(chatConversations.id, conversationId)).catch(() => undefined)
  await db.delete(users).where(eq(users.id, userId)).catch(() => undefined)
  cleaned = true
}

try {
  await ensureSchema()
  await db.insert(users).values({
    id: userId,
    email: `jw-usage-${marker}@example.invalid`,
    name: 'JW 用量与压缩验收',
    role: '系统管理员',
    department: '迁移验收',
    passwordHash: await hashPassword(`Jw-usage-${marker}`),
  })
  await db.insert(chatConversations).values({
    id: conversationId,
    userId,
    title: 'JW 用量与压缩验收',
    scope: 'global',
    agentId,
    messages: [],
  })
  await db.insert(agentConversations).values({
    id: conversationId,
    userId,
    title: 'JW 用量与压缩验收',
    scope: 'global',
    status: 'streaming',
    runtime: 'jw',
    externalSessionId: agentId,
    metadata: { retained: 'yes' },
  })

  await persistJwRuntimeEvent(conversationId, 'streaming', {
    type: 'system', subtype: 'init', session_id: `sdk-${marker}`, model: 'acceptance-model',
  }, '2026-08-10T01:00:00.000Z')
  await persistJwRuntimeEvent(conversationId, 'streaming', {
    type: 'system', subtype: 'status', status: 'compacting', uuid: `status-${marker}`,
  }, '2026-08-10T01:00:01.000Z')
  await persistJwRuntimeEvent(conversationId, 'streaming', {
    type: 'system', subtype: 'compact_boundary', uuid: `compact-auto-${marker}`,
    session_id: `sdk-${marker}`,
    compact_metadata: { trigger: 'auto', pre_tokens: 120_000, post_tokens: 32_000, duration_ms: 2_500 },
  }, '2026-08-10T01:00:02.000Z')
  // SDK 事件重放不得把同一个压缩边界重复计数。
  await persistJwRuntimeEvent(conversationId, 'streaming', {
    type: 'system', subtype: 'compact_boundary', uuid: `compact-auto-${marker}`,
    session_id: `sdk-${marker}`,
    compact_metadata: { trigger: 'auto', pre_tokens: 120_000, post_tokens: 32_000, duration_ms: 2_500 },
  }, '2026-08-10T01:00:03.000Z')

  await persistJwRuntimeEvent(conversationId, 'streaming', {
    type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'synthetic failure',
  }, '2026-08-10T01:00:04.000Z')
  const [failedRow] = await db.select({ metadata: agentConversations.metadata }).from(agentConversations)
    .where(eq(agentConversations.id, conversationId)).limit(1)
  assert.equal(failedRow?.metadata?.retained, 'yes')
  assert.equal((failedRow?.metadata?.contextCompaction as { state?: string })?.state, 'failed')

  await persistJwRuntimeEvent(conversationId, 'streaming', {
    type: 'system', subtype: 'status', status: 'compacting', uuid: `status-manual-${marker}`,
  }, '2026-08-10T01:00:05.000Z')
  await persistJwRuntimeEvent(conversationId, 'streaming', {
    type: 'system', subtype: 'status', status: null, uuid: `status-clear-${marker}`,
  }, '2026-08-10T01:00:05.500Z')
  const [clearedRow] = await db.select({ metadata: agentConversations.metadata }).from(agentConversations)
    .where(eq(agentConversations.id, conversationId)).limit(1)
  assert.equal((clearedRow?.metadata?.contextCompaction as { state?: string })?.state, 'idle')
  await persistJwRuntimeEvent(conversationId, 'streaming', {
    type: 'system', subtype: 'status', status: 'compacting', uuid: `status-manual-restart-${marker}`,
  }, '2026-08-10T01:00:05.750Z')
  await persistJwRuntimeEvent(conversationId, 'streaming', {
    type: 'system', subtype: 'compact_boundary', uuid: `compact-manual-${marker}`,
    session_id: `sdk-${marker}`,
    compact_metadata: { trigger: 'manual', pre_tokens: 80_000, post_tokens: 20_000, duration_ms: 1_500 },
  }, '2026-08-10T01:00:06.000Z')
  await persistJwRuntimeEvent(conversationId, 'idle', {
    type: 'result', subtype: 'success', is_error: false,
    total_cost_usd: 0.125, num_turns: 4, duration_ms: 9_500,
    usage: {
      input_tokens: 1_000,
      output_tokens: 250,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 2_000,
    },
  }, '2026-08-10T01:00:07.000Z')

  const snapshot = await getJwAgentSnapshot(userId, agentId)
  assert(snapshot)
  assert.equal(snapshot.status, 'idle')
  assert.equal(snapshot.runtime.model, 'acceptance-model')
  assert.deepEqual(snapshot.runtime.usage, {
    inputTokens: 1_000,
    outputTokens: 250,
    cacheCreationInputTokens: 300,
    cacheReadInputTokens: 2_000,
    totalInputTokens: 3_300,
    totalTokens: 3_550,
  })
  assert.equal(snapshot.runtime.totalCostUsd, 0.125)
  assert.equal(snapshot.runtime.numTurns, 4)
  assert.equal(snapshot.runtime.durationMs, 9_500)
  assert.equal(snapshot.runtime.contextCompaction.state, 'idle')
  assert.equal(snapshot.runtime.contextCompaction.count, 2)
  assert.equal(snapshot.runtime.contextCompaction.lastTrigger, 'manual')
  assert.equal(snapshot.runtime.contextCompaction.lastPreTokens, 80_000)
  assert.equal(snapshot.runtime.contextCompaction.lastPostTokens, 20_000)
  assert.equal(snapshot.runtime.contextCompaction.lastDurationMs, 1_500)
  assert.equal(snapshot.runtime.contextCompaction.lastResult, 'success')

  const invalidUsage = projectJwRuntimeMetadata({}, {
    type: 'result', is_error: false, usage: { input_tokens: -1, output_tokens: 1 },
  }, '2026-08-10T01:00:08.000Z')
  assert.equal((invalidUsage.lastResult as { usage?: unknown }).usage, null)

  await cleanup()
  const [remainingUser, remainingChat, remainingAgent] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.id, userId)),
    db.select({ id: chatConversations.id }).from(chatConversations).where(eq(chatConversations.id, conversationId)),
    db.select({ id: agentConversations.id }).from(agentConversations).where(eq(agentConversations.id, conversationId)),
  ])
  assert.equal(remainingUser.length + remainingChat.length + remainingAgent.length, 0)

  const checks = [
    'sdk-init-model-and-session-persisted',
    'result-token-cache-cost-turn-duration-persisted',
    'compact-status-failure-and-recovery-persisted',
    'compact-status-null-clears-transient-compacting-state',
    'compact-boundary-replay-counted-exactly-once',
    'mysql-snapshot-restores-runtime-state-without-memory-session',
    'invalid-negative-token-usage-rejected',
    'synthetic-identity-and-conversation-cleaned',
    'mode: 0o600',
  ]
  await writeEvidence({
    ok: true,
    generatedAt: new Date().toISOString(),
    checks,
    runtime: {
      tokenUsageRecorded: true,
      compactionCount: 2,
      lastCompactionTrigger: 'manual',
      duplicateBoundaryIgnored: true,
      snapshotRecoveredFromMySql: true,
    },
    cleanup: { remainingRows: 0 },
  })
  console.log(JSON.stringify({ ok: true, checks }))
} finally {
  if (!cleaned) await cleanup()
  await pool.end()
}
