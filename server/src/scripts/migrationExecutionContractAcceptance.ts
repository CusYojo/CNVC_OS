import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

const execFileAsync = promisify(execFile)
const sourcePath = path.resolve(process.env.PG_DUMP_PATH?.trim() || 'cybernaut_mvp_dump.sql')
const outputDir = path.resolve('.runtime/migration-evidence/execution-contract')
const sourceTables = [
  'users', 'projects', 'project_files', 'meetings', 'todos', 'risks', 'ai_summaries', 'leads',
  'lead_reserve', 'audit_logs', 'chat_conversations', 'file_chunks', 'knowledge_chunks',
  'ai_tasks', 'ai_artifacts', 'ai_task_sources',
] as const

type ImportReport = {
  ok?: boolean
  code?: string
  mode?: string
  runId?: string | null
  checkpointed?: boolean
  attempts?: number
  resumedFromCheckpoint?: boolean
  completedCheckpointTables?: number
  tables?: Array<{
    table: string
    sourceRows: number
    targetRowsAfter: number
    readRows: number
    writtenRows: number
    skippedRows: number
    failedRows: number
    sourceHash: string
    targetHash: string
    status: string
  }>
}

type CheckpointLedger = {
  id: string
  status: string
  report: {
    attempts?: number
    checkpoint?: { completedTables?: string[] }
  }
}

function childEnvironment(database: string, evidenceRoot: string, batchSize?: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DB_DATABASE: database,
    MIGRATION_EVIDENCE_ROOT: evidenceRoot,
    ...(batchSize == null ? {} : { DB_MIGRATION_BATCH_SIZE: String(batchSize) }),
  }
}

function parseReport(output: string): ImportReport | undefined {
  const trimmed = output.trim()
  let start = trimmed.indexOf('{')
  while (start >= 0) {
    try { return JSON.parse(trimmed.slice(start)) as ImportReport } catch { /* try the next object */ }
    start = trimmed.indexOf('{', start + 1)
  }
  for (const line of trimmed.split('\n').reverse()) {
    try { return JSON.parse(line) as ImportReport } catch { /* keep looking */ }
  }
  return undefined
}

async function runNodeScript(
  script: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  expectFailure = false,
): Promise<{ report?: ImportReport; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [
      '--env-file-if-exists=.env', '--import', 'tsx', script, ...args,
    ], { cwd: process.cwd(), env: environment, maxBuffer: 8 * 1024 * 1024 })
    assert.equal(expectFailure, false, `${script} unexpectedly succeeded`)
    return { report: parseReport(result.stdout), stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    assert.equal(expectFailure, true, error instanceof Error ? error.message : String(error))
    const failure = error as { stdout?: string; stderr?: string }
    const output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`
    return {
      report: parseReport(output),
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    }
  }
}

function corruptFirstJsonValue(dump: string, table: string, column: string): string {
  const header = new RegExp(`^COPY public\\.${table} \\(([^)]+)\\) FROM stdin;$`, 'm').exec(dump)
  assert(header?.index != null, `COPY block ${table} is missing`)
  const columns = header[1].split(', ')
  const columnIndex = columns.indexOf(column)
  assert(columnIndex >= 0, `${table}.${column} is missing`)
  const dataStart = dump.indexOf('\n', header.index) + 1
  const dataEnd = dump.indexOf('\n\\.\n', dataStart)
  assert(dataStart > 0 && dataEnd > dataStart, `COPY block ${table} is unterminated`)
  const rows = dump.slice(dataStart, dataEnd).split('\n')
  let changed = false
  const corrupted = rows.map((row) => {
    if (changed) return row
    const values = row.split('\t')
    if (values[columnIndex] === String.raw`\N`) return row
    values[columnIndex] = '{invalid-json'
    changed = true
    return values.join('\t')
  })
  assert(changed, `no non-null ${table}.${column} value was available to corrupt`)
  return `${dump.slice(0, dataStart)}${corrupted.join('\n')}${dump.slice(dataEnd)}`
}

async function tableCount(database: string, base: string): Promise<number> {
  const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) count FROM ${quoteMysqlIdentifier(database)}.${quoteMysqlIdentifier(mysqlTableName(base))}`,
  )
  return Number(rows[0]?.count ?? 0)
}

async function snapshot(database: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const name of [...sourceTables, 'migration_runs', 'migration_issues', 'migration_entity_mappings'] as const) {
    result[name] = await tableCount(database, name)
  }
  return result
}

async function checkpointLedgers(database: string): Promise<CheckpointLedger[]> {
  const [rows] = await pool.query<Array<RowDataPacket & { id: string; status: string; report: unknown }>>(`
    SELECT id,status,report
    FROM ${quoteMysqlIdentifier(database)}.${quoteMysqlIdentifier(mysqlTableName('migration_runs'))}
    WHERE migration_type='postgres-dump-checkpointed'
    ORDER BY started_at
  `)
  return rows.map((row) => ({
    id: String(row.id),
    status: String(row.status),
    report: typeof row.report === 'string' ? JSON.parse(row.report) : row.report,
  })) as CheckpointLedger[]
}

async function writeEvidence(payload: Record<string, unknown>): Promise<void> {
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  await chmod(outputDir, 0o700)
  const target = path.resolve(outputDir, 'report.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  await chmod(target, 0o600)
}

async function main(): Promise<void> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16)
  const isolatedDatabase = `sbl_migration_contract_${suffix}`
  assert(/^sbl_migration_contract_[a-f0-9]{16}$/.test(isolatedDatabase))
  const tempDir = await mkdtemp(path.join(tmpdir(), 'sbl-migration-contract-'))
  const evidenceRoot = path.resolve(tempDir, 'evidence')
  const badDumpPath = path.resolve(tempDir, 'corrupted-dump.sql')
  const environment = childEnvironment(isolatedDatabase, evidenceRoot)
  let databaseCreated = false
  try {
    await pool.query(`CREATE DATABASE ${quoteMysqlIdentifier(isolatedDatabase)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    databaseCreated = true
    await runNodeScript('server/src/scripts/migrateMySqlSchema.ts', [], environment)

    const beforePreview = await snapshot(isolatedDatabase)
    const preview = await runNodeScript(
      'server/src/scripts/migratePostgresDumpToMySql.ts', [], environment,
    )
    const afterPreview = await snapshot(isolatedDatabase)
    assert.deepEqual(afterPreview, beforePreview, 'dump preview changed target rows or migration ledgers')
    assert.equal(preview.report?.ok, true)
    assert.equal(preview.report?.mode, 'preview')
    assert.equal(preview.report?.tables?.length, sourceTables.length)
    assert(preview.report?.tables?.every((item) =>
      item.writtenRows === 0 && item.skippedRows === item.sourceRows && item.failedRows === 0),
    'preview report does not expose read/write/skip/fail counts')

    const sourceText = await readFile(sourcePath, 'utf8')
    await writeFile(badDumpPath, corruptFirstJsonValue(sourceText, 'leads', 'scoring'), { mode: 0o600 })
    const failed = await runNodeScript(
      'server/src/scripts/migratePostgresDumpToMySql.ts', ['--apply'],
      { ...childEnvironment(isolatedDatabase, evidenceRoot, 7), PG_DUMP_PATH: badDumpPath }, true,
    )
    assert.equal(failed.report?.ok, false, 'corrupted batch did not fail closed')
    const afterFailure = await snapshot(isolatedDatabase)
    assert(sourceTables.every((name) => afterFailure[name] === 0),
      'failed batch left partially committed source-table rows')
    assert.equal(afterFailure.migration_runs, 1, 'failed batch did not leave exactly one failed run')
    assert.equal(afterFailure.migration_issues, 1, 'failed JSON batch did not leave exactly one isolated issue')

    const checkpointFailure = await runNodeScript(
      'server/src/scripts/migratePostgresDumpToMySql.ts', ['--checkpointed-apply'],
      {
        ...childEnvironment(isolatedDatabase, evidenceRoot, 11),
        MIGRATION_TEST_FAIL_AT_TABLE: 'leads',
      },
      true,
    )
    assert.equal(checkpointFailure.report?.ok, false, 'checkpoint interruption did not fail')
    assert.equal(
      checkpointFailure.report?.code,
      'MIGRATION_TEST_INTERRUPT',
      `checkpointed apply failed before the injected interruption: ${checkpointFailure.stderr || checkpointFailure.stdout}`,
    )
    const afterCheckpointFailure = await snapshot(isolatedDatabase)
    const completedBeforeInterruption = sourceTables.slice(0, sourceTables.indexOf('leads'))
    const pendingAfterInterruption = sourceTables.slice(sourceTables.indexOf('leads'))
    assert.deepEqual(
      Object.fromEntries(completedBeforeInterruption.map((name) => [name, afterCheckpointFailure[name]])),
      Object.fromEntries(completedBeforeInterruption.map((name) => [
        name,
        Number(preview.report?.tables?.find((item) => item.table === name)?.sourceRows ?? -1),
      ])),
      'checkpointed apply did not retain every committed table before interruption',
    )
    assert(pendingAfterInterruption.every((name) => afterCheckpointFailure[name] === 0),
      'checkpointed apply leaked the interrupted table or a later table')
    assert.equal(
      afterCheckpointFailure.migration_issues,
      afterFailure.migration_issues + 1,
      'checkpointed failure did not add exactly one sanitized issue',
    )
    const failedCheckpointLedgers = await checkpointLedgers(isolatedDatabase)
    assert.equal(failedCheckpointLedgers.length, 1, 'checkpointed failure did not keep one resumable run')
    assert.equal(failedCheckpointLedgers[0].status, 'failed')
    assert.deepEqual(
      failedCheckpointLedgers[0].report.checkpoint?.completedTables,
      [...completedBeforeInterruption],
      'persisted checkpoint does not match committed table prefix',
    )

    const checkpointResume = await runNodeScript(
      'server/src/scripts/migratePostgresDumpToMySql.ts', ['--checkpointed-apply'],
      childEnvironment(isolatedDatabase, evidenceRoot, 5),
    )
    assert.equal(checkpointResume.report?.ok, true)
    assert.equal(checkpointResume.report?.mode, 'checkpointed-apply')
    assert.equal(checkpointResume.report?.checkpointed, true)
    assert.equal(checkpointResume.report?.attempts, 2)
    assert.equal(checkpointResume.report?.resumedFromCheckpoint, true)
    assert.equal(checkpointResume.report?.completedCheckpointTables, sourceTables.length)
    const resumedCheckpointLedgers = await checkpointLedgers(isolatedDatabase)
    assert.equal(resumedCheckpointLedgers.length, 1, 'resume created a second migration batch instead of reusing the checkpoint')
    assert.equal(resumedCheckpointLedgers[0].id, failedCheckpointLedgers[0].id)
    assert.equal(resumedCheckpointLedgers[0].status, 'succeeded')
    assert.equal(resumedCheckpointLedgers[0].report.attempts, 2)
    assert.deepEqual(resumedCheckpointLedgers[0].report.checkpoint?.completedTables, [...sourceTables])
    const afterCheckpointResume = await snapshot(isolatedDatabase)
    assert(sourceTables.every((name) =>
      afterCheckpointResume[name] === Number(preview.report?.tables?.find((item) => item.table === name)?.sourceRows ?? -1)),
    'checkpoint resume did not complete every source table')
    assert.equal(afterCheckpointResume.migration_issues, afterCheckpointFailure.migration_issues,
      'successful resume unexpectedly added or removed an issue')

    const firstApply = await runNodeScript(
      'server/src/scripts/migratePostgresDumpToMySql.ts', ['--apply'],
      childEnvironment(isolatedDatabase, evidenceRoot, 13),
    )
    assert.equal(firstApply.report?.ok, true)
    assert.equal(firstApply.report?.mode, 'apply')
    assert(firstApply.report?.tables?.every((item) =>
      item.readRows === item.sourceRows && item.failedRows === 0
      && ['verified', 'verified-preserved'].includes(item.status)),
    'first batched apply was not fully verified')
    const firstSnapshot = await snapshot(isolatedDatabase)

    const secondApply = await runNodeScript(
      'server/src/scripts/migratePostgresDumpToMySql.ts', ['--apply'],
      childEnvironment(isolatedDatabase, evidenceRoot, 7),
    )
    assert.equal(secondApply.report?.ok, true)
    assert.equal(secondApply.report?.mode, 'apply')
    const secondSnapshot = await snapshot(isolatedDatabase)
    for (const name of sourceTables) {
      assert.equal(secondSnapshot[name], firstSnapshot[name], `repeat apply duplicated ${name}`)
    }
    assert.equal(secondSnapshot.migration_entity_mappings, firstSnapshot.migration_entity_mappings,
      'repeat apply duplicated entity mappings')
    const firstHashes = Object.fromEntries(firstApply.report?.tables?.map((item) => [item.table, item.targetHash]) ?? [])
    const secondHashes = Object.fromEntries(secondApply.report?.tables?.map((item) => [item.table, item.targetHash]) ?? [])
    assert.deepEqual(secondHashes, firstHashes, 'repeat apply changed source-table content hashes')

    const output = {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      ok: true,
      sourceTables: sourceTables.length,
      sourceRows: firstApply.report?.tables?.reduce((sum, item) => sum + item.sourceRows, 0),
      batchSizes: [13, 7],
      dryRunTargetRowsChanged: 0,
      failedBatchSourceRowsCommitted: 0,
      atomicFailedRuns: afterFailure.migration_runs,
      atomicIsolatedIssues: afterFailure.migration_issues,
      checkpointCommittedTablesBeforeInterruption: completedBeforeInterruption.length,
      checkpointPendingTablesAfterInterruption: pendingAfterInterruption.length,
      checkpointFailureIssuesAdded: afterCheckpointFailure.migration_issues - afterFailure.migration_issues,
      checkpointResumeAttempts: 2,
      checkpointRunIdsAddedOnResume: 0,
      repeatedBusinessRowsChanged: 0,
      repeatedEntityMappingsAdded: 0,
      persistentCheckpointResumeImplemented: true,
      checks: [
        'dump-preview-is-a-row-and-ledger-zero-write-dry-run',
        'bounded-batch-sizes-apply-and-verify-all-source-tables',
        'invalid-late-table-json-rolls-back-the-whole-business-batch-and-isolates-failure',
        'clean-restart-after-failure-completes-without-partial-row-leakage',
        'table-checkpoints-persist-in-mysql-and-resume-the-same-run-after-interruption',
        'repeat-batched-apply-keeps-business-counts-hashes-and-entity-mapping-count-stable',
      ],
    }
    await writeEvidence(output)
    console.log(JSON.stringify(output))
  } finally {
    if (databaseCreated) {
      await pool.query(`DROP DATABASE ${quoteMysqlIdentifier(isolatedDatabase)}`).catch(() => undefined)
    }
    await rm(tempDir, { recursive: true, force: true })
  }
}

await main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => pool.end())
