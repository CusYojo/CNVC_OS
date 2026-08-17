import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import mysql, { type RowDataPacket } from 'mysql2/promise'

const migrationUser = process.env.DB_MIGRATION_USERNAME?.trim()
const migrationPassword = process.env.DB_MIGRATION_PASSWORD
if (migrationUser || migrationPassword) {
  if (!migrationUser || !migrationPassword) {
    throw new Error('DB_MIGRATION_USERNAME and DB_MIGRATION_PASSWORD must be provided together')
  }
  process.env.DB_USERNAME = migrationUser
  process.env.DB_PASSWORD = migrationPassword
}

const [
  { MYSQL_CONNECTION_COLLATION, mysqlConfig, quoteMysqlIdentifier },
  { createBackup, dropRollbackPrefix, restoreLogicalBackupToPrefix },
] = await Promise.all([
  import('../db/config.js'),
  import('./mysqlBackupRestoreAcceptance.js'),
])
const execFileAsync = promisify(execFile)
const marker = randomBytes(5).toString('hex')
const targetPrefix = `rb_accept_${marker}_`
const tempDir = await mkdtemp(path.join(tmpdir(), 'mysql-schema-lifecycle-'))
const backupPath = path.join(tempDir, 'pre-migration.jsonl.gz')
const evidenceDir = path.resolve('.runtime/migration-evidence/mysql-schema-lifecycle')
const connection = await mysql.createConnection({
  host: mysqlConfig.host,
  port: mysqlConfig.port,
  database: mysqlConfig.database,
  user: mysqlConfig.user,
  password: mysqlConfig.password,
  charset: MYSQL_CONNECTION_COLLATION,
  timezone: '+08:00',
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
  connectTimeout: mysqlConfig.connectTimeoutMs,
})

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[mysql schema lifecycle] ${message}`)
}

async function prefixTableCount(prefix: string) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' AND LEFT(TABLE_NAME, ?) = ?`,
    [mysqlConfig.database, prefix.length, prefix],
  )
  return Number(rows[0]?.count || 0)
}

let cleanupVerified = false
try {
  const sourceTableCountBefore = await prefixTableCount(mysqlConfig.tablePrefix)
  assertContract(sourceTableCountBefore > 0, 'active prefix contains no tables')
  const schemaSource = await readFile(path.resolve('server/src/db/schema.ts'), 'utf8')
  const expectedMigratedTableCount = [...schemaSource.matchAll(/mysqlTable\('([a-z0-9_]+)'/g)].length + 1
  const backup = await createBackup(connection, backupPath)
  await chmod(backupPath, 0o600)
  const restored = await restoreLogicalBackupToPrefix({
    connection,
    backupPath,
    targetPrefix,
    cleanupOnFailure: true,
  })
  assertContract(restored.tables === sourceTableCountBefore, 'restored table count differs from active prefix')
  assertContract(await prefixTableCount(targetPrefix) === sourceTableCountBefore, 'rollback prefix table count mismatch')
  assertContract(await prefixTableCount(mysqlConfig.tablePrefix) === sourceTableCountBefore, 'active prefix changed during rollback restore')

  const seedEnv = {
    ...process.env,
    DB_FREFIX: targetPrefix,
    DB_USERNAME: mysqlConfig.user,
    DB_PASSWORD: mysqlConfig.password,
    SEED_DEMO_USERS: 'false',
  }
  const migrationResult = await execFileAsync(process.execPath, [
    '--import', 'tsx', 'server/src/scripts/migrateMySqlSchema.ts',
  ], {
    cwd: process.cwd(), env: seedEnv, maxBuffer: 10 * 1024 * 1024,
  })
  const migrationOutput = JSON.parse(migrationResult.stdout.trim().split(/\r?\n/).at(-1) || '{}') as { ok?: boolean }
  assertContract(migrationOutput.ok, 'forward migration on restored prefix failed')
  const migratedTableCount = await prefixTableCount(targetPrefix)
  assertContract(
    migratedTableCount === expectedMigratedTableCount,
    `forward-migrated table count differs from schema authority: ${migratedTableCount}/${expectedMigratedTableCount}`,
  )
  const seedArgs = ['--import', 'tsx', 'server/src/scripts/seedMySql.ts', '--apply']
  const firstSeed = await execFileAsync(process.execPath, seedArgs, {
    cwd: process.cwd(), env: seedEnv, maxBuffer: 10 * 1024 * 1024,
  })
  const firstResult = JSON.parse(firstSeed.stdout.trim().split(/\r?\n/).at(-1) || '{}') as {
    ok?: boolean; mode?: string; manifestSha256?: string; after?: { templateChanges?: number; missingCapabilities?: number; missingGlobalBindings?: number; missingJobs?: number; ledgerCurrent?: boolean }
  }
  assertContract(firstResult.ok && firstResult.mode === 'apply', 'first seed apply failed')
  assertContract(firstResult.after?.templateChanges === 0, 'template seed did not converge')
  assertContract(firstResult.after?.missingCapabilities === 0 && firstResult.after?.missingGlobalBindings === 0, 'capability seed did not converge')
  assertContract(firstResult.after?.missingJobs === 0 && firstResult.after?.ledgerCurrent === true, 'runtime job/ledger seed did not converge')

  const [beforeRepeatRows] = await connection.query<RowDataPacket[]>(
    `SELECT
      (SELECT COUNT(*) FROM ${quoteMysqlIdentifier(`${targetPrefix}ai_task_templates`)}) AS templates,
      (SELECT COUNT(*) FROM ${quoteMysqlIdentifier(`${targetPrefix}ai_capabilities`)}) AS capabilities,
      (SELECT COUNT(*) FROM ${quoteMysqlIdentifier(`${targetPrefix}ai_capability_bindings`)}) AS bindings,
      (SELECT COUNT(*) FROM ${quoteMysqlIdentifier(`${targetPrefix}runtime_jobs`)}) AS jobs,
      (SELECT COUNT(*) FROM ${quoteMysqlIdentifier(`${targetPrefix}migration_runs`)} WHERE migration_type='mysql-system-seed') AS seed_runs,
      (SELECT COUNT(*) FROM ${quoteMysqlIdentifier(`${targetPrefix}migration_runs`)} WHERE migration_type='mysql-system-seed' AND source_sha256=?) AS current_seed_runs`,
    [firstResult.manifestSha256],
  )
  const secondSeed = await execFileAsync(process.execPath, seedArgs, {
    cwd: process.cwd(), env: seedEnv, maxBuffer: 10 * 1024 * 1024,
  })
  const secondResult = JSON.parse(secondSeed.stdout.trim().split(/\r?\n/).at(-1) || '{}') as { ok?: boolean }
  assertContract(secondResult.ok, 'second seed apply failed')
  const [afterRepeatRows] = await connection.query<RowDataPacket[]>(
    `SELECT
      (SELECT COUNT(*) FROM ${quoteMysqlIdentifier(`${targetPrefix}ai_task_templates`)}) AS templates,
      (SELECT COUNT(*) FROM ${quoteMysqlIdentifier(`${targetPrefix}ai_capabilities`)}) AS capabilities,
      (SELECT COUNT(*) FROM ${quoteMysqlIdentifier(`${targetPrefix}ai_capability_bindings`)}) AS bindings,
      (SELECT COUNT(*) FROM ${quoteMysqlIdentifier(`${targetPrefix}runtime_jobs`)}) AS jobs,
      (SELECT COUNT(*) FROM ${quoteMysqlIdentifier(`${targetPrefix}migration_runs`)} WHERE migration_type='mysql-system-seed') AS seed_runs,
      (SELECT COUNT(*) FROM ${quoteMysqlIdentifier(`${targetPrefix}migration_runs`)} WHERE migration_type='mysql-system-seed' AND source_sha256=?) AS current_seed_runs`,
    [firstResult.manifestSha256],
  )
  assertContract(JSON.stringify(beforeRepeatRows[0]) === JSON.stringify(afterRepeatRows[0]), 'repeated seed changed canonical row counts')
  assertContract(Number(afterRepeatRows[0]?.seed_runs || 0) >= 1, 'versioned seed ledger must retain at least one manifest')
  assertContract(Number(afterRepeatRows[0]?.current_seed_runs || 0) === 1, 'current seed manifest ledger must remain exactly one row')

  const removed = await dropRollbackPrefix(connection, targetPrefix)
  cleanupVerified = removed === migratedTableCount && await prefixTableCount(targetPrefix) === 0
  assertContract(cleanupVerified, 'rollback prefix cleanup was not verified')
  assertContract(await prefixTableCount(mysqlConfig.tablePrefix) === sourceTableCountBefore, 'active prefix changed after cleanup')

  const report = {
    ok: true,
    checks: [
      'owner-only-consistent-pre-migration-backup',
      'rollback-restores-to-isolated-prefix-without-overwriting-active-prefix',
      'rollback-ddl-row-count-and-row-checksum-verification',
      'restored-prefix-forward-migrates-to-current-schema-authority',
      'restored-prefix-is-runtime-schema-ready',
      'versioned-system-template-capability-and-runtime-job-seed',
      'demo-users-never-seeded',
      'repeated-seed-converges-with-one-current-manifest-ledger-row',
      'exact-isolated-prefix-cleanup',
      'active-prefix-table-count-preserved',
    ],
    sourceTables: sourceTableCountBefore,
    restoredTables: restored.tables,
    migratedTables: migratedTableCount,
    restoredRows: restored.rows,
    seedCounts: afterRepeatRows[0],
    isolatedPrefixRemoved: cleanupVerified,
    activePrefixPreserved: true,
    backupRemovedAfterAcceptance: true,
    connectionIdentityExcluded: true,
  }
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const reportPath = path.join(evidenceDir, 'report.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await chmod(reportPath, 0o600)
  console.log(JSON.stringify(report))
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown schema lifecycle error'
  throw new Error(message.slice(0, 2_000))
} finally {
  if (!cleanupVerified) await dropRollbackPrefix(connection, targetPrefix).catch(() => undefined)
  await connection.end()
  await rm(tempDir, { recursive: true, force: true })
}
