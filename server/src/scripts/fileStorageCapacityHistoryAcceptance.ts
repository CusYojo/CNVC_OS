import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { operationalTelemetryRepository } from '../repositories/mysql/mysqlOperationalTelemetryRepository.js'
import { httpTelemetrySnapshot } from '../runtime/httpTelemetry.js'
import {
  fileStorageCapacityHistory,
  fileStorageCapacityModule,
  fileStorageCapacitySeriesHash,
  fileStorageCapacitySnapshotAction,
  recordFileStorageCapacitySnapshot,
  resetFileStorageCapacityHealthCacheForAcceptance,
} from '../services/fileStorageCapacityTelemetryService.js'
import { evaluateOperationalAlerts } from '../services/operationalTelemetryService.js'

type AuditRow = RowDataPacket & {
  user_id: string | null
  user_name: string
  target: string
  created_at: Date | string
}

const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
const checks: string[] = []
function assert(condition: unknown, check: string): asserts condition {
  if (!condition) throw new Error(check)
  checks.push(check)
}

async function main() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'sbl-file-capacity-'))
  const envNames = ['PROJECT_FILE_ROOT', 'AI_ARTIFACT_ROOT', 'AGENT_WORKSPACE', 'GENERATED_DIR'] as const
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
  let series = ''
  try {
    for (const [index, name] of envNames.entries()) {
      const root = path.join(temporaryRoot, `root-${index}`)
      await mkdir(root, { recursive: true, mode: 0o700 })
      process.env[name] = root
    }
    resetFileStorageCapacityHealthCacheForAcceptance()
    series = fileStorageCapacitySeriesHash()
    const now = new Date()
    const baselineAt = new Date(now.getTime() - 25 * 60 * 60_000)
    const baseline = {
      accessibleRoots: 4,
      missingRequired: 0,
      minimumFreeBytes: 20 * 1024 ** 3,
      maximumUsedRatio: 0.4,
    }
    const current = {
      accessibleRoots: 4,
      missingRequired: 0,
      minimumFreeBytes: 19 * 1024 ** 3,
      maximumUsedRatio: 0.5,
    }
    const baselineRecord = await recordFileStorageCapacitySnapshot({ now: baselineAt, observedCapacity: baseline })
    assert(baselineRecord.recorded, 'historical-capacity-snapshot-is-recorded')
    const history = await fileStorageCapacityHistory(now.getTime(), current)
    assert(history.historyObservationAvailable, 'capacity-history-is-readable-through-runtime-account')
    assert(history.baselineAvailable && history.baselineAgeHours >= 24, 'cross-day-capacity-baseline-is-selected')
    assert(history.freeBytesDecline24h === 1024 ** 3, 'cross-day-free-byte-decline-is-exact')
    assert(Math.abs(history.usedRatioIncrease24h - 0.1) < 1e-9, 'cross-day-used-ratio-increase-is-exact')

    const database = await operationalTelemetryRepository.snapshot()
    const alerts = evaluateOperationalAlerts({
      http: httpTelemetrySnapshot(),
      database,
      components: [{ kind: 'file-storage-capacity', ...current, ...history }],
    })
    assert(
      alerts.some((alert) => alert.code === 'FILE_STORAGE_USED_RATIO_GROWTH_24H'),
      'cross-day-used-ratio-growth-alert-is-emitted',
    )

    const currentRecord = await recordFileStorageCapacitySnapshot({ now, observedCapacity: current })
    const duplicateRecord = await recordFileStorageCapacitySnapshot({ now, observedCapacity: current })
    assert(currentRecord.recorded && !duplicateRecord.recorded, 'hourly-capacity-snapshot-is-idempotent')

    const [rows] = await pool.query<AuditRow[]>(
      `SELECT user_id,user_name,target,created_at FROM ${auditTable}
       WHERE module=? AND action=? AND result='success' AND JSON_VALID(target)
         AND JSON_UNQUOTE(JSON_EXTRACT(target,'$.series'))=?
       ORDER BY created_at`,
      [fileStorageCapacityModule, fileStorageCapacitySnapshotAction, series],
    )
    assert(rows.length === 2, 'exactly-two-cross-day-snapshots-are-persisted')
    assert(rows.every((row) => row.user_id === null && row.user_name === '（系统）'), 'capacity-snapshots-use-null-system-actor')
    const targets = rows.map((row) => JSON.parse(row.target) as Record<string, unknown>)
    const allowedKeys = [
      'accessibleRoots', 'bucket', 'maximumUsedRatio', 'minimumFreeBytes',
      'missingRequired', 'pathsExcluded', 'schema', 'series',
    ].sort().join(',')
    assert(
      targets.every((target) => Object.keys(target).sort().join(',') === allowedKeys),
      'capacity-snapshot-target-has-fixed-safe-field-allowlist',
    )
    const serializedTargets = JSON.stringify(targets)
    assert(
      envNames.every((name) => !serializedTargets.includes(String(process.env[name]))),
      'capacity-snapshot-targets-exclude-root-paths',
    )
    assert(targets.every((target) => target.pathsExcluded === true), 'capacity-snapshots-declare-path-exclusion')

    await pool.query(
      `DELETE FROM ${auditTable} WHERE module=? AND action=? AND JSON_VALID(target)
         AND JSON_UNQUOTE(JSON_EXTRACT(target,'$.series'))=?`,
      [fileStorageCapacityModule, fileStorageCapacitySnapshotAction, series],
    )
    const [residueRows] = await pool.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) AS count FROM ${auditTable} WHERE module=? AND action=? AND JSON_VALID(target)
         AND JSON_UNQUOTE(JSON_EXTRACT(target,'$.series'))=?`,
      [fileStorageCapacityModule, fileStorageCapacitySnapshotAction, series],
    )
    assert(Number(residueRows[0]?.count || 0) === 0, 'capacity-history-fixture-residue-is-zero')

    const result = {
      ok: true,
      checks,
      baselineAgeHours: history.baselineAgeHours,
      freeBytesDecline24h: history.freeBytesDecline24h,
      usedRatioIncrease24h: history.usedRatioIncrease24h,
      persistedSnapshots: rows.length,
      fixtureResidue: 0,
      pathsExcluded: true,
    }
    const evidenceRoot = path.resolve('.runtime/migration-evidence/file-storage-capacity-history')
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
    await chmod(evidenceRoot, 0o700)
    const reportPath = path.join(evidenceRoot, 'report.json')
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
    await chmod(reportPath, 0o600)
    const written = JSON.parse(await readFile(reportPath, 'utf8')) as typeof result
    assert(written.pathsExcluded && written.fixtureResidue === 0, 'owner-only-capacity-history-evidence-is-readable')
    console.log(JSON.stringify({ ...result, checks }))
  } finally {
    if (series) {
      await pool.query(
        `DELETE FROM ${auditTable} WHERE module=? AND action=? AND JSON_VALID(target)
           AND JSON_UNQUOTE(JSON_EXTRACT(target,'$.series'))=?`,
        [fileStorageCapacityModule, fileStorageCapacitySnapshotAction, series],
      ).catch(() => undefined)
    }
    for (const name of envNames) {
      const value = previous[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    resetFileStorageCapacityHealthCacheForAcceptance()
    await rm(temporaryRoot, { recursive: true, force: true })
    await pool.end().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
