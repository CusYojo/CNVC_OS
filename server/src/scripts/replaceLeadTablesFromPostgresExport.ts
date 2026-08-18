import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { initialLeadFieldProvenance } from '../services/leadFieldProvenance.js'

const EXPECTED_SHA256 = '8a853719d91bf6f8453c31c26e7201cee9b9f6283489b91414ed03f2a64856b5'
const EXPECTED_LEADS = 1_899
const EXPECTED_RESERVE = 10_000
const EXPECTED_IMPORTED = 1_056
const apply = process.argv.includes('--apply')
const exportPath = process.env.LEAD_SOURCE_EXPORT_PATH?.trim()

type JsonObject = Record<string, any>
type SourceLead = JsonObject & { id: string; name: string; company_name?: string | null; source?: string | null }
type SourceReserve = JsonObject & { id: string | number; imported: boolean; detail_json?: JsonObject | string | null }
type SourceExport = { schemaVersion: string; exportedAt: string; leads: SourceLead[]; leadReserve: SourceReserve[] }
type ReferenceSpec = { table: string; key: string; column: string }
type ReferenceRow = { keyValue: string; leadId: string }

const table = (name: string) => quoteMysqlIdentifier(mysqlTableName(name))
const leadsTable = table('leads')
const reserveTable = table('lead_reserve')
const projectsTable = table('projects')

const referenceSpecs: ReferenceSpec[] = [
  { table: 'lead_import_rows', key: 'id', column: 'lead_id' },
  { table: 'lead_intake_files', key: 'id', column: 'lead_id' },
  { table: 'lead_pipeline_entity_matches', key: 'id', column: 'candidate_lead_id' },
  { table: 'lead_pipeline_items', key: 'event_id', column: 'lead_id' },
]

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function normalize(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN')
}

function jsonObject(value: unknown): JsonObject {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function jsonValue(value: unknown, fallback: unknown): string {
  return JSON.stringify(value == null ? fallback : value)
}

function dateValue(value: unknown): Date | null {
  if (!value) return null
  const parsed = new Date(String(value))
  assert(!Number.isNaN(parsed.getTime()), `invalid date: ${String(value)}`)
  return parsed
}

function placeholders(rows: number, columns: number): string {
  return Array.from({ length: rows }, () => `(${Array(columns).fill('?').join(',')})`).join(',')
}

async function insertBatches(
  connection: PoolConnection,
  target: string,
  columns: string[],
  rows: unknown[][],
  batchSize = 50,
) {
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize)
    await connection.query(
      `INSERT INTO ${target} (${columns.map(quoteMysqlIdentifier).join(',')}) VALUES ${placeholders(batch.length, columns.length)}`,
      batch.flat(),
    )
  }
}

function buildReserveMappings(leads: SourceLead[], reserve: SourceReserve[]) {
  const aliases = new Map<string, Set<string>>()
  const leadById = new Map(leads.map((lead) => [lead.id, lead]))
  for (const lead of leads.filter((row) => row.source === '36氪项目库')) {
    for (const value of [lead.name, lead.company_name]) {
      const key = normalize(value)
      if (!key) continue
      const ids = aliases.get(key) ?? new Set<string>()
      ids.add(lead.id)
      aliases.set(key, ids)
    }
  }

  const candidates = new Map<number, string>()
  const ambiguous: number[] = []
  for (const row of reserve.filter((item) => Boolean(item.imported))) {
    const detail = jsonObject(row.detail_json)
    const ids = new Set<string>()
    for (const value of [row.name, detail.name, detail.companyName, detail.business?.name]) {
      for (const id of aliases.get(normalize(value)) ?? []) ids.add(id)
    }
    if (ids.size === 1) candidates.set(Number(row.id), [...ids][0])
    else if (ids.size > 1) ambiguous.push(Number(row.id))
  }

  const reverse = new Map<string, number[]>()
  for (const [reserveId, leadId] of candidates) {
    reverse.set(leadId, [...(reverse.get(leadId) ?? []), reserveId])
  }
  const mappings = new Map<number, string>()
  for (const [reserveId, leadId] of candidates) {
    if (reverse.get(leadId)?.length === 1) mappings.set(reserveId, leadId)
  }
  for (const leadId of mappings.values()) assert(leadById.has(leadId), `reserve mapping references missing lead ${leadId}`)
  return { mappings, ambiguous }
}

function reserveScoreStatus(lead: SourceLead): string {
  const scoring = jsonObject(lead.scoring)
  const jobStatus = String(jsonObject(scoring.scoreJob).status ?? '')
  if (jobStatus === 'done' || (Array.isArray(scoring.dimensions) && scoring.dimensions.length > 0)) return 'succeeded'
  if (jobStatus === 'failed') return 'failed'
  return 'pending'
}

async function captureReferences(connection: PoolConnection): Promise<Map<string, ReferenceRow[]>> {
  const captured = new Map<string, ReferenceRow[]>()
  for (const spec of referenceSpecs) {
    const [rows] = await connection.query<Array<RowDataPacket & { keyValue: string; leadId: string }>>(
      `SELECT ${quoteMysqlIdentifier(spec.key)} AS keyValue, ${quoteMysqlIdentifier(spec.column)} AS leadId
       FROM ${table(spec.table)} WHERE ${quoteMysqlIdentifier(spec.column)} IS NOT NULL FOR UPDATE`,
    )
    captured.set(spec.table, rows.map((row) => ({ keyValue: String(row.keyValue), leadId: String(row.leadId) })))
  }
  return captured
}

async function restoreReferences(
  connection: PoolConnection,
  captured: Map<string, ReferenceRow[]>,
  newLeadIds: Set<string>,
) {
  const restored: Record<string, number> = {}
  for (const spec of referenceSpecs) {
    const rows = (captured.get(spec.table) ?? []).filter((row) => newLeadIds.has(row.leadId))
    restored[spec.table] = rows.length
    for (let offset = 0; offset < rows.length; offset += 100) {
      const batch = rows.slice(offset, offset + 100)
      const cases = batch.map(() => 'WHEN ? THEN ?').join(' ')
      await connection.query(
        `UPDATE ${table(spec.table)} SET ${quoteMysqlIdentifier(spec.column)} = CASE ${quoteMysqlIdentifier(spec.key)} ${cases} END
         WHERE ${quoteMysqlIdentifier(spec.key)} IN (${batch.map(() => '?').join(',')})`,
        [...batch.flatMap((row) => [row.keyValue, row.leadId]), ...batch.map((row) => row.keyValue)],
      )
    }
  }
  return restored
}

async function scalar(connection: PoolConnection, sql: string, params: unknown[] = []): Promise<number> {
  const [rows] = await connection.query<Array<RowDataPacket & { count: number }>>(sql, params)
  return Number(rows[0]?.count ?? 0)
}

async function main() {
  assert(exportPath, 'LEAD_SOURCE_EXPORT_PATH is required')
  const compressed = await readFile(exportPath)
  const sha256 = createHash('sha256').update(compressed).digest('hex')
  assert(sha256 === EXPECTED_SHA256, `source sha256 mismatch: ${sha256}`)
  const source = JSON.parse(gunzipSync(compressed).toString('utf8')) as SourceExport
  assert(source.schemaVersion === '1.0', `unexpected schema version: ${source.schemaVersion}`)
  assert(source.leads.length === EXPECTED_LEADS, `expected ${EXPECTED_LEADS} leads, got ${source.leads.length}`)
  assert(source.leadReserve.length === EXPECTED_RESERVE, `expected ${EXPECTED_RESERVE} reserve rows, got ${source.leadReserve.length}`)
  assert(new Set(source.leads.map((row) => row.id)).size === EXPECTED_LEADS, 'duplicate lead ids in source')
  assert(new Set(source.leadReserve.map((row) => Number(row.id))).size === EXPECTED_RESERVE, 'duplicate reserve ids in source')
  assert(source.leadReserve.filter((row) => Boolean(row.imported)).length === EXPECTED_IMPORTED, 'source imported count mismatch')

  const { mappings, ambiguous } = buildReserveMappings(source.leads, source.leadReserve)
  const resetReserveIds = source.leadReserve
    .filter((row) => Boolean(row.imported) && !mappings.has(Number(row.id)))
    .map((row) => Number(row.id))
  assert(ambiguous.length === 0, `ambiguous reserve mappings: ${ambiguous.join(',')}`)
  assert(mappings.size === 1_053, `expected 1053 reserve mappings, got ${mappings.size}`)
  assert(resetReserveIds.join(',') === '90,148,459', `unexpected unmatched imported reserve rows: ${resetReserveIds.join(',')}`)

  const connection = await pool.getConnection()
  let locked = false
  try {
    const [lockRows] = await connection.query<Array<RowDataPacket & { acquired: number }>>(
      `SELECT GET_LOCK('sbl:replace-lead-tables:20260817', 15) AS acquired`,
    )
    assert(Number(lockRows[0]?.acquired) === 1, 'could not acquire lead-table replacement lock')
    locked = true

    const [projectRows] = await connection.query<Array<RowDataPacket & { id: string }>>(`SELECT id FROM ${projectsTable}`)
    const projectIds = new Set(projectRows.map((row) => String(row.id)))
    const missingConverted = source.leads.filter((row) => row.converted_project_id && !projectIds.has(String(row.converted_project_id)))
    assert(missingConverted.length === 4, `expected 4 missing converted projects, got ${missingConverted.length}`)

    const preview = {
      apply,
      sourceSha256: sha256,
      source: { leads: source.leads.length, reserve: source.leadReserve.length, imported: EXPECTED_IMPORTED },
      target: {
        leads: await scalar(connection, `SELECT COUNT(*) count FROM ${leadsTable}`),
        reserve: await scalar(connection, `SELECT COUNT(*) count FROM ${reserveTable}`),
      },
      mappedImportedReserve: mappings.size,
      resetImportedReserveIds: resetReserveIds,
      normalizedMissingConvertedLeadIds: missingConverted.map((row) => row.id),
    }
    if (!apply) {
      console.log(JSON.stringify(preview, null, 2))
      return
    }

    await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
    await connection.beginTransaction()
    try {
      await connection.query(`SELECT id FROM ${leadsTable} ORDER BY id FOR UPDATE`)
      await connection.query(`SELECT id FROM ${reserveTable} ORDER BY id FOR UPDATE`)
      const captured = await captureReferences(connection)

      await connection.query(`DELETE FROM ${reserveTable}`)
      await connection.query(`DELETE FROM ${leadsTable}`)

      const newLeadIds = new Set(source.leads.map((row) => row.id))
      const leadColumns = [
        'id', 'name', 'company_name', 'industry', 'business_region', 'business_region_source',
        'business_region_confidence', 'source', 'pool_status', 'score', 'summary', 'highlights', 'risks',
        'team', 'funding_rounds', 'risk_tags', 'sources', 'scoring', 'radar_profile', 'radar_source_keys',
        'field_provenance', 'claimed_by', 'converted_project_id', 'created_at',
      ]
      const leadRows = source.leads.map((row) => {
        const convertedProjectId = row.converted_project_id && projectIds.has(String(row.converted_project_id))
          ? String(row.converted_project_id)
          : null
        const normalized = {
          name: row.name,
          companyName: row.company_name,
          industry: row.industry,
          businessRegion: row.business_region,
          businessRegionSource: row.business_region_source,
          businessRegionConfidence: row.business_region_confidence,
          source: row.source,
          poolStatus: row.pool_status,
          score: row.score,
          summary: row.summary,
          highlights: row.highlights,
          risks: row.risks,
          team: row.team,
          fundingRounds: row.funding_rounds,
          riskTags: row.risk_tags,
          sources: row.sources,
          scoring: row.scoring,
          radarProfile: row.radar_profile,
          radarSourceKeys: row.radar_source_keys,
        }
        return [
          row.id, row.name, row.company_name ?? null, row.industry ?? null, row.business_region ?? null,
          row.business_region_source ?? null, row.business_region_confidence ?? null, row.source ?? null,
          row.converted_project_id && !convertedProjectId ? '成功' : (row.pool_status || '成功'), Number(row.score ?? 0),
          row.summary ?? null, jsonValue(row.highlights, []), jsonValue(row.risks, []), row.team ?? null,
          jsonValue(row.funding_rounds, []), jsonValue(row.risk_tags, []), jsonValue(row.sources, []),
          row.scoring == null ? null : jsonValue(row.scoring, {}), row.radar_profile == null ? null : jsonValue(row.radar_profile, {}),
          jsonValue(row.radar_source_keys, []), JSON.stringify(initialLeadFieldProvenance(normalized, 'legacy_import')),
          row.claimed_by ?? null, convertedProjectId, dateValue(row.created_at) ?? new Date(),
        ]
      })
      await insertBatches(connection, leadsTable, leadColumns, leadRows)

      const reserveColumns = [
        'id', 'seq', 'src_id', 'name', 'detail_url', 'detail_json', 'imported', 'imported_at',
        'imported_lead_id', 'score_status', 'score_requested_at', 'score_last_error', 'created_at',
      ]
      const reserveRows = source.leadReserve.map((row) => {
        const leadId = mappings.get(Number(row.id)) ?? null
        const imported = Boolean(row.imported) && Boolean(leadId)
        const lead = leadId ? source.leads.find((item) => item.id === leadId) : undefined
        return [
          Number(row.id), row.seq == null ? null : Number(row.seq), row.src_id ?? null, row.name ?? null,
          row.detail_url ?? null, row.detail_json == null ? null : jsonValue(jsonObject(row.detail_json), {}),
          imported ? 1 : 0, imported ? dateValue(row.imported_at) : null, leadId,
          imported && lead ? reserveScoreStatus(lead) : (row.detail_json == null ? 'source_missing' : 'not_requested'), null,
          row.detail_json == null ? 'source detail_json missing in authoritative PostgreSQL export' : null,
          dateValue(row.created_at) ?? new Date(),
        ]
      })
      await insertBatches(connection, reserveTable, reserveColumns, reserveRows)
      const restoredReferences = await restoreReferences(connection, captured, newLeadIds)

      const validation = {
        leads: await scalar(connection, `SELECT COUNT(*) count FROM ${leadsTable}`),
        reserve: await scalar(connection, `SELECT COUNT(*) count FROM ${reserveTable}`),
        imported: await scalar(connection, `SELECT COUNT(*) count FROM ${reserveTable} WHERE imported=1`),
        importedLinked: await scalar(connection, `SELECT COUNT(*) count FROM ${reserveTable} WHERE imported=1 AND imported_lead_id IS NOT NULL`),
        reserveOrphans: await scalar(connection, `SELECT COUNT(*) count FROM ${reserveTable} r LEFT JOIN ${leadsTable} l ON l.id=r.imported_lead_id WHERE r.imported_lead_id IS NOT NULL AND l.id IS NULL`),
        convertedOrphans: await scalar(connection, `SELECT COUNT(*) count FROM ${leadsTable} l LEFT JOIN ${projectsTable} p ON p.id=l.converted_project_id WHERE l.converted_project_id IS NOT NULL AND p.id IS NULL`),
        projects: await scalar(connection, `SELECT COUNT(*) count FROM ${projectsTable}`),
      }
      assert(validation.leads === EXPECTED_LEADS, `target leads count mismatch: ${validation.leads}`)
      assert(validation.reserve === EXPECTED_RESERVE, `target reserve count mismatch: ${validation.reserve}`)
      assert(validation.imported === mappings.size, `target imported count mismatch: ${validation.imported}`)
      assert(validation.importedLinked === mappings.size, `target imported-link count mismatch: ${validation.importedLinked}`)
      assert(validation.reserveOrphans === 0, `target reserve orphan count: ${validation.reserveOrphans}`)
      assert(validation.convertedOrphans === 0, `target converted-project orphan count: ${validation.convertedOrphans}`)

      await connection.commit()
      console.log(JSON.stringify({ ...preview, status: 'committed', validation, restoredReferences }, null, 2))
    } catch (error) {
      await connection.rollback()
      throw error
    }
  } finally {
    if (locked) await connection.query(`SELECT RELEASE_LOCK('sbl:replace-lead-tables:20260817')`)
    connection.release()
    await pool.end()
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  try { await pool.end() } catch {}
  process.exitCode = 1
})
