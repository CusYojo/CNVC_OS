import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGunzip, createGzip } from 'node:zlib'
import { finished } from 'node:stream/promises'
import { once } from 'node:events'
import readline from 'node:readline'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'
import { MYSQL_CONNECTION_COLLATION, mysqlConfig, quoteMysqlIdentifier } from '../db/config.js'

type EncodedValue = null | number | boolean | { __type: 'buffer' | 'string' | 'date' | 'json'; value: string }
export type TableMetadata = {
  name: string
  createSql: string
  columns: string[]
  ddlChecksum: string
}
export type TableSummary = { name: string; rows: number; rowChecksum: string; ddlChecksum: string }
export type BackupHeader = {
  type: 'header'; format: 'cybernaut-mysql-logical-backup'; version: 1;
  createdAt: string; charset: string; collation: string; tablePrefix?: string; tables: TableMetadata[]
}
type BackupRows = { type: 'rows'; table: string; values: EncodedValue[][] }
export type BackupFooter = { type: 'footer'; tables: TableSummary[] }

const maxBackupSeconds = boundedInteger('MYSQL_BACKUP_MAX_SECONDS', 300, 1, 86_400)
const maxRestoreSeconds = boundedInteger('MYSQL_RESTORE_MAX_SECONDS', 300, 1, 86_400)
const outputRoot = path.resolve(process.env.MYSQL_RESTORE_EVIDENCE_ROOT || path.join(process.cwd(), '.runtime', 'migration-evidence', 'mysql-restore'))

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be ${minimum}..${maximum}`)
  return value
}

export function normalizeDdl(value: string) {
  return value.replace(/AUTO_INCREMENT=\d+\s*/gi, '').replace(/\s+/g, ' ').trim()
}

function canonicalRollbackDdl(value: string) {
  const named = value
    .replace(/AUTO_INCREMENT=\d+\s*/gi, '')
    .replace(/^CREATE TABLE `[^`]+`/i, 'CREATE TABLE `<table>`')
    .replace(/CONSTRAINT `[^`]+`/gi, 'CONSTRAINT `<constraint>`')
    .replace(/\bUNIQUE KEY `[^`]+`/gi, 'UNIQUE KEY `<index>`')
    .replace(/(?<!UNIQUE )\bKEY `[^`]+`/gi, 'KEY `<index>`')
  const lines = named.split(/\r?\n/).map((line) => line.trim().replace(/,$/, '')).filter(Boolean)
  if (lines.length < 3) return normalizeDdl(named)
  const header = lines[0]
  const tail = lines.at(-1) || ''
  const body = lines.slice(1, -1)
  const namedConstraints = body.filter((line) => /^(?:UNIQUE KEY|KEY|CONSTRAINT)\b/i.test(line)).sort()
  const orderedColumns = body.filter((line) => !/^(?:UNIQUE KEY|KEY|CONSTRAINT)\b/i.test(line))
  return [header, ...orderedColumns, ...namedConstraints, tail].map((line) => normalizeDdl(line)).join(' | ')
}

function ddlDifference(left: string, right: string) {
  let index = 0
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1
  return {
    index,
    expected: left.slice(Math.max(0, index - 60), index + 120),
    actual: right.slice(Math.max(0, index - 60), index + 120),
  }
}

export function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function encodeValue(value: unknown): EncodedValue {
  if (value == null) return null
  if (Buffer.isBuffer(value)) return { __type: 'buffer', value: value.toString('base64') }
  if (value instanceof Date) return { __type: 'date', value: Buffer.from(value.toISOString()).toString('base64') }
  if (typeof value === 'bigint') return { __type: 'string', value: Buffer.from(value.toString()).toString('base64') }
  if (typeof value === 'string') return { __type: 'string', value: Buffer.from(value).toString('base64') }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return { __type: 'json', value: Buffer.from(JSON.stringify(value)).toString('base64') }
}

function decodeValue(value: EncodedValue): unknown {
  if (!value || typeof value !== 'object') return value
  if (value.__type === 'buffer') return Buffer.from(value.value, 'base64')
  return Buffer.from(value.value, 'base64').toString('utf8')
}

function tableRowChecksum(rows: RowDataPacket[], columns: string[]) {
  const rowHashes = rows.map((row) => sha256(JSON.stringify(columns.map((column) => encodeValue(row[column]))))).sort()
  return sha256(rowHashes.join('\n'))
}

function connectionOptions(database?: string) {
  return {
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    user: mysqlConfig.user,
    password: mysqlConfig.password,
    ...(database ? { database } : {}),
    charset: MYSQL_CONNECTION_COLLATION,
    timezone: '+08:00',
    dateStrings: true as const,
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectTimeout: mysqlConfig.connectTimeoutMs,
  }
}

async function writeGzipLine(gzip: ReturnType<typeof createGzip>, value: unknown) {
  if (!gzip.write(`${JSON.stringify(value)}\n`)) await once(gzip, 'drain')
}

async function loadMetadata(connection: Connection): Promise<{ charset: string; collation: string; tables: TableMetadata[] }> {
  const [schemaRows] = await connection.query<RowDataPacket[]>(
    `SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation
       FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?`,
    [mysqlConfig.database],
  )
  const charset = String(schemaRows[0]?.charset || '')
  const collation = String(schemaRows[0]?.collation || '')
  if (!/^[A-Za-z0-9_]+$/.test(charset) || !/^[A-Za-z0-9_]+$/.test(collation)) throw new Error('source schema charset/collation is unsafe')
  const [unsupported] = await connection.query<RowDataPacket[]>(
    `SELECT
       (SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA=?) AS views,
       (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=?) AS triggers,
       (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=?) AS routines,
       (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=?) AS events`,
    [mysqlConfig.database, mysqlConfig.database, mysqlConfig.database, mysqlConfig.database],
  )
  if (['views', 'triggers', 'routines', 'events'].some((key) => Number(unsupported[0]?.[key] || 0) !== 0)) {
    throw new Error('logical backup currently requires zero views, triggers, routines and events; unsupported objects were found')
  }
  const [tableRows] = await connection.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS tableName FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' AND LEFT(TABLE_NAME, ?) = ? ORDER BY TABLE_NAME`,
    [mysqlConfig.database, mysqlConfig.tablePrefix.length, mysqlConfig.tablePrefix],
  )
  const tables: TableMetadata[] = []
  for (const tableRow of tableRows) {
    const name = String(tableRow.tableName)
    const quoted = quoteMysqlIdentifier(name)
    const [ddlRows] = await connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${quoted}`)
    const createSql = String(ddlRows[0]?.['Create Table'] || '')
    const [columnRows] = await connection.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME AS columnName FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND EXTRA NOT LIKE '%GENERATED%' ORDER BY ORDINAL_POSITION`,
      [mysqlConfig.database, name],
    )
    const columns = columnRows.map((row) => String(row.columnName))
    if (!createSql || !columns.length) throw new Error(`cannot inspect table ${name}`)
    tables.push({ name, createSql, columns, ddlChecksum: sha256(normalizeDdl(createSql)) })
  }
  if (!tables.length) throw new Error('source schema contains no tables')
  return { charset, collation, tables }
}

export async function createBackup(connection: Connection, backupPath: string) {
  const startedAt = Date.now()
  const migrationLock = `cybernaut-migrate-${sha256(`${mysqlConfig.database}:${mysqlConfig.tablePrefix}`).slice(0, 32)}`
  const [lockRows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 60) AS acquired', [migrationLock])
  if (Number(lockRows[0]?.acquired || 0) !== 1) throw new Error('timed out waiting for migration lock before backup')
  const output = createWriteStream(backupPath, { mode: 0o600 })
  const gzip = createGzip({ level: 9 })
  gzip.pipe(output)
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT')
    const metadata = await loadMetadata(connection)
    const header: BackupHeader = {
      type: 'header', format: 'cybernaut-mysql-logical-backup', version: 1,
      createdAt: new Date().toISOString(), tablePrefix: mysqlConfig.tablePrefix, ...metadata,
    }
    await writeGzipLine(gzip, header)
    const summaries: TableSummary[] = []
    for (const table of metadata.tables) {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT ${table.columns.map(quoteMysqlIdentifier).join(',')} FROM ${quoteMysqlIdentifier(table.name)}`,
      )
      for (let offset = 0; offset < rows.length; offset += 100) {
        const record: BackupRows = {
          type: 'rows', table: table.name,
          values: rows.slice(offset, offset + 100).map((row) => table.columns.map((column) => encodeValue(row[column]))),
        }
        await writeGzipLine(gzip, record)
      }
      summaries.push({ name: table.name, rows: rows.length, rowChecksum: tableRowChecksum(rows, table.columns), ddlChecksum: table.ddlChecksum })
    }
    const footer: BackupFooter = { type: 'footer', tables: summaries }
    await writeGzipLine(gzip, footer)
    await connection.query('COMMIT')
    gzip.end()
    await finished(output)
    const durationMs = Date.now() - startedAt
    if (durationMs > maxBackupSeconds * 1000) throw new Error(`backup exceeded ${maxBackupSeconds}s target`)
    return { header, summaries, durationMs }
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined)
    gzip.destroy(error as Error)
    throw error
  } finally {
    await connection.query('SELECT RELEASE_LOCK(?)', [migrationLock]).catch(() => undefined)
  }
}

export async function inspectLogicalBackup(backupPath: string): Promise<{
  header: BackupHeader
  footer: BackupFooter
  backupSha256: string
  totalRows: number
}> {
  const backupSha256 = sha256(await import('node:fs/promises').then(({ readFile }) => readFile(backupPath)))
  const lines = readline.createInterface({ input: createReadStream(backupPath).pipe(createGunzip()), crlfDelay: Infinity })
  let header: BackupHeader | null = null
  let footer: BackupFooter | null = null
  for await (const line of lines) {
    const record = JSON.parse(line) as BackupHeader | BackupRows | BackupFooter
    if (record.type === 'header') {
      if (header || record.format !== 'cybernaut-mysql-logical-backup' || record.version !== 1) {
        throw new Error('unsupported or duplicate backup header')
      }
      header = record
    } else if (record.type === 'footer') {
      if (footer) throw new Error('duplicate backup footer')
      footer = record
    }
  }
  if (!header || !footer) throw new Error('backup is missing header or footer')
  if (!header.tables.length || header.tables.length !== footer.tables.length) throw new Error('backup table manifest is incomplete')
  const headerNames = header.tables.map((item) => item.name)
  const footerNames = footer.tables.map((item) => item.name)
  if (new Set(headerNames).size !== headerNames.length || headerNames.join('\n') !== footerNames.join('\n')) {
    throw new Error('backup table manifest/footer ordering or uniqueness mismatch')
  }
  return {
    header,
    footer,
    backupSha256,
    totalRows: footer.tables.reduce((sum, item) => sum + item.rows, 0),
  }
}

function rollbackPrefix(value: string): string {
  if (!/^(?:rollback|rb_accept)_[a-z0-9]{8,16}_$/.test(value) || value.length > 32) {
    throw new Error('rollback target prefix must match rollback_<8-16 lowercase letters/digits>_')
  }
  if (value === mysqlConfig.tablePrefix) throw new Error('rollback target prefix must differ from the active prefix')
  return value
}

function boundedIdentifier(value: string): string {
  if (value.length <= 64) return value
  const suffix = sha256(value).slice(0, 12)
  return `${value.slice(0, 51)}_${suffix}`
}

function rewriteBackupDdlForPrefix(createSql: string, sourcePrefix: string, targetPrefix: string): string {
  let rewritten = createSql.replace(/CONSTRAINT `([^`]+)`/gi, (_match, name: string) => {
    const targetName = name.startsWith(sourcePrefix)
      ? `${targetPrefix}${name.slice(sourcePrefix.length)}`
      : `${targetPrefix}${name}`
    return `CONSTRAINT \`${boundedIdentifier(targetName)}\``
  })
  rewritten = rewritten.replace(/`([^`]+)`/g, (match, name: string) => (
    name.startsWith(sourcePrefix)
      ? `\`${boundedIdentifier(`${targetPrefix}${name.slice(sourcePrefix.length)}`)}\``
      : match
  ))
  return rewritten
}

async function rollbackTargetTables(connection: Connection, targetPrefix: string): Promise<string[]> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS tableName FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' AND LEFT(TABLE_NAME, ?) = ? ORDER BY TABLE_NAME`,
    [mysqlConfig.database, targetPrefix.length, targetPrefix],
  )
  return rows.map((row) => String(row.tableName))
}

export async function dropRollbackPrefix(connection: Connection, rawTargetPrefix: string): Promise<number> {
  const targetPrefix = rollbackPrefix(rawTargetPrefix)
  const tables = await rollbackTargetTables(connection, targetPrefix)
  if (!tables.length) return 0
  await connection.query('SET FOREIGN_KEY_CHECKS=0')
  try {
    for (const table of tables) await connection.query(`DROP TABLE ${quoteMysqlIdentifier(table)}`)
  } finally {
    await connection.query('SET FOREIGN_KEY_CHECKS=1')
  }
  return tables.length
}

export async function restoreLogicalBackupToPrefix(input: {
  connection: Connection
  backupPath: string
  targetPrefix: string
  cleanupOnFailure?: boolean
}): Promise<{
  sourcePrefix: string
  targetPrefix: string
  tables: number
  rows: number
  backupSha256: string
  restoreDurationMs: number
  verified: true
}> {
  const restoreStartedAt = Date.now()
  const targetPrefix = rollbackPrefix(input.targetPrefix)
  const inspected = await inspectLogicalBackup(input.backupPath)
  const sourcePrefix = inspected.header.tablePrefix || mysqlConfig.tablePrefix
  if (!/^[A-Za-z0-9_]+$/.test(sourcePrefix)) throw new Error('backup source prefix is unsafe')
  if (inspected.header.tables.some((table) => !table.name.startsWith(sourcePrefix))) {
    throw new Error('backup contains a table outside its declared source prefix')
  }
  const existing = await rollbackTargetTables(input.connection, targetPrefix)
  if (existing.length) throw new Error(`rollback target prefix already contains ${existing.length} table(s)`)

  const expectedByTarget = new Map(inspected.header.tables.map((table) => {
    const targetName = `${targetPrefix}${table.name.slice(sourcePrefix.length)}`
    const expectedDdl = rewriteBackupDdlForPrefix(table.createSql, sourcePrefix, targetPrefix)
    return [targetName, { ...table, targetName, expectedDdl }]
  }))
  let restoredRows = 0
  let lastRestoredTable = ''
  try {
    await input.connection.query('SET FOREIGN_KEY_CHECKS=0')
    for (const table of expectedByTarget.values()) await input.connection.query(table.expectedDdl)
    const createdTables = new Set(await rollbackTargetTables(input.connection, targetPrefix))
    const missingTables = [...expectedByTarget.keys()].filter((name) => !createdTables.has(name))
    if (missingTables.length || createdTables.size !== expectedByTarget.size) {
      throw new Error(`rollback table creation mismatch missing=${missingTables.length} actual=${createdTables.size} expected=${expectedByTarget.size}`)
    }

    const lines = readline.createInterface({ input: createReadStream(input.backupPath).pipe(createGunzip()), crlfDelay: Infinity })
    for await (const line of lines) {
      const record = JSON.parse(line) as BackupHeader | BackupRows | BackupFooter
      if (record.type === 'header') continue
      if (record.type !== 'rows' || !record.values.length) continue
      const targetName = `${targetPrefix}${record.table.slice(sourcePrefix.length)}`
      const table = expectedByTarget.get(targetName)
      if (!table) throw new Error(`backup row references unknown rollback table ${record.table}`)
      if (record.table !== lastRestoredTable) {
        const [beforeRows] = await input.connection.query<RowDataPacket[]>(
          'SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
          [mysqlConfig.database, targetName],
        )
        if (Number(beforeRows[0]?.count || 0) !== 1) {
          throw new Error(`rollback target disappeared before rows table=${record.table} previous=${lastRestoredTable || 'none'} targetTables=${(await rollbackTargetTables(input.connection, targetPrefix)).length}`)
        }
        lastRestoredTable = record.table
      }
      if (record.values.some((row) => row.length !== table.columns.length)) throw new Error(`column mismatch in ${record.table}`)
      const placeholders = record.values.map(() => `(${table.columns.map(() => '?').join(',')})`).join(',')
      try {
        await input.connection.query(
          `INSERT INTO ${quoteMysqlIdentifier(targetName)} (${table.columns.map(quoteMysqlIdentifier).join(',')}) VALUES ${placeholders}`,
          record.values.flatMap((row) => row.map(decodeValue)),
        )
      } catch (error) {
        const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'UNKNOWN'
        const [existenceRows] = await input.connection.query<RowDataPacket[]>(
          'SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
          [mysqlConfig.database, targetName],
        )
        const currentTargetCount = (await rollbackTargetTables(input.connection, targetPrefix)).length
        throw new Error(`rollback row restore failed table=${record.table} code=${code} targetExists=${Number(existenceRows[0]?.count || 0) === 1} targetTables=${currentTargetCount}`)
      }
      restoredRows += record.values.length
    }
    await input.connection.query('SET FOREIGN_KEY_CHECKS=1')

    const actual: TableSummary[] = []
    for (const table of expectedByTarget.values()) {
      const [ddlRows] = await input.connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${quoteMysqlIdentifier(table.targetName)}`)
      const [rows] = await input.connection.query<RowDataPacket[]>(
        `SELECT ${table.columns.map(quoteMysqlIdentifier).join(',')} FROM ${quoteMysqlIdentifier(table.targetName)}`,
      )
      actual.push({
        name: table.name,
        rows: rows.length,
        rowChecksum: tableRowChecksum(rows, table.columns),
        ddlChecksum: sha256(canonicalRollbackDdl(String(ddlRows[0]?.['Create Table'] || ''))),
      })
      const expectedCanonicalDdl = canonicalRollbackDdl(table.expectedDdl)
      const actualCanonicalDdl = canonicalRollbackDdl(String(ddlRows[0]?.['Create Table'] || ''))
      const expectedDdlChecksum = sha256(expectedCanonicalDdl)
      if (actual.at(-1)?.ddlChecksum !== expectedDdlChecksum) {
        throw new Error(`rollback DDL checksum mismatch: ${table.name} ${JSON.stringify(ddlDifference(expectedCanonicalDdl, actualCanonicalDdl))}`)
      }
    }
    const actualByName = new Map(actual.map((item) => [item.name, item]))
    for (const expected of inspected.footer.tables) {
      const value = actualByName.get(expected.name)
      if (!value || value.rows !== expected.rows || value.rowChecksum !== expected.rowChecksum) {
        throw new Error(`rollback row verification failed: ${expected.name}`)
      }
    }
    if (restoredRows !== inspected.totalRows) throw new Error('rollback restored row total mismatch')
    const restoreDurationMs = Date.now() - restoreStartedAt
    if (restoreDurationMs > maxRestoreSeconds * 1000) {
      throw new Error(`restore exceeded ${maxRestoreSeconds}s target`)
    }
    return {
      sourcePrefix,
      targetPrefix,
      tables: actual.length,
      rows: restoredRows,
      backupSha256: inspected.backupSha256,
      restoreDurationMs,
      verified: true,
    }
  } catch (error) {
    await input.connection.query('SET FOREIGN_KEY_CHECKS=1').catch(() => undefined)
    if (input.cleanupOnFailure !== false) await dropRollbackPrefix(input.connection, targetPrefix).catch(() => undefined)
    throw error
  }
}

async function main() {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const outputDir = path.join(outputRoot, runId)
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  await chmod(outputDir, 0o700)
  const temporaryDir = await mkdtemp(path.join(tmpdir(), 'mysql-backup-restore-'))
  const backupPath = path.join(temporaryDir, 'mysql-logical-backup.jsonl.gz')
  const reportPath = path.join(outputDir, 'report.json')
  const targetPrefix = `rb_accept_${randomUUID().replaceAll('-', '').slice(0, 10)}_`
  const migrationUser = process.env.DB_MIGRATION_USERNAME?.trim()
  const migrationPassword = process.env.DB_MIGRATION_PASSWORD
  if (!migrationUser || !migrationPassword) throw new Error('separated migration credentials are required for isolated-prefix restore')
  const source = await mysql.createConnection({ ...connectionOptions(mysqlConfig.database), user: mysqlConfig.user, password: mysqlConfig.password })
  const restore = await mysql.createConnection({
    ...connectionOptions(mysqlConfig.database), user: migrationUser, password: migrationPassword,
  })
  let cleanupVerified = false
  try {
    const backup = await createBackup(source, backupPath)
    await chmod(backupPath, 0o600)
    const backupFile = await import('node:fs/promises').then(({ readFile }) => readFile(backupPath))
    const backupSha256 = sha256(backupFile)
    const restored = await restoreLogicalBackupToPrefix({
      connection: restore, backupPath, targetPrefix, cleanupOnFailure: true,
    })
    const removed = await dropRollbackPrefix(restore, targetPrefix)
    cleanupVerified = removed === restored.tables && (await rollbackTargetTables(restore, targetPrefix)).length === 0
    if (!cleanupVerified) throw new Error('isolated restore prefix cleanup was not verified')
    const report = {
      ok: true, runId, format: backup.header.format, backupSha256,
      tables: restored.tables, rows: restored.rows, rpoRows: 0,
      backupDurationMs: backup.durationMs, restoreDurationMs: restored.restoreDurationMs,
      targets: { maxBackupSeconds, maxRestoreSeconds, maxRpoRows: 0 },
      ddlChecksumsMatch: true, rowCountsMatch: true, rowChecksumsMatch: true,
      isolatedPrefixRemoved: cleanupVerified, activePrefixPreserved: true,
      backupRemovedAfterAcceptance: true, artifactMode: '0600',
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    await chmod(reportPath, 0o600)
    console.log(JSON.stringify(report))
  } finally {
    if (!cleanupVerified) {
      await dropRollbackPrefix(restore, targetPrefix).catch(() => undefined)
    }
    await Promise.all([source.end(), restore.end()])
    await rm(temporaryDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    process.exitCode = 1
  })
}
