import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { assertSchemaReady } from '../db/migrate.js'
import {
  aiArtifactGapRecord,
  leadReserveGapRecord,
  validateSourceGapDisposition,
  type AiArtifactGapRecord,
  type LeadReserveGapRecord,
  type SourceGapDispositionDocument,
} from './sourceGapDispositionContract.js'
import { collectCurrentSourceGaps, parseSourceGapDisposition } from './sourceGapDispositionRuntime.js'

const apply = process.argv.includes('--apply')
const probeRollback = process.argv.includes('--probe-rollback')
if (apply && probeRollback) throw new Error('--apply and --probe-rollback are mutually exclusive')
const decisionPath = path.resolve(
  process.env.SOURCE_GAP_DISPOSITIONS_FILE || '.runtime/migration-decisions/source-gap-dispositions.json',
)
const evidenceDirectory = path.resolve('.runtime/migration-evidence/source-gap-dispositions')

const domains = {
  leadReserve: {
    migrationType: 'lead-reserve-source-gap-disposition',
    sourceTable: 'lead_reserve',
    issueCode: 'LEAD_RESERVE_PERMANENT_SOURCE_GAP_APPROVED',
    sourceCountKey: 'missing_detail_rows',
    targetCountKey: 'approved_permanent_quarantine_rows',
  },
  aiArtifacts: {
    migrationType: 'ai-artifact-source-gap-disposition',
    sourceTable: 'ai_artifacts',
    issueCode: 'AI_ARTIFACT_PERMANENT_SOURCE_GAP_APPROVED',
    sourceCountKey: 'missing_source_artifacts',
    targetCountKey: 'approved_permanent_archive_artifacts',
  },
} as const

function table(name: string): string {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

async function loadDecision(): Promise<{ document: SourceGapDispositionDocument; sha256: string }> {
  const stat = await lstat(decisionPath)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('source-gap disposition must be an owner-only regular file')
  }
  const bytes = await readFile(decisionPath)
  return {
    document: parseSourceGapDisposition(JSON.parse(bytes.toString('utf8'))),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

async function collectLocked(connection: PoolConnection) {
  const [leadRows, artifactRows] = await Promise.all([
    connection.query<Array<RowDataPacket & {
      id: number; srcId: string | null; imported: number; importedLeadId: string | null; scoreStatus: string
    }>>(`
      SELECT id,src_id AS srcId,imported,imported_lead_id AS importedLeadId,score_status AS scoreStatus
      FROM ${table('lead_reserve')} WHERE detail_json IS NULL ORDER BY id FOR UPDATE
    `).then(([rows]) => rows),
    connection.query<Array<RowDataPacket & {
      id: string; taskId: string; taskType: string; userId: string; projectId: string
      fileName: string; format: string; storagePath: string; qualityStatus: string; archived: number
    }>>(`
      SELECT a.id,a.task_id AS taskId,t.type AS taskType,a.user_id AS userId,a.project_id AS projectId,
        a.file_name AS fileName,a.format,a.storage_path AS storagePath,
        a.quality_status AS qualityStatus,a.archived
      FROM ${table('ai_artifacts')} a JOIN ${table('ai_tasks')} t ON t.id=a.task_id
      WHERE a.storage_path REGEXP '^/Users/[^/]+/' ORDER BY a.id FOR UPDATE
    `).then(([rows]) => rows),
  ])
  return {
    leadReserve: leadRows.map(leadReserveGapRecord),
    aiArtifacts: artifactRows.map(aiArtifactGapRecord),
  }
}

async function existingApprovals(
  connection: PoolConnection,
  config: typeof domains[keyof typeof domains],
  baselineSha256: string,
): Promise<Map<string, Record<string, unknown>>> {
  const [rows] = await connection.query<Array<RowDataPacket & { sourceKey: string; payload: string | Record<string, unknown> }>>(`
    SELECT i.source_key AS sourceKey,i.payload
    FROM ${table('migration_issues')} i JOIN ${table('migration_runs')} r ON r.id=i.run_id
    WHERE i.source_system='business_decision' AND i.source_table=? AND i.code=?
      AND r.migration_type=? AND r.source_sha256=? AND r.status='succeeded'
  `, [config.sourceTable, config.issueCode, config.migrationType, baselineSha256])
  return new Map(rows.map((row) => [row.sourceKey, typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload]))
}

function validateExisting<T extends { id: string | number; fingerprintSha256: string }>(
  label: string,
  records: T[],
  existing: Map<string, Record<string, unknown>>,
  disposition: string,
): void {
  if (existing.size !== 0 && existing.size !== records.length) throw new Error(`${label} approved ledger is partial`)
  const expected = new Map(records.map((record) => [String(record.id), record]))
  for (const [key, payload] of existing) {
    const record = expected.get(key)
    if (!record || payload.fingerprintSha256 !== record.fingerprintSha256 || payload.disposition !== disposition) {
      throw new Error(`${label} approved ledger differs from the exact disposition baseline`)
    }
  }
}

function leadPayload(record: LeadReserveGapRecord, document: SourceGapDispositionDocument) {
  return {
    disposition: document.leadReserve.disposition,
    fingerprintSha256: record.fingerprintSha256,
    sourceKeySha256: record.sourceKeySha256,
    rationale: document.leadReserve.rationale,
    approvedBy: document.leadReserve.approvedBy,
    approvedAt: document.leadReserve.approvedAt,
    sourceBytesOrDetailManufactured: false,
  }
}

function artifactPayload(record: AiArtifactGapRecord, document: SourceGapDispositionDocument) {
  return {
    disposition: document.aiArtifacts.disposition,
    fingerprintSha256: record.fingerprintSha256,
    taskType: record.taskType,
    format: record.format,
    taskIdSha256: record.taskIdSha256,
    userIdSha256: record.userIdSha256,
    projectIdSha256: record.projectIdSha256,
    fileNameSha256: record.fileNameSha256,
    storagePathSha256: record.storagePathSha256,
    qualityStatus: record.qualityStatus,
    archived: record.archived ? 1 : 0,
    rationale: document.aiArtifacts.rationale,
    approvedBy: document.aiArtifacts.approvedBy,
    approvedAt: document.aiArtifacts.approvedAt,
    sourceBytesOrDetailManufactured: false,
  }
}

async function insertDomain(
  connection: PoolConnection,
  input: {
    config: typeof domains[keyof typeof domains]
    baselineSha256: string
    decisionSha256: string
    records: Array<{ id: string | number; fingerprintSha256: string }>
    payload: (record: never) => Record<string, unknown>
  },
): Promise<number> {
  if (!input.records.length) return 0
  const runId = randomUUID()
  const runReport = {
    schemaVersion: '1.0', mode: probeRollback ? 'probe-rollback' : 'apply',
    migrationType: input.config.migrationType, decisionSha256: input.decisionSha256,
    baselineSha256: input.baselineSha256, approvedRecords: input.records.length,
    exactScopeMatched: true, sourceBytesOrDetailManufactured: false,
    approvalIdentitiesExcluded: true, businessContentExcluded: true,
  }
  await connection.query(`
    INSERT INTO ${table('migration_runs')}
      (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,
       source_checksum,target_checksum,report,started_at,completed_at)
    VALUES (?,?,?,?,'apply','succeeded',?,?,?,?,?,NOW(3),NOW(3))
  `, [
    runId, input.config.migrationType, `private-decision-sha256:${input.decisionSha256}`, input.baselineSha256,
    JSON.stringify({ [input.config.sourceCountKey]: input.records.length }),
    JSON.stringify({ [input.config.targetCountKey]: input.records.length }),
    input.baselineSha256, input.baselineSha256, JSON.stringify(runReport),
  ])
  for (const record of input.records) {
    await connection.query(`
      INSERT INTO ${table('migration_issues')}
        (id,run_id,severity,source_system,source_table,source_key,code,message,payload)
      VALUES (?,?,'warning','business_decision',?,?,?,?,?)
    `, [
      randomUUID(), runId, input.config.sourceTable, String(record.id), input.config.issueCode,
      'Missing source data is explicitly approved for permanent quarantine or archive; no source content is manufactured.',
      JSON.stringify(input.payload(record as never)),
    ])
  }
  return input.records.length
}

async function writeEvidence(report: Record<string, unknown>): Promise<void> {
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
  await chmod(evidenceDirectory, 0o700)
  const target = path.join(evidenceDirectory, 'application.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  await chmod(target, 0o600)
}

async function main(): Promise<void> {
  await assertSchemaReady()
  const decision = await loadDecision()
  const current = await collectCurrentSourceGaps()
  const errors = validateSourceGapDisposition(decision.document, current, true)
  if (errors.length) {
    console.log(JSON.stringify({ ok: false, mode: 'strict', errors, databaseWrites: 0 }))
    process.exitCode = decision.document.leadReserve.disposition === 'pending'
      || decision.document.aiArtifacts.disposition === 'pending' ? 2 : 1
    return
  }
  const connection = await pool.getConnection()
  let transactionStarted = false
  try {
    const leadExisting = await existingApprovals(connection, domains.leadReserve, decision.document.leadReserve.baselineSha256)
    const artifactExisting = await existingApprovals(connection, domains.aiArtifacts, decision.document.aiArtifacts.baselineSha256)
    validateExisting('lead reserve', current.leadReserve, leadExisting, decision.document.leadReserve.disposition)
    validateExisting('AI artifacts', current.aiArtifacts, artifactExisting, decision.document.aiArtifacts.disposition)
    const planned = (leadExisting.size ? 0 : current.leadReserve.length) + (artifactExisting.size ? 0 : current.aiArtifacts.length)
    const baseReport = {
      schemaVersion: '1.0', generatedAt: new Date().toISOString(),
      mode: probeRollback ? 'probe-rollback' : apply ? 'apply' : 'preview',
      decisionSha256: decision.sha256,
      counts: {
        leadReserveApprovedScope: current.leadReserve.length,
        aiArtifactApprovedScope: current.aiArtifacts.length,
        alreadyRecorded: leadExisting.size + artifactExisting.size,
        planned,
      },
      exactScopeMatched: true, sourceBytesOrDetailManufactured: false,
      approvalIdentitiesExcluded: true, fileNamesExcludedFromEvidence: true,
      businessContentExcluded: true,
    }
    if ((!apply && !probeRollback) || planned === 0) {
      const report = { ...baseReport, ok: true, applied: planned === 0, appliedNow: false, idempotent: planned === 0, databaseWrites: 0 }
      await writeEvidence(report)
      console.log(JSON.stringify(report))
      return
    }

    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await connection.beginTransaction()
    transactionStarted = true
    const locked = await collectLocked(connection)
    const lockedErrors = validateSourceGapDisposition(decision.document, locked, true)
    if (lockedErrors.length) throw new Error(`source-gap baseline changed before apply: ${lockedErrors.join(',')}`)
    const lockedLeadExisting = await existingApprovals(connection, domains.leadReserve, decision.document.leadReserve.baselineSha256)
    const lockedArtifactExisting = await existingApprovals(connection, domains.aiArtifacts, decision.document.aiArtifacts.baselineSha256)
    validateExisting('lead reserve', locked.leadReserve, lockedLeadExisting, decision.document.leadReserve.disposition)
    validateExisting('AI artifacts', locked.aiArtifacts, lockedArtifactExisting, decision.document.aiArtifacts.disposition)
    if (lockedLeadExisting.size !== leadExisting.size || lockedArtifactExisting.size !== artifactExisting.size) {
      throw new Error('source-gap approval ledger changed before apply')
    }
    let written = 0
    if (!lockedLeadExisting.size) written += await insertDomain(connection, {
      config: domains.leadReserve, baselineSha256: decision.document.leadReserve.baselineSha256,
      decisionSha256: decision.sha256, records: locked.leadReserve,
      payload: (record) => leadPayload(record as LeadReserveGapRecord, decision.document),
    })
    if (!lockedArtifactExisting.size) written += await insertDomain(connection, {
      config: domains.aiArtifacts, baselineSha256: decision.document.aiArtifacts.baselineSha256,
      decisionSha256: decision.sha256, records: locked.aiArtifacts,
      payload: (record) => artifactPayload(record as AiArtifactGapRecord, decision.document),
    })
    const report = {
      ...baseReport, ok: true,
      applied: apply, appliedNow: apply, idempotent: false,
      transactionalRecordsWritten: written + (written ? 2 : 0),
      probeRolledBack: probeRollback,
      databaseWrites: apply ? written + (written ? 2 : 0) : 0,
    }
    if (probeRollback) {
      await connection.rollback()
      transactionStarted = false
    } else {
      await connection.commit()
      transactionStarted = false
    }
    await writeEvidence(report)
    console.log(JSON.stringify(report))
  } finally {
    if (transactionStarted) await connection.rollback().catch(() => undefined)
    connection.release()
  }
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, message: (error as Error).message }))
  process.exitCode = 1
}).finally(async () => pool.end())
