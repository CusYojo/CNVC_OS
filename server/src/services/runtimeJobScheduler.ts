import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  recoverLeadScoringQueue,
  runRadarSyncImport,
  scheduleLeadScoring,
} from '../routes/meta.js'
import {
  runRadarPaperCollection,
  runRadarPublicCollection,
  runRadarWechatDaily,
  runRadarWechatInstitution,
  runRadarWechatRetry,
} from './radarCollectorService.js'
import { runLeadReserveIntake } from './leadReserveIntakeService.js'
import { recoverAiTasks } from './aiTaskService.js'
import { purgeExpiredAuthSessions } from './authService.js'
import { redactSensitiveText } from '../security/redactSecrets.js'
import { processImOutboxBatch } from './imIntegrationService.js'
import { resolveExtensionFeatureFlags } from '../config/extensionFeatureFlags.js'
import { reportRadarSourceRun, type RadarRunAction } from './radarSourceObservabilityService.js'
import {
  isRadarSyncContentionError,
  radarCandidateWriteCount,
} from './radarSyncRuntimePolicy.js'
import {
  recordJobCoordinationEventSafely,
  recordJobCoordinationEventsSafely,
} from '../runtime/jobCoordinationTelemetry.js'

type ScheduleKind = 'interval' | 'daily'
export type RuntimeJobDefinition = {
  id: string
  task: string
  enabled: boolean
  scheduleKind: ScheduleKind
  intervalSeconds?: number
  dailyHour?: number
  dailyMinute?: number
  initialDelayMs: number
  timeoutMs: number
  maxAttempts?: number
  run: (signal: AbortSignal) => Promise<Record<string, unknown>>
}

type JobRow = RowDataPacket & {
  id: string
  task: string
  enabled: number | boolean
  schedule_kind: ScheduleKind
  interval_seconds: number | null
  daily_hour: number | null
  daily_minute: number | null
  next_run_at: Date
  lease_owner: string | null
  lease_expires_at: Date | null
  current_run_id: string | null
  consecutive_failures: number
}

type ClaimedJob = {
  id: string
  task: string
  runId: string
  attempt: number
  timeoutMs: number
  definition: RuntimeJobDefinition
  leaseOwner: string
}

const jobsTable = quoteMysqlIdentifier(mysqlTableName('runtime_jobs'))
const runsTable = quoteMysqlIdentifier(mysqlTableName('runtime_job_runs'))
const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
const pollMs = readIntegerEnv('RUNTIME_JOB_POLL_MS', 5_000, 1_000)
const leaseSeconds = readIntegerEnv('RUNTIME_JOB_LEASE_SECONDS', 900, 30)
const maxRetries = readIntegerEnv('RUNTIME_JOB_MAX_RETRIES', 3, 1)
const concurrency = readIntegerEnv('RUNTIME_JOB_CONCURRENCY', 1, 1)
const active = new Map<string, { controller: AbortController; promise: Promise<void> }>()
const managedRadarJobIds = new Set([
  'radar-collect-sync',
  'radar-paper-daily',
  'radar-wechat-daily',
  'radar-wechat-retry',
  'radar-wechat-institution',
])
let pollTimer: NodeJS.Timeout | undefined
let polling = false
let started = false
let stopping = false
let radarCollectorTail: Promise<void> = Promise.resolve()

function readIntegerEnv(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name]
  if (!raw?.trim()) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`)
  }
  return value
}

function enabledEnv(name: string, fallback = true): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) return fallback
  return !['0', 'false', 'no', 'off'].includes(value)
}

async function withRadarCollectorLock<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  const previous = radarCollectorTail
  let release!: () => void
  radarCollectorTail = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Radar task aborted')
    return await task()
  } finally {
    release()
  }
}

async function runRadarCollectorAction(
  action: RadarRunAction,
  signal: AbortSignal,
) {
  return await withRadarCollectorLock(signal, async () => {
    try {
      const result = action === 'auto'
        ? await runRadarPublicCollection(signal)
        : action === 'paper-daily'
          ? await runRadarPaperCollection(signal)
          : action === 'wechat-daily'
            ? await runRadarWechatDaily(signal)
            : action === 'wechat-retry'
              ? await runRadarWechatRetry(signal)
              : await runRadarWechatInstitution(signal)
      await reportRadarSourceRun(action, { result }).catch((error) => {
        console.error(`[radar-monitor] notification failed action=${action}: ${redactSensitiveText(error)}`)
      })
      return result
    } catch (error) {
      await reportRadarSourceRun(action, { error }).catch((notifyError) => {
        console.error(`[radar-monitor] failure notification failed action=${action}: ${redactSensitiveText(notifyError)}`)
      })
      throw error
    }
  })
}

async function runRadarSyncWhenAvailable(input: Record<string, unknown>) {
  try {
    return await runRadarSyncImport(input)
  } catch (error) {
    // HTTP 手工同步与周期同步可能在同一进程短暂重叠。已有同步会处理同一候选表，
    // 因此这是幂等并发折叠，不是业务失败，更不能累计为永久死信。
    if (isRadarSyncContentionError(error)) {
      return { skipped: true, reason: 'sync_already_running', contentionCollapsed: true }
    }
    throw error
  }
}

async function runWechatCollectorWithSyncHandoff(action: Exclude<RadarRunAction, 'auto' | 'paper-daily'>, signal: AbortSignal) {
  const collection = await runRadarCollectorAction(action, signal)
  const syncHandoff = await queueRadarSyncAfterCollection(collection)
  return { ...collection, syncHandoff }
}

async function consumeRadarSyncHandoff(): Promise<{ syncOnly: boolean; candidateWrites: number }> {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<Array<RowDataPacket & { payload: Record<string, unknown> | null }>>(
      `SELECT payload FROM ${jobsTable} WHERE id='radar-collect-sync' FOR UPDATE`,
    )
    const payload = rows[0]?.payload && typeof rows[0].payload === 'object' ? rows[0].payload : {}
    const syncOnly = payload.syncOnly === true || payload.syncOnly === 1 || payload.syncOnly === 'true'
    const candidateWrites = Math.max(0, Number(payload.candidateWrites) || 0)
    if (syncOnly) {
      await connection.query(
        `UPDATE ${jobsTable}
         SET payload=JSON_REMOVE(COALESCE(payload,JSON_OBJECT()),'$.syncOnly','$.candidateWrites','$.handoffQueuedAt'),
           updated_at=NOW(3)
         WHERE id='radar-collect-sync'`,
      )
    }
    await connection.commit()
    return { syncOnly, candidateWrites }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

function millisecondsUntilShanghai(hour: number, minute: number, from = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(from)
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  let target = Date.UTC(value('year'), value('month') - 1, value('day'), hour - 8, minute)
  if (target <= from.getTime()) target += 24 * 60 * 60_000
  return target - from.getTime()
}

export function runtimeJobDefinitions(): RuntimeJobDefinition[] {
  const syncIntervalMs = readIntegerEnv('RADAR_SYNC_INTERVAL_MS', 30 * 60_000, 60_000)
  const syncStartDelayMs = readIntegerEnv('RADAR_SYNC_START_DELAY_MS', 2 * 60_000, 0)
  const retrySeconds = readIntegerEnv('RADAR_WECHAT_RETRY_INTERVAL_SECONDS', 1_800, 300)
  const institutionSeconds = readIntegerEnv('RADAR_WECHAT_INSTITUTION_INTERVAL_SECONDS', 7_200, 1_800)
  const syncInput = {
    limit: readIntegerEnv('RADAR_SYNC_PAGE_SIZE', 50, 1),
    incrementalPages: readIntegerEnv('RADAR_SYNC_INCREMENTAL_PAGES', 4, 1),
    backfillPages: readIntegerEnv('RADAR_SYNC_BACKFILL_PAGES', 1, 0),
    source: 'all',
  }
  const intakeHour = Math.min(23, readIntegerEnv('DAILY_INTAKE_HOUR', 9, 0))
  const intakeMinute = Math.min(59, readIntegerEnv('DAILY_INTAKE_MINUTE', 0, 0))
  const paperHour = Math.min(23, readIntegerEnv('RADAR_PAPER_DAILY_HOUR', 7, 0))
  const paperMinute = Math.min(59, readIntegerEnv('RADAR_PAPER_DAILY_MINUTE', 30, 0))
  return [
    {
      id: 'im-outbox-dispatch',
      task: 'im-outbox-dispatch',
      enabled: resolveExtensionFeatureFlags().imIntegrationsEnabled && enabledEnv('IM_OUTBOX_ENABLED'),
      scheduleKind: 'interval',
      intervalSeconds: readIntegerEnv('IM_OUTBOX_INTERVAL_SECONDS', 15, 5),
      initialDelayMs: 5_000,
      timeoutMs: 30_000,
      run: async (signal) => {
        const { dispatchOperationalAlerts } = await import('./operationalAlertDeliveryService.js')
        const alertDispatch = await dispatchOperationalAlerts()
        const outbox = await processImOutboxBatch({
          limit: readIntegerEnv('IM_OUTBOX_BATCH_SIZE', 10, 1), signal,
        })
        return { alertDispatch, outbox }
      },
    },
    {
      id: 'ai-task-recovery',
      task: 'ai-task-recovery',
      enabled: true,
      scheduleKind: 'interval',
      intervalSeconds: 60,
      initialDelayMs: 30_000,
      timeoutMs: 30_000,
      run: async () => await recoverAiTasks(),
    },
    {
      id: 'lead-score-recovery',
      task: 'lead-score-recovery',
      enabled: enabledEnv('SCORE_RECOVERY_ENABLED'),
      scheduleKind: 'interval',
      intervalSeconds: readIntegerEnv('SCORE_RECOVERY_INTERVAL_SECONDS', 900, 60),
      initialDelayMs: 45_000,
      timeoutMs: 5 * 60_000,
      run: async () => await recoverLeadScoringQueue(
        readIntegerEnv('SCORE_RECOVERY_BATCH_SIZE', 500, 1),
      ),
    },
    {
      id: 'file-storage-capacity-snapshot',
      task: 'file-storage-capacity-snapshot',
      enabled: true,
      scheduleKind: 'interval',
      intervalSeconds: readIntegerEnv('OPS_FILE_CAPACITY_SNAPSHOT_INTERVAL_SECONDS', 3_600, 300),
      initialDelayMs: 15_000,
      timeoutMs: 30_000,
      run: async () => {
        const { recordFileStorageCapacitySnapshot } = await import('./fileStorageCapacityTelemetryService.js')
        return await recordFileStorageCapacitySnapshot()
      },
    },
    {
      id: 'auth-session-cleanup',
      task: 'auth-session-cleanup',
      enabled: true,
      scheduleKind: 'interval',
      intervalSeconds: 3_600,
      initialDelayMs: 60_000,
      timeoutMs: 30_000,
      run: async () => await purgeExpiredAuthSessions(),
    },
    {
      id: 'lead-reserve-daily-intake',
      task: 'lead-reserve-daily-intake',
      enabled: enabledEnv('DAILY_INTAKE_ENABLED', false),
      scheduleKind: 'daily',
      dailyHour: intakeHour,
      dailyMinute: intakeMinute,
      initialDelayMs: millisecondsUntilShanghai(intakeHour, intakeMinute),
      timeoutMs: 30 * 60_000,
      run: async () => await runLeadReserveIntake({
        limit: readIntegerEnv('DAILY_INTAKE', 50, 1),
        scheduleScoring: scheduleLeadScoring,
      }),
    },
    {
      id: 'radar-collect-sync',
      task: 'radar-collect-sync',
      enabled: enabledEnv('RADAR_SYNC_ENABLED'),
      scheduleKind: 'interval',
      intervalSeconds: Math.ceil(syncIntervalMs / 1_000),
      initialDelayMs: syncStartDelayMs,
      timeoutMs: 30 * 60_000,
      run: async (signal) => {
        // The Node process owns collection, persistence and synchronization.
        // No Python service or child process participates in this runtime path.
        const handoff = await consumeRadarSyncHandoff()
        const collection = handoff.syncOnly
          ? { skipped: true, reason: 'wechat_candidate_handoff', candidateWrites: handoff.candidateWrites }
          : await runRadarCollectorAction('auto', signal)
        const sync = await runRadarSyncWhenAvailable(syncInput)
        return { collection, sync }
      },
    },
    {
      id: 'radar-paper-daily',
      task: 'radar-paper-daily',
      enabled: enabledEnv('RADAR_PAPER_CRAWL_ENABLED'),
      scheduleKind: 'daily',
      dailyHour: paperHour,
      dailyMinute: paperMinute,
      initialDelayMs: millisecondsUntilShanghai(paperHour, paperMinute),
      timeoutMs: 30 * 60_000,
      maxAttempts: 2,
      run: async (signal) => await runRadarCollectorAction('paper-daily', signal),
    },
    {
      id: 'radar-wechat-daily',
      task: 'radar-wechat-daily',
      enabled: enabledEnv('RADAR_WECHAT_DAILY_ENABLED'),
      scheduleKind: 'daily',
      dailyHour: 8,
      dailyMinute: 30,
      initialDelayMs: millisecondsUntilShanghai(8, 30),
      timeoutMs: 30 * 60_000,
      run: async (signal) => await runWechatCollectorWithSyncHandoff('wechat-daily', signal),
    },
    {
      id: 'radar-wechat-retry',
      task: 'radar-wechat-retry',
      enabled: enabledEnv('RADAR_WECHAT_DAILY_ENABLED'),
      scheduleKind: 'interval',
      intervalSeconds: retrySeconds,
      initialDelayMs: retrySeconds * 1_000,
      timeoutMs: 15 * 60_000,
      run: async (signal) => await runWechatCollectorWithSyncHandoff('wechat-retry', signal),
    },
    {
      id: 'radar-wechat-institution',
      task: 'radar-wechat-institution',
      enabled: enabledEnv('RADAR_WECHAT_DAILY_ENABLED'),
      scheduleKind: 'interval',
      intervalSeconds: institutionSeconds,
      initialDelayMs: 30_000,
      timeoutMs: 20 * 60_000,
      run: async (signal) => await runWechatCollectorWithSyncHandoff('wechat-institution', signal),
    },
  ]
}

function nextRunFor(row: Pick<JobRow, 'schedule_kind' | 'interval_seconds' | 'daily_hour' | 'daily_minute'>, from = new Date()): Date {
  if (row.schedule_kind === 'daily') {
    return new Date(from.getTime() + millisecondsUntilShanghai(row.daily_hour ?? 8, row.daily_minute ?? 30, from))
  }
  return new Date(from.getTime() + Math.max(1, row.interval_seconds ?? 60) * 1_000)
}

export async function seedRuntimeJobDefinitions(
  definitions: RuntimeJobDefinition[] = runtimeJobDefinitions(),
): Promise<{ jobs: number }> {
  for (const definition of definitions) {
    const firstRun = new Date(Date.now() + definition.initialDelayMs)
    await pool.query(
      `INSERT INTO ${jobsTable}
        (id, task, enabled, schedule_kind, interval_seconds, daily_hour, daily_minute, payload, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, JSON_OBJECT(), ?, NOW(3), NOW(3))
       ON DUPLICATE KEY UPDATE
        task=VALUES(task),
        enabled=IF(id LIKE 'radar-%', enabled, VALUES(enabled)),
        schedule_kind=VALUES(schedule_kind),
        interval_seconds=VALUES(interval_seconds), daily_hour=VALUES(daily_hour), daily_minute=VALUES(daily_minute),
        updated_at=NOW(3)`,
      [definition.id, definition.task, definition.enabled, definition.scheduleKind,
        definition.intervalSeconds ?? null, definition.dailyHour ?? null,
        definition.dailyMinute ?? null, firstRun],
    )
  }
  return { jobs: definitions.length }
}

function managedRadarJob(id: string): RuntimeJobDefinition {
  if (!managedRadarJobIds.has(id)) {
    const error = new Error('不支持的 Radar 调度任务') as Error & { status?: number; code?: string }
    error.status = 404
    error.code = 'RADAR_JOB_NOT_FOUND'
    throw error
  }
  const definition = runtimeJobDefinitions().find((item) => item.id === id)
  if (!definition) throw new Error(`Radar runtime definition missing: ${id}`)
  return definition
}

export async function listRadarRuntimeJobs() {
  const [rows] = await pool.query<Array<RowDataPacket & {
    id: string
    enabled: number | boolean
    schedule_kind: ScheduleKind
    interval_seconds: number | null
    daily_hour: number | null
    daily_minute: number | null
    next_run_at: Date
    last_status: string | null
    last_started_at: Date | null
    last_finished_at: Date | null
    last_error: string | null
    current_run_id: string | null
  }>>(
    `SELECT id, enabled, schedule_kind, interval_seconds, daily_hour, daily_minute,
      next_run_at, last_status, last_started_at, last_finished_at, last_error, current_run_id
     FROM ${jobsTable} WHERE id IN (${[...managedRadarJobIds].map(() => '?').join(',')}) ORDER BY id`,
    [...managedRadarJobIds],
  )
  return rows.map((row) => ({
    id: row.id,
    enabled: Boolean(row.enabled),
    scheduleKind: row.schedule_kind,
    intervalSeconds: row.interval_seconds,
    dailyHour: row.daily_hour,
    dailyMinute: row.daily_minute,
    nextRunAt: row.next_run_at,
    lastStatus: row.last_status,
    lastStartedAt: row.last_started_at,
    lastFinishedAt: row.last_finished_at,
    lastError: row.last_error,
    running: Boolean(row.current_run_id),
  }))
}

export async function setRadarRuntimeJobEnabled(id: string, enabled: boolean) {
  managedRadarJob(id)
  await pool.query(
    `UPDATE ${jobsTable} SET enabled=?, next_run_at=IF(?, NOW(3), next_run_at), updated_at=NOW(3) WHERE id=?`,
    [enabled, enabled, id],
  )
  return (await listRadarRuntimeJobs()).find((item) => item.id === id)
}

export async function queueRuntimeJobNow(id: string) {
  const [result] = await pool.query<import('mysql2').ResultSetHeader>(
    `UPDATE ${jobsTable} SET next_run_at=NOW(3),
       last_error=IF(last_status='dead_letter',NULL,last_error),
       consecutive_failures=IF(last_status='dead_letter',0,consecutive_failures),
       last_status=IF(last_status='dead_letter','queued',last_status),
       updated_at=NOW(3)
     WHERE id=? AND enabled=1 AND current_run_id IS NULL`,
    [id],
  )
  if (result.affectedRows !== 1) {
    const error = new Error('任务未启用或正在运行') as Error & { status?: number; code?: string }
    error.status = 409
    error.code = 'RADAR_JOB_NOT_QUEUEABLE'
    throw error
  }
  if (started) void poll()
  return { id, queued: true }
}

export async function queueRadarSyncAfterCollection(collection: Record<string, unknown>) {
  const candidateWrites = radarCandidateWriteCount(collection)
  if (candidateWrites === 0) {
    return { queued: false, candidateWrites: 0, reason: 'no_candidate_writes' }
  }
  const [result] = await pool.query<import('mysql2').ResultSetHeader>(
    `UPDATE ${jobsTable}
     SET next_run_at=NOW(3),
       payload=JSON_SET(COALESCE(payload,JSON_OBJECT()),
         '$.syncOnly',TRUE,
         '$.candidateWrites',COALESCE(JSON_EXTRACT(payload,'$.candidateWrites'),0)+?,
         '$.handoffQueuedAt',DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ')),
       last_error=IF(last_status='dead_letter',NULL,last_error),
       consecutive_failures=IF(last_status='dead_letter',0,consecutive_failures),
       last_status=IF(last_status='dead_letter','queued',last_status),
       updated_at=NOW(3)
     WHERE id='radar-collect-sync' AND enabled=1`,
    [candidateWrites],
  )
  if (result.affectedRows !== 1) {
    const error = new Error('公众号候选已写入，但雷达同步任务未启用或不存在') as Error & { status?: number; code?: string }
    error.status = 503
    error.code = 'RADAR_SYNC_HANDOFF_UNAVAILABLE'
    throw error
  }
  if (started) void poll()
  return { queued: true, candidateWrites, reason: 'candidate_write_handoff', syncOnly: true }
}

export async function recoverBenignRadarSyncDeadLetter(): Promise<{ recovered: number }> {
  const [result] = await pool.query<import('mysql2').ResultSetHeader>(
    `UPDATE ${jobsTable}
     SET last_status='queued', last_error=NULL, consecutive_failures=0,
       next_run_at=NOW(3), updated_at=NOW(3)
     WHERE id='radar-collect-sync' AND enabled=1 AND current_run_id IS NULL
       AND last_status='dead_letter'
       AND (last_error='上一轮雷达同步仍在运行，请稍后重试'
         OR last_error LIKE '%RADAR_SYNC_ALREADY_RUNNING%')`,
  )
  return { recovered: result.affectedRows }
}

export async function queueRadarRuntimeJobNow(id: string) {
  managedRadarJob(id)
  return await queueRuntimeJobNow(id)
}

export async function recoverExpiredRuntimeJobLeases(): Promise<void> {
  const [expiredRows] = await pool.query<Array<RowDataPacket & { id: string }>>(
    `SELECT id FROM ${jobsTable}
     WHERE current_run_id IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW(3)`,
  )
  await pool.query(
    `UPDATE ${runsTable} r JOIN ${jobsTable} j ON j.current_run_id=r.id
     SET r.status='abandoned', r.finished_at=NOW(3), r.error='lease expired before completion'
     WHERE r.status='running' AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at < NOW(3)`,
  )
  await pool.query(
    `UPDATE ${jobsTable}
     SET lease_owner=NULL, lease_expires_at=NULL, current_run_id=NULL,
       last_status='abandoned', last_finished_at=NOW(3), last_error='lease expired before completion',
       consecutive_failures=consecutive_failures+1, next_run_at=NOW(3), updated_at=NOW(3)
     WHERE lease_expires_at IS NOT NULL AND lease_expires_at < NOW(3)`,
  )
  if (expiredRows.length > 0) await recordJobCoordinationEventsSafely({
    domain: 'runtime-job',
    entityIds: expiredRows.map((row) => row.id),
    event: 'leaseRecovered',
  })
}

export async function claimRuntimeJobLease(
  id: string,
  definitions: Map<string, RuntimeJobDefinition>,
  claimantOwner = owner,
): Promise<ClaimedJob | null> {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<JobRow[]>(
      `SELECT * FROM ${jobsTable}
       WHERE id=? AND enabled=1 AND next_run_at <= NOW(3)
         AND COALESCE(last_status,'') <> 'dead_letter'
         AND (lease_expires_at IS NULL OR lease_expires_at < NOW(3))
       FOR UPDATE`,
      [id],
    )
    const row = rows[0]
    const now = new Date()
    const definition = definitions.get(id)
    if (!row || !definition) {
      await connection.rollback()
      if (definition) {
        const [contendedRows] = await connection.query<Array<RowDataPacket & { id: string }>>(
          `SELECT id FROM ${jobsTable}
           WHERE id=? AND current_run_id IS NOT NULL AND lease_expires_at >= NOW(3) LIMIT 1`,
          [id],
        )
        if (contendedRows[0]) await recordJobCoordinationEventSafely({
          domain: 'runtime-job', entityId: id, event: 'leaseContention',
        })
      }
      return null
    }
    const runId = randomUUID()
    const attempt = Math.max(1, Number(row.consecutive_failures || 0) + 1)
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000)
    const nextRunAt = nextRunFor(row, now)
    await connection.query(
      `INSERT INTO ${runsTable}
        (id, job_id, task, status, attempt, lease_owner, started_at, created_at)
       VALUES (?, ?, ?, 'running', ?, ?, NOW(3), NOW(3))`,
      [runId, id, row.task, attempt, claimantOwner],
    )
    await connection.query(
      `UPDATE ${jobsTable} SET lease_owner=?, lease_expires_at=?, current_run_id=?,
        last_status='running', last_started_at=NOW(3), last_error=NULL, next_run_at=?, updated_at=NOW(3)
       WHERE id=?`,
      [claimantOwner, leaseExpiresAt, runId, nextRunAt, id],
    )
    await connection.commit()
    return {
      id, task: row.task, runId, attempt, timeoutMs: definition.timeoutMs,
      definition, leaseOwner: claimantOwner,
    }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

function errorText(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : error).slice(0, 8_000)
}

async function finishJob(claim: ClaimedJob, status: 'succeeded' | 'failed' | 'dead_letter' | 'cancelled', result?: Record<string, unknown>, error?: unknown): Promise<void> {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<JobRow[]>(`SELECT * FROM ${jobsTable} WHERE id=? FOR UPDATE`, [claim.id])
    const row = rows[0]
    if (!row || row.current_run_id !== claim.runId || row.lease_owner !== claim.leaseOwner) {
      await connection.rollback()
      await recordJobCoordinationEventSafely({
        domain: 'runtime-job', entityId: claim.id, event: 'staleCompletionRejected',
      })
      return
    }
    const nextRunAt = status === 'failed'
      ? new Date(Date.now() + Math.min(30 * 60_000, 60_000 * (2 ** Math.max(0, claim.attempt - 1))))
      : new Date(row.next_run_at)
    await connection.query(
      `UPDATE ${runsTable} SET status=?, finished_at=NOW(3), result=?, error=? WHERE id=?`,
      [status, result ? JSON.stringify(result) : null, error ? errorText(error) : null, claim.runId],
    )
    await connection.query(
      `UPDATE ${jobsTable} SET lease_owner=NULL, lease_expires_at=NULL, current_run_id=NULL,
        last_status=?, last_finished_at=NOW(3), last_error=?, consecutive_failures=?, next_run_at=?, updated_at=NOW(3)
       WHERE id=?`,
      [status, error ? errorText(error) : null, status === 'failed' ? claim.attempt : 0, nextRunAt, claim.id],
    )
    await connection.commit()
  } catch (finishError) {
    await connection.rollback()
    throw finishError
  } finally {
    connection.release()
  }
}

export async function executeClaimedRuntimeJob(claim: ClaimedJob): Promise<void> {
  const controller = new AbortController()
  let heartbeat: NodeJS.Timeout | undefined
  let timeout: NodeJS.Timeout | undefined
  let timedOut = false
  const promise = (async () => {
    try {
      heartbeat = setInterval(() => {
        const expiresAt = new Date(Date.now() + leaseSeconds * 1_000)
        void pool.query(
          `UPDATE ${jobsTable} SET lease_expires_at=?, updated_at=NOW(3)
           WHERE id=? AND current_run_id=? AND lease_owner=?`,
          [expiresAt, claim.id, claim.runId, claim.leaseOwner],
        ).catch((error) => console.error(`[runtime-job] heartbeat failed job=${claim.id}: ${errorText(error)}`))
      }, Math.max(10_000, Math.floor(leaseSeconds * 1_000 / 3)))
      timeout = setTimeout(() => {
        timedOut = true
        controller.abort(new Error(`job timeout after ${claim.timeoutMs}ms`))
      }, claim.timeoutMs)
      const result = await Promise.race([
        claim.definition.run(controller.signal),
        new Promise<never>((_resolve, reject) => {
          if (controller.signal.aborted) return reject(controller.signal.reason)
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
        }),
      ])
      await finishJob(claim, 'succeeded', result)
      console.log(`[runtime-job] succeeded job=${claim.id} run=${claim.runId}`)
    } catch (error) {
      const cancelled = stopping && !timedOut
      const maxAttempts = claim.definition.maxAttempts ?? maxRetries
      const status = cancelled ? 'cancelled' : (claim.attempt >= maxAttempts ? 'dead_letter' : 'failed')
      await finishJob(claim, status, undefined, error)
      console.error(`[runtime-job] ${status} job=${claim.id} run=${claim.runId}: ${errorText(error)}`)
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      if (timeout) clearTimeout(timeout)
      active.delete(claim.id)
    }
  })()
  active.set(claim.id, { controller, promise })
  await promise
}

async function poll(): Promise<void> {
  if (polling || stopping || active.size >= concurrency) return
  polling = true
  try {
    await recoverExpiredRuntimeJobLeases()
    const capacity = concurrency - active.size
    const [rows] = await pool.query<Array<RowDataPacket & { id: string }>>(
      `SELECT id FROM ${jobsTable}
       WHERE enabled=1 AND next_run_at <= NOW(3)
         AND COALESCE(last_status,'') <> 'dead_letter'
         AND (lease_expires_at IS NULL OR lease_expires_at < NOW(3))
       ORDER BY next_run_at, id LIMIT ?`,
      [capacity],
    )
    const definitions = new Map(runtimeJobDefinitions().map((definition) => [definition.id, definition]))
    for (const row of rows) {
      const claim = await claimRuntimeJobLease(row.id, definitions)
      if (claim) void executeClaimedRuntimeJob(claim)
    }
  } catch (error) {
    console.error(`[runtime-job] poll failed: ${errorText(error)}`)
  } finally {
    polling = false
  }
}

export async function startRuntimeJobScheduler(): Promise<void> {
  if (started) return
  stopping = false
  const definitions = runtimeJobDefinitions()
  await seedRuntimeJobDefinitions(definitions)
  await recoverExpiredRuntimeJobLeases()
  const benignRecovery = await recoverBenignRadarSyncDeadLetter()
  if (benignRecovery.recovered > 0) {
    console.warn('[runtime-job] recovered benign radar sync contention dead-letter')
  }
  started = true
  pollTimer = setInterval(() => void poll(), pollMs)
  pollTimer.unref()
  await poll()
  console.log(`[runtime-job] scheduler ready owner=${owner} jobs=${definitions.length}`)
}

export async function stopRuntimeJobScheduler(): Promise<void> {
  if (!started) return
  stopping = true
  if (pollTimer) clearInterval(pollTimer)
  for (const running of active.values()) running.controller.abort(new Error('service shutdown'))
  const waits = [...active.values()].map((running) => running.promise.catch(() => undefined))
  await Promise.race([
    Promise.all(waits),
    new Promise((resolve) => setTimeout(resolve, 20_000)),
  ])
  started = false
}

export async function runtimeJobSchedulerHealth() {
  if (!started || stopping) {
    return { name: 'mysql-runtime-jobs', ok: false, inProcess: true, owner, active: active.size }
  }
  try {
    const [rows] = await pool.query<Array<RowDataPacket & { enabled_count: number; leased_count: number; dead_count: number }>>(
      `SELECT COUNT(*) AS enabled_count,
        SUM(CASE WHEN lease_expires_at >= NOW(3) THEN 1 ELSE 0 END) AS leased_count,
        SUM(CASE WHEN last_status='dead_letter' THEN 1 ELSE 0 END) AS dead_count
       FROM ${jobsTable} WHERE enabled=1`,
    )
    const deadLetter = Number(rows[0]?.dead_count || 0)
    return {
      name: 'mysql-runtime-jobs', ok: deadLetter === 0, inProcess: true, owner,
      enabled: Number(rows[0]?.enabled_count || 0),
      leased: Number(rows[0]?.leased_count || 0),
      deadLetter,
      active: active.size,
    }
  } catch (error) {
    return { name: 'mysql-runtime-jobs', ok: false, inProcess: true, owner, active: active.size, error: errorText(error) }
  }
}
