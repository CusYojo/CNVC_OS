import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import mysql, { type PoolConnection } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlConfig, quoteMysqlIdentifier } from '../db/config.js'
import {
  dropMysqlAccount,
  provisionSeparatedMysqlAccounts,
  type MysqlAccountSpec,
} from '../services/mysqlAccountProvisioningService.js'

const execFileAsync = promisify(execFile)

function password(): string {
  return `Aa9!${randomBytes(24).toString('base64url')}`
}

async function writePrivate(file: string, value: string) {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, file)
  await chmod(file, 0o600)
}

async function loadAdminCredential() {
  const file = path.resolve(process.env.DB_ACCOUNT_ADMIN_ENV_FILE?.trim()
    || '.runtime/secrets/.env.before-mysql-account-cutover')
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('[mysql-account-separation] admin credential file must be an owner-only regular non-symlink file')
  }
  const values = new Map<string, string>()
  for (const raw of (await readFile(file, 'utf8')).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator)
    if (!['DB_USERNAME', 'DB_PASSWORD'].includes(key) || values.has(key)) continue
    values.set(key, line.slice(separator + 1))
  }
  const user = values.get('DB_USERNAME')
  const password = values.get('DB_PASSWORD')
  if (!user || !password) throw new Error('[mysql-account-separation] admin credentials are incomplete')
  return { user, password }
}

async function main() {
  const suffix = randomBytes(6).toString('hex')
  const runtime: MysqlAccountSpec = { username: `sbl_rt_${suffix}`, host: '%', password: password() }
  const migration: MysqlAccountSpec = { username: `sbl_mig_${suffix}`, host: '%', password: password() }
  const fixture = `${mysqlConfig.tablePrefix}account_separation_${suffix}`
  const forbiddenFixture = `${fixture}_forbidden`
  const adminCredential = await loadAdminCredential()
  const admin = await mysql.createConnection({
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    database: mysqlConfig.database,
    user: adminCredential.user,
    password: adminCredential.password,
    connectTimeout: mysqlConfig.connectTimeoutMs,
  })
  let migrationConnection: mysql.Connection | null = null
  let runtimeConnection: mysql.Connection | null = null
  let runtimeDdlDenied = false
  let dmlRoundTrip = false
  let migrationDdlRoundTrip = false
  let cleanupVerified = false
  let runtimeReleaseAuditAccepted = false
  let provisioned: Awaited<ReturnType<typeof provisionSeparatedMysqlAccounts>> | null = null
  try {
    provisioned = await provisionSeparatedMysqlAccounts(admin as unknown as PoolConnection, {
      database: mysqlConfig.database,
      runtime,
      migration,
    })
    migrationConnection = await mysql.createConnection({
      host: mysqlConfig.host,
      port: mysqlConfig.port,
      database: mysqlConfig.database,
      user: migration.username,
      password: migration.password,
      connectTimeout: mysqlConfig.connectTimeoutMs,
    })
    runtimeConnection = await mysql.createConnection({
      host: mysqlConfig.host,
      port: mysqlConfig.port,
      database: mysqlConfig.database,
      user: runtime.username,
      password: runtime.password,
      connectTimeout: mysqlConfig.connectTimeoutMs,
    })
    await migrationConnection.query(`CREATE TABLE ${quoteMysqlIdentifier(fixture)} (id INT PRIMARY KEY, value VARCHAR(40) NOT NULL)`)
    await migrationConnection.query(`ALTER TABLE ${quoteMysqlIdentifier(fixture)} ADD COLUMN version INT NOT NULL DEFAULT 1`)
    await migrationConnection.query(`CREATE INDEX ${quoteMysqlIdentifier(`${fixture}_value_idx`)} ON ${quoteMysqlIdentifier(fixture)} (value)`)
    migrationDdlRoundTrip = true
    await runtimeConnection.query(`INSERT INTO ${quoteMysqlIdentifier(fixture)} (id, value) VALUES (1, 'runtime-dml')`)
    await runtimeConnection.query(`UPDATE ${quoteMysqlIdentifier(fixture)} SET value='runtime-updated' WHERE id=1`)
    const [rows] = await runtimeConnection.query<mysql.RowDataPacket[]>(`SELECT value FROM ${quoteMysqlIdentifier(fixture)} WHERE id=1`)
    await runtimeConnection.query(`DELETE FROM ${quoteMysqlIdentifier(fixture)} WHERE id=1`)
    dmlRoundTrip = String(rows[0]?.value) === 'runtime-updated'
    try {
      await runtimeConnection.query(`CREATE TABLE ${quoteMysqlIdentifier(forbiddenFixture)} (id INT PRIMARY KEY)`)
    } catch (error) {
      runtimeDdlDenied = /denied|command denied|privilege/i.test(error instanceof Error ? error.message : String(error))
    }
    const audit = await execFileAsync(process.execPath, [
      '--import', 'tsx', path.resolve('server/src/scripts/mysqlPrivilegeAudit.ts'),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DB_USERNAME: runtime.username,
        DB_PASSWORD: runtime.password,
      },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    })
    const auditReport = JSON.parse(audit.stdout.trim()) as { ok?: boolean; parserSelfTest?: boolean }
    runtimeReleaseAuditAccepted = auditReport.ok === true && auditReport.parserSelfTest === true
    await migrationConnection.query(`DROP TABLE ${quoteMysqlIdentifier(fixture)}`)
  } finally {
    await runtimeConnection?.end().catch(() => undefined)
    await migrationConnection?.query(`DROP TABLE IF EXISTS ${quoteMysqlIdentifier(forbiddenFixture)}`).catch(() => undefined)
    await migrationConnection?.query(`DROP TABLE IF EXISTS ${quoteMysqlIdentifier(fixture)}`).catch(() => undefined)
    await migrationConnection?.end().catch(() => undefined)
    await dropMysqlAccount(admin as unknown as PoolConnection, runtime).catch(() => undefined)
    await dropMysqlAccount(admin as unknown as PoolConnection, migration).catch(() => undefined)
    const [tableRows] = await admin.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS count FROM information_schema.tables
       WHERE table_schema=? AND table_name IN (?, ?)`,
      [mysqlConfig.database, fixture, forbiddenFixture],
    )
    const [userRows] = await admin.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM mysql.user WHERE user IN (?, ?) AND host=?',
      [runtime.username, migration.username, '%'],
    )
    cleanupVerified = Number(tableRows[0]?.count || 0) === 0 && Number(userRows[0]?.count || 0) === 0
    await admin.end()
  }
  const checks = {
    runtimeGrantSetIsDmlOnly: provisioned?.runtime.assessment.ok === true,
    migrationGrantSetIsSchemaScoped: provisioned?.migration.assessment.ok === true,
    runtimeDmlRoundTrip: dmlRoundTrip,
    runtimeDdlDenied,
    migrationDdlRoundTrip,
    runtimeReleaseAuditAccepted,
    fixtureAccountsAndTablesRemoved: cleanupVerified,
  }
  const report = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    ok: Object.values(checks).every(Boolean),
    checks,
    runtimePrivileges: provisioned?.runtime.privileges || [],
    migrationPrivileges: provisioned?.migration.privileges || [],
    currentConfiguredRuntimeAccountChanged: false,
    note: 'Acceptance uses random disposable accounts. Production DB_USERNAME remains unchanged until explicit credentials are supplied and applied.',
  }
  const outputDir = path.resolve('.runtime/migration-evidence/mysql-account-separation')
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  await chmod(outputDir, 0o700)
  await writePrivate(path.join(outputDir, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report))
  if (!report.ok) process.exitCode = 2
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}).finally(() => pool.end())
