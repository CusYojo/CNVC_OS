import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { redactSensitiveText } from '../security/redactSecrets.js'
import { leadAgentUsageMetrics } from './leadAgentUsageService.js'
import { resolveAiModelByKey, resolveAiModelRoute } from './aiModelSettingsService.js'
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

export const LEAD_SCORING_AGENT_PROFILE = 'lead-scoring-agent'
export const LEAD_SCORING_AGENT_PROFILE_VERSION = 'lead-scoring-agent-v1'
export const LEAD_SCORING_AGENT_SCHEMA_VERSION = 'lead-scoring-output-v1'
export const LEAD_SCORING_AGENT_TOOLSET_VERSION = 'no-tools-v1'

export type LeadScoringAgentExecution = {
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

export function leadScoringAgentRuntime(model?: string, forceClaudeSdk = false): LeadScoringAgentExecution['runtime'] {
  if (forceClaudeSdk) return 'claude-agent-sdk'
  const configured = process.env.LEAD_SCORING_AGENT_BACKEND?.trim().toLowerCase()
  if (configured === 'codex-cli' || configured === 'claude-agent-sdk') return configured
  const selectedModel = model || process.env.SCORE_MODEL || process.env.LLM_MODEL || ''
  return /^gpt-/i.test(selectedModel) ? 'codex-cli' : 'claude-agent-sdk'
}

export type LeadScoringAgentQueryFactory = (params: Parameters<typeof query>[0]) => AsyncIterable<SDKMessage> & {
  close?: () => void
}

type AgentExecutionError = Error & {
  retryable?: boolean
  leadRunMetrics?: Partial<LeadScoringAgentExecution>
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

async function runtimeConfig(modelOverride?: string) {
  const policy = await resolveAgentRuntimePolicy('lead-scoring')
  const baseUrl = (
    process.env.LLM_BASE_URL
    || process.env.ANTHROPIC_BASE_URL
    || process.env.OPENAI_BASE_URL
    || 'http://127.0.0.1:18081/v1'
  ).replace(/\/v1\/?$/, '').replace(/\/$/, '')
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || ''
  const model = modelOverride || process.env.SCORE_MODEL || process.env.LLM_MODEL || 'claude-sonnet-4-6'
  const configured = modelOverride
    ? await resolveAiModelByKey(modelOverride)
    : await resolveAiModelRoute(policy.modelRouteKey)
  return {
    baseUrl: configured?.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '') || baseUrl,
    apiKey: configured?.apiKey || apiKey,
    model: configured?.model || model,
    maxTurns: Math.min(policy.maxTurns, Math.round(boundedNumber(process.env.LEAD_SCORING_AGENT_MAX_TURNS, 2, 1, 2))),
    maxBudgetUsd: Math.min(policy.maxBudgetUsd, boundedNumber(process.env.LEAD_SCORING_AGENT_MAX_BUDGET_USD, 0.75, 0.01, 4)),
    timeoutMs: Math.min(policy.timeoutMs, Math.round(boundedNumber(process.env.SCORE_REQUEST_TIMEOUT_MS, 360_000, 30_000, 600_000))),
  }
}

function restrictedEnvironment(config: Awaited<ReturnType<typeof runtimeConfig>>, workDir: string) {
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
    CLAUDE_AGENT_SDK_CLIENT_APP: 'cybernaut-lead-scoring-agent/1.0',
  }
}

function parseJsonObject(value: string) {
  const cleaned = value.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '')
  const parsed = JSON.parse(cleaned)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('lead scoring Agent did not return a JSON object')
  }
  return parsed
}

function codexUsage(stdout: string) {
  let inputTokens = 0
  let outputTokens = 0
  for (const line of stdout.split('\n')) {
    let value: unknown
    try { value = JSON.parse(line) } catch { continue }
    const stack: unknown[] = [value]
    while (stack.length) {
      const current = stack.pop()
      if (!current || typeof current !== 'object') continue
      const data = current as Record<string, unknown>
      const usage = data.usage && typeof data.usage === 'object'
        ? data.usage as Record<string, unknown>
        : null
      if (usage) {
        inputTokens = Math.max(inputTokens, Number(usage.input_tokens ?? usage.inputTokens) || 0)
        outputTokens = Math.max(outputTokens, Number(usage.output_tokens ?? usage.outputTokens) || 0)
      }
      stack.push(...Object.values(data))
    }
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

async function runLeadScoringCodexCli(input: {
  systemPrompt: string
  prompt: string
  outputSchema: Record<string, unknown>
  model?: string
}, config: Awaited<ReturnType<typeof runtimeConfig>>, options: { workDir?: string; timeoutMs?: number }) {
  const ownsWorkDir = !options.workDir
  const workDir = options.workDir
    ? path.resolve(options.workDir)
    : await mkdtemp(path.join(tmpdir(), 'cybernaut-lead-scoring-codex-'))
  if (!ownsWorkDir) await mkdir(workDir, { recursive: true, mode: 0o700 })
  const schemaPath = path.join(workDir, `output-schema-${process.pid}-${Date.now()}.json`)
  const outputPath = path.join(workDir, `output-${process.pid}-${Date.now()}.json`)
  await writeFile(schemaPath, `${JSON.stringify(input.outputSchema)}\n`, { mode: 0o600 })
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? config.timeoutMs
  const codexBin = process.env.CODEX_BIN?.trim() || 'codex'
  let timeout: NodeJS.Timeout | undefined
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(codexBin, [
        'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
        '--json', '-m', input.model || config.model, '-s', 'read-only', '-C', workDir,
        '--output-schema', schemaPath, '--output-last-message', outputPath, '-',
      ], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-2_000_000) })
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-100_000) })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
      timeout = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
      }, Math.max(30_000, timeoutMs))
      child.stdin.end([
        input.systemPrompt,
        input.prompt,
        '仅根据输入中的已冻结补全快照完成评级。严格按输出 schema 返回 JSON，不要调用工具，不要输出 Markdown 或额外解释。',
      ].join('\n\n'))
    })
    let output: unknown
    try { output = parseJsonObject(await readFile(outputPath, 'utf8')) } catch { output = undefined }
    if (result.code !== 0 && !output) {
      const error = new Error(redactSensitiveText(
        `lead-scoring Codex CLI exited ${result.code}; stdout=${result.stdout.slice(-4_000)}; stderr=${result.stderr.slice(-2_000)}`,
      ).slice(0, 8_000)) as AgentExecutionError
      error.retryable = true
      throw error
    }
    if (!output) {
      const error = new Error('lead-scoring Codex CLI did not produce valid structured output') as AgentExecutionError
      error.retryable = true
      throw error
    }
    const usage = codexUsage(result.stdout)
    return {
      output,
      runtime: 'codex-cli' as const,
      usage,
      durationMs: Date.now() - startedAt,
      costMicrousd: 0,
      toolCalls: 0,
      numTurns: 1,
      sessionId: null,
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    if (ownsWorkDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function resultError(message: string, result: SDKResultMessage, retryable: boolean): AgentExecutionError {
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

export async function runLeadScoringAgent(input: {
  systemPrompt: string
  prompt: string
  outputSchema: Record<string, unknown>
  model?: string
}, options: {
  queryFactory?: LeadScoringAgentQueryFactory
  workDir?: string
  timeoutMs?: number
} = {}): Promise<LeadScoringAgentExecution> {
  if (!input.prompt.trim()) throw new Error('lead scoring Agent requires a prompt')
  const config = await runtimeConfig(input.model)
  if (leadScoringAgentRuntime(config.model, Boolean(options.queryFactory)) === 'codex-cli') {
    return await runLeadScoringCodexCli(input, config, options)
  }
  const runtimePermit = options.queryFactory ? null : await acquireLeadAgentRuntimePermit({
    agentProfile: LEAD_SCORING_AGENT_PROFILE,
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
    : await mkdtemp(path.join(tmpdir(), 'cybernaut-lead-scoring-agent-'))
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
  let sdkQuery: ReturnType<LeadScoringAgentQueryFactory> | null = null
  let result: SDKResultMessage | null = null
  const telemetryRequestId = beginAiRuntimeRequest('lead-scoring-agent')
  const factory = options.queryFactory || ((params) => query(params) as ReturnType<LeadScoringAgentQueryFactory>)
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
        tools: [],
        skills: [],
        allowedTools: [],
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Skill'],
        canUseTool: async (toolName) => {
          deniedTool = toolName
          return {
            behavior: 'deny',
            message: `lead-scoring-agent does not allow tools: ${toolName}`,
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
        outputFormat: { type: 'json_schema', schema: input.outputSchema },
        env: restrictedEnvironment(config, workDir),
      },
    })
    for await (const message of sdkQuery) {
      markAiRuntimeFirstTokenFromSdkMessage(telemetryRequestId, message)
      if (message.type === 'result') result = message
    }
  } catch (cause) {
    const message = timedOut
      ? `lead-scoring-agent timed out after ${timeoutMs}ms`
      : `lead-scoring-agent execution failed: ${cause instanceof Error ? cause.message : String(cause)}`
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
    const error = new Error(`lead-scoring-agent attempted forbidden tool: ${deniedTool}`) as AgentExecutionError
    error.retryable = false
    await failRuntimePermit(error)
    finishAiRuntimeRequest(telemetryRequestId, 'failed')
    throw error
  }
  if (!result) {
    const error = new Error('lead-scoring-agent completed without a result') as AgentExecutionError
    error.retryable = true
    await failRuntimePermit(error)
    finishAiRuntimeRequest(telemetryRequestId, 'failed')
    throw error
  }
  if (result.subtype !== 'success' || result.is_error) {
    const detail = result.subtype === 'success' ? result.result : result.errors.join('; ')
    const error = resultError(
      `lead-scoring-agent ${result.subtype}: ${detail || 'unknown error'}`,
      result,
      result.subtype === 'error_during_execution',
    )
    await failRuntimePermit(error, error.leadRunMetrics?.costMicrousd)
    finishAiRuntimeRequest(telemetryRequestId, 'failed')
    throw error
  }
  if (result.permission_denials.length) {
    const error = resultError('lead-scoring-agent received a forbidden tool permission request', result, false)
    await failRuntimePermit(error, error.leadRunMetrics?.costMicrousd)
    finishAiRuntimeRequest(telemetryRequestId, 'failed')
    throw error
  }
  let output: unknown
  try {
    output = result.structured_output ?? parseJsonObject(result.result)
  } catch (cause) {
    const error = resultError(
      `lead-scoring-agent structured output is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
      result,
      false,
    )
    await failRuntimePermit(error, error.leadRunMetrics?.costMicrousd)
    finishAiRuntimeRequest(telemetryRequestId, 'failed')
    throw error
  }
  const execution: LeadScoringAgentExecution = {
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
