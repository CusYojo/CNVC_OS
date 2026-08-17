import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'

type MissingRow = RowDataPacket & {
  id: number
  srcId: string | null
  imported: number
  importedLeadId: string | null
  scoreStatus: string
}

const apply = process.argv.includes('--apply')
const issueCode = 'LEAD_RESERVE_SOURCE_DETAIL_MISSING'
const outputDir = path.resolve(process.cwd(), '.runtime/migration-evidence/lead-reserve-missing-detail')

function table(name: string): string {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

function evidenceHash(rows: MissingRow[]): string {
  return createHash('sha256').update(JSON.stringify(rows.map((row) => [row.id, row.srcId]).sort((a, b) => Number(a[0]) - Number(b[0])))).digest('hex')
}

async function writeEvidence(report: Record<string, unknown>): Promise<void> {
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  const reportPath = path.resolve(outputDir, 'report.json')
  const summaryPath = path.resolve(outputDir, 'summary.md')
  const suffix = `.${process.pid}-${Date.now()}`
  await writeFile(`${reportPath}${suffix}`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  const counts = report.counts as Record<string, number>
  const markdown = [
    '# lead_reserve 缺失详情隔离报告', '',
    `生成时间：${report.generatedAt}`, '',
    `- 缺失 detail_json：${counts.missingDetail}`,
    `- 待隔离：${counts.planned}`,
    `- 已隔离并有台账：${counts.alreadyQuarantined}`,
    `- 阻断状态冲突：${counts.blockers}`, '',
    '隔离仅把未导入、未绑定线索且缺少 `detail_json` 的记录标记为 `source_missing`，原始行保留；每条记录在 `migration_issues` 保存源键和基线哈希。隔离不等于源详情已恢复。',
  ].join('\n')
  await writeFile(`${summaryPath}${suffix}`, markdown, { mode: 0o600 })
  await rename(`${reportPath}${suffix}`, reportPath)
  await rename(`${summaryPath}${suffix}`, summaryPath)
}

async function main(): Promise<void> {
  await ensureSchema()
  const [rows] = await pool.query<MissingRow[]>(`
    SELECT id,src_id AS srcId,imported,imported_lead_id AS importedLeadId,score_status AS scoreStatus
    FROM ${table('lead_reserve')} WHERE detail_json IS NULL ORDER BY id
  `)
  const sourceSha256 = evidenceHash(rows)
  const [issueRows] = await pool.query<Array<RowDataPacket & { sourceKey: string; sourceSha256: string; runId: string }>>(`
    SELECT i.source_key AS sourceKey,r.source_sha256 AS sourceSha256,r.id AS runId
    FROM ${table('migration_issues')} i JOIN ${table('migration_runs')} r ON r.id=i.run_id
    WHERE i.source_system='postgres_dump' AND i.source_table='lead_reserve' AND i.code=? AND r.status='succeeded'
  `, [issueCode])
  const issueById = new Map(issueRows.map((row) => [row.sourceKey, row.sourceSha256]))
  const successfulRunIds = [...new Set(issueRows
    .filter((row) => row.sourceSha256 === sourceSha256)
    .map((row) => row.runId))]
  const planned = rows.filter((row) => row.scoreStatus === 'not_requested' && !Boolean(row.imported) && !row.importedLeadId)
  const alreadyQuarantined = rows.filter((row) =>
    row.scoreStatus === 'source_missing' && issueById.get(String(row.id)) === sourceSha256)
  const blockers = rows.filter((row) => !planned.includes(row) && !alreadyQuarantined.includes(row)).map((row) => ({
    id: row.id, scoreStatus: row.scoreStatus, imported: Boolean(row.imported), linked: Boolean(row.importedLeadId),
  }))
  const baseReport = {
    schemaVersion: '1.0', generatedAt: new Date().toISOString(), mode: apply ? 'apply' : 'preview',
    sourceSha256,
    counts: {
      missingDetail: rows.length, planned: planned.length,
      alreadyQuarantined: alreadyQuarantined.length, blockers: blockers.length,
    },
    blockers,
    policy: 'retain-row-and-quarantine-missing-source-detail-with-durable-issue-ledger',
  }
  if (blockers.length) {
    await writeEvidence({ ...baseReport, ok: false, applied: false })
    throw new Error(`lead_reserve missing-detail quarantine blocked by ${blockers.length} state conflict(s)`)
  }
  if (!apply || planned.length === 0) {
    const ledgerVerified = rows.length > 0 && alreadyQuarantined.length === rows.length
    const report = {
      ...baseReport, ok: true, applied: ledgerVerified, appliedNow: false,
      idempotent: planned.length === 0, successfulRunIds,
    }
    await writeEvidence(report)
    console.log(JSON.stringify(report))
    return
  }

  const connection = await pool.getConnection()
  const runId = randomUUID()
  try {
    await connection.beginTransaction()
    const [locked] = await connection.query<MissingRow[]>(`
      SELECT id,src_id AS srcId,imported,imported_lead_id AS importedLeadId,score_status AS scoreStatus
      FROM ${table('lead_reserve')} WHERE detail_json IS NULL ORDER BY id FOR UPDATE
    `)
    if (evidenceHash(locked) !== sourceSha256
      || locked.some((row) => row.scoreStatus !== 'not_requested' || Boolean(row.imported) || row.importedLeadId)) {
      throw new Error('lead_reserve missing-detail source changed before quarantine')
    }
    await connection.query(`
      UPDATE ${table('lead_reserve')}
      SET score_status='source_missing',score_last_error='source detail_json missing at migration baseline'
      WHERE detail_json IS NULL AND score_status='not_requested' AND imported=0 AND imported_lead_id IS NULL
    `)
    const runReport = {
      ...baseReport, ok: true, applied: true, runId,
      tables: [{
        table: 'lead_reserve', sourceRows: rows.length, targetRowsAfter: rows.length,
        readRows: rows.length, writtenRows: rows.length, skippedRows: 0, failedRows: 0,
        sourceHash: sourceSha256, targetHash: sourceSha256, status: 'verified',
      }],
    }
    await connection.query(`
      INSERT INTO ${table('migration_runs')}
        (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,
         source_checksum,target_checksum,report,started_at,completed_at)
      VALUES (?,?,?,?,?,'succeeded',?,?,?,?,?,NOW(3),NOW(3))
    `, [
      runId, 'lead-reserve-missing-detail-quarantine', 'cybernaut_mvp_dump.sql:lead_reserve',
      sourceSha256, 'apply', JSON.stringify({ lead_reserve_missing_detail: rows.length }),
      JSON.stringify({ lead_reserve_quarantined: rows.length }), sourceSha256, sourceSha256,
      JSON.stringify(runReport),
    ])
    for (const row of rows) {
      await connection.query(`
        INSERT INTO ${table('migration_issues')}
          (id,run_id,severity,source_system,source_table,source_key,code,message,payload)
        VALUES (?,?,'warning','postgres_dump','lead_reserve',?,?,?,?)
      `, [
        randomUUID(), runId, String(row.id), issueCode,
        'Source lead_reserve row has no detail_json and is retained in source_missing quarantine.',
        JSON.stringify({ srcId: row.srcId, sourceSha256, decision: 'retained-source-missing' }),
      ])
    }
    await connection.commit()
    await writeEvidence(runReport)
    console.log(JSON.stringify(runReport))
  } catch (error) {
    await connection.rollback().catch(() => undefined)
    throw error
  } finally {
    connection.release()
  }
}

await main().finally(async () => pool.end())
