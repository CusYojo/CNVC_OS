import { ensureSchema } from '../db/migrate.js'
import { pool } from '../db/client.js'
import { ingestRadarDataToMySql } from '../services/radarDataMigrationService.js'

try {
  await ensureSchema()
  const result = await ingestRadarDataToMySql()
  console.log(JSON.stringify(result))
} catch (error) {
  console.error('[radar mysql migration]', error)
  process.exitCode = 1
} finally {
  await pool.end()
}
