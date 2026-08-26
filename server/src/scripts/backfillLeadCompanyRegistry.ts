import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  meaningfulLeadRegistryText,
  normalizeLeadFoundedAt,
  normalizeLeadRegistry,
} from '../services/leadRegistry.js'

type BackfillRow = RowDataPacket & {
  lead_id: string
  lead_name: string
  scoring: Record<string, unknown> | string | null
  detail_json: Record<string, unknown> | string | null
}

const apply = process.argv.includes('--apply')
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const reserveTable = quoteMysqlIdentifier(mysqlTableName('lead_reserve'))
const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))

function objectValue(value: unknown): Record<string, any> {
  if (!value) return {}
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, any> } catch { return {} }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function stableRecord(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
}

const [rows] = await pool.query<BackfillRow[]>(
  `SELECT l.id AS lead_id,l.name AS lead_name,l.scoring,r.detail_json
   FROM ${reserveTable} r
   JOIN ${leadsTable} l ON l.id=r.imported_lead_id
   WHERE r.imported=1 AND r.imported_lead_id IS NOT NULL AND r.detail_json IS NOT NULL
     AND l.pool_status<>'已删除' AND l.pool_status<>'已合并'
   ORDER BY r.id`,
)

const patches: Array<{ id: string; name: string; scoring: Record<string, unknown>; fields: string[] }> = []
const summary = {
  scanned: rows.length,
  candidates: 0,
  foundedAtAdded: 0,
  legalRepresentativeAdded: 0,
  registeredAddressAdded: 0,
  companyNameAdded: 0,
  suspectRegisteredCapitalRemoved: 0,
  sourceOwnedFieldsRefreshed: 0,
}

for (const row of rows) {
  const scoring = objectValue(row.scoring)
  const current = objectValue(scoring.registry)
  const priorBackfill = objectValue(scoring.registryBackfill)
  const priorFields = new Set(
    Array.isArray(priorBackfill.fields)
      ? priorBackfill.fields.filter((value: unknown): value is string => typeof value === 'string')
      : [],
  )
  const detail = objectValue(row.detail_json)
  const business = objectValue(detail.business)
  const source = normalizeLeadRegistry({
    companyName: business.name || detail.companyName,
    foundedAt: normalizeLeadFoundedAt(business.estiblishTime || detail.setupDate),
    legalRepresentative: business.legalPersonName,
    registeredAddress: business.regLocation,
  })
  const sanitizedCurrent = { ...current }
  // Values previously owned by this source may be refreshed from the retained raw detail.
  // This makes the backfill repairable without allowing the source to overwrite external research.
  for (const field of ['companyName', 'foundedAt', 'legalRepresentative', 'registeredAddress']) {
    if (!priorFields.has(field)) continue
    delete sanitizedCurrent[field]
    if (field === 'registeredAddress') delete sanitizedCurrent.regLocation
  }
  const shareholderAmount = meaningfulLeadRegistryText(objectValue(
    Array.isArray(business.shareholder) ? business.shareholder[0] : undefined,
  ).amomon)
  const currentCapital = meaningfulLeadRegistryText(current.registeredCapital)
  const removeSuspectCapital = Boolean(
    shareholderAmount
    && currentCapital === shareholderAmount
    && !meaningfulLeadRegistryText(scoring.publicIntelUpdatedAt),
  )
  if (removeSuspectCapital) delete sanitizedCurrent.registeredCapital

  const merged = normalizeLeadRegistry(sanitizedCurrent, source)
  const fields: string[] = []
  if (!meaningfulLeadRegistryText(current.foundedAt) && meaningfulLeadRegistryText(merged.foundedAt)) {
    fields.push('foundedAt'); summary.foundedAtAdded += 1
  }
  if (!meaningfulLeadRegistryText(current.legalRepresentative) && meaningfulLeadRegistryText(merged.legalRepresentative)) {
    fields.push('legalRepresentative'); summary.legalRepresentativeAdded += 1
  }
  if (!meaningfulLeadRegistryText(current.registeredAddress) && meaningfulLeadRegistryText(merged.registeredAddress)) {
    fields.push('registeredAddress'); summary.registeredAddressAdded += 1
  }
  if (!meaningfulLeadRegistryText(current.companyName) && meaningfulLeadRegistryText(merged.companyName)) {
    fields.push('companyName'); summary.companyNameAdded += 1
  }
  if (removeSuspectCapital) {
    fields.push('registeredCapital:removed-invalid-shareholder-amount')
    summary.suspectRegisteredCapitalRemoved += 1
  }
  const registryChanged = JSON.stringify(stableRecord(current)) !== JSON.stringify(stableRecord(merged))
  if (!fields.length && !registryChanged) continue
  if (!fields.length && registryChanged && priorFields.size) summary.sourceOwnedFieldsRefreshed += 1
  const recordedFields = [...new Set([...priorFields, ...fields])]
  patches.push({
    id: row.lead_id,
    name: row.lead_name,
    scoring: {
      ...scoring,
      registry: merged,
      registryBackfill: {
        source: '36kr-reserve-detail',
        fields: recordedFields,
      },
    },
    fields: recordedFields,
  })
}
summary.candidates = patches.length

if (apply && patches.length) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    for (const patch of patches) {
      await connection.query(
        `UPDATE ${leadsTable} SET scoring=? WHERE id=?`,
        [JSON.stringify(patch.scoring), patch.id],
      )
    }
    await connection.query(
      `INSERT INTO ${auditTable}
        (id,user_id,user_name,module,action,target,result,request_id,created_at)
       VALUES (?,NULL,'（系统）','项目获取池','回填企业工商字段',?,'success',?,NOW(3))`,
      [
        randomUUID(),
        JSON.stringify(summary),
        randomUUID(),
      ],
    )
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

console.log(JSON.stringify({ ok: true, mode: apply ? 'apply' : 'preview', ...summary }, null, 2))
await pool.end()
