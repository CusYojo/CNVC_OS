import { createHash, randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

const permitsTable = quoteMysqlIdentifier(mysqlTableName('lead_agent_runtime_permits'))

export type LeadAgentRuntimePermit = {
  id: string
  agentProfile: string
  reservedMicrousd: number
}

type GuardError = Error & { code?: string; retryable?: boolean; retryAfterMs?: number }

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

export function leadAgentRuntimeGuardConfig() {
  return {
    maxConcurrency: Math.round(boundedNumber(process.env.LEAD_AGENT_GLOBAL_MAX_CONCURRENCY, 10, 1, 96)),
    maxRequestsPerMinute: Math.round(boundedNumber(process.env.LEAD_AGENT_GLOBAL_MAX_REQUESTS_PER_MINUTE, 60, 1, 10_000)),
    dailyBudgetMicrousd: Math.round(boundedNumber(process.env.LEAD_AGENT_GLOBAL_DAILY_BUDGET_USD, 100, 0.1, 100_000) * 1_000_000),
    defaultReservationMicrousd: Math.round(boundedNumber(process.env.LEAD_AGENT_GLOBAL_RESERVATION_USD, 0.75, 0.01, 4) * 1_000_000),
    circuitFailureThreshold: Math.round(boundedNumber(process.env.LEAD_AGENT_CIRCUIT_FAILURE_THRESHOLD, 5, 1, 100)),
    circuitOpenMs: Math.round(boundedNumber(process.env.LEAD_AGENT_CIRCUIT_OPEN_MS, 300_000, 1_000, 86_400_000)),
    permitTtlMs: Math.round(boundedNumber(process.env.LEAD_AGENT_PERMIT_TTL_MS, 600_000, 30_000, 3_600_000)),
    historyRetentionDays: Math.round(boundedNumber(process.env.LEAD_AGENT_PERMIT_RETENTION_DAYS, 30, 1, 365)),
  }
}

function guardError(code: string, message: string, retryable = true, retryAfterMs?: number): GuardError {
  const error = new Error(message) as GuardError
  error.code = code
  error.retryable = retryable
  if (retryAfterMs !== undefined) error.retryAfterMs = Math.max(1_000, Math.round(retryAfterMs))
  return error
}

const LOCAL_THROTTLE_CODES = new Set([
  'LEAD_AGENT_CONCURRENCY_LIMIT',
  'LEAD_AGENT_RATE_LIMIT',
  'LEAD_AGENT_GUARD_LOCK_TIMEOUT',
  'LEAD_AGENT_CIRCUIT_OPEN',
])

export function isLeadAgentRuntimeThrottleError(error: unknown) {
  const value = error as { code?: unknown; localThrottle?: unknown }
  if (value?.localThrottle === true) return true
  const code = String(value?.code ?? '').normalize('NFKC').trim().toUpperCase()
  if (LOCAL_THROTTLE_CODES.has(code)) return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /线索 Agent (?:全局并发已达到上限|全局分钟请求速率已达到上限|全局运行门禁暂时繁忙|连续失败熔断中)/u.test(message)
}

function utcDayStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export function shouldOpenLeadAgentCircuit(
  activeProfileCount: number,
  recentTerminalStates: string[],
  failureThreshold: number,
) {
  return activeProfileCount === 0
    && recentTerminalStates.length === failureThreshold
    && recentTerminalStates.every((state) => state === 'failed')
}

export async function acquireLeadAgentRuntimePermit(input: {
  agentProfile: string
  reservationMicrousd?: number
  now?: Date
}): Promise<LeadAgentRuntimePermit> {
  const config = leadAgentRuntimeGuardConfig()
  const now = input.now ?? new Date()
  const reservationMicrousd = Math.max(1, Math.round(input.reservationMicrousd || config.defaultReservationMicrousd))
  const connection = await pool.getConnection()
  const lockName = `lead-agent-guard-${createHash('sha256')
    .update(`${mysqlConfig.database}:${mysqlConfig.tablePrefix}`)
    .digest('hex').slice(0, 32)}`
  let locked = false
  try {
    const [lockRows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 10) AS acquired', [lockName])
    locked = Number(lockRows[0]?.acquired || 0) === 1
    if (!locked) throw guardError('LEAD_AGENT_GUARD_LOCK_TIMEOUT', '线索 Agent 全局运行门禁暂时繁忙')

    await connection.query(
      `UPDATE ${permitsTable}
       SET state='expired', actual_microusd=COALESCE(actual_microusd, 0), error_class='permit_expired', finished_at=?
       WHERE state='active' AND expires_at<=?`,
      [now, now],
    )
    await connection.query(
      `DELETE FROM ${permitsTable} WHERE state<>'active' AND finished_at<?`,
      [new Date(now.getTime() - config.historyRetentionDays * 86_400_000)],
    )

    const minuteStart = new Date(now.getTime() - 60_000)
    const dayStart = utcDayStart(now)
    const [statRows] = await connection.query<Array<RowDataPacket & {
      activeCount: number
      recentCount: number
      budgetMicrousd: number
    }>>(
      `SELECT
         SUM(CASE WHEN state='active' AND expires_at>? THEN 1 ELSE 0 END) AS activeCount,
         SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) AS recentCount,
         SUM(CASE
           WHEN created_at>=? AND state='active' AND expires_at>? THEN reserved_microusd
           WHEN created_at>=? AND state<>'active' THEN COALESCE(actual_microusd, 0)
           ELSE 0 END) AS budgetMicrousd
       FROM ${permitsTable}`,
      [now, minuteStart, dayStart, now, dayStart],
    )
    const activeCount = Number(statRows[0]?.activeCount || 0)
    const recentCount = Number(statRows[0]?.recentCount || 0)
    const budgetMicrousd = Number(statRows[0]?.budgetMicrousd || 0)

    const [profileStateRows] = await connection.query<Array<RowDataPacket & {
      activeCount: number
    }>>(
      `SELECT SUM(CASE WHEN state='active' AND expires_at>? THEN 1 ELSE 0 END) AS activeCount
       FROM ${permitsTable} WHERE agent_profile=?`,
      [now, input.agentProfile],
    )
    const activeProfileCount = Number(profileStateRows[0]?.activeCount || 0)
    const [recentTerminal] = await connection.query<Array<RowDataPacket & {
      state: string
      finished_at: Date | string | null
    }>>(
      `SELECT state, finished_at FROM ${permitsTable}
       WHERE agent_profile=? AND state IN ('succeeded','failed') AND finished_at IS NOT NULL
       ORDER BY finished_at DESC LIMIT ${config.circuitFailureThreshold}`,
      [input.agentProfile],
    )
    // 同一批并发请求中，失败请求通常比成功请求更早结束。只看“最近完成”的
    // 终态会把仍在运行、稍后可能成功的请求排除在窗口外，造成瞬时误熔断。
    // 等该 profile 没有在途任务后再判定连续失败，仍能在整批失败后及时熔断。
    if (shouldOpenLeadAgentCircuit(
      activeProfileCount,
      recentTerminal.map((row) => row.state),
      config.circuitFailureThreshold,
    )) {
      const latestFailureAt = new Date(recentTerminal[0].finished_at || 0).getTime()
      if (latestFailureAt + config.circuitOpenMs > now.getTime()) {
        throw guardError(
          'LEAD_AGENT_CIRCUIT_OPEN',
          '线索 Agent 连续失败熔断中',
          true,
          latestFailureAt + config.circuitOpenMs - now.getTime(),
        )
      }
    }
    if (activeCount >= config.maxConcurrency) {
      throw guardError('LEAD_AGENT_CONCURRENCY_LIMIT', '线索 Agent 全局并发已达到上限', true, 15_000)
    }
    if (recentCount >= config.maxRequestsPerMinute) {
      throw guardError('LEAD_AGENT_RATE_LIMIT', '线索 Agent 全局分钟请求速率已达到上限', true, 60_000)
    }
    if (budgetMicrousd + reservationMicrousd > config.dailyBudgetMicrousd) {
      throw guardError('LEAD_AGENT_DAILY_BUDGET_EXCEEDED', '线索 Agent 全局日预算不足', false)
    }

    const permit: LeadAgentRuntimePermit = {
      id: randomUUID(),
      agentProfile: input.agentProfile.slice(0, 64),
      reservedMicrousd: reservationMicrousd,
    }
    await connection.query(
      `INSERT INTO ${permitsTable}
        (id, agent_profile, state, reserved_microusd, created_at, expires_at)
       VALUES (?, ?, 'active', ?, ?, ?)`,
      [permit.id, permit.agentProfile, permit.reservedMicrousd, now, new Date(now.getTime() + config.permitTtlMs)],
    )
    return permit
  } finally {
    if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined)
    connection.release()
  }
}

export async function finishLeadAgentRuntimePermit(input: {
  permit: LeadAgentRuntimePermit
  status: 'succeeded' | 'failed'
  actualMicrousd?: number | null
  error?: unknown
  now?: Date
}) {
  const error = input.error as { code?: unknown; name?: unknown } | undefined
  const errorClass = input.status === 'failed'
    ? String(error?.code || error?.name || 'agent_execution_failed').slice(0, 64)
    : null
  const actualMicrousd = Math.max(0, Math.round(Number(input.actualMicrousd || 0)))
  const [result] = await pool.query(
    `UPDATE ${permitsTable}
     SET state=?, actual_microusd=?, error_class=?, finished_at=?
     WHERE id=? AND state='active'`,
    [input.status, actualMicrousd, errorClass, input.now ?? new Date(), input.permit.id],
  )
  if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
    throw new Error(`lead Agent runtime permit is missing or already terminal: ${input.permit.id}`)
  }
}
