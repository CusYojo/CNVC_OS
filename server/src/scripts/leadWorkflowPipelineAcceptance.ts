import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { recordLeadPipelineRawEvent } from '../services/leadPipelineEventService.js'
import { executeLeadWorkflowStage } from '../services/leadWorkflowPipelineService.js'
import type { LeadWorkflowAgentQueryFactory } from '../services/leadWorkflowAgentService.js'

const rawTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_raw_events'))
const itemsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_items'))
const transitionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_transitions'))
const promptsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_prompt_versions'))
const runsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_runs'))
const decisionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_decisions'))
const evidenceTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_evidence'))
const marker = `workflow-pipeline-acceptance-${randomUUID()}`
const checks: string[] = []
let eventId = ''

function successMessage(output: unknown): SDKMessage {
  return {
    type: 'result', subtype: 'success', duration_ms: 73, duration_api_ms: 70,
    is_error: false, num_turns: 2, result: JSON.stringify(output), stop_reason: 'end_turn',
    total_cost_usd: 0.004321,
    usage: {
      input_tokens: 600, cache_creation_input_tokens: 13, cache_read_input_tokens: 24,
      output_tokens: 97, server_tool_use: null, service_tier: null,
    },
    modelUsage: {}, permission_denials: [], structured_output: output,
    uuid: randomUUID(), session_id: `workflow-pipeline-${randomUUID()}`,
  } as unknown as SDKMessage
}

function successFactory(output: unknown): LeadWorkflowAgentQueryFactory {
  return () => (async function* () { yield successMessage(output) })()
}

async function count(table: string, where: string, values: unknown[]) {
  const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
    values,
  )
  return Number(rows[0]?.count || 0)
}

async function countDistinct(table: string, column: string, where: string, values: unknown[]) {
  if (!/^[a-z_]+$/.test(column)) throw new Error('unsafe distinct column')
  const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(DISTINCT ${column}) AS count FROM ${table} WHERE ${where}`,
    values,
  )
  return Number(rows[0]?.count || 0)
}

async function cleanup() {
  if (!eventId) return
  const [runRows] = await pool.query<Array<RowDataPacket & { id: string }>>(
    `SELECT id FROM ${runsTable} WHERE primary_event_id=?`, [eventId],
  )
  const runIds = runRows.map((row) => row.id)
  await pool.query(`DELETE e FROM ${evidenceTable} e JOIN ${decisionsTable} d ON d.id=e.decision_id WHERE d.event_id=?`, [eventId])
  await pool.query(`DELETE FROM ${decisionsTable} WHERE event_id=?`, [eventId])
  if (runIds.length) {
    await pool.query(`DELETE FROM ${runsTable} WHERE id IN (${runIds.map(() => '?').join(',')})`, runIds)
  }
  await pool.query(`DELETE FROM ${transitionsTable} WHERE event_id=?`, [eventId])
  await pool.query(`DELETE FROM ${itemsTable} WHERE event_id=?`, [eventId])
  await pool.query(`DELETE FROM ${rawTable} WHERE id=?`, [eventId])
}

async function main() {
  await ensureSchema()
  try {
    const raw = await recordLeadPipelineRawEvent({
      sourceType: 'workflow-agent-acceptance',
      sourceId: marker,
      payload: {
        subjectName: '星河科技',
        evidence: [
          { sourceId: 'raw-1', text: '星河科技于2025年完成A轮融资。' },
          { sourceId: 'raw-2', text: '星河科技总部位于北京市海淀区。' },
        ],
      },
    })
    eventId = raw.event.id

    const stages = [
      {
        profile: 'lead-research-agent' as const,
        prompt: '【sourceId=raw-1】原文：星河科技于2025年完成A轮融资。',
        output: {
          summary: '已形成融资事实包。',
          facts: [{
            claim: '星河科技完成A轮融资', quote: '星河科技于2025年完成A轮融资。',
            sourceId: 'raw-1', sourceUrl: 'https://example.com/raw-1', reliability: 'medium',
            verificationStatus: 'verified',
          }],
          conflicts: [], gaps: [],
        },
      },
      {
        profile: 'lead-screening-agent' as const,
        prompt: '【sourceId=raw-1】原文：星河科技于2025年完成A轮融资。',
        output: {
          decision: 'accept', reason: '主体与融资事件有连续原文证据。', confidence: 91,
          evidence: [{
            claim: '星河科技完成A轮融资', quote: '星河科技于2025年完成A轮融资。',
            sourceId: 'raw-1', sourceUrl: 'https://example.com/raw-1', reliability: 'medium',
            verificationStatus: 'verified',
          }], risks: [],
        },
      },
      {
        profile: 'lead-enrichment-agent' as const,
        prompt: '【existing】businessRegion为空。\n【sourceId=raw-2】原文：星河科技总部位于北京市海淀区。',
        output: {
          patches: [{
            field: 'businessRegion', operation: 'set_if_empty', value: '北京市',
            claim: '星河科技总部位于北京', quote: '星河科技总部位于北京市海淀区。', sourceId: 'raw-2',
          }], conflicts: [], gaps: [],
        },
      },
    ]

    for (const stage of stages) {
      await executeLeadWorkflowStage({
        profile: stage.profile,
        eventId,
        idempotencyKey: `${marker}:${stage.profile}`,
        prompt: stage.prompt,
        subjectType: 'company',
        subjectName: '星河科技',
        model: 'gpt-5.6-sol',
      }, { queryFactory: successFactory(stage.output), timeoutMs: 5_000 })
    }

    assert.equal(await countDistinct(
      promptsTable,
      'agent_profile',
      "agent_profile IN ('lead-research-agent','lead-screening-agent','lead-enrichment-agent') AND toolset_version='lead-research-host-tools-v1'",
      [],
    ), 3)
    checks.push('three-workflow-profile-version-contracts-registered-immutably')
    assert.equal(await count(runsTable, "primary_event_id=? AND status='succeeded' AND runtime='claude-agent-sdk' AND model='gpt-5.6-sol' AND tool_calls=0", [eventId]), 3)
    checks.push('three-workflow-agent-runs-bind-event-model-metrics-and-zero-tools')
    assert.equal(await count(decisionsTable, "event_id=? AND decision_type IN ('research','screening','enrichment') AND outcome='accept'", [eventId]), 3)
    assert.equal(await count(evidenceTable, 'event_id=?', [eventId]), 3)
    checks.push('submit-lead-decision-stages-three-evidence-bound-outputs-without-formal-write')

    const replay = await executeLeadWorkflowStage({
      profile: stages[0].profile,
      eventId,
      idempotencyKey: `${marker}:${stages[0].profile}`,
      prompt: stages[0].prompt,
      subjectType: 'company',
      subjectName: '星河科技',
      model: 'gpt-5.6-sol',
    }, {
      queryFactory: () => (async function* () {
        throw new Error('replayed workflow run must not call the model again')
        yield successMessage(stages[0].output)
      })(),
      timeoutMs: 5_000,
    })
    assert.equal(replay.replayed, true)
    assert.equal(replay.execution, null)
    assert.equal(await count(runsTable, "primary_event_id=? AND status='succeeded'", [eventId]), 3)
    checks.push('completed-workflow-run-replay-does-not-call-model-or-duplicate-audit')

    const failFactory: LeadWorkflowAgentQueryFactory = () => (async function* () {
      yield {
        type: 'result', subtype: 'error_during_execution', duration_ms: 17, duration_api_ms: 16,
        is_error: true, num_turns: 2, stop_reason: null, total_cost_usd: 0.000123,
        usage: {
          input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
          output_tokens: 0, server_tool_use: null, service_tier: null,
        },
        modelUsage: {}, permission_denials: [], errors: ['password=WorkflowPipelineAcceptanceSecret'],
        uuid: randomUUID(), session_id: 'failed-workflow-pipeline-session',
      } as unknown as SDKMessage
    })()
    await assert.rejects(() => executeLeadWorkflowStage({
      profile: 'lead-research-agent',
      eventId,
      idempotencyKey: `${marker}:failed-research`,
      prompt: stages[0].prompt,
      subjectType: 'company',
      subjectName: '星河科技',
      model: 'gpt-5.6-sol',
    }, { queryFactory: failFactory, timeoutMs: 5_000 }))
    assert.equal(await count(runsTable, "primary_event_id=? AND status='failed' AND error NOT LIKE '%WorkflowPipelineAcceptanceSecret%'", [eventId]), 1)
    assert.equal(await count(decisionsTable, "event_id=? AND decision_type='research' AND outcome='failed'", [eventId]), 1)
    checks.push('failed-workflow-run-and-decision-are-redacted-and-preserved')

    console.log(JSON.stringify({ ok: true, checks, count: checks.length }))
  } finally {
    await cleanup()
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => await pool.end())
