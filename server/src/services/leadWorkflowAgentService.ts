import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { redactSensitiveText } from '../security/redactSecrets.js'
import { leadAgentUsageMetrics } from './leadAgentUsageService.js'
import { resolveAiModelByKey, resolveAiModelRoute, type AiModelProfileKey } from './aiModelSettingsService.js'
import { resolveAgentRuntimePolicy } from './aiCapabilityService.js'
import {
  acquireLeadAgentRuntimePermit,
  finishLeadAgentRuntimePermit,
} from './leadAgentRuntimeGuardService.js'
import {
  beginAiRuntimeRequest,
  finishAiRuntimeRequest,
  markAiRuntimeFirstTokenFromSdkMessage,
} from '../runtime/aiRuntimeTelemetry.js'
import {
  codexStructuredOutputRuntime,
  runCodexStructuredOutput,
  type CodexStructuredOutputRuntime,
} from './codexStructuredOutputService.js'

export type LeadWorkflowAgentProfile =
  | 'lead-research-agent'
  | 'lead-screening-agent'
  | 'lead-enrichment-agent'

const evidenceSchema = z.object({
  claim: z.string().min(1).max(8_000),
  quote: z.string().min(1).max(8_000),
  sourceId: z.string().min(1).max(2_000),
  sourceUrl: z.string().max(4_000).default(''),
  reliability: z.enum(['high', 'medium', 'low', 'unknown']),
  verificationStatus: z.enum(['verified', 'unverified', 'conflicted']),
}).strict()

const researchOutputSchema = z.object({
  summary: z.string().min(1).max(8_000),
  facts: z.array(evidenceSchema).max(100),
  conflicts: z.array(z.object({
    field: z.string().min(1).max(128),
    values: z.array(z.string().min(1).max(2_000)).min(2).max(10),
    reason: z.string().min(1).max(4_000),
    sourceIds: z.array(z.string().min(1).max(2_000)).min(1).max(20),
  }).strict()).max(50),
  gaps: z.array(z.string().min(1).max(2_000)).max(50),
}).strict()

const screeningOutputSchema = z.object({
  decision: z.enum(['accept', 'reject', 'review']),
  reason: z.string().min(1).max(8_000),
  confidence: z.number().min(0).max(100),
  evidence: z.array(evidenceSchema).max(50),
  risks: z.array(z.string().min(1).max(2_000)).max(50),
}).strict().superRefine((value, context) => {
  if (value.decision === 'accept' && !value.evidence.length) {
    context.addIssue({ code: 'custom', path: ['evidence'], message: 'accepted screening requires evidence' })
  }
})

const ENRICHMENT_FIELDS = [
  'companyName', 'industry', 'businessRegion', 'summary', 'team',
  'fundingRounds', 'sources',
] as const

const enrichmentOutputSchema = z.object({
  patches: z.array(z.object({
    field: z.enum(ENRICHMENT_FIELDS),
    operation: z.enum(['set_if_empty', 'append_unique']),
    value: z.unknown(),
    claim: z.string().min(1).max(8_000),
    quote: z.string().min(1).max(8_000),
    sourceId: z.string().min(1).max(2_000),
  }).strict()).max(100),
  conflicts: z.array(z.object({
    field: z.enum(ENRICHMENT_FIELDS),
    existingValue: z.unknown(),
    proposedValue: z.unknown(),
    reason: z.string().min(1).max(4_000),
    sourceIds: z.array(z.string().min(1).max(2_000)).min(1).max(20),
  }).strict()).max(50),
  gaps: z.array(z.string().min(1).max(2_000)).max(50),
}).strict()

const EVIDENCE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claim', 'quote', 'sourceId', 'sourceUrl', 'reliability', 'verificationStatus'],
  properties: {
    claim: { type: 'string', minLength: 1, maxLength: 8_000 },
    quote: { type: 'string', minLength: 1, maxLength: 8_000 },
    sourceId: { type: 'string', minLength: 1, maxLength: 2_000 },
    sourceUrl: { type: 'string', maxLength: 4_000 },
    reliability: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
    verificationStatus: { type: 'string', enum: ['verified', 'unverified', 'conflicted'] },
  },
} as const

const PROFILE_CONTRACTS: Record<LeadWorkflowAgentProfile, {
  profileVersion: string
  promptVersion: string
  schemaVersion: string
  skillVersion: string
  toolsetVersion: string
  systemPrompt: string
  outputSchema: Record<string, unknown>
  validator: z.ZodTypeAny
  defaultBudgetUsd: number
}> = {
  'lead-research-agent': {
    profileVersion: 'lead-research-agent-v1',
    promptVersion: 'lead-research-prompt-v1',
    schemaVersion: 'lead-research-output-v1',
    skillVersion: 'lead-research-skill-v1',
    toolsetVersion: 'lead-research-host-tools-v1',
    defaultBudgetUsd: 0.5,
    systemPrompt: [
      '你是线索公开研究 Agent。只能使用宿主提供的原始事件、已有线索和公开来源片段。',
      '不得搜索网络、读取文件、调用工具或补写输入中不存在的事实。',
      '每条事实必须带连续原文 quote 和 sourceId；冲突必须保留，不得自行选择；缺口明确列出。',
      '只返回符合 JSON Schema 的对象。',
    ].join('\n'),
    validator: researchOutputSchema,
    outputSchema: {
      type: 'object', additionalProperties: false,
      required: ['summary', 'facts', 'conflicts', 'gaps'],
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 8_000 },
        facts: { type: 'array', maxItems: 100, items: EVIDENCE_JSON_SCHEMA },
        conflicts: {
          type: 'array', maxItems: 50,
          items: {
            type: 'object', additionalProperties: false,
            required: ['field', 'values', 'reason', 'sourceIds'],
            properties: {
              field: { type: 'string', minLength: 1, maxLength: 128 },
              values: { type: 'array', minItems: 2, maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 2_000 } },
              reason: { type: 'string', minLength: 1, maxLength: 4_000 },
              sourceIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 2_000 } },
            },
          },
        },
        gaps: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 2_000 } },
      },
    },
  },
  'lead-screening-agent': {
    profileVersion: 'lead-screening-agent-v3',
    promptVersion: 'lead-screening-prompt-v3',
    schemaVersion: 'lead-screening-output-v1',
    skillVersion: 'lead-screening-skill-v3',
    toolsetVersion: 'lead-research-host-tools-v1',
    defaultBudgetUsd: 0.3,
    systemPrompt: [
      '你是线索准入初筛 Agent。只能根据宿主提供的不可变原始事件和研究事实包判断 accept、reject 或 review。',
      'accept 必须至少有一条可定位连续原文证据；事实冲突、主体歧义或证据不足必须 review，不得猜测。',
      '关键财务、融资、客户或商业化结论若仅有 low/unknown 可靠性或 unverified 证据，必须 review，不得自动 accept。',
      '论文候选不要求具备公司、客户、收入或融资信息；若 arXiv 身份、完整标题和技术摘要可由原始来源连续原文核验，且主体无歧义，应 accept，并把商业化、团队机构和联系方式缺失列入 risks，而不是据此 review。',
      '不得调用工具、数据库、文件或网络，只返回符合 JSON Schema 的对象。',
    ].join('\n'),
    validator: screeningOutputSchema,
    outputSchema: {
      type: 'object', additionalProperties: false,
      required: ['decision', 'reason', 'confidence', 'evidence', 'risks'],
      properties: {
        decision: { type: 'string', enum: ['accept', 'reject', 'review'] },
        reason: { type: 'string', minLength: 1, maxLength: 8_000 },
        confidence: { type: 'number', minimum: 0, maximum: 100 },
        evidence: { type: 'array', maxItems: 50, items: EVIDENCE_JSON_SCHEMA },
        risks: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 2_000 } },
      },
    },
  },
  'lead-enrichment-agent': {
    profileVersion: 'lead-enrichment-agent-v1',
    promptVersion: 'lead-enrichment-prompt-v1',
    schemaVersion: 'lead-enrichment-output-v1',
    skillVersion: 'lead-enrichment-skill-v1',
    toolsetVersion: 'lead-research-host-tools-v1',
    defaultBudgetUsd: 0.4,
    systemPrompt: [
      '你是已入池线索增量补全 Agent。只提出字段补丁，不直接写库。',
      '仅允许白名单字段；标量只能 set_if_empty，数组只能 append_unique；不得覆盖人工或已有有效字段。',
      '每个补丁必须带输入中连续出现的原文 quote 和 sourceId；冲突进入 conflicts，不得擅自覆盖。',
      '不得调用工具、数据库、文件或网络，只返回符合 JSON Schema 的对象。',
    ].join('\n'),
    validator: enrichmentOutputSchema,
    outputSchema: {
      type: 'object', additionalProperties: false,
      required: ['patches', 'conflicts', 'gaps'],
      properties: {
        patches: {
          type: 'array', maxItems: 100,
          items: {
            type: 'object', additionalProperties: false,
            required: ['field', 'operation', 'value', 'claim', 'quote', 'sourceId'],
            properties: {
              field: { type: 'string', enum: [...ENRICHMENT_FIELDS] },
              operation: { type: 'string', enum: ['set_if_empty', 'append_unique'] },
              value: {},
              claim: { type: 'string', minLength: 1, maxLength: 8_000 },
              quote: { type: 'string', minLength: 1, maxLength: 8_000 },
              sourceId: { type: 'string', minLength: 1, maxLength: 2_000 },
            },
          },
        },
        conflicts: {
          type: 'array', maxItems: 50,
          items: {
            type: 'object', additionalProperties: false,
            required: ['field', 'existingValue', 'proposedValue', 'reason', 'sourceIds'],
            properties: {
              field: { type: 'string', enum: [...ENRICHMENT_FIELDS] },
              existingValue: {}, proposedValue: {},
              reason: { type: 'string', minLength: 1, maxLength: 4_000 },
              sourceIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 2_000 } },
            },
          },
        },
        gaps: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 2_000 } },
      },
    },
  },
}

export type LeadWorkflowAgentExecution = {
  profile: LeadWorkflowAgentProfile
  output: unknown
  runtime: 'claude-agent-sdk' | CodexStructuredOutputRuntime
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  durationMs: number
  costMicrousd: number
  toolCalls: number
  numTurns: number
  sessionId: string | null
}

export function leadWorkflowAgentRuntime(model?: string, forceClaudeSdk = false): LeadWorkflowAgentExecution['runtime'] {
  if (forceClaudeSdk) return 'claude-agent-sdk'
  const configured = process.env.LEAD_WORKFLOW_AGENT_BACKEND?.trim().toLowerCase()
  if (configured === 'codex-cli' || configured === 'codex-gateway' || configured === 'claude-agent-sdk') return configured
  return /^gpt-/i.test(model || process.env.LLM_MODEL || '') ? codexStructuredOutputRuntime() : 'claude-agent-sdk'
}

export type LeadWorkflowAgentQueryFactory = (params: Parameters<typeof query>[0]) => AsyncIterable<SDKMessage> & {
  close?: () => void
}

type AgentExecutionError = Error & {
  retryable?: boolean
  leadRunMetrics?: Partial<LeadWorkflowAgentExecution>
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

async function runtimeConfig(profile: LeadWorkflowAgentProfile, modelOverride?: string) {
  const contract = PROFILE_CONTRACTS[profile]
  const baseUrl = (
    process.env.LLM_BASE_URL
    || process.env.ANTHROPIC_BASE_URL
    || process.env.OPENAI_BASE_URL
    || 'http://127.0.0.1:18081/v1'
  ).replace(/\/v1\/?$/, '').replace(/\/$/, '')
  const routeKey = ({
    'lead-research-agent': 'lead-research',
    'lead-screening-agent': 'lead-screening',
    'lead-enrichment-agent': 'lead-enrichment',
  } as Partial<Record<LeadWorkflowAgentProfile, AiModelProfileKey>>)[profile] || 'lead-research'
  const policy = await resolveAgentRuntimePolicy(routeKey)
  const configured = modelOverride
    ? await resolveAiModelByKey(modelOverride)
    : await resolveAiModelRoute(policy.modelRouteKey)
  return {
    baseUrl: configured?.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '') || baseUrl,
    apiKey: configured?.apiKey || process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
    model: configured?.model || modelOverride || process.env.LLM_MODEL || 'gpt-5.6-sol',
    maxTurns: Math.min(policy.maxTurns, Math.round(boundedNumber(process.env.LEAD_WORKFLOW_AGENT_MAX_TURNS, 2, 1, 2))),
    maxBudgetUsd: Math.min(policy.maxBudgetUsd, boundedNumber(process.env.LEAD_WORKFLOW_AGENT_MAX_BUDGET_USD, contract.defaultBudgetUsd, 0.01, 2)),
    timeoutMs: Math.min(policy.timeoutMs, Math.round(boundedNumber(process.env.LEAD_WORKFLOW_AGENT_TIMEOUT_MS, 180_000, 30_000, 360_000))),
  }
}

function restrictedEnvironment(
  profile: LeadWorkflowAgentProfile,
  config: Awaited<ReturnType<typeof runtimeConfig>>,
  workDir: string,
) {
  const inherited = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']
  const env: Record<string, string | undefined> = {}
  for (const key of inherited) env[key] = process.env[key]
  return {
    ...env,
    ANTHROPIC_BASE_URL: config.baseUrl,
    ANTHROPIC_API_KEY: config.apiKey,
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_MODEL: config.model,
    CLAUDE_CONFIG_DIR: path.join(workDir, '.claude'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: `cybernaut-${profile}/1.0`,
  }
}

function parseJsonObject(value: string) {
  const cleaned = value.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '')
  const parsed = JSON.parse(cleaned)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Agent did not return a JSON object')
  return parsed
}

function normalizedEvidenceText(value: unknown) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function topLevelJsonObjects(input: string) {
  const objects: Record<string, unknown>[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (character === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(input.slice(start, index + 1))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) objects.push(parsed)
        } catch {
          // A clipped host JSON package still falls back to whole-prompt quote validation.
        }
        start = -1
      }
    }
  }
  return objects
}

function sourceEvidenceCorpora(prompt: string) {
  const corpora = new Map<string, string[]>()
  const add = (sourceId: unknown, value: unknown) => {
    const id = String(sourceId ?? '').trim()
    const normalized = normalizedEvidenceText(value)
    if (!id || !normalized) return
    corpora.set(id, [...(corpora.get(id) || []), normalized])
  }
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!value || typeof value !== 'object') return
    const object = value as Record<string, unknown>
    if (object.sourceId) {
      for (const key of ['quote', 'snippet', 'excerpt', 'articleText', 'article_text', 'summary', 'title']) {
        add(object.sourceId, object[key])
      }
    }
    for (const nested of Object.values(object)) visit(nested)
  }
  for (const object of topLevelJsonObjects(prompt)) visit(object)

  const taggedSource = /【sourceId=([^】]+)】/g
  const matches = [...prompt.matchAll(taggedSource)]
  for (const [index, match] of matches.entries()) {
    const from = (match.index || 0) + match[0].length
    const to = matches[index + 1]?.index ?? prompt.length
    add(match[1], prompt.slice(from, to))
  }
  return corpora
}

function validateQuotes(profile: LeadWorkflowAgentProfile, output: unknown, prompt: string) {
  const corpus = normalizedEvidenceText(prompt)
  const evidence = profile === 'lead-research-agent'
    ? (output as z.infer<typeof researchOutputSchema>).facts
    : profile === 'lead-screening-agent'
      ? (output as z.infer<typeof screeningOutputSchema>).evidence
      : (output as z.infer<typeof enrichmentOutputSchema>).patches
  const sourceCorpora = sourceEvidenceCorpora(prompt)
  for (const item of evidence) {
    const normalized = normalizedEvidenceText(item.quote)
    // JSON host packages escape newlines/quotes. Match the decoded source text
    // as well, without accepting paraphrases or quotes from a different source.
    const declaredSource = sourceCorpora.get(item.sourceId)
    const matchesSource = Boolean(normalized && declaredSource?.some((sourceText) => sourceText.includes(normalized)))
    if (!normalized || (!corpus.includes(normalized) && !matchesSource)) {
      throw new Error(`${profile} returned evidence quote not found in immutable host input`)
    }
    if (sourceCorpora.size) {
      if (!matchesSource) {
        throw new Error(`${profile} returned evidence quote not bound to declared sourceId`)
      }
    }
  }
}

export function leadWorkflowAgentContract(profile: LeadWorkflowAgentProfile) {
  const contract = PROFILE_CONTRACTS[profile]
  return {
    profile,
    profileVersion: contract.profileVersion,
    promptVersion: contract.promptVersion,
    schemaVersion: contract.schemaVersion,
    skillVersion: contract.skillVersion,
    toolsetVersion: contract.toolsetVersion,
    systemPrompt: contract.systemPrompt,
    outputSchema: contract.outputSchema,
  }
}

export function validateLeadWorkflowAgentOutput(
  profile: LeadWorkflowAgentProfile,
  output: unknown,
  immutableHostInput: string,
) {
  const parsed = PROFILE_CONTRACTS[profile].validator.parse(output)
  validateQuotes(profile, parsed, immutableHostInput)
  return parsed
}

export async function runLeadWorkflowAgent(input: {
  profile: LeadWorkflowAgentProfile
  prompt: string
  model?: string
}, options: {
  queryFactory?: LeadWorkflowAgentQueryFactory
  workDir?: string
  timeoutMs?: number
} = {}): Promise<LeadWorkflowAgentExecution> {
  if (!input.prompt.trim()) throw new Error(`${input.profile} requires immutable host input`)
  const contract = PROFILE_CONTRACTS[input.profile]
  const config = await runtimeConfig(input.profile, input.model)
  const runtime = leadWorkflowAgentRuntime(config.model, Boolean(options.queryFactory))
  if (runtime === 'codex-cli' || runtime === 'codex-gateway') {
    const execution = await runCodexStructuredOutput({
      profile: input.profile,
      systemPrompt: contract.systemPrompt,
      prompt: input.prompt,
      outputSchema: contract.outputSchema,
      model: config.model,
      timeoutMs: options.timeoutMs ?? config.timeoutMs,
      workDir: options.workDir,
      runtime,
    })
    try {
      return {
        ...execution,
        profile: input.profile,
        output: validateLeadWorkflowAgentOutput(input.profile, execution.output, input.prompt),
      }
    } catch (cause) {
      const error = new Error(redactSensitiveText(
        `${input.profile} structured output is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
      ).slice(0, 8_000)) as AgentExecutionError
      error.retryable = false
      error.leadRunMetrics = execution
      throw error
    }
  }
  const runtimePermit = options.queryFactory ? null : await acquireLeadAgentRuntimePermit({
    agentProfile: input.profile,
    reservationMicrousd: Math.round(config.maxBudgetUsd * 1_000_000),
  })
  const failRuntimePermit = async (error: unknown, actualMicrousd = 0) => {
    if (!runtimePermit) return
    await finishLeadAgentRuntimePermit({
      permit: runtimePermit,
      status: 'failed',
      actualMicrousd,
      error,
    }).catch(() => undefined)
  }
  const ownsWorkDir = !options.workDir
  const workDir = options.workDir
    ? path.resolve(options.workDir)
    : await mkdtemp(path.join(tmpdir(), `cybernaut-${input.profile}-`))
  if (!ownsWorkDir) await mkdir(workDir, { recursive: true, mode: 0o700 })
  const abortController = new AbortController()
  let timedOut = false
  const timeoutMs = options.timeoutMs ?? config.timeoutMs
  const timer = setTimeout(() => {
    timedOut = true
    abortController.abort()
  }, timeoutMs)
  timer.unref?.()
  let deniedTool: string | null = null
  let sdkQuery: ReturnType<LeadWorkflowAgentQueryFactory> | null = null
  let result: SDKResultMessage | null = null
  const telemetryRequestId = beginAiRuntimeRequest('lead-workflow-agent')
  const factory = options.queryFactory || ((params) => query(params) as ReturnType<LeadWorkflowAgentQueryFactory>)
  try {
    sdkQuery = factory({
      prompt: input.prompt,
      options: {
        cwd: workDir,
        model: config.model,
        maxTurns: config.maxTurns,
        maxBudgetUsd: config.maxBudgetUsd,
        abortController,
        permissionMode: 'dontAsk',
        tools: [], skills: [], allowedTools: [],
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Skill'],
        canUseTool: async (toolName) => {
          deniedTool = toolName
          return { behavior: 'deny', message: `${input.profile} does not allow tools: ${toolName}`, interrupt: true }
        },
        settingSources: [], mcpServers: {}, plugins: [], agents: {},
        persistSession: false,
        includePartialMessages: true,
        systemPrompt: contract.systemPrompt,
        outputFormat: { type: 'json_schema', schema: contract.outputSchema },
        env: restrictedEnvironment(input.profile, config, workDir),
      },
    })
    for await (const message of sdkQuery) {
      markAiRuntimeFirstTokenFromSdkMessage(telemetryRequestId, message)
      if (message.type === 'result') result = message
    }
  } catch (cause) {
    const message = timedOut
      ? `${input.profile} timed out after ${timeoutMs}ms`
      : `${input.profile} execution failed: ${cause instanceof Error ? cause.message : String(cause)}`
    const error = new Error(redactSensitiveText(message).slice(0, 8_000)) as AgentExecutionError
    error.retryable = true
    await failRuntimePermit(error)
    finishAiRuntimeRequest(telemetryRequestId, timedOut ? 'cancelled' : 'failed')
    throw error
  } finally {
    clearTimeout(timer)
    sdkQuery?.close?.()
    if (ownsWorkDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
  if (deniedTool) {
    const error = new Error(`${input.profile} attempted forbidden tool: ${deniedTool}`) as AgentExecutionError
    error.retryable = false
    await failRuntimePermit(error)
    finishAiRuntimeRequest(telemetryRequestId, 'failed')
    throw error
  }
  if (!result) {
    const error = new Error(`${input.profile} completed without a result`) as AgentExecutionError
    error.retryable = true
    await failRuntimePermit(error)
    finishAiRuntimeRequest(telemetryRequestId, 'failed')
    throw error
  }
  const metrics = {
    profile: input.profile,
    runtime: 'claude-agent-sdk' as const,
    usage: leadAgentUsageMetrics(result),
    durationMs: Number(result.duration_ms || 0),
    costMicrousd: Math.max(0, Math.round(Number(result.total_cost_usd || 0) * 1_000_000)),
    toolCalls: 0,
    numTurns: Number(result.num_turns || 0),
    sessionId: result.session_id || null,
  }
  if (result.subtype !== 'success' || result.is_error || result.permission_denials.length) {
    const detail = result.permission_denials.length
      ? 'forbidden tool permission request'
      : result.subtype === 'success' ? result.result : result.errors.join('; ')
    const error = new Error(redactSensitiveText(`${input.profile} ${result.subtype}: ${detail}`).slice(0, 8_000)) as AgentExecutionError
    error.retryable = result.subtype === 'error_during_execution'
    error.leadRunMetrics = metrics
    await failRuntimePermit(error, metrics.costMicrousd)
    finishAiRuntimeRequest(telemetryRequestId, 'failed')
    throw error
  }
  let output: unknown
  try {
    output = result.structured_output ?? parseJsonObject(result.result)
    output = validateLeadWorkflowAgentOutput(input.profile, output, input.prompt)
  } catch (cause) {
    const error = new Error(redactSensitiveText(
      `${input.profile} structured output is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
    ).slice(0, 8_000)) as AgentExecutionError
    error.retryable = false
    error.leadRunMetrics = metrics
    await failRuntimePermit(error, metrics.costMicrousd)
    finishAiRuntimeRequest(telemetryRequestId, 'failed')
    throw error
  }
  try {
    if (runtimePermit) {
      await finishLeadAgentRuntimePermit({
        permit: runtimePermit,
        status: 'succeeded',
        actualMicrousd: metrics.costMicrousd,
      })
    }
  } catch (error) {
    finishAiRuntimeRequest(telemetryRequestId, 'failed')
    throw error
  }
  finishAiRuntimeRequest(telemetryRequestId, 'succeeded')
  return { ...metrics, output }
}
