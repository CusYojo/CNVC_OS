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
  beginJwAgentInteraction,
  getJwAgentSnapshot,
  JW_AGENT_ALLOWED_TOOLS,
  JW_AGENT_INTERACTIVE_TOOL,
  jwAgentPermissionSettings,
  recoverInterruptedJwAgentSessions,
  respondJwAgentInteraction,
  shutdownJwAgentRuntime,
} from '../runtime/jwAgentRuntime.js'

const marker = randomUUID()
const userId = randomUUID()
const otherUserId = randomUUID()
const conversationId = randomUUID()
const agentId = `jw-interaction-${marker}`
const evidenceDir = path.resolve('.runtime/migration-evidence/jw-interaction')
let cleaned = false

const questions = [{
  header: '策略',
  question: '请选择本轮分析策略',
  options: [
    { label: '稳健', description: '优先验证下行风险' },
    { label: '进取', description: '优先寻找增长弹性' },
  ],
  multiSelect: false,
}, {
  header: '范围',
  question: '请选择需要覆盖的范围',
  options: [
    { label: '财务', description: '覆盖财务质量' },
    { label: '技术', description: '覆盖技术壁垒' },
  ],
  multiSelect: true,
}]

async function writeEvidence(report: Record<string, unknown>): Promise<void> {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const target = path.resolve(evidenceDir, 'report.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  await chmod(target, 0o600)
}

async function waitForInteraction(expectedId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const snapshot = await getJwAgentSnapshot(userId, agentId)
    if (snapshot?.interaction?.id === expectedId) return snapshot
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('pending interaction was not persisted to the MySQL snapshot')
}

async function cleanup(): Promise<void> {
  await shutdownJwAgentRuntime()
  await db.delete(agentConversations).where(eq(agentConversations.id, conversationId)).catch(() => undefined)
  await db.delete(chatConversations).where(eq(chatConversations.id, conversationId)).catch(() => undefined)
  await db.delete(users).where(eq(users.id, otherUserId)).catch(() => undefined)
  await db.delete(users).where(eq(users.id, userId)).catch(() => undefined)
  cleaned = true
}

try {
  const permissionSettings = jwAgentPermissionSettings()
  assert.deepEqual(permissionSettings.permissions.ask, [JW_AGENT_INTERACTIVE_TOOL])
  assert.equal(permissionSettings.permissions.defaultMode, 'dontAsk')
  assert.equal(permissionSettings.permissions.disableBypassPermissionsMode, 'disable')
  assert.equal(JW_AGENT_ALLOWED_TOOLS.includes(JW_AGENT_INTERACTIVE_TOOL as never), false)

  await ensureSchema()
  const passwordHash = await hashPassword(`Jw-interaction-${marker}`)
  await db.insert(users).values([{
    id: userId,
    email: `jw-interaction-${marker}@example.invalid`,
    name: 'JW 交互验收用户',
    role: '系统管理员',
    department: '迁移验收',
    passwordHash,
  }, {
    id: otherUserId,
    email: `jw-interaction-other-${marker}@example.invalid`,
    name: 'JW 交互越权验收用户',
    role: '普通用户',
    department: '迁移验收',
    passwordHash,
  }])
  await db.insert(chatConversations).values({
    id: conversationId,
    userId,
    title: 'JW 交互验收',
    scope: 'global',
    agentId,
    messages: [],
  })
  await db.insert(agentConversations).values({
    id: conversationId,
    userId,
    title: 'JW 交互验收',
    scope: 'global',
    status: 'idle',
    runtime: 'jw',
    externalSessionId: agentId,
    metadata: { retained: 'yes' },
  })

  const answerInteractionId = `ask-answer-${marker}`
  const answerPermission = beginJwAgentInteraction(conversationId, answerInteractionId, { questions })
  const pendingSnapshot = await waitForInteraction(answerInteractionId)
  assert.equal(pendingSnapshot.status, 'streaming')
  assert.equal(pendingSnapshot.interaction?.questions.length, 2)
  assert.equal(pendingSnapshot.interaction?.questions[1]?.multiSelect, true)

  assert.equal(await respondJwAgentInteraction({
    userId: otherUserId,
    agentId,
    interactionId: answerInteractionId,
    action: 'cancel',
  }), null)
  await assert.rejects(
    respondJwAgentInteraction({
      userId,
      agentId,
      interactionId: `wrong-${marker}`,
      action: 'cancel',
    }),
    (error: unknown) => (error as { code?: string }).code === 'AGENT_INTERACTION_NOT_ACTIVE',
  )
  await assert.rejects(
    respondJwAgentInteraction({
      userId,
      agentId,
      interactionId: answerInteractionId,
      action: 'answer',
      answers: { q1: '', q2: [] },
    }),
    (error: unknown) => (error as { code?: string }).code === 'AGENT_INTERACTION_ANSWER_INVALID',
  )
  const answered = await respondJwAgentInteraction({
    userId,
    agentId,
    interactionId: answerInteractionId,
    action: 'answer',
    answers: { q1: '稳健', q2: ['财务', '自定义法务范围'] },
  })
  assert.deepEqual(answered, { ok: true, outcome: 'answered' })
  const answerResult = await answerPermission
  assert.equal(answerResult.behavior, 'allow')
  assert.deepEqual(answerResult.behavior === 'allow' ? answerResult.updatedInput.answers : null, {
    '请选择本轮分析策略': '稳健',
    '请选择需要覆盖的范围': ['财务', '自定义法务范围'],
  })
  const afterAnswer = await getJwAgentSnapshot(userId, agentId)
  assert.equal(afterAnswer?.interaction, null)

  const cancelInteractionId = `ask-cancel-${marker}`
  const cancelPermission = beginJwAgentInteraction(conversationId, cancelInteractionId, { questions: [questions[0]] })
  await waitForInteraction(cancelInteractionId)
  assert.deepEqual(await respondJwAgentInteraction({
    userId,
    agentId,
    interactionId: cancelInteractionId,
    action: 'cancel',
  }), { ok: true, outcome: 'cancelled' })
  const cancelResult = await cancelPermission
  assert.equal(cancelResult.behavior, 'deny')
  assert.equal(cancelResult.behavior === 'deny' ? cancelResult.interrupt : true, false)

  const abortController = new AbortController()
  const abortInteractionId = `ask-abort-${marker}`
  const abortPermission = beginJwAgentInteraction(
    conversationId,
    abortInteractionId,
    { questions: [questions[0]] },
    abortController.signal,
  )
  await waitForInteraction(abortInteractionId)
  abortController.abort()
  const abortResult = await abortPermission
  assert.equal(abortResult.behavior, 'deny')

  const timeoutInteractionId = `ask-timeout-${marker}`
  const timeoutPermission = beginJwAgentInteraction(
    conversationId,
    timeoutInteractionId,
    { questions: [questions[0]] },
    undefined,
    500,
  )
  await waitForInteraction(timeoutInteractionId)
  const timeoutResult = await timeoutPermission
  assert.equal(timeoutResult.behavior, 'deny')
  assert.equal((await getJwAgentSnapshot(userId, agentId))?.interaction, null)

  const [beforeRecovery] = await db.select({ metadata: agentConversations.metadata }).from(agentConversations)
    .where(eq(agentConversations.id, conversationId)).limit(1)
  await db.update(agentConversations).set({
    status: 'streaming',
    metadata: {
      ...(beforeRecovery?.metadata || {}),
      pendingInteraction: {
        id: `ask-restart-${marker}`,
        toolName: 'AskUserQuestion',
        questions: [questions[0]],
        requestedAt: new Date().toISOString(),
      },
    },
  }).where(eq(agentConversations.id, conversationId))
  const recovery = await recoverInterruptedJwAgentSessions()
  assert(recovery.conversations >= 1)
  const recoveredSnapshot = await getJwAgentSnapshot(userId, agentId)
  assert.equal(recoveredSnapshot?.status, 'idle')
  assert.equal(recoveredSnapshot?.interaction, null)

  const [finalRow] = await db.select({ metadata: agentConversations.metadata }).from(agentConversations)
    .where(eq(agentConversations.id, conversationId)).limit(1)
  assert.equal(finalRow?.metadata?.retained, 'yes')
  assert.equal((finalRow?.metadata?.lastInteraction as { outcome?: string })?.outcome, 'service_restart')
  assert.equal(JSON.stringify(finalRow?.metadata || {}).includes('自定义法务范围'), false)

  await cleanup()
  const [remainingOwner, remainingOther, remainingChat, remainingAgent] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.id, userId)),
    db.select({ id: users.id }).from(users).where(eq(users.id, otherUserId)),
    db.select({ id: chatConversations.id }).from(chatConversations).where(eq(chatConversations.id, conversationId)),
    db.select({ id: agentConversations.id }).from(agentConversations).where(eq(agentConversations.id, conversationId)),
  ])
  assert.equal(remainingOwner.length + remainingOther.length + remainingChat.length + remainingAgent.length, 0)

  const checks = [
    'ask-user-question-visible-but-not-auto-allowed',
    'explicit-ask-rule-routes-interaction-to-sdk-permission-callback',
    'ask-user-question-persisted-in-mysql-snapshot',
    'single-and-multi-select-answer-resumes-sdk-permission',
    'free-form-answer-supported-without-metadata-content-retention',
    'cancel-denies-tool-without-interrupting-agent-turn',
    'abort-signal-settles-pending-interaction',
    'interaction-timeout-prevents-unbounded-runtime-wait',
    'cross-user-and-stale-interaction-response-rejected',
    'invalid-answer-fails-closed-and-keeps-request-pending',
    'service-restart-clears-unresumable-interaction',
    'synthetic-identities-and-conversation-cleaned',
    'mode: 0o600',
  ]
  await writeEvidence({
    ok: true,
    generatedAt: new Date().toISOString(),
    checks,
    interactions: { answered: 1, cancelled: 1, aborted: 1, timedOut: 1, restartRecovered: 1 },
    authorization: { crossUserAccepted: 0, staleInteractionAccepted: 0 },
    persistedAnswerBodies: 0,
    cleanup: { remainingRows: 0 },
  })
  console.log(JSON.stringify({ ok: true, checks }))
} finally {
  if (!cleaned) await cleanup()
  await pool.end()
}
