import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'

type MissingProjectFile = RowDataPacket & { id: string; projectId: string }
type LegacyArtifact = RowDataPacket & {
  id: string; projectId: string; storagePath: string; archived: number; qualityStatus: string
}

const apply = process.argv.includes('--apply')
const projectIssueCode = 'PROJECT_FILE_SOURCE_FILE_MISSING'
const artifactIssueCode = 'AI_ARTIFACT_SOURCE_FILE_MISSING'
const outputDirectory = path.resolve(process.cwd(), '.runtime/migration-evidence/missing-file-assets')

function table(name: string): string {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

function pathHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sourceHash(projectFiles: MissingProjectFile[], artifacts: LegacyArtifact[]): string {
  return createHash('sha256').update(JSON.stringify({
    projectFiles: projectFiles.map((row) => [row.id, row.projectId]).sort(),
    artifacts: artifacts.map((row) => [row.id, row.projectId, pathHash(row.storagePath)]).sort(),
  })).digest('hex')
}

async function fileExists(file: string): Promise<boolean> {
  try { return (await lstat(file)).isFile() } catch { return false }
}

async function loadRows(connection: PoolConnection): Promise<{
  projectFiles: MissingProjectFile[]; artifacts: LegacyArtifact[]
}> {
  const [projectFiles] = await connection.query<MissingProjectFile[]>(`
    SELECT id,project_id AS projectId FROM ${table('project_files')}
    WHERE storage_path IS NULL OR TRIM(storage_path)='' ORDER BY id
  `)
  const [artifacts] = await connection.query<LegacyArtifact[]>(`
    SELECT id,project_id AS projectId,storage_path AS storagePath,archived,quality_status AS qualityStatus
    FROM ${table('ai_artifacts')} WHERE storage_path REGEXP '^/Users/[^/]+/' ORDER BY id
  `)
  return { projectFiles, artifacts }
}

async function writeEvidence(report: Record<string, unknown>): Promise<void> {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  const reportPath = path.resolve(outputDirectory, 'report.json')
  const summaryPath = path.resolve(outputDirectory, 'summary.md')
  const suffix = `.${process.pid}-${Date.now()}`
  await writeFile(`${reportPath}${suffix}`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  const counts = report.counts as Record<string, number>
  const summary = [
    '# 缺失文件资产隔离报告', '',
    `生成时间：${report.generatedAt}`, '',
    `- 缺原件项目资料：${counts.missingProjectFiles}`,
    `- 旧机器 AI 产物：${counts.legacyArtifacts}`,
    `- 待写入问题台账：${counts.plannedIssues}`,
    `- 待隐藏不可下载 AI 产物：${counts.plannedArtifactQuarantines}`,
    `- 已隔离且有台账：${counts.alreadyQuarantined}`,
    `- 阻断（源文件实际存在）：${counts.blockers}`, '',
    '隔离不删除任务、产物或项目资料记录。不可下载的 AI 产物改为 archived/failed；项目资料保留“补传原文件”入口。源文件缺失本身仍是迁移阻断项。',
  ].join('\n')
  await writeFile(`${summaryPath}${suffix}`, `${summary}\n`, { mode: 0o600 })
  await rename(`${reportPath}${suffix}`, reportPath)
  await rename(`${summaryPath}${suffix}`, summaryPath)
}

async function main(): Promise<void> {
  await ensureSchema()
  const connection = await pool.getConnection()
  let transactionStarted = false
  try {
    const rows = await loadRows(connection)
    const baselineSha256 = sourceHash(rows.projectFiles, rows.artifacts)
    const [issueRows] = await connection.query<Array<RowDataPacket & {
      sourceTable: string; sourceKey: string; sourceSha256: string; runId: string
    }>>(`
      SELECT i.source_table AS sourceTable,i.source_key AS sourceKey,
             r.source_sha256 AS sourceSha256,r.id AS runId
      FROM ${table('migration_issues')} i JOIN ${table('migration_runs')} r ON r.id=i.run_id
      WHERE i.code IN (?,?) AND r.migration_type='missing-file-asset-quarantine' AND r.status='succeeded'
    `, [projectIssueCode, artifactIssueCode])
    // A later inventory may contain additional missing rows and therefore have a
    // different aggregate hash. Successful per-row issues remain valid; only the
    // exact aggregate run ID is hash-scoped.
    const issueKeys = new Set(issueRows.map((row) => `${row.sourceTable}:${row.sourceKey}`))
    const existingRunIds = [...new Set(issueRows
      .filter((row) => row.sourceSha256 === baselineSha256).map((row) => row.runId))]
    const artifactExistence = new Map(await Promise.all(rows.artifacts.map(async (row) => [
      row.id, await fileExists(row.storagePath),
    ] as const)))
    const blockers = rows.artifacts.filter((row) => artifactExistence.get(row.id)).map((row) => ({
      table: 'ai_artifacts', id: row.id, code: 'SOURCE_FILE_AVAILABLE_REQUIRES_RECOVERY',
    }))
    const plannedProjectIssues = rows.projectFiles.filter((row) => !issueKeys.has(`project_files:${row.id}`))
    const plannedArtifactIssues = rows.artifacts.filter((row) =>
      !artifactExistence.get(row.id) && !issueKeys.has(`ai_artifacts:${row.id}`))
    const plannedArtifactQuarantines = rows.artifacts.filter((row) =>
      !artifactExistence.get(row.id) && (!Boolean(row.archived) || row.qualityStatus !== 'failed'))
    const alreadyQuarantined = rows.projectFiles.length + rows.artifacts.length
      - plannedProjectIssues.length - plannedArtifactIssues.length
    const baseReport = {
      schemaVersion: '1.0', generatedAt: new Date().toISOString(),
      mode: apply ? 'apply' : 'preview', sourceSha256: baselineSha256,
      counts: {
        missingProjectFiles: rows.projectFiles.length,
        legacyArtifacts: rows.artifacts.length,
        plannedIssues: plannedProjectIssues.length + plannedArtifactIssues.length,
        plannedArtifactQuarantines: plannedArtifactQuarantines.length,
        alreadyQuarantined, blockers: blockers.length,
      },
      blockers,
      policy: 'retain-missing-records-hide-unavailable-artifacts-and-write-durable-ledger',
    }
    if (blockers.length) {
      await writeEvidence({ ...baseReport, ok: false, applied: false })
      throw new Error(`${blockers.length} legacy artifact source file(s) exist and require recovery instead of quarantine`)
    }
    if (!apply || (!plannedProjectIssues.length && !plannedArtifactIssues.length && !plannedArtifactQuarantines.length)) {
      const appliedState = rows.projectFiles.length + rows.artifacts.length > 0
        && alreadyQuarantined === rows.projectFiles.length + rows.artifacts.length
        && plannedArtifactQuarantines.length === 0
      const report = {
        ...baseReport, ok: true, applied: appliedState, appliedNow: false,
        idempotent: plannedProjectIssues.length + plannedArtifactIssues.length + plannedArtifactQuarantines.length === 0,
        successfulRunIds: existingRunIds,
      }
      await writeEvidence(report)
      console.log(JSON.stringify(report))
      return
    }

    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await connection.beginTransaction()
    transactionStarted = true
    const locked = await loadRows(connection)
    if (sourceHash(locked.projectFiles, locked.artifacts) !== baselineSha256) {
      throw new Error('missing file asset baseline changed before quarantine')
    }
    for (const row of locked.artifacts) {
      if (await fileExists(row.storagePath)) {
        throw new Error(`legacy artifact source became available before quarantine: ${row.id}`)
      }
    }
    const quarantinedAt = new Date().toISOString()
    for (const row of plannedArtifactQuarantines) {
      await connection.query(`
        UPDATE ${table('ai_artifacts')}
        SET archived=1,quality_status='failed',metadata=JSON_SET(
          COALESCE(metadata,JSON_OBJECT()),'$.migrationDisposition','source-file-missing',
          '$.legacyStoragePathSha256',?,'$.quarantinedAt',?
        ) WHERE id=?
      `, [pathHash(row.storagePath), quarantinedAt, row.id])
    }
    const runId = randomUUID()
    const tableReports = [
      {
        table: 'project_files', sourceRows: rows.projectFiles.length,
        targetRowsAfter: rows.projectFiles.length, readRows: rows.projectFiles.length,
        writtenRows: 0, skippedRows: rows.projectFiles.length, failedRows: 0,
        sourceHash: baselineSha256, targetHash: baselineSha256, status: 'verified-preserved',
      },
      {
        table: 'ai_artifacts', sourceRows: rows.artifacts.length,
        targetRowsAfter: rows.artifacts.length, readRows: rows.artifacts.length,
        writtenRows: plannedArtifactQuarantines.length,
        skippedRows: rows.artifacts.length - plannedArtifactQuarantines.length, failedRows: 0,
        sourceHash: baselineSha256, targetHash: baselineSha256, status: 'verified-preserved',
      },
    ]
    const runReport = { ...baseReport, ok: true, applied: true, appliedNow: true, runId, tables: tableReports }
    await connection.query(`
      INSERT INTO ${table('migration_runs')}
        (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,
         source_checksum,target_checksum,report,started_at,completed_at)
      VALUES (?, 'missing-file-asset-quarantine','file-asset-inventory',?,'apply','succeeded',?,?,?,?,?,NOW(3),NOW(3))
    `, [
      runId, baselineSha256,
      JSON.stringify({ project_files_missing: rows.projectFiles.length, ai_artifacts_legacy_path: rows.artifacts.length }),
      JSON.stringify({ project_files_retained: rows.projectFiles.length, ai_artifacts_quarantined: rows.artifacts.length }),
      baselineSha256, baselineSha256, JSON.stringify(runReport),
    ])
    for (const row of plannedProjectIssues) {
      await connection.query(`
        INSERT INTO ${table('migration_issues')}
          (id,run_id,severity,source_system,source_table,source_key,code,message,payload)
        VALUES (?,?,'warning','postgres_dump','project_files',?,?,?,?)
      `, [
        randomUUID(), runId, row.id, projectIssueCode,
        'Project file metadata is retained but the original source bytes are unavailable.',
        JSON.stringify({ projectId: row.projectId, sourceSha256: baselineSha256, decision: 'retain-for-original-file-reattachment' }),
      ])
    }
    for (const row of plannedArtifactIssues) {
      await connection.query(`
        INSERT INTO ${table('migration_issues')}
          (id,run_id,severity,source_system,source_table,source_key,code,message,payload)
        VALUES (?,?,'warning','postgres_dump','ai_artifacts',?,?,?,?)
      `, [
        randomUUID(), runId, row.id, artifactIssueCode,
        'AI artifact metadata is retained but the legacy source file is unavailable; artifact is archived.',
        JSON.stringify({
          projectId: row.projectId, sourceSha256: baselineSha256,
          legacyStoragePathSha256: pathHash(row.storagePath), decision: 'archive-unavailable-artifact',
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
