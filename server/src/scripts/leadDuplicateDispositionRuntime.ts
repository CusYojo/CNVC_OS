import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  buildLeadDuplicateCollisions, collisionSignature, createLeadDuplicateDispositionTemplate,
  LEAD_DUPLICATE_NORMALIZATION, sha256,
  type LeadDuplicateCollision, type LeadDuplicateDispositionFile, type LeadSnapshot,
} from './leadDuplicateDispositionContract.js'

type NormalizationReport = {
  schemaVersion: string
  normalization: string
  collisions: Array<LeadDuplicateCollision & { field: string }>
}

const defaultReportPath = path.resolve('.runtime/migration-evidence/mysql-normalization/report.json')

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code)
}

export async function loadCurrentLeadDuplicateDispositionContext(reportPath = defaultReportPath): Promise<{
  expected: LeadDuplicateDispositionFile
  reportSha256: string
  collisionSignature: string
}> {
  const reportSource = await readFile(reportPath, 'utf8')
  const report = JSON.parse(reportSource) as NormalizationReport
  assert(report.schemaVersion === '1.0' && report.normalization === LEAD_DUPLICATE_NORMALIZATION
    && Array.isArray(report.collisions), 'LEAD_DUPLICATE_REPORT_INVALID')
  const reportCollisions = report.collisions.filter((collision): collision is LeadDuplicateCollision =>
    collision.field === 'leads.name' || collision.field === 'leads.company_name')
  assert(reportCollisions.length === report.collisions.length, 'LEAD_DUPLICATE_REPORT_HAS_UNSUPPORTED_SCOPE')

  const table = quoteMysqlIdentifier(mysqlTableName('leads'))
  const [rawRows] = await pool.query<Array<RowDataPacket & LeadSnapshot>>(
    `SELECT * FROM ${table} WHERE pool_status<>'已合并' ORDER BY id`,
  )
  const rows = rawRows.map((row) => ({ ...row })) as LeadSnapshot[]
  const liveCollisions = buildLeadDuplicateCollisions(rows)
  assert(collisionSignature(liveCollisions) === collisionSignature(reportCollisions), 'LEAD_DUPLICATE_BASELINE_STALE')
  const reportSha256 = sha256(reportSource)
  return {
    expected: createLeadDuplicateDispositionTemplate({
      collisions: liveCollisions,
      rows,
      normalizationReportSha256: reportSha256,
    }),
    reportSha256,
    collisionSignature: collisionSignature(liveCollisions),
  }
}
