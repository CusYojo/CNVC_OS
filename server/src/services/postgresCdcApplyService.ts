import { createHash, randomUUID } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  legacySyntheticColumnValue,
  supportsLegacySyntheticColumn,
} from '../scripts/migrationLegacyEvolution.js'
import type { PostgresCdcEvent, PostgresCdcTable } from '../scripts/postgresCdcContract.js'
import { POSTGRES_CDC_CAPTURE_VERSION, POSTGRES_CDC_TABLES } from '../scripts/postgresCdcContract.js'

type TargetColumn = {
  columnName: string
  dataType: string
  extra: string
}

type CheckpointRow = RowDataPacket & {
  id: string
  lastSequence: string
  lastTxid: string
  appliedEvents: string
  replayedEvents: string
  insertedEvents: string
  updatedEvents: string
  deletedEvents: string
  cascadeDeletedEvents: string
}

export type PostgresCdcApplyInput = {
  sourceInstance: string
  sourceFingerprint: string
  contractSha256: string
  safeWatermark: string
  observedWatermark: string
  safeXmin: string
  sourcePendingEvents?: number
  events: PostgresCdcEvent[]
  failAfterComponents?: number
}

export type PostgresCdcApplyResult = {
  checkpointId: string
  inputEvents: number
  appliedEvents: number
  replayedEvents: number
  insertedEvents: number
  updatedEvents: number
  deletedEvents: number
  cascadeDeletedEvents: number
  transactionComponents: number
  lastSequence: string
  safeWatermark: string
  observedWatermark: string
  pendingSafeEvents: number
  caughtUp: boolean
  replicationLagMs: number
}

function deterministicUuid(key: string): string {
  const bytes = Buffer.from(createHash('sha256').update(key).digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function asBigInt(value: string | number | bigint | null | undefined): bigint {
  const normalized = String(value ?? '0')
  if (!/^\d+$/.test(normalized)) throw new Error(`invalid unsigned CDC position: ${normalized}`)
  return BigInt(normalized)
}

function eventChecksum(event: PostgresCdcEvent): string {
  return createHash('sha256').update(JSON.stringify({
    sequence: event.sequence,
    txid: event.txid,
    table: event.table,
    operation: event.operation,
    entityId: event.entityId,
    rowData: event.rowData,
    tombstone: event.tombstone,
    occurredAt: event.occurredAt,
    actor: event.actor,
    migrationBatch: event.migrationBatch,
    cascadeDelete: event.cascadeDelete,
  })).digest('hex')
}

function eventComponents(events: PostgresCdcEvent[]): PostgresCdcEvent[][] {
  const byTxid = new Map<string, PostgresCdcEvent[]>()
  for (const event of events) {
    const items = byTxid.get(event.txid) ?? []
    items.push(event)
    byTxid.set(event.txid, items)
  }
  const transactions = [...byTxid.values()].map((items) => {
    const sorted = [...items].sort((left, right) => asBigInt(left.sequence) < asBigInt(right.sequence) ? -1 : 1)
    return { items: sorted, min: asBigInt(sorted[0].sequence), max: asBigInt(sorted.at(-1)!.sequence) }
  }).sort((left, right) => left.min < right.min ? -1 : left.min > right.min ? 1 : 0)
  const result: PostgresCdcEvent[][] = []
  let current: PostgresCdcEvent[] = []
  let currentMax = -1n
  for (const transaction of transactions) {
    if (current.length && transaction.min > currentMax) {
      result.push(current.sort((left, right) => asBigInt(left.sequence) < asBigInt(right.sequence) ? -1 : 1))
      current = []
      currentMax = -1n
    }
    current.push(...transaction.items)
    if (transaction.max > currentMax) currentMax = transaction.max
  }
  if (current.length) result.push(current.sort((left, right) => asBigInt(left.sequence) < asBigInt(right.sequence) ? -1 : 1))
  return result
}

async function targetColumns(connection: PoolConnection, table: PostgresCdcTable): Promise<TargetColumn[]> {
  const [rows] = await connection.query<RowDataPacket[]>(`
    SELECT COLUMN_NAME AS columnName,DATA_TYPE AS dataType,EXTRA AS extra
    FROM information_schema.columns
    WHERE table_schema=? AND table_name=?
    ORDER BY ORDINAL_POSITION
  `, [mysqlConfig.database, mysqlTableName(table)])
  return rows.map((row) => ({
    columnName: String(row.columnName),
    dataType: String(row.dataType).toLowerCase(),
    extra: String(row.extra ?? '').toLowerCase(),
  })).filter((column) => !column.extra.includes('generated'))
}

function mysqlValue(value: unknown, dataType: string, table: string, column: string): unknown {
  if (value == null) return null
  if (dataType === 'json') {
    if (typeof value === 'string') {
      try { return JSON.stringify(JSON.parse(value)) } catch { throw new Error(`invalid CDC JSON in ${table}.${column}`) }
    }
    return JSON.stringify(value)
  }
  if (['datetime', 'timestamp'].includes(dataType)) {
    const date = value instanceof Date ? value : new Date(String(value))
    if (Number.isNaN(date.valueOf())) throw new Error(`invalid CDC timestamp in ${table}.${column}`)
    return date
  }
  if (['int', 'bigint', 'smallint', 'mediumint', 'tinyint'].includes(dataType)) {
    if (typeof value === 'boolean') return value ? 1 : 0
    const number = Number(value)
    if (!Number.isFinite(number)) throw new Error(`invalid CDC number in ${table}.${column}`)
    return number
  }
  return value
}

async function resolveTargetId(
  connection: PoolConnection,
  event: PostgresCdcEvent,
  sourceRow: Record<string, unknown> | null,
): Promise<string> {
  if (event.table !== 'users') return event.entityId
  const [mappingRows] = await connection.query<Array<RowDataPacket & { targetId: string }>>(`
    SELECT target_user_id AS targetId
    FROM ${quoteMysqlIdentifier(mysqlTableName('iam_user_mappings'))}
    WHERE source_system='legacy_postgres' AND source_user_id=? LIMIT 1
  `, [event.entityId])
  if (mappingRows[0]?.targetId) return String(mappingRows[0].targetId)
  const email = String(sourceRow?.email ?? '').trim().toLowerCase()
  if (email) {
    const [users] = await connection.query<Array<RowDataPacket & { id: string }>>(`
      SELECT id FROM ${quoteMysqlIdentifier(mysqlTableName('users'))} WHERE LOWER(email)=? LIMIT 1
    `, [email])
    if (users[0]?.id) return String(users[0].id)
  }
  return event.entityId
}

async function upsertUserMapping(
  connection: PoolConnection,
  event: PostgresCdcEvent,
  sourceRow: Record<string, unknown>,
  targetId: string,
): Promise<void> {
  await connection.query(`
    INSERT INTO ${quoteMysqlIdentifier(mysqlTableName('iam_user_mappings'))}
      (id,source_system,source_user_id,source_email,target_user_id)
    VALUES (?,'legacy_postgres',?,?,?) AS new
    ON DUPLICATE KEY UPDATE source_email=new.source_email,target_user_id=new.target_user_id
  `, [randomUUID(), event.entityId, String(sourceRow.email ?? ''), targetId])
}

async function applyBusinessEvent(
  connection: PoolConnection,
  event: PostgresCdcEvent,
): Promise<'applied' | 'noop'> {
  const sourceRow = event.operation === 'D' ? event.tombstone : event.rowData
  if (!sourceRow || typeof sourceRow !== 'object') throw new Error(`CDC ${event.operation} event has no row payload`)
  const targetId = await resolveTargetId(connection, event, sourceRow)
  if (event.operation === 'D') {
    const [result] = await connection.execute<import('mysql2').ResultSetHeader>(
      `DELETE FROM ${quoteMysqlIdentifier(mysqlTableName(event.table))} WHERE id=?`,
      [targetId],
    )
    return result.affectedRows > 0 ? 'applied' : 'noop'
  }
  const allColumns = await targetColumns(connection, event.table)
  const sourceColumns = new Set(Object.keys(sourceRow))
  const columns = allColumns.filter((column) =>
    sourceColumns.has(column.columnName)
    || supportsLegacySyntheticColumn(event.table, column.columnName))
  if (!columns.some((column) => column.columnName === 'id')) throw new Error(`CDC row for ${event.table} has no target id`)
  const normalizedRow = Object.fromEntries(columns.map((column) => {
    const raw = column.columnName === 'id'
      ? targetId
      : sourceColumns.has(column.columnName)
        ? sourceRow[column.columnName]
        : legacySyntheticColumnValue(event.table, column.columnName, sourceRow)
    return [column.columnName, mysqlValue(raw, column.dataType, event.table, column.columnName)]
  }))
  const names = columns.map((column) => quoteMysqlIdentifier(column.columnName)).join(',')
  const updates = columns.filter((column) => column.columnName !== 'id').map((column) => {
    const name = quoteMysqlIdentifier(column.columnName)
    return `${name}=new.${name}`
  }).join(',') || `${quoteMysqlIdentifier('id')}=new.${quoteMysqlIdentifier('id')}`
  await connection.query(
    `INSERT INTO ${quoteMysqlIdentifier(mysqlTableName(event.table))} (${names})
     VALUES (${columns.map(() => '?').join(',')}) AS new ON DUPLICATE KEY UPDATE ${updates}`,
    columns.map((column) => normalizedRow[column.columnName]),
  )
  if (event.table === 'users') await upsertUserMapping(connection, event, sourceRow, targetId)
  return 'applied'
}

async function ensureCheckpoint(connection: PoolConnection, input: PostgresCdcApplyInput): Promise<string> {
  const checkpointId = deterministicUuid(`postgres-cdc:${input.sourceInstance}`)
  await connection.query(`
    INSERT INTO ${quoteMysqlIdentifier(mysqlTableName('migration_cdc_checkpoints'))}
      (id,source_system,source_instance,source_fingerprint,capture_version,status,report)
    VALUES (?,'legacy_postgres',?,?,?,'idle',?) AS new
    ON DUPLICATE KEY UPDATE id=new.id
  `, [
    checkpointId,
    input.sourceInstance,
    input.sourceFingerprint,
    POSTGRES_CDC_CAPTURE_VERSION,
    JSON.stringify({ contractSha256: input.contractSha256 }),
  ])
  const [rows] = await connection.query<Array<RowDataPacket & { id: string; sourceFingerprint: string | null; captureVersion: string | null }>>(`
    SELECT id,source_fingerprint AS sourceFingerprint,capture_version AS captureVersion
    FROM ${quoteMysqlIdentifier(mysqlTableName('migration_cdc_checkpoints'))}
    WHERE source_system='legacy_postgres' AND source_instance=? LIMIT 1
  `, [input.sourceInstance])
  if (!rows[0] || rows[0].sourceFingerprint !== input.sourceFingerprint || rows[0].captureVersion !== POSTGRES_CDC_CAPTURE_VERSION) {
    throw new Error('CDC source instance fingerprint or capture version changed')
  }
  return String(rows[0].id)
}

async function lockedCheckpoint(connection: PoolConnection, checkpointId: string): Promise<CheckpointRow> {
  const [rows] = await connection.query<CheckpointRow[]>(`
    SELECT id,CAST(last_sequence AS CHAR) AS lastSequence,CAST(last_txid AS CHAR) AS lastTxid,
      CAST(applied_events AS CHAR) AS appliedEvents,CAST(replayed_events AS CHAR) AS replayedEvents,
      CAST(inserted_events AS CHAR) AS insertedEvents,CAST(updated_events AS CHAR) AS updatedEvents,
      CAST(deleted_events AS CHAR) AS deletedEvents,CAST(cascade_deleted_events AS CHAR) AS cascadeDeletedEvents
    FROM ${quoteMysqlIdentifier(mysqlTableName('migration_cdc_checkpoints'))}
    WHERE id=? FOR UPDATE
  `, [checkpointId])
  if (!rows[0]) throw new Error('CDC checkpoint disappeared')
  return rows[0]
}

export async function applyPostgresCdcEvents(
  connection: PoolConnection,
  input: PostgresCdcApplyInput,
): Promise<PostgresCdcApplyResult> {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.sourceInstance)) throw new Error('invalid CDC source instance')
  for (const value of [input.safeWatermark, input.observedWatermark, input.safeXmin]) asBigInt(value)
  if (asBigInt(input.safeWatermark) > asBigInt(input.observedWatermark)) {
    throw new Error('CDC safe watermark cannot exceed observed watermark')
  }
  for (const event of input.events) {
    if (!POSTGRES_CDC_TABLES.includes(event.table)) throw new Error(`CDC event table is not allowlisted: ${event.table}`)
    if (asBigInt(event.sequence) > asBigInt(input.safeWatermark)) throw new Error('CDC event exceeds safe watermark')
  }
  const checkpointId = await ensureCheckpoint(connection, input)
  const components = eventComponents(input.events)
  let appliedThisRun = 0
  let replayedThisRun = 0
  let insertedThisRun = 0
  let updatedThisRun = 0
  let deletedThisRun = 0
  let cascadeDeletedThisRun = 0
  let completedComponents = 0
  let lastReplicationLagMs = 0

  for (const component of components) {
    await connection.beginTransaction()
    try {
      let appliedInComponent = 0
      let replayedInComponent = 0
      let insertedInComponent = 0
      let updatedInComponent = 0
      let deletedInComponent = 0
      let cascadeDeletedInComponent = 0
      const checkpoint = await lockedCheckpoint(connection, checkpointId)
      let lastSequence = asBigInt(checkpoint.lastSequence)
      let lastTxid = asBigInt(checkpoint.lastTxid)
      for (const event of component) {
        const sequence = asBigInt(event.sequence)
        const checksum = eventChecksum(event)
        const [existingRows] = await connection.query<Array<RowDataPacket & { eventChecksum: string }>>(`
          SELECT event_checksum AS eventChecksum
          FROM ${quoteMysqlIdentifier(mysqlTableName('migration_cdc_events'))}
          WHERE checkpoint_id=? AND source_sequence=? LIMIT 1
        `, [checkpointId, event.sequence])
        if (existingRows[0]) {
          if (existingRows[0].eventChecksum !== checksum) throw new Error(`CDC replay checksum conflict at sequence ${event.sequence}`)
          replayedThisRun += 1
          replayedInComponent += 1
          if (sequence > lastSequence) lastSequence = sequence
          continue
        }
        if (sequence <= lastSequence) throw new Error(`CDC checkpoint gap at sequence ${event.sequence}`)
        const outcome = await applyBusinessEvent(connection, event)
        await connection.query(`
          INSERT INTO ${quoteMysqlIdentifier(mysqlTableName('migration_cdc_events'))}
            (id,checkpoint_id,source_sequence,source_txid,source_table,source_entity_id,operation,
             event_checksum,outcome,tombstone,cascade_delete,source_occurred_at,applied_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(3))
        `, [
          deterministicUuid(`postgres-cdc-event:${input.sourceInstance}:${event.sequence}`),
          checkpointId,
          event.sequence,
          event.txid,
          event.table,
          event.entityId,
          event.operation,
          checksum,
          outcome,
          event.operation === 'D' ? 1 : 0,
          event.cascadeDelete ? 1 : 0,
          new Date(event.occurredAt),
        ])
        appliedThisRun += 1
        appliedInComponent += 1
        if (event.operation === 'I') { insertedThisRun += 1; insertedInComponent += 1 }
        if (event.operation === 'U') { updatedThisRun += 1; updatedInComponent += 1 }
        if (event.operation === 'D') { deletedThisRun += 1; deletedInComponent += 1 }
        if (event.operation === 'D' && event.cascadeDelete) {
          cascadeDeletedThisRun += 1
          cascadeDeletedInComponent += 1
        }
        if (sequence > lastSequence) lastSequence = sequence
        const txid = asBigInt(event.txid)
        if (txid > lastTxid) lastTxid = txid
      }
      const lastOccurredAt = component.reduce((latest, event) => {
        const time = new Date(event.occurredAt).valueOf()
        return Number.isFinite(time) && time > latest ? time : latest
      }, 0)
      const lag = lastOccurredAt ? Math.max(0, Date.now() - lastOccurredAt) : 0
      lastReplicationLagMs = lag
      await connection.query(`
        UPDATE ${quoteMysqlIdentifier(mysqlTableName('migration_cdc_checkpoints'))}
        SET status='running',last_sequence=?,last_txid=?,source_safe_watermark=?,source_observed_watermark=?,
          applied_events=applied_events+?,replayed_events=replayed_events+?,
          inserted_events=inserted_events+?,updated_events=updated_events+?,deleted_events=deleted_events+?,
          cascade_deleted_events=cascade_deleted_events+?,replication_lag_ms=?,last_event_at=?,
          report=?,updated_at=NOW(3)
        WHERE id=?
      `, [
        lastSequence.toString(),
        lastTxid.toString(),
        input.safeWatermark,
        input.observedWatermark,
        appliedInComponent,
        replayedInComponent,
        insertedInComponent,
        updatedInComponent,
        deletedInComponent,
        cascadeDeletedInComponent,
        lag,
        lastOccurredAt ? new Date(lastOccurredAt) : null,
        JSON.stringify({ contractSha256: input.contractSha256, safeXmin: input.safeXmin }),
        checkpointId,
      ])
      await connection.commit()
      completedComponents += 1
      if (input.failAfterComponents === completedComponents) {
        const isolatedAcceptanceTarget = mysqlConfig.database.startsWith('sbl_migration_contract_')
          || /^pca_[0-9a-f]{8}_$/.test(mysqlConfig.tablePrefix)
        if (!isolatedAcceptanceTarget) {
          throw new Error('CDC failure injection is restricted to isolated acceptance databases or table prefixes')
        }
        throw Object.assign(new Error('injected CDC interruption'), { code: 'CDC_TEST_INTERRUPT' })
      }
    } catch (error) {
      await connection.rollback().catch(() => undefined)
      await connection.query(`
        UPDATE ${quoteMysqlIdentifier(mysqlTableName('migration_cdc_checkpoints'))}
        SET status='failed',report=?,updated_at=NOW(3) WHERE id=?
      `, [JSON.stringify({
        contractSha256: input.contractSha256,
        safeXmin: input.safeXmin,
        code: (error as Error & { code?: string }).code ?? 'CDC_APPLY_FAILED',
        completedComponents,
      }), checkpointId]).catch(() => undefined)
      throw error
    }
  }

  await connection.beginTransaction()
  try {
    const checkpoint = await lockedCheckpoint(connection, checkpointId)
    const lastSequence = asBigInt(checkpoint.lastSequence)
    const caughtUp = lastSequence >= asBigInt(input.safeWatermark)
    const pendingSafeEvents = caughtUp
      ? 0
      : Math.max(0, Number(input.sourcePendingEvents ?? input.events.length) - appliedThisRun)
    await connection.query(`
      UPDATE ${quoteMysqlIdentifier(mysqlTableName('migration_cdc_checkpoints'))}
      SET status=?,source_safe_watermark=?,source_observed_watermark=?,report=?,updated_at=NOW(3)
      WHERE id=?
    `, [
      caughtUp ? 'caught_up' : 'running',
      input.safeWatermark,
      input.observedWatermark,
      JSON.stringify({
        contractSha256: input.contractSha256,
        safeXmin: input.safeXmin,
        caughtUp,
        pendingSafeEvents,
      }),
      checkpointId,
    ])
    await connection.commit()
    return {
      checkpointId,
      inputEvents: input.events.length,
      appliedEvents: appliedThisRun,
      replayedEvents: replayedThisRun,
      insertedEvents: insertedThisRun,
      updatedEvents: updatedThisRun,
      deletedEvents: deletedThisRun,
      cascadeDeletedEvents: cascadeDeletedThisRun,
      transactionComponents: components.length,
      lastSequence: lastSequence.toString(),
      safeWatermark: input.safeWatermark,
      observedWatermark: input.observedWatermark,
      pendingSafeEvents,
      caughtUp,
      replicationLagMs: lastReplicationLagMs,
    }
  } catch (error) {
    await connection.rollback().catch(() => undefined)
    throw error
  }
}
