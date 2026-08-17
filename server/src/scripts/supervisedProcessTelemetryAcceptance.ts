import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { operationalTelemetryRepository } from '../repositories/mysql/mysqlOperationalTelemetryRepository.js'
import {
  execFileSupervised,
  shutdownSupervisedProcesses,
  supervisedProcessHealth,
} from '../runtime/supervisedProcessService.js'
import {
  supervisedProcessTelemetryActions,
  supervisedProcessTelemetryExecutionKey,
  supervisedProcessTelemetryModule,
} from '../runtime/supervisedProcessTelemetry.js'

const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
const checks: string[] = []
function check(condition: unknown, name: string) {
  assert.ok(condition, name)
  checks.push(name)
}

async function rejectedCode(promise: Promise<unknown>) {
  return await promise.then(() => null, (error) => (error as { code?: unknown }).code ?? null)
}

async function waitForActive(expected: number) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (supervisedProcessHealth().active === expected) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`supervised process active count did not reach ${expected}`)
}

async function main() {
  await ensureSchema()
  const keys = {
    success: `process-telemetry-success-${randomUUID()}`,
    failure: `process-telemetry-failure-${randomUUID()}`,
    timeout: `process-telemetry-timeout-${randomUUID()}`,
    abort: `process-telemetry-abort-${randomUUID()}`,
    maxBuffer: `process-telemetry-buffer-${randomUUID()}`,
    shutdown: `process-telemetry-shutdown-${randomUUID()}`,
  }
  const prefixes = Object.values(keys).map((key) => `execution=${supervisedProcessTelemetryExecutionKey(key)};%`)
  const baseline = (await operationalTelemetryRepository.snapshot()).processHistory
  try {
    await execFileSupervised(process.execPath, ['-e', 'process.stdout.write("ok")'], {
      timeout: 5_000, telemetryKey: keys.success,
    })
    const failureCode = await rejectedCode(execFileSupervised(process.execPath, ['-e', 'process.exit(7)'], {
      timeout: 5_000, telemetryKey: keys.failure,
    }))
    check(failureCode === 7, 'non-zero-exit-preserves-exit-code')

    const timeoutCode = await rejectedCode(execFileSupervised(process.execPath, [
      '-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
    ], { timeout: 100, terminationGraceMs: 100, telemetryKey: keys.timeout }))
    check(timeoutCode === 'SUPERVISED_PROCESS_TIMEOUT', 'timeout-preserves-supervisor-error-code')

    const abortController = new AbortController()
    const abortedPromise = execFileSupervised(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      timeout: 5_000, signal: abortController.signal, telemetryKey: keys.abort,
    })
    setTimeout(() => abortController.abort(), 50).unref()
    const abortCode = await rejectedCode(abortedPromise)
    check(abortCode === 'SUPERVISED_PROCESS_ABORTED', 'abort-preserves-supervisor-error-code')

    const bufferCode = await rejectedCode(execFileSupervised(process.execPath, [
      '-e', 'process.stdout.write("x".repeat(1024));setInterval(()=>{},1000)',
    ], { timeout: 5_000, maxBuffer: 16, terminationGraceMs: 100, telemetryKey: keys.maxBuffer }))
    check(bufferCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'max-buffer-preserves-supervisor-error-code')

    const shutdownPromise = execFileSupervised(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      timeout: 30_000, telemetryKey: keys.shutdown,
    })
    await waitForActive(1)
    const shutdownResult = await shutdownSupervisedProcesses(3_000)
    const shutdownCode = await rejectedCode(shutdownPromise)
    check(shutdownCode === 'SUPERVISED_PROCESS_ABORTED'
      && shutdownResult.terminated === 1 && shutdownResult.remaining === 0,
    'shutdown-persists-terminal-event-and-drains-process')

    const observed = (await operationalTelemetryRepository.snapshot()).processHistory
    check(observed.exits24h === baseline.exits24h + 6, 'six-exit-events-are-persisted')
    check(observed.succeeded24h === baseline.succeeded24h + 1, 'success-exit-is-counted')
    check(observed.failed24h === baseline.failed24h + 5, 'failed-exits-are-counted')
    check(observed.nonZeroExit24h === baseline.nonZeroExit24h + 1, 'non-zero-exit-is-counted')
    check(observed.timeout24h === baseline.timeout24h + 1, 'timeout-exit-is-counted')
    check(observed.aborted24h === baseline.aborted24h + 1, 'abort-exit-is-counted')
    check(observed.shutdown24h === baseline.shutdown24h + 1, 'shutdown-exit-is-counted')
    check(observed.maxBuffer24h === baseline.maxBuffer24h + 1, 'max-buffer-exit-is-counted')
    check(observed.forceKilled24h === baseline.forceKilled24h + 1, 'sigkill-escalation-is-counted')
    check(observed.averageDurationMs24h >= 0, 'average-exit-duration-is-non-negative')

    const [eventRows] = await pool.query<Array<RowDataPacket & {
      user_id: string | null
      action: string
      target: string
      result: string
    }>>(
      `SELECT user_id,action,target,result FROM ${auditTable}
       WHERE module=? AND (${prefixes.map(() => 'target LIKE ?').join(' OR ')})`,
      [supervisedProcessTelemetryModule, ...prefixes],
    )
    check(eventRows.length === 6 && eventRows.every((row) => row.user_id == null),
      'exit-events-use-null-system-actor')
    check(new Set(eventRows.map((row) => row.action)).size === 6
      && Object.values(supervisedProcessTelemetryActions).every((action) => eventRows.some((row) => row.action === action)),
    'all-stable-exit-actions-are-persisted')
    check(eventRows.every((row) => !Object.values(keys).some((key) => row.target.includes(key))
      && !row.target.includes(process.execPath)),
    'exit-targets-exclude-raw-execution-keys-and-paths')
  } finally {
    await pool.query(
      `DELETE FROM ${auditTable} WHERE module=? AND (${prefixes.map(() => 'target LIKE ?').join(' OR ')})`,
      [supervisedProcessTelemetryModule, ...prefixes],
    ).catch(() => undefined)
  }
  const restored = (await operationalTelemetryRepository.snapshot()).processHistory
  check(JSON.stringify(restored) === JSON.stringify(baseline), 'process-history-returns-to-baseline-after-cleanup')
  console.log(JSON.stringify({ ok: true, checks }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => await pool.end())
