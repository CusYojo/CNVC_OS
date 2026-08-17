import assert from 'node:assert/strict'
import type { RowDataPacket } from 'mysql2'
import { ensureSchema } from '../db/migrate.js'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  acquireLeadAgentRuntimePermit,
  finishLeadAgentRuntimePermit,
  leadAgentRuntimeGuardConfig,
  type LeadAgentRuntimePermit,
} from '../services/leadAgentRuntimeGuardService.js'

const permitsTable = quoteMysqlIdentifier(mysqlTableName('lead_agent_runtime_permits'))
const permits: LeadAgentRuntimePermit[] = []
const checks: string[] = []

function at(value: string) {
  return new Date(value)
}

async function acquire(agentProfile: string, now: Date, reservationMicrousd = 100_000) {
  const permit = await acquireLeadAgentRuntimePermit({ agentProfile, now, reservationMicrousd })
  permits.push(permit)
  return permit
}

async function main() {
  await ensureSchema()
  const keys = [
    'LEAD_AGENT_GLOBAL_MAX_CONCURRENCY', 'LEAD_AGENT_GLOBAL_MAX_REQUESTS_PER_MINUTE',
    'LEAD_AGENT_GLOBAL_DAILY_BUDGET_USD', 'LEAD_AGENT_GLOBAL_RESERVATION_USD',
    'LEAD_AGENT_CIRCUIT_FAILURE_THRESHOLD', 'LEAD_AGENT_CIRCUIT_OPEN_MS',
    'LEAD_AGENT_PERMIT_TTL_MS', 'LEAD_AGENT_PERMIT_RETENTION_DAYS',
  ] as const
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  try {
    process.env.LEAD_AGENT_GLOBAL_MAX_CONCURRENCY = '1'
    process.env.LEAD_AGENT_GLOBAL_MAX_REQUESTS_PER_MINUTE = '100'
    process.env.LEAD_AGENT_GLOBAL_DAILY_BUDGET_USD = '100'
    process.env.LEAD_AGENT_CIRCUIT_FAILURE_THRESHOLD = '100'
    process.env.LEAD_AGENT_PERMIT_TTL_MS = '600000'
    process.env.LEAD_AGENT_PERMIT_RETENTION_DAYS = '365'
    const concurrencyNow = at('2035-01-02T00:00:00.000Z')
    const active = await acquire('lead-subject-agent', concurrencyNow)
    await assert.rejects(
      () => acquire('lead-screening-agent', new Date(concurrencyNow.getTime() + 1_000)),
      (error: Error & { code?: string }) => error.code === 'LEAD_AGENT_CONCURRENCY_LIMIT',
    )
    await finishLeadAgentRuntimePermit({ permit: active, status: 'succeeded', actualMicrousd: 12_345, now: new Date(concurrencyNow.getTime() + 2_000) })
    checks.push('cross-profile-concurrency-is-limited-by-one-mysql-permit-pool')

    process.env.LEAD_AGENT_GLOBAL_MAX_CONCURRENCY = '10'
    process.env.LEAD_AGENT_GLOBAL_MAX_REQUESTS_PER_MINUTE = '1'
    const rateNow = at('2035-02-02T00:00:00.000Z')
    const rate = await acquire('lead-research-agent', rateNow)
    await finishLeadAgentRuntimePermit({ permit: rate, status: 'succeeded', actualMicrousd: 1_000, now: new Date(rateNow.getTime() + 1_000) })
    await assert.rejects(
      () => acquire('lead-enrichment-agent', new Date(rateNow.getTime() + 2_000)),
      (error: Error & { code?: string }) => error.code === 'LEAD_AGENT_RATE_LIMIT',
    )
    checks.push('cross-profile-minute-rate-is-persistently-limited')

    process.env.LEAD_AGENT_GLOBAL_MAX_REQUESTS_PER_MINUTE = '100'
    process.env.LEAD_AGENT_GLOBAL_DAILY_BUDGET_USD = '1'
    const budgetNow = at('2035-03-02T00:00:00.000Z')
    const budget = await acquire('lead-scoring-agent', budgetNow, 750_000)
    await finishLeadAgentRuntimePermit({ permit: budget, status: 'succeeded', actualMicrousd: 600_000, now: new Date(budgetNow.getTime() + 1_000) })
    await assert.rejects(
      () => acquire('lead-research-agent', new Date(budgetNow.getTime() + 2_000), 500_000),
      (error: Error & { code?: string; retryable?: boolean }) => (
        error.code === 'LEAD_AGENT_DAILY_BUDGET_EXCEEDED' && error.retryable === false
      ),
    )
    checks.push('actual-cost-plus-active-reservation-cannot-exceed-global-daily-budget')

    process.env.LEAD_AGENT_GLOBAL_DAILY_BUDGET_USD = '100'
    process.env.LEAD_AGENT_CIRCUIT_FAILURE_THRESHOLD = '2'
    process.env.LEAD_AGENT_CIRCUIT_OPEN_MS = '60000'
    const circuitNow = at('2035-04-02T00:00:00.000Z')
    const failureOne = await acquire('lead-research-agent', circuitNow)
    await finishLeadAgentRuntimePermit({ permit: failureOne, status: 'failed', error: Object.assign(new Error('upstream one'), { code: 'UPSTREAM' }), now: new Date(circuitNow.getTime() + 1_000) })
    const failureTwo = await acquire('lead-screening-agent', new Date(circuitNow.getTime() + 2_000))
    await finishLeadAgentRuntimePermit({ permit: failureTwo, status: 'failed', error: Object.assign(new Error('upstream two'), { code: 'UPSTREAM' }), now: new Date(circuitNow.getTime() + 3_000) })
    await assert.rejects(
      () => acquire('lead-enrichment-agent', new Date(circuitNow.getTime() + 4_000)),
      (error: Error & { code?: string }) => error.code === 'LEAD_AGENT_CIRCUIT_OPEN',
    )
    checks.push('consecutive-cross-profile-failures-open-a-persistent-circuit')

    process.env.LEAD_AGENT_GLOBAL_MAX_CONCURRENCY = '1'
    process.env.LEAD_AGENT_CIRCUIT_FAILURE_THRESHOLD = '100'
    process.env.LEAD_AGENT_PERMIT_TTL_MS = '30000'
    const expiryNow = at('2035-05-02T00:00:00.000Z')
    const abandoned = await acquire('lead-subject-agent', expiryNow)
    const replacement = await acquire('lead-subject-agent', new Date(expiryNow.getTime() + 31_000))
    await finishLeadAgentRuntimePermit({ permit: replacement, status: 'succeeded', actualMicrousd: 2_000, now: new Date(expiryNow.getTime() + 32_000) })
    const [expiredRows] = await pool.query<RowDataPacket[]>(
      `SELECT state, error_class FROM ${permitsTable} WHERE id=?`, [abandoned.id],
    )
    assert.equal(expiredRows[0]?.state, 'expired')
    assert.equal(expiredRows[0]?.error_class, 'permit_expired')
    checks.push('expired-permit-is-recovered-without-permanent-capacity-leak')

    const config = leadAgentRuntimeGuardConfig()
    assert.equal(config.maxConcurrency, 1)
    assert.equal(config.maxRequestsPerMinute, 100)
    assert.equal(config.permitTtlMs, 30_000)
    checks.push('runtime-guard-environment-is-bounded-and-observable')

    const [stored] = await pool.query<RowDataPacket[]>(
      `SELECT state, reserved_microusd, actual_microusd, error_class FROM ${permitsTable} WHERE id=?`,
      [failureOne.id],
    )
    assert.equal(stored[0]?.state, 'failed')
    assert.equal(Number(stored[0]?.reserved_microusd), 100_000)
    assert.equal(Number(stored[0]?.actual_microusd), 0)
    assert.equal(stored[0]?.error_class, 'UPSTREAM')
    checks.push('permit-terminal-state-reservation-actual-cost-and-error-class-are-auditable')

    console.log(JSON.stringify({ ok: true, checks, count: checks.length }))
  } finally {
    if (permits.length) {
      await pool.query(`DELETE FROM ${permitsTable} WHERE id IN (${permits.map(() => '?').join(',')})`, permits.map((permit) => permit.id))
    }
    for (const key of keys) {
      const value = original[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
