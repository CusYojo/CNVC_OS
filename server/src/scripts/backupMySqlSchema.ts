import { mkdir, chmod, access, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import { createBackup, sha256 } from './mysqlBackupRestoreAcceptance.js'
import { MYSQL_CONNECTION_COLLATION, mysqlConfig } from '../db/config.js'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined
}

const requestedOutput = option('--output')
const outputPath = requestedOutput
  ? path.resolve(requestedOutput)
  : path.resolve('.runtime', 'mysql-backups', `mysql-pre-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl.gz`)
if (!outputPath.endsWith('.jsonl.gz')) throw new Error('backup output must end with .jsonl.gz')
await access(outputPath).then(
  () => { throw new Error('backup output already exists; refusing to overwrite') },
  () => undefined,
)
await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 })

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
    [mysqlConfig.database, mysqlConfig.tablePrefix.length, mysqlConfig.tablePrefix],
  )
  const existingTables = Number(existingRows[0]?.count || 0)
  if (existingTables === 0) {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: 'empty-prefix-first-install',
      prefix: mysqlConfig.tablePrefix,
      connectionIdentityExcluded: true,
    }))
    process.exitCode = 0
  } else {
  const backup = await createBackup(connection, outputPath)
  await chmod(outputPath, 0o600)
  const backupBytes = await import('node:fs/promises').then(({ readFile }) => readFile(outputPath))
  const reportPath = `${outputPath}.report.json`
  const report = {
    ok: true,
    format: backup.header.format,
    version: backup.header.version,
    prefix: backup.header.tablePrefix,
    tables: backup.summaries.length,
    rows: backup.summaries.reduce((sum, item) => sum + item.rows, 0),
    sha256: sha256(backupBytes),
    durationMs: backup.durationMs,
    ownerOnly: true,
    connectionIdentityExcluded: true,
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await chmod(reportPath, 0o600)
  console.log(JSON.stringify({ ...report, outputPath, reportPath }))
  }
} finally {
  await connection.end()
}
