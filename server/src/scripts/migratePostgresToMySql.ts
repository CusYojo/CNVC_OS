import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'
import {
  legacySyntheticColumnValue,
  supportsLegacySyntheticColumn,
} from './migrationLegacyEvolution.js'

const TABLE_ORDER = [
  'users',
  'projects',
  'project_files',
  'meetings',
  'todos',
  'risks',
  'ai_summaries',
  'leads',
  'audit_logs',
  'chat_conversations',
  'file_chunks',
  'knowledge_chunks',
  'ai_tasks',
  'ai_artifacts',
  'ai_task_sources',
  'ai_custom_templates',
  'radar_sync_state',
] as const

type TargetColumn = {
  columnName: string
  dataType: string
  extra: string
}

type TableReport = {
  table: string
  sourceRows: number
  targetRowsBefore: number
  targetRowsAfter: number
  readRows: number
  writtenRows: number
  skippedRows: number
  failedRows: number
  sourceHash: string
  targetHash: string
  policy: 'online-source-authoritative' | 'preserve-backup-data' | 'online-user-profile-preserve-target-id'
  status: 'preview' | 'verified' | 'verified-preserved'
}

const apply = process.argv.includes('--apply')
const sourceUrl = (() => {
  const value = process.env.DATABASE_URL?.trim()
  if (!value) throw new Error('DATABASE_URL is required for the legacy PostgreSQL source')
  return value
})()

function assertSafeName(value: string, label: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error(`unsafe ${label}: ${value}`)
}

function quotePostgresIdentifier(value: string): string {
  assertSafeName(value, 'PostgreSQL identifier')
  return `"${value}"`
}

function canonicalValue(value: unknown, dataType: string): unknown {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (dataType === 'json' && typeof value === 'string') {
    try {
      return canonicalValue(JSON.parse(value), dataType)
    } catch {
      return value
    }
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, dataType))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item, dataType)]))
  }
  return value
}

function rowsHash(rows: Record<string, unknown>[], columns: TargetColumn[]): string {
  const canonical = rows.map((row) => Object.fromEntries(columns.map((column) => [
    column.columnName,
    canonicalValue(row[column.columnName], column.dataType),
  ])))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function rowsHashByKey(
  rows: Record<string, unknown>[],
  columns: TargetColumn[],
  key: string,
): string {
  const sorted = [...rows].sort((left, right) => String(left[key]).localeCompare(String(right[key])))
  return rowsHash(sorted, columns)
}

function mysqlValue(value: unknown, dataType: string): unknown {
  if (value == null) return null
  if (dataType === 'json') return JSON.stringify(value)
  return value
}

async function targetColumns(connection: PoolConnection, table: string): Promise<TargetColumn[]> {
  const [rows] = await connection.query<RowDataPacket[]>(`
    SELECT COLUMN_NAME AS columnName, DATA_TYPE AS dataType, EXTRA AS extra
    FROM information_schema.columns
    WHERE table_schema = ? AND table_name = ?
    ORDER BY ORDINAL_POSITION
  `, [mysqlConfig.database, mysqlTableName(table)])
  return rows
    .map((row) => ({
      columnName: String(row.columnName),
      dataType: String(row.dataType).toLowerCase(),
      extra: String(row.extra ?? ''),
    }))
    .filter((column) => !column.extra.toLowerCase().includes('generated'))
}

async function sourceColumns(client: pg.Client, table: string): Promise<Set<string>> {
  const result = await client.query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [table])
  return new Set(result.rows.map((row) => row.column_name))
}

async function selectSourceRows(
  client: pg.Client,
  table: string,
  columns: TargetColumn[],
): Promise<Record<string, unknown>[]> {
  const projection = columns.map((column) => quotePostgresIdentifier(column.columnName)).join(', ')
  const orderColumn = columns.some((column) => column.columnName === 'id') ? 'id' : columns[0]?.columnName
  if (!projection || !orderColumn) throw new Error(`no migratable columns for source table ${table}`)
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${projection} FROM public.${quotePostgresIdentifier(table)} ORDER BY ${quotePostgresIdentifier(orderColumn)}`,
  )
  return result.rows
}

async function selectTargetRows(
  connection: PoolConnection,
  table: string,
  columns: TargetColumn[],
): Promise<Record<string, unknown>[]> {
  const projection = columns.map((column) => quoteMysqlIdentifier(column.columnName)).join(', ')
  const orderColumn = columns.some((column) => column.columnName === 'id') ? 'id' : columns[0]?.columnName
  if (!projection || !orderColumn) throw new Error(`no migratable columns for target table ${table}`)
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT ${projection} FROM ${quoteMysqlIdentifier(mysqlTableName(table))} ORDER BY ${quoteMysqlIdentifier(orderColumn)}`,
  )
  return rows as Record<string, unknown>[]
}

async function upsertRows(
  connection: PoolConnection,
  table: string,
  columns: TargetColumn[],
  rows: Record<string, unknown>[],
): Promise<void> {
  const batchSize = Math.max(1, Number(process.env.DB_MIGRATION_BATCH_SIZE ?? 200))
  if (!Number.isInteger(batchSize) || batchSize > 2_000) {
    throw new Error('DB_MIGRATION_BATCH_SIZE must be an integer between 1 and 2000')
  }
  const names = columns.map((column) => quoteMysqlIdentifier(column.columnName)).join(', ')
  const updates = columns.map((column) => {
    const name = quoteMysqlIdentifier(column.columnName)
    return `${name}=new.${name}`
  }).join(', ')

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize)
    const placeholders = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ')
    const values = batch.flatMap((row) => columns.map((column) => mysqlValue(row[column.columnName], column.dataType)))
    await connection.query(
      `INSERT INTO ${quoteMysqlIdentifier(mysqlTableName(table))} (${names}) VALUES ${placeholders} AS new ON DUPLICATE KEY UPDATE ${updates}`,
      values,
    )
  }
}

async function mergeUsersByEmail(
  connection: PoolConnection,
  columns: TargetColumn[],
  sourceRows: Record<string, unknown>[],
  targetRows: Record<string, unknown>[],
): Promise<void> {
  const targetEmails = new Set(targetRows.map((row) => String(row.email).toLowerCase()))
  const missing = sourceRows.filter((row) => !targetEmails.has(String(row.email).toLowerCase()))
  if (missing.length > 0) {
    await upsertRows(connection, 'users', columns, missing)
  }

  const updateColumns = columns.filter((column) => column.columnName !== 'id' && column.columnName !== 'email')
  const assignments = updateColumns.map((column) => {
    const name = quoteMysqlIdentifier(column.columnName)
    return `${name}=?`
  }).join(', ')
  for (const row of sourceRows.filter((item) => targetEmails.has(String(item.email).toLowerCase()))) {
    const values = updateColumns.map((column) => mysqlValue(row[column.columnName], column.dataType))
    await connection.query(
      `UPDATE ${quoteMysqlIdentifier(mysqlTableName('users'))} SET ${assignments} WHERE ${quoteMysqlIdentifier('email')}=?`,
      [...values, row.email],
    )
  }
}

async function upsertIdentityMappings(
  connection: PoolConnection,
  sourceSystem: string,
  sourceRows: Record<string, unknown>[],
  targetRows: Record<string, unknown>[],
): Promise<void> {
  const targetByEmail = new Map(targetRows.map((row) => [String(row.email).toLowerCase(), row]))
  for (const sourceRow of sourceRows) {
    const targetRow = targetByEmail.get(String(sourceRow.email).toLowerCase())
    if (!targetRow) throw new Error(`cannot map ${sourceSystem} user without matching target email`)
    await connection.query(
      `INSERT INTO ${quoteMysqlIdentifier(mysqlTableName('iam_user_mappings'))}
        (${quoteMysqlIdentifier('id')}, ${quoteMysqlIdentifier('source_system')}, ${quoteMysqlIdentifier('source_user_id')}, ${quoteMysqlIdentifier('source_email')}, ${quoteMysqlIdentifier('target_user_id')})
       VALUES (?, ?, ?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE ${quoteMysqlIdentifier('source_email')}=new.${quoteMysqlIdentifier('source_email')}, ${quoteMysqlIdentifier('target_user_id')}=new.${quoteMysqlIdentifier('target_user_id')}`,
      [randomUUID(), sourceSystem, sourceRow.id, sourceRow.email, targetRow.id],
    )
  }
}

async function main(): Promise<void> {
  await ensureSchema()
  const source = new pg.Client({
    connectionString: sourceUrl,
    application_name: apply ? 'sbl_mysql_data_migration' : 'sbl_mysql_data_migration_preview',
    statement_timeout: 60_000,
    query_timeout: 65_000,
  })
  const target = await pool.getConnection()
  const reports: TableReport[] = []
  const runId = randomUUID()
  const sourceIdentitySha256 = createHash('sha256').update(sourceUrl).digest('hex')
  let sourceConnected = false
  let targetTransactionStarted = false

  try {
    await source.connect()
    sourceConnected = true
    await source.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    if (apply) {
      await target.beginTransaction()
      targetTransactionStarted = true
    }

    for (const table of TABLE_ORDER) {
      assertSafeName(table, 'table name')
      const availableSourceColumns = await sourceColumns(source, table)
      if (availableSourceColumns.size === 0) {
        throw new Error(`required source table public.${table} is missing`)
      }
      const availableTargetColumns = await targetColumns(target, table)
      const sourceBackedColumns = availableTargetColumns
        .filter((column) => availableSourceColumns.has(column.columnName))
      const columns = availableTargetColumns.filter((column) =>
        availableSourceColumns.has(column.columnName)
        || supportsLegacySyntheticColumn(table, column.columnName))
      const missingRequiredTargetColumns = availableTargetColumns
        .filter((column) =>
          !availableSourceColumns.has(column.columnName)
          && !supportsLegacySyntheticColumn(table, column.columnName)
          && !column.extra.toLowerCase().includes('default_generated'))
      if (missingRequiredTargetColumns.length > 0) {
        throw new Error(`source ${table} is missing target columns: ${missingRequiredTargetColumns.map((column) => column.columnName).join(', ')}`)
      }

      const sourceRows = (await selectSourceRows(source, table, sourceBackedColumns)).map((row) =>
        Object.fromEntries(columns.map((column) => [
          column.columnName,
          availableSourceColumns.has(column.columnName)
            ? row[column.columnName]
            : legacySyntheticColumnValue(table, column.columnName, row),
        ])))
      const beforeRows = await selectTargetRows(target, table, columns)
      const mergeExistingUsers = table === 'users' && beforeRows.length > 0
      const verificationColumns = mergeExistingUsers
        ? columns.filter((column) => column.columnName !== 'id')
        : columns
      const verificationKey = mergeExistingUsers ? 'email' : 'id'
      const sourceHash = rowsHashByKey(sourceRows, verificationColumns, verificationKey)
      const beforeHash = rowsHashByKey(beforeRows, verificationColumns, verificationKey)
      const preserveBackupData = sourceRows.length === 0 && beforeRows.length > 0

      if (apply && !preserveBackupData) {
        if (mergeExistingUsers) await mergeUsersByEmail(target, columns, sourceRows, beforeRows)
        else await upsertRows(target, table, columns, sourceRows)
      }
      const afterRows = apply ? await selectTargetRows(target, table, columns) : beforeRows
      if (apply && table === 'users') {
        await upsertIdentityMappings(target, 'legacy_postgres', sourceRows, afterRows)
      }
      const targetHash = rowsHashByKey(afterRows, verificationColumns, verificationKey)
      const exactMatch = afterRows.length === sourceRows.length && targetHash === sourceHash
      const preservedMatch = preserveBackupData
        && afterRows.length === beforeRows.length
        && targetHash === beforeHash
      const verified = exactMatch || preservedMatch

      reports.push({
        table,
        sourceRows: sourceRows.length,
        targetRowsBefore: beforeRows.length,
        targetRowsAfter: afterRows.length,
        readRows: sourceRows.length,
        writtenRows: apply && !preserveBackupData ? sourceRows.length : 0,
        skippedRows: apply ? 0 : sourceRows.length,
        failedRows: 0,
        sourceHash,
        targetHash,
        policy: preserveBackupData
          ? 'preserve-backup-data'
          : mergeExistingUsers
            ? 'online-user-profile-preserve-target-id'
            : 'online-source-authoritative',
        status: apply && verified ? (preservedMatch ? 'verified-preserved' : 'verified') : 'preview',
      })
      if (apply && !verified) {
        throw new Error(`verification failed for ${table}: source=${sourceRows.length} target=${afterRows.length}`)
      }
    }

    if (apply) {
      const sourceCounts = Object.fromEntries(reports.map((report) => [report.table, report.sourceRows]))
      const targetCounts = Object.fromEntries(reports.map((report) => [report.table, report.targetRowsAfter]))
      const sourceChecksum = createHash('sha256')
        .update(JSON.stringify(reports.map((report) => [report.table, report.sourceHash])))
        .digest('hex')
      const targetChecksum = createHash('sha256')
        .update(JSON.stringify(reports.map((report) => [report.table, report.targetHash])))
        .digest('hex')
      await target.query(`
        INSERT INTO ${quoteMysqlIdentifier(mysqlTableName('migration_runs'))}
          (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,
           source_checksum,target_checksum,report,started_at,completed_at)
        VALUES (?,?,?,?,?,'succeeded',?,?,?,?,?,NOW(3),NOW(3))
      `, [
        runId, 'postgres-online', 'DATABASE_URL', sourceIdentitySha256, 'apply',
        JSON.stringify(sourceCounts), JSON.stringify(targetCounts), sourceChecksum, targetChecksum,
        JSON.stringify({ schemaVersion: '1.0', tables: reports }),
      ])
      await target.commit()
      targetTransactionStarted = false
    }
    await source.query('ROLLBACK')
    console.log(JSON.stringify({
      ok: true,
      mode: apply ? 'apply' : 'preview',
      runId: apply ? runId : null,
      prefix: mysqlConfig.tablePrefix,
      tables: reports,
    }, null, 2))
  } catch (error) {
    if (targetTransactionStarted) await target.rollback().catch(() => undefined)
    if (sourceConnected) await source.query('ROLLBACK').catch(() => undefined)
    if (apply) {
      const failure = error as Error & { code?: string }
      await target.query(`
        INSERT INTO ${quoteMysqlIdentifier(mysqlTableName('migration_runs'))}
          (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,report,started_at,completed_at)
        VALUES (?,?,?,?,?,'failed',?,?,?,NOW(3),NOW(3))
      `, [
        runId, 'postgres-online', 'DATABASE_URL', sourceIdentitySha256, 'apply',
        JSON.stringify(Object.fromEntries(reports.map((report) => [report.table, report.sourceRows]))),
        JSON.stringify({}),
        JSON.stringify({ schemaVersion: '1.0', code: failure.code ?? 'MIGRATION_FAILED', completedTables: reports }),
      ]).catch(() => undefined)
    }
    throw error
  } finally {
    target.release()
    await source.end()
    await pool.end()
  }
}

await main().catch((error: unknown) => {
  const failure = error as Error & { code?: string }
  console.error(JSON.stringify({
    ok: false,
    code: failure.code ?? 'MIGRATION_FAILED',
    message: failure.message,
  }))
  process.exitCode = 1
})
