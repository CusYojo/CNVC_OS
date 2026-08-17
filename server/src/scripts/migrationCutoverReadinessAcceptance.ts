import { execFile, spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

const execFileAsync = promisify(execFile)
const reportPath = path.resolve('.runtime/migration-evidence/cutover-readiness/report.json')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[cutover readiness acceptance] ${message}`)
}

function table(name: string) {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

async function authoritativeCounts() {
  const names = ['users', 'migration_runs'] as const
  return Object.fromEntries(await Promise.all(names.map(async (name) => {
    const [rows] = await pool.query<Array<RowDataPacket & { count: number | string }>>(`SELECT COUNT(*) AS count FROM ${table(name)}`)
    return [name, Number(rows[0]?.count ?? 0)]
  })))
}

async function listenerPids() {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP:3100', '-sTCP:LISTEN', '-t'])
    return [...new Set(stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))].sort()
  } catch {
    return []
  }
}

function runStrict() {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--env-file-if-exists=.env', '--import', 'tsx',
      'server/src/scripts/migrationCutoverReadiness.ts', '--strict',
    ], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'ignore', 'ignore'] })
    child.once('error', reject)
    child.once('exit', resolve)
  })
}

try {
  const [beforeCounts, beforePids] = await Promise.all([authoritativeCounts(), listenerPids()])
  const exitCode = await runStrict()
  assert(exitCode === 0 || exitCode === 2, `strict command returned unexpected exit ${String(exitCode)}`)
  const [raw, metadata, afterCounts, afterPids] = await Promise.all([
    readFile(reportPath, 'utf8'), stat(reportPath), authoritativeCounts(), listenerPids(),
  ])
  const report = JSON.parse(raw) as {
    ready?: boolean
    mode?: string
    dimensions?: Record<string, unknown>
    counts?: Record<string, unknown>
    blockers?: Array<{ code?: unknown; category?: unknown; count?: unknown }>
    pathsExcluded?: boolean
    fileNamesExcluded?: boolean
    identitiesExcluded?: boolean
    businessContentExcluded?: boolean
    secretsExcluded?: boolean
    databaseSessionsReadOnly?: boolean
    databaseWrites?: number
    processMutation?: boolean
  }
  const blockers = report.blockers ?? []
  const blockerByCode = new Map(blockers.map((item) => [item.code, item]))
  const deferredProductionBlockers = Number(report.counts?.deferredProductionBlockers ?? 0)
  const unapprovedAcceptanceExceptions = Number(report.counts?.unapprovedAcceptanceExceptions ?? 0)
  const pendingProductionSmoke = Number(report.counts?.pendingProductionSmoke ?? 0)
  const pendingFinalConfirmations = Number(report.counts?.pendingFinalConfirmations ?? 0)
  const dimensionValues = Object.values(report.dimensions ?? {})
  const expectedReady = dimensionValues.every((value) => value === true) && blockers.length === 0
  assert(report.mode === 'read-only', 'report mode is not read-only')
  assert(report.ready === expectedReady, 'ready result is inconsistent with dimensions/blockers')
  assert((report.ready && exitCode === 0) || (!report.ready && exitCode === 2), 'strict exit code is inconsistent with readiness')
  assert(new Set(blockers.map((item) => item.code)).size === blockers.length, 'blocker codes are not unique')
  assert(blockers.every((item) => typeof item.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(item.code)
    && typeof item.category === 'string' && Number(item.count) > 0), 'blockers do not use stable aggregate codes/counts')
  assert(deferredProductionBlockers === 0
    ? !blockerByCode.has('DEFERRED_PRODUCTION_BLOCKERS_REMAIN')
    : Number(blockerByCode.get('DEFERRED_PRODUCTION_BLOCKERS_REMAIN')?.count) === deferredProductionBlockers,
  'deferred production blockers are not represented exactly')
  assert(unapprovedAcceptanceExceptions === 0
    ? !blockerByCode.has('UNAPPROVED_ACCEPTANCE_EXCEPTIONS_REMAIN')
    : Number(blockerByCode.get('UNAPPROVED_ACCEPTANCE_EXCEPTIONS_REMAIN')?.count) === unapprovedAcceptanceExceptions,
  'unapproved acceptance exceptions are not represented exactly')
  assert(pendingProductionSmoke === 0
    ? !blockerByCode.has('PRODUCTION_SMOKE_ITEMS_PENDING')
    : Number(blockerByCode.get('PRODUCTION_SMOKE_ITEMS_PENDING')?.count) === pendingProductionSmoke,
  'pending production smoke items are not represented exactly')
  assert(pendingFinalConfirmations === 0
    ? !blockerByCode.has('FINAL_ACCEPTANCE_CONFIRMATIONS_PENDING')
    : Number(blockerByCode.get('FINAL_ACCEPTANCE_CONFIRMATIONS_PENDING')?.count) === pendingFinalConfirmations,
  'pending final acceptance confirmations are not represented exactly')
  assert(report.pathsExcluded && report.fileNamesExcluded && report.identitiesExcluded
    && report.businessContentExcluded && report.secretsExcluded, 'sensitive evidence exclusions are incomplete')
  assert(report.databaseSessionsReadOnly === true && report.databaseWrites === 0 && report.processMutation === false,
    'report does not declare a read-only zero-mutation boundary')
  assert((metadata.mode & 0o077) === 0, 'readiness report is not owner-only')
  assert(!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(raw), 'readiness report contains an email identity')
  assert(!/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/.test(raw), 'readiness report contains a bcrypt hash')
  assert(!/(?:\/Users\/|\/home\/|\/www\/|[A-Za-z]:\\)/.test(raw), 'readiness report contains an absolute path')
  assert(JSON.stringify(beforeCounts) === JSON.stringify(afterCounts), 'readiness preflight changed authoritative MySQL counts')
  assert(JSON.stringify(beforePids) === JSON.stringify(afterPids), 'readiness preflight changed the 3100 listener process set')
  console.log(JSON.stringify({
    ok: true,
    ready: report.ready,
    blockerCount: blockers.length,
    checks: [
      'strict-exit-matches-readiness',
      'dimensions-and-blockers-consistent',
      'stable-aggregate-blocker-codes',
      'deferred-production-blockers-fail-closed',
      'unapproved-acceptance-exceptions-fail-closed',
      'pending-production-smoke-fails-closed',
      'pending-final-confirmations-fail-closed',
      'owner-only-sensitive-detail-free-report',
      'authoritative-mysql-counts-unchanged',
      'single-service-listener-set-unchanged',
    ],
    databaseWrites: 0,
    processMutation: false,
  }))
} finally {
  await pool.end()
}
