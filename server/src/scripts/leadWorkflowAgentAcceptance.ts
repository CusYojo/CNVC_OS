import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { pool } from '../db/client.js'
import {
  leadWorkflowAgentContract,
  runLeadWorkflowAgent,
  validateLeadWorkflowAgentOutput,
  type LeadWorkflowAgentProfile,
  type LeadWorkflowAgentQueryFactory,
} from '../services/leadWorkflowAgentService.js'
import { aiRuntimeTelemetrySnapshot, resetAiRuntimeTelemetryForAcceptance } from '../runtime/aiRuntimeTelemetry.js'

const checks: string[] = []
function check(condition: unknown, name: string, detail?: unknown) {
  assert.ok(condition, detail == null ? name : `${name}: ${JSON.stringify(detail)}`)
  checks.push(name)
}

function successMessage(output: unknown, sessionId: string): SDKMessage {
  return {
    type: 'result', subtype: 'success', duration_ms: 61, duration_api_ms: 59,
    is_error: false, num_turns: 2, result: JSON.stringify(output), stop_reason: 'end_turn',
    total_cost_usd: 0.003456,
    usage: {
      input_tokens: 500, cache_creation_input_tokens: 12, cache_read_input_tokens: 23,
      output_tokens: 89, server_tool_use: null, service_tier: null,
    },
    modelUsage: {}, permission_denials: [], structured_output: output,
    uuid: '00000000-0000-4000-8000-000000000021', session_id: sessionId,
  } as unknown as SDKMessage
}

function firstTokenMessage(sessionId: string): SDKMessage {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{' } },
    uuid: '00000000-0000-4000-8000-000000000020', session_id: sessionId,
  } as unknown as SDKMessage
}

const scenarios: Array<{
  profile: LeadWorkflowAgentProfile
  prompt: string
  output: unknown
}> = [
  {
    profile: 'lead-research-agent',
    prompt: '【sourceId=raw-1】原文：星河科技于2025年完成A轮融资。',
    output: {
      summary: '公开来源显示该主体完成A轮融资。',
      facts: [{
        claim: '星河科技于2025年完成A轮融资', quote: '星河科技于2025年完成A轮融资。',
        sourceId: 'raw-1', sourceUrl: 'https://example.com/raw-1', reliability: 'medium',
        verificationStatus: 'verified',
      }],
      conflicts: [], gaps: ['融资金额尚未披露'],
    },
  },
  {
    profile: 'lead-screening-agent',
    prompt: '【sourceId=raw-1】原文：星河科技于2025年完成A轮融资。',
    output: {
      decision: 'accept', reason: '主体和融资事件均有连续原文证据。', confidence: 92,
      evidence: [{
        claim: '星河科技完成A轮融资', quote: '星河科技于2025年完成A轮融资。',
        sourceId: 'raw-1', sourceUrl: 'https://example.com/raw-1', reliability: 'medium',
        verificationStatus: 'verified',
      }],
      risks: ['融资金额尚未披露'],
    },
  },
  {
    profile: 'lead-enrichment-agent',
    prompt: '【existing】businessRegion为空。\n【sourceId=raw-2】原文：星河科技总部位于北京市海淀区。',
    output: {
      patches: [{
        field: 'businessRegion', operation: 'set_if_empty', value: '北京市',
        claim: '星河科技总部位于北京', quote: '星河科技总部位于北京市海淀区。', sourceId: 'raw-2',
      }],
      conflicts: [], gaps: [],
    },
  },
]

async function main() {
  resetAiRuntimeTelemetryForAcceptance()
  const workDir = await mkdtemp(path.join(tmpdir(), 'lead-workflow-agent-acceptance-'))
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
  process.env.LLM_BASE_URL = 'https://workflow-agent-acceptance.invalid/api/v9'
  process.env.LLM_API_KEY = 'WorkflowAgentAcceptanceApiKey'
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_API_KEY
  process.env.DB_HOST = 'mysql.internal.invalid'
  process.env.DB_DATABASE = 'workflow_agent_must_not_see_database'
  process.env.DB_USERNAME = 'workflow_agent_must_not_see_username'
  process.env.DB_PASSWORD = 'WorkflowAgentMustNotSeePassword'
  process.env.DB_FREFIX = 'workflow_agent_must_not_see_prefix_'
  try {
    const contracts = scenarios.map(({ profile }) => leadWorkflowAgentContract(profile))
    check(new Set(contracts.map((item) => item.profileVersion)).size === 3
      && new Set(contracts.map((item) => item.schemaVersion)).size === 3
      && contracts.every((item) => item.toolsetVersion === 'lead-research-host-tools-v1'),
    'three-profiles-have-distinct-versioned-schema-contracts')

    const captured = new Map<LeadWorkflowAgentProfile, Parameters<typeof query>[0]>()
    for (const scenario of scenarios) {
      const factory: LeadWorkflowAgentQueryFactory = (params) => {
        captured.set(scenario.profile, params)
        return (async function* () {
          yield firstTokenMessage(`${scenario.profile}-acceptance-session`)
          yield successMessage(scenario.output, `${scenario.profile}-acceptance-session`)
        })()
      }
      const execution = await runLeadWorkflowAgent({
        profile: scenario.profile,
        prompt: scenario.prompt,
        model: 'workflow-agent-acceptance-model',
      }, { queryFactory: factory, workDir, timeoutMs: 5_000 })
      check(execution.profile === scenario.profile
        && execution.runtime === 'claude-agent-sdk'
        && execution.usage.inputTokens === 535
        && execution.usage.outputTokens === 89
        && execution.usage.totalTokens === 624
        && execution.durationMs === 61
        && execution.costMicrousd === 3_456
        && execution.toolCalls === 0
        && execution.numTurns === 2,
      `${scenario.profile}-returns-validated-output-and-exact-metrics`, execution)
    }
    const aiTelemetry = aiRuntimeTelemetrySnapshot()
    check(aiTelemetry.last24h.firstTokenObserved === 3
      && aiTelemetry.last24h.firstTokenUnavailable === 0,
    'three-workflow-agents-record-real-partial-message-first-token', aiTelemetry.last24h)

    check([...captured.values()].every(({ options }) =>
      options?.model === 'workflow-agent-acceptance-model'
      && Number(options.maxTurns) >= 1 && Number(options.maxTurns) <= 2
      && Number(options.maxBudgetUsd) > 0 && Number(options.maxBudgetUsd) <= 2
      && options.permissionMode === 'dontAsk'
      && options.persistSession === false
      && options.settingSources?.length === 0
      && Object.keys(options.mcpServers || {}).length === 0
      && options.plugins?.length === 0
      && Object.keys(options.agents || {}).length === 0
      && options.includePartialMessages === true),
    'all-workflow-profiles-enforce-model-turn-budget-and-runtime-isolation')

    check([...captured.values()].every(({ options }) =>
      Array.isArray(options?.tools) && options.tools.length === 0
      && Array.isArray(options.skills) && options.skills.length === 0
      && Array.isArray(options.allowedTools) && options.allowedTools.length === 0
      && ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Skill']
        .every((tool) => options.disallowedTools?.includes(tool))),
    'all-workflow-profiles-expose-no-built-in-tools-skills-or-subagents')

    check([...captured.values()].every(({ options }) => {
      const env = options?.env || {}
      return env.ANTHROPIC_BASE_URL === 'https://workflow-agent-acceptance.invalid/api/v9'
        && env.ANTHROPIC_API_KEY === 'WorkflowAgentAcceptanceApiKey'
        && env.DB_HOST === undefined && env.DB_DATABASE === undefined
        && env.DB_USERNAME === undefined && env.DB_PASSWORD === undefined && env.DB_FREFIX === undefined
        && env.OPENAI_API_KEY === undefined && env.LLM_API_KEY === undefined
    }), 'all-workflow-profiles-exclude-database-and-ambient-gateway-secrets')

    assert.throws(() => validateLeadWorkflowAgentOutput('lead-research-agent', {
      summary: '幻觉事实',
      facts: [{
        claim: '不存在的事实', quote: '这段引文不在宿主输入中', sourceId: 'raw-x', sourceUrl: '',
        reliability: 'unknown', verificationStatus: 'unverified',
      }],
      conflicts: [], gaps: [],
    }, '宿主输入只有另一段文字。'), /quote not found/)
    check(true, 'research-profile-rejects-quote-not-found-in-immutable-input')

    assert.throws(() => validateLeadWorkflowAgentOutput('lead-research-agent', {
      summary: '错误来源绑定',
      facts: [{
        claim: '乙来源事实', quote: '乙公司完成B轮融资。', sourceId: 'source-a', sourceUrl: '',
        reliability: 'medium', verificationStatus: 'verified',
      }],
      conflicts: [], gaps: [],
    }, '【sourceId=source-a】原文：甲公司完成A轮融资。\n【sourceId=source-b】原文：乙公司完成B轮融资。'), /not bound to declared sourceId/)
    check(true, 'research-profile-rejects-quote-bound-to-wrong-source-id')

    assert.throws(() => validateLeadWorkflowAgentOutput('lead-screening-agent', {
      decision: 'accept', reason: '没有证据仍接受', confidence: 99, evidence: [], risks: [],
    }, '宿主输入'), /accepted screening requires evidence/)
    check(true, 'screening-profile-rejects-accept-without-evidence')

    assert.throws(() => validateLeadWorkflowAgentOutput('lead-enrichment-agent', {
      patches: [{
        field: 'score', operation: 'set_if_empty', value: 100,
        claim: '越权写评分', quote: '宿主输入', sourceId: 'raw-1',
      }], conflicts: [], gaps: [],
    }, '宿主输入'), /Invalid option/)
    check(true, 'enrichment-profile-rejects-non-whitelisted-field')

    const denyFactory: LeadWorkflowAgentQueryFactory = (params) => (async function* () {
      await params.options?.canUseTool?.('Bash', { command: 'env' }, {
        signal: new AbortController().signal,
        toolUseID: 'forbidden-workflow-tool',
      })
      yield successMessage(scenarios[0].output, 'forbidden-workflow-session')
    })()
    await assert.rejects(() => runLeadWorkflowAgent({
      profile: 'lead-research-agent', prompt: scenarios[0].prompt,
    }, { queryFactory: denyFactory, workDir, timeoutMs: 5_000 }), /attempted forbidden tool: Bash/)
    check(true, 'workflow-agent-runtime-tool-request-is-denied-and-fails-closed')

    const failFactory: LeadWorkflowAgentQueryFactory = () => (async function* () {
      yield {
        type: 'result', subtype: 'error_during_execution', duration_ms: 21, duration_api_ms: 20,
        is_error: true, num_turns: 2, stop_reason: null, total_cost_usd: 0.000111,
        usage: {
          input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
          output_tokens: 0, server_tool_use: null, service_tier: null,
        },
        modelUsage: {}, permission_denials: [], errors: ['password=WorkflowAgentAcceptanceSecret'],
        uuid: '00000000-0000-4000-8000-000000000022', session_id: 'failed-workflow-session',
      } as unknown as SDKMessage
    })()
    const failed: { error?: Error & { retryable?: boolean; leadRunMetrics?: Record<string, unknown> } } = {}
    try {
      await runLeadWorkflowAgent({
        profile: 'lead-research-agent', prompt: scenarios[0].prompt,
      }, { queryFactory: failFactory, workDir, timeoutMs: 5_000 })
    } catch (error) { failed.error = error as typeof failed.error }
    check(Boolean(failed.error)
      && failed.error?.retryable === true
      && !failed.error.message.includes('WorkflowAgentAcceptanceSecret')
      && failed.error.leadRunMetrics?.toolCalls === 0,
    'workflow-agent-failure-is-redacted-retryable-and-metrics-preserved', failed.error)

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
