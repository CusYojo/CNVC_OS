import { createHash, randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { aiArtifacts, aiTaskSources, aiTasks, auditLogs, projects, users } from '../db/schema.js'
import { aiTaskRepository } from '../repositories/index.js'
import { hashPassword } from '../services/authService.js'
import { jobCoordinationTarget } from '../runtime/jobCoordinationTelemetry.js'

async function main() {
  const marker = randomUUID()
  const [user] = await db.insert(users).values({
    email: `ai-task-repository-${marker}@example.invalid`,
    name: `AI任务仓储-${marker.slice(0, 8)}`,
    role: '投资经理',
    department: 'Repository验收部',
    passwordHash: await hashPassword(`Ai-Task-Repo-A9!-${marker}`),
  }).$returningId()
  const [project] = await db.insert(projects).values({
    name: `AI Task Repository 验收-${marker.slice(0, 8)}`,
    owner: `AI任务仓储-${marker.slice(0, 8)}`,
    ownerUserId: user.id,
    createdBy: user.id,
  }).$returningId()
  const taskIds: string[] = []
  const makeTask = async (suffix: string, overrides: Partial<Parameters<typeof aiTaskRepository.createTask>[0]> = {}) => {
    const task = await aiTaskRepository.createTask({
      userId: user.id,
      projectId: project.id,
      type: 'project_qa',
      parameters: { marker, suffix },
      templateVersion: 'repository-acceptance-v1',
      idempotencyKey: `ai-task-repository:${marker}:${suffix}`,
      requestHash: createHash('sha256').update(`${marker}:${suffix}`).digest('hex'),
      ...overrides,
    })
    taskIds.push(task.id)
    return task
  }

  try {
    const idempotencyInput = {
      userId: user.id,
      projectId: project.id,
      type: 'project_qa',
      parameters: { marker, mode: 'idempotency' },
      templateVersion: 'repository-acceptance-v1',
      idempotencyKey: `ai-task-repository:${marker}:idempotency`,
      requestHash: createHash('sha256').update(`${marker}:idempotency`).digest('hex'),
    }
    const idempotencyResults = await Promise.allSettled([
      aiTaskRepository.createTask(idempotencyInput),
      aiTaskRepository.createTask(idempotencyInput),
    ])
    const created = idempotencyResults.filter((result) => result.status === 'fulfilled')
    const rejected = idempotencyResults.filter((result) => result.status === 'rejected')
    if (created.length !== 1 || rejected.length !== 1) {
      throw new Error('parallel idempotent task creation did not have exactly one winner')
    }
    taskIds.push((created[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof aiTaskRepository.createTask>>>).value.id)
    const rejectionCode = String((rejected[0] as PromiseRejectedResult).reason?.code ?? '')
    if (rejectionCode !== 'CONFLICT') throw new Error(`duplicate task did not map to CONFLICT: ${rejectionCode}`)

    const claimTask = await makeTask('claim')
    const leaseOwner = `acceptance:${marker}`
    const claims = await Promise.all(Array.from({ length: 12 }, () => aiTaskRepository.claimTask({
      taskId: claimTask.id,
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      updatedAt: new Date(),
    })))
    if (claims.filter(Boolean).length !== 1) throw new Error('parallel task claim did not have exactly one winner')

    const artifactId = randomUUID()
    const sourceId = randomUUID()
    const completed = await aiTaskRepository.completeTaskWithArtifacts({
      taskId: claimTask.id,
      leaseOwner,
      stage: 'DOCX 已生成',
      resultSummary: 'Repository 原子完成验收',
      completedAt: new Date(),
      artifacts: [{
        id: artifactId,
        taskId: claimTask.id,
        userId: user.id,
        projectId: project.id,
        conversationId: null,
        fileName: 'repository-acceptance.docx',
        format: 'docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        version: 1,
        storagePath: `/tmp/${artifactId}.docx`,
        editableLevel: 'core-content',
        sourceCutoffDate: '2026-08-10',
        templateVersion: 'repository-acceptance-v1',
        qualityStatus: 'passed',
        metadata: { marker },
        archived: false,
      }],
      sources: [{
        id: sourceId,
        taskId: claimTask.id,
        artifactId,
        sourceType: 'project_record',
        sourceId: project.id,
        sourceName: 'Repository 验收项目',
        locator: 'project',
        verificationStatus: '资料记载',
      }],
    })
    const committedTask = await aiTaskRepository.findTaskById(claimTask.id)
    const committedArtifacts = await aiTaskRepository.listTaskArtifacts(claimTask.id)
    const committedSources = await aiTaskRepository.listTaskSources(claimTask.id)
    if (!completed || committedTask?.status !== 'succeeded' || committedArtifacts.length !== 1 || committedSources.length !== 1) {
      throw new Error('artifact/source/task completion did not commit atomically')
    }

    const conflictTask = await makeTask('completion-conflict')
    const conflictArtifactId = randomUUID()
    const conflictCompleted = await aiTaskRepository.completeTaskWithArtifacts({
      taskId: conflictTask.id,
      leaseOwner: 'not-the-owner',
      stage: '不应完成',
      resultSummary: '不应提交',
      completedAt: new Date(),
      artifacts: [{
        id: conflictArtifactId,
        taskId: conflictTask.id,
        userId: user.id,
        projectId: project.id,
        conversationId: null,
        fileName: 'must-rollback.docx',
        format: 'docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        version: 1,
        storagePath: `/tmp/${conflictArtifactId}.docx`,
        editableLevel: 'core-content',
        sourceCutoffDate: null,
        templateVersion: 'repository-acceptance-v1',
        qualityStatus: 'passed',
        metadata: { marker },
        archived: false,
      }],
      sources: [],
    })
    const rolledBackArtifacts = await aiTaskRepository.listTaskArtifacts(conflictTask.id)
    if (conflictCompleted || rolledBackArtifacts.length) throw new Error('completion conflict left a partial artifact')

    const recoveryTask = await makeTask('expired-recovery')
    await db.update(aiTasks).set({
      status: 'running',
      leaseOwner: 'dead-worker',
      leaseExpiresAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 120_000),
    }).where(eq(aiTasks.id, recoveryTask.id))
    const recoverable = await aiTaskRepository.listRecoverableTasks({
      taskIds: [recoveryTask.id],
      staleWithoutLeaseBefore: new Date(Date.now() - 60_000),
    })
    const reset = await aiTaskRepository.resetExpiredRunningTask({
      taskId: recoveryTask.id,
      staleWithoutLeaseBefore: new Date(Date.now() - 60_000),
      updatedAt: new Date(),
    })
    const recoveredTask = await aiTaskRepository.findTaskById(recoveryTask.id)
    if (recoverable.length !== 1 || !reset || recoveredTask?.status !== 'pending' || recoveredTask.leaseOwner) {
      throw new Error('expired running task was not recovered safely')
    }

    const stopCancelled = await makeTask('stop-cancelled')
    const stopReleased = await makeTask('stop-released')
    await db.update(aiTasks).set({
      status: 'running', leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000), cancellationRequested: true,
    }).where(eq(aiTasks.id, stopCancelled.id))
    await db.update(aiTasks).set({
      status: 'running', leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000), cancellationRequested: false,
    }).where(eq(aiTasks.id, stopReleased.id))
    const stopped = await aiTaskRepository.stopOwnedRunningTasks({ leaseOwner, updatedAt: new Date() })
    const stoppedRows = await db.select({ id: aiTasks.id, status: aiTasks.status, leaseOwner: aiTasks.leaseOwner })
      .from(aiTasks).where(inArray(aiTasks.id, [stopCancelled.id, stopReleased.id]))
    if (
      stopped.cancelled !== 1
      || stopped.released !== 1
      || stoppedRows.find((row) => row.id === stopCancelled.id)?.status !== 'cancelled'
      || stoppedRows.find((row) => row.id === stopReleased.id)?.status !== 'pending'
      || stoppedRows.some((row) => row.leaseOwner)
    ) throw new Error('worker stop did not atomically cancel and release owned tasks')

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'parallel-idempotency-conflict-mapping',
        'parallel-lease-claim-single-winner',
        'artifact-source-completion-atomic-commit',
        'completion-conflict-full-rollback',
        'expired-running-task-recovery',
        'worker-stop-cancel-and-release-transaction',
      ],
    }))
  } finally {
    if (taskIds.length) {
      await db.delete(auditLogs).where(inArray(
        auditLogs.target,
        taskIds.map((id) => jobCoordinationTarget('ai-task', id)),
      ))
      await db.delete(aiTaskSources).where(inArray(aiTaskSources.taskId, taskIds))
      await db.delete(aiArtifacts).where(inArray(aiArtifacts.taskId, taskIds))
      await db.delete(aiTasks).where(inArray(aiTasks.id, taskIds))
    }
    await db.delete(projects).where(and(eq(projects.id, project.id), eq(projects.createdBy, user.id)))
    await db.delete(users).where(eq(users.id, user.id))
  }
}

await main().finally(async () => pool.end())
