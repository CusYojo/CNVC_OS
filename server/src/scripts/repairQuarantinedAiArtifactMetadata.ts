import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { loadLegacyAiArtifactSources } from './postgresDumpAiArtifactSource.js'

type TargetArtifact = RowDataPacket & {
  id: string
  storagePath: string
  metadata: Record<string, unknown> | string
}

const apply = process.argv.includes('--apply')
const evidenceDirectory = path.resolve('.runtime/migration-evidence/missing-file-assets')

function table(name: string): string {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  }
  return {}
}

function hashPath(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function writeEvidence(report: Record<string, unknown>): Promise<void> {
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
  const target = path.join(evidenceDirectory, 'metadata-repair.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

async function main(): Promise<void> {
  const source = await loadLegacyAiArtifactSources()
  const connection = await pool.getConnection()
  let transactionStarted = false
  try {
    const [rows] = await connection.query<TargetArtifact[]>(`
      SELECT id,storage_path AS storagePath,metadata
      FROM ${table('ai_artifacts')}
      WHERE storage_path REGEXP '^/Users/[^/]+/' ORDER BY id
    `)
    const findings = rows.map((row) => {
      const legacy = source.records.get(row.id)
      const currentMetadata = objectValue(row.metadata)
      const pathIdentityMatches = Boolean(legacy)
        && hashPath(legacy!.storagePath) === currentMetadata.legacyStoragePathSha256
      const missingSourceMetadataKeys = legacy
        ? Object.keys(legacy.metadata).filter((key) => currentMetadata[key] === undefined)
        : []
      const conflictingSourceMetadataKeys = legacy
        ? Object.keys(legacy.metadata).filter((key) => currentMetadata[key] !== undefined
          && JSON.stringify(currentMetadata[key]) !== JSON.stringify(legacy.metadata[key]))
        : []
      const recoverable = Boolean(legacy)
        && pathIdentityMatches
        && conflictingSourceMetadataKeys.length === 0
      const mergedMetadata = legacy && recoverable ? {
        ...legacy.metadata,
        ...currentMetadata,
        legacyQualityStatus: legacy.qualityStatus,
        legacyArchived: legacy.archived,
        legacyMetadataRestoredAt: new Date().toISOString(),
      } : currentMetadata
      const needsRepair = recoverable && (
        missingSourceMetadataKeys.length > 0
        || currentMetadata.legacyQualityStatus !== legacy!.qualityStatus
        || currentMetadata.legacyArchived !== legacy!.archived
      )
      return {
        id: row.id,
        sourceFound: Boolean(legacy),
        pathIdentityMatches,
        missingSourceMetadataKeys,
        conflictingSourceMetadataKeys,
        recoverable,
        needsRepair,
        mergedMetadata,
      }
    })
    const unsafe = findings.filter((finding) => !finding.recoverable)
    const pending = findings.filter((finding) => finding.needsRepair)
    const baseReport = {
      schemaVersion: '1.0', generatedAt: new Date().toISOString(), mode: apply ? 'apply' : 'preview',
      sourceSha256: source.sourceSha256,
      counts: { artifacts: rows.length, pending: pending.length, alreadyComplete: rows.length - pending.length - unsafe.length, unsafe: unsafe.length },
      findings: findings.map(({ mergedMetadata: _mergedMetadata, ...finding }) => finding),
    }
    if (unsafe.length) {
      await writeEvidence({ ...baseReport, ok: false, applied: false })
      throw new Error(`${unsafe.length} quarantined AI artifact metadata row(s) cannot be tied to the locked dump`)
    }
    if (!apply || !pending.length) {
      const report = { ...baseReport, ok: true, applied: apply && !pending.length, appliedNow: false, idempotent: pending.length === 0 }
      await writeEvidence(report)
      console.log(JSON.stringify({ ok: true, mode: baseReport.mode, ...baseReport.counts, appliedNow: false }))
      return
    }

    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await connection.beginTransaction()
    transactionStarted = true
    for (const finding of pending) {
      const [locked] = await connection.query<TargetArtifact[]>(`
        SELECT id,storage_path AS storagePath,metadata FROM ${table('ai_artifacts')} WHERE id=? FOR UPDATE
      `, [finding.id])
      const row = locked[0]
      const legacy = source.records.get(finding.id)!
      if (!row || hashPath(legacy.storagePath) !== objectValue(row.metadata).legacyStoragePathSha256) {
        throw new Error(`quarantined AI artifact baseline changed: ${finding.id}`)
      }
      await connection.query(`UPDATE ${table('ai_artifacts')} SET metadata=? WHERE id=?`, [
        JSON.stringify(finding.mergedMetadata), finding.id,
      ])
    }
    const runId = randomUUID()
    const completedAt = new Date().toISOString()
    const report = { ...baseReport, ok: true, applied: true, appliedNow: true, runId, completedAt }
    await connection.query(`
      INSERT INTO ${table('migration_runs')}
        (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,
         source_checksum,target_checksum,report,started_at,completed_at)
      VALUES (?,'ai-artifact-quarantine-metadata-repair','postgres-dump-ai-artifacts',?,'apply','succeeded',?,?,?,?,?,NOW(3),NOW(3))
    `, [
      runId, source.sourceSha256,
      JSON.stringify({ quarantined_artifacts: rows.length, metadata_repairs: pending.length }),
      JSON.stringify({ quarantined_artifacts: rows.length, metadata_repairs: pending.length }),
      source.sourceSha256, source.sourceSha256, JSON.stringify(report),
    ])
    await connection.commit()
    transactionStarted = false
    await writeEvidence(report)
    console.log(JSON.stringify({ ok: true, mode: 'apply', ...baseReport.counts, appliedNow: true, runId }))
  } finally {
    if (transactionStarted) await connection.rollback().catch(() => undefined)
    connection.release()
    await pool.end()
  }
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, message: (error as Error).message }))
  process.exitCode = 1
})
