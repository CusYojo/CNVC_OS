import { randomUUID } from 'node:crypto'
import { inArray, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { aiTasks, auditLogs, chatConversations, projectFiles, projects, users } from '../db/schema.js'
import { hashPassword } from '../services/authService.js'
import {
  assertRegisteredAiTaskTemplate,
  validateAiTaskCoreReferences,
} from '../services/aiTaskService.js'
import { AI_TASK_TYPES, AI_TEMPLATE_CATALOG } from '../services/aiTemplateCatalog.js'

async function expectCode(run: () => Promise<unknown>, code: string) {
  const error = await run().then(() => null, (caught: unknown) => caught as Error & { code?: string })
  if (!error || error.code !== code) throw new Error(`expected ${code}, received ${error?.code || error?.message || 'success'}`)
}

async function taskCount() {
  const [row] = await db.select({ count: sql<number>`COUNT(*)` }).from(aiTasks)
  return Number(row?.count || 0)
}

async function main() {
  const marker = randomUUID()
  const passwordHash = await hashPassword(randomUUID())
  const [owner] = await db.insert(users).values({
    email: `task-ref-owner-${marker}@example.invalid`, name: '任务引用所有者', role: '投资经理', department: '验收部', passwordHash,
  }).$returningId()
  const [outsider] = await db.insert(users).values({
    email: `task-ref-outsider-${marker}@example.invalid`, name: '任务引用外部用户', role: '投资经理', department: '验收部', passwordHash,
  }).$returningId()
  const [disabled] = await db.insert(users).values({
    email: `task-ref-disabled-${marker}@example.invalid`, name: '任务引用禁用用户', role: '投资经理', department: '验收部', passwordHash, status: '禁用',
  }).$returningId()
  const userIds = [owner.id, outsider.id, disabled.id]
  const projectIds: string[] = []
  try {
    const [project] = await db.insert(projects).values({
      name: `任务引用项目-${marker}`, owner: '任务引用所有者', ownerUserId: owner.id, createdBy: owner.id, collaborators: [],
    }).$returningId()
    const [otherProject] = await db.insert(projects).values({
      name: `任务引用其他项目-${marker}`, owner: '任务引用外部用户', ownerUserId: outsider.id, createdBy: outsider.id, collaborators: [],
    }).$returningId()
    projectIds.push(project.id, otherProject.id)
    const [conversation] = await db.insert(chatConversations).values({
      userId: owner.id, projectId: project.id, projectName: `任务引用项目-${marker}`,
      title: '任务引用验收会话', scope: 'project', agentId: `task-ref-${marker}`, messages: [],
    }).$returningId()
    const [globalConversation] = await db.insert(chatConversations).values({
      userId: owner.id, projectId: null, title: '全局会话', scope: 'global', agentId: `task-ref-global-${marker}`, messages: [],
    }).$returningId()
    const [goodFile] = await db.insert(projectFiles).values({
      projectId: project.id, name: `已解析-${marker}.txt`, type: 'TXT', category: '项目资料',
      uploader: '任务引用所有者', uploadedBy: owner.id, parseStatus: '成功', visibility: '项目成员',
    }).$returningId()
    const [pendingFile] = await db.insert(projectFiles).values({
      projectId: project.id, name: `解析中-${marker}.txt`, type: 'TXT', category: '项目资料',
      uploader: '任务引用所有者', uploadedBy: owner.id, parseStatus: '解析中', visibility: '项目成员',
    }).$returningId()
    const [failedFile] = await db.insert(projectFiles).values({
      projectId: project.id, name: `失败-${marker}.txt`, type: 'TXT', category: '项目资料',
      uploader: '任务引用所有者', uploadedBy: owner.id, parseStatus: '失败', parseError: '验收夹具', visibility: '项目成员',
    }).$returningId()
    const [otherFile] = await db.insert(projectFiles).values({
      projectId: otherProject.id, name: `跨项目-${marker}.txt`, type: 'TXT', category: '项目资料',
      uploader: '任务引用外部用户', uploadedBy: outsider.id, parseStatus: '成功', visibility: '项目成员',
    }).$returningId()

    const beforeTasks = await taskCount()
    for (const type of AI_TASK_TYPES) await assertRegisteredAiTaskTemplate(AI_TEMPLATE_CATALOG[type])
    await expectCode(() => assertRegisteredAiTaskTemplate({
      ...AI_TEMPLATE_CATALOG.project_qa,
      templateVersion: '不存在的验收版本',
    }), 'AI_TEMPLATE_REGISTRY_MISMATCH')
    const valid = await validateAiTaskCoreReferences(
      { uid: owner.id, name: '伪造显示名', role: '系统管理员' },
      {
        projectId: project.id,
        conversationId: conversation.id,
        parameters: { attachmentFileIds: [goodFile.id, pendingFile.id, goodFile.id] },
      },
    )
    if (
      valid.user.uid !== owner.id || valid.user.name !== '任务引用所有者' || valid.user.role !== '投资经理'
      || valid.project.id !== project.id
      || JSON.stringify(valid.parameters.attachmentFileIds) !== JSON.stringify([goodFile.id, pendingFile.id])
    ) throw new Error('stable user/project/conversation/file normalization contract mismatch')
    await expectCode(() => validateAiTaskCoreReferences(
      { uid: owner.id, name: '任务引用所有者', role: '投资经理' },
      { projectId: project.id, conversationId: globalConversation.id },
    ), 'CONVERSATION_PROJECT_MISMATCH')
    await expectCode(() => validateAiTaskCoreReferences(
      { uid: outsider.id, name: '任务引用外部用户', role: '投资经理' },
      { projectId: project.id, conversationId: conversation.id },
    ), 'PROJECT_FORBIDDEN')
    await expectCode(() => validateAiTaskCoreReferences(
      { uid: disabled.id, name: '任务引用禁用用户', role: '投资经理' },
      { projectId: project.id },
    ), 'USER_DISABLED_OR_MISSING')
    await expectCode(() => validateAiTaskCoreReferences(
      { uid: owner.id, name: '任务引用所有者', role: '投资经理' },
      { projectId: project.id, conversationId: conversation.id, parameters: { attachmentFileIds: [randomUUID()] } },
    ), 'TASK_ATTACHMENT_NOT_FOUND')
    await expectCode(() => validateAiTaskCoreReferences(
      { uid: owner.id, name: '任务引用所有者', role: '投资经理' },
      { projectId: project.id, conversationId: conversation.id, parameters: { attachmentFileIds: [otherFile.id] } },
    ), 'TASK_ATTACHMENT_NOT_FOUND')
    await expectCode(() => validateAiTaskCoreReferences(
      { uid: owner.id, name: '任务引用所有者', role: '投资经理' },
      { projectId: project.id, conversationId: conversation.id, parameters: { attachmentFileIds: [failedFile.id] } },
    ), 'TASK_ATTACHMENT_PARSE_FAILED')
    await expectCode(() => validateAiTaskCoreReferences(
      { uid: owner.id, name: '任务引用所有者', role: '投资经理' },
      { projectId: project.id, conversationId: conversation.id, parameters: { attachmentFileIds: ['invalid-id'] } },
    ), 'INVALID_TASK_ATTACHMENT_REFERENCES')
    const afterTasks = await taskCount()
    if (afterTasks !== beforeTasks) throw new Error(`reference validation created orphan tasks: before=${beforeTasks} after=${afterTasks}`)

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'stable-enabled-user-reloaded-from-mysql',
        'all-built-in-template-versions-registered-in-mysql',
        'missing-or-version-mismatched-template-rejected',
        'accessible-project-and-exact-project-conversation',
        'valid-and-pending-project-files-accepted-before-insert',
        'duplicate-file-references-normalized',
        'global-or-cross-project-conversation-rejected',
        'cross-user-project-rejected',
        'disabled-user-rejected',
        'missing-or-cross-project-file-rejected',
        'failed-or-invalid-file-reference-rejected',
        'no-orphan-task-created-on-validation-failure',
      ],
    }))
  } finally {
    if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds)).catch(() => {})
    await db.delete(auditLogs).where(inArray(auditLogs.userId, userIds)).catch(() => {})
    await db.delete(users).where(inArray(users.id, userIds)).catch(() => {})
  }
}

await main().finally(async () => pool.end())
