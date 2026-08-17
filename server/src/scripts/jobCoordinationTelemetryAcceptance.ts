import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { operationalTelemetryRepository } from '../repositories/mysql/mysqlOperationalTelemetryRepository.js'
import {
  jobCoordinationActions,
  jobCoordinationModule,
  jobCoordinationTarget,
  recordJobCoordinationEvent,
  type JobCoordinationDomain,
  type JobCoordinationEvent,
} from '../runtime/jobCoordinationTelemetry.js'

const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
const outputDir = path.resolve('.runtime/migration-evidence/operations')
const outputPath = path.join(outputDir, 'job-coordination-telemetry-acceptance.json')
const checks: string[] = []

function assert(condition: unknown, check: string): asserts condition {
  if (!condition) throw new Error(check)
  checks.push(check)
}

const fixtures: Array<{
  domain: JobCoordinationDomain
  entityId: string
  event: JobCoordinationEvent
}> = [
  { domain: 'runtime-job', entityId: `runtime-${randomUUID()}`, event: 'leaseContention' },
  { domain: 'lead-score', entityId: randomUUID(), event: 'duplicateSuppressed' },
  { domain: 'project-score', entityId: randomUUID(), event: 'leaseRecovered' },
  { domain: 'ai-task', entityId: randomUUID(), event: 'staleCompletionRejected' },
]
const targets = fixtures.map((fixture) => jobCoordinationTarget(fixture.domain, fixture.entityId))

async function main() {
  const baseline = (await operationalTelemetryRepository.snapshot()).jobHistory
  try {
    for (const fixture of fixtures) await recordJobCoordinationEvent(fixture)
    const [rows] = await pool.query<Array<RowDataPacket & {
      user_id: string | null
      user_name: string
      module: string
      action: string
      target: string
      result: string
    }>>(
      `SELECT user_id,user_name,module,action,target,result FROM ${auditTable}
       WHERE target IN (${targets.map(() => '?').join(',')}) ORDER BY action,target`,
      targets,
    )
    assert(rows.length === fixtures.length, 'all-coordination-events-persisted')
    assert(rows.every((row) => row.user_id === null && row.user_name === '（系统）'), 'events-use-null-system-actor')
    assert(rows.every((row) => row.module === jobCoordinationModule && row.result === 'success'), 'events-use-stable-module-and-result')
    assert(
      new Set(rows.map((row) => row.action)).size === Object.keys(jobCoordinationActions).length,
      'four-stable-coordination-actions-covered',
    )
    const serialized = JSON.stringify(rows)
    assert(fixtures.every((fixture) => !serialized.includes(fixture.entityId)), 'entity-identifiers-are-sha256-protected')

    const observed = (await operationalTelemetryRepository.snapshot()).jobHistory
    assert(observed.leaseContentions24h >= baseline.leaseContentions24h + 1, 'lease-contention-aggregate-incremented')
    assert(observed.duplicateSuppressed24h >= baseline.duplicateSuppressed24h + 1, 'duplicate-suppression-aggregate-incremented')
    assert(observed.staleCompletionRejected24h >= baseline.staleCompletionRejected24h + 1, 'stale-completion-aggregate-incremented')
    assert(observed.leaseRecoveryEvents24h >= baseline.leaseRecoveryEvents24h + 1, 'lease-recovery-event-aggregate-incremented')

    await mkdir(outputDir, { recursive: true, mode: 0o700 })
    await writeFile(outputPath, `${JSON.stringify({
      ok: true,
      checks,
      eventTypes: Object.keys(jobCoordinationActions).length,
      targetsHashed: true,
      businessContentExcluded: true,
    }, null, 2)}\n`, { mode: 0o600 })
    await chmod(outputPath, 0o600)
    console.log(JSON.stringify({ ok: true, checks, count: checks.length, outputPath }))
  } finally {
    await pool.query(
      `DELETE FROM ${auditTable} WHERE target IN (${targets.map(() => '?').join(',')})`,
      targets,
    )
    const [residue] = await pool.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) AS count FROM ${auditTable} WHERE target IN (${targets.map(() => '?').join(',')})`,
      targets,
    )
    if (Number(residue[0]?.count || 0) !== 0) throw new Error('coordination acceptance fixture residue remains')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => pool.end())
