import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { redactSensitiveText } from '../security/redactSecrets.js'
import { resolveAiModelByKey, resolveAiModelRoute } from './aiModelSettingsService.js'
import { resolveAgentRuntimePolicy } from './aiCapabilityService.js'
import {
  acquireLeadAgentRuntimePermit,
  finishLeadAgentRuntimePermit,
} from './leadAgentRuntimeGuardService.js'
import { leadAgentUsageMetrics } from './leadAgentUsageService.js'
import {
  beginAiRuntimeRequest,
  finishAiRuntimeRequest,
  markAiRuntimeFirstTokenFromSdkMessage,
} from '../runtime/aiRuntimeTelemetry.js'
import { runCodexStructuredOutput } from './codexStructuredOutputService.js'

export const LEAD_SUBJECT_AGENT_PROFILE = 'lead-subject-agent'
export const LEAD_SUBJECT_AGENT_PROFILE_VERSION = 'lead-subject-agent-v1'
export const LEAD_SUBJECT_AGENT_SCHEMA_VERSION = 'radar-subject-decision-v2'
export const LEAD_SUBJECT_AGENT_TOOLSET_VERSION = 'no-tools-v1'

export type LeadSubjectAgentCandidate = {
  candidateId: string
  promptText: string
}

export type LeadSubjectAgentExecution = {
  output: unknown
  runtime: 'claude-agent-sdk' | 'codex-cli'
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  durationMs: number
  costMicrousd: number
  toolCalls: number
  numTurns: number
  sessionId: string | null
}

export function leadSubjectAgentRuntime(model?: string, forceClaudeSdk = false): LeadSubjectAgentExecution['runtime'] {
  if (forceClaudeSdk) return 'claude-agent-sdk'
  const configured = process.env.LEAD_SUBJECT_AGENT_BACKEND?.trim().toLowerCase()
  if (configured === 'codex-cli' || configured === 'claude-agent-sdk') return configured
  return /^gpt-/i.test(model || process.env.RADAR_AI_REVIEW_MODEL || process.env.LLM_MODEL || '')
    ? 'codex-cli'
    : 'claude-agent-sdk'
}

export type LeadSubjectAgentQueryFactory = (params: Parameters<typeof query>[0]) => AsyncIterable<SDKMessage> & {
  close?: () => void
}

type AgentExecutionError = Error & {
  retryable?: boolean
  leadRunMetrics?: Partial<LeadSubjectAgentExecution>
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['reviews'],
  properties: {
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'candidateId', 'decision', 'subjectType', 'subjectName', 'legalName', 'evidence',
          'translatedTitle', 'paperProjectName', 'paperProjectNameZh', 'translatedSummary', 'confidence', 'rejectReason',
        ],
        properties: {
          candidateId: { type: 'string', minLength: 1 },
          decision: { type: 'string', enum: ['accept', 'reject', 'review'] },
          subjectType: { anyOf: [{ type: 'string', enum: ['company', 'project', 'team', 'lab', 'paper'] }, { type: 'null' }] },
          subjectName: { type: 'string' },
          legalName: { type: 'string' },
          evidence: { type: 'string' },
          translatedTitle: { type: 'string' },
          paperProjectName: { type: 'string' },
          paperProjectNameZh: { type: 'string' },
          translatedSummary: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          rejectReason: { type: 'string' },
        },
      },
    },
  },
}

function positiveNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

async function agentConfig(modelOverride?: string) {
  const policy = await resolveAgentRuntimePolicy('lead-subject')
  const baseUrl = (
    process.env.LLM_BASE_URL
    || process.env.ANTHROPIC_BASE_URL
    || process.env.OPENAI_BASE_URL
    || 'http://127.0.0.1:18081/v1'
  ).replace(/\/v1\/?$/, '')
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || ''
  const model = modelOverride || process.env.RADAR_AI_REVIEW_MODEL || process.env.LLM_MODEL || 'claude-sonnet-4-6'
  const configured = modelOverride
    ? await resolveAiModelByKey(modelOverride)
    : await resolveAiModelRoute(policy.modelRouteKey)
  return {
    baseUrl: configured?.baseUrl.replace(/\/v1\/?$/, '') || baseUrl,
    apiKey: configured?.apiKey || apiKey,
    model: configured?.model || model,
    maxTurns: Math.min(policy.maxTurns, Math.round(positiveNumber(process.env.LEAD_SUBJECT_AGENT_MAX_TURNS, 2, 1, 2))),
    maxBudgetUsd: Math.min(policy.maxBudgetUsd, positiveNumber(process.env.LEAD_SUBJECT_AGENT_MAX_BUDGET_USD, 0.25, 0.01, 2)),
    timeoutMs: Math.min(policy.timeoutMs, Math.round(positiveNumber(process.env.RADAR_AI_REVIEW_TIMEOUT_MS, 120_000, 30_000, 300_000))),
  }
}

function restrictedAgentEnvironment(config: Awaited<ReturnType<typeof agentConfig>>, workDir: string) {
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
    CLAUDE_AGENT_SDK_CLIENT_APP: 'cybernaut-lead-subject-agent/1.0',
  }
}

function parseJsonObject(value: string) {
  const cleaned = value.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '')
  const parsed = JSON.parse(cleaned)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('lead subject Agent did not return a JSON object')
  }
  return parsed
}

function executionError(message: string, result: SDKResultMessage, retryable: boolean): AgentExecutionError {
  const error = new Error(redactSensitiveText(message).slice(0, 8_000)) as AgentExecutionError
  error.retryable = retryable
  error.leadRunMetrics = {
    runtime: 'claude-agent-sdk',
    usage: leadAgentUsageMetrics(result),
    durationMs: Number(result.duration_ms || 0),
    costMicrousd: Math.max(0, Math.round(Number(result.total_cost_usd || 0) * 1_000_000)),
    toolCalls: 0,
    numTurns: Number(result.num_turns || 0),
    sessionId: result.session_id || null,
  }
  return error
}

export async function runLeadSubjectAgentBatch(input: {
  systemPrompt: string
  candidates: LeadSubjectAgentCandidate[]
  model?: string
}, options: {
  queryFactory?: LeadSubjectAgentQueryFactory
  workDir?: string
  timeoutMs?: number
} = {}): Promise<LeadSubjectAgentExecution> {
  if (!input.candidates.length) throw new Error('lead subject Agent requires candidates')
  const config = await agentConfig(input.model)
  const prompt = input.candidates
    .map((item) => `【candidateId=${item.candidateId}】\n${item.promptText || '无可用原文'}`)
    .join('\n\n')
  if (leadSubjectAgentRuntime(config.model, Boolean(options.queryFactory)) === 'codex-cli') {
    return await runCodexStructuredOutput({
      profile: LEAD_SUBJECT_AGENT_PROFILE,
      systemPrompt: input.systemPrompt,
      prompt,
      outputSchema: OUTPUT_SCHEMA,
      model: config.model,
      timeoutMs: options.timeoutMs ?? config.timeoutMs,
      workDir: options.workDir,
    })
  }
  const runtimePermit = options.queryFactory ? null : await acquireLeadAgentRuntimePermit({
    agentProfile: LEAD_SUBJECT_AGENT_PROFILE,
    reservationMicrousd: Math.round(config.maxBudgetUsd * 1_000_000),
  })
  const failRuntimePermit = async (error: unknown, actualMicrousd = 0) => {
    if (!runtimePermit) return
    await finishLeadAgentRuntimePermit({
      permit: runtimePermit, status: 'failed', actualMicrousd, error,
    }).catch(() => undefined)
  }
  const ownsWorkDir = !options.workDir
  const workDir = options.workDir
    ? path.resolve(options.workDir)
    : await mkdtemp(path.join(tmpdir(), 'cybernaut-lead-subject-agent-'))
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
  const factory = options.queryFactory || ((params) => query(params) as ReturnType<LeadSubjectAgentQueryFactory>)
  let sdkQuery: ReturnType<LeadSubjectAgentQueryFactory> | null = null
  let result: SDKResultMessage | null = null
  const telemetryRequestId = beginAiRuntimeRequest('lead-subject-agent')
  try {
    sdkQuery = factory({
      prompt,
      options: {
        cwd: workDir,
        model: config.model,
        maxTurns: config.maxTurns,
        maxBudgetUsd: config.maxBudgetUsd,
        abortController,
        permissionMode: 'dontAsk',
        tools: [],
        skills: [],
        allowedTools: [],
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Skill'],
        canUseTool: async (toolName) => {
          deniedTool = toolName
          return {
            behavior: 'deny',
            message: `lead-subject-agent does not allow tools: ${toolName}`,
            interrupt: true,
          }
        },
        settingSources: [],
        mcpServers: {},
        plugins: [],
        agents: {},
        persistSession: false,
        includePartialMessages: true,
        systemPrompt: input.systemPrompt,
        outputFormat: { type: 'json_schema', schema: OUTPUT_SCHEMA },
        env: restrictedAgentEnvironment(config, workDir),
      },
    })
    for await (const message of sdkQuery) {
      markAiRuntimeFirstTokenFromSdkMessage(telemetryRequestId, message)
      if (message.type === 'result') result = message
    }
  } catch (cause) {
    const message = timedOut
      ? `lead-subject-agent timed out after ${timeoutMs}ms`
      : `lead-subject-agent execution failed: ${cause instanceof Error ? cause.message : String(cause)}`
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
    const error = new Error(`lead-subject-agent attempted forbidden tool: ${deniedTool}`) as AgentExecutionError
    error.retryable = false
    await failRuntimePermit(error)
    finishAiRuntimeRequest(telemetryRequestId, 'failed')
    throw error
  }
  if (!result) {
    const error = new Error('lead-subject-agent completed without a result') as AgentExecutionError
    error.retryable = true
    await failRuntimePermit(error)
    finishAiRuntimeRequest(telemetryRequestId, 'failed')
    throw error
  }
  if (result.subtype !== 'success' || result.is_error) {
    const detail = result.subtype === 'success' ? result.result : result.errors.join('; ')
    const error = executionError(
      `lead-subject-agent ${result.subtype}: ${detail || 'unknown error'}`,
      result,
      result.subtype === 'error_during_execution',
    )
    await failRuntimePermit(error, error.leadRunMetrics?.costMicrousd)
    finishAiRuntimeRequest(telemetryRequestId, 'failed')
    throw error
  }
  if (result.permission_denials.length) {
    const error = executionError('lead-subject-agent received a forbidden tool permission request', result, false)
    await failRuntimePermit(error, error.leadRunMetrics?.costMicrousd)
    finishAiRuntimeRequest(telemetryRequestId, 'failed')
    throw error
  }
  let output: unknown
  try {
    output = result.structured_output ?? parseJsonObject(result.result)
  } catch (cause) {
    const error = executionError(
      `lead-subject-agent structured output is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
      result,
      false,
    )
    await failRuntimePermit(error, error.leadRunMetrics?.costMicrousd)
    finishAiRuntimeRequest(telemetryRequestId, 'failed')
    throw error
  }
  const execution: LeadSubjectAgentExecution = {
    output,
    runtime: 'claude-agent-sdk',
    usage: leadAgentUsageMetrics(result),
    durationMs: Number(result.duration_ms || 0),
    costMicrousd: Math.max(0, Math.round(Number(result.total_cost_usd || 0) * 1_000_000)),
    toolCalls: 0,
    numTurns: Number(result.num_turns || 0),
    sessionId: result.session_id || null,
  }
  try {
    if (runtimePermit) {
      await finishLeadAgentRuntimePermit({
        permit: runtimePermit, status: 'succeeded', actualMicrousd: execution.costMicrousd,
      })
    }
  } catch (error) {
    finishAiRuntimeRequest(telemetryRequestId, 'failed')
    throw error
  }
  finishAiRuntimeRequest(telemetryRequestId, 'succeeded')
  return execution
}
