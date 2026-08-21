import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getAiSkillDirectory, type LoadedAiSkill } from './aiSkillService.js'
import type { EvidenceSource } from './aiBusinessContentService.js'
import { resolveAiModelRoute } from './aiModelSettingsService.js'
import { redactSensitiveText } from '../security/redactSecrets.js'
import { directAgentTurnUsage } from '../runtime/directAgentUsage.js'

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
  message?: { content?: unknown; usage?: Record<string, unknown> }
}

type DirectAgentQuery = AsyncIterable<DirectAgentMessage> & {
  close?: () => void
}

type DirectAgentQueryFactory = (input: {
  prompt: string
  options: Record<string, unknown>
}) => DirectAgentQuery

export type DirectInvestmentCommitteePptAgentProgress = {
  stage: string
  progress: number
  toolName?: string
}

export type DirectInvestmentCommitteePptAgentResult = {
  outputPath: string
  deckSha256: string
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

function progressForTool(toolName: string, readEvents: number): DirectInvestmentCommitteePptAgentProgress {
  if (toolName === 'Skill') return { stage: 'PPT Agent 已调用 investment-committee-ppt Skill', progress: 18, toolName }
  if (['Read', 'Glob', 'Grep'].includes(toolName)) {
    return {
      stage: 'PPT Agent 正在按 Skill 研读全部项目资料',
      progress: Math.min(58, 24 + readEvents),
      toolName,
    }
  }
  if (['Write', 'Edit'].includes(toolName)) {
    return { stage: 'PPT Agent 正在按 Skill 编制投资建议书', progress: 70, toolName }
  }
  if (toolName === 'Bash') {
    return { stage: 'PPT Agent 正在执行 Skill 审计、渲染与逐页复核', progress: 82, toolName }
  }
  return { stage: `PPT Agent 正在执行 ${toolName}`, progress: 30, toolName }
}

function directAgentPrompt(input: {
  project: ProjectIdentity
  sourceCutoffDate: string
  instructions: string
  outputFileName: string
  documentCount: number
  chunkCount: number
}) {
  return `请直接调用 Skill 工具执行 investment-committee-ppt，并严格按该 Skill 的 SKILL.md、references、scripts 与模板完成当前项目投资建议书。

这是正式交付任务，不要创建另一个后台任务，也不要只返回文字草稿。

项目：${input.project.companyName || input.project.name}
资料截止日：${input.sourceCutoffDate}
资料目录：./materials
资料清单：./materials/manifest.json
资料数量：${input.documentCount} 个来源文档，${input.chunkCount} 个完整片段
用户要求：${input.instructions || '无额外要求'}

强制要求：
1. 首先使用 Skill 工具调用 investment-committee-ppt；未调用 Skill 不得继续。
2. 逐一读取 materials/manifest.json 中的全部来源文件和全部片段，不得抽样、截断或只读摘要。
3. 由当前 Agent 按 Skill 自主完成项目建档、证据账本、指标清单、叙事、逐页蓝图、Design Contract、可编辑 PPTX、Reviewer 修订和 QA；宿主不会生成页面、编排内容或提供兜底稿。
4. 对交易金额、估值、股比、收入、人员任职和协议日期的冲突必须保留来源边界，不得编造。
5. 使用 Skill 自带 references、scripts、Design DNA、示例资产以及当前工作区可用工具完成 PPTX；必须如实记录实际采用的渲染与视觉复核路径，不得把非 PowerPoint 渲染冒充为 PowerPoint 原生导出。
6. 最终只在 ./output 中保留一份正式可编辑 PPTX，文件名必须是 ${input.outputFileName}。PDF、来源账本、逐页蓝图和 QA 底稿如有生成应保留在工作区其他目录，不得把示例或模板文件复制到 output。
7. 只有在当前 Agent 按 Skill 完成最终审阅且确认可交付后才结束；无法完成时明确失败，不得生成占位文件。

完成后简要说明最终结论和输出路径。`
}

export async function runDirectInvestmentCommitteePptAgent(input: {
  taskDirectory: string
  project: ProjectIdentity
  sources: EvidenceSource[]
  requiredProjectFiles: Array<{ sourceId: string; sourceName: string }>
  skill: LoadedAiSkill
  sourceCutoffDate: string
  instructions: string
  userRole: string
  onProgress?: (event: DirectInvestmentCommitteePptAgentProgress) => void | Promise<void>
  onUsage?: (usage: Record<string, unknown>) => void | Promise<void>
  shouldCancel?: () => boolean | Promise<boolean>
}, options: {
  queryFactory?: DirectAgentQueryFactory
  runtimeConfig?: DirectAgentRuntimeConfig
} = {}): Promise<DirectInvestmentCommitteePptAgentResult> {
  const workspace = path.join(input.taskDirectory, '.direct-skill-agent')
  const outputDirectory = path.join(workspace, 'output')
  const projectSettingsDirectory = path.join(workspace, '.claude')
  const targetSkillDirectory = path.join(projectSettingsDirectory, 'skills', 'investment-committee-ppt')
  await rm(workspace, { recursive: true, force: true })
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  await mkdir(path.dirname(targetSkillDirectory), { recursive: true, mode: 0o700 })
  await cp(getAiSkillDirectory(input.skill.name), targetSkillDirectory, { recursive: true, force: true })
  await writeFile(
    path.join(projectSettingsDirectory, 'settings.json'),
    JSON.stringify({ permissions: { deny: ['WebFetch', 'WebSearch', 'Task'] } }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  )
  const materialized = await materializeSources({ workspace, sources: input.sources })
  const outputFileName = `${safeFileStem(input.project.companyName || input.project.name, '项目')}_投资建议书.pptx`
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
  let result: DirectAgentMessage | null = null
  let skillInvoked = false
  let readEvents = 0
  let sdkQuery: DirectAgentQuery | null = null
  try {
    await input.onProgress?.({ stage: '正在启动隔离 PPT Agent 并加载 Skill', progress: 12 })
    sdkQuery = factory({
      prompt: directAgentPrompt({
        project: input.project,
        sourceCutoffDate: input.sourceCutoffDate,
        instructions: input.instructions,
        outputFileName,
        documentCount: materialized.manifest.length,
        chunkCount: input.sources.length,
      }),
      options: {
        cwd: workspace,
        model: config.model,
        maxTurns: config.maxTurns,
        maxBudgetUsd: config.maxBudgetUsd,
        abortController,
        permissionMode: 'dontAsk',
        tools: ['Skill', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
        skills: ['investment-committee-ppt'],
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
          append: '你是隔离运行的正式 PPT Agent。业务流程、内容质量与验收只服从已调用的 investment-committee-ppt Skill。宿主只准备全部资料、观察进度、检查文件完整性和登记下载，不会替你生成页面、编排内容或审核成品。',
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
        await input.onProgress?.(progressForTool(toolName, readEvents))
      }
      const turnUsage = directAgentTurnUsage(message)
      if (turnUsage) await input.onUsage?.(turnUsage)
      if (message.type === 'result') result = message
    }
  } catch (error) {
    const errorCode = (error as { code?: string })?.code
    const timedOut = abortController.signal.aborted && errorCode !== 'AI_TASK_CANCELLED'
    const message = timedOut
      ? `文档 Agent 执行超时（${config.timeoutMs}ms）`
      : error instanceof Error ? error.message : String(error)
    const authenticationOrQuotaFailure = /Failed to authenticate|API Error:\s*403|额度不足|余额不足/i.test(message)
    throw Object.assign(new Error(redactSensitiveText(message).slice(0, 8_000)), {
      code: timedOut
        ? 'DIRECT_SKILL_AGENT_TIMEOUT'
        : authenticationOrQuotaFailure
          ? 'DIRECT_SKILL_AGENT_AUTH_OR_QUOTA'
          : errorCode || 'DIRECT_SKILL_AGENT_FAILED',
    })
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
    throw Object.assign(new Error('文档 Agent 未调用 investment-committee-ppt Skill'), {
      code: 'DIRECT_SKILL_NOT_INVOKED',
    })
  }
  const files = (await readdir(outputDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.pptx$/i.test(entry.name))
  if (files.length !== 1 || files[0].name !== outputFileName) {
    throw Object.assign(new Error(`文档 Agent 输出目录必须只有 ${outputFileName}`), {
      code: 'DIRECT_SKILL_OUTPUT_CONTRACT_FAILED',
    })
  }
  const outputPath = path.join(outputDirectory, files[0].name)
  const output = await readFile(outputPath)
  if (output.length < 1_000) {
    throw Object.assign(new Error('PPT Agent 生成的 PPTX 为空或不完整'), {
      code: 'DIRECT_SKILL_OUTPUT_INVALID',
    })
  }
  const represented = [...new Set(input.requiredProjectFiles.map((file) => file.sourceName))]
  await input.onProgress?.({ stage: 'PPT Agent 已按当前 Skill 完成生成与审阅', progress: 96 })
  return {
    outputPath,
    deckSha256: createHash('sha256').update(output).digest('hex'),
    bytes: output.length,
    skillInvoked,
    session: {
      model: config.model,
      numTurns: Number(result.num_turns || 0),
      totalCostUsd: Number(result.total_cost_usd || 0),
      usage: result.usage ?? null,
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
