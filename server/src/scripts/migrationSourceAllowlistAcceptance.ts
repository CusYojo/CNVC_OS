import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'

const execFileAsync = promisify(execFile)
const excludedIdentity = /(^|[^a-z0-9_])aipin([^a-z0-9_]|$)/i
const dumpPath = path.resolve(process.env.PG_DUMP_PATH?.trim() || 'cybernaut_mvp_dump.sql')
const outputDir = path.resolve('.runtime/migration-evidence/source-allowlist')

function table(base: string): string {
  return quoteMysqlIdentifier(mysqlTableName(base))
}

function constantStrings(source: string, name: string): string[] {
  const block = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const`))?.[1]
  assert(block, `${name} allowlist is missing`)
  return [...block.matchAll(/['"]([A-Za-z0-9_]+)['"]/g)].map((item) => item[1])
}

function createFlueFixture(file: string, withExcludedTable: boolean): void {
  const sqlite = new DatabaseSync(file)
  try {
    sqlite.exec(`
      CREATE TABLE flue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE flue_conversation_streams (
        path TEXT PRIMARY KEY, identity_json TEXT NOT NULL, next_offset INTEGER NOT NULL DEFAULT 0,
        producer_id TEXT, producer_epoch INTEGER NOT NULL DEFAULT 0,
        next_producer_sequence INTEGER NOT NULL DEFAULT 0, incarnation TEXT NOT NULL
      );
      CREATE TABLE flue_conversation_stream_batches (
        path TEXT NOT NULL, seq INTEGER NOT NULL, producer_id TEXT NOT NULL,
        producer_epoch INTEGER NOT NULL, producer_sequence INTEGER NOT NULL,
        data TEXT NOT NULL, submission_id TEXT, attempt_id TEXT,
        PRIMARY KEY (path, seq), UNIQUE (path, producer_id, producer_epoch, producer_sequence)
      );
      CREATE TABLE flue_attachments (
        stream_path TEXT NOT NULL, attachment_id TEXT NOT NULL, mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL, digest TEXT NOT NULL, conversation_id TEXT NOT NULL,
        chunk_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (stream_path, attachment_id)
      );
      CREATE TABLE flue_attachment_chunks (
        stream_path TEXT NOT NULL, attachment_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
        bytes BLOB NOT NULL, PRIMARY KEY (stream_path, attachment_id, chunk_index)
      );
      ${withExcludedTable ? 'CREATE TABLE aipin_jobs (id TEXT PRIMARY KEY, payload TEXT);' : ''}
    `)
    sqlite.prepare('INSERT INTO flue_meta (key,value) VALUES (?,?)').run('schema_version', '4')
  } finally {
    sqlite.close()
  }
}

async function runFluePreview(source: string): Promise<Record<string, unknown>> {
  const result = await execFileAsync(process.execPath, [
    '--env-file-if-exists=.env',
    '--import', 'tsx',
    'server/src/scripts/migrateFlueSqliteToMySql.ts',
    '--source', source,
  ], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 })
  const line = result.stdout.trim().split('\n').at(-1)
  assert(line, 'Flue preview did not return a report')
  return JSON.parse(line) as Record<string, unknown>
}

async function runStrictExclusionAudit(): Promise<Record<string, unknown>> {
  const result = await execFileAsync(process.execPath, [
    '--env-file-if-exists=.env',
    '--import', 'tsx',
    'server/src/scripts/aipinExclusionAudit.ts',
    '--strict',
  ], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 })
  const line = result.stdout.trim().split('\n').at(-1)
  assert(line, 'strict source/target exclusion audit did not return a report')
  return JSON.parse(line) as Record<string, unknown>
}

function issueCodes(report: Record<string, unknown>): string[] {
  return Array.isArray(report.issues)
    ? report.issues.flatMap((issue) => {
        if (!issue || typeof issue !== 'object') return []
        const code = (issue as { code?: unknown }).code
        return typeof code === 'string' ? [code] : []
      })
    : []
}

async function targetSentinel(): Promise<Record<string, number>> {
  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT
      (SELECT COUNT(*) FROM ${table('migration_runs')}) AS migrationRuns,
      (SELECT COUNT(*) FROM ${table('migration_issues')}) AS migrationIssues,
      (SELECT COUNT(*) FROM ${table('agent_conversations')}) AS conversations,
      (SELECT COUNT(*) FROM ${table('agent_messages')}) AS messages
  `)
  return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)]))
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

async function cleanupAcceptanceFlueEvidence(): Promise<void> {
  const directory = path.resolve('.runtime/migration-evidence/flue-sources')
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
    const file = path.resolve(directory, entry.name)
    const report = JSON.parse(await readFile(file, 'utf8')) as {
      source?: unknown
      applied?: unknown
      issues?: Array<{ code?: unknown }>
    }
    const codes = Array.isArray(report.issues)
      ? report.issues.flatMap((issue) => typeof issue?.code === 'string' ? [issue.code] : [])
      : []
    if (typeof report.source === 'string'
      && report.source.includes(`${path.sep}migration-source-allowlist-`)
      && report.applied !== true
      && codes.length > 0
      && codes.every((code) => code === 'AIPIN_SOURCE_REJECTED' || code === 'AIPIN_TABLE_REJECTED')) {
      await unlink(file)
    }
  }
}

async function main(): Promise<void> {
  await ensureSchema()
  await cleanupAcceptanceFlueEvidence()
  const [onlineSource, dumpImporterSource, flueSource, dumpBytes] = await Promise.all([
    readFile(path.resolve('server/src/scripts/migratePostgresToMySql.ts'), 'utf8'),
    readFile(path.resolve('server/src/scripts/migratePostgresDumpToMySql.ts'), 'utf8'),
    readFile(path.resolve('server/src/scripts/migrateFlueSqliteToMySql.ts'), 'utf8'),
    readFile(dumpPath),
  ])
  const dumpText = dumpBytes.toString('utf8')
  const sourceSha256 = createHash('sha256').update(dumpBytes).digest('hex')
  const onlineTables = constantStrings(onlineSource, 'TABLE_ORDER')
  const dumpTables = constantStrings(dumpImporterSource, 'LOAD_ORDER')
  const dumpCopyTables = [...new Set([...dumpText.matchAll(/^COPY public\.([A-Za-z0-9_]+) \(/gm)].map((item) => item[1]))].sort()
  const excludedDumpTables = dumpCopyTables.filter((name) => excludedIdentity.test(name))
  const excludedDumpRecordMarkers = [...dumpText.matchAll(new RegExp(excludedIdentity.source, 'gi'))].length
  assert.equal(excludedDumpTables.length, 0, 'checksum-locked dump contains an excluded Aipin table')
  assert.equal(excludedDumpRecordMarkers, 0, 'checksum-locked dump contains an excluded Aipin record marker')
  assert(onlineTables.length > 0 && dumpTables.length > 0, 'PostgreSQL source allowlists must be non-empty')
  assert(!onlineTables.some((name) => excludedIdentity.test(name)), 'online PostgreSQL allowlist contains Aipin')
  assert(!dumpTables.some((name) => excludedIdentity.test(name)), 'dump PostgreSQL allowlist contains Aipin')
  assert(dumpTables.every((name) => dumpCopyTables.includes(name)), 'dump allowlist requires a missing COPY table')
  assert.match(flueSource, /AIPIN_SOURCE_REJECTED/)
  assert.match(flueSource, /AIPIN_TABLE_REJECTED/)

  const [baselineRows] = await pool.query<Array<RowDataPacket & { count: number }>>(`
    SELECT COUNT(*) count FROM ${table('migration_runs')}
    WHERE migration_type='postgres-dump-baseline-reconciliation'
      AND source_sha256=? AND status='succeeded'
  `, [sourceSha256])
  assert(Number(baselineRows[0]?.count) > 0, 'dump allowlist acceptance requires a successful checksum-bound reconciliation')

  const tempDir = await mkdtemp(path.join(tmpdir(), 'migration-source-allowlist-'))
  try {
    const excludedPathFixture = path.resolve(tempDir, 'aipin-flue.db')
    const excludedTableFixture = path.resolve(tempDir, 'flue-with-excluded-table.db')
    createFlueFixture(excludedPathFixture, false)
    createFlueFixture(excludedTableFixture, true)
    const before = await targetSentinel()
    const pathReport = await runFluePreview(excludedPathFixture)
    const tableReport = await runFluePreview(excludedTableFixture)
    const strictExclusionReport = await runStrictExclusionAudit()
    const after = await targetSentinel()
    const pathCodes = issueCodes(pathReport)
    const tableCodes = issueCodes(tableReport)
    assert.equal(pathReport.ok, false, 'Aipin path fixture must fail closed')
    assert(pathCodes.includes('AIPIN_SOURCE_REJECTED'), 'Aipin path rejection was not reported')
    assert.equal(tableReport.ok, false, 'Aipin table fixture must fail closed')
    assert(tableCodes.includes('AIPIN_TABLE_REJECTED'), 'Aipin table rejection was not reported')
    assert.equal(strictExclusionReport.ok, true, 'strict source/code/environment/target exclusion audit failed')
    assert.deepEqual(after, before, 'previewing excluded sources changed target migration or Agent tables')

    const output = {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      ok: true,
      dump: {
        sourceSha256,
        copyTables: dumpCopyTables.length,
        approvedTables: dumpTables.length,
        excludedTables: excludedDumpTables.length,
        excludedRecordMarkers: excludedDumpRecordMarkers,
        checksumBoundReconciliation: true,
      },
      allowlists: {
        onlinePostgresTables: onlineTables.length,
        dumpPostgresTables: dumpTables.length,
        flueSourceAndTableRejectionContracts: true,
      },
      maliciousFixtures: {
        excludedPathIssueCodes: pathCodes,
        excludedTableIssueCodes: tableCodes,
        targetSentinelUnchanged: true,
      },
      strictSourceTargetExclusion: { ok: true },
      checks: [
        'postgres-online-and-dump-importers-read-only-explicit-table-allowlists',
        'checksum-bound-dump-has-no-aipin-table-or-record-identity',
        'flue-aipin-path-is-rejected-and-reported-without-target-write',
        'flue-aipin-table-is-rejected-and-reported-without-target-write',
      ],
    }
    await writeEvidence(output)
    await cleanupAcceptanceFlueEvidence()
    console.log(JSON.stringify(output))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

await main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => pool.end())
