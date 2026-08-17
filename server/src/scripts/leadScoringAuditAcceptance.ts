import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { leads } from '../db/schema.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  scoreWithAgentDetailed,
  type LeadScoringAgentRunner,
} from '../services/inProcessAiWorkflowService.js'
import {
  prepareLeadScoringAuditContext,
  prepareProjectScoringAuditContext,
} from '../services/leadScoringPipelineService.js'

const rawTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_raw_events'))
const itemsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_items'))
const transitionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_transitions'))
const promptTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_prompt_versions'))
const runsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_runs'))
const decisionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_decisions'))
const evidenceTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_evidence'))
const reviewsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_reviews'))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))

const checks: string[] = []
function check(condition: unknown, name: string, detail?: unknown) {
  assert.ok(condition, detail == null ? name : `${name}: ${JSON.stringify(detail)}`)
  checks.push(name)
}

type Standard = {
  dimensions: Array<{
    key: string
    name: string
    max: number
    items?: Array<{ key: string; name: string; max: number }>
  }>
}

function outputFor(standard: Standard, modelTotal = 1) {
  return {
    total: modelTotal,
    verdict: '模型原始结论将由宿主覆盖',
    overall_comment: '基于已入库资料逐项评分，宿主重新聚合总分。',
    dimensions: standard.dimensions.map((dimension) => ({
      key: dimension.key,
      name: `模型名称-${dimension.key}`,
      score: dimension.max,
      max: 100,
      items: (dimension.items || []).map((item) => ({
        key: item.key,
        name: `模型名称-${item.key}`,
        score: item.max,
        max: 100,
        reason: `已入库资料支持 ${item.name} 的验收满分夹具。`,
      })),
    })),
    competitors: [] as Array<Record<string, unknown>>,
    highlights: ['已完成结构化评分'],
    risks: ['验收夹具风险'],
    next_actions: ['核验评分证据'],
  }
}

async function main() {
  await ensureSchema()
  const suffix = randomUUID()
  const projectLeadId = randomUUID()
  const paperLeadId = randomUUID()
  const failedLeadId = randomUUID()
  const projectEntityId = randomUUID()
  let projectEntityAuditEventId: string | null = null
  const leadIds = [projectLeadId, paperLeadId, failedLeadId]
  const projectModel = `scoring-project-acceptance-${suffix}`
  const paperModel = `scoring-paper-acceptance-${suffix}`
  const failedPrimary = `scoring-failed-primary-${suffix}`
  const failedFallback = `scoring-failed-fallback-${suffix}`
  await db.insert(leads).values([{
    id: projectLeadId, name: `评分星科技-${suffix}`, source: 'lead-scoring-audit-acceptance', poolStatus: '成功',
  }, {
    id: paperLeadId, name: `评分论文-${suffix}`, source: 'lead-scoring-audit-acceptance', poolStatus: '成功',
  }, {
    id: failedLeadId, name: `评分失败项目-${suffix}`, source: 'lead-scoring-audit-acceptance', poolStatus: '成功',
  }])

  try {
    const projectStandard = JSON.parse(await readFile(
      path.resolve(process.cwd(), 'server/assets/ai/scoring_standard.json'), 'utf8',
    )) as Standard
    const paperStandard: Standard = {
      dimensions: [
        { key: 'tech_strength', name: '技术实力/创新性', max: 30 },
        { key: 'landing', name: '技术落地可能性', max: 28 },
        { key: 'market', name: '市场空间', max: 20 },
        { key: 'academic', name: '学者/团队学术背景', max: 12 },
        { key: 'commercialization', name: '过往商业化经验', max: 10 },
      ],
    }
    const projectInput = {
      projectName: `评分星科技-${suffix}`,
      summary: '评分星科技已完成样机验证并获得客户订单。',
      sources: ['验收来源｜https://example.invalid/project'],
    }
    const paperInput = {
      projectName: `评分论文-${suffix}`,
      title: `评分论文-${suffix}`,
      abstract: '论文提出新方法并报告完整实验，但商业化信息仍需后续核验。',
      sources: ['arXiv 验收来源｜https://example.invalid/paper'],
    }
    const projectAudit = await prepareLeadScoringAuditContext({
      leadId: projectLeadId, workflow: 'score-project', scoringInput: projectInput, queueAttempt: 1,
    })
    const paperAudit = await prepareLeadScoringAuditContext({
      leadId: paperLeadId, workflow: 'score-paper', scoringInput: paperInput, queueAttempt: 1,
    })
    check(projectAudit.eventIds[0] === projectAudit.inputEventId
      && paperAudit.eventIds[0] === paperAudit.inputEventId,
    'immutable-scoring-input-snapshot-is-primary-audit-event')
    const projectEntityAudit = await prepareProjectScoringAuditContext({
      projectId: projectEntityId, scoringInput: projectInput, queueAttempt: 1,
    })
    projectEntityAuditEventId = projectEntityAudit.inputEventId
    const [projectEntityItems] = await pool.query<Array<RowDataPacket & {
      source_type: string
      status: string
      lead_id: string | null
    }>>(
      `SELECT r.source_type,i.status,i.lead_id FROM ${itemsTable} i
       JOIN ${rawTable} r ON r.id=i.event_id WHERE i.event_id=?`,
      [projectEntityAudit.inputEventId],
    )
    check(projectEntityItems.length === 1
      && projectEntityItems[0].source_type === 'project-scoring-input'
      && projectEntityItems[0].status === 'discovered'
      && projectEntityItems[0].lead_id === null,
    'project-scoring-input-is-immutable-without-entering-lead-only-ready-state', projectEntityItems)

    const successfulRunner = (output: unknown): LeadScoringAgentRunner => async () => ({
      output,
      runtime: 'claude-agent-sdk',
      usage: { inputTokens: 500, outputTokens: 120, totalTokens: 620 },
      durationMs: 73,
      costMicrousd: 4_567,
      toolCalls: 0,
      numTurns: 2,
      sessionId: `scoring-session-${suffix}`,
    })
    const projectOutput = outputFor(projectStandard)
    projectOutput.competitors = [{
      name: '模型虚构竞品', tech: '未知', product: '未知', funding: '未知', differentiation: '未知',
      is_self: false, evidence: '模型虚构竞品与评分星科技竞争', verificationStatus: 'evidence-backed',
    }]
    const project = await scoreWithAgentDetailed('score-project', projectInput, {
      primaryModel: projectModel,
      fallbackModel: projectModel,
      audit: projectAudit,
      agentRunner: successfulRunner(projectOutput),
    })
    const paper = await scoreWithAgentDetailed('score-paper', paperInput, {
      primaryModel: paperModel,
      fallbackModel: paperModel,
      audit: paperAudit,
      agentRunner: successfulRunner(outputFor(paperStandard)),
    })
    check(project.result.total === 100
      && project.result.verdict === '强烈推荐'
      && project.result.dimensions.length === 7
      && project.result.dimensions.every((dimension) => dimension.items.length > 0)
      && (project.result.competitors?.[0] as { verificationStatus?: string }).verificationStatus === 'unverified',
    'project-seven-dimension-score-is-host-normalized-from-standard', project.result)
    check(paper.result.total === 100
      && paper.result.verdict === '强烈推荐'
      && paper.result.dimensions.length === 5
      && paper.result.dimensions.every((dimension) => dimension.items.length === 0),
    'paper-five-dimension-score-is-routed-without-company-financing-requirement', paper.result)

    const failedInput = {
      projectName: `评分失败项目-${suffix}`,
      summary: '用于验证 Agent 失败、模型回退和敏感信息脱敏。',
    }
    const failedAudit = await prepareLeadScoringAuditContext({
      leadId: failedLeadId, workflow: 'score-project', scoringInput: failedInput, queueAttempt: 2,
    })
    let failureCalls = 0
    const failedRunner: LeadScoringAgentRunner = async () => {
      failureCalls += 1
      const error = new Error('password=LeadScoringAuditSecret') as Error & {
        retryable?: boolean
        leadRunMetrics?: Record<string, unknown>
      }
      error.retryable = true
      error.leadRunMetrics = {
        runtime: 'claude-agent-sdk',
        usage: { inputTokens: 9, outputTokens: 0, totalTokens: 9 },
        durationMs: 21,
        costMicrousd: 123,
        toolCalls: 0,
        numTurns: 2,
        sessionId: `failed-scoring-session-${suffix}`,
      }
      throw error
    }
    await assert.rejects(() => scoreWithAgentDetailed('score-project', failedInput, {
      primaryModel: failedPrimary,
      fallbackModel: failedFallback,
      audit: failedAudit,
      agentRunner: failedRunner,
    }), /LeadScoringAuditSecret/)
    check(failureCalls === 2, 'retryable-primary-agent-failure-runs-one-configured-fallback-model')

    const [runRows] = await pool.query<Array<RowDataPacket & {
      id: string
      primary_event_id: string
      runtime: string
      agent_profile: string
      model: string
      status: string
      input_tokens: number
      output_tokens: number
      total_tokens: number
      tool_calls: number
      duration_ms: number
      cost_microusd: number
      error: string | null
    }>>(
      `SELECT * FROM ${runsTable} WHERE model IN (?,?,?,?) ORDER BY created_at,id`,
      [projectModel, paperModel, failedPrimary, failedFallback],
    )
    check(runRows.length === 4
      && runRows.filter((row) => row.status === 'succeeded').length === 2
      && runRows.filter((row) => row.status === 'failed').length === 2
      && runRows.every((row) => row.runtime === 'claude-agent-sdk'
        && row.agent_profile === 'lead-scoring-agent'
        && Number(row.tool_calls) === 0),
    'project-paper-success-and-fallback-failure-runs-use-agent-sdk-zero-tools', runRows)
    check(runRows.filter((row) => row.status === 'succeeded').every((row) =>
      Number(row.input_tokens) === 500 && Number(row.output_tokens) === 120
      && Number(row.total_tokens) === 620 && Number(row.duration_ms) === 73
      && Number(row.cost_microusd) === 4_567),
    'successful-scoring-runs-persist-token-duration-and-cost-metrics')
    check(runRows.filter((row) => row.status === 'failed').every((row) =>
      Number(row.input_tokens) === 9 && Number(row.tool_calls) === 0
      && Number(row.duration_ms) === 21 && Number(row.cost_microusd) === 123
      && !String(row.error).includes('LeadScoringAuditSecret')),
    'failed-scoring-runs-persist-redacted-error-and-sdk-metrics')

    const eventIds = [projectAudit.inputEventId, paperAudit.inputEventId, failedAudit.inputEventId]
    const placeholders = eventIds.map(() => '?').join(',')
    const [itemRows] = await pool.query<Array<RowDataPacket & {
      event_id: string
      source_type: string
      status: string
      lead_id: string
    }>>(
      `SELECT i.event_id,r.source_type,i.status,i.lead_id
       FROM ${itemsTable} i JOIN ${rawTable} r ON r.id=i.event_id
       WHERE i.event_id IN (${placeholders})`, eventIds,
    )
    check(itemRows.length === 3
      && itemRows.every((row) => row.source_type === 'lead-scoring-input' && row.status === 'ready')
      && new Set(itemRows.map((row) => row.lead_id)).size === 3,
    'scoring-input-events-are-ready-and-linked-to-formal-leads', itemRows)

    const [decisionRows] = await pool.query<Array<RowDataPacket & {
      run_id: string
      event_id: string
      decision_type: string
      outcome: string
      subject_name: string
      reason: string
    }>>(
      `SELECT d.* FROM ${decisionsTable} d JOIN ${runsTable} r ON r.id=d.run_id
       WHERE r.model IN (?,?,?,?)`, [projectModel, paperModel, failedPrimary, failedFallback],
    )
    check(decisionRows.length === 4
      && decisionRows.some((row) => row.decision_type === 'project_scoring' && row.outcome === 'accept')
      && decisionRows.some((row) => row.decision_type === 'paper_scoring' && row.outcome === 'accept')
      && decisionRows.filter((row) => row.outcome === 'failed').length === 2
      && decisionRows.every((row) => !row.reason.includes('LeadScoringAuditSecret')),
    'scoring-decisions-persist-project-paper-outcomes-and-redacted-failures', decisionRows)
    const [evidenceRows] = await pool.query<Array<RowDataPacket & {
      event_id: string
      source_type: string
      verification_status: string
      quote: string
    }>>(
      `SELECT e.* FROM ${evidenceTable} e JOIN ${decisionsTable} d ON d.id=e.decision_id
       JOIN ${runsTable} r ON r.id=d.run_id WHERE r.model IN (?,?)`, [projectModel, paperModel],
    )
    check(evidenceRows.length === 2
      && evidenceRows.every((row) => row.source_type === 'lead-scoring-input'
        && row.verification_status === 'verified' && row.quote.length > 0),
    'successful-scoring-decisions-bind-point-of-decision-input-evidence', evidenceRows)

    const [promptRows] = await pool.query<Array<RowDataPacket & { prompt_version: string }>>(
      `SELECT prompt_version FROM ${promptTable} WHERE agent_profile='lead-scoring-agent'`,
    )
    check(promptRows.some((row) => row.prompt_version.startsWith('score-project-'))
      && promptRows.some((row) => row.prompt_version.startsWith('score-paper-')),
    'project-and-paper-scoring-prompt-standard-schema-toolset-versions-registered', promptRows)

    console.log(JSON.stringify({ ok: true, checks, count: checks.length }))
  } finally {
    const [eventRows] = await pool.query<Array<RowDataPacket & { event_id: string }>>(
      `SELECT event_id FROM ${itemsTable} WHERE lead_id IN (?,?,?)`, leadIds,
    )
    const eventIds = eventRows.map((row) => row.event_id)
    if (eventIds.length) {
      const placeholders = eventIds.map(() => '?').join(',')
      await pool.query(`DELETE FROM ${reviewsTable} WHERE event_id IN (${placeholders})`, eventIds)
      await pool.query(`DELETE FROM ${evidenceTable} WHERE event_id IN (${placeholders})`, eventIds)
      await pool.query(`DELETE FROM ${decisionsTable} WHERE event_id IN (${placeholders}) AND parent_decision_id IS NOT NULL`, eventIds)
      await pool.query(`DELETE FROM ${decisionsTable} WHERE event_id IN (${placeholders})`, eventIds)
      await pool.query(`DELETE FROM ${runsTable} WHERE primary_event_id IN (${placeholders})`, eventIds)
      await pool.query(`DELETE FROM ${transitionsTable} WHERE event_id IN (${placeholders})`, eventIds)
      await pool.query(`DELETE FROM ${itemsTable} WHERE event_id IN (${placeholders})`, eventIds)
      await pool.query(`DELETE FROM ${rawTable} WHERE id IN (${placeholders})`, eventIds)
    }
    if (projectEntityAuditEventId) {
      await pool.query(`DELETE FROM ${transitionsTable} WHERE event_id=?`, [projectEntityAuditEventId])
      await pool.query(`DELETE FROM ${itemsTable} WHERE event_id=?`, [projectEntityAuditEventId])
      await pool.query(`DELETE FROM ${rawTable} WHERE id=?`, [projectEntityAuditEventId])
    }
    await pool.query(`DELETE FROM ${leadsTable} WHERE id IN (?,?,?)`, leadIds)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => await pool.end())
