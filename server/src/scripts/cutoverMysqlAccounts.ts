import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlConfig, quoteMysqlIdentifier } from '../db/config.js'
import {
  dropMysqlAccount,
  provisionSeparatedMysqlAccounts,
  type MysqlAccountSpec,
} from '../services/mysqlAccountProvisioningService.js'

const root = process.cwd()
const envPath = path.resolve(root, '.env')
const secretsDir = path.resolve(root, '.runtime/secrets')
const rollbackPath = path.join(secretsDir, '.env.before-mysql-account-cutover')
const migrationCredentialPath = path.join(secretsDir, 'mysql-migration.env')
const evidenceDir = path.resolve(root, '.runtime/migration-evidence/mysql-account-separation')

function strongPassword(): string {
  return `Aa9!${randomBytes(32).toString('base64url')}`
}

function identityHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function accountName(kind: 'rt' | 'mig', suffix: string): string {
  const prefix = mysqlConfig.tablePrefix.replace(/_+$/g, '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 10) || 'app'
  return `${prefix}_${kind}_${suffix}`.slice(0, 32)
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function assertPrivateRegularFile(file: string, label: string): Promise<void> {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`[mysql-cutover] ${label} must be a regular non-symlink file`)
  if ((info.mode & 0o077) !== 0) throw new Error(`[mysql-cutover] ${label} must not be group/other accessible`)
}

async function ensurePrivateDirectory(directory: string, label: string): Promise<void> {
  if (await exists(directory)) {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`[mysql-cutover] ${label} must be a real directory`)
    }
  } else {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  }
  await chmod(directory, 0o700)
}

async function writePrivateAtomic(file: string, value: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await rename(temporary, file)
  await chmod(file, 0o600)
}

export function replaceDotEnvValue(source: string, key: string, value: string): string {
  if (!value || /[\r\n]/.test(value)) throw new Error(`[mysql-cutover] unsafe ${key} value`)
  const lines = source.split(/\r?\n/)
  let matches = 0
  const updated = lines.map((line) => {
    if (!line.startsWith(`${key}=`)) return line
    matches += 1
    return `${key}=${value}`
  })
  if (matches !== 1) throw new Error(`[mysql-cutover] .env must contain exactly one ${key} entry`)
  return updated.join('\n')
}

async function observedClientHost(): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT SUBSTRING_INDEX(USER(),'@',-1) AS clientHost")
  const host = String(rows[0]?.clientHost || '').trim()
  if (!host || host === '%' || !/^[A-Za-z0-9_.:%-]+$/.test(host)) {
    throw new Error('[mysql-cutover] could not derive a safe exact client host')
  }
  return host
}

async function connect(account: MysqlAccountSpec): Promise<Connection> {
  return mysql.createConnection({
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    database: mysqlConfig.database,
    user: account.username,
    password: account.password,
    connectTimeout: mysqlConfig.connectTimeoutMs,
  })
}

async function verifyLiveSeparation(runtime: MysqlAccountSpec, migration: MysqlAccountSpec, suffix: string) {
  const fixture = `${mysqlConfig.tablePrefix}formal_account_cutover_${suffix}`
  const deniedFixture = `${fixture}_denied`
  const migrationConnection = await connect(migration)
  const runtimeConnection = await connect(runtime)
  let runtimeDdlDenied = false
  try {
    await migrationConnection.query(`CREATE TABLE ${quoteMysqlIdentifier(fixture)} (id INT PRIMARY KEY, value VARCHAR(40) NOT NULL)`)
    await migrationConnection.query(`ALTER TABLE ${quoteMysqlIdentifier(fixture)} ADD COLUMN version INT NOT NULL DEFAULT 1`)
    await migrationConnection.query(`CREATE INDEX ${quoteMysqlIdentifier(`${fixture}_value_idx`)} ON ${quoteMysqlIdentifier(fixture)} (value)`)
    await runtimeConnection.query(`INSERT INTO ${quoteMysqlIdentifier(fixture)} (id,value) VALUES (1,'runtime-dml')`)
    await runtimeConnection.query(`UPDATE ${quoteMysqlIdentifier(fixture)} SET value='runtime-verified' WHERE id=1`)
    const [rows] = await runtimeConnection.query<RowDataPacket[]>(`SELECT value FROM ${quoteMysqlIdentifier(fixture)} WHERE id=1`)
    if (String(rows[0]?.value) !== 'runtime-verified') throw new Error('[mysql-cutover] runtime DML round trip failed')
    await runtimeConnection.query(`DELETE FROM ${quoteMysqlIdentifier(fixture)} WHERE id=1`)
    try {
      await runtimeConnection.query(`CREATE TABLE ${quoteMysqlIdentifier(deniedFixture)} (id INT PRIMARY KEY)`)
    } catch (error) {
      runtimeDdlDenied = /denied|command denied|privilege/i.test(error instanceof Error ? error.message : String(error))
    }
    if (!runtimeDdlDenied) throw new Error('[mysql-cutover] runtime account unexpectedly accepted DDL')
    const [inventory] = await runtimeConnection.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND LEFT(TABLE_NAME,?)=?',
      [mysqlConfig.database, mysqlConfig.tablePrefix.length, mysqlConfig.tablePrefix],
    )
    if (Number(inventory[0]?.count || 0) < 1) throw new Error('[mysql-cutover] runtime account cannot read application schema')
  } finally {
    await migrationConnection.query(`DROP TABLE IF EXISTS ${quoteMysqlIdentifier(deniedFixture)}`).catch(() => undefined)
    await migrationConnection.query(`DROP TABLE IF EXISTS ${quoteMysqlIdentifier(fixture)}`).catch(() => undefined)
    await runtimeConnection.end().catch(() => undefined)
    await migrationConnection.end().catch(() => undefined)
  }
  return { runtimeDmlRoundTrip: true, runtimeDdlDenied, migrationDdlRoundTrip: true }
}

async function rollback() {
  await assertPrivateRegularFile(rollbackPath, 'rollback copy')
  const previous = await readFile(rollbackPath, 'utf8')
  await writePrivateAtomic(envPath, previous)
  console.log(JSON.stringify({
    ok: true,
    mode: 'rollback',
    envRestored: true,
    accountsRetainedForRecovery: true,
    nextStep: 'Run audit:mysql-privileges; the restored DBA account is intentionally not revoked automatically.',
  }))
}

async function apply() {
  await assertPrivateRegularFile(envPath, '.env')
  if (await exists(rollbackPath)) throw new Error('[mysql-cutover] rollback copy already exists; archive or explicitly remove it before another cutover')
  if (await exists(migrationCredentialPath)) throw new Error('[mysql-cutover] migration credential file already exists; refusing to overwrite it')

  const originalEnv = await readFile(envPath, 'utf8')
  const host = await observedClientHost()
  const suffix = randomBytes(6).toString('hex')
  const runtime: MysqlAccountSpec = { username: accountName('rt', suffix), host, password: strongPassword() }
  const migration: MysqlAccountSpec = { username: accountName('mig', suffix), host, password: strongPassword() }
  const admin = await pool.getConnection()
  let provisioned = false
  let backupWritten = false
  let migrationCredentialWritten = false
  let envWritten = false
  try {
    const grants = await provisionSeparatedMysqlAccounts(admin, { database: mysqlConfig.database, runtime, migration })
    provisioned = true
    const live = await verifyLiveSeparation(runtime, migration, suffix)

    await ensurePrivateDirectory(secretsDir, 'secrets directory')
    await writePrivateAtomic(rollbackPath, originalEnv)
    backupWritten = true
    await writePrivateAtomic(
      migrationCredentialPath,
      `DB_MIGRATION_USERNAME=${migration.username}\nDB_MIGRATION_PASSWORD=${migration.password}\n`,
    )
    migrationCredentialWritten = true
    const runtimeEnv = replaceDotEnvValue(
      replaceDotEnvValue(originalEnv, 'DB_USERNAME', runtime.username),
      'DB_PASSWORD',
      runtime.password,
    )
    await writePrivateAtomic(envPath, runtimeEnv)
    envWritten = true

    await ensurePrivateDirectory(evidenceDir, 'evidence directory')
    const report = {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      ok: true,
      hostScope: 'exact-observed-client-host',
      runtime: { principalSha256: identityHash(`${runtime.username}@${runtime.host}`), privileges: grants.runtime.privileges },
      migration: { principalSha256: identityHash(`${migration.username}@${migration.host}`), privileges: grants.migration.privileges },
      checks: {
        ...live,
        runtimeEnvironmentUpdated: true,
        migrationCredentialsSeparated: true,
        rollbackCopyOwnerOnly: true,
        passwordsExcludedFromOutputAndEvidence: true,
      },
      migrationCredentialFile: path.relative(root, migrationCredentialPath),
      rollbackFile: path.relative(root, rollbackPath),
    }
    await writePrivateAtomic(path.join(evidenceDir, 'formal-cutover.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({
      ok: true,
      mode: 'apply',
      hostScope: report.hostScope,
      runtimePrivileges: grants.runtime.privileges,
      migrationPrivileges: grants.migration.privileges,
      checks: report.checks,
      migrationCredentialFile: report.migrationCredentialFile,
      rollbackFile: report.rollbackFile,
    }))
  } catch (error) {
    if (envWritten) await writePrivateAtomic(envPath, originalEnv).catch(() => undefined)
    if (migrationCredentialWritten) await rm(migrationCredentialPath, { force: true }).catch(() => undefined)
    if (backupWritten) await rm(rollbackPath, { force: true }).catch(() => undefined)
    if (provisioned) {
      await dropMysqlAccount(admin, runtime).catch(() => undefined)
      await dropMysqlAccount(admin, migration).catch(() => undefined)
    }
    throw error
  } finally {
    admin.release()
  }
}

async function main() {
  const applyMode = process.argv.includes('--apply')
  const rollbackMode = process.argv.includes('--rollback')
  if (applyMode && rollbackMode) throw new Error('[mysql-cutover] choose either --apply or --rollback')
  if (rollbackMode) return rollback()
  if (!applyMode) {
    await assertPrivateRegularFile(envPath, '.env')
    const host = await observedClientHost()
    console.log(JSON.stringify({
      ok: true,
      mode: 'preview',
      mutatesDatabase: false,
      changesRuntimeEnvironment: false,
      exactHostBindingAvailable: Boolean(host),
      rollbackCopyWillBeCreated: true,
      passwordsWillBeGeneratedInternally: true,
      passwordsWillBePrintedOrWrittenToEvidence: false,
    }))
    return
  }
  await apply()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}).finally(async () => pool.end())
