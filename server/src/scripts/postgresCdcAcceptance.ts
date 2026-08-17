import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import mysql from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { applyPostgresCdcEvents } from '../services/postgresCdcApplyService.js'
import type { PostgresCdcEvent } from './postgresCdcContract.js'
import {
  POSTGRES_CDC_CAPTURE_VERSION,
  POSTGRES_CDC_TABLES,
  postgresCdcBaseSql,
  postgresCdcContractSha256,
  postgresCdcTriggerSql,
} from './postgresCdcContract.js'

const execFileAsync = promisify(execFile)
const workerMode = process.argv.includes('--worker')

function identifier(value: string) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error('unsafe CDC acceptance identifier')
  return `\`${value}\``
}

function fixtureEvents(): PostgresCdcEvent[] {
  const userId = '10000000-0000-4000-8000-000000000001'
  const projectId = '20000000-0000-4000-8000-000000000001'
  const fileId = '30000000-0000-4000-8000-000000000001'
  const occurredAt = new Date(Date.now() - 500).toISOString()
  const user = {
    id: userId,
    email: 'cdc-acceptance@example.invalid',
    name: 'CDC验收用户',
    role: '投资经理',
    department: '投资部',
    password_hash: '$2b$10$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuu',
    status: '启用',
    last_login: null,
    created_at: occurredAt,
  }
  const projectV1 = {
    id: projectId,
    name: 'CDC项目-v1',
    company_name: 'CDC项目公司',
    industry: '测试',
    round: '天使轮',
    stage: '线索',
    owner: 'CDC验收用户',
    collaborators: [],
    source: 'cdc-acceptance',
    financing: null,
    valuation: null,
    risk_level: '低',
    score: 0,
    progress: 0,
    summary: null,
    business_model: null,
    market: null,
    team: null,
    tags: ['cdc'],
    scoring: null,
    pinned: false,
    created_at: occurredAt,
    updated_at: occurredAt,
  }
  const projectV2 = { ...projectV1, name: 'CDC项目-v2', progress: 25, updated_at: new Date().toISOString() }
  const file = {
    id: fileId,
    project_id: projectId,
    name: 'cdc.txt',
    type: 'TXT',
    category: '其他',
    size: '3 B',
    uploader: 'CDC验收用户',
    parse_status: '已解析',
    storage_path: null,
    content_text: 'cdc',
    version: 1,
    uploaded_at: occurredAt,
  }
  const base = { occurredAt, actor: 'cdc-acceptance', migrationBatch: 'cdc-batch-1', cascadeDelete: false }
  return [
    { ...base, sequence: '4', txid: '102', table: 'projects', operation: 'U', entityId: projectId, rowData: projectV2, tombstone: null },
    { ...base, sequence: '1', txid: '100', table: 'users', operation: 'I', entityId: userId, rowData: user, tombstone: null },
    { ...base, sequence: '6', txid: '103', table: 'project_files', operation: 'D', entityId: fileId, rowData: null, tombstone: file, cascadeDelete: true },
    { ...base, sequence: '3', txid: '101', table: 'project_files', operation: 'I', entityId: fileId, rowData: file, tombstone: null },
    { ...base, sequence: '2', txid: '101', table: 'projects', operation: 'I', entityId: projectId, rowData: projectV1, tombstone: null },
    { ...base, sequence: '5', txid: '103', table: 'projects', operation: 'D', entityId: projectId, rowData: null, tombstone: projectV2 },
  ]
}

async function scalar(connection: Awaited<ReturnType<typeof pool.getConnection>>, sql: string, params: unknown[] = []): Promise<number> {
  const [rows] = await connection.query<Array<RowDataPacket & { count: number }>>(sql, params)
  return Number(rows[0]?.count ?? 0)
}

async function runWorker(): Promise<void> {
  const connection = await pool.getConnection()
  const sourceInstance = 'cdc-acceptance-source'
  const sourceFingerprint = createHash('sha256').update('cdc-acceptance-source').digest('hex')
  const contractSha256 = postgresCdcContractSha256('sbl_migration')
  const input = {
    sourceInstance,
    sourceFingerprint,
    contractSha256,
    safeWatermark: '6',
    observedWatermark: '6',
    safeXmin: '200',
    sourcePendingEvents: 6,
    events: fixtureEvents(),
  }
  try {
    let interruptionCode = ''
    try {
      await applyPostgresCdcEvents(connection, { ...input, failAfterComponents: 2 })
    } catch (error) {
      interruptionCode = String((error as Error & { code?: string }).code ?? '')
      if (interruptionCode !== 'CDC_TEST_INTERRUPT') throw error
    }
    assert.equal(interruptionCode, 'CDC_TEST_INTERRUPT')
    assert.equal(await scalar(connection, `SELECT COUNT(*) count FROM ${quoteMysqlIdentifier(mysqlTableName('users'))}`), 1)
    assert.equal(await scalar(connection, `SELECT COUNT(*) count FROM ${quoteMysqlIdentifier(mysqlTableName('projects'))}`), 1)
    assert.equal(await scalar(connection, `SELECT COUNT(*) count FROM ${quoteMysqlIdentifier(mysqlTableName('project_files'))}`), 1)
    assert.equal(await scalar(connection, `SELECT COUNT(*) count FROM ${quoteMysqlIdentifier(mysqlTableName('migration_cdc_events'))}`), 3)
    const [failedRows] = await connection.query<Array<RowDataPacket & { status: string; lastSequence: string }>>(`
      SELECT status,CAST(last_sequence AS CHAR) AS lastSequence
      FROM ${quoteMysqlIdentifier(mysqlTableName('migration_cdc_checkpoints'))}
    `)
    assert.equal(failedRows[0]?.status, 'failed')
    assert.equal(failedRows[0]?.lastSequence, '3')

    const resumed = await applyPostgresCdcEvents(connection, input)
    assert.equal(resumed.appliedEvents, 3)
    assert.equal(resumed.replayedEvents, 3)
    assert.equal(resumed.insertedEvents, 0)
    assert.equal(resumed.updatedEvents, 1)
    assert.equal(resumed.deletedEvents, 2)
    assert.equal(resumed.cascadeDeletedEvents, 1)
    assert.equal(resumed.lastSequence, '6')
    assert.equal(resumed.caughtUp, true)
    assert.equal(await scalar(connection, `SELECT COUNT(*) count FROM ${quoteMysqlIdentifier(mysqlTableName('users'))}`), 1)
    assert.equal(await scalar(connection, `SELECT COUNT(*) count FROM ${quoteMysqlIdentifier(mysqlTableName('projects'))}`), 0)
    assert.equal(await scalar(connection, `SELECT COUNT(*) count FROM ${quoteMysqlIdentifier(mysqlTableName('project_files'))}`), 0)
    assert.equal(await scalar(connection, `SELECT COUNT(*) count FROM ${quoteMysqlIdentifier(mysqlTableName('iam_user_mappings'))} WHERE source_system='legacy_postgres'`), 1)
    assert.equal(await scalar(connection, `SELECT COUNT(*) count FROM ${quoteMysqlIdentifier(mysqlTableName('migration_cdc_events'))}`), 6)
    assert.equal(await scalar(connection, `SELECT COUNT(*) count FROM ${quoteMysqlIdentifier(mysqlTableName('migration_cdc_events'))} WHERE tombstone=1`), 2)
    assert.equal(await scalar(connection, `SELECT COUNT(*) count FROM ${quoteMysqlIdentifier(mysqlTableName('migration_cdc_events'))} WHERE cascade_delete=1 AND outcome='noop'`), 1)
    const [checkpointRows] = await connection.query<Array<RowDataPacket & {
      status: string
      lastSequence: string
      appliedEvents: string
      replayedEvents: string
      insertedEvents: string
      updatedEvents: string
      deletedEvents: string
      cascadeDeletedEvents: string
    }>>(`
      SELECT status,CAST(last_sequence AS CHAR) AS lastSequence,
        CAST(applied_events AS CHAR) AS appliedEvents,CAST(replayed_events AS CHAR) AS replayedEvents,
        CAST(inserted_events AS CHAR) AS insertedEvents,CAST(updated_events AS CHAR) AS updatedEvents,
        CAST(deleted_events AS CHAR) AS deletedEvents,
        CAST(cascade_deleted_events AS CHAR) AS cascadeDeletedEvents
      FROM ${quoteMysqlIdentifier(mysqlTableName('migration_cdc_checkpoints'))}
    `)
    assert.deepEqual({ ...checkpointRows[0] }, {
      status: 'caught_up',
      lastSequence: '6',
      appliedEvents: '6',
      replayedEvents: '3',
      insertedEvents: '3',
      updatedEvents: '1',
      deletedEvents: '2',
      cascadeDeletedEvents: '1',
    })
    const emptyReplay = await applyPostgresCdcEvents(connection, { ...input, events: [] })
    assert.equal(emptyReplay.appliedEvents, 0)
    assert.equal(emptyReplay.replayedEvents, 0)
    assert.equal(emptyReplay.caughtUp, true)
    console.log(JSON.stringify({
      ok: true,
      interruptionCode,
      resumed,
      eventLedgerRows: 6,
      tombstones: 2,
      cascadeNoops: 1,
      finalCheckpoint: checkpointRows[0],
    }))
  } finally {
    connection.release()
    await pool.end()
  }
}

async function runParent(): Promise<void> {
  const prefix = `pca_${randomUUID().replaceAll('-', '').slice(0, 8)}_`
  assert(/^pca_[0-9a-f]{8}_$/.test(prefix))
  const database = process.env.DB_DATABASE?.trim()
  const migrationUser = process.env.DB_MIGRATION_USERNAME?.trim()
  const migrationPassword = process.env.DB_MIGRATION_PASSWORD
  if (!database) throw new Error('DB_DATABASE is required')
  if (!migrationUser || !migrationPassword) {
    throw new Error('DB_MIGRATION_USERNAME and DB_MIGRATION_PASSWORD are required for isolated CDC acceptance')
  }
  const migrationConnection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    database,
    user: migrationUser,
    password: migrationPassword,
    charset: 'utf8mb4_0900_ai_ci',
  })
  try {
    const baseSql = postgresCdcBaseSql('sbl_migration').join('\n')
    const triggerSql = POSTGRES_CDC_TABLES.flatMap((table) => postgresCdcTriggerSql('sbl_migration', table)).join('\n')
    assert(/AFTER INSERT OR UPDATE OR DELETE/.test(triggerSql))
    assert(/pg_trigger_depth\(\) > 1/.test(baseSql))
    assert(/txid_current\(\)/.test(baseSql))
    assert(/actor/.test(baseSql) && /migration_batch/.test(baseSql) && /tombstone/.test(baseSql))
    const escapedPrefix = `${prefix.replaceAll('_', '\\_')}%`
    const [preexisting] = await migrationConnection.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) count FROM information_schema.TABLES
       WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE ? ESCAPE '\\\\'`,
      [database, escapedPrefix],
    )
    if (Number(preexisting[0]?.count ?? 0) !== 0) {
      throw new Error('isolated CDC acceptance table prefix already exists; rerun to allocate another prefix')
    }
    const environment = { ...process.env, DB_DATABASE: database, DB_FREFIX: prefix }
    await execFileAsync(process.execPath, [
      '--env-file-if-exists=.env', '--import', 'tsx', 'server/src/scripts/migrateMySqlSchema.ts',
    ], { cwd: process.cwd(), env: environment, maxBuffer: 8 * 1024 * 1024 })
    const worker = await execFileAsync(process.execPath, [
      '--env-file-if-exists=.env', '--import', 'tsx', 'server/src/scripts/postgresCdcAcceptance.ts', '--worker',
    ], { cwd: process.cwd(), env: environment, maxBuffer: 8 * 1024 * 1024 })
    const workerResult = JSON.parse(worker.stdout.trim().split('\n').at(-1) || '{}') as { ok?: boolean }
    assert.equal(workerResult.ok, true)
    const output = {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      ok: true,
      isolatedTablePrefix: true,
      sourceCaptureRuntimeVerified: false,
      sourceCaptureRuntimeBlocker:
        'target-isolated acceptance does not substitute for installing and exercising capture against the configured PostgreSQL source',
      captureVersion: POSTGRES_CDC_CAPTURE_VERSION,
      allowlistedTables: POSTGRES_CDC_TABLES.length,
      targetEvents: 6,
      transactionComponents: 4,
      interruptionAfterComponents: 2,
      resumedFromSequence: 3,
      finalSequence: 6,
      insertedEvents: 3,
      updatedEvents: 1,
      deletedEvents: 2,
      cascadeDeletedEvents: 1,
      replayedEvents: 3,
      checks: [
        'source-ddl-captures-insert-update-delete-actor-batch-and-cascade-tombstone',
        'target-applier-sorts-out-of-order-input-and-preserves-source-transaction-components',
        'interruption-persists-sequence-three-and-resume-replays-without-duplicate-business-rows',
        'parent-delete-cascades-child-and-later-child-tombstone-is-audited-noop',
        'source-and-target-watermark-caught-up-after-resume',
      ],
    }
    const directory = path.resolve('.runtime/migration-evidence/postgres-cdc-acceptance')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const target = path.resolve(directory, 'report.json')
    const temporary = `${target}.${process.pid}-${Date.now()}`
    await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, target)
    await chmod(target, 0o600)
    console.log(JSON.stringify(output))
  } finally {
    const escapedPrefix = `${prefix.replaceAll('_', '\\_')}%`
    const [tables] = await migrationConnection.query<Array<RowDataPacket & { tableName: string }>>(
      `SELECT TABLE_NAME tableName FROM information_schema.TABLES
       WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE ? ESCAPE '\\\\' ORDER BY TABLE_NAME`,
      [database, escapedPrefix],
    )
    await migrationConnection.query('SET FOREIGN_KEY_CHECKS=0')
    try {
      for (const table of tables) await migrationConnection.query(`DROP TABLE ${identifier(table.tableName)}`)
    } finally {
      await migrationConnection.query('SET FOREIGN_KEY_CHECKS=1')
    }
    const [remaining] = await migrationConnection.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) count FROM information_schema.TABLES
       WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE ? ESCAPE '\\\\'`,
      [database, escapedPrefix],
    )
    await migrationConnection.end()
    assert.equal(Number(remaining[0]?.count ?? 0), 0)
    await pool.end()
  }
}

if (workerMode) await runWorker()
else await runParent()
