import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import { cleanupFdeTables, withAcceptanceCleanup } from './fdeAcceptanceCleanup.js'
import { withFdeAcceptanceSignals } from './fdeAcceptanceSignals.js'
import { assertLeadDuplicateAcceptanceIsolation } from './leadDuplicateAcceptanceGuard.js'
import { buildLeadDuplicateCollisions, LEAD_DUPLICATE_NORMALIZATION, type LeadSnapshot } from './leadDuplicateDispositionContract.js'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

// A random prefix alone does not authorize test writes in the business database.
assertIsolatedMysqlAcceptanceDatabase('leadDuplicateReleaseAcceptance')
assert.equal(process.argv.length, 2, '不接受自定义前缀、脚本或写入目标')
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const sourcePrefix = process.env.DB_FREFIX ?? ''
assert.match(sourcePrefix, /^[A-Za-z0-9_]+$/, '必须提供合法业务表前缀')
assert.ok(!sourcePrefix.startsWith('fde_accept_'), '不能嵌套隔离验收')
const targetPrefix = `fde_accept_${randomBytes(5).toString('hex')}_`
if (process.env.DB_MIGRATION_USERNAME && process.env.DB_MIGRATION_PASSWORD) {
  process.env.DB_USERNAME = process.env.DB_MIGRATION_USERNAME
  process.env.DB_PASSWORD = process.env.DB_MIGRATION_PASSWORD
}
// Import DB modules only after switching the prefix. No business data is copied.
process.env.DB_FREFIX = targetPrefix
process.env.LEAD_ACCEPTANCE_PREFIX = targetPrefix
process.env.LEAD_ACCEPTANCE_SOURCE_PREFIX = sourcePrefix
process.env.DB_MIGRATIONS_DIR = path.join(repositoryRoot, 'server/drizzle')
const { mysqlConfig, mysqlTableName, quoteMysqlIdentifier } = await import('../db/config.js')
assert.equal(mysqlConfig.tablePrefix, targetPrefix)
const connect = () => mysql.createConnection({
  host: mysqlConfig.host, port: mysqlConfig.port, database: mysqlConfig.database,
  user: mysqlConfig.user, password: mysqlConfig.password,
  charset: 'utf8mb4_0900_ai_ci', connectTimeout: 10000,
})
async function tableNames(connection: mysql.Connection, prefix: string) {
  const [rows] = await connection.query<Array<RowDataPacket & { name: string }>>(
    'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND LEFT(TABLE_NAME,?)=? ORDER BY TABLE_NAME',
    [mysqlConfig.database, prefix.length, prefix],
  )
  return rows.map(row => row.name)
}
await withFdeAcceptanceSignals(async lifecycle => {
  const metadata = await connect()
  let sourceTables: string[]
  try {
    sourceTables = await tableNames(metadata, sourcePrefix)
    assert.equal((await tableNames(metadata, targetPrefix)).length, 0, '隔离前缀已存在，拒绝复用')
  } finally { await metadata.end().catch(() => metadata.destroy()) }
  lifecycle.checkpoint()
  // macOS /var is an alias of /private/var; child cwd is canonicalized by Node.
  const fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'lead-duplicate-release-')))
  process.env.LEAD_ACCEPTANCE_ROOT = fixtureRoot
  assertLeadDuplicateAcceptanceIsolation(process.env, fixtureRoot)
  let fixturePool: { end(): Promise<void> } | undefined
  console.log(JSON.stringify({ fixturePrefix: targetPrefix, fixtureRoot, syntheticDataOnly: true }))
  await withAcceptanceCleanup(async () => {
    const { pool } = await import('../db/client.js'); fixturePool = pool
    const { applySchemaMigrations, assertSchemaReady } = await import('../db/migrate.js')
    lifecycle.checkpoint()
    await applySchemaMigrations()
    await assertSchemaReady()
    lifecycle.checkpoint()
    const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
    const marker = randomUUID()
    // Two overlapping groups exercise conflicting canonical decisions without
    // depending on the presence of duplicate records in the business database.
    await pool.query(`INSERT INTO ${leadsTable} (id,name,company_name,source) VALUES (?,?,?,?),(?,?,?,?),(?,?,?,?)`, [
      randomUUID(), `synthetic-name-${marker}`, `synthetic-company-${marker}`, 'isolated-release-acceptance',
      randomUUID(), `synthetic-name-${marker}`, `synthetic-other-company-${marker}`, 'isolated-release-acceptance',
      randomUUID(), `synthetic-other-name-${marker}`, `synthetic-company-${marker}`, 'isolated-release-acceptance',
    ])
    const [rows] = await pool.query<Array<RowDataPacket & LeadSnapshot>>(`SELECT * FROM ${leadsTable} ORDER BY id`)
    const reportDirectory = path.join(fixtureRoot, '.runtime/migration-evidence/mysql-normalization')
    await mkdir(reportDirectory, { recursive: true, mode: 0o700 })
    await writeFile(path.join(reportDirectory, 'report.json'), JSON.stringify({
      schemaVersion: '1.0', normalization: LEAD_DUPLICATE_NORMALIZATION,
      collisions: buildLeadDuplicateCollisions(rows), syntheticFixture: true,
    }), { mode: 0o600 })
    const execFileAsync = promisify(execFile)
    for (const script of ['leadDuplicateDispositionAcceptance.ts', 'leadDuplicateApplyAcceptance.ts']) {
      lifecycle.checkpoint()
      const operation = execFileAsync(process.execPath, [
        '--import', import.meta.resolve('tsx'), path.join(repositoryRoot, 'server/src/scripts', script),
      ], { cwd: fixtureRoot, env: { ...process.env }, maxBuffer: 2 * 1024 * 1024 })
      lifecycle.track(operation.child)
      const result = await operation
      process.stdout.write(result.stdout)
      process.stderr.write(result.stderr)
      console.log(JSON.stringify({ script, exitCode: 0 }))
    }
    lifecycle.checkpoint()
  }, async () => {
    await withAcceptanceCleanup(async () => { await fixturePool?.end() }, async () => {
      const result = await cleanupFdeTables({ targetPrefix, sourcePrefix, sourceTables, connect: async () => {
        const connection = await connect()
        try { await connection.query('SET SESSION lock_wait_timeout=10') }
        catch (error) { await connection.end().catch(() => connection.destroy()); throw error }
        return {
          tables: prefix => tableNames(connection, prefix),
          foreignKeys: async enabled => { await connection.query(`SET FOREIGN_KEY_CHECKS=${enabled ? 1 : 0}`) },
          drop: async table => { await connection.query(`DROP TABLE IF EXISTS ${quoteMysqlIdentifier(table)}`) },
          close: async () => { await connection.end().catch(() => connection.destroy()) },
        }
      } })
      await rm(fixtureRoot, { recursive: true, force: true })
      console.log(JSON.stringify({ cleanup: true, prefix: targetPrefix, tables: result.tables, businessTableSetUnchanged: true }))
    })
  })
  // Release may continue only after both acceptance AND cleanup succeeded.
  lifecycle.checkpoint()
  console.log(JSON.stringify({ ok: true, acceptance: 'lead-duplicate-release', syntheticDataOnly: true, cleanupCompleted: true }))
})
