import type { RowDataPacket } from 'mysql2'
import type { PoolConnection } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { buildConditionalRollbackPatch } from '../services/leadBackfillRollbackService.js'
import { extractLeadFinancingFacts } from '../services/leadFinancingFactService.js'
import {
  buildConvertedProjectFundingPatch,
  commitLeadPublicIntel,
  type PublicIntelResult,
} from '../services/leadPublicIntelService.js'

type LeadRow = RowDataPacket & {
  id: string
  name: string
  company_name: string | null
  source: string | null
  pool_status: string
  converted_project_id: string | null
  funding_rounds: unknown
  scoring: unknown
  radar_profile: unknown
}

const apply = process.argv.includes('--apply')
const rollbackFile = process.argv.find((value) => value.startsWith('--rollback='))?.slice(11) || ''
const requestedSnapshotFile = process.argv.find((value) => value.startsWith('--snapshot='))?.slice(11) || ''
const requestedBatchId = process.argv.find((value) => value.startsWith('--batch-id='))?.slice(11) || ''
const leadId = process.argv.find((value) => value.startsWith('--lead-id='))?.slice(10) || ''
const projectId = process.argv.find((value) => value.startsWith('--project-id='))?.slice(13) || ''
const candidateKey = process.argv.find((value) => value.startsWith('--candidate-key='))?.slice(16) || ''
const after = process.argv.find((value) => value.startsWith('--after='))?.slice(8) || ''
const limit = Math.max(1, Math.min(500, Number(
  process.argv.find((value) => value.startsWith('--limit='))?.slice(8),
) || 25))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const projectsTable = quoteMysqlIdentifier(mysqlTableName('projects'))
const auditLogsTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
const evidenceRoot = resolve(process.cwd(), '.runtime/evidence')

type Projection = {
  lead: Record<string, unknown>
  project: Record<string, unknown> | null
}

type BackfillSnapshot = {
  kind: 'wechat-lead-financing-backfill-snapshot'
  version: 1
  batchId: string
  createdAt: string
  items: Array<{
    leadId: string
    projectId: string | null
    eventId: string
    before: Projection
    after: Projection
  }>
}

function safeEvidenceFile(value: string) {
  const target = resolve(process.cwd(), value)
  if (target !== evidenceRoot && !target.startsWith(`${evidenceRoot}${sep}`)) {
    throw new Error('snapshot and rollback files must stay under .runtime/evidence')
  }
  return target
}

function jsonValue(value: unknown) {
  if (value == null) return null
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

async function readProjection(executor: Pick<PoolConnection, 'query'> | typeof pool, targetLeadId: string, targetProjectId: string | null): Promise<Projection> {
  const [leadRows] = await executor.query<Array<RowDataPacket & {
    company_name: string | null
    summary: string | null
    business_region: string | null
    business_region_source: string | null
    business_region_confidence: string | null
    funding_rounds: unknown
    scoring: unknown
    sources: unknown
    field_provenance: unknown
  }>>(
    `SELECT company_name,summary,business_region,business_region_source,business_region_confidence,
            funding_rounds,scoring,sources,field_provenance
     FROM ${leadsTable} WHERE id=? LIMIT 1`,
    [targetLeadId],
  )
  const lead = leadRows[0]
  if (!lead) throw new Error(`lead not found while reading snapshot: ${targetLeadId}`)
  let project: Record<string, unknown> | null = null
  if (targetProjectId) {
    const [projectRows] = await executor.query<Array<RowDataPacket & {
      round: string | null
      financing: string | null
      valuation: string | null
    }>>(`SELECT round,financing,valuation FROM ${projectsTable} WHERE id=? LIMIT 1`, [targetProjectId])
    if (projectRows[0]) {
      project = {
        round: projectRows[0].round,
        financing: projectRows[0].financing,
        valuation: projectRows[0].valuation,
      }
    }
  }
  return {
    lead: {
      companyName: lead.company_name,
      summary: lead.summary,
      businessRegion: lead.business_region,
      businessRegionSource: lead.business_region_source,
      businessRegionConfidence: lead.business_region_confidence,
      fundingRounds: jsonValue(lead.funding_rounds),
      scoring: jsonValue(lead.scoring),
      sources: jsonValue(lead.sources),
      fieldProvenance: jsonValue(lead.field_provenance),
    },
    project,
  }
}

const leadColumnByField: Record<string, { column: string; json?: boolean }> = {
  companyName: { column: 'company_name' },
  summary: { column: 'summary' },
  businessRegion: { column: 'business_region' },
  businessRegionSource: { column: 'business_region_source' },
  businessRegionConfidence: { column: 'business_region_confidence' },
  fundingRounds: { column: 'funding_rounds', json: true },
  scoring: { column: 'scoring', json: true },
  sources: { column: 'sources', json: true },
  fieldProvenance: { column: 'field_provenance', json: true },
}
const projectColumnByField: Record<string, string> = {
  round: 'round', financing: 'financing', valuation: 'valuation',
}

async function applyRollbackSnapshot(snapshot: BackfillSnapshot) {
  const summary = {
    ok: true,
    mode: apply ? 'rollback-apply' : 'rollback-preview',
    batchId: snapshot.batchId,
    restoredFields: 0,
    conflicts: 0,
    results: [] as Array<Record<string, unknown>>,
  }
  for (const item of [...snapshot.items].reverse()) {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const current = await readProjection(connection, item.leadId, item.projectId)
      const leadDecision = buildConditionalRollbackPatch({
        before: item.before.lead,
        after: item.after.lead,
        current: current.lead,
      })
      const projectDecision = item.before.project && item.after.project && current.project
        ? buildConditionalRollbackPatch({ before: item.before.project, after: item.after.project, current: current.project })
        : { patch: {}, restored: [] as string[], conflicts: [] as Array<{ field: string; reason: string }> }
      const result = {
        leadId: item.leadId,
        projectId: item.projectId,
        leadRestored: leadDecision.restored,
        projectRestored: projectDecision.restored,
        conflicts: [...leadDecision.conflicts, ...projectDecision.conflicts],
      }
      if (apply) {
        const leadEntries = Object.entries(leadDecision.patch)
          .filter(([field]) => Boolean(leadColumnByField[field]))
        if (leadEntries.length) {
          const assignments = leadEntries.map(([field]) => `${leadColumnByField[field]!.column}=?`)
          const values = leadEntries.map(([field, value]) => leadColumnByField[field]!.json ? JSON.stringify(value) : value)
          await connection.query(
            `UPDATE ${leadsTable} SET ${assignments.join(',')} WHERE id=?`,
            [...values, item.leadId],
          )
        }
        const projectEntries = Object.entries(projectDecision.patch)
          .filter(([field]) => Boolean(projectColumnByField[field]))
        if (item.projectId && projectEntries.length) {
          const assignments = projectEntries.map(([field]) => `${projectColumnByField[field]}=?`)
          await connection.query(
            `UPDATE ${projectsTable} SET ${assignments.join(',')},version=version+1,updated_at=NOW(3) WHERE id=?`,
            [...projectEntries.map(([, value]) => value), item.projectId],
          )
        }
        if (leadEntries.length || projectEntries.length || result.conflicts.length) {
          await connection.query(
            `INSERT INTO ${auditLogsTable} (id,user_name,module,action,target,result,request_id,created_at)
             VALUES (?,'（系统）','项目获取池','回滚微信公众号融资回填',?,'success',?,NOW(3))`,
            [randomUUID(), JSON.stringify({ batchId: snapshot.batchId, eventId: item.eventId, ...result }), `wechat-backfill-rollback:${snapshot.batchId}`.slice(0, 64)],
          )
        }
      }
      if (apply) await connection.commit()
      else await connection.rollback()
      summary.restoredFields += leadDecision.restored.length + projectDecision.restored.length
      summary.conflicts += result.conflicts.length
      summary.results.push(result)
    } catch (error) {
      await connection.rollback().catch(() => undefined)
      throw error
    } finally {
      connection.release()
    }
  }
  return summary
}

if (rollbackFile) {
  const rollbackPath = safeEvidenceFile(rollbackFile)
  const snapshot = JSON.parse(await readFile(rollbackPath, 'utf8')) as BackfillSnapshot
  if (snapshot.kind !== 'wechat-lead-financing-backfill-snapshot' || snapshot.version !== 1 || !Array.isArray(snapshot.items)) {
    throw new Error('invalid WeChat lead financing backfill snapshot')
  }
  console.log(JSON.stringify(await applyRollbackSnapshot(snapshot), null, 2))
  await pool.end()
  process.exit(0)
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown> } catch { return {} }
  }
  return {}
}

function array(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
  if (typeof value === 'string') {
    try { return array(JSON.parse(value)) } catch { return [] }
  }
  return []
}

function text(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

const conditions = ["pool_status NOT IN ('已删除','已合并')"]
const parameters: unknown[] = []
if (leadId) { conditions.push('id=?'); parameters.push(leadId) }
if (projectId) { conditions.push('converted_project_id=?'); parameters.push(projectId) }
if (candidateKey) {
  conditions.push("JSON_UNQUOTE(JSON_EXTRACT(radar_profile,'$.radarSourceKey'))=?")
  parameters.push(candidateKey)
}
if (!leadId && !projectId && !candidateKey) {
  conditions.push('id>?')
  parameters.push(after)
  conditions.push("(source LIKE '%公众号%' OR JSON_UNQUOTE(JSON_EXTRACT(radar_profile,'$.channel'))='公众号' OR JSON_UNQUOTE(JSON_EXTRACT(radar_profile,'$.link')) LIKE 'https://mp.weixin.qq.com/%')")
}

const [rows] = await pool.query<LeadRow[]>(
  `SELECT id,name,company_name,source,pool_status,converted_project_id,funding_rounds,scoring,radar_profile
   FROM ${leadsTable}
   WHERE ${conditions.join(' AND ')}
   ORDER BY id LIMIT ?`,
  [...parameters, limit],
)

const batchId = (requestedBatchId || `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  .replace(/[^a-zA-Z0-9._-]/g, '-')
  .slice(0, 80)
const snapshotPath = safeEvidenceFile(
  requestedSnapshotFile || `.runtime/evidence/wechat-lead-backfill-${batchId}.json`,
)
const backfillSnapshot: BackfillSnapshot = {
  kind: 'wechat-lead-financing-backfill-snapshot',
  version: 1,
  batchId,
  createdAt: new Date().toISOString(),
  items: [],
}
if (apply) {
  await mkdir(dirname(snapshotPath), { recursive: true })
  await writeFile(snapshotPath, `${JSON.stringify(backfillSnapshot, null, 2)}\n`, { flag: 'wx' })
}

const summary = {
  ok: true,
  mode: apply ? 'apply' : 'preview',
  batchId: apply ? batchId : null,
  snapshotPath: apply ? snapshotPath : null,
  scanned: rows.length,
  eligible: 0,
  applied: 0,
  unchanged: 0,
  failed: 0,
  results: [] as Array<Record<string, unknown>>,
}

for (const row of rows) {
  const radar = record(row.radar_profile)
  const articleText = text(radar.articleText)
  const sourceUrl = text(radar.link)
  const facts = extractLeadFinancingFacts({
    text: articleText,
    sourceUrl,
    publishedAt: radar.publishedAt,
  })
  if (!facts.length) {
    summary.unchanged += 1
    summary.results.push({ leadId: row.id, name: row.name, status: 'no_completed_financing_fact' })
    continue
  }
  summary.eligible += 1
  const current = array(row.funding_rounds)
  const incoming = facts.map((fact) => ({
    round: fact.round,
    roundRaw: fact.roundRaw,
    date: fact.date,
    amount: fact.amount,
    amountRaw: fact.amountRaw,
    currency: fact.currency,
    valuation: fact.valuation,
    investors: fact.investors.join('；'),
    leadInvestors: fact.leadInvestors,
    sourceUrl: fact.sourceUrl,
    evidenceQuote: fact.evidenceQuote,
    evidenceStatus: fact.evidenceStatus,
    extractionMethod: fact.extractionMethod,
    extractorVersion: fact.extractorVersion,
    idempotencyKey: fact.idempotencyKey,
  }))
  let currentProject: Record<string, unknown> | null = null
  let proposedProjectPatch: Record<string, unknown> = {}
  if (row.converted_project_id) {
    const [projectRows] = await pool.query<Array<RowDataPacket & {
      id: string; name: string; round: string | null; financing: string | null; valuation: string | null
    }>>(
      `SELECT id,name,round,financing,valuation FROM ${projectsTable} WHERE id=? LIMIT 1`,
      [row.converted_project_id],
    )
    const project = projectRows[0]
    if (project) {
      currentProject = { id: project.id, name: project.name, round: project.round, financing: project.financing, valuation: project.valuation }
      proposedProjectPatch = buildConvertedProjectFundingPatch(project, incoming[0]).patch
    }
  }
  const preview = {
    leadId: row.id,
    projectId: row.converted_project_id,
    name: row.name,
    poolStatus: row.pool_status,
    sourceUrl,
    currentFundingRounds: current,
    proposedFundingRounds: incoming,
    currentProject,
    proposedProjectPatch,
    status: apply ? 'pending_apply' : 'preview',
  }
  if (!apply) {
    summary.results.push(preview)
    continue
  }
  const company = text(row.company_name) || text(row.name)
  const intel: PublicIntelResult = {
    positioning: articleText.slice(0, 2_000),
    registeredCapital: '',
    legalRepresentative: '',
    foundedAt: '',
    region: '',
    registeredAddress: '',
    fundingRounds: incoming,
    shareholders: [],
    competitors: [],
    companyNews: [],
    sources: sourceUrl ? [{ title: text(radar.sourceTitle) || row.name, url: sourceUrl, reliability: '微信公众号原文' }] : [],
    searchEvidence: sourceUrl ? [{
      query: company,
      title: text(radar.sourceTitle) || row.name,
      snippet: articleText.slice(0, 12_000),
      url: sourceUrl,
      publisher: text(radar.sourceName),
      publishedAt: text(radar.publishedAt),
      reliability: '微信公众号原文，待交叉核验',
    }] : [],
    confidence: 0.7,
    fetchedAt: text(radar.publishedAt) || undefined,
  }
  try {
    const before = await readProjection(pool, row.id, row.converted_project_id)
    const committed = await commitLeadPublicIntel({ company, intel, targetLeadId: row.id })
    const afterProjection = await readProjection(pool, row.id, row.converted_project_id)
    backfillSnapshot.items.push({
      leadId: row.id,
      projectId: row.converted_project_id,
      eventId: committed.eventId,
      before,
      after: afterProjection,
    })
    await writeFile(snapshotPath, `${JSON.stringify(backfillSnapshot, null, 2)}\n`)
    summary.applied += committed.status === 'unchanged' ? 0 : 1
    summary.unchanged += committed.status === 'unchanged' ? 1 : 0
    summary.results.push({
      ...preview,
      status: committed.status,
      replayed: committed.replayed,
      eventId: committed.eventId,
    })
  } catch (error) {
    summary.failed += 1
    summary.results.push({
      ...preview,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

console.log(JSON.stringify(summary, null, 2))
await pool.end()
if (summary.failed) process.exitCode = 1
