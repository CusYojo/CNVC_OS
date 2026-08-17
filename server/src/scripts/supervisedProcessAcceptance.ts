import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  execFileSupervised,
  shutdownSupervisedProcesses,
  supervisedProcessHealth,
} from '../runtime/supervisedProcessService.js'
import {
  supervisedProcessTelemetryExecutionKey,
  supervisedProcessTelemetryModule,
} from '../runtime/supervisedProcessTelemetry.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    if (process.platform !== 'win32') {
      const state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
      return Boolean(state) && !state.startsWith('Z')
    }
    return true
  } catch { return false }
}

async function waitForProcessesGone(pids: number[]) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processExists(pid))) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`supervised process tree still exists: ${pids.filter(processExists).join(',')}`)
}

async function waitForPidFile(filePath: string): Promise<number> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const value = await readFile(filePath, 'utf8').catch(() => '')
    if (/^\d+$/.test(value.trim())) return Number(value.trim())
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`supervised fixture did not write pid file: ${filePath}`)
}

const directory = await mkdtemp(path.join(tmpdir(), 'supervised-process-acceptance-'))
const telemetryKeys = {
  success: `process-supervisor-success-${randomUUID()}`,
  timeout: `process-supervisor-timeout-${randomUUID()}`,
  shutdown: `process-supervisor-shutdown-${randomUUID()}`,
}
try {
  const success = await execFileSupervised(process.execPath, ['-e', 'process.stdout.write("ok")'], {
    timeout: 5_000,
    telemetryKey: telemetryKeys.success,
  })
  assert(success.stdout === 'ok', 'successful supervised command output mismatch')

  const pidFile = path.join(directory, 'timeout-pids.txt')
  const nestedFixture = [
    "const {spawn}=require('node:child_process')",
    "const fs=require('node:fs')",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
    "fs.writeFileSync(process.argv[1],`${process.pid},${child.pid}`)",
    'setInterval(()=>{},1000)',
  ].join(';')
  let timeoutError: unknown
  try {
    await execFileSupervised(process.execPath, ['-e', nestedFixture, pidFile], {
      timeout: 300,
      terminationGraceMs: 200,
      telemetryKey: telemetryKeys.timeout,
    })
  } catch (error) {
    timeoutError = error
  }
  assert((timeoutError as { code?: string })?.code === 'SUPERVISED_PROCESS_TIMEOUT', 'timeout error contract mismatch')
  const timedOutPids = (await readFile(pidFile, 'utf8')).split(',').map(Number)
  await waitForProcessesGone(timedOutPids)
  assert(supervisedProcessHealth().active === 0, 'timed-out process remained registered')

  const shutdownPidFile = path.join(directory, 'shutdown-pid.txt')
  const activePromise = execFileSupervised(process.execPath, [
    '-e',
    `require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)`,
    shutdownPidFile,
  ], { timeout: 30_000, telemetryKey: telemetryKeys.shutdown })
  while (supervisedProcessHealth().active !== 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const shutdownPid = await waitForPidFile(shutdownPidFile)
  const shutdownResult = await shutdownSupervisedProcesses(3_000)
  const shutdownError = await activePromise.then(() => null, (error) => error)
  assert((shutdownError as { code?: string })?.code === 'SUPERVISED_PROCESS_ABORTED', 'shutdown error contract mismatch')
  assert(shutdownResult.terminated === 1 && shutdownResult.remaining === 0, 'shutdown did not drain registry')
  await waitForProcessesGone([shutdownPid])

  let rejectedAfterShutdown: unknown
  try { await execFileSupervised(process.execPath, ['-e', ''], { timeout: 1_000 }) } catch (error) { rejectedAfterShutdown = error }
  assert(
    (rejectedAfterShutdown as { code?: string })?.code === 'SUPERVISED_PROCESS_SHUTTING_DOWN',
    'new process was accepted after shutdown',
  )

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'successful-command',
      'timeout-contract',
      'process-group-termination',
      'shutdown-drain',
      'post-shutdown-rejection',
    ],
  }))
} finally {
  await rm(directory, { recursive: true, force: true })
  const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
  const prefixes = Object.values(telemetryKeys)
    .map((key) => `execution=${supervisedProcessTelemetryExecutionKey(key)};%`)
  await pool.query(
    `DELETE FROM ${auditTable} WHERE module=? AND (${prefixes.map(() => 'target LIKE ?').join(' OR ')})`,
    [supervisedProcessTelemetryModule, ...prefixes],
  ).catch(() => undefined)
  await pool.end()
}
