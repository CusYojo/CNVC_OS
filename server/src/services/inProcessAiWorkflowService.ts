import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { execFileSupervised as execFileAsync } from '../runtime/supervisedProcessService.js'
import { redactSensitiveText, safeErrorLog } from '../security/redactSecrets.js'
import { resolveAiModelByKey, resolveAiModelRoute } from './aiModelSettingsService.js'
import { resolveAgentRuntimePolicy } from './aiCapabilityService.js'
import { requestAiGatewayText } from './aiGatewayService.js'
import {
  finishLeadPipelineRun,
  recordLeadPipelineDecision,
  registerLeadPipelinePromptVersion,
  startLeadPipelineRun,
} from './leadPipelineAuditService.js'
import {
  LEAD_SCORING_AGENT_PROFILE,
  LEAD_SCORING_AGENT_PROFILE_VERSION,
  LEAD_SCORING_AGENT_SCHEMA_VERSION,
  LEAD_SCORING_AGENT_TOOLSET_VERSION,
  leadScoringAgentRuntime,
  runLeadScoringAgent,
  type LeadScoringAgentExecution,
} from './leadScoringAgentService.js'
import { shouldAttemptLeadScoreFallback } from './leadScoreRetryPolicy.js'
import { resolvePublicIntelPython } from './publicIntelPythonRuntime.js'
import {
  computeLeadRatingV3,
  leadRatingV3JsonSchema,
  leadRatingV3PromptTemplate,
  LEAD_RATING_V3_CLAUDE_PROMPT_VERSION,
  LEAD_RATING_V3_PROMPT_VERSION,
  LEAD_RATING_V3_SCHEMA_VERSION,
  LEAD_RATING_V3_WORKFLOW,
} from './leadRatingV3Service.js'
import {
  LEAD_COMPANY_INTEL_FIELDS,
  validateLeadCompanyIntelExtraction,
  type LeadCompanyIntelField,
} from './leadCompanyIntelExtractionService.js'
import {
  LEAD_COMPANY_WEB_SEARCH_METHOD,
  searchCompaniesWithCodex,
} from './leadCompanyWebSearchService.js'
const gatewayBase = () => (process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'http://127.0.0.1:18081/v1').replace(/\/$/, '')
const gatewayKey = () => process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || ''
const defaultModel = () => process.env.LLM_MODEL || 'gpt-5.6-sol'

function modelId(value?: string) {
  return (value || defaultModel()).replace(/^zeelin-oai\//, '').replace(/^zeelin\//, '')
}

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const candidate = (fenced || text).trim()
  try { return JSON.parse(candidate) as unknown } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1)) as unknown
    throw new Error('模型未返回有效 JSON')
  }
}

export async function gatewayText(input: {
  system: string
  prompt: string
  model?: string
  timeoutMs?: number
  json?: boolean
}) {
  const policy = await resolveAgentRuntimePolicy('ai-document')
  const configured = input.model
    ? await resolveAiModelByKey(input.model)
    : await resolveAiModelRoute(policy.modelRouteKey)
  const key = configured?.apiKey || gatewayKey()
  if (!key) throw new Error('未配置 LLM_API_KEY/OPENAI_API_KEY')
  return requestAiGatewayText({
    baseUrl: configured?.baseUrl || gatewayBase(),
    apiKey: key,
    model: configured?.model || modelId(input.model),
    messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.prompt },
    ],
    json: input.json,
    maxTokens: 4096,
    timeoutMs: Math.min(policy.timeoutMs, input.timeoutMs || configured?.timeoutMs || 120_000),
  })
}

export async function gatewayJson<T>(input: Omit<Parameters<typeof gatewayText>[0], 'json'>): Promise<T> {
  return extractJson(await gatewayText({ ...input, json: true })) as T
}

type IntelInput = {
  company: string
  topics?: string[]
  contextEvidence?: Array<{ title: string; snippet: string; url: string }>
  registryFields?: LeadCompanyIntelField[]
  model?: string
}

type CollectedIntel = {
  queries?: Array<{ q?: string; results?: Array<{ title?: string; snippet?: string; url?: string }> }>
  fetched_at?: string
}

export async function collectCompanyIntel(input: IntelInput) {
  const script = path.resolve(process.cwd(), 'server/assets/ai/collect_intel.py')
  const python = resolvePublicIntelPython()
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'cybernaut-intel-'))
  const requestFile = path.join(temporaryDirectory, 'request.json')
  let stdout = ''
  const startedAt = Date.now()
  try {
    await writeFile(requestFile, JSON.stringify({
      company: input.company,
      topics: input.topics || [],
      registryFields: input.registryFields || LEAD_COMPANY_INTEL_FIELDS,
    }), { mode: 0o600 })
    console.log({
      event: 'ai_public_intel_process_start',
      runtimeSource: python.source,
      platform: process.platform,
    })
    let result
    try {
      result = await execFileAsync(python.executable, [...python.argsPrefix, '-B', script, `@${requestFile}`], {
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
        telemetryKey: 'ai-public-intel',
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
        },
      })
    } catch (error) {
      const processError = error as Error & { stderr?: string; stdout?: string; command?: string }
      console.error({
        event: 'ai_public_intel_process_failed',
        runtimeSource: python.source,
        platform: process.platform,
        durationMs: Date.now() - startedAt,
        error: safeErrorLog(error),
        stderr: redactSensitiveText(processError.stderr || '').slice(-2_000),
        stdout: redactSensitiveText(processError.stdout || '').slice(-1_000),
      })
      throw error
    }
    stdout = result.stdout
    console.log({
      event: 'ai_public_intel_process_succeeded',
      runtimeSource: python.source,
      platform: process.platform,
      durationMs: Date.now() - startedAt,
      responseBytes: Buffer.byteLength(stdout, 'utf8'),
    })
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  const collected = JSON.parse(stdout) as CollectedIntel
  const seen = new Set<string>()
  const searchEvidence = [
    ...(input.contextEvidence || []).map((item) => ({
      query: '线索池已有来源', title: item.title, snippet: item.snippet, url: item.url,
      publisher: '', publishedAt: '', reliability: '线索池已有来源，需访问原始页面核验',
    })),
    ...(collected.queries || []).flatMap((query) => (query.results || []).map((result) => ({
      query: query.q || '项目公开信息',
      title: String(result.title || ''),
      snippet: String(result.snippet || ''),
      url: String(result.url || ''),
      publisher: (() => { try { return new URL(String(result.url || '')).hostname } catch { return '' } })(),
      publishedAt: '',
      reliability: '公开搜索结果摘要，需访问原始页面核验',
    }))),
  ].filter((item) => {
    const key = `${item.url}|${item.snippet.replace(/\s+/g, '').toLowerCase()}`
    if (!item.url || seen.has(key)) return false
    seen.add(key)
    return true
  })
  const requestedFields = [...new Set(input.registryFields || LEAD_COMPANY_INTEL_FIELDS)]
  let extractedFields: ReturnType<typeof validateLeadCompanyIntelExtraction> = []
  let enrichmentError = ''
  if (requestedFields.length && searchEvidence.length) {
    try {
      const raw = await gatewayJson({
        model: input.model,
        timeoutMs: 180_000,
        system: [
          '你是企业公开信息结构化审计员。只允许从宿主给出的搜索结果标题和摘要中逐字抽取字段，不得使用记忆、常识或输入外事实。',
          '每个字段必须返回原文连续 quote 和对应 sourceUrl。搜索摘要没有明确出现的字段必须省略；冲突时必须省略。',
          'website 只能返回可判断为该企业官网的 http/https URL。统一社会信用代码必须为原文中的18位代码。严格返回 JSON。',
        ].join('\n'),
        prompt: `${JSON.stringify({
          company: input.company,
          requestedFields,
          searchEvidence: searchEvidence.map((item) => ({ title: item.title, snippet: item.snippet, url: item.url })),
        })}\n返回 {"fields":[{"field":"...","value":"...","quote":"...","sourceUrl":"..."}]}。field 只能来自 requestedFields。`,
      })
      extractedFields = validateLeadCompanyIntelExtraction({ raw, requestedFields, searchEvidence })
    } catch (error) {
      // Public search evidence remains useful even when the model route is temporarily
      // unavailable. Collection must degrade to an explicit gap instead of inventing data.
      enrichmentError = redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 2_000)
    }
  }
  const locallyCompleted = new Set(extractedFields.map((item) => item.field))
  const webRequestedFields = requestedFields.filter((field) => !locallyCompleted.has(field))
  let webSearchUsed = false
  if (webRequestedFields.length && process.env.LEAD_INTEL_WEB_SEARCH_ENABLED !== 'false') {
    webSearchUsed = true
    const web = await searchCompaniesWithCodex({
      companies: [{ company: input.company, requestedFields: webRequestedFields }],
      model: input.model,
    })
    if (web.error) enrichmentError = web.error
    const result = web.results[0]
    if (result) {
      extractedFields = [...extractedFields, ...result.evidence]
      for (const source of result.sources) {
        const key = `${source.url}|`
        if (seen.has(key)) continue
        seen.add(key)
        searchEvidence.push({
          query: 'Codex 内置联网搜索',
          title: source.title,
          snippet: '',
          url: source.url,
          publisher: (() => { try { return new URL(source.url).hostname } catch { return '' } })(),
          publishedAt: '',
          reliability: source.reliability,
        })
      }
    }
  }
  const extracted = Object.fromEntries(extractedFields.map((item) => [item.field, item.value]))
  return {
    company: input.company,
    canonicalCompanyName: extracted.companyName || '',
    positioning: extracted.companyIntroduction || (searchEvidence.length
      ? `已取得${searchEvidence.length}条公开检索线索，具体事实以原始页面和后续章节核验为准。`
      : '未获取到有效公开信息，建议核验公司全称或补充一手材料。'),
    companyIntroduction: extracted.companyIntroduction || '',
    website: extracted.website || '',
    registeredCapital: extracted.registeredCapital || '待核验',
    legalRepresentative: extracted.legalRepresentative || '待核验',
    foundedAt: extracted.foundedAt || '待核验',
    creditCode: extracted.creditCode || '',
    registrationStatus: extracted.registrationStatus || '',
    companyType: extracted.companyType || '',
    region: '待核验',
    registeredAddress: extracted.registeredAddress || '待核验',
    fundingRounds: [],
    shareholders: [],
    competitors: [],
    companyNews: [],
    sources: [...new Map(searchEvidence.map((item) => [item.url, {
      title: item.title, url: item.url, reliability: item.reliability,
    }])).values()],
    searchEvidence,
    registryEvidence: extractedFields,
    registryEnrichment: {
      method: webSearchUsed ? LEAD_COMPANY_WEB_SEARCH_METHOD : 'codex-evidence-bound-web-enrichment-v1' as const,
      model: input.model || defaultModel(),
      requestedFields,
      completedFields: extractedFields.map((item) => item.field),
      status: enrichmentError
        ? 'model_failed' as const
        : !searchEvidence.length
          ? 'no_results' as const
          : !extractedFields.length
            ? 'no_match' as const
            : 'completed' as const,
      error: enrichmentError || undefined,
    },
    confidence: Math.min(0.8, new Set(searchEvidence.map((item) => item.url)).size / 20),
    fetchedAt: collected.fetched_at || new Date().toISOString(),
  }
}

type ScoreItem = {
  key: string
  name: string
  score: number
  max: number
  reason: string
}

type ScoreDimension = {
  key: string
  name: string
  score: number
  max: number
  items: ScoreItem[]
}

export type InProcessScoreResult = {
  total: number
  verdict: string
  overall_comment: string
  dimensions: ScoreDimension[]
  competitors?: unknown[]
  [key: string]: unknown
}

type DetailedNormalizedScore = {
  total: number
  verdict: string
  overall_comment: string
  dimensions: Array<{
    key: string
    name: string
    score: number | null
    max: number
    items: unknown[]
    weight?: number
    assessment?: string
  }>
  competitors?: unknown[]
  highlights?: string[]
  risks?: string[]
  next_actions?: string[]
  ratingV3?: ReturnType<typeof computeLeadRatingV3>
  projectName?: unknown
  [key: string]: unknown
}

const paperStandard = {
  version: 'paper-v1',
  dimensions: [
    { key: 'tech_strength', name: '技术实力/创新性', max: 30 },
    { key: 'landing', name: '技术落地可能性', max: 28 },
    { key: 'market', name: '市场空间', max: 20 },
    { key: 'academic', name: '学者/团队学术背景', max: 12 },
    { key: 'commercialization', name: '过往商业化经验', max: 10 },
  ],
  verdict_bands: [
    { min: 80, label: '强烈推荐' }, { min: 65, label: '推荐' },
    { min: 50, label: '谨慎观察' }, { min: 0, label: '暂不推荐' },
  ],
}

type ScoreStandard = {
  version?: string
  name?: string
  dimensions: Array<{
    key: string
    name: string
    max: number
    items?: Array<{ key: string; name: string; max: number }>
  }>
  verdict_bands: Array<{ min: number; label: string }>
}

export type ScoreWorkflow = 'score-project' | 'score-paper' | typeof LEAD_RATING_V3_WORKFLOW

async function scoreStandard(workflow: string): Promise<ScoreStandard> {
  if (workflow === 'score-paper') return paperStandard
  const text = await readFile(path.resolve(process.cwd(), 'server/assets/ai/scoring_standard.json'), 'utf8')
  return JSON.parse(text) as ScoreStandard
}

const rawScoreSchema = z.object({
  total: z.coerce.number(),
  verdict: z.string(),
  overall_comment: z.string().min(1),
  dimensions: z.array(z.object({
    key: z.string().min(1),
    name: z.string(),
    score: z.coerce.number(),
    max: z.coerce.number(),
    items: z.array(z.object({
      key: z.string().min(1),
      name: z.string(),
      score: z.coerce.number(),
      max: z.coerce.number(),
      reason: z.string().min(1),
    })),
  })),
  competitors: z.array(z.object({
    name: z.string(),
    tech: z.string(),
    product: z.string(),
    funding: z.string(),
    differentiation: z.string(),
    is_self: z.boolean(),
    evidence: z.string(),
    verificationStatus: z.enum(['evidence-backed', 'unverified']),
  })),
  highlights: z.array(z.string()),
  risks: z.array(z.string()),
  next_actions: z.array(z.string()),
})

function normalizedEvidenceText(value: unknown) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function normalizeScore(
  value: unknown,
  standard: ScoreStandard,
  input: Record<string, unknown>,
): InProcessScoreResult {
  const result = rawScoreSchema.parse(value)
  const rawDimensions = new Map<string, z.infer<typeof rawScoreSchema>['dimensions'][number]>()
  for (const dimension of result.dimensions) {
    if (rawDimensions.has(dimension.key)) throw new Error(`评分模型返回重复维度: ${dimension.key}`)
    rawDimensions.set(dimension.key, dimension)
  }
  if (rawDimensions.size !== standard.dimensions.length
    || standard.dimensions.some((dimension) => !rawDimensions.has(dimension.key))) {
    throw new Error('评分模型返回的维度不完整或包含未定义维度')
  }
  const dimensions: ScoreDimension[] = standard.dimensions.map((definition) => {
    const raw = rawDimensions.get(definition.key)!
    const itemDefinitions = definition.items ?? []
    let items: ScoreItem[] = []
    let score: number
    if (itemDefinitions.length) {
      const rawItems = new Map<string, typeof raw.items[number]>()
      for (const item of raw.items) {
        if (rawItems.has(item.key)) throw new Error(`评分模型返回重复子项: ${definition.key}.${item.key}`)
        rawItems.set(item.key, item)
      }
      if (rawItems.size !== itemDefinitions.length
        || itemDefinitions.some((item) => !rawItems.has(item.key))) {
        throw new Error(`评分模型返回的子项不完整或包含未定义子项: ${definition.key}`)
      }
      items = itemDefinitions.map((item) => ({
        key: item.key,
        name: item.name,
        max: item.max,
        score: Math.max(0, Math.min(item.max, Number(rawItems.get(item.key)!.score) || 0)),
        reason: rawItems.get(item.key)!.reason.trim(),
      }))
      score = items.reduce((sum, item) => sum + item.score, 0)
    } else {
      if (raw.items.length) throw new Error(`评分维度不允许未定义子项: ${definition.key}`)
      score = Math.max(0, Math.min(definition.max, Number(raw.score) || 0))
    }
    return { key: definition.key, name: definition.name, max: definition.max, score, items }
  })
  const total = Math.max(0, Math.min(100, dimensions.reduce((sum, dimension) => sum + dimension.score, 0)))
  const verdict = [...standard.verdict_bands].sort((a, b) => b.min - a.min)
    .find((band) => total >= band.min)?.label || '暂不推荐'
  const evidenceCorpus = normalizedEvidenceText(JSON.stringify(input))
  const competitors = result.competitors.map((competitor) => {
    const name = normalizedEvidenceText(competitor.name)
    const evidence = normalizedEvidenceText(competitor.evidence)
    const evidenceBacked = !competitor.is_self
      && name.length >= 2
      && evidence.length >= 10
      && evidenceCorpus.includes(name)
      && evidence.includes(name)
      && evidenceCorpus.includes(evidence)
    return {
      ...competitor,
      verificationStatus: evidenceBacked ? 'evidence-backed' as const : 'unverified' as const,
    }
  })
  return { ...result, dimensions, total, verdict, competitors }
}

function scoringOutputSchema(standard: ScoreStandard): Record<string, unknown> {
  const dimensionKeys = standard.dimensions.map((dimension) => dimension.key)
  const itemKeys = [...new Set(standard.dimensions.flatMap((dimension) => (dimension.items ?? []).map((item) => item.key)))]
  return {
    type: 'object',
    additionalProperties: false,
    required: ['total', 'verdict', 'overall_comment', 'dimensions', 'competitors', 'highlights', 'risks', 'next_actions'],
    properties: {
      total: { type: 'number', minimum: 0, maximum: 100 },
      verdict: { type: 'string' },
      overall_comment: { type: 'string', minLength: 1 },
      dimensions: {
        type: 'array', minItems: standard.dimensions.length, maxItems: standard.dimensions.length,
        items: {
          type: 'object', additionalProperties: false,
          required: ['key', 'name', 'score', 'max', 'items'],
          properties: {
            key: { type: 'string', enum: dimensionKeys },
            name: { type: 'string' },
            score: { type: 'number', minimum: 0, maximum: 100 },
            max: { type: 'number', minimum: 0, maximum: 100 },
            items: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false,
                required: ['key', 'name', 'score', 'max', 'reason'],
                properties: {
                  key: { type: 'string', ...(itemKeys.length ? { enum: itemKeys } : {}) },
                  name: { type: 'string' },
                  score: { type: 'number', minimum: 0, maximum: 100 },
                  max: { type: 'number', minimum: 0, maximum: 100 },
                  reason: { type: 'string', minLength: 1 },
                },
              },
            },
          },
        },
      },
      competitors: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['name', 'tech', 'product', 'funding', 'differentiation', 'is_self', 'evidence', 'verificationStatus'],
          properties: {
            name: { type: 'string' }, tech: { type: 'string' }, product: { type: 'string' },
            funding: { type: 'string' }, differentiation: { type: 'string' }, is_self: { type: 'boolean' },
            evidence: { type: 'string' }, verificationStatus: { type: 'string', enum: ['evidence-backed', 'unverified'] },
          },
        },
      },
      highlights: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
      next_actions: { type: 'array', items: { type: 'string' } },
    },
  }
}

const SCORING_SYSTEM_PROMPT = '你是浙江赛智伯乐的投资评审 AI。严格、克制、区分事实与推断；只使用输入资料，禁止调用工具或补充外部事实；聚合分数将由宿主服务重新计算。'

function scoringPromptTemplate(workflow: 'score-project' | 'score-paper', standard: ScoreStandard) {
  return [
    `评分类型：${workflow === 'score-paper' ? '论文/学术成果早期项目' : '一级市场项目'}`,
    '评分标准：', JSON.stringify(standard),
    '待评分资料：<runtime-input-json>',
    '逐项按评分标准作出判断。dimensions 必须且只能覆盖标准定义的每个 key；有子项的维度必须且只能覆盖标准定义的每个子项 key，无子项维度的 items 必须为空。',
    '每项 reason 必须说明输入中的依据或明确指出信息缺失。不得虚构竞品；没有输入证据时 competitors 返回空数组。',
    '同时返回不超过 5 条 highlights、risks 和 next_actions。total 与 verdict 会由宿主按逐项得分重新计算。',
  ].join('\n')
}

function scoringPrompt(workflow: 'score-project' | 'score-paper', standard: ScoreStandard, input: Record<string, unknown>) {
  return scoringPromptTemplate(workflow, standard)
    .replace('<runtime-input-json>', JSON.stringify(input))
}

export type LeadScoringAgentRunner = typeof runLeadScoringAgent

export type LeadScoringAuditContext = {
  eventIds: string[]
  inputEventId: string
  entityType?: 'lead' | 'project'
  leadId?: string
  projectId?: string
  queueAttempt?: number
}

export type ScoreWithAgentOptions = {
  agentRunner?: LeadScoringAgentRunner
  primaryModel?: string
  fallbackModel?: string
  audit?: LeadScoringAuditContext
}

type ScoreAgentEnvelope<T> = {
  result: T
  execution: LeadScoringAgentExecution
  model: string
  workflow: ScoreWorkflow
  promptVersion: string
  audit: { runId: string; decisionId: string | null; inputEventId: string } | null
}

function retryableError(error: unknown) {
  return (error as Error & { retryable?: boolean }).retryable !== false
}

function scoreOutcome(total: number) {
  if (total >= 65) return 'accept' as const
  if (total >= 50) return 'review' as const
  return 'reject' as const
}

function evidenceQuote(input: Record<string, unknown>) {
  for (const key of ['articleText', 'abstract', 'summary', 'projectName']) {
    const value = String(input[key] ?? '').trim().replace(/\s+/g, ' ')
    if (value) return value.slice(0, 4_000)
  }
  return JSON.stringify(input).slice(0, 4_000)
}

function safeRunError(error: unknown) {
  return redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 8_000)
}

export function scoreWithAgentDetailed(
  workflow: 'score-project' | 'score-paper',
  input: Record<string, unknown>,
  options?: ScoreWithAgentOptions,
): Promise<ScoreAgentEnvelope<InProcessScoreResult & { projectName?: unknown }>>
export function scoreWithAgentDetailed(
  workflow: typeof LEAD_RATING_V3_WORKFLOW,
  input: Record<string, unknown>,
  options?: ScoreWithAgentOptions,
): Promise<ScoreAgentEnvelope<DetailedNormalizedScore>>
export async function scoreWithAgentDetailed(
  workflow: ScoreWorkflow,
  input: Record<string, unknown>,
  options: ScoreWithAgentOptions = {},
): Promise<ScoreAgentEnvelope<DetailedNormalizedScore>> {
  const ratingV3Workflow = workflow === LEAD_RATING_V3_WORKFLOW
  const standard = ratingV3Workflow ? null : await scoreStandard(workflow)
  const primary = options.primaryModel || process.env.SCORE_MODEL || process.env.LLM_MODEL || 'claude-sonnet-4-6'
  const fallback = process.env.SCORE_FALLBACK_MODEL || primary
  const configuredFallback = options.fallbackModel || fallback
  const models = configuredFallback === primary ? [primary] : [primary, configuredFallback]
  const promptTemplate = ratingV3Workflow
    ? leadRatingV3PromptTemplate()
    : scoringPromptTemplate(workflow, standard!)
  const prompt = promptTemplate.replace('<runtime-input-json>', JSON.stringify(input))
  const outputSchema = ratingV3Workflow ? leadRatingV3JsonSchema() : scoringOutputSchema(standard!)
  const agentRunner = options.agentRunner || runLeadScoringAgent
  let lastError: Error = new Error('评分 Agent 未返回结果')

  for (let modelAttempt = 1; modelAttempt <= models.length; modelAttempt += 1) {
    const model = models[modelAttempt - 1]
    const runtime = leadScoringAgentRuntime(model, Boolean(options.agentRunner))
    const ratingPromptVersion = runtime === 'codex-cli'
      ? LEAD_RATING_V3_PROMPT_VERSION
      : LEAD_RATING_V3_CLAUDE_PROMPT_VERSION
    let auditRun: Awaited<ReturnType<typeof startLeadPipelineRun>> | null = null
    let execution: LeadScoringAgentExecution | null = null
    let auditRunFinished = false
    let auditDecisionId: string | null = null
    try {
      if (options.audit) {
        const promptVersion = await registerLeadPipelinePromptVersion({
          agentProfile: LEAD_SCORING_AGENT_PROFILE,
          promptVersion: ratingV3Workflow
            ? ratingPromptVersion
            : `${workflow}-${standard!.version || 'v1'}-agent-v1`,
          schemaVersion: ratingV3Workflow ? LEAD_RATING_V3_SCHEMA_VERSION : LEAD_SCORING_AGENT_SCHEMA_VERSION,
          skillVersion: LEAD_SCORING_AGENT_PROFILE_VERSION,
          toolsetVersion: LEAD_SCORING_AGENT_TOOLSET_VERSION,
          prompt: `${SCORING_SYSTEM_PROMPT}\n\n${promptTemplate}`,
          configuration: {
            runtime, workflow, tools: [], skills: [],
            permissionMode: 'dontAsk', outputFormat: 'json_schema',
          },
        })
        auditRun = await startLeadPipelineRun({
          eventIds: options.audit.eventIds,
          runtime,
          agentProfile: LEAD_SCORING_AGENT_PROFILE,
          promptVersionId: promptVersion.id,
          model,
          attempt: Math.max(1, ((options.audit.queueAttempt || 1) - 1) * 2 + modelAttempt),
          metadata: {
            leadId: options.audit.leadId,
            projectId: options.audit.projectId,
            entityType: options.audit.entityType ?? 'lead',
            inputEventId: options.audit.inputEventId,
            workflow,
            queueAttempt: options.audit.queueAttempt || 1,
            modelAttempt,
            transport: runtime,
            toolsetVersion: LEAD_SCORING_AGENT_TOOLSET_VERSION,
          },
        })
      }
      execution = await agentRunner({ systemPrompt: SCORING_SYSTEM_PROMPT, prompt, outputSchema, model })
      const normalized: DetailedNormalizedScore = ratingV3Workflow
        ? (() => {
            const ratingV3 = computeLeadRatingV3(execution!.output)
            const detail = ratingV3.detailView
            return {
              total: ratingV3.computed.score ?? 0,
              verdict: ratingV3.mainView.displayGrade,
              overall_comment: detail.rating.oneSentenceJudgment,
              dimensions: detail.dimensionScores.map((dimension) => ({
                key: dimension.key,
                name: dimension.dimension,
                score: dimension.score,
                max: 10,
                items: [],
                weight: dimension.weight,
                assessment: dimension.assessment,
              })),
              highlights: detail.investmentThesis.map((item) => item.thesis).slice(0, 5),
              risks: detail.keyRisks.slice(0, 5),
              next_actions: detail.dueDiligence.P0.map((item) => item.question).slice(0, 5),
              ratingV3,
              projectName: input.projectName,
            }
          })()
        : { ...normalizeScore(execution.output, standard!, input), projectName: input.projectName }
      if (auditRun && options.audit) {
        const outcome = ratingV3Workflow && normalized.ratingV3?.computed.ratingStatus === '无法评级'
          ? 'review' as const
          : scoreOutcome(normalized.total)
        const reason = `${workflow} 评分 ${normalized.total}/100，结论：${normalized.verdict}`
        const decision = await recordLeadPipelineDecision({
          idempotencyKey: `lead-score:${auditRun.id}:succeeded`,
          eventId: options.audit.inputEventId,
          runId: auditRun.id,
          decisionType: workflow === 'score-paper' ? 'paper_scoring' : workflow === LEAD_RATING_V3_WORKFLOW ? 'lead_rating_v3' : 'project_scoring',
          outcome,
          subjectType: workflow === 'score-paper' ? 'paper' : 'project',
          subjectName: String(input.projectName || ''),
          reason,
          output: { workflow, score: normalized },
          actorType: 'agent',
          actorId: model,
          evidence: [{
            sourceId: options.audit.inputEventId,
            sourceType: 'lead-scoring-input',
            locator: 'immutable host scoring input snapshot',
            claim: `已入库资料支持对 ${String(input.projectName || '该主体')} 执行 ${workflow} 评分`,
            quote: evidenceQuote(input),
            verificationStatus: 'verified',
            metadata: {
              leadId: options.audit.leadId,
              projectId: options.audit.projectId,
              entityType: options.audit.entityType ?? 'lead',
              eventIds: options.audit.eventIds,
            },
          }],
        })
        auditDecisionId = decision.id
        await finishLeadPipelineRun(auditRun.id, {
          status: 'succeeded', ...execution.usage, toolCalls: execution.toolCalls,
          durationMs: execution.durationMs, costMicrousd: execution.costMicrousd,
        })
        auditRunFinished = true
      }
      return {
        result: normalized,
        execution,
        model,
        workflow,
        promptVersion: ratingV3Workflow ? ratingPromptVersion : `${workflow}-${standard!.version || 'v1'}-agent-v1`,
        audit: auditRun && options.audit ? {
          runId: auditRun.id,
          decisionId: auditDecisionId,
          inputEventId: options.audit.inputEventId,
        } : null,
      }
    } catch (error) {
      lastError = error as Error
      if (auditRun && !auditRunFinished) {
        const metrics = execution || (lastError as Error & {
          leadRunMetrics?: Partial<LeadScoringAgentExecution>
        }).leadRunMetrics
        await finishLeadPipelineRun(auditRun.id, {
          status: 'failed', ...(metrics?.usage || {}), toolCalls: metrics?.toolCalls,
          durationMs: metrics?.durationMs, costMicrousd: metrics?.costMicrousd, error: lastError,
        }).catch(() => undefined)
        if (options.audit) {
          await recordLeadPipelineDecision({
            idempotencyKey: `lead-score:${auditRun.id}:failed`,
            eventId: options.audit.inputEventId,
            runId: auditRun.id,
            decisionType: workflow === 'score-paper' ? 'paper_scoring' : workflow === LEAD_RATING_V3_WORKFLOW ? 'lead_rating_v3' : 'project_scoring',
            outcome: 'failed',
            subjectType: workflow === 'score-paper' ? 'paper' : 'project',
            subjectName: String(input.projectName || ''),
            reason: `评分 Agent 运行失败：${safeRunError(lastError)}`,
            output: { workflow, failed: true },
            actorType: 'agent',
            actorId: model,
          }).catch(() => undefined)
        }
      }
      if (!retryableError(lastError)
        || !shouldAttemptLeadScoreFallback(lastError, modelAttempt, models.length)) break
    }
  }
  throw lastError
}

export async function scoreWithAgent(
  workflow: ScoreWorkflow,
  input: Record<string, unknown>,
  options: ScoreWithAgentOptions = {},
) {
  if (workflow === LEAD_RATING_V3_WORKFLOW) {
    return (await scoreWithAgentDetailed(workflow, input, options)).result
  }
  return (await scoreWithAgentDetailed(workflow, input, options)).result
}
