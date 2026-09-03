import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { listLeads } from '../services/aiSummaryService.js'
import {
  LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS,
  LEAD_ENRICHMENT_SCHEMA_VERSION,
} from '../services/leadEnrichmentContract.js'
import {
  planLeadDeepCollection,
  type LeadDeepCollectionPlan,
  type LeadDeepCollectionReason,
  type LeadDeepCollectionSnapshot,
} from '../services/leadDeepCollectionPlan.js'
import { enqueueLeadEnrichmentJob } from '../services/leadEnrichmentService.js'

type SnapshotRow = RowDataPacket & {
  id: string
  lead_id: string
  status: string
  topic_states: unknown
  coverage: number
  created_at: Date
}

const args = process.argv.slice(2)
const applying = args.includes('--apply')
const reporting = args.includes('--report')
const force = args.includes('--force')
const retryGaps = args.includes('--retry-gaps')
const companyOnly = args.includes('--company-only')

function option(name: string, fallback = '') {
  const prefix = `--${name}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim() || fallback
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = option(name)
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

const batchId = option('batch-id')
const requestedLeadIds = [...new Set(option('lead-ids').split(',').map((value) => value.trim()).filter(Boolean))]
const limit = boundedInteger('limit', applying ? 50 : 10_000, 1, 10_000)
const maxAgeDays = boundedInteger('max-age-days', 30, 0, 3_650)
const enqueueConcurrency = boundedInteger('concurrency', 4, 1, 8)
const workerConcurrency = boundedInteger('worker-concurrency', 4, 1, 10)

if (batchId && !/^[A-Za-z0-9._-]{1,28}$/.test(batchId)) {
  throw new Error('--batch-id must be 1-28 safe characters so trigger_type stays lossless')
}
if (requestedLeadIds.length > 100) throw new Error('--lead-ids accepts at most 100 explicit IDs')
if (requestedLeadIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id))) {
  throw new Error('--lead-ids contains an invalid UUID')
}
if (applying && !batchId) throw new Error('--apply requires --batch-id=<stable-id> for idempotent resume')
if (reporting && !batchId) throw new Error('--report requires --batch-id=<stable-id>')
if (applying && reporting) throw new Error('--apply and --report are mutually exclusive')
if (applying && force && !requestedLeadIds.length) {
  throw new Error('--force --apply requires explicit --lead-ids; refusing to refresh the entire visible pool')
}

const jobsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_jobs'))
const topicRunsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_topic_runs'))
const snapshotsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_snapshots'))
const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))

async function visibleLeads() {
  const first = await listLeads({ page: 1, pageSize: 100 })
  const items = first.list.map((lead) => ({
    id: lead.id, name: lead.name, leadType: lead.leadType, poolEnteredAt: lead.poolEnteredAt,
  }))
  for (let page = 2; page <= first.totalPages; page += 1) {
    const current = await listLeads({ page, pageSize: 100 })
    items.push(...current.list.map((lead) => ({
      id: lead.id, name: lead.name, leadType: lead.leadType, poolEnteredAt: lead.poolEnteredAt,
    })))
  }
  return [...new Map(items.map((lead) => [lead.id, lead])).values()]
}

function reasonPriority(plan: LeadDeepCollectionPlan) {
  if (plan.reasons.includes('no_current_snapshot')) return 0
  if (plan.reasons.includes('snapshot_has_gaps')) return 1
  if (plan.reasons.includes('snapshot_stale')) return 2
  return 3
}

async function reportBatch(triggerType: string) {
  const [[jobRows], [topicRows], [snapshotRows]] = await Promise.all([
    pool.query<Array<RowDataPacket & { status: string; count: number }>>(
      `SELECT status,COUNT(*) count FROM ${jobsTable}
       WHERE schema_version=? AND trigger_type=? GROUP BY status ORDER BY status`,
      [LEAD_ENRICHMENT_SCHEMA_VERSION, triggerType],
    ),
    pool.query<Array<RowDataPacket & { status: string; count: number }>>(
      `SELECT tr.status,COUNT(*) count FROM ${topicRunsTable} tr
       JOIN ${jobsTable} j ON j.id=tr.job_id
       WHERE j.schema_version=? AND j.trigger_type=? GROUP BY tr.status ORDER BY tr.status`,
      [LEAD_ENRICHMENT_SCHEMA_VERSION, triggerType],
    ),
    pool.query<Array<RowDataPacket & { count: number; average_coverage: number | null }>>(
      `SELECT COUNT(*) count,ROUND(AVG(s.coverage),2) average_coverage
       FROM ${snapshotsTable} s JOIN ${jobsTable} j ON j.id=s.job_id
       WHERE j.schema_version=? AND j.trigger_type=?`,
      [LEAD_ENRICHMENT_SCHEMA_VERSION, triggerType],
    ),
  ])
  const jobs = Object.fromEntries(jobRows.map((row) => [row.status, Number(row.count)]))
  const topics = Object.fromEntries(topicRows.map((row) => [row.status, Number(row.count)]))
  console.log(JSON.stringify({
    ok: true,
    mode: 'report',
    batchId,
    triggerType,
    schemaVersion: LEAD_ENRICHMENT_SCHEMA_VERSION,
    jobs,
    topics,
    snapshots: Number(snapshotRows[0]?.count || 0),
    averageCoverage: snapshotRows[0]?.average_coverage === null
      ? null
      : Number(snapshotRows[0]?.average_coverage || 0),
  }, null, 2))
}

async function main() {
  const triggerType = batchId ? `deep-collect:${batchId}` : null
  if (reporting) return await reportBatch(triggerType!)

  const allVisibleLeads = (await visibleLeads()).filter((lead) => !companyOnly || lead.leadType === 'company')
  const allVisibleIds = allVisibleLeads.map((lead) => lead.id)
  const leadNameById = new Map(allVisibleLeads.map((lead) => [lead.id, lead.name]))
  const leadEnteredAtById = new Map(allVisibleLeads.map((lead) => [lead.id, lead.poolEnteredAt]))
  const visibleIdSet = new Set(allVisibleIds)
  const scopedIds = requestedLeadIds.length
    ? requestedLeadIds.filter((leadId) => visibleIdSet.has(leadId))
    : allVisibleIds
  const requestedButNotVisible = requestedLeadIds.filter((leadId) => !visibleIdSet.has(leadId))
  if (applying && requestedButNotVisible.length) {
    throw new Error(`requested lead ids are not visible: ${requestedButNotVisible.join(',')}`)
  }

  const latestSnapshots = new Map<string, LeadDeepCollectionSnapshot>()
  const activeLeadIds = new Set<string>()
  for (let offset = 0; offset < scopedIds.length; offset += 500) {
    const chunk = scopedIds.slice(offset, offset + 500)
    if (!chunk.length) continue
    const placeholders = chunk.map(() => '?').join(',')
    const [snapshotRows] = await pool.query<SnapshotRow[]>(
      `SELECT id,lead_id,status,topic_states,coverage,created_at
       FROM ${snapshotsTable}
       WHERE schema_version=? AND lead_id IN (${placeholders})
       ORDER BY lead_id,created_at DESC,id DESC`,
      [LEAD_ENRICHMENT_SCHEMA_VERSION, ...chunk],
    )
    for (const row of snapshotRows) {
      if (latestSnapshots.has(row.lead_id)) continue
      latestSnapshots.set(row.lead_id, {
        status: row.status,
        topicStates: row.topic_states,
        coverage: Number(row.coverage || 0),
        createdAt: row.created_at,
      })
    }
    const [jobRows] = await pool.query<Array<RowDataPacket & { lead_id: string }>>(
      `SELECT DISTINCT lead_id FROM ${jobsTable}
       WHERE schema_version=? AND status IN ('queued','running') AND lead_id IN (${placeholders})`,
      [LEAD_ENRICHMENT_SCHEMA_VERSION, ...chunk],
    )
    for (const row of jobRows) activeLeadIds.add(row.lead_id)
  }

  const planned = scopedIds.map((leadId) => ({
    leadId,
    poolEnteredAt: leadEnteredAtById.get(leadId) || '',
    plan: planLeadDeepCollection({
      snapshot: latestSnapshots.get(leadId) ?? null,
      hasActiveJob: activeLeadIds.has(leadId),
      maxAgeDays,
      retryGaps,
      force,
    }),
  }))
  const eligible = planned.filter((item) => item.plan.selected).sort((left, right) => (
    (Date.parse(right.poolEnteredAt) || 0) - (Date.parse(left.poolEnteredAt) || 0)
    || reasonPriority(left.plan) - reasonPriority(right.plan)
    || (right.plan.gapTopics.length - left.plan.gapTopics.length)
    || ((right.plan.snapshotAgeDays ?? Number.MAX_SAFE_INTEGER) - (left.plan.snapshotAgeDays ?? Number.MAX_SAFE_INTEGER))
    || left.leadId.localeCompare(right.leadId)
  ))
  const candidates = eligible.slice(0, limit)

  let queued = 0
  let duplicate = 0
  let skipped = 0
  if (applying) {
    let cursor = 0
    async function enqueueWorker() {
      while (cursor < candidates.length) {
        const candidateIndex = cursor++
        const candidate = candidates[candidateIndex]
        // The worker leases lower priorities first. Preserve newest-intake ordering even
        // when jobs are inserted concurrently by spreading the ordered candidates over
        // the full persisted priority range.
        const priority = Math.min(
          1_000,
          Math.floor(candidateIndex * 1_000 / Math.max(1, candidates.length)) + 1,
        )
        const result = await enqueueLeadEnrichmentJob({
          leadId: candidate.leadId,
          triggerType: triggerType!,
          idempotencyToken: batchId,
          priority,
        })
        if (result.queued) queued += 1
        else if (result.reason === 'duplicate') duplicate += 1
        else skipped += 1
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(enqueueConcurrency, Math.max(1, candidates.length)) },
      () => enqueueWorker(),
    ))
    await pool.query(
      `INSERT INTO ${auditTable}
        (id,user_id,user_name,module,action,target,result,request_id,created_at)
       VALUES (?,NULL,'Codex','共享线索','创建线索池深度采集任务',?,'success',?,NOW(3))`,
      [randomUUID(), JSON.stringify({
        batchId,
        triggerType,
        schemaVersion: LEAD_ENRICHMENT_SCHEMA_VERSION,
        visible: scopedIds.length,
        eligible: eligible.length,
        selected: candidates.length,
        queued,
        duplicate,
        skipped,
        maxAgeDays,
        retryGaps,
        force,
      }), batchId],
    )
  }

  const collectionReasons: LeadDeepCollectionReason[] = [
    'no_current_snapshot', 'snapshot_stale', 'snapshot_has_gaps', 'forced_refresh',
  ]
  const reasonCounts = Object.fromEntries(collectionReasons.map((reason) => [
    reason,
    eligible.filter((item) => item.plan.reasons.includes(reason)).length,
  ]))
  const workerCommand = triggerType
    ? `LEAD_ENRICHMENT_RESEARCH_BACKEND=codex-cli LEAD_ENRICHMENT_TRIGGER_TYPE_FILTER=${triggerType} LEAD_ENRICHMENT_CONCURRENCY=${workerConcurrency} npm run worker:lead-enrichment:codex`
    : null

  console.log(JSON.stringify({
    ok: true,
    mode: applying ? 'apply' : 'preview',
    batchId: batchId || null,
    triggerType,
    schemaVersion: LEAD_ENRICHMENT_SCHEMA_VERSION,
    scope: requestedLeadIds.length ? 'explicit-visible-lead-ids' : companyOnly ? 'all-visible-enterprise-leads' : 'all-visible-leads',
    companyOnly,
    requested: requestedLeadIds.length || null,
    requestedButNotVisible,
    visible: scopedIds.length,
    withCurrentSnapshot: latestSnapshots.size,
    withActiveJob: activeLeadIds.size,
    selection: {
      maxAgeDays,
      retryGaps,
      force,
      eligibleBeforeLimit: eligible.length,
      selected: candidates.length,
      limit,
      reasonCounts,
    },
    candidatePreview: candidates.slice(0, 100).map((candidate) => ({
      leadId: candidate.leadId,
      name: leadNameById.get(candidate.leadId) || '',
      poolEnteredAt: candidate.poolEnteredAt || null,
      reasons: candidate.plan.reasons,
      gapTopics: candidate.plan.gapTopics,
      snapshotAgeDays: candidate.plan.snapshotAgeDays === null
        ? null
        : Number(candidate.plan.snapshotAgeDays.toFixed(1)),
    })),
    candidatePreviewTruncated: candidates.length > 100,
    estimatedTopicRunsUpperBound: candidates.length * LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS.length,
    queued,
    duplicate,
    skipped,
    enqueueConcurrency,
    workerConcurrency,
    workerCommand: applying ? workerCommand : null,
    nextStep: applying
      ? 'Start the printed isolated worker command to perform web collection and evidence-bound persistence.'
      : 'Review this read-only selection, then rerun with --apply and a stable --batch-id.',
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}).finally(async () => await pool.end())
