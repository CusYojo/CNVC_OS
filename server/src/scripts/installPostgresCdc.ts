import { createHash } from 'node:crypto'
import pg from 'pg'
import {
  POSTGRES_CDC_CAPTURE_VERSION,
  POSTGRES_CDC_TABLES,
  assertSafePostgresName,
  postgresCdcBaseSql,
  postgresCdcContractSha256,
  postgresCdcTriggerSql,
  quotePostgresName,
} from './postgresCdcContract.js'

const apply = process.argv.includes('--apply')
const schema = process.env.PG_CDC_SCHEMA?.trim() || 'sbl_migration'
assertSafePostgresName(schema, 'CDC schema')
const sourceUrl = (() => {
  const value = process.env.DATABASE_URL?.trim()
  if (!value) throw new Error('DATABASE_URL is required for the legacy PostgreSQL source')
  return value
})()

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: sourceUrl, statement_timeout: 60_000, query_timeout: 65_000 })
  await client.connect()
  const contractSha256 = postgresCdcContractSha256(schema)
  const sourceFingerprint = createHash('sha256').update(sourceUrl).digest('hex')
  try {
    const existing = await client.query<{ table_name: string; has_id: boolean }>(`
      SELECT t.table_name,
        EXISTS (
          SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema='public' AND c.table_name=t.table_name AND c.column_name='id'
        ) AS has_id
      FROM information_schema.tables t
      WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND t.table_name = ANY($1::text[])
      ORDER BY t.table_name
    `, [[...POSTGRES_CDC_TABLES]])
    const existingByName = new Map(existing.rows.map((row) => [row.table_name, row.has_id]))
    const missing = POSTGRES_CDC_TABLES.filter((table) => !existingByName.has(table))
    const missingId = POSTGRES_CDC_TABLES.filter((table) => existingByName.get(table) === false)
    if (missing.length || missingId.length) {
      throw new Error(`CDC source contract mismatch: missing tables=${missing.join(',') || 'none'} missing id=${missingId.join(',') || 'none'}`)
    }
    if (apply) {
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock(hashtext('sbl-postgres-cdc-install'))")
      for (const sql of postgresCdcBaseSql(schema)) await client.query(sql)
      for (const table of POSTGRES_CDC_TABLES) {
        for (const sql of postgresCdcTriggerSql(schema, table)) await client.query(sql)
      }
      await client.query(`
        INSERT INTO ${quotePostgresName(schema)}.capture_config
          (singleton,capture_version,contract_sha256,installed_tables,installed_at)
        VALUES (true,$1,$2,$3::jsonb,clock_timestamp())
        ON CONFLICT (singleton) DO UPDATE SET
          capture_version=EXCLUDED.capture_version,
          contract_sha256=EXCLUDED.contract_sha256,
          installed_tables=EXCLUDED.installed_tables,
          installed_at=EXCLUDED.installed_at
      `, [POSTGRES_CDC_CAPTURE_VERSION, contractSha256, JSON.stringify(POSTGRES_CDC_TABLES)])
      await client.query('COMMIT')
    }
    const result = {
      ok: true,
      mode: apply ? 'apply' : 'preview',
      captureVersion: POSTGRES_CDC_CAPTURE_VERSION,
      contractSha256,
      sourceFingerprint,
      schema,
      tables: POSTGRES_CDC_TABLES.length,
      guarantees: [
        'insert-update-delete-row-triggers',
        'foreign-key-cascade-delete-tombstones',
        'actor-and-migration-batch-attribution',
        'global-sequence-with-safe-txid-horizon',
      ],
    }
    console.log(JSON.stringify(result))
  } catch (error) {
    if (apply) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, code: 'POSTGRES_CDC_INSTALL_FAILED', message: (error as Error).message }))
  process.exitCode = 1
})
