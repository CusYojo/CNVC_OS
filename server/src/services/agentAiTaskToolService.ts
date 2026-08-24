import { createHash } from 'node:crypto'
import { agentConversationRepository, identityRepositories } from '../repositories/index.js'
import {
  createAiTask,
  getAiTask,
  type AiTaskUser,
  type CreateAiTaskInput,
} from './aiTaskService.js'
import { getAiCustomTemplate } from './aiCustomTemplateService.js'
import { getAccessibleProject } from './projectAccessService.js'
import type { AiExecutableTaskType } from './aiTemplateCatalog.js'
import { formatShanghaiDateKey, parseShanghaiDate } from '../utils/shanghaiTime.js'

export const AGENT_CREATABLE_AI_TASK_TYPES = [
  'compliance_statement',
  'investment_proposal',
  'investment_recommendation_ppt',
  'due_diligence_report',
  'project_qa',
  'custom_template_document',
] as const satisfies readonly AiExecutableTaskType[]

type AgentCreatableAiTaskType = typeof AGENT_CREATABLE_AI_TASK_TYPES[number]

const AGENT_TASK_SKILLS: Record<AgentCreatableAiTaskType, string> = {
  compliance_statement: 'generate-investment-compliance-note',
  investment_proposal: 'draft-investment-proposal',
  investment_recommendation_ppt: 'investment-committee-ppt',
  due_diligence_report: 'draft-due-diligence-report',
  project_qa: 'draft-investment-qa',
  custom_template_document: 'generate-document-from-template',
}

type AgentAiTaskToolDependencies = {
  createTask: (user: AiTaskUser, input: CreateAiTaskInput) => Promise<unknown>
  getTask: (userId: string, taskId: string) => Promise<unknown>
  getCustomTemplate: (userId: string, templateId: string) => Promise<unknown>
}

const defaultDependencies: AgentAiTaskToolDependencies = {
  createTask: createAiTask,
  getTask: getAiTask,
  getCustomTemplate: getAiCustomTemplate,
}

function toolError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code })
}

function permission(projectId: string) {
  return { granted: true, checkedBy: 'server-stable-identity', scope: 'project' as const, projectId }
}

async function assertBoundTaskContext(userId: string, projectId: string, conversationId: string) {
  const stableUser = await identityRepositories.users.findById(userId)
  if (!stableUser || stableUser.status !== '启用') {
    throw toolError(403, 'USER_DISABLED_OR_MISSING', '当前用户不存在或已禁用')
  }
  const user = { uid: stableUser.id, name: stableUser.name, role: stableUser.role }
  const project = await getAccessibleProject(userId, projectId)
  if (!project) throw toolError(403, 'PROJECT_FORBIDDEN', '无权访问当前项目')
  const conversation = await agentConversationRepository.findChatByIdForUser(userId, conversationId)
  if (!conversation || conversation.projectId !== projectId) {
    throw toolError(403, 'CONVERSATION_FORBIDDEN', '当前会话不存在或与项目不匹配')
  }
  return { user, project }
}

function normalizedCutoffDate(value?: string): string {
  const date = value?.trim() || formatShanghaiDateKey(new Date())
  try {
    parseShanghaiDate(date)
  } catch {
    throw toolError(400, 'INVALID_SOURCE_CUTOFF_DATE', '资料截止日必须为 YYYY-MM-DD')
  }
  if (date > formatShanghaiDateKey(new Date())) {
    throw toolError(400, 'INVALID_SOURCE_CUTOFF_DATE', '资料截止日不能晚于今天')
  }
  return date
}

function taskParameters(
  type: AgentCreatableAiTaskType,
  sourceCutoffDate: string,
  instructions?: string,
  attachmentFileIds: string[] = [],
) {
  const cleanInstructions = instructions?.trim() || ''
  if (cleanInstructions.length > 2_000) throw toolError(400, 'TASK_INSTRUCTIONS_TOO_LONG', '补充要求不能超过 2000 字')
  const parameters: Record<string, unknown> = {
    sourceCutoffDate,
    outputFormat: type === 'investment_recommendation_ppt' ? 'PPTX' : 'DOCX',
    skillName: AGENT_TASK_SKILLS[type],
    displayMode: 'chat',
    ...(cleanInstructions ? { userInstructions: cleanInstructions, researchIntent: cleanInstructions } : {}),
    ...(attachmentFileIds.length ? { attachmentFileIds: [...new Set(attachmentFileIds)].slice(0, 10) } : {}),
  }
  if (type === 'investment_recommendation_ppt') Object.assign(parameters, { language: '中文', structureMode: 'standard' })
  if (type === 'due_diligence_report') Object.assign(parameters, { diligenceScope: '商业尽调' })
  return parameters
}

function deterministicIdempotencyKey(input: {
  conversationId: string
  type: AgentCreatableAiTaskType
  parameters: Record<string, unknown>
}) {
  const digest = createHash('sha256').update(JSON.stringify({
    type: input.type,
    parameters: input.parameters,
  })).digest('hex')
  return `jw:${input.conversationId}:${digest}`
}

function publicTaskSnapshot(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const task = value as Record<string, unknown>
  return {
    id: task.id,
    type: task.type,
    status: task.status,
    stage: task.stage,
    progress: task.progress,
    resultSummary: task.resultSummary,
    errorId: task.errorId,
    errorMessage: task.errorMessage,
    cancellationRequested: task.cancellationRequested,
    executionAttempts: task.executionAttempts,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    updatedAt: task.updatedAt,
    artifacts: Array.isArray(task.artifacts) ? task.artifacts : [],
    sources: Array.isArray(task.sources) ? task.sources : [],
  }
}

export async function createAgentAiTaskForUser(input: {
  userId: string
  projectId: string
  conversationId: string
  type: AgentCreatableAiTaskType
  sourceCutoffDate?: string
  instructions?: string
  attachmentFileIds?: string[]
  customTemplateId?: string
}, dependencies: AgentAiTaskToolDependencies = defaultDependencies) {
  if (!AGENT_CREATABLE_AI_TASK_TYPES.includes(input.type)) {
    throw toolError(400, 'INVALID_TASK_TYPE', '该任务类型不允许由 Agent 创建')
  }
  const { user } = await assertBoundTaskContext(input.userId, input.projectId, input.conversationId)
  const sourceCutoffDate = normalizedCutoffDate(input.sourceCutoffDate)
  const parameters = taskParameters(
    input.type,
    sourceCutoffDate,
    input.instructions,
    input.attachmentFileIds,
  )
  if (input.type === 'custom_template_document') {
    if (!input.customTemplateId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.customTemplateId)) {
      throw toolError(400, 'CUSTOM_TEMPLATE_REQUIRED', '自定义模板任务必须指定有效模板 ID')
    }
    const value = await dependencies.getCustomTemplate(input.userId, input.customTemplateId)
    const template = value && typeof value === 'object' ? value as Record<string, unknown> : null
    if (
      !template
      || template.projectId !== input.projectId
      || (template.conversationId && template.conversationId !== input.conversationId)
      || template.status !== 'succeeded'
      || !['docx', 'pptx'].includes(String(template.format).toLowerCase())
    ) throw toolError(404, 'CUSTOM_TEMPLATE_NOT_FOUND', '当前项目会话中不存在可用的自定义模板')
    parameters.customTemplateId = input.customTemplateId
    parameters.outputFormat = String(template.format).toUpperCase()
  } else if (input.customTemplateId) {
    throw toolError(400, 'UNEXPECTED_CUSTOM_TEMPLATE', '内置任务不接受自定义模板 ID')
  }
  const idempotencyKey = deterministicIdempotencyKey({
    conversationId: input.conversationId,
    type: input.type,
    parameters,
  })
  const task = await dependencies.createTask(user, {
    type: input.type,
    projectId: input.projectId,
    conversationId: input.conversationId,
    parameters,
    idempotencyKey,
  })
  return {
    permission: permission(input.projectId),
    projectId: input.projectId,
    conversationId: input.conversationId,
    idempotencyKey,
    task: publicTaskSnapshot(task),
  }
}

export async function getAgentAiTaskStatusForUser(input: {
  userId: string
  projectId: string
  conversationId: string
  taskId: string
}, dependencies: AgentAiTaskToolDependencies = defaultDependencies) {
  await assertBoundTaskContext(input.userId, input.projectId, input.conversationId)
  const value = await dependencies.getTask(input.userId, input.taskId)
  const task = value && typeof value === 'object' ? value as Record<string, unknown> : null
  if (!task || task.projectId !== input.projectId || task.conversationId !== input.conversationId) {
    throw toolError(404, 'AI_TASK_NOT_FOUND', '当前项目会话中不存在该任务')
  }
  return {
    permission: permission(input.projectId),
    projectId: input.projectId,
    conversationId: input.conversationId,
    task: publicTaskSnapshot(task),
  }
}
