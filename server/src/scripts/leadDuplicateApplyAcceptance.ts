import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  leadDuplicateGroupId, leadRowFingerprint, sha256,
  type LeadDuplicateCollision, type LeadDuplicateDispositionFile, type LeadSnapshot,
} from './leadDuplicateDispositionContract.js'
import { applyApprovedLeadDuplicateDispositions } from './leadDuplicateDispositionApplyRuntime.js'

function table(name: string) {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

function check(condition: unknown, name: string, checks: string[]) {
  if (!condition) throw new Error(`lead duplicate apply acceptance failed: ${name}`)
  checks.push(name)
}

async function count(sql: string, params: unknown[] = []) {
  const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(sql, params)
  return Number(rows[0]?.count || 0)
}

async function main() {
  const marker = randomUUID()
  const canonicalId = randomUUID()
  const mergedId = randomUUID()
  const eventId = `lead-duplicate-apply-${marker}`
  const matchId = randomUUID()
  const runId = randomUUID()
  const checks: string[] = []
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.query(
      `INSERT INTO ${table('leads')}
        (id,name,company_name,source,pool_status,score,radar_source_keys,created_at)
       VALUES (?,?,?,'lead-duplicate-apply-acceptance','成功',0,JSON_ARRAY('source-canonical'),NOW(3)),
              (?,?,?,'lead-duplicate-apply-acceptance','成功',0,JSON_ARRAY('source-merged'),NOW(3))`,
      [canonicalId, `重复线索执行验收-${marker}`, `执行验收公司-${marker}`,
        mergedId, `重复线索执行验收-${marker}`, `执行验收公司-${marker}`],
    )
    await connection.query(`INSERT INTO ${table('lead_score_jobs')} (lead_id) VALUES (?)`, [mergedId])
    await connection.query(
      `INSERT INTO ${table('lead_pipeline_raw_events')}
        (id,source_type,source_id,source_id_hash,content_hash,idempotency_key,payload,ingested_at)
       VALUES (?,'acceptance',?,SHA2(?,256),SHA2(?,256),SHA2(?,256),JSON_OBJECT('fixture',true),NOW(3))`,
      [eventId, marker, marker, `${marker}:content`, `${marker}:idempotency`],
    )
    await connection.query(
      `INSERT INTO ${table('lead_pipeline_items')} (event_id,status,lead_id) VALUES (?,'ready',?)`,
      [eventId, mergedId],
    )
    await connection.query(
      `INSERT INTO ${table('lead_pipeline_entity_matches')}
        (id,match_key,event_id,subject_name,normalized_subject_name,match_type,candidate_lead_id,
         candidate_name,candidate_company_name,status,resolution_type,aliases,metadata,created_at)
       VALUES (?,?,?,? ,?,'exact',?,?,?,'selected','automatic',JSON_ARRAY(),JSON_OBJECT(),NOW(3))`,
      [matchId, sha256(`${marker}:match`), eventId, `重复线索执行验收-${marker}`,
        `重复线索执行验收-${marker}`.toLowerCase(), mergedId,
        `旧候选名-${marker}`, `旧候选公司-${marker}`],
    )
    await connection.query(
      `INSERT INTO ${table('lead_reserve')}
        (seq,src_id,name,detail_json,imported,imported_at,imported_lead_id,score_status,created_at)
       VALUES (NULL,?,?,JSON_OBJECT('fixture',true),1,NOW(3),?,'done',NOW(3))`,
      [`acceptance-${marker}`, `重复线索执行验收-${marker}`, mergedId],
    )
    const [rows] = await connection.query<Array<RowDataPacket & LeadSnapshot>>(
      `SELECT * FROM ${table('leads')} WHERE id IN (?,?) ORDER BY id`, [canonicalId, mergedId])
    const rowsById = new Map(rows.map((row) => [row.id, { ...row } as LeadSnapshot]))
    const collision: LeadDuplicateCollision = {
      field: 'leads.name', comparisonKey: `重复线索执行验收-${marker}`.toLowerCase(),
      kind: 'exact-duplicate',
      records: [canonicalId, mergedId].sort().map((id) => ({ id, value: `重复线索执行验收-${marker}` })),
    }
    const file: LeadDuplicateDispositionFile = {
      schemaVersion: '1.0', decisionSetId: 'lead-duplicate-dispositions-20260811', revision: 1,
      generatedAt: '2026-08-11T08:00:00.000Z',
      normalization: 'NFKC + trim + collapse Unicode whitespace + lowercase comparison',
      normalizationReportSha256: sha256('acceptance-normalization-report'),
      scope: { collisionGroups: 1, collisionRecordOccurrences: 2, uniqueLeadRecords: 2 },
      safeguards: {
        noAutomaticSelection: true, physicalDeleteForbidden: true, preserveAuditHistory: true,
        transactionalApplyRequired: true, revalidateLiveRows: true,
      },
      groups: [{
        groupId: leadDuplicateGroupId(collision), field: collision.field,
        comparisonKey: collision.comparisonKey, kind: collision.kind,
        records: collision.records.map((record) => ({
          ...record, rowFingerprint: leadRowFingerprint(rowsById.get(record.id) as LeadSnapshot),
        })),
        decision: {
          decisionRevision: 1, action: 'merge', canonicalLeadId: canonicalId,
          mergedLeadIds: [mergedId], reason: '验收明确批准将夹具记录合并到主记录',
          approvedBy: '迁移验收负责人', approvedAt: '2026-08-11T08:00:00.000Z',
        },
      }],
    }
    const result = await applyApprovedLeadDuplicateDispositions({
      connection, file, decisionFileSha256: sha256(JSON.stringify(file)), runId,
    })
    check(result.mergedLeadRecords === 1 && result.physicalDeletes === 0,
      'approved-merge-preserves-source-lead-row', checks)
    const [leadStates] = await connection.query<Array<RowDataPacket & {
      id: string; poolStatus: string; radarSourceKeys: unknown
    }>>(`SELECT id,pool_status poolStatus,radar_source_keys radarSourceKeys
         FROM ${table('leads')} WHERE id IN (?,?) ORDER BY id`, [canonicalId, mergedId])
    const canonical = leadStates.find((row) => row.id === canonicalId)
    const merged = leadStates.find((row) => row.id === mergedId)
    const canonicalKeys = Array.isArray(canonical?.radarSourceKeys) ? canonical.radarSourceKeys
      : JSON.parse(String(canonical?.radarSourceKeys || '[]'))
    check(leadStates.length === 2 && merged?.poolStatus === '已合并'
      && canonicalKeys.includes('source-canonical') && canonicalKeys.includes('source-merged'),
    'source-keys-consolidated-and-merged-row-archived', checks)
    for (const [tableName, column] of [
      ['lead_score_jobs', 'lead_id'], ['lead_pipeline_items', 'lead_id'],
      ['lead_pipeline_entity_matches', 'candidate_lead_id'], ['lead_reserve', 'imported_lead_id'],
    ] as const) {
      const [referenceRows] = await connection.query<Array<RowDataPacket & { oldCount: number; canonicalCount: number }>>(
        `SELECT SUM(${column}=?) oldCount,SUM(${column}=?) canonicalCount FROM ${table(tableName)}
         WHERE ${column} IN (?,?)`, [mergedId, canonicalId, mergedId, canonicalId])
      check(Number(referenceRows[0]?.oldCount || 0) === 0 && Number(referenceRows[0]?.canonicalCount || 0) === 1,
        `${tableName}-reference-moved-exactly-once`, checks)
    }
    const [ledgerRows] = await connection.query<Array<RowDataPacket & {
      runs: number; issues: number; mappings: number; audits: number
    }>>(`SELECT
      (SELECT COUNT(*) FROM ${table('migration_runs')} WHERE id=?) runs,
      (SELECT COUNT(*) FROM ${table('migration_issues')} WHERE run_id=?) issues,
      (SELECT COUNT(*) FROM ${table('migration_entity_mappings')} WHERE run_id=?) mappings,
      (SELECT COUNT(*) FROM ${table('audit_logs')} WHERE request_id=?) audits`,
    [runId, runId, runId, `migration:${runId}`])
    check(Number(ledgerRows[0]?.runs) === 1 && Number(ledgerRows[0]?.issues) === 1
      && Number(ledgerRows[0]?.mappings) === 1 && Number(ledgerRows[0]?.audits) === 1,
    'run-issue-mapping-and-audit-ledger-are-atomic', checks)
    await connection.rollback()
  } catch (error) {
    await connection.rollback().catch(() => undefined)
    throw error
  } finally {
    connection.release()
  }

  check(await count(`SELECT COUNT(*) count FROM ${table('leads')} WHERE id IN (?,?)`, [canonicalId, mergedId]) === 0,
    'transaction-probe-removes-all-lead-fixtures', checks)
  check(await count(`SELECT COUNT(*) count FROM ${table('migration_runs')} WHERE id=?`, [runId]) === 0,
    'transaction-probe-removes-all-ledger-fixtures', checks)
  console.log(JSON.stringify({ ok: true, checks, transactionProbeRolledBack: true, databaseWrites: 0 }))
}

await main().finally(async () => pool.end())
