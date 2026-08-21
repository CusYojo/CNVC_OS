import { randomUUID } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import {
  aiTasks,
  auditLogs,
  chatConversations,
  projects,
  users,
} from '../db/schema.js'
import { hashPassword } from '../services/authService.js'
import {
  cancelAiTask,
  claimAiTaskForExecution,
  classifyAiTaskFailure,
  createAiTask,
  recoverAiTasks,
  retryAiTask,
  stopAiTaskWorker,
} from '../services/aiTaskService.js'

type TaskUser = { uid: string; name: string; role: string }

async function expectCode(run: () => Promise<unknown>, code: string) {
  const error = await run().then(() => null, (caught: unknown) => caught as Error & { code?: string })
  if (!error || error.code !== code) {
    throw new Error(`expected ${code}, received ${error?.code || error?.message || 'success'}`)
  }
}

async function taskRow(taskId: string) {
  const [row] = await db.select().from(aiTasks).where(eq(aiTasks.id, taskId)).limit(1)
  if (!row) throw new Error(`missing acceptance task ${taskId}`)
  return row
}

function taskInput(projectId: string, conversationId: string, idempotencyKey: string, userInstructions = '') {
  return {
    type: 'project_qa' as const,
    projectId,
    conversationId,
    parameters: {
      sourceCutoffDate: '2026-08-09',
      outputFormat: 'DOCX',
      ...(userInstructions ? { userInstructions } : {}),
    },
    idempotencyKey,
  }
}

async function main() {
  const marker = randomUUID()
  const passwordHash = await hashPassword(randomUUID())
  const [owner] = await db.insert(users).values({
    email: `task-lifecycle-${marker}@example.invalid`,
    name: '任务生命周期验收用户',
    role: '系统管理员',
    department: '验收部',
    passwordHash,
  }).$returningId()
  const user: TaskUser = { uid: owner.id, name: '任务生命周期验收用户', role: '系统管理员' }
  let projectId = ''
  try {
    const projectName = `任务生命周期验收项目-${marker}`
    const [project] = await db.insert(projects).values({
      name: projectName,
      owner: user.name,
      ownerUserId: owner.id,
      createdBy: owner.id,
      collaborators: [],
    }).$returningId()
    projectId = project.id
    const [conversation] = await db.insert(chatConversations).values({
      userId: owner.id,
      projectId: project.id,
      projectName,
      title: '任务生命周期验收会话',
      scope: 'project',
      agentId: `task-lifecycle-${marker}`,
      messages: [],
    }).$returningId()

    const leaseRows = await db.insert(aiTasks).values([
      {
        userId: owner.id, projectId: project.id, conversationId: conversation.id,
        type: 'project_qa', parameters: {}, templateVersion: 'lifecycle-lease',
        idempotencyKey: `lease-release-${marker}`,
      },
      {
        userId: owner.id, projectId: project.id, conversationId: conversation.id,
        type: 'project_qa', parameters: {}, templateVersion: 'lifecycle-lease',
        idempotencyKey: `lease-cancel-${marker}`,
      },
      {
        userId: owner.id, projectId: project.id, conversationId: conversation.id,
        type: 'project_qa', parameters: {}, templateVersion: 'lifecycle-lease',
        idempotencyKey: `claim-cancelled-${marker}`, cancellationRequested: true,
      },
    ]).$returningId()
    if (await claimAiTaskForExecution(leaseRows[2].id)) {
      throw new Error('cancellation-requested task was claimed')
    }
    if (!await claimAiTaskForExecution(leaseRows[0].id) || !await claimAiTaskForExecution(leaseRows[1].id)) {
      throw new Error('acceptance lease tasks were not claimed')
    }
    await db.update(aiTasks).set({ cancellationRequested: true })
      .where(eq(aiTasks.id, leaseRows[1].id))
    const stopResult = await stopAiTaskWorker()
    const releasedAfterStop = await taskRow(leaseRows[0].id)
    const cancelledAfterStop = await taskRow(leaseRows[1].id)
    if (
      stopResult.releasedLeases !== 2
      || stopResult.cancelled !== 1
      || releasedAfterStop.status !== 'pending'
      || releasedAfterStop.leaseOwner
      || cancelledAfterStop.status !== 'cancelled'
      || cancelledAfterStop.leaseOwner
    ) throw new Error('graceful stop did not release/cancel owned leases correctly')

    const stableKey = `stable-${marker}`
    const first = await createAiTask(user, taskInput(project.id, conversation.id, stableKey))
    const replay = await createAiTask(user, taskInput(project.id, conversation.id, stableKey))
    if (!first || !replay || first.id !== replay.id) throw new Error('same idempotent request created two tasks')
    await expectCode(
      () => createAiTask(user, taskInput(project.id, conversation.id, stableKey, '不同参数')),
      'IDEMPOTENCY_CONFLICT',
    )
    const [stableCount] = await db.select({ count: sql<number>`COUNT(*)` }).from(aiTasks)
      .where(and(eq(aiTasks.userId, owner.id), eq(aiTasks.idempotencyKey, stableKey)))
    if (Number(stableCount?.count || 0) !== 1) throw new Error('stable idempotency key has duplicate rows')

    const raceKey = `race-${marker}`
    const race = await Promise.allSettled([
      createAiTask(user, taskInput(project.id, conversation.id, raceKey, '并发参数甲')),
      createAiTask(user, taskInput(project.id, conversation.id, raceKey, '并发参数乙')),
    ])
    const raceSuccesses = race.filter((item) => item.status === 'fulfilled')
    const raceConflicts = race.filter((item) => (
      item.status === 'rejected'
      && (item.reason as { code?: string }).code === 'IDEMPOTENCY_CONFLICT'
    ))
    if (raceSuccesses.length !== 1 || raceConflicts.length !== 1) {
      throw new Error('concurrent conflicting idempotency requests did not produce one winner and one conflict')
    }

    const cancelKey = `cancel-${marker}`
    const pending = await createAiTask(user, taskInput(project.id, conversation.id, cancelKey))
    if (!pending) throw new Error('pending cancellation task was not created')
    const cancelled = await cancelAiTask(user, pending.id)
    const [cancelAudit] = await db.select().from(auditLogs).where(and(
      eq(auditLogs.userId, owner.id),
      eq(auditLogs.action, '取消 AI 任务'),
      eq(auditLogs.target, pending.id),
    )).limit(1)
    if (
      cancelled?.status !== 'cancelled'
      || cancelled.cancellationRequested !== true
      || cancelled.stage !== '已取消'
      || !cancelled.completedAt
      || !cancelAudit
    ) throw new Error('pending cancellation state or audit is incomplete')

    const [retryableFailure, permanentFailure] = await db.insert(aiTasks).values([
      {
        userId: owner.id, projectId: project.id, conversationId: conversation.id,
        type: 'project_qa', parameters: taskInput(project.id, conversation.id, 'x').parameters,
        templateVersion: 'qa-jialiang-202606-v1', status: 'failed', stage: '网关超时', progress: 45,
        idempotencyKey: `retryable-source-${marker}`, errorCode: 'MODEL_TIMEOUT', retryable: true,
        completedAt: new Date(),
      },
      {
        userId: owner.id, projectId: project.id, conversationId: conversation.id,
        type: 'project_qa', parameters: taskInput(project.id, conversation.id, 'x').parameters,
        templateVersion: 'qa-jialiang-202606-v1', status: 'failed', stage: '模板不兼容', progress: 10,
        idempotencyKey: `permanent-source-${marker}`, errorCode: 'CUSTOM_TEMPLATE_FORMAT_MISMATCH', retryable: false,
        completedAt: new Date(),
      },
    ]).$returningId()
    const retryKey = `retry-${marker}`
    const retry = await retryAiTask(user, retryableFailure.id, retryKey)
    const retryReplay = await retryAiTask(user, retryableFailure.id, retryKey)
    if (
      !retry || !retryReplay || retry.id !== retryReplay.id
      || retry.retryOfTaskId !== retryableFailure.id
      || retry.status !== 'pending'
      || Number(retry.parameters._resumeProgressFloor) !== 45
    ) throw new Error('retry did not create/replay a linked resumable task')
    await expectCode(
      () => retryAiTask(user, permanentFailure.id, `blocked-retry-${marker}`),
      'TASK_ERROR_NOT_RETRYABLE',
    )
    await expectCode(
      () => retryAiTask(user, retryableFailure.id, stableKey),
      'IDEMPOTENCY_CONFLICT',
    )

    const expiredAt = new Date(Date.now() - 60_000)
    const recoveryRows = await db.insert(aiTasks).values([
      {
        userId: owner.id, projectId: project.id, conversationId: conversation.id,
        type: 'project_qa', parameters: {}, templateVersion: 'recovery-test',
        status: 'running', stage: '处理中', idempotencyKey: `recover-running-${marker}`,
        leaseOwner: 'dead-worker', leaseExpiresAt: expiredAt,
      },
      {
        userId: owner.id, projectId: project.id, conversationId: conversation.id,
        type: 'project_qa', parameters: {}, templateVersion: 'recovery-test',
        status: 'running', stage: '正在取消', idempotencyKey: `recover-cancel-${marker}`,
        cancellationRequested: true, leaseOwner: 'dead-worker', leaseExpiresAt: expiredAt,
      },
      {
        userId: owner.id, projectId: project.id, conversationId: conversation.id,
        type: 'investment_recommendation_ppt', parameters: { _templatePreparationPending: true },
        templateVersion: '模板上传与预检', status: 'running', stage: '模板分析中',
        idempotencyKey: `recover-template-${marker}`, leaseOwner: 'dead-worker', leaseExpiresAt: expiredAt,
      },
    ]).$returningId()
    const recovery = await recoverAiTasks({
      schedule: false,
      taskIds: recoveryRows.map((row) => row.id),
    })
    const [recovered, recoveredCancelled, interruptedTemplate] = await Promise.all(
      recoveryRows.map((row) => taskRow(row.id)),
    )
    if (
      recovery.found !== 3 || recovery.recovered !== 1 || recovery.cancelled !== 1 || recovery.templateFailed !== 1
      || recovered.status !== 'pending' || recovered.stage !== '等待恢复' || recovered.leaseOwner
      || recoveredCancelled.status !== 'cancelled' || recoveredCancelled.leaseOwner
      || interruptedTemplate.status !== 'failed'
      || interruptedTemplate.errorCode !== 'TEMPLATE_REUPLOAD_REQUIRED'
      || interruptedTemplate.retryable !== false
    ) throw new Error('restart recovery state transitions are incomplete')

    const transient = classifyAiTaskFailure(Object.assign(new Error('gateway timeout'), { code: 'MODEL_TIMEOUT', status: 429 }))
    const permanent = classifyAiTaskFailure(Object.assign(new Error('bad template'), { code: 'CUSTOM_TEMPLATE_FORMAT_MISMATCH', status: 409 }))
    const resumableVisualQa = classifyAiTaskFailure(Object.assign(
      new Error('checkpointed visual QA rejection'),
      { code: 'GORDEN_VISUAL_QA_REJECTED' },
    ))
    const exhaustedDirectAgent = classifyAiTaskFailure(Object.assign(
      new Error('model quota unavailable'),
      { code: 'DIRECT_SKILL_AGENT_AUTH_OR_QUOTA' },
    ))
    if (
      !transient.retryable
      || permanent.retryable
      || !resumableVisualQa.retryable
      || exhaustedDirectAgent.retryable
    ) {
      throw new Error('failure retry classification mismatch')
    }

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'cancel-requested-task-cannot-be-claimed',
        'graceful-stop-releases-live-lease-and-finalizes-cancellation',
        'same-idempotency-request-replays-one-task',
        'same-key-different-parameters-conflict',
        'concurrent-idempotency-race-has-one-winner',
        'pending-cancellation-is-terminal-and-audited',
        'retryable-failure-creates-linked-resumable-task',
        'checkpointed-gorden-visual-qa-failure-is-retryable',
        'retry-request-is-idempotent',
        'non-retryable-failure-is-explicitly-rejected',
        'retry-key-cannot-be-reused-for-a-different-request',
        'expired-worker-lease-recovers-to-pending',
        'cancelled-work-is-not-rescheduled-after-restart',
        'interrupted-template-preparation-fails-with-reupload-contract',
        'failure-code-retryability-classification',
      ],
    }))
  } finally {
    await db.delete(auditLogs).where(eq(auditLogs.userId, owner.id)).catch(() => {})
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {})
    await db.delete(users).where(eq(users.id, owner.id)).catch(() => {})
  }
}

await main().finally(async () => pool.end())
