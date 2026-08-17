import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { operationalTelemetryRepository } from '../repositories/mysql/mysqlOperationalTelemetryRepository.js'

type StatusRow = RowDataPacket & { Variable_name: string; Value: string | number }

const checks: string[] = []
function assert(condition: unknown, check: string): asserts condition {
  if (!condition) throw new Error(check)
  checks.push(check)
}

async function main() {
  const snapshot = (await operationalTelemetryRepository.snapshot()).mysqlServer
  const [rows] = await pool.query<StatusRow[]>(`SHOW GLOBAL STATUS WHERE Variable_name IN (
    'Threads_connected','Threads_running','Max_used_connections','Slow_queries',
    'Innodb_row_lock_current_waits','Innodb_row_lock_waits','Innodb_row_lock_time','Innodb_deadlocks'
  )`)
  const observed = new Map(rows.map((row) => [String(row.Variable_name), Number(row.Value)]))
  const required = [
    'Threads_connected', 'Threads_running', 'Max_used_connections', 'Slow_queries',
    'Innodb_row_lock_current_waits', 'Innodb_row_lock_waits', 'Innodb_row_lock_time',
  ]
  assert(required.every((name) => observed.has(name)), 'runtime-account-can-read-required-global-status')
  assert(snapshot.statusObservationAvailable, 'repository-reports-global-status-observation-available')
  assert(
    [
      snapshot.threadsConnected, snapshot.threadsRunning, snapshot.maxUsedConnections,
      snapshot.slowQueriesTotal, snapshot.currentRowLockWaits, snapshot.rowLockWaitsTotal,
      snapshot.rowLockTimeMsTotal, snapshot.deadlocksTotal, snapshot.replicationLagSeconds,
    ].every((value) => Number.isFinite(value) && value >= 0),
    'server-status-values-are-finite-and-non-negative',
  )
  assert(snapshot.slowQueriesTotal <= Number(observed.get('Slow_queries')), 'slow-query-counter-is-live-and-monotonic')
  assert(snapshot.rowLockWaitsTotal <= Number(observed.get('Innodb_row_lock_waits')), 'row-lock-wait-counter-is-live-and-monotonic')
  assert(snapshot.rowLockTimeMsTotal <= Number(observed.get('Innodb_row_lock_time')), 'row-lock-time-counter-is-live-and-monotonic')
  assert(
    snapshot.deadlockObservationAvailable === observed.has('Innodb_deadlocks'),
    'deadlock-observation-availability-is-not-reported-as-zero',
  )

  let replicaQueryAvailable = false
  let replicaConfigured = false
  try {
    const [replicaRows] = await pool.query<RowDataPacket[]>('SHOW REPLICA STATUS')
    replicaQueryAvailable = true
    replicaConfigured = replicaRows.length > 0
  } catch {
    replicaQueryAvailable = false
  }
  assert(
    snapshot.replicationObservationAvailable === replicaQueryAvailable,
    'replication-observation-availability-matches-runtime-authority',
  )
  assert(
    !replicaQueryAvailable || snapshot.replicaConfigured === replicaConfigured,
    'replica-configuration-is-reported-only-when-observable',
  )

  const serialized = JSON.stringify(snapshot)
  assert(
    !/(host|hostname|database|username|password|source_host|source_user)/i.test(serialized),
    'server-telemetry-excludes-connection-and-replication-identities',
  )
  for (const name of ['DB_HOST', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD']) {
    const secret = process.env[name]
    if (secret && secret.length >= 3) {
      assert(!serialized.includes(secret), `configured-${name.toLowerCase()}-is-excluded`)
    }
  }

  const result = {
    ok: true,
    checks,
    statusObservationAvailable: snapshot.statusObservationAvailable,
    deadlockObservationAvailable: snapshot.deadlockObservationAvailable,
    replicationObservationAvailable: snapshot.replicationObservationAvailable,
    replicaConfigured: snapshot.replicaConfigured,
    currentRowLockWaits: snapshot.currentRowLockWaits,
    connectionAndReplicationIdentitiesExcluded: true,
  }
  const evidenceRoot = path.resolve('.runtime/migration-evidence/mysql-server-telemetry')
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
  await chmod(evidenceRoot, 0o700)
  const reportPath = path.join(evidenceRoot, 'report.json')
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  await chmod(reportPath, 0o600)
  console.log(JSON.stringify(result))
  await pool.end()
}

main().catch(async (error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  await pool.end().catch(() => undefined)
  process.exitCode = 1
})
