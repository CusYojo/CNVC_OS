import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'
import {
  legacySyntheticColumnValue,
  supportsLegacySyntheticColumn,
} from './migrationLegacyEvolution.js'
import { evaluateDumpTargetEvolution } from './postgresDumpReconciliationPolicy.js'
import { isMigrationJsonError, migrationJsonIssue, parseMigrationJson } from './migrationJsonSafety.js'

const LOAD_ORDER = [
  'users',
  'projects',
  'project_files',
  'meetings',
  'todos',
  'risks',
  'ai_summaries',
  'leads',
  'lead_reserve',
  'audit_logs',
  'chat_conversations',
  'file_chunks',
  'knowledge_chunks',
  'ai_tasks',
  'ai_artifacts',
  'ai_task_sources',
] as const

type TargetColumn = {
  columnName: string
  dataType: string
  extra: string
}

type DumpTable = {
  table: string
  columns: string[]
  rows: Record<string, unknown>[]
}

type DumpTableReport = {
  table: string
  sourceRows: number
  targetRowsBefore: number
  targetRowsAfter: number
  readRows: number
  writtenRows: number
  skippedRows: number
  failedRows: number
  sourceMissingInTarget: number
  targetOnlyRows: number
  changedSourceRows: number
  changedColumns: Record<string, number>
  sourceHash: string
  targetHash: string
  policy: 'preserve-online-source' | 'dump-authoritative' | 'approved-target-evolution'
  policyReason?: string
  status: 'preview' | 'verified' | 'verified-preserved'
}

const directApply = process.argv.includes('--apply')
const checkpointedApply = process.argv.includes('--checkpointed-apply')
if (directApply && checkpointedApply) throw new Error('--apply and --checkpointed-apply are mutually exclusive')
const apply = directApply || checkpointedApply
const reconcileExisting = process.argv.includes('--reconcile-existing')
if (apply && reconcileExisting) throw new Error('--apply and --reconcile-existing are mutually exclusive')
const dumpPath = path.resolve(process.env.PG_DUMP_PATH?.trim() || 'cybernaut_mvp_dump.sql')

type CheckpointReport = {
  schemaVersion?: string
  attempts?: number
  checkpoint?: {
    completedTables?: string[]
    tables?: DumpTableReport[]
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function assertSafeName(value: string, label: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error(`unsafe ${label}: ${value}`)
}

function decodeCopyValue(raw: string): string | null {
  if (raw === String.raw`\N`) return null
  let result = ''
  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index]
    if (current !== '\\') {
      result += current
      continue
    }
    const next = raw[index + 1]
    if (next == null) throw new Error('invalid trailing backslash in PostgreSQL COPY value')
    index += 1
    const escapes: Record<string, string> = {
      b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\',
    }
    if (next in escapes) {
      result += escapes[next]
      continue
    }
    if (next === 'x') {
      const hex = raw.slice(index + 1, index + 3).match(/^[0-9A-Fa-f]{1,2}/)?.[0]
      if (!hex) throw new Error('invalid hexadecimal PostgreSQL COPY escape')
      result += String.fromCharCode(Number.parseInt(hex, 16))
      index += hex.length
      continue
    }
    if (/[0-7]/.test(next)) {
      const octal = raw.slice(index, index + 3).match(/^[0-7]{1,3}/)?.[0] ?? next
      result += String.fromCharCode(Number.parseInt(octal, 8))
      index += octal.length - 1
      continue
    }
    result += next
  }
  return result
}

async function parseDump(): Promise<Map<string, DumpTable>> {
  const wanted = new Set<string>(LOAD_ORDER)
  const parsed = new Map<string, DumpTable>()
  let active: DumpTable | undefined
  let lineNumber = 0

  // readline also splits on bare carriage returns, but legacy text fields may contain
  // those bytes. PostgreSQL COPY records are LF-delimited, so split on LF only.
  const input = createReadStream(dumpPath, { encoding: 'utf8' })
  let buffered = ''
  for await (const chunk of input) {
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      const rawLine = buffered.slice(0, newline)
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      buffered = buffered.slice(newline + 1)
      lineNumber += 1
      processLine(line)
      newline = buffered.indexOf('\n')
    }
  }
  if (buffered) {
    lineNumber += 1
    processLine(buffered)
  }

  function processLine(line: string): void {
    if (!active) {
      const match = line.match(/^COPY public\.([A-Za-z0-9_]+) \(([^)]+)\) FROM stdin;$/)
      if (!match || !wanted.has(match[1])) return
      const table = match[1]
      const columns = match[2].split(', ').map((column) => {
        assertSafeName(column, 'dump column')
        return column
      })
      active = { table, columns, rows: [] }
      parsed.set(table, active)
      return
    }
    if (line === String.raw`\.`) {
      active = undefined
      return
    }
    const values = line.split('\t')
    if (values.length !== active.columns.length) {
      throw new Error(`COPY row for ${active.table} at line ${lineNumber} has ${values.length} values, expected ${active.columns.length}`)
    }
    active.rows.push(Object.fromEntries(active.columns.map((column, index) => [
      column,
      decodeCopyValue(values[index]),
    ])))
  }
  if (active) throw new Error('unterminated COPY block in PostgreSQL dump')
  for (const table of LOAD_ORDER) {
    if (!parsed.has(table)) throw new Error(`required COPY block public.${table} is missing from ${dumpPath}`)
  }
  return parsed
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function getTargetColumns(connection: PoolConnection, table: string): Promise<TargetColumn[]> {
  const [rows] = await connection.query<RowDataPacket[]>(`
    SELECT COLUMN_NAME AS columnName, DATA_TYPE AS dataType, EXTRA AS extra
    FROM information_schema.columns
    WHERE table_schema = ? AND table_name = ?
    ORDER BY ORDINAL_POSITION
  `, [mysqlConfig.database, mysqlTableName(table)])
  return rows.map((row) => ({
    columnName: String(row.columnName),
    dataType: String(row.dataType).toLowerCase(),
    extra: String(row.extra ?? '').toLowerCase(),
  })).filter((column) => !column.extra.includes('generated'))
}

function convertDumpValue(value: unknown, dataType: string, table: string, column: string, sourceKey?: string): unknown {
  if (value == null) return null
  const raw = String(value)
  if (dataType === 'json') {
    return parseMigrationJson(raw, { sourceSystem: 'postgres_dump', table, column, sourceKey })
  }
  if (['datetime', 'timestamp'].includes(dataType)) {
    const date = new Date(raw)
    if (Number.isNaN(date.valueOf())) throw new Error(`invalid timestamp in ${table}.${column}`)
    return date
  }
  if (['int', 'bigint', 'smallint', 'mediumint', 'tinyint'].includes(dataType)) {
    if (raw === 't') return 1
    if (raw === 'f') return 0
    const number = Number(raw)
    if (!Number.isFinite(number)) throw new Error(`invalid number in ${table}.${column}`)
    return number
  }
  return raw
}

function canonicalValue(value: unknown, dataType: string): unknown {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (dataType === 'json' && typeof value === 'string') {
    try { return canonicalValue(JSON.parse(value), dataType) } catch { return value }
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

function deterministicUuid(key: string): string {
  const bytes = Buffer.from(createHash('sha256').update(key).digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function sourceRowChecksum(row: Record<string, unknown>, columns: TargetColumn[]): string {
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(columns.map((column) => [
    column.columnName,
    canonicalValue(row[column.columnName], column.dataType),
  ])))).digest('hex')
}

async function upsertEntityMappings(
  connection: PoolConnection,
  runId: string,
  rowsByTable: Map<string, { rows: Record<string, unknown>[]; columns: TargetColumn[] }>,
): Promise<{ total: number; changed: number }> {
  const mappings = [...rowsByTable].flatMap(([sourceTable, value]) => value.rows.map((row) => {
    const sourceId = String(row.id ?? '')
    if (!sourceId) throw new Error(`source entity mapping requires an id: ${sourceTable}`)
    return {
      id: deterministicUuid(`postgres-dump-map:${sourceTable}:${sourceId}`),
      runId,
      sourceTable,
      sourceId,
      targetTable: sourceTable,
      targetId: sourceId,
      sourceChecksum: sourceRowChecksum(row, value.columns),
    }
  }))
  const [existingRows] = await connection.query<Array<RowDataPacket & {
    sourceTable: string
    sourceId: string
    runId: string | null
    targetTable: string
    targetId: string
    mappingKind: string
    sourceChecksum: string
  }>>(`
    SELECT source_table AS sourceTable,source_id AS sourceId,run_id AS runId,
      target_table AS targetTable,target_id AS targetId,mapping_kind AS mappingKind,
      source_checksum AS sourceChecksum
    FROM ${quoteMysqlIdentifier(mysqlTableName('migration_entity_mappings'))}
    WHERE source_system='postgres_dump'
  `)
  const existing = new Map(existingRows.map((row) => [`${row.sourceTable}\u0000${row.sourceId}`, row]))
  const changedMappings = mappings.filter((mapping) => {
    const current = existing.get(`${mapping.sourceTable}\u0000${mapping.sourceId}`)
    return !current
      || current.runId !== mapping.runId
      || current.targetTable !== mapping.targetTable
      || current.targetId !== mapping.targetId
      || current.mappingKind !== 'preserved'
      || current.sourceChecksum !== mapping.sourceChecksum
  })
  for (let offset = 0; offset < changedMappings.length; offset += 250) {
    const batch = changedMappings.slice(offset, offset + 250)
    const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?,NOW(3))').join(',')
    await connection.execute<import('mysql2').ResultSetHeader>(`
      INSERT INTO ${quoteMysqlIdentifier(mysqlTableName('migration_entity_mappings'))}
        (id,run_id,source_system,source_table,source_id,target_table,target_id,mapping_kind,source_checksum,created_at)
      VALUES ${placeholders}
      AS new ON DUPLICATE KEY UPDATE
        run_id=new.run_id,target_table=new.target_table,target_id=new.target_id,
        mapping_kind=new.mapping_kind,source_checksum=new.source_checksum
    `, batch.flatMap((mapping) => [
      mapping.id, mapping.runId, 'postgres_dump', mapping.sourceTable, mapping.sourceId,
      mapping.targetTable, mapping.targetId, 'preserved', mapping.sourceChecksum,
    ]))
  }
  return { total: mappings.length, changed: changedMappings.length }
}

function sortAndHash(rows: Record<string, unknown>[], columns: TargetColumn[]): string {
  const key = columns.some((column) => column.columnName === 'id') ? 'id' : columns[0].columnName
  const canonicalRows = rows.map((row) => Object.fromEntries(columns.map((column) => [
    column.columnName,
    canonicalValue(row[column.columnName], column.dataType),
  ]))).sort((left, right) => String(left[key]).localeCompare(String(right[key])))
  return createHash('sha256').update(JSON.stringify(canonicalRows)).digest('hex')
}

function mismatchSummary(
  sourceRows: Record<string, unknown>[],
  targetRows: Record<string, unknown>[],
  columns: TargetColumn[],
): Record<string, number> {
  const targetById = new Map(targetRows.map((row) => [String(row.id), row]))
  return Object.fromEntries(columns.map((column) => {
    let mismatches = 0
    for (const sourceRow of sourceRows) {
      const targetRow = targetById.get(String(sourceRow.id))
      const left = JSON.stringify(canonicalValue(sourceRow[column.columnName], column.dataType))
      const right = JSON.stringify(canonicalValue(targetRow?.[column.columnName], column.dataType))
      if (left !== right) mismatches += 1
    }
    return [column.columnName, mismatches]
  }).filter(([, count]) => Number(count) > 0))
}

function rowDifferenceSummary(
  sourceRows: Record<string, unknown>[],
  targetRows: Record<string, unknown>[],
  columns: TargetColumn[],
): { sourceMissingInTarget: number; targetOnlyRows: number; changedSourceRows: number; changedColumns: Record<string, number> } {
  const sourceById = new Map(sourceRows.map((row) => [String(row.id), row]))
  const targetById = new Map(targetRows.map((row) => [String(row.id), row]))
  let sourceMissingInTarget = 0
  let changedSourceRows = 0
  for (const [id, sourceRow] of sourceById) {
    const targetRow = targetById.get(id)
    if (!targetRow) {
      sourceMissingInTarget += 1
      continue
    }
    if (columns.some((column) =>
      JSON.stringify(canonicalValue(sourceRow[column.columnName], column.dataType))
        !== JSON.stringify(canonicalValue(targetRow[column.columnName], column.dataType)))) changedSourceRows += 1
  }
  return {
    sourceMissingInTarget,
    targetOnlyRows: [...targetById.keys()].filter((id) => !sourceById.has(id)).length,
    changedSourceRows,
    changedColumns: mismatchSummary(sourceRows, targetRows, columns),
  }
}

async function selectTargetRows(
  connection: PoolConnection,
  table: string,
  columns: TargetColumn[],
): Promise<Record<string, unknown>[]> {
  const projection = columns.map((column) => quoteMysqlIdentifier(column.columnName)).join(', ')
  const key = columns.some((column) => column.columnName === 'id') ? 'id' : columns[0].columnName
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT ${projection} FROM ${quoteMysqlIdentifier(mysqlTableName(table))} ORDER BY ${quoteMysqlIdentifier(key)}`,
  )
  return rows as Record<string, unknown>[]
}

async function upsertRows(
  connection: PoolConnection,
  table: string,
  columns: TargetColumn[],
  rows: Record<string, unknown>[],
  preserveExisting: boolean,
): Promise<void> {
  const batchSize = Math.max(1, Number(process.env.DB_MIGRATION_BATCH_SIZE ?? 100))
  if (!Number.isInteger(batchSize) || batchSize > 1_000) {
    throw new Error('DB_MIGRATION_BATCH_SIZE must be an integer between 1 and 1000')
  }
  const names = columns.map((column) => quoteMysqlIdentifier(column.columnName)).join(', ')
  const keyName = quoteMysqlIdentifier(columns.some((column) => column.columnName === 'id') ? 'id' : columns[0].columnName)
  const updates = preserveExisting
    ? `${keyName}=new.${keyName}`
    : columns.map((column) => {
      const name = quoteMysqlIdentifier(column.columnName)
      return `${name}=new.${name}`
    }).join(', ')

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize)
    const placeholders = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ')
    const values = batch.flatMap((row) => columns.map((column) => {
      const value = row[column.columnName]
      return column.dataType === 'json' && value != null ? JSON.stringify(value) : value
    }))
    await connection.query(
      `INSERT INTO ${quoteMysqlIdentifier(mysqlTableName(table))} (${names}) VALUES ${placeholders} AS new ON DUPLICATE KEY UPDATE ${updates}`,
      values,
    )
  }
}

async function upsertDumpUserMappings(
  connection: PoolConnection,
  sourceRows: Record<string, unknown>[],
  targetRows: Record<string, unknown>[],
): Promise<void> {
  const targetByEmail = new Map(targetRows.map((row) => [String(row.email).toLowerCase(), row]))
  for (const sourceRow of sourceRows) {
    const targetRow = targetByEmail.get(String(sourceRow.email).toLowerCase())
    if (!targetRow) throw new Error('cannot map postgres_dump user without matching target email')
    await connection.query(
      `INSERT INTO ${quoteMysqlIdentifier(mysqlTableName('iam_user_mappings'))}
        (${quoteMysqlIdentifier('id')}, ${quoteMysqlIdentifier('source_system')}, ${quoteMysqlIdentifier('source_user_id')}, ${quoteMysqlIdentifier('source_email')}, ${quoteMysqlIdentifier('target_user_id')})
       VALUES (?, 'postgres_dump', ?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE ${quoteMysqlIdentifier('source_email')}=new.${quoteMysqlIdentifier('source_email')}, ${quoteMysqlIdentifier('target_user_id')}=new.${quoteMysqlIdentifier('target_user_id')}`,
      [randomUUID(), sourceRow.id, sourceRow.email, targetRow.id],
    )
  }
}

async function main(): Promise<void> {
  await ensureSchema()
  const dump = await parseDump()
  const sourceSha256 = await sha256File(dumpPath)
  const connection = await pool.getConnection()
  const report: DumpTableReport[] = []
  const sourceRowsByTable = new Map<string, { rows: Record<string, unknown>[]; columns: TargetColumn[] }>()
  const runId = randomUUID()
  let effectiveRunId: string | null = null
  let ledgerWritten = false
  let transactionStarted = false
  let migrationLockHeld = false
  let migrationLockName: string | null = null
  let checkpointAttempts = 0
  let resumedFromCheckpoint = false
  const completedCheckpointTables = new Set<string>()
  async function writeDefaultEvidence(payload: Record<string, unknown>): Promise<void> {
    const evidenceRoot = path.resolve(process.env.MIGRATION_EVIDENCE_ROOT?.trim() || '.runtime/migration-evidence')
    const directory = path.resolve(evidenceRoot, 'postgres-dump')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const target = path.resolve(directory, `${sourceSha256}.json`)
    const temporary = `${target}.${process.pid}-${Date.now()}`
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, target)
  }
  try {
    if (checkpointedApply) {
      const lockName = `sbl:pgdump:${sourceSha256.slice(0, 48)}`
      migrationLockName = lockName
      const [lockRows] = await connection.query<Array<RowDataPacket & { acquired: number }>>(
        'SELECT GET_LOCK(?, 0) AS acquired',
        [lockName],
      )
      if (Number(lockRows[0]?.acquired ?? 0) !== 1) {
        const error = new Error('another checkpointed migration for this source is already running') as Error & { code?: string }
        error.code = 'MIGRATION_LOCKED'
        throw error
      }
      migrationLockHeld = true
      const [checkpointRows] = await connection.query<Array<RowDataPacket & { id: string; report: unknown }>>(`
        SELECT id,report FROM ${quoteMysqlIdentifier(mysqlTableName('migration_runs'))}
        WHERE migration_type='postgres-dump-checkpointed' AND source_sha256=? AND mode='checkpointed'
          AND status IN ('running','failed')
        ORDER BY started_at DESC LIMIT 1
      `, [sourceSha256])
      const existingCheckpoint = checkpointRows[0]
      if (existingCheckpoint) {
        effectiveRunId = String(existingCheckpoint.id)
        const previous = parseJsonObject(existingCheckpoint.report) as CheckpointReport
        checkpointAttempts = Math.max(0, Number(previous.attempts ?? 0)) + 1
        for (const table of previous.checkpoint?.completedTables ?? []) {
          if (LOAD_ORDER.includes(table as typeof LOAD_ORDER[number])) completedCheckpointTables.add(table)
        }
        resumedFromCheckpoint = completedCheckpointTables.size > 0
        await connection.query(`
          UPDATE ${quoteMysqlIdentifier(mysqlTableName('migration_runs'))}
          SET status='running',completed_at=NULL,report=? WHERE id=?
        `, [JSON.stringify({
          ...previous,
          schemaVersion: '1.2',
          attempts: checkpointAttempts,
          resumedAt: new Date().toISOString(),
        }), effectiveRunId])
      } else {
        effectiveRunId = runId
        ledgerWritten = true
        checkpointAttempts = 1
        await connection.query(`
          INSERT INTO ${quoteMysqlIdentifier(mysqlTableName('migration_runs'))}
            (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,report,started_at)
          VALUES (?,'postgres-dump-checkpointed',?,?,'checkpointed','running',?,?,?,NOW(3))
        `, [
          effectiveRunId,
          path.basename(dumpPath),
          sourceSha256,
          JSON.stringify({}),
          JSON.stringify({}),
          JSON.stringify({
            schemaVersion: '1.2',
            attempts: checkpointAttempts,
            checkpoint: { completedTables: [], tables: [] },
          }),
        ])
      }
    } else if (apply || reconcileExisting) {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      await connection.beginTransaction()
      transactionStarted = true
    }
    const [evidenceRows] = await connection.query<Array<RowDataPacket & { migrationType: string }>>(`
      SELECT DISTINCT migration_type AS migrationType FROM ${quoteMysqlIdentifier(mysqlTableName('migration_runs'))}
      WHERE migration_type IN (
        'postgres-dump-orphan-conversation-normalization',
        'legacy-conversation-scope-normalization',
        'missing-file-asset-quarantine',
        'legacy-scoring-classification'
      )
        AND status='succeeded'
    `)
    const successfulEvidenceTypes = new Set(evidenceRows.map((row) => row.migrationType))
    const sourceOrphanNormalizationReady = successfulEvidenceTypes.has('postgres-dump-orphan-conversation-normalization')
    const legacyConversationScopeNormalizationReady = successfulEvidenceTypes.has('legacy-conversation-scope-normalization')
    const missingFileAssetQuarantineReady = successfulEvidenceTypes.has('missing-file-asset-quarantine')
    const legacyScoringReady = successfulEvidenceTypes.has('legacy-scoring-classification')
    for (const table of LOAD_ORDER) {
      const checkpointAlreadyCompleted = checkpointedApply && completedCheckpointTables.has(table)
      if (checkpointedApply && !checkpointAlreadyCompleted) {
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        await connection.beginTransaction()
        transactionStarted = true
      }
      const block = dump.get(table)!
      const sourceColumnNames = new Set(block.columns)
      const allTargetColumns = await getTargetColumns(connection, table)
      const columns = allTargetColumns.filter((column) =>
        sourceColumnNames.has(column.columnName)
        || supportsLegacySyntheticColumn(table, column.columnName))
      const sourceRows = block.rows.map((row, rowIndex) => Object.fromEntries(columns.map((column) => [
        column.columnName,
        convertDumpValue(
          sourceColumnNames.has(column.columnName)
            ? row[column.columnName]
            : legacySyntheticColumnValue(table, column.columnName, row),
          column.dataType,
          table,
          column.columnName,
          String(row.id ?? rowIndex),
        ),
      ])))
      sourceRowsByTable.set(table, { rows: sourceRows, columns })
      const beforeRows = await selectTargetRows(connection, table, columns)
      const preserveExisting = table === 'users'
      const writeCurrentTable = apply && !checkpointAlreadyCompleted
      if (writeCurrentTable) await upsertRows(connection, table, columns, sourceRows, preserveExisting)
      const afterRows = writeCurrentTable ? await selectTargetRows(connection, table, columns) : beforeRows
      if (writeCurrentTable && table === 'users') {
        await upsertDumpUserMappings(connection, sourceRows, afterRows)
      }
      const sourceHash = sortAndHash(sourceRows, columns)
      const targetHash = sortAndHash(afterRows, columns)
      const exactMatch = sourceRows.length === afterRows.length && sourceHash === targetHash
      const sourceIds = new Set(sourceRows.map((row) => String(row.id)))
      const targetIds = new Set(afterRows.map((row) => String(row.id)))
      const preservedMatch = preserveExisting
        && sourceRows.length === afterRows.length
        && [...sourceIds].every((id) => targetIds.has(id))
      const sourceIdsBefore = new Set(beforeRows.map((row) => String(row.id)))
      const writtenRows = writeCurrentTable
        ? preserveExisting
          ? sourceRows.filter((row) => !sourceIdsBefore.has(String(row.id))).length
          : sourceRows.length
        : 0
      const differences = rowDifferenceSummary(sourceRows, afterRows, columns)
      const evolution = evaluateDumpTargetEvolution(table, {
        ...differences,
        changedColumns: Object.keys(differences.changedColumns),
      }, {
        sourceOrphanNormalizationReady,
        legacyConversationScopeNormalizationReady,
        missingFileAssetQuarantineReady,
        legacyScoringReady,
      })
      const verified = reconcileExisting ? evolution.approved : exactMatch || preservedMatch
      report.push({
        table,
        sourceRows: sourceRows.length,
        targetRowsBefore: beforeRows.length,
        targetRowsAfter: afterRows.length,
        readRows: sourceRows.length,
        writtenRows,
        skippedRows: writeCurrentTable ? sourceRows.length - writtenRows : sourceRows.length,
        failedRows: 0,
        ...differences,
        sourceHash,
        targetHash,
        policy: reconcileExisting
          ? 'approved-target-evolution'
          : preserveExisting ? 'preserve-online-source' : 'dump-authoritative',
        policyReason: reconcileExisting ? evolution.reason : undefined,
        status: (apply || reconcileExisting) && verified
          ? (exactMatch ? 'verified' : 'verified-preserved') : 'preview',
      })
      if ((apply || reconcileExisting) && !verified) {
        throw new Error(`dump verification failed for ${table}: ${JSON.stringify({
          sourceRows: sourceRows.length,
          targetRows: afterRows.length,
          sourceMissingInTarget: differences.sourceMissingInTarget,
          targetOnlyRows: differences.targetOnlyRows,
          changedColumns: differences.changedColumns,
          policyReason: evolution.reason,
        })}`)
      }
      if (checkpointedApply && !checkpointAlreadyCompleted) {
        const injectedTable = process.env.MIGRATION_TEST_FAIL_AT_TABLE?.trim()
        if (injectedTable === table) {
          if (!mysqlConfig.database.startsWith('sbl_migration_contract_')) {
            throw new Error('MIGRATION_TEST_FAIL_AT_TABLE is restricted to isolated acceptance databases')
          }
          const error = new Error(`injected migration interruption at ${table}`) as Error & { code?: string }
          error.code = 'MIGRATION_TEST_INTERRUPT'
          throw error
        }
        completedCheckpointTables.add(table)
        await connection.query(`
          UPDATE ${quoteMysqlIdentifier(mysqlTableName('migration_runs'))}
          SET source_counts=?,target_counts=?,report=? WHERE id=?
        `, [
          JSON.stringify(Object.fromEntries(report.map((item) => [item.table, item.sourceRows]))),
          JSON.stringify(Object.fromEntries(report.map((item) => [item.table, item.targetRowsAfter]))),
          JSON.stringify({
            schemaVersion: '1.2',
            attempts: checkpointAttempts,
            checkpoint: {
              completedTables: [...completedCheckpointTables],
              tables: report,
            },
          }),
          effectiveRunId,
        ])
        await connection.commit()
        transactionStarted = false
      }
    }
    if (apply || reconcileExisting) {
      if (checkpointedApply) {
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        await connection.beginTransaction()
        transactionStarted = true
      }
      const sourceCounts = Object.fromEntries(report.map((item) => [item.table, item.sourceRows]))
      const targetCounts = Object.fromEntries(report.map((item) => [item.table, item.targetRowsAfter]))
      const sourceChecksum = createHash('sha256')
        .update(JSON.stringify(report.map((item) => [item.table, item.sourceHash]))).digest('hex')
      const targetChecksum = createHash('sha256')
        .update(JSON.stringify(report.map((item) => [item.table, item.targetHash]))).digest('hex')
      const migrationType = reconcileExisting
        ? 'postgres-dump-baseline-reconciliation'
        : checkpointedApply ? 'postgres-dump-checkpointed' : 'postgres-dump'
      const mode = reconcileExisting ? 'reconcile' : checkpointedApply ? 'checkpointed' : 'apply'
      if (reconcileExisting) {
        const [existingRows] = await connection.query<Array<RowDataPacket & { id: string }>>(`
          SELECT id FROM ${quoteMysqlIdentifier(mysqlTableName('migration_runs'))}
          WHERE migration_type=? AND source_sha256=? AND mode=? AND status='succeeded'
            AND source_checksum=? AND target_checksum=?
          ORDER BY completed_at DESC LIMIT 1
        `, [migrationType, sourceSha256, mode, sourceChecksum, targetChecksum])
        effectiveRunId = existingRows[0]?.id == null ? null : String(existingRows[0].id)
      }
      if (!effectiveRunId) {
        await connection.query(`
          INSERT INTO ${quoteMysqlIdentifier(mysqlTableName('migration_runs'))}
            (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,
             source_checksum,target_checksum,report,started_at,completed_at)
          VALUES (?,?,?,?,?,'succeeded',?,?,?,?,?,NOW(3),NOW(3))
        `, [
          runId, migrationType, path.basename(dumpPath), sourceSha256, mode,
          JSON.stringify(sourceCounts), JSON.stringify(targetCounts), sourceChecksum, targetChecksum,
          JSON.stringify({ schemaVersion: '1.1', verificationMode: mode, tables: report }),
        ])
        effectiveRunId = runId
        ledgerWritten = true
      }
      const mappingResult = await upsertEntityMappings(connection, effectiveRunId, sourceRowsByTable)
      const mappingRows = mappingResult.total
      const mappingRowsChanged = mappingResult.changed
      if (checkpointedApply) {
        await connection.query(`
          UPDATE ${quoteMysqlIdentifier(mysqlTableName('migration_runs'))}
          SET status='succeeded',source_counts=?,target_counts=?,source_checksum=?,target_checksum=?,
            report=?,completed_at=NOW(3) WHERE id=?
        `, [
          JSON.stringify(sourceCounts),
          JSON.stringify(targetCounts),
          sourceChecksum,
          targetChecksum,
          JSON.stringify({
            schemaVersion: '1.2',
            attempts: checkpointAttempts,
            resumedFromCheckpoint,
            checkpoint: { completedTables: [...completedCheckpointTables], tables: report },
            verificationMode: mode,
            tables: report,
          }),
          effectiveRunId,
        ])
      }
      await connection.commit()
      transactionStarted = false
      const output = {
        schemaVersion: checkpointedApply ? '1.2' : '1.1', generatedAt: new Date().toISOString(),
        ok: true, mode: reconcileExisting ? 'reconcile-existing' : checkpointedApply ? 'checkpointed-apply' : apply ? 'apply' : 'preview',
        dumpPath, sourceSha256, runId: effectiveRunId,
        ledgerWritten, mappingRows, mappingRowsChanged,
        ...(checkpointedApply ? {
          checkpointed: true,
          attempts: checkpointAttempts,
          resumedFromCheckpoint,
          completedCheckpointTables: completedCheckpointTables.size,
        } : {}),
        idempotent: reconcileExisting && !ledgerWritten && mappingRowsChanged === 0,
        tables: report,
      }
      await writeDefaultEvidence(output)
      console.log(JSON.stringify(output, null, 2))
      return
    }
    const output = {
      schemaVersion: '1.0', generatedAt: new Date().toISOString(),
      ok: true, mode: reconcileExisting ? 'reconcile-existing' : apply ? 'apply' : 'preview',
      dumpPath, sourceSha256, runId: effectiveRunId,
      ledgerWritten, idempotent: reconcileExisting && !ledgerWritten, tables: report,
    }
    await writeDefaultEvidence(output)
    console.log(JSON.stringify(output, null, 2))
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback().catch(() => undefined)
      transactionStarted = false
    }
    if (apply || reconcileExisting) {
      const failure = error as Error & { code?: string }
      const migrationType = reconcileExisting
        ? 'postgres-dump-baseline-reconciliation'
        : checkpointedApply ? 'postgres-dump-checkpointed' : 'postgres-dump'
      const mode = reconcileExisting ? 'reconcile' : checkpointedApply ? 'checkpointed' : 'apply'
      const failureRunId = checkpointedApply ? effectiveRunId : runId
      try {
        if (failureRunId) {
          await connection.beginTransaction()
          const persistedReports = checkpointedApply
            ? report.filter((item) => completedCheckpointTables.has(item.table))
            : report
          if (checkpointedApply) {
            await connection.query(`
              UPDATE ${quoteMysqlIdentifier(mysqlTableName('migration_runs'))}
              SET status='failed',source_counts=?,target_counts=?,report=?,completed_at=NOW(3) WHERE id=?
            `, [
              JSON.stringify(Object.fromEntries(persistedReports.map((item) => [item.table, item.sourceRows]))),
              JSON.stringify(Object.fromEntries(persistedReports.map((item) => [item.table, item.targetRowsAfter]))),
              JSON.stringify({
                schemaVersion: '1.2',
                attempts: checkpointAttempts,
                code: failure.code ?? 'MIGRATION_FAILED',
                checkpoint: { completedTables: [...completedCheckpointTables], tables: persistedReports },
              }),
              failureRunId,
            ])
          } else {
            await connection.query(`
              INSERT INTO ${quoteMysqlIdentifier(mysqlTableName('migration_runs'))}
                (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,report,started_at,completed_at)
              VALUES (?,?,?,?,?,'failed',?,?,?,NOW(3),NOW(3))
            `, [
              failureRunId, migrationType, path.basename(dumpPath), sourceSha256, mode,
              JSON.stringify(Object.fromEntries(report.map((item) => [item.table, item.sourceRows]))),
              JSON.stringify({}),
              JSON.stringify({ schemaVersion: '1.0', code: failure.code ?? 'MIGRATION_FAILED', completedTables: report }),
            ])
          }
          if (isMigrationJsonError(error)) {
            const issue = migrationJsonIssue(error)
            await connection.query(`
              INSERT INTO ${quoteMysqlIdentifier(mysqlTableName('migration_issues'))}
                (id,run_id,severity,source_system,source_table,source_key,code,message,payload,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,NOW(3))
            `, [randomUUID(), failureRunId, issue.severity, error.context.sourceSystem, issue.sourceTable,
              issue.sourceKey ?? null, issue.code, issue.message, JSON.stringify(issue.payload)])
          } else {
            await connection.query(`
              INSERT INTO ${quoteMysqlIdentifier(mysqlTableName('migration_issues'))}
                (id,run_id,severity,source_system,source_table,source_key,code,message,payload,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,NOW(3))
            `, [
              randomUUID(), failureRunId, 'error', 'postgres_dump', null, null,
              failure.code ?? 'MIGRATION_FAILED',
              'migration execution failed; inspect protected operator logs',
              JSON.stringify({ completedCheckpointTables: completedCheckpointTables.size }),
            ])
          }
          await connection.commit()
        }
      } catch {
        await connection.rollback().catch(() => undefined)
      }
    }
    await writeDefaultEvidence({
      schemaVersion: checkpointedApply ? '1.2' : '1.0', generatedAt: new Date().toISOString(), ok: false,
      mode: reconcileExisting ? 'reconcile-existing' : checkpointedApply ? 'checkpointed-apply' : apply ? 'apply' : 'preview',
      dumpPath, sourceSha256, runId: checkpointedApply ? effectiveRunId : runId,
      ...(checkpointedApply ? {
        checkpointed: true,
        attempts: checkpointAttempts,
        resumedFromCheckpoint,
        completedCheckpointTables: completedCheckpointTables.size,
      } : {}),
      code: (error as Error & { code?: string }).code ?? 'MIGRATION_FAILED', completedTables: report,
    }).catch(() => undefined)
    throw error
  } finally {
    if (migrationLockHeld && migrationLockName) {
      await connection.query('SELECT RELEASE_LOCK(?)', [migrationLockName]).catch(() => undefined)
    }
    connection.release()
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
