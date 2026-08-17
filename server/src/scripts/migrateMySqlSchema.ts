export {}

const migrationUser = process.env.DB_MIGRATION_USERNAME?.trim()
const migrationPassword = process.env.DB_MIGRATION_PASSWORD
if (migrationUser || migrationPassword) {
  if (!migrationUser || !migrationPassword) {
    throw new Error('DB_MIGRATION_USERNAME and DB_MIGRATION_PASSWORD must be provided together')
  }
  process.env.DB_USERNAME = migrationUser
  process.env.DB_PASSWORD = migrationPassword
}

const [{ pool }, { applySchemaMigrations }] = await Promise.all([
  import('../db/client.js'),
  import('../db/migrate.js'),
])

await applySchemaMigrations()
  .then(() => console.log(JSON.stringify({ ok: true, schema: 'mysql' })))
  .finally(() => pool.end())
