import type { PoolConnection } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  recordLeadPipelineRawEventsBatch,
  transitionLeadPipelineItem,
} from '../services/leadPipelineEventService.js'
import {
  leadReserveRawEventInput,
  type LeadReserveRawRow,
} from '../services/leadReserveIntakeService.js'

type RadarRawRow = RowDataPacket & {
  id: string
  source_key: string
  payload: Record<string, unknown> | string
  collected_at: Date | null
  published_at: Date | null
}

const apply = process.argv.includes('--apply')
const reserveTable = quoteMysqlIdentifier(mysqlTableName('lead_reserve'))
const radarRawTable = quoteMysqlIdentifier(mysqlTableName('radar_raw_events'))
const rawTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_raw_events'))
const itemsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_items'))
const transitionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_transitions'))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))

function objectPayload(value: Record<string, unknown> | string | null): Record<string, unknown> {
  if (!value) return {}
  if (typeof value !== 'string') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

async function existingLead(connection: PoolConnection, leadId: string | null) {
  if (!leadId) return null
  const [rows] = await connection.query<Array<RowDataPacket & { id: string }>>(
    `SELECT id FROM ${leadsTable} WHERE id=? LIMIT 1`,
    [leadId],
  )
  return rows[0]?.id ?? null
}

async function reserveHistoricalLead(connection: PoolConnection, row: LeadReserveRawRow) {
  const [rows] = await connection.query<Array<RowDataPacket & { id: string }>>(
    `SELECT id FROM ${leadsTable}
     WHERE JSON_CONTAINS(radar_source_keys, JSON_QUOTE(?)) LIMIT 2`,
    [`lead-reserve:${row.id}`],
  )
  if (rows.length === 1) return { leadId: rows[0].id, basis: 'legacy-source-key' }

  // The oldest 36Kr import predates imported_lead_id and radar_source_keys. Recover only
  // a bidirectionally unique exact match across authoritative source/name fields.
  const [candidates] = await connection.query<Array<RowDataPacket & { id: string; name: string }>>(
    `SELECT DISTINCT l.id, l.name FROM ${leadsTable} l
     WHERE l.source='36氪项目库'
       AND l.name IN (?, JSON_UNQUOTE(JSON_EXTRACT(CAST(? AS JSON), '$.name')),
         JSON_UNQUOTE(JSON_EXTRACT(CAST(? AS JSON), '$.companyName')),
         JSON_UNQUOTE(JSON_EXTRACT(CAST(? AS JSON), '$.business.name')))
     LIMIT 2`,
    [row.name, JSON.stringify(objectPayload(row.detail_json)), JSON.stringify(objectPayload(row.detail_json)),
      JSON.stringify(objectPayload(row.detail_json))],
  )
  if (candidates.length !== 1) return null
  const candidate = candidates[0]
  const [reverseRows] = await connection.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) AS count FROM ${reserveTable} r
     WHERE r.imported=1
       AND ? IN (r.name, JSON_UNQUOTE(JSON_EXTRACT(r.detail_json, '$.name')),
         JSON_UNQUOTE(JSON_EXTRACT(r.detail_json, '$.companyName')),
         JSON_UNQUOTE(JSON_EXTRACT(r.detail_json, '$.business.name')))`,
    [candidate.name],
  )
  return Number(reverseRows[0]?.count || 0) === 1
    ? { leadId: candidate.id, basis: 'mutual-unique-exact-36kr-name' }
    : null
}

async function radarLead(connection: PoolConnection, sourceKey: string) {
  const [rows] = await connection.query<Array<RowDataPacket & { id: string }>>(
    `SELECT id FROM ${leadsTable}
     WHERE JSON_CONTAINS(radar_source_keys, JSON_QUOTE(?)) LIMIT 1`,
    [sourceKey],
  )
  return rows[0]?.id ?? null
}

async function applyReserveBatch(rows: LeadReserveRawRow[], counters: Record<string, number>) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const recordedRows = await recordLeadPipelineRawEventsBatch(
      rows.map(leadReserveRawEventInput),
      connection,
    )
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      const recorded = recordedRows[index]
      counters.rawCreated += Number(recorded.created)
      if (!Boolean(row.imported) && !row.imported_lead_id) {
        counters.discovered += Number(recorded.item.status === 'discovered')
        continue
      }
      const existingLeadId = await existingLead(connection, row.imported_lead_id)
      const resolved = existingLeadId
        ? { leadId: existingLeadId, basis: 'existing-imported-lead-id' }
        : await reserveHistoricalLead(connection, row)
      if (resolved) {
        if (!row.imported_lead_id) {
          await connection.query(
            `UPDATE ${reserveTable} SET imported_lead_id=? WHERE id=? AND imported=1 AND imported_lead_id IS NULL`,
            [resolved.leadId, row.id],
          )
          counters.mappingRecovered += 1
        }
        const transitioned = await transitionLeadPipelineItem(recorded.event.id, {
          status: 'ready',
          reason: 'historical lead_reserve mapping backfilled',
          evidence: [{ reserveId: row.id, srcId: row.src_id, matchBasis: resolved.basis }],
          confidence: 100,
          leadId: resolved.leadId,
          actorType: 'migration',
          actorId: 'lead-pipeline-raw-backfill-v1',
        }, connection)
        counters.ready += Number(transitioned.changed)
      } else {
        const transitioned = await transitionLeadPipelineItem(recorded.event.id, {
          status: 'review',
          reason: 'historical imported reserve row has no unique formal lead source-key match',
          evidence: [{ reserveId: row.id, importedLeadId: row.imported_lead_id }],
          confidence: 100,
          actorType: 'migration',
          actorId: 'lead-pipeline-raw-backfill-v1',
        }, connection)
        counters.review += Number(transitioned.changed)
      }
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

async function applyRadarBatch(rows: RadarRawRow[], counters: Record<string, number>) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const recordedRows = await recordLeadPipelineRawEventsBatch(rows.map((row) => ({
        sourceType: 'radar',
        sourceId: row.source_key,
        sourceOccurredAt: row.collected_at || row.published_at,
        payload: objectPayload(row.payload),
      })), connection)
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      const recorded = recordedRows[index]
      counters.rawCreated += Number(recorded.created)
      const leadId = await radarLead(connection, row.source_key)
      if (leadId) {
        const transitioned = await transitionLeadPipelineItem(recorded.event.id, {
          status: 'ready',
          reason: 'historical radar source mapping backfilled',
          evidence: [{ radarRawEventId: row.id, sourceKey: row.source_key }],
          confidence: 100,
          leadId,
          actorType: 'migration',
          actorId: 'lead-pipeline-raw-backfill-v1',
        }, connection)
        counters.ready += Number(transitioned.changed)
      } else {
        counters.discovered += Number(recorded.item.status === 'discovered')
      }
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

async function main() {
  await ensureSchema()
  const [[reserveCountRows], [radarCountRows], [currentRows]] = await Promise.all([
    pool.query<Array<RowDataPacket & { count: number }>>(`SELECT COUNT(*) AS count FROM ${reserveTable} WHERE detail_json IS NOT NULL`),
    pool.query<Array<RowDataPacket & { count: number }>>(`SELECT COUNT(*) AS count FROM ${radarRawTable}`),
    pool.query<Array<RowDataPacket & { raw_count: number; item_count: number }>>(
      `SELECT
        (SELECT COUNT(*) FROM ${rawTable}) AS raw_count,
        (SELECT COUNT(*) FROM ${itemsTable}) AS item_count`,
    ),
  ])
  const preview = {
    apply,
    reserveEligible: Number(reserveCountRows[0]?.count || 0),
    radarEligible: Number(radarCountRows[0]?.count || 0),
    currentRawEvents: Number(currentRows[0]?.raw_count || 0),
    currentItems: Number(currentRows[0]?.item_count || 0),
  }
  if (!apply) {
    console.log(JSON.stringify({ ok: true, mode: 'preview', ...preview }))
    return
  }

  const counters = { rawCreated: 0, ready: 0, review: 0, discovered: 0, mappingRecovered: 0 }
  let reserveCursor = 0
  for (;;) {
    const [rows] = await pool.query<LeadReserveRawRow[]>(
      `SELECT id, seq, src_id, name, detail_url, detail_json, imported, imported_lead_id, created_at
       FROM ${reserveTable}
       WHERE id>? AND detail_json IS NOT NULL ORDER BY id LIMIT 200`,
      [reserveCursor],
    )
    if (!rows.length) break
    await applyReserveBatch(rows, counters)
    reserveCursor = rows.at(-1)!.id
  }

  let radarCursor = ''
  for (;;) {
    const [rows] = await pool.query<RadarRawRow[]>(
      `SELECT id, source_key, payload, collected_at, published_at
       FROM ${radarRawTable} WHERE id>? ORDER BY id LIMIT 200`,
      [radarCursor],
    )
    if (!rows.length) break
    await applyRadarBatch(rows, counters)
    radarCursor = rows.at(-1)!.id
  }

  const [afterRows] = await pool.query<Array<RowDataPacket & {
    raw_count: number
    item_count: number
    orphan_count: number
    transition_count: number
    discovered_count: number
    ready_count: number
    review_count: number
    rejected_count: number
    failed_count: number
    reserve_imported: number
    reserve_linked_imported: number
    reserve_missing_detail: number
  }>>(
    `SELECT
      (SELECT COUNT(*) FROM ${rawTable}) AS raw_count,
      (SELECT COUNT(*) FROM ${itemsTable}) AS item_count,
      (SELECT COUNT(*) FROM ${itemsTable} i LEFT JOIN ${rawTable} r ON r.id=i.event_id WHERE r.id IS NULL) AS orphan_count,
      (SELECT COUNT(*) FROM ${transitionsTable}) AS transition_count,
      (SELECT COUNT(*) FROM ${itemsTable} WHERE status='discovered') AS discovered_count,
      (SELECT COUNT(*) FROM ${itemsTable} WHERE status='ready') AS ready_count,
      (SELECT COUNT(*) FROM ${itemsTable} WHERE status='review') AS review_count,
      (SELECT COUNT(*) FROM ${itemsTable} WHERE status='rejected') AS rejected_count,
      (SELECT COUNT(*) FROM ${itemsTable} WHERE status='failed') AS failed_count,
      (SELECT COUNT(*) FROM ${reserveTable} WHERE imported=1) AS reserve_imported,
      (SELECT COUNT(*) FROM ${reserveTable} WHERE imported=1 AND imported_lead_id IS NOT NULL) AS reserve_linked_imported,
      (SELECT COUNT(*) FROM ${reserveTable} WHERE detail_json IS NULL) AS reserve_missing_detail`,
  )
  const reconciliation = afterRows[0]
  if (Number(reconciliation?.raw_count || 0) !== Number(reconciliation?.item_count || 0)
    || Number(reconciliation?.orphan_count || 0) !== 0) {
    throw new Error('lead pipeline raw-event reconciliation failed')
  }
  console.log(JSON.stringify({
    ok: true,
    mode: 'apply',
    ...preview,
    ...counters,
    finalRawEvents: Number(reconciliation?.raw_count || 0),
    finalItems: Number(reconciliation?.item_count || 0),
    orphanItems: Number(reconciliation?.orphan_count || 0),
    finalTransitions: Number(reconciliation?.transition_count || 0),
    finalStatuses: {
      discovered: Number(reconciliation?.discovered_count || 0),
      ready: Number(reconciliation?.ready_count || 0),
      review: Number(reconciliation?.review_count || 0),
      rejected: Number(reconciliation?.rejected_count || 0),
      failed: Number(reconciliation?.failed_count || 0),
    },
    reserveImported: Number(reconciliation?.reserve_imported || 0),
    reserveLinkedImported: Number(reconciliation?.reserve_linked_imported || 0),
    reserveMissingDetail: Number(reconciliation?.reserve_missing_detail || 0),
  }))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => await pool.end())
