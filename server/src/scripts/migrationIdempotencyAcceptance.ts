import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
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
  { MYSQL_CONNECTION_COLLATION, mysqlConfig, mysqlTableName, quoteMysqlIdentifier },
  { createBackup, dropRollbackPrefix, restoreLogicalBackupToPrefix },
] = await Promise.all([
  import('../db/config.js'),
  import('./mysqlBackupRestoreAcceptance.js'),
])
const execFileAsync = promisify(execFile)
const targetPrefix = `rb_accept_${randomBytes(5).toString('hex')}_`
const tempDir = await mkdtemp(path.join(tmpdir(), 'migration-idempotency-'))
const backupPath = path.join(tempDir, 'active-prefix.jsonl.gz')
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

type TableSnapshot = {
  ddlSha256: string
  rows: number
  dataSha256: string
}

function stableValue(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() }
  if (Buffer.isBuffer(value)) return { $buffer: value.toString('base64') }
  if (typeof value === 'bigint') return { $bigint: value.toString() }
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]))
  }
  return value
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

async function snapshotDatabase(prefix: string): Promise<Record<string, TableSnapshot>> {
  const [tableRows] = await connection.query<Array<RowDataPacket & { tableName: string }>>(
    `SELECT TABLE_NAME AS tableName
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=? AND LEFT(TABLE_NAME,?)=? AND TABLE_TYPE='BASE TABLE'
      ORDER BY TABLE_NAME`,
    [mysqlConfig.database, prefix.length, prefix],
  )
  if (!tableRows.length) throw new Error('[migration idempotency] no prefixed MySQL tables found')

  const snapshot: Record<string, TableSnapshot> = {}
  for (const { tableName } of tableRows) {
    const quoted = quoteMysqlIdentifier(tableName)
    const [createRows] = await connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${quoted}`)
    const createRow = createRows[0]
    const ddl = String(createRow?.['Create Table'] || '')
    if (!ddl) throw new Error(`[migration idempotency] SHOW CREATE TABLE returned no DDL for ${tableName}`)

    const [primaryRows] = await connection.query<Array<RowDataPacket & { columnName: string }>>(
      `SELECT COLUMN_NAME AS columnName
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND CONSTRAINT_NAME='PRIMARY'
        ORDER BY ORDINAL_POSITION`,
      [mysqlConfig.database, tableName],
    )
    const orderBy = primaryRows.length
      ? ` ORDER BY ${primaryRows.map(({ columnName }) => quoteMysqlIdentifier(columnName)).join(',')}`
      : ''
    const [rows] = await connection.query<RowDataPacket[]>(`SELECT * FROM ${quoted}${orderBy}`)
    const rowHashes = rows.map((row) => sha256(JSON.stringify(stableValue(row))))
    if (!primaryRows.length) rowHashes.sort()
    snapshot[tableName] = {
      ddlSha256: sha256(ddl.replace(/ AUTO_INCREMENT=\d+/g, '')),
      rows: rows.length,
      dataSha256: sha256(rowHashes.join('\n')),
    }
  }
  return snapshot
}

async function prefixTableCount(prefix: string) {
  const [rows] = await connection.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) AS count FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' AND LEFT(TABLE_NAME,?)=?`,
    [mysqlConfig.database, prefix.length, prefix],
  )
  return Number(rows[0]?.count || 0)
}

async function runIsolatedMigration(env: NodeJS.ProcessEnv) {
  const result = await execFileAsync(process.execPath, [
    '--import', 'tsx', 'server/src/scripts/migrateMySqlSchema.ts',
  ], { cwd: process.cwd(), env, maxBuffer: 10 * 1024 * 1024 })
  const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) || '{}') as { ok?: boolean }
  if (!output.ok) throw new Error('[migration idempotency] isolated migration did not report success')
}

function assertEqual(
  expected: Record<string, TableSnapshot>,
  actual: Record<string, TableSnapshot>,
  label: string,
) {
  const expectedJson = JSON.stringify(expected)
  const actualJson = JSON.stringify(actual)
  if (expectedJson !== actualJson) {
    const names = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    const changed = names.filter((name) => JSON.stringify(expected[name]) !== JSON.stringify(actual[name]))
    throw new Error(`[migration idempotency] ${label} changed tables: ${changed.join(',')}`)
  }
}

async function main() {
  const sourceTableCount = await prefixTableCount(mysqlConfig.tablePrefix)
  let cleanupVerified = false
  try {
    await createBackup(connection, backupPath)
    await chmod(backupPath, 0o600)
    const restored = await restoreLogicalBackupToPrefix({
      connection, backupPath, targetPrefix, cleanupOnFailure: true,
    })
    if (restored.tables !== sourceTableCount) {
      throw new Error('[migration idempotency] isolated restore table count differs from active prefix')
    }
    const migrationEnv = {
      ...process.env,
      DB_FREFIX: targetPrefix,
      DB_USERNAME: mysqlConfig.user,
      DB_PASSWORD: mysqlConfig.password,
    }
    await runIsolatedMigration(migrationEnv)
    const before = await snapshotDatabase(targetPrefix)
    await runIsolatedMigration(migrationEnv)
    const afterFirst = await snapshotDatabase(targetPrefix)
    assertEqual(before, afterFirst, 'first repeat')
    await runIsolatedMigration(migrationEnv)
    const afterSecond = await snapshotDatabase(targetPrefix)
    assertEqual(afterFirst, afterSecond, 'second repeat')

    const migrationTable = mysqlTableName('__drizzle_migrations').replace(mysqlConfig.tablePrefix, targetPrefix)
    const [journalRows] = await connection.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) AS count FROM ${quoteMysqlIdentifier(migrationTable)}`,
    )
    const isolatedTableCount = Object.keys(before).length
    const removed = await dropRollbackPrefix(connection, targetPrefix)
    cleanupVerified = removed === isolatedTableCount && await prefixTableCount(targetPrefix) === 0
    if (!cleanupVerified) throw new Error('[migration idempotency] isolated prefix cleanup failed')
    if (await prefixTableCount(mysqlConfig.tablePrefix) !== sourceTableCount) {
      throw new Error('[migration idempotency] active prefix table count changed')
    }
    console.log(JSON.stringify({
      ok: true,
      checks: [
        'active-prefix-consistent-backup-restored-to-isolated-prefix',
        'first-repeat-schema-and-data-unchanged',
        'second-repeat-schema-and-data-unchanged',
        'isolated-prefix-cleanup-verified',
        'active-prefix-preserved',
      ],
      tables: isolatedTableCount,
      rows: Object.values(before).reduce((total, table) => total + table.rows, 0),
      migrationJournalEntries: Number(journalRows[0]?.count || 0),
      activePrefixWrites: 0,
    }))
  } finally {
    if (!cleanupVerified) await dropRollbackPrefix(connection, targetPrefix).catch(() => undefined)
  }
}

await main().finally(async () => {
  await connection.end()
  await rm(tempDir, { recursive: true, force: true })
})
