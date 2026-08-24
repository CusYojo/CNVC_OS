import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { RowDataPacket } from 'mysql2'
import { db, pool } from '../../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../../db/config.js'
import {
  aiArtifacts,
  aiCustomTemplates,
  aiTaskEvents,
  aiTaskSources,
  aiTaskTemplates,
  aiTasks,
  auditLogs,
} from '../../db/schema.js'
import type {
  CreateAiArtifactRecord,
  AiTaskRepository,
  CreateAiTaskRecord,
  CreateAiTaskSourceRecord,
  CreateAiCustomTemplateRecord,
} from '../aiTaskRepository.js'
import { isMySqlDriverError, isRepositoryError, mapMySqlRepositoryError } from '../contracts.js'
import type { AuditRecord } from '../identityRepository.js'
import { recordJobCoordinationEventSafely } from '../../runtime/jobCoordinationTelemetry.js'

type ProgressRow = RowDataPacket & {
  id: string
  user_id: string
  project_id: string
  task_id: string | null
  file_name: string
  purpose: string
  status: 'running' | 'succeeded' | 'failed'
  stage: string
  progress: number
  error_message: string | null
  result: unknown
  started_at: Date
  updated_at: Date
  expires_at: Date
}

const progressTable = quoteMysqlIdentifier(mysqlTableName('ai_template_analysis_progress'))

export function visibleTaskEventStage(stage: string) {
  return stage
    .replace(/[（(]已等待\s*\d+\s*秒[）)]/g, '')
    .replace(/，已等待\s*\d+\s*秒/g, '')
    .replace(/[（(]已用时\s*\d+\s*秒[）)]/g, '')
    .replace(/，已用时\s*\d+\s*秒/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
}

function errorChainHasCode(error: unknown, code: string) {
  let current: unknown = error
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    if ('code' in current && (current as { code?: unknown }).code === code) return true
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined
  }
  return false
}

function mapProgress(row: ProgressRow) {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    taskId: row.task_id,
    fileName: row.file_name,
    purpose: row.purpose,
    status: row.status,
    stage: row.stage,
    progress: Number(row.progress),
    errorMessage: row.error_message,
    result: typeof row.result === 'string'
      ? (() => { try { return JSON.parse(row.result) as unknown } catch { return row.result } })()
      : row.result,
    startedAt: new Date(row.started_at),
    updatedAt: new Date(row.updated_at),
    expiresAt: new Date(row.expires_at),
  }
}

export type MySqlAiTaskExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function mapped<T>(operation: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (isRepositoryError(error)) throw error
    if (isMySqlDriverError(error)) throw mapMySqlRepositoryError(error, operation)
    throw error
  }
}

class MySqlAiTaskRepository implements AiTaskRepository {
  constructor(private readonly executor: MySqlAiTaskExecutor) {}

  async findTaskById(taskId: string) {
    return mapped('aiTask.findTaskById', async () => {
      const [row] = await this.executor.select().from(aiTasks)
        .where(eq(aiTasks.id, taskId)).limit(1)
      return row ?? null
    })
  }

  async findOwnedTask(userId: string, taskId: string) {
    return mapped('aiTask.findOwnedTask', async () => {
      const [row] = await this.executor.select().from(aiTasks).where(and(
        eq(aiTasks.id, taskId), eq(aiTasks.userId, userId),
      )).limit(1)
      return row ?? null
    })
  }

  async listTaskEvents(taskId: string) {
    try {
      return await mapped('aiTask.listTaskEvents', async () => this.executor
        .select()
        .from(aiTaskEvents)
        .where(eq(aiTaskEvents.taskId, taskId))
        .orderBy(asc(aiTaskEvents.createdAt), asc(aiTaskEvents.id)))
    } catch (error) {
      // 允许应用候选构建先于 0046 迁移启动；任务仍以 ai_tasks 为事实源，
      // 迁移完成后无需重启即可开始返回持久阶段历史。
      if (errorChainHasCode(error, 'ER_NO_SUCH_TABLE')) return []
      throw error
    }
  }

  async findTaskByIdempotency(userId: string, idempotencyKey: string) {
    return mapped('aiTask.findTaskByIdempotency', async () => {
      const [row] = await this.executor.select().from(aiTasks).where(and(
        eq(aiTasks.userId, userId), eq(aiTasks.idempotencyKey, idempotencyKey),
      )).limit(1)
      return row ?? null
    })
  }

  async createTask(input: CreateAiTaskRecord) {
    return mapped('aiTask.createTask', async () => {
      const [createdId] = await this.executor.insert(aiTasks).values({
        ...input,
        conversationId: input.conversationId ?? null,
        retryOfTaskId: input.retryOfTaskId ?? null,
      }).$returningId()
      const id = input.id ?? createdId.id
      const created = await this.findTaskById(id)
      if (!created) throw new Error('AI task cannot be reloaded after creation')
      return created
    })
  }

  async listOwnedTasks(input: {
    userId: string
    projectId?: string
    conversationId?: string
    limit?: number
  }) {
    const conditions = [eq(aiTasks.userId, input.userId)]
    if (input.projectId) conditions.push(eq(aiTasks.projectId, input.projectId))
    if (input.conversationId) conditions.push(eq(aiTasks.conversationId, input.conversationId))
    return mapped('aiTask.listOwnedTasks', () => this.executor.select().from(aiTasks)
      .where(and(...conditions)).orderBy(desc(aiTasks.createdAt))
      .limit(Math.max(1, Math.min(500, Math.trunc(input.limit ?? 50)))))
  }

  async claimTask(input: {
    taskId: string
    leaseOwner: string
    leaseExpiresAt: Date
    updatedAt: Date
  }) {
    return mapped('aiTask.claimTask', async () => {
      const [result] = await this.executor.update(aiTasks).set({
        status: 'running',
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
        executionAttempts: sql`${aiTasks.executionAttempts} + 1`,
        updatedAt: input.updatedAt,
      }).where(sql`
        ${aiTasks.id} = ${input.taskId}
        AND ${aiTasks.status} = 'pending'
        AND ${aiTasks.cancellationRequested} = false
        AND (${aiTasks.leaseExpiresAt} IS NULL OR ${aiTasks.leaseExpiresAt} < NOW(3))
      `)
      const claimed = result.affectedRows === 1
      if (!claimed) {
        const [current] = await this.executor.select({
          status: aiTasks.status,
          leaseExpiresAt: aiTasks.leaseExpiresAt,
        }).from(aiTasks).where(eq(aiTasks.id, input.taskId)).limit(1)
        if (current?.status === 'running' && current.leaseExpiresAt && current.leaseExpiresAt >= new Date()) {
          await recordJobCoordinationEventSafely({
            domain: 'ai-task', entityId: input.taskId, event: 'leaseContention',
          })
        }
      }
      return claimed
    })
  }

  async getTaskCancellationState(taskId: string) {
    return mapped('aiTask.getTaskCancellationState', async () => {
      const [row] = await this.executor.select({
        cancellationRequested: aiTasks.cancellationRequested,
        status: aiTasks.status,
        leaseOwner: aiTasks.leaseOwner,
      }).from(aiTasks).where(eq(aiTasks.id, taskId)).limit(1)
      return row ?? null
    })
  }

  async updateRunningStage(input: {
    taskId: string
    leaseOwner: string
    stage: string
    progress: number
    updatedAt: Date
  }) {
    return mapped('aiTask.updateRunningStage', async () => {
      const [before] = await this.executor.select({ stage: aiTasks.stage }).from(aiTasks).where(and(
        eq(aiTasks.id, input.taskId),
        eq(aiTasks.status, 'running'),
        eq(aiTasks.leaseOwner, input.leaseOwner),
      )).limit(1)
      const [result] = await this.executor.update(aiTasks).set({
        stage: input.stage,
        progress: sql<number>`GREATEST(${aiTasks.progress}, ${input.progress})`,
        updatedAt: input.updatedAt,
      }).where(and(
        eq(aiTasks.id, input.taskId),
        eq(aiTasks.status, 'running'),
        eq(aiTasks.leaseOwner, input.leaseOwner),
      ))
      const eventStage = visibleTaskEventStage(input.stage)
      if (
        result.affectedRows === 1
        && eventStage
        && eventStage !== visibleTaskEventStage(before?.stage || '')
      ) {
        await this.executor.insert(aiTaskEvents).values({
          taskId: input.taskId,
          stage: eventStage,
          progress: Math.max(0, Math.min(100, input.progress)),
          createdAt: input.updatedAt,
        }).onDuplicateKeyUpdate({
          set: { progress: Math.max(0, Math.min(100, input.progress)) },
        }).catch((error: unknown) => {
          console.warn('[ai-task-event] 阶段事实记录失败，不影响正式任务执行', error)
        })
      }
      return result.affectedRows === 1
    })
  }

  async addTaskModelUsage(input: {
    taskId: string
    usage: {
      inputTokens: number
      outputTokens: number
      cacheCreationInputTokens: number
      cacheReadInputTokens: number
      reasoningTokens: number
      totalTokens: number
    } | null
    updatedAt: Date
  }) {
    await mapped('aiTask.addTaskModelUsage', async () => {
      const usage = input.usage
      await this.executor.update(aiTasks).set({
        modelCalls: sql`${aiTasks.modelCalls} + 1`,
        usageCalls: sql`${aiTasks.usageCalls} + ${usage ? 1 : 0}`,
        inputTokens: sql`${aiTasks.inputTokens} + ${usage?.inputTokens ?? 0}`,
        outputTokens: sql`${aiTasks.outputTokens} + ${usage?.outputTokens ?? 0}`,
        cacheCreationInputTokens: sql`${aiTasks.cacheCreationInputTokens} + ${usage?.cacheCreationInputTokens ?? 0}`,
        cacheReadInputTokens: sql`${aiTasks.cacheReadInputTokens} + ${usage?.cacheReadInputTokens ?? 0}`,
        reasoningTokens: sql`${aiTasks.reasoningTokens} + ${usage?.reasoningTokens ?? 0}`,
        totalTokens: sql`${aiTasks.totalTokens} + ${usage?.totalTokens ?? 0}`,
        updatedAt: input.updatedAt,
      }).where(eq(aiTasks.id, input.taskId))
    })
  }

  async heartbeatTaskLease(input: {
    taskId: string
    leaseOwner: string
    leaseExpiresAt: Date
    updatedAt: Date
  }) {
    return mapped('aiTask.heartbeatTaskLease', async () => {
      const [result] = await this.executor.update(aiTasks).set({
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.updatedAt,
      }).where(and(
        eq(aiTasks.id, input.taskId),
        eq(aiTasks.status, 'running'),
        eq(aiTasks.leaseOwner, input.leaseOwner),
      ))
      return result.affectedRows === 1
    })
  }

  async markTaskStarted(input: {
    taskId: string
    leaseOwner: string
    stage: string
    progress: number
    startedAt: Date
    updatedAt: Date
  }) {
    return mapped('aiTask.markTaskStarted', async () => {
      const [result] = await this.executor.update(aiTasks).set({
        stage: input.stage,
        progress: input.progress,
        startedAt: input.startedAt,
        errorId: null,
        errorCode: null,
        errorMessage: null,
        retryable: null,
        updatedAt: input.updatedAt,
      }).where(and(
        eq(aiTasks.id, input.taskId),
        eq(aiTasks.status, 'running'),
        eq(aiTasks.leaseOwner, input.leaseOwner),
      ))
      return result.affectedRows === 1
    })
  }

  async markTaskCancelledByLease(input: {
    taskId: string
    leaseOwner: string
    completedAt: Date
  }) {
    return mapped('aiTask.markTaskCancelledByLease', async () => {
      const [result] = await this.executor.update(aiTasks).set({
        status: 'cancelled', stage: '已取消', completedAt: input.completedAt, updatedAt: input.completedAt,
      }).where(and(eq(aiTasks.id, input.taskId), eq(aiTasks.leaseOwner, input.leaseOwner)))
      return result.affectedRows === 1
    })
  }

  async releaseTaskLease(input: { taskId: string; leaseOwner: string; updatedAt: Date }) {
    await mapped('aiTask.releaseTaskLease', async () => {
      await this.executor.update(aiTasks).set({
        leaseOwner: null, leaseExpiresAt: null, updatedAt: input.updatedAt,
      }).where(and(eq(aiTasks.id, input.taskId), eq(aiTasks.leaseOwner, input.leaseOwner)))
    })
  }

  async updatePreparationProgress(input: {
    taskId: string
    userId: string
    stage: string
    progress: number
    updatedAt: Date
  }) {
    return mapped('aiTask.updatePreparationProgress', async () => {
      const [result] = await this.executor.update(aiTasks).set({
        stage: input.stage, progress: input.progress, updatedAt: input.updatedAt,
      }).where(and(eq(aiTasks.id, input.taskId), eq(aiTasks.userId, input.userId)))
      return result.affectedRows === 1
    })
  }

  async failPreparation(input: {
    taskId: string
    userId: string
    progress: number
    errorMessage: string
    completedAt: Date
  }) {
    return mapped('aiTask.failPreparation', async () => {
      const [result] = await this.executor.update(aiTasks).set({
        status: 'failed',
        stage: '模板分析失败',
        progress: input.progress,
        errorCode: 'TEMPLATE_REUPLOAD_REQUIRED',
        errorMessage: input.errorMessage,
        retryable: false,
        completedAt: input.completedAt,
        updatedAt: input.completedAt,
      }).where(and(eq(aiTasks.id, input.taskId), eq(aiTasks.userId, input.userId)))
      return result.affectedRows === 1
    })
  }

  async finishPreparation(input: {
    taskId: string
    userId: string
    parameters: Record<string, unknown>
    templateVersion: string
    updatedAt: Date
  }) {
    return mapped('aiTask.finishPreparation', async () => {
      const [result] = await this.executor.update(aiTasks).set({
        parameters: input.parameters,
        templateVersion: input.templateVersion,
        status: 'pending',
        stage: '模板分析完成，等待生成',
        progress: 10,
        errorId: null,
        errorCode: null,
        errorMessage: null,
        retryable: null,
        completedAt: null,
        updatedAt: input.updatedAt,
      }).where(and(eq(aiTasks.id, input.taskId), eq(aiTasks.userId, input.userId)))
      return result.affectedRows === 1
    })
  }

  async cancelOwnedPreparation(input: { taskId: string; userId: string; completedAt: Date }) {
    return mapped('aiTask.cancelOwnedPreparation', async () => {
      const [result] = await this.executor.update(aiTasks).set({
        status: 'cancelled', stage: '已取消', completedAt: input.completedAt, updatedAt: input.completedAt,
      }).where(and(eq(aiTasks.id, input.taskId), eq(aiTasks.userId, input.userId)))
      return result.affectedRows === 1
    })
  }

  async requestCancellation(input: {
    taskId: string
    userId: string
    cancelImmediately: boolean
    updatedAt: Date
  }) {
    return mapped('aiTask.requestCancellation', async () => {
      const [result] = await this.executor.update(aiTasks).set({
        cancellationRequested: true,
        status: sql`CASE WHEN ${aiTasks.status} = 'pending' OR ${input.cancelImmediately} THEN 'cancelled' ELSE ${aiTasks.status} END`,
        stage: sql`CASE WHEN ${aiTasks.status} = 'pending' OR ${input.cancelImmediately} THEN '已取消' ELSE '正在取消' END`,
        completedAt: sql`CASE WHEN ${aiTasks.status} = 'pending' OR ${input.cancelImmediately} THEN NOW(3) ELSE ${aiTasks.completedAt} END`,
        updatedAt: input.updatedAt,
      }).where(and(
        eq(aiTasks.id, input.taskId), eq(aiTasks.userId, input.userId), inArray(aiTasks.status, ['pending', 'running']),
      ))
      return result.affectedRows === 1
    })
  }

  async markEditableArtifactMissing(taskId: string, updatedAt: Date) {
    await mapped('aiTask.markEditableArtifactMissing', async () => {
      await this.executor.update(aiTasks).set({
        status: 'failed', stage: '元素级可编辑版未完成', progress: 78,
        errorCode: 'EDITABLE_ARTIFACT_MISSING',
        errorMessage: '图片高保真版已完成，但元素级可编辑版尚未成功生成。系统已保留检查点，可点击“继续生成”。',
        retryable: true, updatedAt,
      }).where(eq(aiTasks.id, taskId))
    })
  }

  async isTaskTemplateRegistered(input: {
    type: string
    templateVersion: string
    skillName: string
    outputFormat: string
  }) {
    return mapped('aiTask.isTaskTemplateRegistered', async () => {
      const [row] = await this.executor.select({ type: aiTaskTemplates.type }).from(aiTaskTemplates).where(and(
        eq(aiTaskTemplates.type, input.type),
        eq(aiTaskTemplates.templateVersion, input.templateVersion),
        eq(aiTaskTemplates.skillName, input.skillName),
        eq(aiTaskTemplates.outputFormat, input.outputFormat),
        eq(aiTaskTemplates.status, 'enabled'),
      )).limit(1)
      return Boolean(row)
    })
  }

  async listTaskTemplates() {
    return mapped('aiTask.listTaskTemplates', () => this.executor.select().from(aiTaskTemplates)
      .orderBy(aiTaskTemplates.type))
  }

  async countArtifacts(input: { userId: string; projectId: string; format: string }) {
    return mapped('aiTask.countArtifacts', async () => {
      const [{ count }] = await this.executor.select({ count: sql<number>`count(*)` }).from(aiArtifacts).where(and(
        eq(aiArtifacts.userId, input.userId),
        eq(aiArtifacts.projectId, input.projectId),
        eq(aiArtifacts.format, input.format),
      ))
      return Number(count ?? 0)
    })
  }

  async listTaskArtifacts(taskId: string) {
    return mapped('aiTask.listTaskArtifacts', () => this.executor.select().from(aiArtifacts)
      .where(and(
        eq(aiArtifacts.taskId, taskId),
        eq(aiArtifacts.archived, false),
      )).orderBy(desc(aiArtifacts.createdAt)))
  }

  async listTaskSources(taskId: string) {
    return mapped('aiTask.listTaskSources', () => this.executor.select().from(aiTaskSources)
      .where(eq(aiTaskSources.taskId, taskId)).orderBy(asc(aiTaskSources.createdAt)))
  }

  async listOwnedArtifacts(input: { userId: string; projectId?: string; limit?: number }) {
    const conditions = [
      eq(aiArtifacts.userId, input.userId),
      eq(aiArtifacts.archived, false),
      eq(aiArtifacts.qualityStatus, 'passed'),
    ]
    if (input.projectId) conditions.push(eq(aiArtifacts.projectId, input.projectId))
    return mapped('aiTask.listOwnedArtifacts', () => this.executor.select({
      artifact: aiArtifacts,
      taskType: aiTasks.type,
    }).from(aiArtifacts).innerJoin(aiTasks, eq(aiArtifacts.taskId, aiTasks.id))
      .where(and(...conditions)).orderBy(desc(aiArtifacts.createdAt))
      .limit(Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)))))
  }

  async findOwnedArtifactWithTaskType(input: { userId: string; artifactId: string }) {
    return mapped('aiTask.findOwnedArtifactWithTaskType', async () => {
      const [row] = await this.executor.select({ artifact: aiArtifacts, taskType: aiTasks.type })
        .from(aiArtifacts).innerJoin(aiTasks, eq(aiArtifacts.taskId, aiTasks.id)).where(and(
          eq(aiArtifacts.id, input.artifactId),
          eq(aiArtifacts.userId, input.userId),
          eq(aiArtifacts.archived, false),
        )).limit(1)
      return row ?? null
    })
  }

  async findOwnedArtifact(userId: string, artifactId: string) {
    return mapped('aiTask.findOwnedArtifact', async () => {
      const [row] = await this.executor.select().from(aiArtifacts).where(and(
        eq(aiArtifacts.id, artifactId), eq(aiArtifacts.userId, userId), eq(aiArtifacts.archived, false),
      )).limit(1)
      return row ?? null
    })
  }

  async archiveOwnedArtifact(input: { userId: string; artifactId: string }) {
    return mapped('aiTask.archiveOwnedArtifact', async () => {
      const [artifact] = await this.executor.select().from(aiArtifacts).where(and(
        eq(aiArtifacts.id, input.artifactId),
        eq(aiArtifacts.userId, input.userId),
        eq(aiArtifacts.archived, false),
      )).limit(1)
      if (!artifact) return null
      const [result] = await this.executor.update(aiArtifacts).set({ archived: true }).where(and(
        eq(aiArtifacts.id, input.artifactId),
        eq(aiArtifacts.userId, input.userId),
        eq(aiArtifacts.archived, false),
      ))
      return result.affectedRows === 1 ? artifact : null
    })
  }

  async findLatestImageDeck(taskId: string) {
    return mapped('aiTask.findLatestImageDeck', async () => {
      const [row] = await this.executor.select().from(aiArtifacts).where(and(
        eq(aiArtifacts.taskId, taskId),
        eq(aiArtifacts.archived, false),
        sql`(JSON_UNQUOTE(JSON_EXTRACT(${aiArtifacts.metadata}, '$.artifactStage')) = 'image-deck' or ${aiArtifacts.editableLevel} = 'image')`,
      )).orderBy(desc(aiArtifacts.createdAt)).limit(1)
      return row ?? null
    })
  }

  async findLatestMainArtifact(input: { taskId: string; requireEditableStage: boolean }) {
    return mapped('aiTask.findLatestMainArtifact', async () => {
      const [row] = await this.executor.select({ id: aiArtifacts.id, format: aiArtifacts.format })
        .from(aiArtifacts).where(and(
          eq(aiArtifacts.taskId, input.taskId),
          eq(aiArtifacts.archived, false),
          inArray(aiArtifacts.format, ['docx', 'pptx']),
          input.requireEditableStage
            ? sql`JSON_UNQUOTE(JSON_EXTRACT(${aiArtifacts.metadata}, '$.artifactStage')) = 'editable' and ${aiArtifacts.editableLevel} <> 'image'`
            : undefined,
        )).orderBy(desc(aiArtifacts.createdAt)).limit(1)
      return row ?? null
    })
  }

  async upsertImageDeck(input: {
    existingArtifactId?: string
    artifact: CreateAiArtifactRecord
    updatedAt: Date
  }) {
    await mapped('aiTask.upsertImageDeck', async () => {
      if (input.existingArtifactId) {
        await this.executor.update(aiArtifacts).set({
          storagePath: input.artifact.storagePath,
          qualityStatus: input.artifact.qualityStatus,
          templateVersion: input.artifact.templateVersion,
          metadata: input.artifact.metadata,
          createdAt: input.updatedAt,
        }).where(eq(aiArtifacts.id, input.existingArtifactId))
        return
      }
      await this.executor.insert(aiArtifacts).values(input.artifact)
    })
  }

  async completeTaskWithArtifacts(input: {
    taskId: string
    leaseOwner: string
    stage: string
    resultSummary: string
    completedAt: Date
    artifacts: CreateAiArtifactRecord[]
    sources: CreateAiTaskSourceRecord[]
  }) {
    return mapped('aiTask.completeTaskWithArtifacts', () => db.transaction(async (tx) => {
      if (input.artifacts.length) await tx.insert(aiArtifacts).values(input.artifacts)
      if (input.sources.length) await tx.insert(aiTaskSources).values(input.sources)
      const [completion] = await tx.update(aiTasks).set({
        status: 'succeeded', stage: input.stage, progress: 100,
        resultSummary: input.resultSummary, completedAt: input.completedAt, updatedAt: input.completedAt,
      }).where(and(
        eq(aiTasks.id, input.taskId),
        eq(aiTasks.status, 'running'),
        eq(aiTasks.leaseOwner, input.leaseOwner),
        eq(aiTasks.cancellationRequested, false),
      ))
      if (completion.affectedRows !== 1) {
        throw Object.assign(new Error('AI task completion state changed concurrently'), {
          code: 'AI_TASK_COMPLETION_CONFLICT',
        })
      }
      return true
    }).catch(async (error) => {
      if ((error as { code?: string }).code === 'AI_TASK_COMPLETION_CONFLICT') {
        await recordJobCoordinationEventSafely({
          domain: 'ai-task', entityId: input.taskId, event: 'staleCompletionRejected',
        })
        return false
      }
      throw error
    }))
  }

  async markSucceededFromExistingArtifact(input: {
    taskId: string
    leaseOwner: string
    stage: string
    completedAt: Date
  }) {
    return mapped('aiTask.markSucceededFromExistingArtifact', async () => {
      const [result] = await this.executor.update(aiTasks).set({
        status: 'succeeded', stage: input.stage, progress: 100,
        errorId: null, errorCode: null, errorMessage: null, retryable: null,
        completedAt: input.completedAt, updatedAt: input.completedAt,
      }).where(and(
        eq(aiTasks.id, input.taskId), eq(aiTasks.status, 'running'),
        eq(aiTasks.leaseOwner, input.leaseOwner), eq(aiTasks.cancellationRequested, false),
      ))
      const completed = result.affectedRows === 1
      if (!completed) await recordJobCoordinationEventSafely({
        domain: 'ai-task', entityId: input.taskId, event: 'staleCompletionRejected',
      })
      return completed
    })
  }

  async resetTaskForAutomaticRecovery(input: {
    taskId: string
    leaseOwner: string
    stage: string
    progress: number
    parameters: Record<string, unknown>
    updatedAt: Date
  }) {
    return mapped('aiTask.resetTaskForAutomaticRecovery', async () => {
      const [result] = await this.executor.update(aiTasks).set({
        status: 'pending', stage: input.stage, progress: input.progress, parameters: input.parameters,
        errorId: null, errorCode: null, errorMessage: null, retryable: null,
        completedAt: null, updatedAt: input.updatedAt,
      }).where(and(
        eq(aiTasks.id, input.taskId), eq(aiTasks.status, 'running'), eq(aiTasks.leaseOwner, input.leaseOwner),
      ))
      return result.affectedRows === 1
    })
  }

  async markTaskFailed(input: {
    taskId: string
    leaseOwner: string
    stage: string
    errorId: string
    errorCode: string
    errorMessage: string
    retryable: boolean
    completedAt: Date
  }) {
    await mapped('aiTask.markTaskFailed', async () => {
      await this.executor.update(aiTasks).set({
        status: 'failed', stage: input.stage, errorId: input.errorId,
        errorCode: input.errorCode, errorMessage: input.errorMessage, retryable: input.retryable,
        completedAt: input.completedAt, updatedAt: input.completedAt,
      }).where(and(eq(aiTasks.id, input.taskId), eq(aiTasks.leaseOwner, input.leaseOwner)))
    })
  }

  async listRecoverableTasks(input: {
    taskIds?: string[]
    staleWithoutLeaseBefore: Date
    limit?: number
  }) {
    return mapped('aiTask.listRecoverableTasks', () => this.executor.select({
      id: aiTasks.id,
      status: aiTasks.status,
      parameters: aiTasks.parameters,
      cancellationRequested: aiTasks.cancellationRequested,
      leaseExpiresAt: aiTasks.leaseExpiresAt,
      updatedAt: aiTasks.updatedAt,
    }).from(aiTasks).where(and(
      input.taskIds ? inArray(aiTasks.id, input.taskIds) : undefined,
      sql`
      (
        ${aiTasks.status} = 'pending'
        AND (${aiTasks.leaseExpiresAt} IS NULL OR ${aiTasks.leaseExpiresAt} < NOW(3))
      )
      OR (
        ${aiTasks.status} = 'running'
        AND (
          (${aiTasks.leaseExpiresAt} IS NOT NULL AND ${aiTasks.leaseExpiresAt} < NOW(3))
          OR (${aiTasks.leaseExpiresAt} IS NULL AND ${aiTasks.updatedAt} < ${input.staleWithoutLeaseBefore})
        )
      )`,
    )).orderBy(asc(aiTasks.createdAt)).limit(Math.max(1, Math.min(1_000, input.limit ?? 100))))
  }

  async markRecoverableCancelled(input: {
    taskId: string
    previousStatus: string
    completedAt: Date
  }) {
    return mapped('aiTask.markRecoverableCancelled', async () => {
      const [result] = await this.executor.update(aiTasks).set({
        status: 'cancelled', stage: '已取消', leaseOwner: null, leaseExpiresAt: null,
        completedAt: input.completedAt, updatedAt: input.completedAt,
      }).where(and(
        eq(aiTasks.id, input.taskId), eq(aiTasks.status, input.previousStatus), eq(aiTasks.cancellationRequested, true),
      ))
      return result.affectedRows === 1
    })
  }

  async markRecoverableTemplateFailed(input: {
    taskId: string
    previousStatus: string
    completedAt: Date
  }) {
    return mapped('aiTask.markRecoverableTemplateFailed', async () => {
      const [result] = await this.executor.update(aiTasks).set({
        status: 'failed', stage: '模板分析中断', errorCode: 'TEMPLATE_REUPLOAD_REQUIRED',
        errorMessage: '服务重启导致模板分析中断，请重新上传模板。', retryable: false,
        leaseOwner: null, leaseExpiresAt: null, completedAt: input.completedAt, updatedAt: input.completedAt,
      }).where(and(eq(aiTasks.id, input.taskId), eq(aiTasks.status, input.previousStatus)))
      return result.affectedRows === 1
    })
  }

  async resetExpiredRunningTask(input: {
    taskId: string
    staleWithoutLeaseBefore: Date
    updatedAt: Date
  }) {
    return mapped('aiTask.resetExpiredRunningTask', async () => {
      const [result] = await this.executor.update(aiTasks).set({
        status: 'pending', stage: '等待恢复', leaseOwner: null, leaseExpiresAt: null, updatedAt: input.updatedAt,
      }).where(sql`
        ${aiTasks.id} = ${input.taskId}
        AND ${aiTasks.status} = 'running'
        AND ${aiTasks.cancellationRequested} = false
        AND (
          (${aiTasks.leaseExpiresAt} IS NOT NULL AND ${aiTasks.leaseExpiresAt} < NOW(3))
          OR (${aiTasks.leaseExpiresAt} IS NULL AND ${aiTasks.updatedAt} < ${input.staleWithoutLeaseBefore})
        )
      `)
      const recovered = result.affectedRows === 1
      if (recovered) await recordJobCoordinationEventSafely({
        domain: 'ai-task', entityId: input.taskId, event: 'leaseRecovered',
      })
      return recovered
    })
  }

  async taskWorkerHealth() {
    return mapped('aiTask.taskWorkerHealth', async () => {
      const [row] = await this.executor.select({
        pending: sql<number>`SUM(${aiTasks.status} = 'pending')`,
        running: sql<number>`SUM(${aiTasks.status} = 'running')`,
        failed: sql<number>`SUM(${aiTasks.status} = 'failed')`,
        liveLeases: sql<number>`SUM(${aiTasks.status} = 'running' AND ${aiTasks.leaseExpiresAt} >= NOW(3))`,
        expiredLeases: sql<number>`SUM(${aiTasks.status} = 'running' AND ${aiTasks.leaseExpiresAt} < NOW(3))`,
      }).from(aiTasks)
      return {
        pending: Number(row?.pending || 0), running: Number(row?.running || 0), failed: Number(row?.failed || 0),
        liveLeases: Number(row?.liveLeases || 0), expiredLeases: Number(row?.expiredLeases || 0),
      }
    })
  }

  async stopOwnedRunningTasks(input: { leaseOwner: string; updatedAt: Date }) {
    return mapped('aiTask.stopOwnedRunningTasks', () => db.transaction(async (tx) => {
      const [cancelled] = await tx.update(aiTasks).set({
        status: 'cancelled', stage: '已取消', leaseOwner: null, leaseExpiresAt: null,
        completedAt: input.updatedAt, updatedAt: input.updatedAt,
      }).where(and(
        eq(aiTasks.status, 'running'), eq(aiTasks.leaseOwner, input.leaseOwner), eq(aiTasks.cancellationRequested, true),
      ))
      const [released] = await tx.update(aiTasks).set({
        status: 'pending', stage: '服务停止，等待恢复', leaseOwner: null, leaseExpiresAt: null,
        updatedAt: input.updatedAt,
      }).where(and(
        eq(aiTasks.status, 'running'), eq(aiTasks.leaseOwner, input.leaseOwner), eq(aiTasks.cancellationRequested, false),
      ))
      return { released: released.affectedRows, cancelled: cancelled.affectedRows }
    }))
  }

  async createCustomTemplateWithAudit(input: CreateAiCustomTemplateRecord, audit: AuditRecord) {
    return mapped('aiTask.createCustomTemplateWithAudit', () => db.transaction(async (tx) => {
      await tx.insert(aiCustomTemplates).values({
        ...input,
        conversationId: input.conversationId ?? null,
      })
      await tx.insert(auditLogs).values(audit)
      const [created] = await tx.select().from(aiCustomTemplates)
        .where(eq(aiCustomTemplates.id, input.id)).limit(1)
      if (!created) throw new Error('custom template cannot be reloaded after creation')
      return created
    }))
  }

  async listCustomTemplates(input: {
    userId: string
    projectId?: string
    conversationId?: string
    limit?: number
  }) {
    const conditions = [eq(aiCustomTemplates.userId, input.userId)]
    if (input.projectId) conditions.push(eq(aiCustomTemplates.projectId, input.projectId))
    if (input.conversationId) conditions.push(eq(aiCustomTemplates.conversationId, input.conversationId))
    return mapped('aiTask.listCustomTemplates', () => this.executor.select().from(aiCustomTemplates)
      .where(and(...conditions))
      .orderBy(desc(aiCustomTemplates.createdAt))
      .limit(Math.max(1, Math.min(500, Math.trunc(input.limit ?? 50)))))
  }

  async findCustomTemplateForOwner(userId: string, templateId: string) {
    return mapped('aiTask.findCustomTemplateForOwner', async () => {
      const [row] = await this.executor.select().from(aiCustomTemplates).where(and(
        eq(aiCustomTemplates.id, templateId),
        eq(aiCustomTemplates.userId, userId),
      )).limit(1)
      return row ?? null
    })
  }

  async findCustomTemplateForTask(input: { userId: string; projectId: string; templateId: string }) {
    return mapped('aiTask.findCustomTemplateForTask', async () => {
      const [row] = await this.executor.select().from(aiCustomTemplates).where(and(
        eq(aiCustomTemplates.id, input.templateId),
        eq(aiCustomTemplates.userId, input.userId),
        eq(aiCustomTemplates.projectId, input.projectId),
      )).limit(1)
      return row ?? null
    })
  }

  async findLatestInvestmentPptTemplate(input: {
    userId: string
    projectId: string
    conversationId: string
  }) {
    return mapped('aiTask.findLatestInvestmentPptTemplate', async () => {
      const [row] = await this.executor.select().from(aiCustomTemplates).where(and(
        eq(aiCustomTemplates.userId, input.userId),
        eq(aiCustomTemplates.projectId, input.projectId),
        eq(aiCustomTemplates.skillName, 'create-reference-driven-editable-ppt'),
        eq(aiCustomTemplates.format, 'pptx'),
        eq(aiCustomTemplates.status, 'succeeded'),
        or(
          eq(aiCustomTemplates.conversationId, input.conversationId),
          isNull(aiCustomTemplates.conversationId),
        ),
      )).orderBy(desc(aiCustomTemplates.createdAt)).limit(1)
      return row ?? null
    })
  }

  private async failExpiredTemplateAnalysisProgress(input: {
    id?: string
    interruptedMessage: string
    completedTtlMinutes: number
  }): Promise<number> {
    const [result] = await pool.query(
      `UPDATE ${progressTable}
       SET status='failed', stage='模板分析已中断', error_message=?,
         updated_at=NOW(3), expires_at=DATE_ADD(NOW(3), INTERVAL ? MINUTE)
       WHERE status='running' AND expires_at < NOW(3) ${input.id ? 'AND id=?' : ''}`,
      input.id
        ? [input.interruptedMessage, input.completedTtlMinutes, input.id]
        : [input.interruptedMessage, input.completedTtlMinutes],
    )
    return Number((result as { affectedRows?: number }).affectedRows || 0)
  }

  private async deleteExpiredTerminalTemplateAnalysisProgress(): Promise<number> {
    const [result] = await pool.query(
      `DELETE FROM ${progressTable}
       WHERE status IN ('succeeded','failed') AND expires_at < NOW(3)`,
    )
    return Number((result as { affectedRows?: number }).affectedRows || 0)
  }

  async recoverInterruptedTemplateAnalysisProgress(input: {
    interruptedMessage: string
    completedTtlMinutes: number
  }) {
    return mapped('aiTask.recoverInterruptedTemplateAnalysisProgress', async () => {
      const [result] = await pool.query(
        `UPDATE ${progressTable}
         SET status='failed', stage='模板分析已中断', error_message=?,
           updated_at=NOW(3), expires_at=DATE_ADD(NOW(3), INTERVAL ? MINUTE)
         WHERE status='running'`,
        [input.interruptedMessage, input.completedTtlMinutes],
      )
      await this.deleteExpiredTerminalTemplateAnalysisProgress()
      return Number((result as { affectedRows?: number }).affectedRows || 0)
    })
  }

  async startTemplateAnalysisProgress(input: {
    id: string
    userId: string
    projectId: string
    taskId?: string
    fileName: string
    purpose: string
    runningTtlMinutes: number
  }) {
    return mapped('aiTask.startTemplateAnalysisProgress', async () => {
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        const [rows] = await connection.query<ProgressRow[]>(
          `SELECT * FROM ${progressTable} WHERE id=? FOR UPDATE`,
          [input.id],
        )
        const existing = rows[0]
        if (existing) {
          const sameIdentity = existing.user_id === input.userId
            && existing.project_id === input.projectId
            && existing.file_name === input.fileName
            && existing.purpose === input.purpose
            && (existing.task_id ?? null) === (input.taskId ?? null)
          if (!sameIdentity) {
            throw Object.assign(new Error('模板分析进度 ID 已被其他请求占用'), {
              status: 409,
              code: 'TEMPLATE_PROGRESS_ID_CONFLICT',
            })
          }
          await connection.commit()
          return { created: false, progress: mapProgress(existing) }
        }
        await connection.query(
          `INSERT INTO ${progressTable}
            (id, user_id, project_id, task_id, file_name, purpose, status, stage, progress,
             started_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', '已接收模板，正在准备分析', 5,
             NOW(3), NOW(3), DATE_ADD(NOW(3), INTERVAL ? MINUTE))`,
          [
            input.id,
            input.userId,
            input.projectId,
            input.taskId ?? null,
            input.fileName,
            input.purpose,
            input.runningTtlMinutes,
          ],
        )
        const [createdRows] = await connection.query<ProgressRow[]>(
          `SELECT * FROM ${progressTable} WHERE id=?`,
          [input.id],
        )
        await connection.commit()
        return { created: true, progress: mapProgress(createdRows[0]) }
      } catch (error) {
        await connection.rollback()
        throw error
      } finally {
        connection.release()
      }
    })
  }

  async updateTemplateAnalysisProgress(input: {
    id: string
    stage: string
    progress: number
    runningTtlMinutes: number
  }) {
    await mapped('aiTask.updateTemplateAnalysisProgress', async () => {
      await pool.query(
        `UPDATE ${progressTable}
         SET stage=?, progress=GREATEST(progress, ?), updated_at=NOW(3),
           expires_at=DATE_ADD(NOW(3), INTERVAL ? MINUTE)
         WHERE id=? AND status='running'`,
        [input.stage, input.progress, input.runningTtlMinutes, input.id],
      )
    })
  }

  async completeTemplateAnalysisProgress(input: {
    id: string
    result: unknown
    completedTtlMinutes: number
  }) {
    await mapped('aiTask.completeTemplateAnalysisProgress', async () => {
      await pool.query(
        `UPDATE ${progressTable}
         SET status='succeeded', stage='模板分析完成', progress=100, error_message=NULL,
           result=CAST(? AS JSON), updated_at=NOW(3),
           expires_at=DATE_ADD(NOW(3), INTERVAL ? MINUTE)
         WHERE id=? AND status='running'`,
        [JSON.stringify(input.result ?? null), input.completedTtlMinutes, input.id],
      )
    })
  }

  async failTemplateAnalysisProgress(input: {
    id: string
    message: string
    completedTtlMinutes: number
  }) {
    await mapped('aiTask.failTemplateAnalysisProgress', async () => {
      await pool.query(
        `UPDATE ${progressTable}
         SET status='failed', stage='模板分析失败', error_message=?, result=NULL,
           updated_at=NOW(3), expires_at=DATE_ADD(NOW(3), INTERVAL ? MINUTE)
         WHERE id=? AND status='running'`,
        [input.message, input.completedTtlMinutes, input.id],
      )
    })
  }

  async getTemplateAnalysisProgress(input: {
    userId: string
    id: string
    interruptedMessage: string
    completedTtlMinutes: number
  }) {
    return mapped('aiTask.getTemplateAnalysisProgress', async () => {
      await this.failExpiredTemplateAnalysisProgress(input)
      await this.deleteExpiredTerminalTemplateAnalysisProgress()
      const [rows] = await pool.query<ProgressRow[]>(
        `SELECT * FROM ${progressTable} WHERE id=? AND user_id=? LIMIT 1`,
        [input.id, input.userId],
      )
      return rows[0] ? mapProgress(rows[0]) : null
    })
  }
}

export function createMySqlAiTaskRepository(executor: MySqlAiTaskExecutor): AiTaskRepository {
  return new MySqlAiTaskRepository(executor)
}

export const mysqlAiTaskRepository = createMySqlAiTaskRepository(
  db as unknown as MySqlAiTaskExecutor,
)
