import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { pool } from '../db/client.js'
import {
  runLeadSubjectAgentBatch,
  type LeadSubjectAgentQueryFactory,
} from '../services/leadSubjectAgentService.js'
import { aiRuntimeTelemetrySnapshot, resetAiRuntimeTelemetryForAcceptance } from '../runtime/aiRuntimeTelemetry.js'

const checks: string[] = []
function check(condition: unknown, name: string, detail?: unknown) {
  assert.ok(condition, detail == null ? name : `${name}: ${JSON.stringify(detail)}`)
  checks.push(name)
}

function successMessage(output: unknown): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 42,
    duration_api_ms: 40,
    is_error: false,
    num_turns: 1,
    result: JSON.stringify(output),
    stop_reason: 'end_turn',
    total_cost_usd: 0.001234,
    usage: {
      input_tokens: 321,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
      output_tokens: 45,
      server_tool_use: null,
      service_tier: null,
    },
    modelUsage: {},
    permission_denials: [],
    structured_output: output,
    uuid: '00000000-0000-4000-8000-000000000001',
    session_id: 'lead-subject-acceptance-session',
  } as unknown as SDKMessage
}

function firstTokenMessage(): SDKMessage {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '{' } },
    uuid: '00000000-0000-4000-8000-000000000000', session_id: 'lead-subject-acceptance-session',
  } as unknown as SDKMessage
}

async function main() {
  resetAiRuntimeTelemetryForAcceptance()
  const workDir = await mkdtemp(path.join(tmpdir(), 'lead-subject-agent-acceptance-'))
  const originalEnv = {
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    DB_HOST: process.env.DB_HOST,
    DB_DATABASE: process.env.DB_DATABASE,
    DB_USERNAME: process.env.DB_USERNAME,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DB_FREFIX: process.env.DB_FREFIX,
  }
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:18081/v1'
  process.env.ANTHROPIC_API_KEY = 'AgentAcceptanceApiKey'
  process.env.DB_HOST = 'mysql.internal.invalid'
  process.env.DB_DATABASE = 'agent_must_not_see_database'
  process.env.DB_USERNAME = 'agent_must_not_see_username'
  process.env.DB_PASSWORD = 'AgentMustNotSeePassword'
  process.env.DB_FREFIX = 'agent_must_not_see_prefix_'

  try {
    const captured: { value?: Parameters<typeof query>[0] } = {}
    const output = { reviews: [] }
    const queryFactory: LeadSubjectAgentQueryFactory = (params) => {
      captured.value = params
      return (async function* () {
        yield firstTokenMessage()
        yield successMessage(output)
      })()
    }
    const execution = await runLeadSubjectAgentBatch({
      systemPrompt: 'Return the required structured lead subject decision.',
      candidates: [{ candidateId: 'candidate-1', promptText: '审计星科技完成融资。' }],
      model: 'claude-sonnet-acceptance',
    }, { queryFactory, workDir, timeoutMs: 5_000 })
    check(execution.output === output
      && execution.runtime === 'claude-agent-sdk'
      && execution.usage.inputTokens === 351
      && execution.usage.outputTokens === 45
      && execution.usage.totalTokens === 396
      && execution.durationMs === 42
      && execution.costMicrousd === 1_234
      && execution.toolCalls === 0
      && execution.numTurns === 1,
    'structured-output-and-exact-agent-metrics-returned', execution)
    const aiTelemetry = aiRuntimeTelemetrySnapshot()
    check(aiTelemetry.last24h.firstTokenObserved === 1
      && aiTelemetry.last24h.firstTokenUnavailable === 0,
    'subject-agent-records-real-partial-message-first-token', aiTelemetry.last24h)

    assert.ok(captured.value)
    const options = captured.value.options
    check(Array.isArray(options?.tools) && options.tools.length === 0
      && Array.isArray(options.skills) && options.skills.length === 0
      && Array.isArray(options.allowedTools) && options.allowedTools.length === 0,
    'agent-exposes-no-tools-or-skills')
    check(options?.permissionMode === 'dontAsk'
      && options.persistSession === false
      && options.settingSources?.length === 0
      && Object.keys(options.mcpServers || {}).length === 0
      && options.plugins?.length === 0
      && Object.keys(options.agents || {}).length === 0
      && options.includePartialMessages === true,
    'agent-has-no-settings-mcp-plugins-subagents-or-session-persistence')
    check(Number(options?.maxTurns) >= 1 && Number(options?.maxTurns) <= 2
      && Number(options?.maxBudgetUsd) > 0 && Number(options?.maxBudgetUsd) <= 2,
    'agent-turn-and-budget-bounds-are-enforced')
    check(options?.outputFormat?.type === 'json_schema'
      && typeof options.systemPrompt === 'string'
      && options.systemPrompt.includes('structured lead subject'),
    'agent-uses-custom-system-prompt-and-json-schema-output')
    const env = options?.env || {}
    check(env.ANTHROPIC_BASE_URL === 'http://127.0.0.1:18081'
      && env.ANTHROPIC_API_KEY === 'AgentAcceptanceApiKey'
      && env.DB_HOST === undefined
      && env.DB_DATABASE === undefined
      && env.DB_USERNAME === undefined
      && env.DB_PASSWORD === undefined
      && env.DB_FREFIX === undefined
      && env.OPENAI_API_KEY === undefined
      && env.LLM_API_KEY === undefined,
    'agent-environment-whitelists-gateway-and-excludes-database-secrets', Object.keys(env))
    check([
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Skill',
    ].every((tool) => options?.disallowedTools?.includes(tool)),
    'sensitive-built-in-tools-are-explicitly-denied')

    const denyingFactory: LeadSubjectAgentQueryFactory = (params) => (async function* () {
      await params.options?.canUseTool?.('Bash', { command: 'env' }, {
        signal: new AbortController().signal,
        toolUseID: 'forbidden-tool-use',
      })
      yield successMessage(output)
    })()
    await assert.rejects(() => runLeadSubjectAgentBatch({
      systemPrompt: 'Return JSON.',
      candidates: [{ candidateId: 'candidate-2', promptText: 'test' }],
    }, { queryFactory: denyingFactory, workDir, timeoutMs: 5_000 }), /attempted forbidden tool: Bash/)
    check(true, 'runtime-tool-request-is-denied-and-fails-closed')

    const failingFactory: LeadSubjectAgentQueryFactory = () => (async function* () {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: 17,
        duration_api_ms: 15,
        is_error: true,
        num_turns: 2,
        stop_reason: null,
        total_cost_usd: 0.000099,
        usage: {
          input_tokens: 7,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
        modelUsage: {},
        permission_denials: [],
        errors: ['password=AgentAcceptanceSecret'],
        uuid: '00000000-0000-4000-8000-000000000002',
        session_id: 'failed-lead-subject-session',
      } as unknown as SDKMessage
    })()
    const failed: {
      error?: Error & { retryable?: boolean; leadRunMetrics?: Record<string, unknown> }
    } = {}
    try {
      await runLeadSubjectAgentBatch({
        systemPrompt: 'Return JSON.',
        candidates: [{ candidateId: 'candidate-3', promptText: 'test' }],
      }, { queryFactory: failingFactory, workDir, timeoutMs: 5_000 })
    } catch (error) {
      failed.error = error as typeof failed.error
    }
    check(Boolean(failed.error)
      && failed.error?.retryable === true
      && !failed.error.message.includes('AgentAcceptanceSecret')
      && failed.error.leadRunMetrics?.toolCalls === 0,
    'agent-failure-is-retryable-redacted-and-audited-with-zero-tools', failed.error)

    const throwingFactory: LeadSubjectAgentQueryFactory = () => (async function* () {
      throw new Error('password=ThrownAgentAcceptanceSecret')
      yield successMessage(output)
    })()
    let thrownMessage = ''
    try {
      await runLeadSubjectAgentBatch({
        systemPrompt: 'Return JSON.',
        candidates: [{ candidateId: 'candidate-4', promptText: 'test' }],
      }, { queryFactory: throwingFactory, workDir, timeoutMs: 5_000 })
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error)
    }
    check(thrownMessage.includes('[REDACTED]') && !thrownMessage.includes('ThrownAgentAcceptanceSecret'),
      'agent-transport-exception-is-redacted-before-propagation', thrownMessage)

    console.log(JSON.stringify({ ok: true, checks: checks.length, names: checks }, null, 2))
  } finally {
    resetAiRuntimeTelemetryForAcceptance()
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(workDir, { recursive: true, force: true })
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
