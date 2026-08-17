import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { RowDataPacket } from 'mysql2'
import { db, pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { migrationRuns } from '../db/schema.js'
import {
  formatShanghaiDateKey,
  formatShanghaiDateTimeInput,
  parseShanghaiDateTime,
} from '../utils/shanghaiTime.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const knownInstant = new Date('2026-08-09T16:30:45.678Z')

async function main() {
  const runId = randomUUID()
  const defaultRunId = randomUUID()
  try {
    await db.insert(migrationRuns).values({
      id: runId,
      migrationType: 'timezone-acceptance',
      sourceLocator: 'isolated-fixture',
      sourceSha256: '0'.repeat(64),
      mode: 'acceptance',
      status: 'succeeded',
      sourceCounts: {},
      targetCounts: {},
      report: { expectedUtc: knownInstant.toISOString() },
      startedAt: knownInstant,
      completedAt: knownInstant,
    })
    const beforeDefaultInsert = Date.now()
    await db.insert(migrationRuns).values({
      id: defaultRunId,
      migrationType: 'timezone-default-acceptance',
      sourceLocator: 'isolated-fixture',
      sourceSha256: '0'.repeat(64),
      mode: 'acceptance',
      status: 'succeeded',
      sourceCounts: {},
      targetCounts: {},
      report: {},
    })
    const afterDefaultInsert = Date.now()

    const table = quoteMysqlIdentifier(mysqlTableName('migration_runs'))
    const [rawRows] = await pool.query<Array<RowDataPacket & {
      sessionTimeZone: string
      storedLocal: string
    }>>(`SELECT @@session.time_zone AS sessionTimeZone,
      DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s.%f') AS storedLocal
      FROM ${table} WHERE id=?`, [runId])
    const [roundTrip] = await db.select({ startedAt: migrationRuns.startedAt })
      .from(migrationRuns).where(eq(migrationRuns.id, runId)).limit(1)
    const [defaultRoundTrip] = await db.select({ startedAt: migrationRuns.startedAt })
      .from(migrationRuns).where(eq(migrationRuns.id, defaultRunId)).limit(1)

    assert(rawRows[0]?.sessionTimeZone === '+08:00', 'application MySQL session timezone is not +08:00')
    assert(rawRows[0]?.storedLocal === '2026-08-10 00:30:45.678000', 'DATETIME did not store the Shanghai wall-clock value')
    assert(roundTrip?.startedAt instanceof Date, 'Drizzle did not return a Date')
    assert(roundTrip.startedAt.toISOString() === knownInstant.toISOString(), 'MySQL Date round-trip changed the UTC instant')
    assert(JSON.stringify({ startedAt: roundTrip.startedAt }).includes(knownInstant.toISOString()), 'API JSON serialization is not UTC ISO-8601')
    assert(formatShanghaiDateKey(roundTrip.startedAt) === '2026-08-10', 'server business date is not Asia/Shanghai')
    assert(formatShanghaiDateTimeInput(roundTrip.startedAt) === '2026-08-10 00:30', 'server form time is not Asia/Shanghai')
    assert(parseShanghaiDateTime('2026-08-10 00:30').toISOString() === '2026-08-09T16:30:00.000Z', 'Shanghai input did not convert to UTC correctly')
    assert(
      defaultRoundTrip?.startedAt.getTime() >= beforeDefaultInsert - 1_000
        && defaultRoundTrip.startedAt.getTime() <= afterDefaultInsert + 1_000,
      'CURRENT_TIMESTAMP default did not map from Shanghai wall-clock to the current UTC instant',
    )

    console.log(JSON.stringify({
      ok: true,
      sessionTimeZone: rawRows[0].sessionTimeZone,
      checks: [
        'application-mysql-session-timezone-plus-eight',
        'datetime-stores-shanghai-wall-clock-with-milliseconds',
        'mysql-driver-round-trip-preserves-utc-instant',
        'api-json-serializes-utc-iso-8601',
        'server-and-client-contract-use-asia-shanghai',
        'shanghai-form-input-converts-to-utc-instant',
        'mysql-current-timestamp-default-maps-to-current-utc-instant',
      ],
    }))
  } finally {
    await db.delete(migrationRuns).where(eq(migrationRuns.id, runId))
    await db.delete(migrationRuns).where(eq(migrationRuns.id, defaultRunId))
    await pool.end()
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
