import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getAiSkillDirectory, type LoadedAiSkill } from './aiSkillService.js'
import type { EvidenceSource } from './aiBusinessContentService.js'
import { resolveAiModelRoute } from './aiModelSettingsService.js'
import {
  classifyDirectSkillAgentFailure,
  directSkillAgentGatewayRecoveryPolicy,
  type DirectSkillAgentGatewayRecoveryOptions,
} from './aiDirectSkillAgentRecovery.js'
import { redactSensitiveText } from '../security/redactSecrets.js'
import { directAgentResultUsage, directAgentTurnUsage } from '../runtime/directAgentUsage.js'

type ProjectIdentity = {
  id: string
  name: string
  companyName?: string | null
  industry?: string | null
  financing?: string | null
  valuation?: string | null
}

type DirectAgentRuntimeConfig = {
  baseUrl: string
  apiKey: string
  model: string
  maxTurns: number
  maxBudgetUsd: number
  timeoutMs: number
}

type DirectAgentMessage = {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  errors?: string[]
  num_turns?: number
  total_cost_usd?: number
  usage?: Record<string, unknown>
  modelUsage?: Record<string, Record<string, unknown>>
  message?: { content?: unknown; usage?: Record<string, unknown> }
}

type DirectAgentQuery = AsyncIterable<DirectAgentMessage> & {
  close?: () => void
}

type DirectAgentQueryFactory = (input: {
  prompt: string
  options: Record<string, unknown>
}) => DirectAgentQuery

export type DirectInvestmentProposalAgentProgress = {
  stage: string
  progress: number
  toolName?: string
}

export type DirectInvestmentProposalAgentResult = {
  outputPath: string
  documentSha256: string
  bytes: number
  skillInvoked: boolean
  session: {
    model: string
    numTurns: number
    totalCostUsd: number
    usage: Record<string, unknown> | null
    resultText: string
  }
  projectKnowledgeStudy: {
    mode: 'direct-skill-agent'
    requiredSourceDocumentCount: number
    sourceDocumentCount: number
    sourceChunkCount: number
    includedChunkCount: number
    sourceFilesRepresented: string[]
    completeProjectFileCoverage: true
    completeSourceChunkCoverage: true
    hostContentOrchestration: false
    hostEvidenceFallback: false
  }
}

export type DirectBusinessDocumentTaskType =
  | 'investment_proposal'
  | 'project_qa'
  | 'due_diligence_report'

type DirectBusinessDocumentProfile = {
  taskType: DirectBusinessDocumentTaskType
  skillName: string
  outputSuffix: string
  documentLabel: string
  authoringStage: string
  processContract: string
}

const DIRECT_BUSINESS_DOCUMENT_PROFILES: Record<DirectBusinessDocumentTaskType, DirectBusinessDocumentProfile> = {
  investment_proposal: {
    taskType: 'investment_proposal',
    skillName: 'draft-investment-proposal',
    outputSuffix: '投资提案',
    documentLabel: '投资提案',
    authoringStage: '编制投资提案',
    processContract: '建立事实库、冲突裁决、Decision Manifest、计算底稿、正文、Reviewer 修订和版式验收',
  },
  project_qa: {
    taskType: 'project_qa',
    skillName: 'draft-investment-qa',
    outputSuffix: '项目Q&A报告',
    documentLabel: '项目 Q&A 报告',
    authoringStage: '编制项目 Q&A 报告',
    processContract: '建立事实与证据台账、定义投资主线、设计并筛选问题、起草回答、执行 Markdown 门禁、DOCX 渲染和逐页视觉验收',
  },
  due_diligence_report: {
    taskType: 'due_diligence_report',
    skillName: 'draft-due-diligence-report',
    outputSuffix: '尽职调查报告',
    documentLabel: '尽职调查报告',
    authoringStage: '编制尽职调查报告',
    processContract: '确定报告类型、建立证据台账与字段数据层、形成合伙人观点、执行字段/内容/叙事门禁、DOCX 审计和逐页视觉验收',
  },
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback
}

async function runtimeConfig(role: string): Promise<DirectAgentRuntimeConfig> {
  const configured = await resolveAiModelRoute('ai-document', role)
    ?? await resolveAiModelRoute('interactive-assistant', role)
  const baseUrl = String(
    configured?.baseUrl
      ?? process.env.JW_AGENT_BASE_URL
      ?? process.env.ANTHROPIC_BASE_URL
      ?? process.env.OPENAI_BASE_URL
      ?? process.env.LLM_BASE_URL
      ?? '',
  ).replace(/\/v1\/?$/, '').replace(/\/$/, '')
  const apiKey = String(
    configured?.apiKey
      ?? process.env.JW_AGENT_API_KEY
      ?? process.env.ANTHROPIC_API_KEY
      ?? process.env.ANTHROPIC_AUTH_TOKEN
      ?? process.env.OPENAI_API_KEY
      ?? process.env.LLM_API_KEY
      ?? '',
  )
  const model = String(configured?.model ?? process.env.JW_AGENT_MODEL ?? process.env.LLM_MODEL ?? '')
  if (!baseUrl || !apiKey || !model) {
    throw Object.assign(new Error('文档 Agent 模型运行时未配置完整'), {
      code: 'DIRECT_SKILL_AGENT_NOT_CONFIGURED',
    })
  }
  assertDirectAgentGatewayAllowed(baseUrl)
  return {
    baseUrl,
    apiKey,
    model,
    maxTurns: boundedInteger(process.env.AI_DIRECT_SKILL_MAX_TURNS, 80, 10, 80),
    maxBudgetUsd: boundedNumber(process.env.AI_DIRECT_SKILL_MAX_BUDGET_USD, 20, 1, 100),
    timeoutMs: boundedInteger(process.env.AI_DIRECT_SKILL_TIMEOUT_MS, 7_200_000, 300_000, 7_200_000),
  }
}

function assertDirectAgentGatewayAllowed(baseUrl: string, env: NodeJS.ProcessEnv = process.env) {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw Object.assign(new Error('文档 Agent 模型网关地址无效'), {
      code: 'DIRECT_SKILL_AGENT_GATEWAY_INVALID',
    })
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw Object.assign(new Error('文档 Agent 模型网关协议或认证信息无效'), {
      code: 'DIRECT_SKILL_AGENT_GATEWAY_INVALID',
    })
  }
  if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error('生产文档 Agent 模型网关必须使用 HTTPS'), {
      code: 'DIRECT_SKILL_AGENT_GATEWAY_FORBIDDEN',
    })
  }
  const allowedHosts = (env.MODEL_PROVIDER_ALLOWED_HOSTS || '').split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (
    (env.NODE_ENV === 'production' || allowedHosts.length > 0)
    && !allowedHosts.includes(parsed.hostname.toLowerCase())
  ) {
    throw Object.assign(new Error('文档 Agent 模型网关不在生产白名单中'), {
      code: 'DIRECT_SKILL_AGENT_GATEWAY_FORBIDDEN',
    })
  }
}

function safeFileStem(value: string, fallback: string) {
  const cleaned = value.normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
  return cleaned || fallback
}

function sourceKey(source: EvidenceSource) {
  return `${source.sourceId || ''}\u0000${source.sourceName}\u0000${source.sourceType}`
}

async function materializeSources(input: {
  workspace: string
  sources: EvidenceSource[]
}) {
  const materialDirectory = path.join(input.workspace, 'materials')
  await mkdir(materialDirectory, { recursive: true, mode: 0o700 })
  const groups = new Map<string, EvidenceSource[]>()
  for (const source of input.sources) {
    const key = sourceKey(source)
    groups.set(key, [...(groups.get(key) ?? []), source])
  }
  const manifest: Array<Record<string, unknown>> = []
  let documentIndex = 0
  for (const groupedSources of groups.values()) {
    documentIndex += 1
    const first = groupedSources[0]
    const fileName = `${String(documentIndex).padStart(3, '0')}-${safeFileStem(first.sourceName, 'source')}.md`
    const ordered = [...groupedSources].sort((left, right) =>
      Number(left.chunkIndex ?? 0) - Number(right.chunkIndex ?? 0))
    const body = [
      `# ${first.sourceName}`,
      '',
      `- source_type: ${first.sourceType}`,
      `- source_id: ${first.sourceId || ''}`,
      `- version_or_date: ${first.versionOrDate || ''}`,
      `- chunk_count: ${ordered.length}`,
      '',
      ...ordered.flatMap((source, index) => [
        `## 片段 ${Number(source.chunkIndex ?? index) + 1}`,
        '',
        source.content,
        '',
      ]),
    ].join('\n')
    await writeFile(path.join(materialDirectory, fileName), body, { encoding: 'utf8', mode: 0o600 })
    manifest.push({
      fileName,
      sourceName: first.sourceName,
      sourceType: first.sourceType,
      sourceId: first.sourceId || null,
      chunkCount: ordered.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    })
  }
  await writeFile(
    path.join(materialDirectory, 'manifest.json'),
    JSON.stringify({ documentCount: manifest.length, chunkCount: input.sources.length, sources: manifest }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  )
  return { manifest, materialDirectory }
}

function restrictedEnvironment(config: DirectAgentRuntimeConfig, workspace: string) {
  const source = process.env
  const venvBin = path.resolve(process.cwd(), 'server', '.venv', 'bin')
  return {
    PATH: `${venvBin}:${source.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
    TMPDIR: source.TMPDIR,
    LANG: source.LANG || 'zh_CN.UTF-8',
    LC_ALL: source.LC_ALL,
    TZ: source.TZ || 'Asia/Shanghai',
    NODE_EXTRA_CA_CERTS: source.NODE_EXTRA_CA_CERTS,
    ANTHROPIC_BASE_URL: config.baseUrl,
    ANTHROPIC_API_KEY: config.apiKey,
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_MODEL: config.model,
    CLAUDE_CONFIG_DIR: path.join(workspace, '.claude-runtime'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'cybernaut-direct-document-agent/1.0',
  }
}

function assistantToolNames(message: DirectAgentMessage): string[] {
  const content = message.message?.content
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => {
    if (!block || typeof block !== 'object') return []
    const record = block as Record<string, unknown>
    return record.type === 'tool_use' && typeof record.name === 'string' ? [record.name] : []
  })
}

function progressForTool(
  profile: DirectBusinessDocumentProfile,
  toolName: string,
  readEvents: number,
): DirectInvestmentProposalAgentProgress {
  if (toolName === 'Skill') return { stage: `文档 Agent 已调用 ${profile.skillName} Skill`, progress: 18, toolName }
  if (['Read', 'Glob', 'Grep'].includes(toolName)) {
    return {
      stage: '文档 Agent 正在按 Skill 研读全部项目资料',
      progress: Math.min(58, 24 + readEvents),
      toolName,
    }
  }
  if (['Write', 'Edit'].includes(toolName)) {
    return { stage: `文档 Agent 正在按 Skill ${profile.authoringStage}`, progress: 70, toolName }
  }
  if (toolName === 'Bash') {
    return { stage: '文档 Agent 正在执行 Skill 校验与 DOCX 渲染', progress: 82, toolName }
  }
  return { stage: `文档 Agent 正在执行 ${toolName}`, progress: 30, toolName }
}

function directAgentPrompt(input: {
  profile: DirectBusinessDocumentProfile
  project: ProjectIdentity
  sourceCutoffDate: string
  instructions: string
  outputFileName: string
  documentCount: number
  chunkCount: number
}) {
  return `请直接调用 Skill 工具执行 ${input.profile.skillName}，并严格按该 Skill 的 SKILL.md、references、scripts 与模板完成当前项目${input.profile.documentLabel}。

这是正式交付任务，不要创建另一个后台任务，也不要只返回文字草稿。

项目：${input.project.companyName || input.project.name}
资料截止日：${input.sourceCutoffDate}
资料目录：./materials
资料清单：./materials/manifest.json
资料数量：${input.documentCount} 个来源文档，${input.chunkCount} 个完整片段
用户要求：${input.instructions || '无额外要求'}

强制要求：
1. 首先使用 Skill 工具调用 ${input.profile.skillName}；未调用 Skill 不得继续。
2. 逐一读取 materials/manifest.json 中的全部来源文件和全部片段，不得抽样、截断或只读摘要。
3. 由当前 Agent 按 Skill 自主${input.profile.processContract}；宿主不会生成问题、答案、章节、底稿或兜底正文，也不会用程序替代 Skill 的业务验收。
4. 对交易金额、估值、股比、收入、人员任职和协议日期的冲突必须保留来源边界，不得编造。
5. 使用 Skill 自带脚本、模板和当前工作区可用 Python/LibreOffice 工具完成 DOCX；可以在工作区写临时文件。
6. 最终只在 ./output 中保留一份 DOCX，文件名必须是 ${input.outputFileName}。不得把模板文件复制到 output。
7. 只有在当前 Agent 按 Skill 完成最终审阅且确认可交付后才结束；无法完成时明确失败，不得生成占位文件。

完成后简要说明最终结论和输出路径。`
}

function directAgentRecoveryPrompt(input: {
  profile: DirectBusinessDocumentProfile
  outputFileName: string
  recoveryAttempt: number
}) {
  return `上一个 ${input.profile.skillName} Agent 上下文在模型网关返回普通 403 后已经关闭。当前是第 ${input.recoveryAttempt} 次全新上下文恢复，工作区中的资料、Manifest、事实台账、草稿、Reviewer 结果和渲染文件均被原样保留。

恢复要求：
1. 首先重新使用 Skill 工具调用 ${input.profile.skillName}；不得沿用未重新加载 Skill 的判断。
2. 读取 ./REQUEST.json 和 ./materials/manifest.json，检查现有工作成果与 Manifest 的覆盖关系；若现有证据台账不能证明某个来源或片段已经纳入，必须补读缺失资料。
3. 在现有工作成果上继续，不得删除已完成的事实库、冲突裁决、草稿、Reviewer 结果或渲染结果后从头降级生成。
4. 业务判断、内容修订和最终验收只服从当前 Skill；宿主不会生成正文、替代审阅或提供旧模板兜底稿。
5. 完成 Skill 要求的最终复核后，只在 ./output 中保留一份 ${input.outputFileName}；未通过 Skill 最终复核不得发布工作稿。

请检查工作区并从尚未完成的阶段继续。`
}

export async function runDirectBusinessDocumentAgent(input: {
  taskType: DirectBusinessDocumentTaskType
  taskDirectory: string
  project: ProjectIdentity
  sources: EvidenceSource[]
  requiredProjectFiles: Array<{ sourceId: string; sourceName: string }>
  skill: LoadedAiSkill
  sourceCutoffDate: string
  instructions: string
  userRole: string
  resumeExistingWorkspace?: boolean
  onProgress?: (event: DirectInvestmentProposalAgentProgress) => void | Promise<void>
  onUsage?: (usage: Record<string, unknown>) => void | Promise<void>
  shouldCancel?: () => boolean | Promise<boolean>
}, options: {
  queryFactory?: DirectAgentQueryFactory
  runtimeConfig?: DirectAgentRuntimeConfig
  gatewayRecovery?: DirectSkillAgentGatewayRecoveryOptions
} = {}): Promise<DirectInvestmentProposalAgentResult> {
  const profile = DIRECT_BUSINESS_DOCUMENT_PROFILES[input.taskType]
  if (!profile || input.skill.name !== profile.skillName) {
    throw Object.assign(new Error(`直接文档 Agent 的任务与 Skill 不匹配：${input.taskType}/${input.skill.name}`), {
      code: 'DIRECT_SKILL_TASK_MISMATCH',
    })
  }
  const workspace = path.join(input.taskDirectory, '.direct-skill-agent')
  const outputDirectory = path.join(workspace, 'output')
  const projectSettingsDirectory = path.join(workspace, '.claude')
  const targetSkillDirectory = path.join(projectSettingsDirectory, 'skills', profile.skillName)
  if (!input.resumeExistingWorkspace) {
    await rm(workspace, { recursive: true, force: true })
  }
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  await mkdir(path.dirname(targetSkillDirectory), { recursive: true, mode: 0o700 })
  await cp(getAiSkillDirectory(input.skill.name), targetSkillDirectory, { recursive: true, force: true })
  await writeFile(
    path.join(projectSettingsDirectory, 'settings.json'),
    JSON.stringify({ permissions: { deny: ['WebFetch', 'WebSearch', 'Task'] } }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  )
  const materialized = await materializeSources({ workspace, sources: input.sources })
  const outputFileName = `${safeFileStem(input.project.companyName || input.project.name, '项目')}_${profile.outputSuffix}.docx`
  await writeFile(path.join(workspace, 'REQUEST.json'), JSON.stringify({
    project: input.project,
    sourceCutoffDate: input.sourceCutoffDate,
    instructions: input.instructions,
    outputFileName,
  }, null, 2), { encoding: 'utf8', mode: 0o600 })

  const config = options.runtimeConfig ?? await runtimeConfig(input.userRole)
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const factory = options.queryFactory ?? ((value) => query(value as never) as DirectAgentQuery)
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), config.timeoutMs)
  timeout.unref?.()
  const gatewayRecovery = directSkillAgentGatewayRecoveryPolicy(options.gatewayRecovery)
  let result: DirectAgentMessage | null = null
  let skillInvoked = false
  let readEvents = 0
  let sdkQuery: DirectAgentQuery | null = null
  let gatewayRetryCount = 0
  let prompt = input.resumeExistingWorkspace
    ? directAgentRecoveryPrompt({ profile, outputFileName, recoveryAttempt: 1 })
    : directAgentPrompt({
      profile,
      project: input.project,
      sourceCutoffDate: input.sourceCutoffDate,
      instructions: input.instructions,
      outputFileName,
      documentCount: materialized.manifest.length,
      chunkCount: input.sources.length,
    })
  try {
    while (true) {
      result = null
      skillInvoked = false
      readEvents = 0
      try {
        await input.onProgress?.({
          stage: input.resumeExistingWorkspace || gatewayRetryCount > 0
            ? '正在启动全新文档 Agent 上下文继续 Skill'
            : '正在启动隔离文档 Agent 并加载 Skill',
          progress: input.resumeExistingWorkspace || gatewayRetryCount > 0 ? 82 : 12,
        })
        sdkQuery = factory({
          prompt,
          options: {
            cwd: workspace,
            model: config.model,
            maxTurns: config.maxTurns,
            maxBudgetUsd: config.maxBudgetUsd,
            abortController,
            permissionMode: 'dontAsk',
            tools: ['Skill', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
            skills: [profile.skillName],
            allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
            disallowedTools: ['WebFetch', 'WebSearch', 'Task'],
            settingSources: ['project'],
            sandbox: {
              enabled: true,
              failIfUnavailable: true,
              autoAllowBashIfSandboxed: true,
              allowUnsandboxedCommands: false,
              network: { allowManagedDomainsOnly: true, allowedDomains: [new URL(config.baseUrl).hostname] },
              filesystem: { allowWrite: [workspace], denyRead: [path.resolve(process.cwd(), '.env')] },
            },
            persistSession: false,
            includePartialMessages: true,
            env: restrictedEnvironment(config, workspace),
            systemPrompt: {
              type: 'preset',
              preset: 'claude_code',
              append: `你是隔离运行的正式文档 Agent。业务流程、内容质量与验收只服从已调用的 ${profile.skillName} Skill。宿主只准备资料、观察进度、检查文件完整性和登记下载，不会替你生成或审核正文。`,
            },
          },
        })
        for await (const message of sdkQuery) {
          if (await input.shouldCancel?.()) {
            abortController.abort()
            throw Object.assign(new Error('用户已取消文档 Agent 任务'), { code: 'AI_TASK_CANCELLED' })
          }
          for (const toolName of assistantToolNames(message)) {
            if (toolName === 'Skill') skillInvoked = true
            if (['Read', 'Glob', 'Grep'].includes(toolName)) readEvents += 1
            await input.onProgress?.(progressForTool(profile, toolName, readEvents))
          }
          const turnUsage = directAgentTurnUsage(message)
          if (turnUsage) await input.onUsage?.(turnUsage)
          if (message.type === 'result') result = message
        }
        if (result && (result.is_error || result.subtype !== 'success')) {
          const resultError = (result.errors || []).join('；') || result.result || result.subtype || 'missing result'
          throw new Error(`文档 Agent 未完成：${resultError}`)
        }
        break
      } catch (error) {
        const errorCode = (error as { code?: string })?.code
        const timedOut = abortController.signal.aborted && errorCode !== 'AI_TASK_CANCELLED'
        const message = timedOut
          ? `文档 Agent 执行超时（${config.timeoutMs}ms）`
          : error instanceof Error ? error.message : String(error)
        const failure = classifyDirectSkillAgentFailure(message, errorCode || 'DIRECT_SKILL_AGENT_FAILED')
        if (
          !timedOut
          && failure.recoverableGateway403
          && gatewayRetryCount < gatewayRecovery.maxRetries
        ) {
          sdkQuery?.close?.()
          sdkQuery = null
          gatewayRetryCount += 1
          await input.onProgress?.({
            stage: `模型网关暂时拒绝，${Math.ceil(gatewayRecovery.delayMs / 1_000)}秒后由新 Agent 上下文继续`,
            progress: 82,
          })
          await gatewayRecovery.wait(gatewayRecovery.delayMs)
          if (abortController.signal.aborted) {
            throw Object.assign(new Error(`文档 Agent 执行超时（${config.timeoutMs}ms）`), {
              code: 'DIRECT_SKILL_AGENT_TIMEOUT',
            })
          }
          if (await input.shouldCancel?.()) {
            abortController.abort()
            throw Object.assign(new Error('用户已取消文档 Agent 任务'), { code: 'AI_TASK_CANCELLED' })
          }
          prompt = directAgentRecoveryPrompt({
            profile,
            outputFileName,
            recoveryAttempt: gatewayRetryCount,
          })
          continue
        }
        throw Object.assign(new Error(redactSensitiveText(message).slice(0, 8_000)), {
          code: timedOut ? 'DIRECT_SKILL_AGENT_TIMEOUT' : failure.code,
        })
      } finally {
        sdkQuery?.close?.()
        sdkQuery = null
      }
    }
  } finally {
    clearTimeout(timeout)
    sdkQuery?.close?.()
  }
  if (!result || result.is_error || result.subtype !== 'success') {
    throw Object.assign(new Error(
      `文档 Agent 未完成：${(result?.errors || []).join('；') || result?.subtype || 'missing result'}`,
    ), { code: 'DIRECT_SKILL_AGENT_INCOMPLETE' })
  }
  if (!skillInvoked) {
    throw Object.assign(new Error(`文档 Agent 未调用 ${profile.skillName} Skill`), {
      code: 'DIRECT_SKILL_NOT_INVOKED',
    })
  }
  const files = (await readdir(outputDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.docx$/i.test(entry.name))
  if (files.length !== 1 || files[0].name !== outputFileName) {
    throw Object.assign(new Error(`文档 Agent 输出目录必须只有 ${outputFileName}`), {
      code: 'DIRECT_SKILL_OUTPUT_CONTRACT_FAILED',
    })
  }
  const outputPath = path.join(outputDirectory, files[0].name)
  const output = await readFile(outputPath)
  if (output.length < 1_000) {
    throw Object.assign(new Error('文档 Agent 生成的 DOCX 为空或不完整'), {
      code: 'DIRECT_SKILL_OUTPUT_INVALID',
    })
  }
  const represented = [...new Set(input.requiredProjectFiles.map((file) => file.sourceName))]
  await input.onProgress?.({ stage: 'Agent 已按当前 Skill 完成生成与审阅', progress: 96 })
  return {
    outputPath,
    documentSha256: createHash('sha256').update(output).digest('hex'),
    bytes: output.length,
    skillInvoked,
    session: {
      model: config.model,
      numTurns: Number(result.num_turns || 0),
      totalCostUsd: Number(result.total_cost_usd || 0),
      usage: directAgentResultUsage(result),
      resultText: String(result.result || '').slice(0, 2_000),
    },
    projectKnowledgeStudy: {
      mode: 'direct-skill-agent',
      requiredSourceDocumentCount: input.requiredProjectFiles.length,
      sourceDocumentCount: materialized.manifest.length,
      sourceChunkCount: input.sources.length,
      includedChunkCount: input.sources.length,
      sourceFilesRepresented: represented,
      completeProjectFileCoverage: true,
      completeSourceChunkCoverage: true,
      hostContentOrchestration: false,
      hostEvidenceFallback: false,
    },
  }
}

export async function runDirectInvestmentProposalAgent(
  input: Omit<Parameters<typeof runDirectBusinessDocumentAgent>[0], 'taskType'>,
  options: Parameters<typeof runDirectBusinessDocumentAgent>[1] = {},
) {
  return runDirectBusinessDocumentAgent({ ...input, taskType: 'investment_proposal' }, options)
}
