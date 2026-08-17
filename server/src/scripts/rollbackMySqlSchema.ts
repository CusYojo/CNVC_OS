import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql, { type RowDataPacket } from 'mysql2/promise'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined
}

const apply = process.argv.includes('--apply')
const backupPath = path.resolve(option('--backup') || '')
const targetPrefix = option('--target-prefix') || ''
if (!option('--backup')) throw new Error('--backup is required')
if (!targetPrefix) throw new Error('--target-prefix is required')

const migrationUser = process.env.DB_MIGRATION_USERNAME?.trim()
const migrationPassword = process.env.DB_MIGRATION_PASSWORD
if (apply && (migrationUser || migrationPassword)) {
  if (!migrationUser || !migrationPassword) {
    throw new Error('DB_MIGRATION_USERNAME and DB_MIGRATION_PASSWORD must be provided together')
  }
  process.env.DB_USERNAME = migrationUser
  process.env.DB_PASSWORD = migrationPassword
}

const [
  { MYSQL_CONNECTION_COLLATION, mysqlConfig },
  { inspectLogicalBackup, restoreLogicalBackupToPrefix, sha256 },
] = await Promise.all([
  import('../db/config.js'),
  import('./mysqlBackupRestoreAcceptance.js'),
])
const inspected = await inspectLogicalBackup(backupPath)
const sourcePrefix = inspected.header.tablePrefix || mysqlConfig.tablePrefix
if (sourcePrefix !== mysqlConfig.tablePrefix) {
  throw new Error(`backup prefix ${sourcePrefix} does not match active DB_FREFIX`)
}

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
try {
  const [existingRows] = await connection.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' AND LEFT(TABLE_NAME, ?) = ?`,
    [mysqlConfig.database, targetPrefix.length, targetPrefix],
  )
  const existingTargetTables = Number(existingRows[0]?.count || 0)
  if (existingTargetTables) throw new Error(`rollback target prefix already contains ${existingTargetTables} table(s)`)
  const planned = {
    mode: apply ? 'apply' : 'preview',
    sourcePrefix,
    targetPrefix,
    tables: inspected.header.tables.length,
    rows: inspected.totalRows,
    backupSha256: inspected.backupSha256,
    currentPrefixPreserved: true,
    requiresConfigCutoverAfterApply: true,
  }
  if (!apply) {
    console.log(JSON.stringify({ ok: true, ...planned }))
  } else {
    const restored = await restoreLogicalBackupToPrefix({
      connection,
      backupPath,
      targetPrefix,
      cleanupOnFailure: true,
    })
    const evidenceDir = path.resolve('.runtime/migration-evidence/mysql-schema-rollback')
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
    await chmod(evidenceDir, 0o700)
    const reportPath = path.join(evidenceDir, `rollback-${Date.now()}-${sha256(targetPrefix).slice(0, 8)}.json`)
    const report = {
      ok: true,
      mode: 'apply',
      backupSha256: restored.backupSha256,
      sourcePrefixSha256: sha256(restored.sourcePrefix),
      targetPrefixSha256: sha256(restored.targetPrefix),
      tables: restored.tables,
      rows: restored.rows,
      restoreDurationMs: restored.restoreDurationMs,
      verified: restored.verified,
      currentPrefixPreserved: true,
      configMutationPerformed: false,
      nextStep: 'set DB_FREFIX to the restored target prefix and restart only after approval',
      connectionIdentityExcluded: true,
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    await chmod(reportPath, 0o600)
    console.log(JSON.stringify({ ...report, reportPath }))
  }
} finally {
  await connection.end()
}
