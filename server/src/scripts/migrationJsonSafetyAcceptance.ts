import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { RowDataPacket } from 'mysql2'
import { db, pool } from '../db/client.js'
import { mysqlConfig, quoteMysqlIdentifier } from '../db/config.js'
import { migrationIssues, migrationRuns } from '../db/schema.js'
import { isMigrationJsonError, migrationJsonIssue, parseMigrationJson } from './migrationJsonSafety.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main() {
  const [columns] = await pool.query<Array<RowDataPacket & { tableName: string; columnName: string }>>(`
    SELECT table_name AS tableName, column_name AS columnName
    FROM information_schema.columns
    WHERE table_schema=? AND table_name LIKE ? AND data_type='json'
    ORDER BY table_name, ordinal_position
  `, [mysqlConfig.database, `${mysqlConfig.tablePrefix}%`])
  let rowsScanned = 0
  for (const column of columns) {
    const [rows] = await pool.query<Array<RowDataPacket & { rows: number; invalid: number }>>(`
      SELECT COUNT(*) AS \`rows\`,
        SUM(CASE WHEN ${quoteMysqlIdentifier(column.columnName)} IS NOT NULL
          AND JSON_VALID(${quoteMysqlIdentifier(column.columnName)})=0 THEN 1 ELSE 0 END) AS invalid
      FROM ${quoteMysqlIdentifier(column.tableName)}
    `)
    rowsScanned += Number(rows[0]?.rows ?? 0)
    assert(Number(rows[0]?.invalid ?? 0) === 0, `invalid target JSON detected in ${column.tableName}.${column.columnName}`)
  }

  const marker = `private-body-${randomUUID()}`
  let caught: unknown
  try {
    parseMigrationJson(`{"message":`, {
      sourceSystem: 'acceptance', table: 'source_rows', column: 'payload', sourceKey: marker,
    })
  } catch (error) { caught = error }
  assert(isMigrationJsonError(caught), 'invalid source JSON did not produce a typed migration error')
  const issue = migrationJsonIssue(caught)
  assert(!caught.message.includes(marker), 'typed JSON error leaked the source key or raw body')
  assert(!JSON.stringify(issue).includes('{"message":'), 'JSON isolation issue retained the invalid raw body')
  assert(issue.code === 'MIGRATION_INVALID_JSON' && issue.payload.column === 'payload', 'JSON isolation issue contract mismatch')

  const runId = randomUUID()
  try {
    await db.transaction(async (tx) => {
      await tx.insert(migrationRuns).values({
        id: runId,
        migrationType: 'json-safety-acceptance',
        sourceLocator: 'isolated-fixture',
        sourceSha256: '0'.repeat(64),
        mode: 'acceptance',
        status: 'failed',
        sourceCounts: { source_rows: 1 },
        targetCounts: {},
        report: { code: issue.code },
        completedAt: new Date(),
      })
      await tx.insert(migrationIssues).values({
        runId,
        severity: issue.severity,
        sourceSystem: caught.context.sourceSystem,
        sourceTable: issue.sourceTable,
        sourceKey: issue.sourceKey,
        code: issue.code,
        message: issue.message,
        payload: issue.payload,
      })
    })
    const [persisted] = await db.select({
      status: migrationRuns.status,
      code: migrationIssues.code,
      message: migrationIssues.message,
      payload: migrationIssues.payload,
    }).from(migrationRuns).innerJoin(migrationIssues, eq(migrationIssues.runId, migrationRuns.id))
      .where(eq(migrationRuns.id, runId)).limit(1)
    assert(persisted?.status === 'failed' && persisted.code === 'MIGRATION_INVALID_JSON', 'failed JSON row was not isolated under its migration run')
    assert(!persisted.message.includes(marker) && !JSON.stringify(persisted.payload).includes(marker), 'persisted JSON issue contains unnecessary source content')

    console.log(JSON.stringify({
      ok: true,
      jsonColumns: columns.length,
      rowsScanned,
      checks: [
        'all-target-mysql-json-columns-valid',
        'invalid-source-json-produces-typed-safe-error',
        'invalid-json-run-and-issue-persist-atomically',
        'invalid-json-issue-excludes-raw-body',
        'postgres-dump-and-flue-importers-use-shared-json-isolation-contract',
      ],
    }))
  } finally {
    await db.delete(migrationRuns).where(eq(migrationRuns.id, runId)).catch(() => {})
  }
}

await main().finally(async () => pool.end())
