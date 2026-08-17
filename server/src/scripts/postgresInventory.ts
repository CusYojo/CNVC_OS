import pg from 'pg'

type SourceColumn = {
  table_name: string
  column_name: string
  data_type: string
  udt_name: string
  is_nullable: 'YES' | 'NO'
}

const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) throw new Error('DATABASE_URL is required for the legacy PostgreSQL inventory')

const client = new pg.Client({
  connectionString: databaseUrl,
  application_name: 'sbl_mysql_migration_inventory',
  statement_timeout: 30_000,
  query_timeout: 35_000,
})

await client.connect()
try {
  await client.query('BEGIN READ ONLY')
  const runtime = await client.query<{ version: string }>(
    "SELECT current_setting('server_version') AS version",
  )
  const tableResult = await client.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `)
  const columnResult = await client.query<SourceColumn>(`
    SELECT table_name, column_name, data_type, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `)

  const tables = []
  for (const { table_name: table } of tableResult.rows) {
    if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error(`unsafe source table name: ${table}`)
    const count = await client.query<{ count: string }>(`SELECT count(*) AS count FROM public."${table}"`)
    tables.push({
      table,
      rows: Number(count.rows[0]?.count ?? 0),
      columns: columnResult.rows
        .filter((column) => column.table_name === table)
        .map((column) => ({
          name: column.column_name,
          type: column.data_type === 'USER-DEFINED' ? column.udt_name : column.data_type,
          nullable: column.is_nullable === 'YES',
        })),
    })
  }

  console.log(JSON.stringify({
    connected: true,
    version: runtime.rows[0]?.version,
    tables,
  }, null, 2))
  await client.query('ROLLBACK')
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined)
  throw error
} finally {
  await client.end()
}
