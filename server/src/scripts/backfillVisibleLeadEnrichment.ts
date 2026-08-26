import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { listLeads } from '../services/aiSummaryService.js'
import { LEAD_ENRICHMENT_SCHEMA_VERSION } from '../services/leadEnrichmentContract.js'
import { enqueueLeadEnrichmentJob } from '../services/leadEnrichmentService.js'

const apply = process.argv.includes('--apply')
const batchId = process.argv.find((arg) => arg.startsWith('--batch-id='))?.slice(11).trim() || ''
const concurrency = Math.max(1, Math.min(8, Number(
  process.argv.find((arg) => arg.startsWith('--concurrency='))?.slice(14),
) || 4))
if (apply && !batchId) throw new Error('--apply requires --batch-id=<stable-id>')

const jobsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_jobs'))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const snapshotsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_snapshots'))
const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))

async function visibleLeadIds() {
  const first = await listLeads({ page: 1, pageSize: 100 })
  const ids = first.list.map((lead) => lead.id)
  for (let page = 2; page <= first.totalPages; page += 1) {
    const current = await listLeads({ page, pageSize: 100 })
    ids.push(...current.list.map((lead) => lead.id))
  }
  return [...new Set(ids)]
}

async function main() {
  const ids = await visibleLeadIds()
  const states = new Map<string, { hasCurrentSnapshot: boolean; hasActiveJob: boolean }>()
  for (const id of ids) states.set(id, { hasCurrentSnapshot: false, hasActiveJob: false })
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500)
    const placeholders = chunk.map(() => '?').join(',')
    const [snapshots] = await pool.query<Array<RowDataPacket & { lead_id: string }>>(
      `SELECT DISTINCT lead_id FROM ${snapshotsTable} WHERE schema_version=? AND lead_id IN (${placeholders})`,
      [LEAD_ENRICHMENT_SCHEMA_VERSION, ...chunk],
    )
    for (const row of snapshots) states.get(row.lead_id)!.hasCurrentSnapshot = true
    const [jobs] = await pool.query<Array<RowDataPacket & { lead_id: string }>>(
      `SELECT DISTINCT lead_id FROM ${jobsTable}
       WHERE status IN ('queued','running') AND lead_id IN (${placeholders})`,
      chunk,
    )
    for (const row of jobs) states.get(row.lead_id)!.hasActiveJob = true
  }

  const candidates = ids.filter((id) => {
    const state = states.get(id)!
    return !state.hasCurrentSnapshot && !state.hasActiveJob
  })
  let repairedEntityStatuses = 0
  let queued = 0
  let duplicate = 0
  let skipped = 0
  if (apply) {
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500)
      const placeholders = chunk.map(() => '?').join(',')
      const [result] = await pool.query(
        `UPDATE ${jobsTable} j JOIN ${leadsTable} l ON l.id=j.lead_id
         SET j.entity_type='company',j.entity_status='claimed',j.updated_at=NOW(3)
         WHERE j.status IN ('queued','running') AND j.entity_status='missing'
           AND l.company_name REGEXP '(股份有限公司|有限责任公司|有限公司)$'
           AND j.lead_id IN (${placeholders})`,
        chunk,
      )
      repairedEntityStatuses += Number((result as { affectedRows?: number }).affectedRows || 0)
    }
    let cursor = 0
    async function worker() {
      while (cursor < candidates.length) {
        const leadId = candidates[cursor++]
        const result = await enqueueLeadEnrichmentJob({
          leadId,
          triggerType: `visible-backfill:${batchId}`,
          idempotencyToken: batchId,
          priority: 200,
        })
        if (result.queued) queued += 1
        else if (result.reason === 'duplicate') duplicate += 1
        else skipped += 1
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, candidates.length)) }, () => worker()))
    await pool.query(
      `INSERT INTO ${auditTable}
        (id,user_id,user_name,module,action,target,result,request_id,created_at)
       VALUES (?,NULL,'Codex','共享线索','补建可见线索V3补全任务',?,'success',?,NOW(3))`,
      [randomUUID(), JSON.stringify({
        batchId, schemaVersion: LEAD_ENRICHMENT_SCHEMA_VERSION, visible: ids.length,
        candidates: candidates.length, queued, duplicate, skipped, repairedEntityStatuses,
      }), batchId],
    )
  }
  console.log(JSON.stringify({
    ok: true,
    mode: apply ? 'apply' : 'preview',
    batchId: batchId || null,
    schemaVersion: LEAD_ENRICHMENT_SCHEMA_VERSION,
    visible: ids.length,
    currentSnapshot: ids.filter((id) => states.get(id)!.hasCurrentSnapshot).length,
    activeJob: ids.filter((id) => states.get(id)!.hasActiveJob).length,
    candidates: candidates.length,
    repairedEntityStatuses,
    queued,
    duplicate,
    skipped,
    concurrency,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}).finally(async () => await pool.end())
