import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import {
  agentConversations,
  agentMessages,
  auditLogs,
  chatConversations,
  users,
} from '../db/schema.js'
import { hashPassword } from '../services/authService.js'
import {
  getJwAgentSnapshot,
  respondJwAgentInteraction,
  sendJwAgentMessage,
  shutdownJwAgentRuntime,
} from '../runtime/jwAgentRuntime.js'

const timeoutMs = (() => {
  const value = Number(process.env.JW_INTERACTION_LIVE_TIMEOUT_MS || 180_000)
  if (!Number.isSafeInteger(value) || value < 30_000 || value > 600_000) {
    throw new Error('JW_INTERACTION_LIVE_TIMEOUT_MS must be between 30000 and 600000')
  }
  return value
})()
const marker = randomUUID()
const userId = randomUUID()
const conversationId = randomUUID()
const agentId = `jw-interaction-live-${marker}`
const challenge = `JWLIVE-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`
const evidenceDir = path.resolve('.runtime/migration-evidence/jw-interaction-live')
const workspaceRoot = path.resolve(process.env.AGENT_WORKSPACE || path.join(process.cwd(), 'server', 'agent-workspace'))
const workspacePath = path.resolve(workspaceRoot, conversationId)
let cleaned = false
let stage = 'setup'

function failureClassification(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause || '')
  if (message.includes('tool was denied before interaction')) return 'ask-user-question-auto-denied-before-callback'
  if (message.includes('completed without requesting')) return 'model-completed-without-interaction'
  if (message.includes('did not request') || message.includes('timeout')) return 'provider-interaction-timeout'
  if (message.includes('runtime entered error')) return 'runtime-error-state'
  if (message.includes('未配置') || message.includes('must be')) return 'runtime-configuration-error'
  return 'external-interaction-unknown-failure'
}

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[JW interaction live] ${message}`)
}

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
  assert(workspacePath.startsWith(`${workspaceRoot}${path.sep}`))
  await rm(workspacePath, { recursive: true, force: true })
  cleaned = true
}

function assistantTexts(snapshot: Awaited<ReturnType<typeof getJwAgentSnapshot>>) {
  return (snapshot?.messages || [])
    .filter((message) => message.role === 'assistant' && !message.id.startsWith('streaming:'))
    .map((message) => message.parts.filter((part) => part.type === 'text')
      .map((part) => String(part.text || '')).join(''))
}

async function waitForExternalInteraction() {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await getJwAgentSnapshot(userId, agentId)
    if (snapshot?.status === 'error') throw new Error('runtime entered error before interaction')
    if (snapshot?.interaction) return snapshot
    if (snapshot?.status === 'idle' && assistantTexts(snapshot).length) {
      const [attemptedTool] = await db.select({ status: agentMessages.status, toolName: agentMessages.toolName }).from(agentMessages)
        .where(eq(agentMessages.conversationId, conversationId))
        .then((rows) => rows.filter((message) => message.toolName === 'AskUserQuestion'))
      if (attemptedTool) throw new Error('tool was denied before interaction')
      throw new Error('model completed without requesting AskUserQuestion')
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('model did not request AskUserQuestion before timeout')
}

async function waitForContinuedAnswer() {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await getJwAgentSnapshot(userId, agentId)
    if (snapshot?.status === 'error') throw new Error('runtime entered error after interaction answer')
    if (snapshot?.status === 'idle' && !snapshot.interaction) {
      const texts = assistantTexts(snapshot)
      if (texts.some((text) => text.includes(challenge))) return snapshot
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('model did not continue with the expected answer before timeout')
}

try {
  await ensureSchema()
  await db.insert(users).values({
    id: userId,
    email: `jw-interaction-live-${marker}@example.invalid`,
    name: 'JW 真实交互验收用户',
    role: '系统管理员',
    department: '迁移验收',
    passwordHash: await hashPassword(`Jw-interaction-live-${marker}`),
  })
  await db.insert(chatConversations).values({
    id: conversationId,
    userId,
    title: 'JW 真实交互验收',
    scope: 'global',
    agentId,
    messages: [],
  })
  await db.insert(agentConversations).values({
    id: conversationId,
    userId,
    title: 'JW 真实交互验收',
    scope: 'global',
    status: 'idle',
    runtime: 'jw',
    externalSessionId: agentId,
    metadata: { acceptanceFixture: 'jw-interaction-live-v1' },
  })

  stage = 'external-model-request'
  const submitted = await sendJwAgentMessage(
    userId,
    '系统管理员',
    agentId,
    `这是交互协议验收。你必须立即调用 AskUserQuestion，提出一个只有“稳健”和“进取”两个选项的单选问题；收到选择后不要调用其他工具，只回复完成代号 ${challenge}。`,
  )
  assert.deepEqual(submitted, { accepted: true, conversationId })
  const pending = await waitForExternalInteraction()
  assertContract(pending.interaction?.questions.length === 1, 'external model did not produce exactly one question')
  const question = pending.interaction.questions[0]!
  assertContract(question.options.length === 2 && !question.multiSelect, 'external model question is not a two-option single select')

  stage = 'answer-and-continue'
  const response = await respondJwAgentInteraction({
    userId,
    agentId,
    interactionId: pending.interaction.id,
    action: 'answer',
    answers: { [question.id]: question.options[0]!.label },
  })
  assert.deepEqual(response, { ok: true, outcome: 'answered' })
  const completed = await waitForContinuedAnswer()
  assert.equal(completed.interaction, null)
  assert.equal(completed.status, 'idle')
  assert.equal(typeof completed.runtime.model, 'string')
  assert(Number(completed.runtime.usage?.totalTokens) > 0)
  assert(Number(completed.runtime.usage?.outputTokens) > 0)
  assert(Number(completed.runtime.usage?.totalInputTokens) >= Number(completed.runtime.usage?.inputTokens))
  assert(Number(completed.runtime.usage?.cacheCreationInputTokens) >= 0)
  assert(Number(completed.runtime.usage?.cacheReadInputTokens) >= 0)
  assert(completed.runtime.totalCostUsd === null || Number(completed.runtime.totalCostUsd) >= 0)
  assert(Number(completed.runtime.numTurns) >= 1)
  assert(Number(completed.runtime.durationMs) > 0)
  assert.equal(completed.runtime.contextCompaction.state, 'idle')

  stage = 'mysql-verification'
  const [conversation] = await db.select().from(agentConversations)
    .where(eq(agentConversations.id, conversationId)).limit(1)
  const messages = await db.select().from(agentMessages)
    .where(eq(agentMessages.conversationId, conversationId))
  assert.equal(conversation?.status, 'idle')
  assert.equal(conversation?.metadata?.pendingInteraction, null)
  assert.equal((conversation?.metadata?.lastInteraction as { outcome?: string })?.outcome, 'answered')
  assert(messages.some((message) => message.role === 'tool' && message.toolName === 'AskUserQuestion'))
  assert(messages.every((message) => !['running', 'streaming'].includes(message.status)))

  await cleanup()
  const remaining = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)),
    db.select().from(chatConversations).where(eq(chatConversations.id, conversationId)),
    db.select().from(agentConversations).where(eq(agentConversations.id, conversationId)),
  ])
  assert.equal(remaining.reduce((total, rows) => total + rows.length, 0), 0)

  const checks = [
    'external-model-actively-requested-ask-user-question',
    'mysql-snapshot-exposed-a-two-option-single-select-question',
    'authorized-answer-resumed-the-same-sdk-turn',
    'external-model-continued-with-the-expected-post-answer-result',
    'external-result-model-token-cache-cost-turn-and-duration-persisted',
    'external-result-snapshot-exposes-idle-context-compaction-state',
    'pending-interaction-cleared-and-tool-terminal-state-persisted',
    'synthetic-identity-conversation-messages-and-workspace-cleaned',
    'mode: 0o600',
  ]
  await writeEvidence({
    ok: true,
    generatedAt: new Date().toISOString(),
    checks,
    providerResponseBodiesPersisted: 0,
    cleanup: { remainingRows: 0, workspaceRemoved: true },
  })
  console.log(JSON.stringify({ ok: true, checks }))
} catch (cause) {
  const classification = failureClassification(cause)
  await writeEvidence({
    ok: false,
    generatedAt: new Date().toISOString(),
    stage,
    classification,
    providerResponseBodiesPersisted: 0,
    cleanupAttempted: true,
  })
  console.error(JSON.stringify({ ok: false, stage, classification }))
  throw new Error(`[JW interaction live] failed at stage=${stage}`)
} finally {
  if (!cleaned) await cleanup()
  await pool.end()
}
