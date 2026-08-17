import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { aiTasks, auditLogs, chatConversations, projects, users } from '../db/schema.js'
import {
  createAgentAiTaskForUser,
  getAgentAiTaskStatusForUser,
} from '../services/agentAiTaskToolService.js'
import type { CreateAiTaskInput } from '../services/aiTaskService.js'
import { hashPassword } from '../services/authService.js'

async function expectCode(run: () => Promise<unknown>, code: string) {
  const error = await run().then(() => null, (caught: unknown) => caught as Error & { code?: string })
  if (!error || error.code !== code) throw new Error(`expected ${code}, received ${error?.code || error?.message || 'success'}`)
}

async function main() {
  const marker = randomUUID()
  const passwordHash = await hashPassword(randomUUID())
  const [owner] = await db.insert(users).values({
    email: `agent-task-owner-${marker}@example.invalid`, name: 'Agent任务所有者', role: '投资经理', department: '验收部', passwordHash,
  }).$returningId()
  const [outsider] = await db.insert(users).values({
    email: `agent-task-outsider-${marker}@example.invalid`, name: 'Agent任务外部用户', role: '投资经理', department: '验收部', passwordHash,
  }).$returningId()
  const userIds = [owner.id, outsider.id]
  const projectIds: string[] = []
  try {
    const [project] = await db.insert(projects).values({
      name: `Agent任务项目-${marker}`, owner: 'Agent任务所有者', ownerUserId: owner.id, createdBy: owner.id, collaborators: [],
    }).$returningId()
    const [otherProject] = await db.insert(projects).values({
      name: `Agent任务其他项目-${marker}`, owner: 'Agent任务所有者', ownerUserId: owner.id, createdBy: owner.id, collaborators: [],
    }).$returningId()
    projectIds.push(project.id, otherProject.id)
    const [conversation] = await db.insert(chatConversations).values({
      userId: owner.id, projectId: project.id, projectName: `Agent任务项目-${marker}`,
      title: 'Agent任务验收会话', scope: 'project', agentId: `agent-${marker}`, messages: [],
    }).$returningId()
    const [otherConversation] = await db.insert(chatConversations).values({
      userId: owner.id, projectId: otherProject.id, projectName: `Agent任务其他项目-${marker}`,
      title: 'Agent任务其他会话', scope: 'project', agentId: `other-agent-${marker}`, messages: [],
    }).$returningId()

    const captured: Array<{ userId: string; input: CreateAiTaskInput }> = []
    const fakeDependencies = {
      createTask: async (user: { uid: string }, input: CreateAiTaskInput) => {
        captured.push({ userId: user.uid, input })
        return {
          id: `fake-${marker}`, projectId: input.projectId, conversationId: input.conversationId,
          type: input.type, status: 'pending', stage: '等待执行', progress: 0,
          artifacts: [], sources: [],
        }
      },
      getTask: async () => undefined,
      getCustomTemplate: async (_userId: string, templateId: string) => ({
        id: templateId,
        projectId: project.id,
        conversationId: conversation.id,
        status: 'succeeded',
        format: 'pptx',
      }),
    }
    const createInput = {
      userId: owner.id,
      projectId: project.id,
      conversationId: conversation.id,
      type: 'investment_proposal' as const,
      sourceCutoffDate: '2026-08-08',
      instructions: `重点核验客户与估值 ${marker}`,
    }
    const first = await createAgentAiTaskForUser(createInput, fakeDependencies)
    const second = await createAgentAiTaskForUser(createInput, fakeDependencies)
    const capturedInput = captured[0]?.input
    if (
      !first.permission.granted || first.permission.checkedBy !== 'server-stable-identity'
      || first.projectId !== project.id || first.conversationId !== conversation.id
      || first.task?.status !== 'pending' || captured[0]?.userId !== owner.id
      || capturedInput?.projectId !== project.id || capturedInput.conversationId !== conversation.id
      || capturedInput.parameters.audience !== '内部立项' || capturedInput.parameters.length !== '标准版'
      || capturedInput.parameters.outputFormat !== 'DOCX'
    ) throw new Error('create_ai_task stable context/default parameter contract mismatch')
    if (
      !first.idempotencyKey.startsWith(`jw:${conversation.id}:`)
      || first.idempotencyKey !== second.idempotencyKey
      || captured[0]?.input.idempotencyKey !== captured[1]?.input.idempotencyKey
    ) throw new Error('create_ai_task deterministic idempotency contract mismatch')
    await expectCode(() => createAgentAiTaskForUser({
      ...createInput, userId: outsider.id,
    }, fakeDependencies), 'PROJECT_FORBIDDEN')
    await expectCode(() => createAgentAiTaskForUser({
      ...createInput, sourceCutoffDate: '2999-01-01',
    }, fakeDependencies), 'INVALID_SOURCE_CUTOFF_DATE')
    const customTemplateId = randomUUID()
    const custom = await createAgentAiTaskForUser({
      ...createInput,
      type: 'custom_template_document',
      customTemplateId,
    }, fakeDependencies)
    const customInput = captured.at(-1)?.input
    if (
      custom.task?.type !== 'custom_template_document'
      || customInput?.parameters.customTemplateId !== customTemplateId
      || customInput?.parameters.outputFormat !== 'PPTX'
    ) throw new Error('create_ai_task custom template ownership/output contract mismatch')

    const [task] = await db.insert(aiTasks).values({
      userId: owner.id, projectId: project.id, conversationId: conversation.id,
      type: 'project_qa', parameters: { sourceCutoffDate: '2026-08-08', outputFormat: 'DOCX' },
      templateVersion: 'agent-tool-acceptance', status: 'succeeded', stage: '已完成', progress: 100,
      resultSummary: `任务完成-${marker}`, idempotencyKey: `agent-tool-${marker}`,
    }).$returningId()
    const [otherTask] = await db.insert(aiTasks).values({
      userId: owner.id, projectId: otherProject.id, conversationId: otherConversation.id,
      type: 'project_qa', parameters: { sourceCutoffDate: '2026-08-08', outputFormat: 'DOCX' },
      templateVersion: 'agent-tool-acceptance', status: 'pending', stage: '等待执行', progress: 0,
      idempotencyKey: `agent-tool-other-${marker}`,
    }).$returningId()
    const status = await getAgentAiTaskStatusForUser({
      userId: owner.id, projectId: project.id, conversationId: conversation.id, taskId: task.id,
    })
    if (
      !status.permission.granted || status.projectId !== project.id || status.conversationId !== conversation.id
      || status.task?.id !== task.id || status.task.status !== 'succeeded' || status.task.progress !== 100
      || status.task.resultSummary !== `任务完成-${marker}`
    ) throw new Error('get_ai_task_status current project/conversation contract mismatch')
    await expectCode(() => getAgentAiTaskStatusForUser({
      userId: owner.id, projectId: project.id, conversationId: conversation.id, taskId: otherTask.id,
    }), 'AI_TASK_NOT_FOUND')
    await expectCode(() => getAgentAiTaskStatusForUser({
      userId: outsider.id, projectId: project.id, conversationId: conversation.id, taskId: task.id,
    }), 'PROJECT_FORBIDDEN')

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'create-stable-user-project-conversation-binding',
        'create-approved-default-parameters',
        'create-server-deterministic-idempotency',
        'create-cross-user-project-denial',
        'create-cutoff-date-boundary',
        'create-owned-custom-template-contract',
        'status-current-task-snapshot',
        'status-cross-project-conversation-denial',
        'status-cross-user-denial',
      ],
    }))
  } finally {
    if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds)).catch(() => {})
    await db.delete(auditLogs).where(inArray(auditLogs.userId, userIds)).catch(() => {})
    await db.delete(users).where(inArray(users.id, userIds)).catch(() => {})
  }
}

await main().finally(async () => pool.end())
