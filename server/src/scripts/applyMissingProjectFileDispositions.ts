import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'

type Decision = {
  schemaVersion: '1.0'
  decisionId: string
  approvedAt: string
  approvalSource: 'explicit-user-instruction'
  disposition: 'permanently-missing-approved'
  rationale: string
  safeguards: {
    retainMetadata: true
    manufactureOriginalBytes: false
    retainReattachmentCapability: true
    deleteBusinessRecord: false
  }
  fileIdsSha256: string
  fileIds: string[]
}

type MissingFileRow = RowDataPacket & { id: string }

const apply = process.argv.includes('--apply')
const decisionPath = path.resolve('server/migration/project-file-missing-dispositions-20260811.json')
const outputDirectory = path.resolve('.runtime/migration-evidence/project-file-missing-dispositions')
const issueCode = 'PROJECT_FILE_SOURCE_FILE_MISSING_APPROVED'
const migrationType = 'project-file-missing-disposition'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function table(name: string): string {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

function hashIds(ids: string[]): string {
  return createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex')
}

async function loadDecision(): Promise<Decision> {
  const decision = JSON.parse(await readFile(decisionPath, 'utf8')) as Decision
  if (decision.schemaVersion !== '1.0'
    || decision.approvalSource !== 'explicit-user-instruction'
    || decision.disposition !== 'permanently-missing-approved') {
    throw new Error('unsupported missing project file disposition')
  }
  if (!decision.decisionId || !/^\d{4}-\d{2}-\d{2}$/.test(decision.approvedAt) || !decision.rationale.trim()) {
    throw new Error('missing project file disposition metadata is incomplete')
  }
  if (decision.fileIds.length !== new Set(decision.fileIds).size
    || decision.fileIds.some((id) => !uuidPattern.test(id))) {
    throw new Error('missing project file disposition IDs are invalid or duplicated')
  }
  if (hashIds(decision.fileIds) !== decision.fileIdsSha256) {
    throw new Error('missing project file disposition ID checksum mismatch')
  }
  if (!decision.safeguards.retainMetadata
    || decision.safeguards.manufactureOriginalBytes
    || !decision.safeguards.retainReattachmentCapability
    || decision.safeguards.deleteBusinessRecord) {
    throw new Error('missing project file disposition safeguards are unsafe')
  }
  return decision
}

async function loadMissingFiles(connection: PoolConnection, lock = false): Promise<MissingFileRow[]> {
  const [rows] = await connection.query<MissingFileRow[]>(`
    SELECT id FROM ${table('project_files')}
    WHERE storage_path IS NULL OR TRIM(storage_path)=''
    ORDER BY id${lock ? ' FOR UPDATE' : ''}
  `)
  return rows
}

async function approvedKeys(connection: PoolConnection, decision: Decision): Promise<Set<string>> {
  const [rows] = await connection.query<Array<RowDataPacket & { sourceKey: string }>>(`
    SELECT i.source_key AS sourceKey
    FROM ${table('migration_issues')} i
    JOIN ${table('migration_runs')} r ON r.id=i.run_id
    WHERE i.code=? AND i.source_system='business_decision'
      AND i.source_table='project_files' AND r.migration_type=?
      AND r.status='succeeded' AND r.source_sha256=?
  `, [issueCode, migrationType, decision.fileIdsSha256])
  return new Set(rows.map((row) => row.sourceKey))
}

function validateApprovedKeys(decision: Decision, keys: Set<string>): void {
  const approvedIds = new Set(decision.fileIds)
  if ([...keys].some((key) => !approvedIds.has(key))) {
    throw new Error('recorded missing project file dispositions exceed the approved exact scope')
  }
}

function validateExactScope(decision: Decision, rows: MissingFileRow[]): void {
  const actualIds = rows.map((row) => row.id).sort()
  const approvedIds = [...decision.fileIds].sort()
  if (actualIds.length !== approvedIds.length || actualIds.some((id, index) => id !== approvedIds[index])) {
    throw new Error('current missing project file inventory differs from the approved exact scope')
  }
}

async function writeEvidence(report: Record<string, unknown>): Promise<void> {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  await chmod(outputDirectory, 0o700)
  const target = path.resolve(outputDirectory, 'report.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  await chmod(target, 0o600)
}

async function main(): Promise<void> {
  await ensureSchema()
  const decision = await loadDecision()
  const connection = await pool.getConnection()
  let transactionStarted = false
  try {
    const current = await loadMissingFiles(connection)
    validateExactScope(decision, current)
    const existing = await approvedKeys(connection, decision)
    validateApprovedKeys(decision, existing)
    const pending = current.filter((row) => !existing.has(row.id))
    const baseReport = {
      schemaVersion: '1.0', generatedAt: new Date().toISOString(),
      mode: apply ? 'apply' : 'preview', decisionId: decision.decisionId,
      disposition: decision.disposition, sourceSha256: decision.fileIdsSha256,
      counts: {
        approvedScope: decision.fileIds.length,
        currentMissingFiles: current.length,
        alreadyRecorded: existing.size,
        pending: pending.length,
      },
      exactScopeMatched: true,
      metadataRetained: true,
      originalBytesManufactured: false,
      reattachmentCapabilityRetained: true,
      fileIdsExcludedFromEvidence: true,
      fileNamesExcludedFromEvidence: true,
      businessContentExcluded: true,
    }
    if (!apply || pending.length === 0) {
      const report = {
        ...baseReport, ok: true, applied: pending.length === 0,
        appliedNow: false, idempotent: pending.length === 0,
      }
      await writeEvidence(report)
      console.log(JSON.stringify(report))
      return
    }

    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await connection.beginTransaction()
    transactionStarted = true
    const locked = await loadMissingFiles(connection, true)
    validateExactScope(decision, locked)
    const lockedExisting = await approvedKeys(connection, decision)
    validateApprovedKeys(decision, lockedExisting)
    const lockedPending = locked.filter((row) => !lockedExisting.has(row.id))
    if (lockedPending.length !== pending.length
      || lockedExisting.size !== existing.size
      || lockedPending.some((row, index) => row.id !== pending[index]?.id)) {
      throw new Error('approval state changed before disposition apply')
    }

    const runId = randomUUID()
    const runReport = {
      ...baseReport,
      ok: true, applied: true, appliedNow: true, idempotent: false,
      counts: { ...baseReport.counts, recordedNow: lockedPending.length },
    }
    await connection.query(`
      INSERT INTO ${table('migration_runs')}
        (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,
         source_checksum,target_checksum,report,started_at,completed_at)
      VALUES (?,?,?,?,'apply','succeeded',?,?,?,?,?,NOW(3),NOW(3))
    `, [
      runId, migrationType, `version-controlled-decision:${decision.decisionId}`, decision.fileIdsSha256,
      JSON.stringify({ missing_project_files: locked.length }),
      JSON.stringify({ approved_missing_project_files: locked.length, metadata_retained: locked.length }),
      decision.fileIdsSha256, decision.fileIdsSha256, JSON.stringify(runReport),
    ])
    for (const row of lockedPending) {
      await connection.query(`
        INSERT INTO ${table('migration_issues')}
          (id,run_id,severity,source_system,source_table,source_key,code,message,payload)
        VALUES (?,?,'warning','business_decision','project_files',?,?,?,?)
      `, [
        randomUUID(), runId, row.id, issueCode,
        'Missing project file source bytes are explicitly approved as permanently unavailable; metadata is retained.',
        JSON.stringify({
          decisionId: decision.decisionId, disposition: decision.disposition,
          metadataRetained: true, originalBytesManufactured: false,
          reattachmentCapabilityRetained: true,
        }),
      ])
    }
    await connection.commit()
    transactionStarted = false
    await writeEvidence(runReport)
    console.log(JSON.stringify(runReport))
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => undefined)
    throw error
  } finally {
    connection.release()
    await pool.end()
  }
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, message: (error as Error).message }))
  process.exitCode = 1
})
