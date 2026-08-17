import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'
import { applyPostgresCdcEvents } from '../services/postgresCdcApplyService.js'
import {
  POSTGRES_CDC_CAPTURE_VERSION,
  POSTGRES_CDC_TABLES,
  normalizePostgresCdcEvent,
  postgresCdcContractSha256,
  quotePostgresName,
} from './postgresCdcContract.js'

type TxRange = { txid: string; minSequence: string; maxSequence: string; events: string }

const apply = process.argv.includes('--apply')
const authorityMode = process.env.PG_CDC_AUTHORITY_MODE?.trim() || ''
const sourceUrl = (() => {
  const value = process.env.DATABASE_URL?.trim()
  if (!value) throw new Error('DATABASE_URL is required for the legacy PostgreSQL source')
  return value
})()
const cdcSchema = process.env.PG_CDC_SCHEMA?.trim() || 'sbl_migration'
const sourceInstance = process.env.PG_CDC_SOURCE_INSTANCE?.trim()
  || `legacy-postgres-${createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16)}`
if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(sourceInstance)) throw new Error('invalid PG_CDC_SOURCE_INSTANCE')
const sourceFingerprint = createHash('sha256').update(sourceUrl).digest('hex')
const contractSha256 = postgresCdcContractSha256(cdcSchema)
const transactionLimit = Number(process.env.PG_CDC_TRANSACTION_BATCH_SIZE ?? 500)
if (!Number.isInteger(transactionLimit) || transactionLimit < 1 || transactionLimit > 10_000) {
  throw new Error('PG_CDC_TRANSACTION_BATCH_SIZE must be an integer between 1 and 10000')
}

function asBigInt(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`invalid CDC position: ${value}`)
  return BigInt(value)
}

function selectClosedTransactionPrefix(ranges: TxRange[], truncated: boolean): TxRange[] {
  if (!ranges.length) return []
  const components: TxRange[][] = []
  let current: TxRange[] = []
  let currentMax = -1n
  for (const range of ranges) {
    const min = asBigInt(range.minSequence)
    const max = asBigInt(range.maxSequence)
    if (current.length && min > currentMax) {
      components.push(current)
      current = []
      currentMax = -1n
    }
    current.push(range)
    if (max > currentMax) currentMax = max
  }
  if (current.length) components.push(current)
  if (truncated) components.pop()
  return components.flat()
}

async function writeEvidence(payload: Record<string, unknown>): Promise<void> {
  const directory = path.resolve('.runtime/migration-evidence/postgres-cdc')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const target = path.resolve(directory, `${sourceInstance}.json`)
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

async function main(): Promise<void> {
  if (apply && authorityMode !== 'legacy-postgres-authoritative') {
    throw new Error('PG_CDC_AUTHORITY_MODE=legacy-postgres-authoritative is required for forward CDC apply')
  }
  await ensureSchema()
  const source = new pg.Client({
    connectionString: sourceUrl,
    application_name: apply ? 'sbl_postgres_cdc_apply' : 'sbl_postgres_cdc_preview',
    statement_timeout: 60_000,
    query_timeout: 65_000,
  })
  const target = await pool.getConnection()
  let sourceTransaction = false
  let lockHeld = false
  const lockName = `sbl:pgcdc:${createHash('sha256').update(sourceInstance).digest('hex').slice(0, 48)}`
  try {
    await source.connect()
    const config = await source.query<{ capture_version: string; contract_sha256: string; installed_tables: unknown }>(`
      SELECT capture_version,contract_sha256,installed_tables
      FROM ${quotePostgresName(cdcSchema)}.capture_config WHERE singleton=true
    `)
    const installed = config.rows[0]
    const installedTables = Array.isArray(installed?.installed_tables) ? installed.installed_tables.map(String) : []
    if (!installed
      || installed.capture_version !== POSTGRES_CDC_CAPTURE_VERSION
      || installed.contract_sha256 !== contractSha256
      || JSON.stringify(installedTables) !== JSON.stringify(POSTGRES_CDC_TABLES)) {
      throw new Error('PostgreSQL CDC capture contract is missing or does not match this release')
    }
    const [checkpointRows] = await target.query<Array<RowDataPacket & { lastSequence: string }>>(`
      SELECT CAST(last_sequence AS CHAR) AS lastSequence
      FROM ${quoteMysqlIdentifier(mysqlTableName('migration_cdc_checkpoints'))}
      WHERE source_system='legacy_postgres' AND source_instance=? LIMIT 1
    `, [sourceInstance])
    const lastSequence = String(checkpointRows[0]?.lastSequence ?? '0')
    asBigInt(lastSequence)

    await source.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    sourceTransaction = true
    const horizon = await source.query<{
      safe_xmin: string
      safe_watermark: string
      observed_watermark: string
      unsafe_events: string
      pending_safe_events: string
    }>(`
      WITH horizon AS (
        SELECT txid_snapshot_xmin(txid_current_snapshot())::text::bigint AS safe_xmin
      )
      SELECT h.safe_xmin::text,
        COALESCE(MAX(c.sequence) FILTER (WHERE c.txid < h.safe_xmin),0)::text AS safe_watermark,
        COALESCE(MAX(c.sequence),0)::text AS observed_watermark,
        COUNT(*) FILTER (WHERE c.txid >= h.safe_xmin)::text AS unsafe_events,
        COUNT(*) FILTER (WHERE c.txid < h.safe_xmin AND c.sequence > $1::bigint)::text AS pending_safe_events
      FROM horizon h LEFT JOIN ${quotePostgresName(cdcSchema)}.change_log c ON true
      GROUP BY h.safe_xmin
    `, [lastSequence])
    const safeXmin = horizon.rows[0]?.safe_xmin ?? '0'
    const safeWatermark = horizon.rows[0]?.safe_watermark ?? '0'
    const observedWatermark = horizon.rows[0]?.observed_watermark ?? '0'
    const unsafeEvents = Number(horizon.rows[0]?.unsafe_events ?? '0')
    const pendingSafeEvents = Number(horizon.rows[0]?.pending_safe_events ?? '0')
    const txRanges = await source.query<TxRange>(`
      SELECT txid::text AS txid,MIN(sequence)::text AS "minSequence",
        MAX(sequence)::text AS "maxSequence",COUNT(*)::text AS events
      FROM ${quotePostgresName(cdcSchema)}.change_log
      WHERE sequence > $1::bigint AND txid < $2::bigint
      GROUP BY txid
      ORDER BY MIN(sequence)
      LIMIT $3
    `, [lastSequence, safeXmin, transactionLimit + 1])
    const truncated = txRanges.rows.length > transactionLimit
    const selectedRanges = selectClosedTransactionPrefix(
      truncated ? txRanges.rows.slice(0, transactionLimit + 1) : txRanges.rows,
      truncated,
    )
    if (truncated && selectedRanges.length === 0) {
      throw new Error('CDC transaction batch is smaller than one interleaved transaction component')
    }
    const selectedTxids = selectedRanges.map((range) => range.txid)
    const rawEvents = selectedTxids.length
      ? await source.query<Record<string, unknown>>(`
          SELECT sequence::text AS sequence,txid::text AS txid,table_name AS table,operation,
            entity_id AS "entityId",row_data AS "rowData",tombstone,occurred_at AS "occurredAt",
            actor,migration_batch AS "migrationBatch",cascade_delete AS "cascadeDelete"
          FROM ${quotePostgresName(cdcSchema)}.change_log
          WHERE txid = ANY($1::bigint[]) ORDER BY sequence
        `, [selectedTxids])
      : { rows: [] as Record<string, unknown>[] }
    const events = rawEvents.rows.map(normalizePostgresCdcEvent)
    await source.query('ROLLBACK')
    sourceTransaction = false

    let result: Awaited<ReturnType<typeof applyPostgresCdcEvents>> | null = null
    if (apply) {
      const [lockRows] = await target.query<Array<RowDataPacket & { acquired: number }>>(
        'SELECT GET_LOCK(?,0) AS acquired', [lockName],
      )
      if (Number(lockRows[0]?.acquired ?? 0) !== 1) throw new Error('another CDC applier for this source is running')
      lockHeld = true
      result = await applyPostgresCdcEvents(target, {
        sourceInstance,
        sourceFingerprint,
        contractSha256,
        safeWatermark,
        observedWatermark,
        safeXmin,
        sourcePendingEvents: pendingSafeEvents,
        events,
      })
    }
    const output = {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      ok: true,
      mode: apply ? 'apply' : 'preview',
      sourceInstance,
      sourceFingerprint,
      captureVersion: POSTGRES_CDC_CAPTURE_VERSION,
      authorityMode: apply ? authorityMode : 'preview-only',
      contractSha256,
      lastSequenceBefore: lastSequence,
      safeXmin,
      safeWatermark,
      observedWatermark,
      unsafeOpenTransactionEvents: unsafeEvents,
      pendingSafeEventsBefore: pendingSafeEvents,
      selectedTransactions: selectedTxids.length,
      selectedEvents: events.length,
      truncated,
      result,
    }
    await writeEvidence(output)
    console.log(JSON.stringify(output))
  } finally {
    if (sourceTransaction) await source.query('ROLLBACK').catch(() => undefined)
    if (lockHeld) await target.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined)
    target.release()
    await source.end().catch(() => undefined)
    await pool.end()
  }
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({
    ok: false,
    code: (error as Error & { code?: string }).code ?? 'POSTGRES_CDC_FAILED',
    message: (error as Error).message,
  }))
  process.exitCode = 1
})
