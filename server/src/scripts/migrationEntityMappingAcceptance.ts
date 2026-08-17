import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function table(base: string): string {
  return quoteMysqlIdentifier(mysqlTableName(base))
}

function objectNumbers(value: unknown): Record<string, number> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'migration source counts are invalid')
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, count]) => {
    assert(/^[A-Za-z0-9_]+$/.test(key), 'migration source table name is unsafe')
    assert(Number.isInteger(Number(count)) && Number(count) >= 0, `migration source count is invalid: ${key}`)
    return [key, Number(count)]
  }))
}

async function main() {
  const [runRows] = await pool.query<Array<RowDataPacket & { id: string; sourceCounts: unknown }>>(`
    SELECT id,source_counts AS sourceCounts
    FROM ${table('migration_runs')}
    WHERE migration_type='postgres-dump-baseline-reconciliation' AND status='succeeded'
    ORDER BY completed_at DESC LIMIT 1
  `)
  const run = runRows[0]
  assert(run, 'successful PostgreSQL dump reconciliation run is missing')
  const sourceCounts = objectNumbers(run.sourceCounts)
  const expectedTotal = Object.values(sourceCounts).reduce((sum, count) => sum + count, 0)

  const [mappingGroups] = await pool.query<Array<RowDataPacket & {
    sourceTable: string
    rows: number
    distinctSourceIds: number
    invalidChecksums: number
    invalidTargets: number
    invalidKinds: number
    wrongRun: number
  }>>(`
    SELECT source_table AS sourceTable,COUNT(*) AS \`rows\`,COUNT(DISTINCT source_id) AS distinctSourceIds,
      SUM(source_checksum NOT REGEXP '^[0-9a-f]{64}$') AS invalidChecksums,
      SUM(target_table<>source_table OR target_id<>source_id) AS invalidTargets,
      SUM(mapping_kind<>'preserved') AS invalidKinds,
      SUM(run_id<>?) AS wrongRun
    FROM ${table('migration_entity_mappings')}
    WHERE source_system='postgres_dump'
    GROUP BY source_table ORDER BY source_table
  `, [run.id])
  const actualCounts = Object.fromEntries(mappingGroups.map((row) => [String(row.sourceTable), Number(row.rows)]))
  assert(
    Object.entries(sourceCounts).every(([sourceTable, count]) => (actualCounts[sourceTable] ?? 0) === count)
      && Object.keys(actualCounts).every((sourceTable) => sourceTable in sourceCounts),
    'PostgreSQL entity mapping counts do not match the locked source counts',
  )

  let targetRowsChecked = 0
  for (const group of mappingGroups) {
    const sourceTable = String(group.sourceTable)
    assert(Number(group.rows) === Number(group.distinctSourceIds), `duplicate source entity mapping detected: ${sourceTable}`)
    assert(Number(group.invalidChecksums) === 0, `invalid source checksum detected: ${sourceTable}`)
    assert(Number(group.invalidTargets) === 0, `preserved PostgreSQL id mapping changed target identity: ${sourceTable}`)
    assert(Number(group.invalidKinds) === 0, `invalid PostgreSQL mapping kind: ${sourceTable}`)
    assert(Number(group.wrongRun) === 0, `PostgreSQL mapping is not linked to the locked reconciliation run: ${sourceTable}`)
    const [missingRows] = await pool.query<Array<RowDataPacket & { missing: number }>>(`
      SELECT COUNT(*) AS missing
      FROM ${table('migration_entity_mappings')} m
      LEFT JOIN ${quoteMysqlIdentifier(mysqlTableName(sourceTable))} t
        ON CONVERT(t.id USING utf8mb4) COLLATE utf8mb4_0900_ai_ci=m.target_id COLLATE utf8mb4_0900_ai_ci
      WHERE m.source_system='postgres_dump' AND m.source_table=? AND t.id IS NULL
    `, [sourceTable])
    assert(Number(missingRows[0]?.missing) === 0, `entity mapping target is missing: ${sourceTable}`)
    targetRowsChecked += Number(group.rows)
  }
  assert(targetRowsChecked === expectedTotal, 'not every PostgreSQL source entity has a target mapping')

  const [flueRows] = await pool.query<Array<RowDataPacket & {
    genericConversations: number
    specificConversations: number
    genericMessages: number
    specificMessages: number
  }>>(`
    SELECT
      (SELECT COUNT(*) FROM ${table('migration_entity_mappings')} WHERE source_system='flue' AND source_table='flue_conversation_streams') AS genericConversations,
      (SELECT COUNT(*) FROM ${table('agent_conversation_source_mappings')} WHERE source_system='flue') AS specificConversations,
      (SELECT COUNT(*) FROM ${table('migration_entity_mappings')} WHERE source_system='flue' AND source_table='flue_conversation_stream_batches') AS genericMessages,
      (SELECT COUNT(*) FROM ${table('agent_message_source_mappings')} WHERE source_system='flue') AS specificMessages
  `)
  const flue = flueRows[0]
  assert(Number(flue.genericConversations) === Number(flue.specificConversations), 'Flue conversation mappings are incomplete')
  assert(Number(flue.genericMessages) === Number(flue.specificMessages), 'Flue message mappings are incomplete')

  console.log(JSON.stringify({
    ok: true,
    postgresTables: mappingGroups.length,
    postgresEntities: expectedTotal,
    targetRowsChecked,
    flueConversations: Number(flue.genericConversations),
    flueMessages: Number(flue.genericMessages),
    checks: [
      'locked-source-counts-equal-entity-mapping-counts',
      'every-source-entity-has-one-stable-target-id',
      'preserved-uuid-and-integer-identities-are-explicit',
      'mapping-source-checksums-and-run-linkage-valid',
      'every-mapped-target-row-exists',
      'flue-generic-and-specialized-mappings-agree',
    ],
  }))
  await pool.end()
}

main().catch(async (error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  await pool.end().catch(() => undefined)
  process.exitCode = 1
})
