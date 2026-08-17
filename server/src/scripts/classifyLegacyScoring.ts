import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'

type ScoreRow = RowDataPacket & { id: string; scoringChecksum: string }

function table(base: string): string {
  return quoteMysqlIdentifier(mysqlTableName(base))
}

const apply = process.argv.includes('--apply')

function legacyCandidateWhere(alias = ''): string {
  const prefix = alias ? `${alias}.` : ''
  return `${prefix}scoring IS NOT NULL
    AND (COALESCE(JSON_LENGTH(JSON_EXTRACT(${prefix}scoring,'$.dimensions')),0)>0
      OR JSON_EXTRACT(${prefix}scoring,'$.total') IS NOT NULL)
    AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${prefix}scoring,'$.provenance')),'')<>'agent-run'`
}

async function scoreRows(connection: PoolConnection, entityTable: 'leads' | 'projects'): Promise<ScoreRow[]> {
  const [rows] = await connection.query<ScoreRow[]>(`
    SELECT id,COALESCE(
      JSON_UNQUOTE(JSON_EXTRACT(scoring,'$._migration.originalScoringChecksum')),
      SHA2(CAST(scoring AS CHAR),256)
    ) AS scoringChecksum
    FROM ${table(entityTable)} WHERE ${legacyCandidateWhere()} ORDER BY id FOR UPDATE
  `)
  return rows
}

function checksum(rows: Array<{ entity: string; id: string; scoringChecksum: string }>): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

async function writeEvidence(report: Record<string, unknown>): Promise<void> {
  const directory = path.resolve(process.cwd(), '.runtime/migration-evidence/legacy-scoring')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const target = path.resolve(directory, 'report.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

async function updateLegacyRows(
  connection: PoolConnection,
  entityTable: 'leads' | 'projects',
  runId: string,
  sourceSha256: string,
): Promise<number> {
  const [result] = await connection.execute<import('mysql2').ResultSetHeader>(`
    UPDATE ${table(entityTable)}
    SET scoring=JSON_SET(scoring,
      '$.provenance','legacy-import',
      '$._migration',JSON_OBJECT(
        'classification','legacy-import',
        'evidenceReconstructable',false,
        'sourceSystem','postgres_dump',
        'sourceSha256',?,
        'runId',?,
        'originalScoringChecksum',SHA2(CAST(scoring AS CHAR),256)
      )
    )
    WHERE ${legacyCandidateWhere()}
      AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(scoring,'$.provenance')),'')<>'legacy-import'
  `, [sourceSha256, runId])
  return result.affectedRows
}

async function main() {
  await ensureSchema()
  const connection = await pool.getConnection()
  let transactionStarted = false
  try {
    await connection.beginTransaction()
    transactionStarted = true
    const [sourceRuns] = await connection.query<Array<RowDataPacket & {
      id: string
      sourceSha256: string
      sourceLocator: string
    }>>(`
      SELECT id,source_sha256 AS sourceSha256,source_locator AS sourceLocator
      FROM ${table('migration_runs')}
      WHERE migration_type='postgres-dump-baseline-reconciliation' AND status='succeeded'
      ORDER BY completed_at DESC LIMIT 1 FOR UPDATE
    `)
    const sourceRun = sourceRuns[0]
    if (!sourceRun) throw new Error('successful PostgreSQL dump reconciliation run is required')
    const leadRows = await scoreRows(connection, 'leads')
    const projectRows = await scoreRows(connection, 'projects')
    const sourceRows = [
      ...leadRows.map((row) => ({ entity: 'leads', id: String(row.id), scoringChecksum: String(row.scoringChecksum) })),
      ...projectRows.map((row) => ({ entity: 'projects', id: String(row.id), scoringChecksum: String(row.scoringChecksum) })),
    ]
    const sourceChecksum = checksum(sourceRows)
    const [priorRows] = await connection.query<Array<RowDataPacket & { id: string }>>(`
      SELECT id FROM ${table('migration_runs')}
      WHERE migration_type='legacy-scoring-classification' AND source_sha256=? AND status='succeeded'
      ORDER BY completed_at DESC LIMIT 1 FOR UPDATE
    `, [sourceRun.sourceSha256])
    if (!apply) {
      await connection.rollback()
      transactionStarted = false
      const preview = {
        schemaVersion: '1.0', ok: true, mode: 'preview', sourceSha256: sourceRun.sourceSha256,
        candidates: { leads: leadRows.length, projects: projectRows.length },
        alreadyClassified: Boolean(priorRows[0]), sourceChecksum,
      }
      await writeEvidence(preview)
      console.log(JSON.stringify(preview))
      return
    }

    const existingRunId = priorRows[0]?.id == null ? null : String(priorRows[0].id)
    const [unclassifiedCounts] = await connection.query<Array<RowDataPacket & { leads: number; projects: number }>>(`
      SELECT
        (SELECT COUNT(*) FROM ${table('leads')} WHERE ${legacyCandidateWhere()}
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(scoring,'$.provenance')),'')<>'legacy-import') AS leads,
        (SELECT COUNT(*) FROM ${table('projects')} WHERE ${legacyCandidateWhere()}
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(scoring,'$.provenance')),'')<>'legacy-import') AS projects
    `)
    const needsChange = Number(unclassifiedCounts[0]?.leads ?? 0) + Number(unclassifiedCounts[0]?.projects ?? 0)
    if (existingRunId && needsChange === 0) {
      await connection.commit()
      transactionStarted = false
      const report = {
        schemaVersion: '1.0', ok: true, mode: 'apply', runId: existingRunId,
        sourceSha256: sourceRun.sourceSha256, candidates: { leads: leadRows.length, projects: projectRows.length },
        changed: { leads: 0, projects: 0 }, idempotent: true,
      }
      await writeEvidence(report)
      console.log(JSON.stringify(report))
      return
    }

    const runId = randomUUID()
    await connection.execute(`
      INSERT INTO ${table('migration_runs')}
        (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,
         source_checksum,report,started_at)
      VALUES (?,?,?,?,?,'running',?,?,?,JSON_OBJECT(),NOW(3))
    `, [runId, 'legacy-scoring-classification', path.basename(String(sourceRun.sourceLocator)),
      sourceRun.sourceSha256, 'apply', JSON.stringify({ leads: leadRows.length, projects: projectRows.length }),
      JSON.stringify({}), sourceChecksum])
    const changedLeads = await updateLegacyRows(connection, 'leads', runId, sourceRun.sourceSha256)
    const changedProjects = await updateLegacyRows(connection, 'projects', runId, sourceRun.sourceSha256)
    const report = {
      schemaVersion: '1.0', ok: true, mode: 'apply', runId, sourceSha256: sourceRun.sourceSha256,
      sourceRunId: sourceRun.id,
      candidates: { leads: leadRows.length, projects: projectRows.length },
      changed: { leads: changedLeads, projects: changedProjects },
      classification: 'legacy-import', evidenceReconstructable: false, idempotent: false,
    }
    await connection.execute(`
      UPDATE ${table('migration_runs')}
      SET status='succeeded',target_counts=?,target_checksum=?,report=?,completed_at=NOW(3) WHERE id=?
    `, [JSON.stringify({ leads: leadRows.length, projects: projectRows.length }), sourceChecksum,
      JSON.stringify(report), runId])
    await connection.commit()
    transactionStarted = false
    await writeEvidence(report)
    console.log(JSON.stringify(report))
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => undefined)
    throw error
  } finally {
    connection.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
