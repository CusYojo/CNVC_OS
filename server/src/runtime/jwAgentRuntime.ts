import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { agentConversationRepository, identityRepositories } from '../repositories/index.js'
import { collectCompanyIntel } from '../services/inProcessAiWorkflowService.js'
import {
  AGENT_CREATABLE_AI_TASK_TYPES,
  createAgentAiTaskForUser,
  getAgentAiTaskStatusForUser,
} from '../services/agentAiTaskToolService.js'
import { getAccessibleProject } from '../services/projectAccessService.js'
import {
  getProjectSummaryForUser,
  listProjectFilesForUser,
  readProjectFileForUser,
  searchProjectDocsForUser,
} from '../services/projectKnowledgeToolService.js'
import {
  clearJwAgentChangeTimers,
  publishJwAgentChange,
} from './jwAgentEvents.js'
import { redactSensitiveText } from '../security/redactSecrets.js'
import { resolveAiModelById, resolveAiModelRoute, type AiModelProfileKey } from '../services/aiModelSettingsService.js'
import { normalizeAgentRuntimePolicy, resolveSelectedRuntimeCapabilities } from '../services/aiCapabilityService.js'
import { AI_BUSINESS_SKILLS, loadAiSkill } from '../services/aiSkillService.js'
import { writeAudit } from '../services/auditService.js'
import {
  beginAiRuntimeRequest,
  finishAiRuntimeRequest,
  markAiRuntimeFirstTokenFromSdkMessage,
} from './aiRuntimeTelemetry.js'
import type { WeixinInboundImage } from '../services/weixinInboundImage.js'
import type { WeixinInboundDocument } from '../services/weixinInboundFile.js'

type RuntimeQuery = AsyncIterable<unknown> & {
  interrupt?: () => Promise<void>
  close?: () => void
}

type RuntimeSession = {
  conversationId: string
  queue: MessageQueue
  query: RuntimeQuery
  partialParts: Record<string, unknown>[]
  telemetryRequestId: string | null
  outputLoop: Promise<void>
  stoppingReason: 'abort' | 'dispose' | 'shutdown' | null
  pendingUserMessage: unknown | null
  resumeRecoveryAttempted: boolean
  assistantSeenForPending: boolean
  selectedSkillNames: Set<string>
  quickSkillInvocation: QuickSkillInvocation | null
}

export type JwQuickSkillName =
  | 'draft-investment-proposal'
  | 'generate-investment-compliance-note'
  | 'investment-committee-ppt'
  | 'draft-investment-qa'
  | 'draft-due-diligence-report'
  | 'generate-document-from-template'

export type JwMessageOptions = {
  skillName?: JwQuickSkillName
  attachmentFileIds?: string[]
  attachmentFileNames?: string[]
  customTemplateId?: string
  customTemplateName?: string
  outputFormat?: 'DOCX' | 'PPTX' | 'PDF'
}

export const JW_AGENT_BUILT_IN_AI_TASK_TYPES = [
  'compliance_statement',
  'investment_proposal',
  'investment_recommendation_ppt',
  'due_diligence_report',
  'project_qa',
] as const satisfies readonly (typeof AGENT_CREATABLE_AI_TASK_TYPES)[number][]

// Keep the built-in Agent tool free of custom-template parameters. Some model
// gateways normalize optional tool fields as required fields; exposing
// customTemplateId here made built-in tasks invent placeholder UUIDs that the
// server correctly rejected. Uploaded-template tasks use the dedicated upload
// and /ai/tasks flow instead.
export const JW_AGENT_CREATE_AI_TASK_INPUT_SCHEMA = {
  type: z.enum(JW_AGENT_BUILT_IN_AI_TASK_TYPES),
  sourceCutoffDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  instructions: z.string().max(2_000).optional(),
}

type QuickSkillInvocation = {
  requestedSkillName: JwQuickSkillName
  internalSkillName: string
  taskType:
    | 'investment_proposal'
    | 'compliance_statement'
    | 'investment_recommendation_ppt'
    | 'project_qa'
    | 'due_diligence_report'
    | 'custom_template_document'
  instructions: string
  attachmentFileIds: string[]
  attachmentFileNames: string[]
  customTemplateId?: string
  customTemplateName?: string
  precreatedTaskId?: string
}

export type JwInteractionQuestion = {
  id: string
  header: string
  question: string
  options: { label: string; description: string }[]
  multiSelect: boolean
}

export type JwPendingInteraction = {
  id: string
  toolName: 'AskUserQuestion'
  questions: JwInteractionQuestion[]
  requestedAt: string
}

type JwInteractionPermissionResult = {
  behavior: 'allow'
  updatedInput: Record<string, unknown>
  toolUseID: string
  decisionClassification: 'user_temporary'
} | {
  behavior: 'deny'
  message: string
  interrupt: false
  toolUseID: string
  decisionClassification: 'user_reject'
}

type PendingJwInteractionController = {
  interaction: JwPendingInteraction
  rawInput: Record<string, unknown>
  resolve: (result: JwInteractionPermissionResult) => void
  removeAbortListener?: () => void
  timeout?: NodeJS.Timeout
}

type AgentSnapshotMessage = {
  id: string
  role: 'user' | 'assistant'
  parts: Record<string, unknown>[]
  metadata: { timestamp: string; transient?: boolean }
}

type JsonRecord = Record<string, unknown>

type JwTokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  totalInputTokens: number
  totalTokens: number
}

type JwContextCompaction = {
  state: 'idle' | 'compacting' | 'failed'
  count: number
  lastEventId: string | null
  lastTrigger: 'manual' | 'auto' | null
  lastPreTokens: number | null
  lastPostTokens: number | null
  lastDurationMs: number | null
  startedAt: string | null
  lastCompletedAt: string | null
  lastResult: 'success' | 'failed' | null
  lastError: string | null
}

class MessageQueue implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  private queued: unknown[] = []
  private waiting: ((result: IteratorResult<unknown>) => void) | null = null
  private done = false

  push(message: unknown) {
    if (this.done) throw new Error('Agent message queue is closed')
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: message, done: false })
      return
    }
    this.queued.push(message)
  }

  end() {
    this.done = true
    this.queued.length = 0
    if (this.waiting) {
      this.waiting({ value: undefined, done: true })
      this.waiting = null
    }
  }

  [Symbol.asyncIterator]() { return this }

  next(): Promise<IteratorResult<unknown>> {
    if (this.queued.length > 0) return Promise.resolve({ value: this.queued.shift(), done: false })
    if (this.done) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => { this.waiting = resolve })
  }
}

const sessions = new Map<string, RuntimeSession>()
const pendingInteractions = new Map<string, PendingJwInteractionController>()
const conversationOperationTails = new Map<string, Promise<void>>()
export const JW_AGENT_ALLOWED_TOOLS = [
  'mcp__investment__search_project_docs',
  'mcp__investment__get_project_summary',
  'mcp__investment__list_project_files',
  'mcp__investment__read_project_file',
  'mcp__investment__create_ai_task',
  'mcp__investment__get_ai_task_status',
  'mcp__investment__collect_public_intel',
] as const
export const JW_AGENT_INTERACTIVE_TOOL = 'AskUserQuestion' as const
const jwAgentAllowedToolSet = new Set<string>(JW_AGENT_ALLOWED_TOOLS)
const projectScopedAgentToolSet = new Set<string>([
  'mcp__investment__get_project_summary',
  'mcp__investment__list_project_files',
  'mcp__investment__read_project_file',
  'mcp__investment__create_ai_task',
  'mcp__investment__get_ai_task_status',
])
const skillByTaskType = new Map(AI_BUSINESS_SKILLS.map((item) => [item.taskType, item.name] as const))
export const JW_AGENT_QUICK_SKILL_BINDINGS: Record<JwQuickSkillName, {
  internalSkillName: string
  taskType: QuickSkillInvocation['taskType']
}> = {
  'draft-investment-proposal': {
    internalSkillName: 'draft-investment-proposal',
    taskType: 'investment_proposal',
  },
  'generate-investment-compliance-note': {
    internalSkillName: 'generate-investment-compliance-note',
    taskType: 'compliance_statement',
  },
  'investment-committee-ppt': {
    internalSkillName: 'investment-committee-ppt',
    taskType: 'investment_recommendation_ppt',
  },
  'draft-investment-qa': {
    internalSkillName: 'draft-investment-qa',
    taskType: 'project_qa',
  },
  'draft-due-diligence-report': {
    internalSkillName: 'draft-due-diligence-report',
    taskType: 'due_diligence_report',
  },
  'generate-document-from-template': {
    internalSkillName: 'generate-document-from-template',
    taskType: 'custom_template_document',
  },
}

async function resolveQuickSkillBinding(skillName: JwQuickSkillName) {
  const binding = JW_AGENT_QUICK_SKILL_BINDINGS[skillName]
  const loaded = await loadAiSkill(binding.internalSkillName)
  if (loaded.name !== skillName) {
    throw Object.assign(new Error(`快捷 Skill 部署不一致：${skillName}`), {
      code: 'AI_SKILL_NOT_AVAILABLE', status: 503,
    })
  }
  return binding
}

function quickSkillTaskInstructions(message: string, recentMessages: string[]) {
  const current = message.trim().slice(0, 1_200)
  const recent = recentMessages
    .filter(Boolean)
    .slice(-6)
    .map((item, index) => `${index + 1}. ${item.replace(/\s+/g, ' ').trim().slice(0, 240)}`)
    .join('\n')
  return [
    current ? `本次生成要求：${current}` : '',
    recent ? `当前会话最近上下文：\n${recent}` : '',
  ].filter(Boolean).join('\n\n').slice(0, 2_000)
}

function quickSkillRuntimeMessage(message: string, invocation: QuickSkillInvocation) {
  const attachmentManifest = invocation.attachmentFileNames.length || invocation.attachmentFileIds.length
    ? [
        ...invocation.attachmentFileNames.map((name) => `- 文件名：${name}`),
        ...invocation.attachmentFileIds.map((fileId) => `- 已绑定项目文件 ID：${fileId}`),
      ].join('\n')
    : '无本轮新增附件；仍须使用当前项目全部已授权资料。'
  if (invocation.taskType === 'custom_template_document' && invocation.precreatedTaskId) {
    return `【服务端已绑定快捷 Skill】
Skill：${invocation.requestedSkillName}
固定任务类型：${invocation.taskType}
模板：${invocation.customTemplateName || invocation.customTemplateId || '已分析模板'}

用户已通过普通对话发送模板生成要求。服务端已安全创建任务 ${invocation.precreatedTaskId}，自定义模板 ID 未暴露给通用工具 schema。请调用 get_ai_task_status 查询该任务，然后用普通对话简洁说明已开始执行；不得再次调用 create_ai_task，不得直接输出宿主兜底稿。

【用户请求】
${message.trim()}`
  }
  return `【服务端已绑定快捷 Skill】
Skill：${invocation.requestedSkillName}
固定任务类型：${invocation.taskType}

这是用户通过快捷入口明确发起的正式文档生成请求。先使用 get_project_summary、list_project_files 和必要的 read_project_file 理解当前项目资料，再调用 create_ai_task；type 必须为 ${invocation.taskType}，instructions 应忠实保留用户本次要求与当前会话中相关上下文。不得改用其他文档类型，也不要只在对话中返回一份纯文本草稿。项目、会话、Skill 与附件范围均由服务端绑定。

【本轮附件清单】
${attachmentManifest}

【用户请求】
${message.trim()}`
}

export function jwAgentToolAllowed(toolName: string): boolean {
  return jwAgentAllowedToolSet.has(toolName)
}

export function jwAgentToolsForScope(toolNames: readonly string[], projectId: string | null) {
  return toolNames.filter((name) => projectId || !projectScopedAgentToolSet.has(name))
}

export function jwAgentSystemPrompt(projectId: string | null) {
  const scopeInstruction = projectId
    ? '当前是项目会话。开始处理项目问题时先调用 get_project_summary 获取项目主记录与当前摘要；回答具体项目事实时调用 search_project_docs，核对文件清单或连续片段时调用 list_project_files/read_project_file。'
    : '当前是全局会话，不需要绑定投资项目。对寒暄、通用问答和日常协助直接回答；不得主动要求用户绑定项目，也不得调用 get_project_summary、list_project_files、read_project_file、create_ai_task 或 get_ai_task_status。只有用户明确提出某个项目相关需求时，才说明可以切换到对应项目会话以使用项目资料。'
  return `你是智能投资管理平台的通用 AI 助手。${scopeInstruction}需要公开补充时调用 collect_public_intel，并区分搜索摘要与已核验事实。当回答依赖用户选择或缺少必要信息时，必须调用 AskUserQuestion 获取单选或多选确认，不得用普通文本列出问题后自行假设；收到回答后继续当前轮。只有在项目会话中且用户明确要求生成合规说明、投资提案、投资建议书 PPT、尽调报告或项目 Q&A 时，才调用 create_ai_task；上传模板生成由专用上传模板入口处理，不得给内置任务虚构模板 ID。不得因为讨论、提问或示例自动创建昂贵任务，创建后用 get_ai_task_status 查询。项目和会话范围由服务端绑定，不得尝试读取其他项目或会话目录。不得读取或披露密钥和系统机密。`
}

export function jwAgentPermissionSettings() {
  return {
    permissions: {
      // AskUserQuestion must produce an SDK permission request so the host can
      // persist the question, pause the turn and resume it with the user's answer.
      ask: [JW_AGENT_INTERACTIVE_TOOL],
      defaultMode: 'dontAsk' as const,
      disableBypassPermissionsMode: 'disable' as const,
    },
  }
}

async function withJwConversationOperation<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
  const previous = conversationOperationTails.get(conversationId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.catch(() => undefined).then(() => gate)
  conversationOperationTails.set(conversationId, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (conversationOperationTails.get(conversationId) === tail) conversationOperationTails.delete(conversationId)
  }
}

export function selectedSkillsAllowAiTask(selectedSkillNames: ReadonlySet<string>, taskType: string): boolean {
  const requiredSkill = skillByTaskType.get(taskType as typeof AI_BUSINESS_SKILLS[number]['taskType'])
  return Boolean(requiredSkill && selectedSkillNames.has(requiredSkill))
}

export type JwAgentBoundary = 'file' | 'subprocess' | 'network' | 'database' | 'dynamic-load' | 'tool'

function safeBoundaryValue(value: string, maximum = 160): string {
  return value.replace(/[^A-Za-z0-9_.:/-]/g, '_').slice(0, maximum) || 'unknown'
}

export function classifyJwAgentBoundary(toolName: string): JwAgentBoundary {
  const normalized = toolName.toLowerCase()
  if (/(?:mysql|postgres|database|sql|__db__)/.test(normalized)) return 'database'
  if (/(?:webfetch|websearch|browser|curl|https?|network)/.test(normalized)) return 'network'
  if (/(?:bash|shell|exec|process|terminal|task)/.test(normalized)) return 'subprocess'
  if (/(?:read|write|edit|glob|grep|notebook|file)/.test(normalized)) return 'file'
  if (/(?:skill|plugin|slash|mcp__)/.test(normalized)) return 'dynamic-load'
  return 'tool'
}

export async function denyJwAgentToolCall(input: {
  toolName: string
  userId: string
  userName: string
  conversationId: string
}, auditWriter: typeof writeAudit = writeAudit) {
  const toolName = safeBoundaryValue(input.toolName)
  const conversationId = safeBoundaryValue(input.conversationId)
  const boundary = classifyJwAgentBoundary(toolName)
  try {
    await auditWriter({
      userId: input.userId,
      userName: input.userName,
      module: 'AI助手安全',
      action: '拒绝 Agent Runtime 越界访问',
      target: JSON.stringify({ conversationId, boundary, toolName }),
      result: 'denied',
    })
  } catch (error) {
    console.error(JSON.stringify({ event: 'jw_agent_boundary_audit_failed', boundary, conversationId, error: errorText(error) }))
  }
  console.warn(JSON.stringify({ event: 'jw_agent_boundary_denied', boundary, conversationId, toolName }))
  return {
    behavior: 'deny' as const,
    message: `工具 ${toolName} 不在 JW Runtime 生产白名单中`,
    interrupt: false,
  }
}

export function resolveJwAgentWorkspace(workspaceRoot: string, conversationId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId)) {
    throw Object.assign(new Error('会话工作目录标识无效'), { code: 'AGENT_WORKSPACE_INVALID', status: 400 })
  }
  const resolvedRoot = path.resolve(workspaceRoot)
  const resolved = path.resolve(resolvedRoot, conversationId)
  const relative = path.relative(resolvedRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('会话工作目录越界'), { code: 'AGENT_WORKSPACE_INVALID', status: 400 })
  }
  return resolved
}

export function assertJwAgentGatewayAllowed(baseUrl: string, env: NodeJS.ProcessEnv = process.env): void {
  let parsed: URL
  try { parsed = new URL(baseUrl) }
  catch { throw Object.assign(new Error('JW Agent 模型网关地址无效'), { code: 'AGENT_GATEWAY_INVALID' }) }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw Object.assign(new Error('JW Agent 模型网关协议或认证信息无效'), { code: 'AGENT_GATEWAY_INVALID' })
  }
  if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error('生产 JW Agent 模型网关必须使用 HTTPS'), { code: 'AGENT_GATEWAY_FORBIDDEN' })
  }
  const allowedHosts = (env.MODEL_PROVIDER_ALLOWED_HOSTS || '').split(',')
    .map((value) => value.trim().toLowerCase()).filter(Boolean)
  if ((env.NODE_ENV === 'production' || allowedHosts.length > 0) && !allowedHosts.includes(parsed.hostname.toLowerCase())) {
    throw Object.assign(new Error('JW Agent 模型网关不在生产白名单中'), { code: 'AGENT_GATEWAY_FORBIDDEN' })
  }
}

export function restrictedJwAgentEnvironment(
  config: { baseUrl: string; apiKey: string; model: string },
  workDir: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const key of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    env[key] = source[key]
  }
  return {
    ...env,
    HOME: workDir,
    ANTHROPIC_BASE_URL: config.baseUrl,
    ANTHROPIC_API_KEY: config.apiKey,
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_MODEL: config.model,
    CLAUDE_CONFIG_DIR: path.join(workDir, '.claude'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'cybernaut-interactive-agent/1.0',
  }
}

function errorText(error: unknown) {
  return redactSensitiveText(error instanceof Error ? error.message : error)
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function nonNegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function boundedInteractionText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

export function normalizeJwInteractionInput(
  toolUseId: string,
  inputValue: unknown,
  requestedAt = new Date().toISOString(),
): JwPendingInteraction {
  if (!toolUseId || toolUseId.length > 160) {
    throw Object.assign(new Error('交互请求标识无效'), { code: 'AGENT_INTERACTION_INVALID', status: 400 })
  }
  const input = record(inputValue)
  const rawQuestions = Array.isArray(input.questions) ? input.questions : []
  if (rawQuestions.length < 1 || rawQuestions.length > 4) {
    throw Object.assign(new Error('交互请求必须包含 1—4 个问题'), { code: 'AGENT_INTERACTION_INVALID', status: 400 })
  }
  const questions = rawQuestions.map((value, index): JwInteractionQuestion => {
    const question = record(value)
    const text = boundedInteractionText(question.question, 1_000)
    if (!text) {
      throw Object.assign(new Error('交互问题不能为空'), { code: 'AGENT_INTERACTION_INVALID', status: 400 })
    }
    const rawOptions = Array.isArray(question.options) ? question.options : []
    if (rawOptions.length < 1 || rawOptions.length > 8) {
      throw Object.assign(new Error('每个交互问题必须包含 1—8 个选项'), { code: 'AGENT_INTERACTION_INVALID', status: 400 })
    }
    const options = rawOptions.map((optionValue) => {
      const option = record(optionValue)
      const label = boundedInteractionText(option.label, 200)
      if (!label) {
        throw Object.assign(new Error('交互选项标签不能为空'), { code: 'AGENT_INTERACTION_INVALID', status: 400 })
      }
      return { label, description: boundedInteractionText(option.description, 500) }
    })
    if (new Set(options.map((option) => option.label)).size !== options.length) {
      throw Object.assign(new Error('同一问题的交互选项不能重名'), { code: 'AGENT_INTERACTION_INVALID', status: 400 })
    }
    return {
      id: `q${index + 1}`,
      header: boundedInteractionText(question.header, 80) || `问题 ${index + 1}`,
      question: text,
      options,
      multiSelect: question.multiSelect === true,
    }
  })
  return { id: toolUseId, toolName: 'AskUserQuestion', questions, requestedAt }
}

function normalizedPersistedJwInteraction(value: unknown): JwPendingInteraction | null {
  const pending = record(value)
  if (pending.toolName !== 'AskUserQuestion' || typeof pending.id !== 'string') return null
  try {
    return normalizeJwInteractionInput(pending.id, { questions: pending.questions },
      typeof pending.requestedAt === 'string' ? pending.requestedAt : new Date().toISOString())
  } catch {
    return null
  }
}

export function resolveJwInteractionAnswerInput(
  interaction: JwPendingInteraction,
  answersValue: unknown,
): Record<string, string | string[]> {
  const answers = record(answersValue)
  const resolved: Record<string, string | string[]> = {}
  for (const question of interaction.questions) {
    const value = answers[question.id]
    if (question.multiSelect) {
      if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
        throw Object.assign(new Error(`请回答“${question.header}”`), { code: 'AGENT_INTERACTION_ANSWER_INVALID', status: 400 })
      }
      const selected = value.map((item) => boundedInteractionText(item, 500)).filter(Boolean)
      if (selected.length !== value.length || new Set(selected).size !== selected.length) {
        throw Object.assign(new Error(`“${question.header}”的回答无效`), { code: 'AGENT_INTERACTION_ANSWER_INVALID', status: 400 })
      }
      resolved[question.question] = selected
    } else {
      const selected = boundedInteractionText(value, 500)
      if (!selected) {
        throw Object.assign(new Error(`请回答“${question.header}”`), { code: 'AGENT_INTERACTION_ANSWER_INVALID', status: 400 })
      }
      resolved[question.question] = selected
    }
  }
  return resolved
}

function normalizedTokenUsage(value: unknown): JwTokenUsage | null {
  const usage = record(value)
  const inputTokens = nonNegativeNumber(usage.input_tokens ?? usage.inputTokens)
  const outputTokens = nonNegativeNumber(usage.output_tokens ?? usage.outputTokens)
  if (inputTokens === null || outputTokens === null) return null
  const cacheCreationInputTokens = nonNegativeNumber(
    usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens,
  ) ?? 0
  const cacheReadInputTokens = nonNegativeNumber(
    usage.cache_read_input_tokens ?? usage.cacheReadInputTokens,
  ) ?? 0
  const totalInputTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalInputTokens,
    totalTokens: totalInputTokens + outputTokens,
  }
}

function normalizedContextCompaction(value: unknown): JwContextCompaction {
  const current = record(value)
  const trigger = current.lastTrigger
  const state = current.state
  const result = current.lastResult
  return {
    state: state === 'compacting' || state === 'failed' ? state : 'idle',
    count: Math.max(0, Math.trunc(nonNegativeNumber(current.count) ?? 0)),
    lastEventId: typeof current.lastEventId === 'string' ? current.lastEventId : null,
    lastTrigger: trigger === 'manual' || trigger === 'auto' ? trigger : null,
    lastPreTokens: nonNegativeNumber(current.lastPreTokens),
    lastPostTokens: nonNegativeNumber(current.lastPostTokens),
    lastDurationMs: nonNegativeNumber(current.lastDurationMs),
    startedAt: typeof current.startedAt === 'string' ? current.startedAt : null,
    lastCompletedAt: typeof current.lastCompletedAt === 'string' ? current.lastCompletedAt : null,
    lastResult: result === 'success' || result === 'failed' ? result : null,
    lastError: typeof current.lastError === 'string' ? current.lastError : null,
  }
}

export function projectJwRuntimeMetadata(
  currentMetadata: unknown,
  rawValue: unknown,
  observedAt = new Date().toISOString(),
): JsonRecord {
  const current = record(currentMetadata)
  const raw = record(rawValue)
  if (raw.type === 'system' && raw.subtype === 'init') {
    return {
      sdkSessionId: typeof raw.session_id === 'string' ? raw.session_id : current.sdkSessionId,
      activeModel: typeof raw.model === 'string' ? raw.model : current.activeModel,
    }
  }
  if (raw.type === 'result') {
    const usage = normalizedTokenUsage(raw.usage)
    const errors = Array.isArray(raw.errors)
      ? raw.errors.filter((item): item is string => typeof item === 'string').join('; ')
      : ''
    const totalCostUsd = nonNegativeNumber(raw.total_cost_usd)
    const numTurns = nonNegativeNumber(raw.num_turns)
    const durationMs = nonNegativeNumber(raw.duration_ms)
    return {
      lastResult: {
        subtype: typeof raw.subtype === 'string' ? raw.subtype : null,
        isError: Boolean(raw.is_error),
        totalCostUsd,
        numTurns,
        durationMs,
        usage,
        usageObservedAt: usage ? observedAt : null,
      },
      lastError: raw.is_error ? errorText(errors || raw.result || 'Agent execution failed') : null,
    }
  }
  if (raw.type !== 'system') return {}

  const compaction = normalizedContextCompaction(current.contextCompaction)
  if (raw.subtype === 'compact_boundary') {
    const compactMetadata = record(raw.compact_metadata)
    const eventId = typeof raw.uuid === 'string'
      ? raw.uuid
      : `${String(raw.session_id || '')}:${String(compactMetadata.trigger || '')}:${String(compactMetadata.pre_tokens || '')}`
    const duplicate = Boolean(eventId && eventId === compaction.lastEventId)
    return {
      contextCompaction: {
        ...compaction,
        state: 'idle',
        count: compaction.count + (duplicate ? 0 : 1),
        lastEventId: eventId || compaction.lastEventId,
        lastTrigger: compactMetadata.trigger === 'manual' || compactMetadata.trigger === 'auto'
          ? compactMetadata.trigger
          : compaction.lastTrigger,
        lastPreTokens: nonNegativeNumber(compactMetadata.pre_tokens),
        lastPostTokens: nonNegativeNumber(compactMetadata.post_tokens),
        lastDurationMs: nonNegativeNumber(compactMetadata.duration_ms),
        lastCompletedAt: duplicate ? compaction.lastCompletedAt : observedAt,
        lastResult: 'success',
        lastError: null,
      },
    }
  }
  if (raw.subtype === 'status' && raw.status === 'compacting') {
    return {
      contextCompaction: {
        ...compaction,
        state: 'compacting',
        startedAt: observedAt,
        lastError: null,
      },
    }
  }
  if (raw.subtype === 'status' && raw.status === null) {
    const failed = raw.compact_result === 'failed'
    return {
      contextCompaction: {
        ...compaction,
        state: failed ? 'failed' : 'idle',
        lastResult: failed ? 'failed' : raw.compact_result === 'success' ? 'success' : compaction.lastResult,
        lastError: failed ? errorText(raw.compact_error || '上下文压缩失败') : null,
      },
    }
  }
  return {}
}

function environmentRuntimeConfig() {
  const configuredBase = process.env.JW_AGENT_BASE_URL
    || process.env.ANTHROPIC_BASE_URL
    || process.env.OPENAI_BASE_URL
    || process.env.LLM_BASE_URL
    || ''
  const baseUrl = configuredBase.replace(/\/v1\/?$/, '').replace(/\/$/, '')
  const apiKey = process.env.JW_AGENT_API_KEY
    || process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN
    || process.env.OPENAI_API_KEY
    || process.env.LLM_API_KEY
    || ''
  const model = process.env.JW_AGENT_MODEL || process.env.LLM_MODEL || ''
  const maxTurns = Number(process.env.JW_AGENT_MAX_TURNS || 12)
  const maxBudgetUsd = Number(process.env.JW_AGENT_MAX_BUDGET_USD || 5)
  const interactionTimeoutMs = Number(process.env.JW_AGENT_INTERACTION_TIMEOUT_MS || 900_000)
  if (!baseUrl) throw new Error('JW Agent 未配置模型网关地址（JW_AGENT_BASE_URL/OPENAI_BASE_URL）')
  if (!apiKey) throw new Error('JW Agent 未配置模型网关密钥（JW_AGENT_API_KEY/OPENAI_API_KEY）')
  if (!model) throw new Error('JW Agent 未配置模型（JW_AGENT_MODEL/LLM_MODEL）')
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 50) {
    throw new Error('JW_AGENT_MAX_TURNS 必须是 1—50 的整数')
  }
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 || maxBudgetUsd > 100) {
    throw new Error('JW_AGENT_MAX_BUDGET_USD 必须大于 0 且不超过 100')
  }
  if (!Number.isSafeInteger(interactionTimeoutMs) || interactionTimeoutMs < 60_000 || interactionTimeoutMs > 3_600_000) {
    throw new Error('JW_AGENT_INTERACTION_TIMEOUT_MS 必须是 60000—3600000 的整数')
  }
  return { baseUrl, apiKey, model, maxTurns, maxBudgetUsd, interactionTimeoutMs }
}

async function runtimeConfig(modelId?: string | null, userRole?: string, modelRouteKey: AiModelProfileKey = 'interactive-assistant') {
  const fallback = environmentRuntimeConfig()
  const selected = modelId ? await resolveAiModelById(modelId, userRole) : null
  const configured = selected || await resolveAiModelRoute(modelRouteKey, userRole)
  if (!configured) return fallback
  return {
    ...fallback,
    baseUrl: configured.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, ''),
    apiKey: configured.apiKey,
    model: configured.model,
  }
}

async function resolveConversation(userId: string, agentId: string) {
  const chat = await agentConversationRepository.findChatByAgentForUser(userId, agentId)
  if (!chat) return null
  if (chat.projectId && !(await getAccessibleProject(userId, chat.projectId))) return null
  return { chat, agent: await agentConversationRepository.ensureAgentFromChat(chat) }
}

async function insertMessage(input: {
  conversationId: string
  externalMessageId: string
  role: string
  content?: string | null
  thinking?: string | null
  toolName?: string | null
  toolInput?: unknown
  toolOutput?: unknown
  status?: string
  preserveTerminalStatus?: boolean
  parts?: { type: string; content?: string | null; payload?: unknown }[]
}) {
  await agentConversationRepository.saveMessage(input)
  publishJwAgentChange(input.conversationId)
}

function contentText(content: unknown) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block && typeof block === 'object' && (block as { type?: string }).type === 'text')
    .map((block) => String((block as { text?: unknown }).text ?? '')).join('')
}

async function persistAssistant(conversationId: string, raw: Record<string, unknown>) {
  const message = raw.message && typeof raw.message === 'object'
    ? raw.message as Record<string, unknown>
    : {}
  const blocks = Array.isArray(message.content) ? message.content as Record<string, unknown>[] : []
  const uuid = typeof raw.uuid === 'string' ? raw.uuid : randomUUID()
  const text = blocks.filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).join('')
  const thinking = blocks.filter((block) => block.type === 'thinking').map((block) => String(block.thinking ?? '')).join('')
  const visibleParts = blocks.flatMap((block) => {
    if (block.type === 'text') return [{ type: 'text', content: String(block.text ?? '') }]
    if (block.type === 'thinking') return [{ type: 'reasoning', content: String(block.thinking ?? '') }]
    return []
  })
  if (visibleParts.length) {
    await insertMessage({
      conversationId,
      externalMessageId: `assistant:${uuid}`,
      role: 'assistant',
      content: text || null,
      thinking: thinking || null,
      parts: visibleParts,
    })
  }
  for (const block of blocks) {
    if (block.type !== 'tool_use') continue
    const toolUseId = typeof block.id === 'string' ? block.id : randomUUID()
    const existingTool = await agentConversationRepository.findMessageByExternalId(
      conversationId,
      `tool:${toolUseId}`,
    )
    // SDK 断线恢复时可能重放 assistant/tool_use。已经落到终态的工具不能
    // 被旧事件重新标记为 running，否则刷新页面会出现“已完成又转圈”。
    if (existingTool && ['complete', 'error', 'interrupted'].includes(existingTool.status)) continue
    await insertMessage({
      conversationId,
      externalMessageId: `tool:${toolUseId}`,
      role: 'tool',
      toolName: String(block.name || 'unknown').slice(0, 128),
      toolInput: block.input,
      status: 'running',
      preserveTerminalStatus: true,
      parts: [{
        type: 'dynamic-tool',
        payload: {
          type: 'dynamic-tool',
          toolName: String(block.name || 'unknown'),
          state: 'input-available',
          input: block.input,
        },
      }],
    })
  }
}

export async function persistJwAgentProtocolMessage(
  conversationId: string,
  raw: Record<string, unknown>,
) {
  if (raw.type === 'assistant') {
    await persistAssistant(conversationId, raw)
    return
  }
  if (raw.type === 'user') await persistToolResult(conversationId, raw)
}

async function persistToolResult(conversationId: string, raw: Record<string, unknown>) {
  const message = raw.message && typeof raw.message === 'object'
    ? raw.message as Record<string, unknown>
    : {}
  const blocks = Array.isArray(message.content) ? message.content as Record<string, unknown>[] : []
  for (const block of blocks) {
    if (block.type !== 'tool_result') continue
    const toolUseId = String(block.tool_use_id || raw.parent_tool_use_id || '')
    if (!toolUseId) continue
    const tool = await agentConversationRepository.findMessageByExternalId(conversationId, `tool:${toolUseId}`)
    if (!tool) continue
    const output = block.content ?? raw.tool_use_result ?? null
    const isError = Boolean(block.is_error)
    await insertMessage({
      conversationId,
      externalMessageId: `tool:${toolUseId}`,
      role: 'tool',
      toolName: tool.toolName,
      toolInput: tool.toolInput,
      toolOutput: output,
      status: isError ? 'error' : 'complete',
      parts: [{
        type: 'dynamic-tool',
        payload: {
          type: 'dynamic-tool',
          toolName: tool.toolName || 'unknown',
          state: isError ? 'output-error' : 'output-available',
          input: tool.toolInput,
          output,
          errorText: isError ? contentText(output) || '工具执行失败' : '',
        },
      }],
    })
  }
}

function applyStreamEvent(session: RuntimeSession, event: Record<string, unknown>) {
  markAiRuntimeFirstTokenFromSdkMessage(session.telemetryRequestId, { type: 'stream_event', event })
  if (event.type === 'message_start') session.partialParts = []
  if (event.type === 'content_block_start') {
    const block = event.content_block as Record<string, unknown> | undefined
    if (block?.type === 'text') session.partialParts.push({ type: 'text', text: String(block.text ?? '') })
    if (block?.type === 'thinking') session.partialParts.push({ type: 'reasoning', text: String(block.thinking ?? '') })
    if (block?.type === 'tool_use') session.partialParts.push({
      type: 'dynamic-tool', toolName: String(block.name || 'unknown'), state: 'input-streaming', input: block.input,
    })
  }
  if (event.type === 'content_block_delta') {
    const index = Number(event.index)
    const delta = event.delta as Record<string, unknown> | undefined
    const part = session.partialParts[index]
    if (!part || !delta) return
    if (delta.type === 'text_delta') part.text = String(part.text ?? '') + String(delta.text ?? '')
    if (delta.type === 'thinking_delta') part.text = String(part.text ?? '') + String(delta.thinking ?? '')
  }
  publishJwAgentChange(session.conversationId)
}

async function updateConversationState(conversationId: string, status: string, metadataPatch: Record<string, unknown> = {}) {
  await agentConversationRepository.mergeConversationState(conversationId, status, metadataPatch)
  publishJwAgentChange(conversationId, status !== 'streaming')
}

async function settleJwInteraction(
  conversationId: string,
  outcome: 'answered' | 'cancelled' | 'aborted' | 'replaced' | 'shutdown' | 'timeout',
  answers?: Record<string, string | string[]>,
): Promise<boolean> {
  const controller = pendingInteractions.get(conversationId)
  if (!controller) return false
  const result: JwInteractionPermissionResult = outcome === 'answered'
    ? {
      behavior: 'allow',
      updatedInput: { ...controller.rawInput, answers: answers || {} },
      toolUseID: controller.interaction.id,
      decisionClassification: 'user_temporary',
    }
    : {
      behavior: 'deny',
      message: outcome === 'cancelled' ? '用户取消了本次交互问题' : '交互请求已结束',
      interrupt: false,
      toolUseID: controller.interaction.id,
      decisionClassification: 'user_reject',
    }
  await updateConversationState(conversationId, 'streaming', {
    pendingInteraction: null,
    lastInteraction: {
      id: controller.interaction.id,
      outcome,
      answeredQuestionCount: outcome === 'answered' ? controller.interaction.questions.length : 0,
      respondedAt: new Date().toISOString(),
    },
  })
  pendingInteractions.delete(conversationId)
  controller.removeAbortListener?.()
  if (controller.timeout) clearTimeout(controller.timeout)
  controller.resolve(result)
  return true
}

export async function beginJwAgentInteraction(
  conversationId: string,
  toolUseId: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = 900_000,
): Promise<JwInteractionPermissionResult> {
  if (pendingInteractions.has(conversationId)) {
    await settleJwInteraction(conversationId, 'replaced')
  }
  const interaction = normalizeJwInteractionInput(toolUseId, input)
  let resolvePermission!: (result: JwInteractionPermissionResult) => void
  const permission = new Promise<JwInteractionPermissionResult>((resolve) => { resolvePermission = resolve })
  const controller: PendingJwInteractionController = {
    interaction,
    rawInput: input,
    resolve: resolvePermission,
  }
  if (signal) {
    const onAbort = () => {
      void settleJwInteraction(conversationId, 'aborted').catch(() => {
        if (pendingInteractions.get(conversationId) !== controller) return
        pendingInteractions.delete(conversationId)
        controller.resolve({
          behavior: 'deny', message: '交互请求已结束', interrupt: false,
          toolUseID: interaction.id, decisionClassification: 'user_reject',
        })
      })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    controller.removeAbortListener = () => signal.removeEventListener('abort', onAbort)
  }
  pendingInteractions.set(conversationId, controller)
  controller.timeout = setTimeout(() => {
    void settleJwInteraction(conversationId, 'timeout').catch(() => false)
  }, timeoutMs)
  controller.timeout.unref?.()
  try {
    await updateConversationState(conversationId, 'streaming', { pendingInteraction: interaction })
  } catch (error) {
    pendingInteractions.delete(conversationId)
    controller.removeAbortListener?.()
    if (controller.timeout) clearTimeout(controller.timeout)
    controller.resolve({
      behavior: 'deny', message: '交互请求保存失败', interrupt: false,
      toolUseID: interaction.id, decisionClassification: 'user_reject',
    })
    throw error
  }
  return permission
}

export async function respondJwAgentInteraction(input: {
  userId: string
  agentId: string
  interactionId: string
  action: 'answer' | 'cancel'
  answers?: unknown
}) {
  const resolved = await resolveConversation(input.userId, input.agentId)
  if (!resolved) return null
  const controller = pendingInteractions.get(resolved.agent.id)
  if (!controller || controller.interaction.id !== input.interactionId) {
    throw Object.assign(new Error('交互请求已结束或服务已重启，请刷新会话'), {
      code: 'AGENT_INTERACTION_NOT_ACTIVE', status: 409,
    })
  }
  if (input.action === 'cancel') {
    await settleJwInteraction(resolved.agent.id, 'cancelled')
    return { ok: true, outcome: 'cancelled' as const }
  }
  const answers = resolveJwInteractionAnswerInput(controller.interaction, input.answers)
  await settleJwInteraction(resolved.agent.id, 'answered', answers)
  return { ok: true, outcome: 'answered' as const }
}

export async function persistJwRuntimeEvent(
  conversationId: string,
  status: string,
  raw: Record<string, unknown>,
  observedAt = new Date().toISOString(),
) {
  const current = await agentConversationRepository.findAgentById(conversationId)
  const metadataPatch = projectJwRuntimeMetadata(current?.metadata, raw, observedAt)
  await updateConversationState(conversationId, status, metadataPatch)
}

export function isMissingSdkConversationResult(rawValue: unknown) {
  const raw = record(rawValue)
  if (raw.type !== 'result' || !raw.is_error) return false
  const errors = Array.isArray(raw.errors)
    ? raw.errors.filter((item): item is string => typeof item === 'string')
    : []
  const combined = [raw.result, raw.error, ...errors]
    .filter((item): item is string => typeof item === 'string')
    .join('\n')
  return isMissingSdkConversationError(combined)
}

export function isMissingSdkConversationError(value: unknown) {
  const message = value instanceof Error ? value.message : String(value || '')
  return /No conversation found with session ID:/i.test(message)
}

async function runOutputLoop(session: RuntimeSession) {
  try {
    for await (const value of session.query) {
      const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
      if (session.stoppingReason) continue
      if (raw.type === 'system' && raw.subtype === 'init') {
        await persistJwRuntimeEvent(session.conversationId, 'streaming', raw)
      } else if (raw.type === 'system' && (raw.subtype === 'compact_boundary' || raw.subtype === 'status')) {
        await persistJwRuntimeEvent(session.conversationId, 'streaming', raw)
      } else if (raw.type === 'stream_event' && raw.event && typeof raw.event === 'object') {
        applyStreamEvent(session, raw.event as Record<string, unknown>)
      } else if (raw.type === 'assistant') {
        session.assistantSeenForPending = true
        await persistJwAgentProtocolMessage(session.conversationId, raw)
        session.partialParts = []
      } else if (raw.type === 'user') {
        await persistJwAgentProtocolMessage(session.conversationId, raw)
      } else if (raw.type === 'result') {
        session.partialParts = []
        if (
          raw.is_error
          && isMissingSdkConversationResult(raw)
          && session.pendingUserMessage
          && !session.resumeRecoveryAttempted
          && !session.assistantSeenForPending
        ) {
          session.resumeRecoveryAttempted = true
          await updateConversationState(session.conversationId, 'streaming', {
            lastError: null,
            sdkSessionRecovery: {
              reason: 'missing_conversation', attemptedAt: new Date().toISOString(), attempt: 1,
            },
          })
          console.warn(JSON.stringify({
            event: 'jw_sdk_session_retry', conversationId: session.conversationId,
          }))
          session.queue.push(session.pendingUserMessage)
          continue
        }
        session.pendingUserMessage = null
        await persistJwRuntimeEvent(session.conversationId, raw.is_error ? 'error' : 'idle', raw)
        finishAiRuntimeRequest(session.telemetryRequestId, raw.is_error ? 'failed' : 'succeeded')
        session.telemetryRequestId = null
      }
    }
    if (!session.stoppingReason) await updateConversationState(session.conversationId, 'idle')
  } catch (error) {
    finishAiRuntimeRequest(session.telemetryRequestId, 'failed')
    session.telemetryRequestId = null
    if (!session.stoppingReason) {
      const missingConversation = isMissingSdkConversationError(error)
      await updateConversationState(session.conversationId, 'error', {
        lastError: errorText(error),
        ...(missingConversation ? {
          sdkSessionId: null,
          sdkSessionInvalidatedAt: new Date().toISOString(),
          sdkSessionInvalidationReason: 'missing_conversation',
        } : {}),
      })
      console.error(`[jw-runtime] conversation ${session.conversationId} failed:`, errorText(error))
    }
  } finally {
    finishAiRuntimeRequest(session.telemetryRequestId, session.stoppingReason ? 'cancelled' : 'failed')
    session.telemetryRequestId = null
    session.queue.end()
    sessions.delete(session.conversationId)
  }
}

async function createRuntimeSession(
  userId: string,
  conversationId: string,
  metadata: Record<string, unknown>,
  projectId: string | null,
  userRole: string,
  modelId?: string | null,
) {
  const { createSdkMcpServer, query, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const runtimeUser = await identityRepositories.users.findById(userId)
  if (!runtimeUser || runtimeUser.status !== '启用') {
    throw Object.assign(new Error('用户不存在或已停用'), { code: 'AUTH_USER_NOT_FOUND', status: 401 })
  }
  const runtimeCapabilities = await resolveSelectedRuntimeCapabilities({
    userId, userName: runtimeUser.name, role: userRole, department: runtimeUser.department,
  }, conversationId)
  const mcpCapabilities = runtimeCapabilities.filter((item) => item.kind === 'mcp')
  const agentCapabilities = runtimeCapabilities.filter((item) => item.kind === 'agent')
  const interactiveAgentCapability = agentCapabilities.find((item) => item.capabilityKey === 'interactive-assistant')
    ?? agentCapabilities.find((item) => item.source === 'uploaded')
  const uploadedPlugins = runtimeCapabilities.filter((item) => item.kind === 'plugin')
  const selectedSkillNames = new Set([
    ...runtimeCapabilities.filter((item) => item.kind === 'skill').map((item) => item.capabilityKey),
    ...uploadedPlugins
      .map((item) => typeof item.config.skillName === 'string' ? item.config.skillName : '')
      .filter(Boolean),
  ])
  const pluginToolNames = new Set(uploadedPlugins.flatMap((item) => item.toolNames || []).map((name) => `mcp__investment__${name}`))
  const mcpToolNames = new Set(mcpCapabilities.flatMap((item) => item.toolNames || []).map((name) => `mcp__investment__${name}`))
  const pluginPrompts = uploadedPlugins
    .map((item) => typeof item.config.prompt === 'string' ? item.config.prompt.trim() : '')
    .filter(Boolean)
  let uploadedPromptBudget = 128_000
  const uploadedCapabilityPrompts = runtimeCapabilities
    .filter((item) => item.source === 'uploaded' && item.kind !== 'plugin')
    .map((item) => {
      const value = typeof item.config.instructions === 'string'
        ? item.config.instructions.trim()
        : typeof item.config.prompt === 'string' ? item.config.prompt.trim() : ''
      if (!value || uploadedPromptBudget <= 0) return ''
      const bounded = value.slice(0, uploadedPromptBudget)
      uploadedPromptBudget -= bounded.length
      return `[上传 ${item.kind.toUpperCase()} ${item.capabilityKey}]\n${bounded}`
    })
    .filter(Boolean)
  if (!interactiveAgentCapability) {
    throw Object.assign(new Error('互动助手能力已停用、未授权或未加载'), { code: 'AGENT_CAPABILITY_FORBIDDEN', status: 403 })
  }
  const agentPolicy = normalizeAgentRuntimePolicy(interactiveAgentCapability)
  const baseConfig = await runtimeConfig(modelId, userRole, agentPolicy.modelRouteKey)
  const config = {
    ...baseConfig,
    maxTurns: Math.min(baseConfig.maxTurns, agentPolicy.maxTurns),
    maxBudgetUsd: Math.min(baseConfig.maxBudgetUsd, agentPolicy.maxBudgetUsd),
    interactionTimeoutMs: Math.min(baseConfig.interactionTimeoutMs, agentPolicy.timeoutMs),
  }
  assertJwAgentGatewayAllowed(config.baseUrl)
  const selectedAgentToolNames = new Set([
    ...agentPolicy.toolNames.map((name) => `mcp__investment__${name}`),
    ...pluginToolNames,
    ...mcpToolNames,
  ])
  const hostInvestmentEnabled = Boolean(mcpCapabilities.length || pluginToolNames.size || mcpToolNames.size)
  const allowedAgentTools = jwAgentToolsForScope(
    JW_AGENT_ALLOWED_TOOLS.filter((name) => selectedAgentToolNames.has(name)),
    projectId,
  )
  const allowedAgentToolSet = new Set<string>(allowedAgentTools)
  const workspaceRoot = path.resolve(process.env.AGENT_WORKSPACE || path.join(process.cwd(), 'server', 'agent-workspace'))
  const cwd = resolveJwAgentWorkspace(workspaceRoot, conversationId)
  await mkdir(cwd, { recursive: true })
  const queue = new MessageQueue()
  let session: RuntimeSession | undefined
  const investmentTools = createSdkMcpServer({
    name: 'investment',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      tool(
        'search_project_docs',
        '检索当前会话已授权的项目资料或全局知识库。项目作用域由服务端绑定，不能由模型修改。',
        { query: z.string().min(1), compareLeadPool: z.boolean().optional() },
        async ({ query: question, compareLeadPool }) => {
          const payload = await searchProjectDocsForUser({ userId, projectId, query: question, compareLeadPool })
          return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
        },
        { alwaysLoad: true },
      ),
      tool(
        'get_project_summary',
        '读取当前会话已授权项目的主记录、最新 AI 摘要、关联记录统计和来源定位。项目由服务端绑定。',
        {},
        async () => {
          if (!projectId) throw Object.assign(new Error('当前会话未绑定项目'), { code: 'PROJECT_SCOPE_REQUIRED' })
          return { content: [{ type: 'text', text: JSON.stringify(await getProjectSummaryForUser({ userId, projectId })) }] }
        },
        { alwaysLoad: true },
      ),
      tool(
        'list_project_files',
        '列出当前会话已授权项目的文件、解析状态、版本和完整性元数据。项目由服务端绑定。',
        {},
        async () => {
          if (!projectId) throw Object.assign(new Error('当前会话未绑定项目'), { code: 'PROJECT_SCOPE_REQUIRED' })
          return { content: [{ type: 'text', text: JSON.stringify(await listProjectFilesForUser({ userId, projectId })) }] }
        },
        { alwaysLoad: true },
      ),
      tool(
        'read_project_file',
        '按文件 ID 读取当前已授权项目的已解析文本片段，返回来源和定位；不能指定其他项目。',
        { fileId: z.string().uuid(), maxChunks: z.number().int().min(1).max(20).optional() },
        async ({ fileId, maxChunks }) => {
          if (!projectId) throw Object.assign(new Error('当前会话未绑定项目'), { code: 'PROJECT_SCOPE_REQUIRED' })
          const payload = await readProjectFileForUser({ userId, projectId, fileId, maxChunks })
          return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
        },
        { alwaysLoad: true },
      ),
      tool(
        'create_ai_task',
        '仅在用户明确要求生成内置专业材料时，创建当前项目会话的受控后台任务。此工具不使用自定义模板 ID；项目、会话、输出格式和幂等键由服务端绑定。',
        JW_AGENT_CREATE_AI_TASK_INPUT_SCHEMA,
        async ({ type, sourceCutoffDate, instructions }) => {
          if (!projectId) throw Object.assign(new Error('当前会话未绑定项目'), { code: 'PROJECT_SCOPE_REQUIRED' })
          const quickInvocation = session?.quickSkillInvocation
          if (quickInvocation && type !== quickInvocation.taskType) {
            throw Object.assign(new Error(`本轮快捷 Skill 只允许创建 ${quickInvocation.taskType} 任务`), {
              code: 'CAPABILITY_FORBIDDEN', status: 403,
            })
          }
          if (!selectedSkillsAllowAiTask(selectedSkillNames, type)) {
            throw Object.assign(new Error('当前会话未加载该文档任务所需 Skill'), {
              code: 'CAPABILITY_FORBIDDEN', status: 403,
            })
          }
          const payload = await createAgentAiTaskForUser({
            userId,
            projectId,
            conversationId,
            type,
            sourceCutoffDate,
            instructions: quickInvocation?.instructions || instructions,
            attachmentFileIds: quickInvocation?.attachmentFileIds,
          })
          return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
        },
        { alwaysLoad: true },
      ),
      tool(
        'get_ai_task_status',
        '查询当前项目会话中由当前用户创建的专业任务状态、阶段、进度、产物和来源。',
        { taskId: z.string().uuid() },
        async ({ taskId }) => {
          if (!projectId) throw Object.assign(new Error('当前会话未绑定项目'), { code: 'PROJECT_SCOPE_REQUIRED' })
          const payload = await getAgentAiTaskStatusForUser({
            userId, projectId, conversationId, taskId,
          })
          return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
        },
        { alwaysLoad: true },
      ),
      tool(
        'collect_public_intel',
        '按公司名称和明确核验主题采集公开搜索证据。结果是搜索摘要，引用前仍需核验原始页面。',
        { company: z.string().min(2), topics: z.array(z.string()).max(8).optional() },
        async ({ company, topics }) => ({
          content: [{ type: 'text', text: JSON.stringify(await collectCompanyIntel({ company, topics })) }],
        }),
        { alwaysLoad: true },
      ),
    ],
  })
  const sdkQuery = query({
    prompt: queue as never,
    options: {
      cwd,
      model: config.model,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
      resume: typeof metadata.sdkSessionId === 'string' ? metadata.sdkSessionId : undefined,
      // 对话 Runtime 只暴露宿主绑定的固定 MCP 工具和由服务端暂停/鉴权/持久化的
      // AskUserQuestion。文件、Shell 与其他 Claude Code 内建工具不进入模型上下文。
      // `dontAsk` 会在进入 canUseTool 前自动拒绝需要确认的工具；使用 default
      // 才能让显式 settings.permissions.ask 规则把 AskUserQuestion 交给宿主。
      // 可见内建工具仍只有这一项，未知工具继续由 canUseTool 失败关闭。
      permissionMode: 'default',
      tools: [JW_AGENT_INTERACTIVE_TOOL],
      skills: [],
      // AskUserQuestion is deliberately absent: allowedTools bypasses the
      // permission callback. The explicit settings.ask rule below routes it to canUseTool.
      allowedTools: hostInvestmentEnabled ? allowedAgentTools : [],
      settings: jwAgentPermissionSettings(),
      canUseTool: async (toolName, toolInput, permissionOptions) => {
        if (toolName === JW_AGENT_INTERACTIVE_TOOL) {
          return beginJwAgentInteraction(
            conversationId,
            permissionOptions.toolUseID,
            toolInput,
            permissionOptions.signal,
            config.interactionTimeoutMs,
          )
        }
        if (hostInvestmentEnabled && allowedAgentToolSet.has(toolName) && jwAgentToolAllowed(toolName)) return { behavior: 'allow' }
        return denyJwAgentToolCall({ toolName, userId, userName: runtimeUser.name, conversationId })
      },
      includePartialMessages: true,
      settingSources: [],
      mcpServers: hostInvestmentEnabled ? { investment: investmentTools } : {},
      env: restrictedJwAgentEnvironment(config, cwd),
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: [
          jwAgentSystemPrompt(projectId),
          ...pluginPrompts.map((prompt, index) => `\n[已安装 Plugin ${index + 1} 行为说明]\n${prompt}`),
          ...uploadedCapabilityPrompts,
        ].join('\n'),
      },
    },
  }) as RuntimeQuery
  session = {
    conversationId,
    queue,
    query: sdkQuery,
    partialParts: [],
    telemetryRequestId: null,
    outputLoop: Promise.resolve(),
    stoppingReason: null,
    pendingUserMessage: null,
    resumeRecoveryAttempted: false,
    assistantSeenForPending: false,
    selectedSkillNames,
    quickSkillInvocation: null,
  }
  session.outputLoop = runOutputLoop(session)
  sessions.set(conversationId, session)
  return session
}

export async function sendJwAgentMessage(
  userId: string,
  userRole: string,
  agentId: string,
  message: string,
  options: JwMessageOptions = {},
) {
  return await sendJwAgentMessageWithMedia(userId, userRole, agentId, message, {}, options)
}

export async function sendJwAgentMessageWithImages(
  userId: string,
  userRole: string,
  agentId: string,
  message: string,
  images: WeixinInboundImage[],
) {
  return await sendJwAgentMessageWithMedia(userId, userRole, agentId, message, { images })
}

export async function sendJwAgentMessageWithMedia(
  userId: string,
  userRole: string,
  agentId: string,
  message: string,
  media: { images?: WeixinInboundImage[]; documents?: WeixinInboundDocument[] },
  options: JwMessageOptions = {},
) {
  const resolved = await resolveConversation(userId, agentId)
  if (!resolved) return null
  return await withJwConversationOperation(resolved.agent.id, async () => {
    const refreshed = await resolveConversation(userId, agentId)
    if (!refreshed) return null
    if (pendingInteractions.has(refreshed.agent.id)) {
      throw Object.assign(new Error('请先回答或取消当前交互问题'), {
        code: 'AGENT_INTERACTION_PENDING', status: 409,
      })
    }
    const clean = message.trim()
    const quickBinding = options.skillName
      ? await resolveQuickSkillBinding(options.skillName)
      : null
    if (quickBinding && !refreshed.agent.projectId) {
      throw Object.assign(new Error('快捷文档 Skill 只能在已绑定项目的会话中使用'), {
        code: 'PROJECT_SCOPE_REQUIRED', status: 409,
      })
    }
    const attachmentFileIds = [...new Set(options.attachmentFileIds || [])].slice(0, 10)
    const attachmentFileNames = [...new Set(options.attachmentFileNames || [])].slice(0, 10)
    const recentContext = quickBinding
      ? (await agentConversationRepository.listMessagesWithParts(refreshed.agent.id))
          .slice(-6)
          .map(({ message: row }) => row.content || '')
      : []
    const validImages = (media.images || []).slice(0, 4).filter((image) => (
      ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(image.mediaType)
      && image.byteSize > 0
      && image.byteSize <= 25 * 1024 * 1024
      && Boolean(image.dataBase64)
      && /^[0-9a-f]{64}$/.test(image.sha256)
    ))
    const validDocuments = (media.documents || []).slice(0, 3).filter((document) => (
      document.fileName.length > 0
      && document.fileName.length <= 180
      && document.byteSize > 0
      && document.byteSize <= 20 * 1024 * 1024
      && /^[0-9a-f]{64}$/.test(document.sha256)
      && (
        (document.kind === 'pdf'
          && document.mediaType === 'application/pdf'
          && Boolean(document.dataBase64)
          && Buffer.byteLength(document.dataBase64 || '', 'base64') === document.byteSize)
        || (document.kind === 'text'
          && ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/markdown'].includes(document.mediaType)
          && Boolean(document.text)
          && (document.text?.length || 0) <= 300_100)
      )
    ))
    if (!clean && !validImages.length && !validDocuments.length) throw new Error('消息不能为空')
    const attachmentSummary = [
      validImages.length ? `微信图片 ${validImages.length} 张` : '',
      validDocuments.length ? `微信文件 ${validDocuments.length} 个` : '',
    ].filter(Boolean).join('，')
    const persistedText = clean || `[${attachmentSummary}]`
    if (refreshed.agent.status === 'streaming') {
      const active = sessions.get(refreshed.agent.id)
      if (!active) await updateConversationState(refreshed.agent.id, 'idle', { lastError: '服务重启后已清理旧的流式状态' })
      else throw new Error('当前会话正在回答，请等待完成或先停止')
    }

    await insertMessage({
      conversationId: refreshed.agent.id,
      externalMessageId: `user:${randomUUID()}`,
      role: 'user',
      content: persistedText,
      parts: [
        { type: 'text', content: persistedText },
        ...validImages.map((image) => ({
          type: 'image',
          content: '[微信图片]',
          payload: { mediaType: image.mediaType, byteSize: image.byteSize, sha256: image.sha256 },
        })),
        ...validDocuments.map((document) => ({
          type: 'file',
          content: `[微信文件：${document.fileName}]`,
          payload: {
            kind: document.kind, fileName: document.fileName, mediaType: document.mediaType,
            byteSize: document.byteSize, sha256: document.sha256, truncated: Boolean(document.truncated),
          },
        })),
      ],
    })
    await updateConversationState(refreshed.agent.id, 'streaming', { lastError: null })
    let telemetryRequestId: string | null = null
    try {
      const fresh = await agentConversationRepository.findAgentById(refreshed.agent.id)
      const session = sessions.get(refreshed.agent.id)
        || await createRuntimeSession(userId, refreshed.agent.id,
          fresh?.metadata || {},
          refreshed.agent.projectId,
          userRole,
          fresh?.modelId,
        )
      if (quickBinding && options.skillName) {
        session.selectedSkillNames.add(quickBinding.internalSkillName)
        session.quickSkillInvocation = {
          requestedSkillName: options.skillName,
          internalSkillName: quickBinding.internalSkillName,
          taskType: quickBinding.taskType,
          instructions: quickSkillTaskInstructions(clean, recentContext),
          attachmentFileIds,
          attachmentFileNames,
          customTemplateId: options.customTemplateId,
          customTemplateName: options.customTemplateName,
        }
        if (quickBinding.taskType === 'custom_template_document') {
          if (!options.customTemplateId) {
            throw Object.assign(new Error('上传模板快捷 Skill 缺少已分析模板'), {
              code: 'CUSTOM_TEMPLATE_REQUIRED', status: 400,
            })
          }
          const created = await createAgentAiTaskForUser({
            userId,
            projectId: refreshed.agent.projectId!,
            conversationId: session.conversationId,
            type: 'custom_template_document',
            instructions: session.quickSkillInvocation.instructions,
            attachmentFileIds,
            customTemplateId: options.customTemplateId,
          })
          const createdTask = created.task && typeof created.task === 'object'
            ? created.task as Record<string, unknown>
            : null
          if (!createdTask || typeof createdTask.id !== 'string') {
            throw new Error('上传模板任务创建后未返回有效任务 ID')
          }
          session.quickSkillInvocation.precreatedTaskId = createdTask.id
        }
      } else {
        session.quickSkillInvocation = null
      }
      telemetryRequestId = beginAiRuntimeRequest('jw-agent')
      session.telemetryRequestId = telemetryRequestId
      const attachments = [
        ...validImages.map((image) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: image.mediaType, data: image.dataBase64 },
        })),
        ...validDocuments.map((document) => document.kind === 'pdf' ? ({
          type: 'document' as const,
          source: {
            type: 'base64' as const,
            media_type: 'application/pdf' as const,
            data: document.dataBase64 || '',
          },
          title: document.fileName,
        }) : ({
          type: 'document' as const,
          source: { type: 'text' as const, media_type: 'text/plain' as const, data: document.text || '' },
          title: document.fileName,
          context: document.mediaType === 'text/markdown'
            ? '该文档来自微信接收的 Markdown 文件。'
            : '该文档来自微信接收的 DOCX 文件，已提取为纯文本。',
        })),
      ]
      const runtimeText = session.quickSkillInvocation
        ? quickSkillRuntimeMessage(clean, session.quickSkillInvocation)
        : clean
      const content = attachments.length ? [
        ...attachments,
        { type: 'text' as const, text: runtimeText || '请阅读并分析以上微信附件。' },
      ] : runtimeText
      const sdkSessionId = typeof fresh?.metadata?.sdkSessionId === 'string'
        ? fresh.metadata.sdkSessionId
        : null
      const userMessage = {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        ...(sdkSessionId ? { session_id: sdkSessionId } : {}),
      }
      session.pendingUserMessage = userMessage
      session.resumeRecoveryAttempted = false
      session.assistantSeenForPending = false
      session.queue.push(userMessage)
    } catch (error) {
      finishAiRuntimeRequest(telemetryRequestId, 'failed')
      await updateConversationState(refreshed.agent.id, 'error', { lastError: errorText(error) })
      throw error
    }
    return { accepted: true, conversationId: refreshed.agent.id }
  })
}

export async function getJwAgentSnapshot(userId: string, agentId: string) {
  const resolved = await resolveConversation(userId, agentId)
  if (!resolved) return null
  const storedMessages = await agentConversationRepository.listMessagesWithParts(resolved.agent.id)
  const messages: AgentSnapshotMessage[] = storedMessages.map(({ message: row, parts: storedParts }) => {
    const rendered = storedParts.map((part) => {
      if (part.type === 'text' || part.type === 'reasoning') return { type: part.type, text: part.content || '' }
      if (part.type === 'dynamic-tool' && part.payload && typeof part.payload === 'object') return part.payload as Record<string, unknown>
      return { type: 'unsupported', text: part.content || `暂不支持的消息类型：${part.type}` }
    })
    if (!rendered.length && row.content) rendered.push({ type: 'text', text: row.content })
    return {
      id: row.id,
      role: row.role === 'user' ? 'user' : 'assistant',
      parts: rendered,
      metadata: { timestamp: row.createdAt.toISOString() },
    }
  })
  const active = sessions.get(resolved.agent.id)
  if (active?.partialParts.length) messages.push({
    id: `streaming:${resolved.agent.id}`,
    role: 'assistant',
    parts: active.partialParts,
    metadata: { timestamp: new Date().toISOString(), transient: true },
  })
  const fresh = await agentConversationRepository.findAgentById(resolved.agent.id)
  return {
    id: agentId,
    status: fresh?.status || 'idle',
    error: typeof fresh?.metadata?.lastError === 'string' ? fresh.metadata.lastError : null,
    interaction: normalizedPersistedJwInteraction(fresh?.metadata?.pendingInteraction),
    runtime: {
      model: typeof fresh?.metadata?.activeModel === 'string' ? fresh.metadata.activeModel : null,
      usage: normalizedTokenUsage(record(fresh?.metadata?.lastResult).usage),
      totalCostUsd: nonNegativeNumber(record(fresh?.metadata?.lastResult).totalCostUsd),
      numTurns: nonNegativeNumber(record(fresh?.metadata?.lastResult).numTurns),
      durationMs: nonNegativeNumber(record(fresh?.metadata?.lastResult).durationMs),
      contextCompaction: normalizedContextCompaction(fresh?.metadata?.contextCompaction),
    },
    messages,
    updatedAt: fresh?.updatedAt.toISOString() || resolved.chat.updatedAt.toISOString(),
  }
}

export async function getJwAgentSubscription(userId: string, agentId: string) {
  const resolved = await resolveConversation(userId, agentId)
  if (!resolved) return null
  const snapshot = await getJwAgentSnapshot(userId, agentId)
  return snapshot ? { conversationId: resolved.agent.id, snapshot } : null
}

async function closeJwRuntimeSession(
  conversationId: string,
  reason: RuntimeSession['stoppingReason'] = 'dispose',
): Promise<boolean> {
  const session = sessions.get(conversationId)
  if (!session) return false
  sessions.delete(conversationId)
  session.stoppingReason = reason
  session.partialParts = []
  session.queue.end()
  try { await session.query.interrupt?.() } catch { /* close below is the fallback */ }
  try { session.query.close?.() } catch { /* output loop still settles */ }
  await session.outputLoop
  return true
}

export async function resetJwAgentSdkSession(userId: string, agentId: string) {
  const resolved = await resolveConversation(userId, agentId)
  if (!resolved) return null
  await closeJwRuntimeSession(resolved.agent.id).catch(() => false)
  await updateConversationState(resolved.agent.id, 'idle', {
    sdkSessionId: null,
    lastError: null,
    sdkSessionResetAt: new Date().toISOString(),
    sdkSessionResetReason: 'missing_conversation',
  })
  return { reset: true, conversationId: resolved.agent.id }
}

export async function recoverInterruptedJwAgentSessions() {
  const interruptedAt = new Date()
  return await agentConversationRepository.recoverStreamingSessions({
    interruptedAt,
    partErrorText: '服务重启，工具执行状态已中断',
    metadataFor: (conversation) => ({
      ...conversation.metadata,
      lastError: '服务重启中断了上一轮生成，请重新发送或继续对话',
      interruptedAt: interruptedAt.toISOString(),
      recoveredAfterRestart: true,
      pendingInteraction: null,
      lastInteraction: normalizedPersistedJwInteraction(conversation.metadata?.pendingInteraction)
        ? {
          id: normalizedPersistedJwInteraction(conversation.metadata?.pendingInteraction)?.id,
          outcome: 'service_restart',
          answeredQuestionCount: 0,
          respondedAt: interruptedAt.toISOString(),
        }
        : conversation.metadata?.lastInteraction,
    }),
  })
}

export async function abortJwAgent(userId: string, agentId: string) {
  const resolved = await resolveConversation(userId, agentId)
  if (!resolved) return null
  const session = sessions.get(resolved.agent.id)
  const interruptedAt = new Date()
  await settleJwInteraction(resolved.agent.id, 'aborted').catch(() => false)
  if (session) {
    session.stoppingReason = 'abort'
    session.partialParts = []
    session.queue.end()
    try { await session.query.interrupt?.() } catch { /* close below is the stop fallback */ }
    try { session.query.close?.() } catch { /* output loop still settles */ }
    await session.outputLoop
  }
  await markRunningJwToolsInterrupted(resolved.agent.id, 'user_stop', interruptedAt)
  await updateConversationState(resolved.agent.id, 'idle', {
    lastError: null,
    interruptedAt: interruptedAt.toISOString(),
    interruptionReason: 'user_stop',
  })
  return { ok: true }
}

async function markRunningJwToolsInterrupted(conversationId: string, reason: string, interruptedAt: Date) {
  return agentConversationRepository.interruptRunningTools({
    conversationId,
    reason,
    interruptedAt,
    partErrorText: '用户已停止本轮生成',
  })
}

export async function disposeJwAgentConversation(userId: string, agentId: string) {
  const resolved = await resolveConversation(userId, agentId)
  if (!resolved) return null
  await settleJwInteraction(resolved.agent.id, 'aborted').catch(() => false)
  return { ok: true, disposed: await closeJwRuntimeSession(resolved.agent.id, 'dispose') }
}

export async function switchJwAgentModel(input: {
  userId: string
  userName: string
  userRole: string
  agentId: string
  modelId: string | null
}) {
  const resolved = await resolveConversation(input.userId, input.agentId)
  if (!resolved) return null
  return await withJwConversationOperation(resolved.agent.id, async () => {
    const refreshed = await resolveConversation(input.userId, input.agentId)
    if (!refreshed) return null
    if (pendingInteractions.has(refreshed.agent.id) || refreshed.agent.status === 'streaming') {
      throw Object.assign(new Error('当前会话正在回答或等待交互，完成或停止后才能切换模型'), {
        code: 'AGENT_MODEL_SWITCH_BUSY', status: 409,
      })
    }
    if (input.modelId && !(await resolveAiModelById(input.modelId, input.userRole))) {
      throw Object.assign(new Error('所选模型不存在、已停用或当前用户无权使用'), {
        code: 'MODEL_FORBIDDEN', status: 403,
      })
    }
    const previousModelId = refreshed.agent.modelId || null
    if (previousModelId === input.modelId) {
      return { ok: true, modelId: input.modelId, disposed: false, unchanged: true }
    }
    const disposed = await closeJwRuntimeSession(refreshed.agent.id, 'dispose')
    const changedAt = new Date()
    await agentConversationRepository.updateModelForOwner({
      conversationId: refreshed.agent.id,
      userId: input.userId,
      modelId: input.modelId,
      metadataPatch: {
        ...(refreshed.agent.metadata || {}),
        activeModel: null,
        modelChangedAt: changedAt.toISOString(),
        modelChangedFrom: previousModelId,
        modelChangedTo: input.modelId,
        modelChangedBy: input.userId,
      },
      updatedAt: changedAt,
    })
    publishJwAgentChange(refreshed.agent.id)
    return { ok: true, modelId: input.modelId, disposed, unchanged: false }
  })
}

export async function shutdownJwAgentRuntime() {
  for (const conversationId of [...pendingInteractions.keys()]) {
    await settleJwInteraction(conversationId, 'shutdown').catch(() => false)
  }
  clearJwAgentChangeTimers()
  const active = [...sessions.values()]
  for (const session of active) {
    session.stoppingReason = 'shutdown'
    session.queue.end()
    try { await session.query.interrupt?.() } catch { /* process shutdown */ }
    try { session.query.close?.() } catch { /* process shutdown */ }
  }
  sessions.clear()
  await Promise.allSettled(active.map((session) => session.outputLoop))
}

export function jwAgentRuntimeHealth() {
  let configured = true
  let configurationError: string | null = null
  let maxTurns: number | null = null
  let maxBudgetUsd: number | null = null
  let interactionTimeoutMs: number | null = null
  try {
    const config = environmentRuntimeConfig()
    maxTurns = config.maxTurns
    maxBudgetUsd = config.maxBudgetUsd
    interactionTimeoutMs = config.interactionTimeoutMs
  } catch (error) { configured = false; configurationError = errorText(error) }
  return {
    name: 'jw-agent-runtime',
    ok: configured,
    inProcess: true,
    activeSessions: sessions.size,
    pendingInteractions: pendingInteractions.size,
    configurationError,
    permissionMode: 'default',
    settingsDefaultMode: 'dontAsk',
    builtInTools: 1,
    interactiveBuiltInTools: ['AskUserQuestion'],
    settingsSources: 0,
    allowedTools: [...JW_AGENT_ALLOWED_TOOLS],
    maxTurns,
    maxBudgetUsd,
    interactionTimeoutMs,
  }
}
