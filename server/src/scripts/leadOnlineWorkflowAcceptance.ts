import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { RowDataPacket } from 'mysql2'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { leads } from '../db/schema.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { recordLeadPipelineRawEvent } from '../services/leadPipelineEventService.js'
import {
  evaluateRadarIntakeWorkflow,
  runRadarIntakeAgents,
  runPublicIntelEnrichmentAgents,
  runPublicIntelIntakeAgents,
} from '../services/leadOnlineWorkflowService.js'
import type { LeadWorkflowAgentQueryFactory } from '../services/leadWorkflowAgentService.js'
import type { PublicIntelResult } from '../services/leadPublicIntelService.js'
import {
  LEAD_RESEARCH_HOST_TOOLS,
  LEAD_RESEARCH_HOST_TOOLSET_VERSION,
} from '../services/leadResearchToolService.js'

const rawTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_raw_events'))
const itemsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_items'))
const transitionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_transitions'))
const runsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_runs'))
const decisionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_decisions'))
const evidenceTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_evidence'))
const reviewsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_reviews'))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const marker = `online-workflow-acceptance-${randomUUID()}`
const leadId = randomUUID()
let eventId = ''
const eventIds: string[] = []
const checks: string[] = []

function successMessage(output: unknown): SDKMessage {
  return {
    type: 'result', subtype: 'success', duration_ms: 44, duration_api_ms: 42,
    is_error: false, num_turns: 2, result: JSON.stringify(output), stop_reason: 'end_turn',
    total_cost_usd: 0.001111,
    usage: {
      input_tokens: 200, cache_creation_input_tokens: 5, cache_read_input_tokens: 6,
      output_tokens: 50, server_tool_use: null, service_tier: null,
    },
    modelUsage: {}, permission_denials: [], structured_output: output,
    uuid: randomUUID(), session_id: `online-workflow-${randomUUID()}`,
  } as unknown as SDKMessage
}

function factory(output: unknown, counter: { calls: number }): LeadWorkflowAgentQueryFactory {
  return () => (async function* () {
    counter.calls += 1
    yield successMessage(output)
  })()
}

async function count(table: string, where: string, values: unknown[]) {
  const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
    values,
  )
  return Number(rows[0]?.count || 0)
}

async function cleanup() {
  for (const id of eventIds) {
    await pool.query(`DELETE e FROM ${evidenceTable} e JOIN ${decisionsTable} d ON d.id=e.decision_id WHERE d.event_id=?`, [id])
    await pool.query(`DELETE FROM ${reviewsTable} WHERE event_id=?`, [id])
    await pool.query(`DELETE FROM ${decisionsTable} WHERE event_id=?`, [id])
    await pool.query(`DELETE FROM ${runsTable} WHERE primary_event_id=?`, [id])
    await pool.query(`DELETE FROM ${transitionsTable} WHERE event_id=?`, [id])
    await pool.query(`DELETE FROM ${itemsTable} WHERE event_id=?`, [id])
    await pool.query(`DELETE FROM ${rawTable} WHERE id=?`, [id])
  }
  await pool.query(`DELETE FROM ${leadsTable} WHERE id=?`, [leadId])
}

async function main() {
  await ensureSchema()
  try {
    await db.insert(leads).values({
      id: leadId,
      name: `在线编排验收公司-${marker}`.slice(0, 128),
      companyName: `在线编排验收公司-${marker}`.slice(0, 128),
      source: 'online-workflow-acceptance',
      poolStatus: '成功',
      summary: '人工已有摘要，不得被覆盖。',
      sources: [{
        title: '已有来源',
        url: `https://example.com/${marker}/existing`,
        excerpt: '在线编排验收公司已有一条人工核验来源。',
        reliability: '高',
      }],
    })
    const raw = await recordLeadPipelineRawEvent({
      sourceType: 'public-intel',
      sourceId: marker,
      payload: {
        title: '在线研究编排验收',
        summary: '在线编排验收公司于2025年完成A轮融资。',
      },
    })
    eventId = raw.event.id
    eventIds.push(eventId)
    const company = `在线编排验收公司-${marker}`.slice(0, 128)
    const intel: PublicIntelResult = {
      positioning: '公开来源显示公司完成A轮融资。',
      registeredCapital: '待核验', legalRepresentative: '待核验', foundedAt: '待核验',
      region: '北京市', registeredAddress: '北京市海淀区',
      fundingRounds: [], shareholders: [], competitors: [], companyNews: [],
      sources: [{ title: '公开来源', url: `https://example.com/${marker}/public`, reliability: '中' }],
      searchEvidence: [{
        query: company,
        title: '融资报道',
        snippet: '在线编排验收公司于2025年完成A轮融资。',
        url: `https://example.com/${marker}/public`,
        reliability: '公开搜索结果摘要，需访问原始页面核验',
      }],
      confidence: 0.8,
      fetchedAt: '2026-08-09T14:00:00+08:00',
    }
    const quote = '在线编排验收公司于2025年完成A轮融资。'
    const publicSourceUrl = intel.searchEvidence?.[0]?.url
    assert.ok(publicSourceUrl)
    const publicSourceId = `public-search:0:${publicSourceUrl}`
    const researchOutput = {
      summary: '形成一条融资事实。',
      facts: [{
        claim: '公司完成A轮融资', quote, sourceId: publicSourceId, sourceUrl: publicSourceUrl,
        reliability: 'medium', verificationStatus: 'verified',
      }], conflicts: [], gaps: [],
    }
    const screeningOutput = {
      decision: 'accept', reason: '主体与融资事实有连续原文证据。', confidence: 90,
      evidence: [{
        claim: '公司完成A轮融资', quote, sourceId: publicSourceId, sourceUrl: publicSourceUrl,
        reliability: 'medium', verificationStatus: 'verified',
      }], risks: [],
    }
    const enrichmentOutput = {
      patches: [{
        field: 'fundingRounds', operation: 'append_unique', value: [{ round: 'A轮', date: '2025年' }],
        claim: '公司完成A轮融资', quote, sourceId: publicSourceId,
      }], conflicts: [], gaps: [],
    }
    const calls = { research: 0, screening: 0, enrichment: 0, replayResearch: 0, radarResearch: 0, radarScreening: 0 }
    const intake = await runPublicIntelIntakeAgents({ eventId, company, intel, model: 'gpt-5.6-sol' }, {
      researchQueryFactory: factory(researchOutput, { get calls() { return calls.research }, set calls(value) { calls.research = value } }),
      screeningQueryFactory: factory(screeningOutput, { get calls() { return calls.screening }, set calls(value) { calls.screening = value } }),
    })
    assert.deepEqual(intake.host.allowedTools, [...LEAD_RESEARCH_HOST_TOOLS])
    assert.equal(intake.host.contractVersion, LEAD_RESEARCH_HOST_TOOLSET_VERSION)
    assert.equal(intake.host.hostToolCalls, 3)
    assert.ok(intake.host.sources.some((source) => source.sourceType === 'public-search'))
    checks.push('host-toolset-reads-immutable-event-public-search-and-source-snippets')

    const enrichment = await runPublicIntelEnrichmentAgents({ eventId, leadId, company, intel, model: 'gpt-5.6-sol' }, {
      researchQueryFactory: factory(researchOutput, { get calls() { return calls.replayResearch }, set calls(value) { calls.replayResearch = value } }),
      enrichmentQueryFactory: factory(enrichmentOutput, { get calls() { return calls.enrichment }, set calls(value) { calls.enrichment = value } }),
    })
    assert.equal(enrichment.host.hostToolCalls, 4)
    assert.equal(enrichment.host.existingLead?.id, leadId)
    assert.equal(calls.research, 1)
    assert.equal(calls.screening, 1)
    assert.equal(calls.replayResearch, 1)
    assert.equal(calls.enrichment, 1)
    checks.push('online-intake-and-enrichment-use-scope-specific-research-runs')

    assert.equal(intake.screening.decision.outcome, 'accept')
    assert.equal(enrichment.enrichment.decision.outcome, 'accept')
    assert.equal(await count(runsTable, "primary_event_id=? AND status='succeeded'", [eventId]), 4)
    assert.equal(await count(runsTable, 'primary_event_id=? AND tool_calls=3', [eventId]), 1)
    assert.equal(await count(runsTable, 'primary_event_id=? AND tool_calls=4', [eventId]), 1)
    assert.equal(await count(decisionsTable, "event_id=? AND decision_type IN ('research','screening','enrichment')", [eventId]), 4)
    checks.push('online-stages-persist-versioned-runs-host-tool-counts-decisions-and-evidence')

    const radar = await runRadarIntakeAgents({
      eventId,
      subjectType: 'project',
      subjectName: company,
      providedPublicIntel: intel,
      model: 'gpt-5.6-sol',
    }, {
      researchQueryFactory: factory(researchOutput, { get calls() { return calls.radarResearch }, set calls(value) { calls.radarResearch = value } }),
      screeningQueryFactory: factory(screeningOutput, { get calls() { return calls.radarScreening }, set calls(value) { calls.radarScreening = value } }),
    })
    assert.equal(radar.screening.decision.outcome, 'accept')
    assert.equal(radar.screening.decision.subjectType, 'project')
    assert.equal(radar.host.hostToolCalls, 2)
    assert.equal(calls.radarResearch, 1)
    assert.equal(calls.radarScreening, 1)
    assert.equal(await count(runsTable, "primary_event_id=? AND status='succeeded'", [eventId]), 6)
    assert.equal(await count(decisionsTable, "event_id=? AND decision_type IN ('research','screening','enrichment')", [eventId]), 6)
    checks.push('radar-intake-uses-scope-specific-research-and-screening-audit-chain')

    const reviewRaw = await recordLeadPipelineRawEvent({
      sourceType: 'radar', sourceId: `${marker}:review`,
      payload: { title: company, summary: quote },
    })
    eventIds.push(reviewRaw.event.id)
    const reviewResult = await evaluateRadarIntakeWorkflow({
      eventId: reviewRaw.event.id,
      subjectType: 'company',
      subjectName: company,
      providedPublicIntel: intel,
      subjectEvidence: [{ excerpt: quote }],
      subjectConfidence: 78,
      model: 'gpt-5.6-sol',
    }, {
      researchQueryFactory: factory(researchOutput, { calls: 0 }),
      screeningQueryFactory: factory({ ...screeningOutput, decision: 'review', reason: '证据需人工复核。', confidence: 62 }, { calls: 0 }),
    })
    assert.equal(reviewResult.status, 'review')
    assert.ok(reviewResult.reviewId)
    assert.equal(await count(itemsTable, "event_id=? AND status='review' AND lead_id IS NULL", [reviewRaw.event.id]), 1)
    assert.equal(await count(reviewsTable, "event_id=? AND status='pending'", [reviewRaw.event.id]), 1)

    const rejectRaw = await recordLeadPipelineRawEvent({
      sourceType: 'radar', sourceId: `${marker}:reject`,
      payload: { title: company, summary: quote },
    })
    eventIds.push(rejectRaw.event.id)
    const rejectResult = await evaluateRadarIntakeWorkflow({
      eventId: rejectRaw.event.id,
      subjectType: 'company',
      subjectName: company,
      providedPublicIntel: intel,
      model: 'gpt-5.6-sol',
    }, {
      researchQueryFactory: factory(researchOutput, { calls: 0 }),
      screeningQueryFactory: factory({ ...screeningOutput, decision: 'reject', reason: '不符合线索准入条件。', confidence: 85, evidence: [] }, { calls: 0 }),
    })
    assert.equal(rejectResult.status, 'reject')
    assert.equal(await count(itemsTable, "event_id=? AND status='rejected' AND lead_id IS NULL", [rejectRaw.event.id]), 1)
    assert.equal(await count(reviewsTable, 'event_id=?', [rejectRaw.event.id]), 0)

    const failedRaw = await recordLeadPipelineRawEvent({
      sourceType: 'radar', sourceId: `${marker}:failed`,
      payload: { title: company, summary: quote },
    })
    eventIds.push(failedRaw.event.id)
    const failureFactory: LeadWorkflowAgentQueryFactory = () => (async function* () {
      throw new Error('password=RadarWorkflowAcceptanceSecret')
      yield successMessage(researchOutput)
    })()
    const failedResult = await evaluateRadarIntakeWorkflow({
      eventId: failedRaw.event.id,
      subjectType: 'company',
      subjectName: company,
      providedPublicIntel: intel,
      model: 'gpt-5.6-sol',
    }, { researchQueryFactory: failureFactory })
    assert.equal(failedResult.status, 'failed')
    assert.ok(!failedResult.error?.includes('RadarWorkflowAcceptanceSecret'))
    assert.equal(await count(itemsTable, "event_id=? AND status='failed' AND lead_id IS NULL AND last_error NOT LIKE '%RadarWorkflowAcceptanceSecret%'", [failedRaw.event.id]), 1)
    const recoveredResult = await evaluateRadarIntakeWorkflow({
      eventId: failedRaw.event.id,
      subjectType: 'company',
      subjectName: company,
      providedPublicIntel: intel,
      attempt: 2,
      model: 'gpt-5.6-sol',
    }, {
      researchQueryFactory: factory(researchOutput, { calls: 0 }),
      screeningQueryFactory: factory(screeningOutput, { calls: 0 }),
    })
    assert.equal(recoveredResult.status, 'accept')
    assert.equal(await count(itemsTable, "event_id=? AND status='discovered' AND lead_id IS NULL", [failedRaw.event.id]), 1)
    assert.equal(await count(runsTable, "primary_event_id=? AND attempt=2 AND status='succeeded'", [failedRaw.event.id]), 2)

    const invalidRaw = await recordLeadPipelineRawEvent({
      sourceType: 'radar', sourceId: `${marker}:invalid-schema`,
      payload: { title: company, summary: quote },
    })
    eventIds.push(invalidRaw.event.id)
    const invalidResult = await evaluateRadarIntakeWorkflow({
      eventId: invalidRaw.event.id,
      subjectType: 'company',
      subjectName: company,
      providedPublicIntel: intel,
      model: 'gpt-5.6-sol',
    }, {
      researchQueryFactory: factory(researchOutput, { calls: 0 }),
      screeningQueryFactory: factory({
        decision: 'accept', reason: '非法无证据接受。', confidence: 99, evidence: [], risks: [],
      }, { calls: 0 }),
    })
    assert.equal(invalidResult.status, 'failed')
    assert.equal(await count(itemsTable, "event_id=? AND status='failed' AND lead_id IS NULL", [invalidRaw.event.id]), 1)
    assert.equal(await count(decisionsTable, "event_id=? AND decision_type='screening' AND outcome='failed'", [invalidRaw.event.id]), 1)
    assert.equal(await count(leadsTable, "source='online-workflow-acceptance'", []), 1)
    checks.push('radar-screening-review-reject-invalid-schema-failure-and-audited-retry-never-bypass-formal-lead-host')

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
