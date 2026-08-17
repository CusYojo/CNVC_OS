import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { pool } from '../db/client.js'
import {
  runLeadScoringAgent,
  type LeadScoringAgentQueryFactory,
} from '../services/leadScoringAgentService.js'
import { aiRuntimeTelemetrySnapshot, resetAiRuntimeTelemetryForAcceptance } from '../runtime/aiRuntimeTelemetry.js'

const checks: string[] = []
function check(condition: unknown, name: string, detail?: unknown) {
  assert.ok(condition, detail == null ? name : `${name}: ${JSON.stringify(detail)}`)
  checks.push(name)
}

function successMessage(output: unknown): SDKMessage {
  return {
    type: 'result', subtype: 'success', duration_ms: 51, duration_api_ms: 49,
    is_error: false, num_turns: 2, result: JSON.stringify(output), stop_reason: 'end_turn',
    total_cost_usd: 0.002345,
    usage: {
      input_tokens: 400, cache_creation_input_tokens: 11, cache_read_input_tokens: 22,
      output_tokens: 67, server_tool_use: null, service_tier: null,
    },
    modelUsage: {}, permission_denials: [], structured_output: output,
    uuid: '00000000-0000-4000-8000-000000000011', session_id: 'lead-scoring-acceptance-session',
  } as unknown as SDKMessage
}

function firstTokenMessage(): SDKMessage {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{' } },
    uuid: '00000000-0000-4000-8000-000000000010', session_id: 'lead-scoring-acceptance-session',
  } as unknown as SDKMessage
}

async function main() {
  resetAiRuntimeTelemetryForAcceptance()
  const workDir = await mkdtemp(path.join(tmpdir(), 'lead-scoring-agent-acceptance-'))
  const originalEnv = {
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DB_HOST: process.env.DB_HOST,
    DB_DATABASE: process.env.DB_DATABASE,
    DB_USERNAME: process.env.DB_USERNAME,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DB_FREFIX: process.env.DB_FREFIX,
  }
  process.env.LLM_BASE_URL = 'https://agent-acceptance.invalid/api/v9'
  process.env.LLM_API_KEY = 'ScoringAgentAcceptanceApiKey'
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_API_KEY
  process.env.DB_HOST = 'mysql.internal.invalid'
  process.env.DB_DATABASE = 'agent_must_not_see_database'
  process.env.DB_USERNAME = 'agent_must_not_see_username'
  process.env.DB_PASSWORD = 'ScoringAgentMustNotSeePassword'
  process.env.DB_FREFIX = 'agent_must_not_see_prefix_'
  try {
    const captured: { value?: Parameters<typeof query>[0] } = {}
    const output = { ok: true }
    const factory: LeadScoringAgentQueryFactory = (params) => {
      captured.value = params
      return (async function* () { yield firstTokenMessage(); yield successMessage(output) })()
    }
    const execution = await runLeadScoringAgent({
      systemPrompt: 'Return the required scoring JSON only.',
      prompt: 'Score the supplied project.',
      outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
      model: 'gpt-scoring-acceptance',
    }, { queryFactory: factory, workDir, timeoutMs: 5_000 })
    check(execution.output === output
      && execution.runtime === 'claude-agent-sdk'
      && execution.usage.inputTokens === 433
      && execution.usage.outputTokens === 67
      && execution.usage.totalTokens === 500
      && execution.durationMs === 51
      && execution.costMicrousd === 2_345
      && execution.toolCalls === 0
      && execution.numTurns === 2,
    'structured-scoring-output-and-exact-sdk-metrics-returned', execution)
    const aiTelemetry = aiRuntimeTelemetrySnapshot()
    check(aiTelemetry.last24h.firstTokenObserved === 1
      && aiTelemetry.last24h.firstTokenUnavailable === 0,
    'scoring-agent-records-real-partial-message-first-token', aiTelemetry.last24h)

    assert.ok(captured.value)
    const options = captured.value.options
    check(options?.model === 'gpt-scoring-acceptance'
      && Number(options.maxTurns) === 2
      && Number(options.maxBudgetUsd) > 0 && Number(options.maxBudgetUsd) <= 4,
    'scoring-agent-model-turn-and-budget-bounds-are-enforced')
    check(Array.isArray(options?.tools) && options.tools.length === 0
      && Array.isArray(options.skills) && options.skills.length === 0
      && Array.isArray(options.allowedTools) && options.allowedTools.length === 0
      && options.permissionMode === 'dontAsk',
    'scoring-agent-exposes-no-tools-or-skills')
    check(options?.settingSources?.length === 0
      && Object.keys(options?.mcpServers || {}).length === 0
      && options?.plugins?.length === 0
      && Object.keys(options?.agents || {}).length === 0
      && options?.persistSession === false
      && options?.includePartialMessages === true,
    'scoring-agent-has-no-settings-mcp-plugins-subagents-or-session-persistence')
    check(options?.outputFormat?.type === 'json_schema'
      && typeof options.systemPrompt === 'string'
      && options.systemPrompt.includes('scoring JSON'),
    'scoring-agent-uses-custom-system-prompt-and-json-schema-output')
    const env = options?.env || {}
    check(env.ANTHROPIC_BASE_URL === 'https://agent-acceptance.invalid/api/v9'
      && env.ANTHROPIC_API_KEY === 'ScoringAgentAcceptanceApiKey'
      && env.DB_HOST === undefined && env.DB_DATABASE === undefined
      && env.DB_USERNAME === undefined && env.DB_PASSWORD === undefined && env.DB_FREFIX === undefined
      && env.OPENAI_API_KEY === undefined && env.LLM_API_KEY === undefined,
    'scoring-agent-environment-excludes-database-secrets', Object.keys(env))
    check(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Skill']
      .every((tool) => options?.disallowedTools?.includes(tool)),
    'scoring-agent-sensitive-built-in-tools-are-explicitly-denied')

    const denyFactory: LeadScoringAgentQueryFactory = (params) => (async function* () {
      await params.options?.canUseTool?.('Bash', { command: 'env' }, {
        signal: new AbortController().signal, toolUseID: 'forbidden-scoring-tool',
      })
      yield successMessage(output)
    })()
    await assert.rejects(() => runLeadScoringAgent({
      systemPrompt: 'Return JSON.', prompt: 'score', outputSchema: { type: 'object' },
    }, { queryFactory: denyFactory, workDir, timeoutMs: 5_000 }), /attempted forbidden tool: Bash/)
    check(true, 'scoring-agent-runtime-tool-request-is-denied-and-fails-closed')

    const failFactory: LeadScoringAgentQueryFactory = () => (async function* () {
      yield {
        type: 'result', subtype: 'error_during_execution', duration_ms: 19, duration_api_ms: 17,
        is_error: true, num_turns: 2, stop_reason: null, total_cost_usd: 0.000123,
        usage: {
          input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
          output_tokens: 0, server_tool_use: null, service_tier: null,
        },
        modelUsage: {}, permission_denials: [], errors: ['password=ScoringAgentAcceptanceSecret'],
        uuid: '00000000-0000-4000-8000-000000000012', session_id: 'failed-scoring-session',
      } as unknown as SDKMessage
    })()
    const failed: { error?: Error & { retryable?: boolean; leadRunMetrics?: Record<string, unknown> } } = {}
    try {
      await runLeadScoringAgent({
        systemPrompt: 'Return JSON.', prompt: 'score', outputSchema: { type: 'object' },
      }, { queryFactory: failFactory, workDir, timeoutMs: 5_000 })
    } catch (error) { failed.error = error as typeof failed.error }
    check(Boolean(failed.error)
      && failed.error?.retryable === true
      && !failed.error.message.includes('ScoringAgentAcceptanceSecret')
      && failed.error.leadRunMetrics?.toolCalls === 0,
    'scoring-agent-failure-is-redacted-retryable-and-audited-with-zero-tools', failed.error)

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
