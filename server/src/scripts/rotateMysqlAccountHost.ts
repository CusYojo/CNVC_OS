import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql, { type Connection, type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import { mysqlConfig } from '../db/config.js'
import {
  dropMysqlAccount,
  provisionSeparatedMysqlAccounts,
  type MysqlAccountSpec,
} from '../services/mysqlAccountProvisioningService.js'

const root = process.cwd()
const runtimeEnvPath = path.resolve(root, '.env')
const dbaEnvPath = path.resolve(root, '.runtime/secrets/.env.before-mysql-account-cutover')
const migrationEnvPath = path.resolve(root, '.runtime/secrets/mysql-migration.env')
const evidenceDirectory = path.resolve(root, '.runtime/migration-evidence/mysql-account-separation')
const evidencePath = path.join(evidenceDirectory, 'host-rotation.json')

function parseEnvironment(source: string, allowed: readonly string[]) {
  const values = new Map<string, string>()
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator)
    if (!allowed.includes(key)) continue
    if (values.has(key)) throw new Error(`[mysql-host-rotation] duplicate ${key}`)
    values.set(key, line.slice(separator + 1))
  }
  for (const key of allowed) if (!values.get(key)) throw new Error(`[mysql-host-rotation] missing ${key}`)
  return values
}

async function privateFile(file: string, label: string) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error(`[mysql-host-rotation] ${label} must be an owner-only regular non-symlink file`)
  }
}

function identityHash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

async function writePrivateAtomic(file: string, value: string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await chmod(path.dirname(file), 0o700)
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await rename(temporary, file)
  await chmod(file, 0o600)
}

async function observedClientHost(connection: Connection) {
  const [rows] = await connection.query<RowDataPacket[]>("SELECT SUBSTRING_INDEX(USER(),'@',-1) AS clientHost")
  const host = String(rows[0]?.clientHost || '').trim()
  if (!host || host === '%' || !/^[A-Za-z0-9_.:%-]+$/.test(host)) {
    throw new Error('[mysql-host-rotation] could not derive a safe exact client host')
  }
  return host
}

async function accountBindings(connection: Connection, usernames: string[]) {
  const [rows] = await connection.query<RowDataPacket[]>(
    'SELECT User AS username, Host AS host FROM mysql.user WHERE User IN (?,?) ORDER BY User, Host',
    usernames,
  )
  return rows.map((row) => ({ username: String(row.username), host: String(row.host) }))
}

async function verifyConnections(runtime: MysqlAccountSpec, migration: MysqlAccountSpec) {
  const connect = (account: MysqlAccountSpec) => mysql.createConnection({
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    database: mysqlConfig.database,
    user: account.username,
    password: account.password,
    connectTimeout: mysqlConfig.connectTimeoutMs,
  })
  const [runtimeConnection, migrationConnection] = await Promise.all([connect(runtime), connect(migration)])
  try {
    const [runtimeRows] = await runtimeConnection.query<RowDataPacket[]>('SELECT CURRENT_USER() AS principal')
    const [migrationRows] = await migrationConnection.query<RowDataPacket[]>('SELECT CURRENT_USER() AS principal')
    if (String(runtimeRows[0]?.principal) !== `${runtime.username}@${runtime.host}`) {
      throw new Error('[mysql-host-rotation] runtime connected through an unexpected binding')
    }
    if (String(migrationRows[0]?.principal) !== `${migration.username}@${migration.host}`) {
      throw new Error('[mysql-host-rotation] migration connected through an unexpected binding')
    }
  } finally {
    await runtimeConnection.end().catch(() => undefined)
    await migrationConnection.end().catch(() => undefined)
  }
}

async function main() {
  await Promise.all([
    privateFile(runtimeEnvPath, 'runtime environment'),
    privateFile(dbaEnvPath, 'DBA recovery environment'),
    privateFile(migrationEnvPath, 'migration credential environment'),
  ])
  const runtimeValues = parseEnvironment(await readFile(runtimeEnvPath, 'utf8'), ['DB_USERNAME', 'DB_PASSWORD'])
  const migrationValues = parseEnvironment(await readFile(migrationEnvPath, 'utf8'), ['DB_MIGRATION_USERNAME', 'DB_MIGRATION_PASSWORD'])
  const dbaValues = parseEnvironment(await readFile(dbaEnvPath, 'utf8'), ['DB_USERNAME', 'DB_PASSWORD'])
  const dba = await mysql.createConnection({
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    database: mysqlConfig.database,
    user: dbaValues.get('DB_USERNAME')!,
    password: dbaValues.get('DB_PASSWORD')!,
    connectTimeout: mysqlConfig.connectTimeoutMs,
  })
  try {
    const host = await observedClientHost(dba)
    const runtime: MysqlAccountSpec = {
      username: runtimeValues.get('DB_USERNAME')!, host, password: runtimeValues.get('DB_PASSWORD')!,
    }
    const migration: MysqlAccountSpec = {
      username: migrationValues.get('DB_MIGRATION_USERNAME')!, host, password: migrationValues.get('DB_MIGRATION_PASSWORD')!,
    }
    if (runtime.username === migration.username) throw new Error('[mysql-host-rotation] runtime and migration usernames must differ')
    const usernames = [runtime.username, migration.username]
    const before = await accountBindings(dba, usernames)
    if (!before.some((row) => row.username === runtime.username) || !before.some((row) => row.username === migration.username)) {
      throw new Error('[mysql-host-rotation] separated account baseline is incomplete')
    }
    const stale = before.filter((row) => row.host !== host)
    const alreadyCurrent = before.filter((row) => row.host === host)
    const preview = {
      ok: true,
      mode: 'preview',
      hostBindingDriftDetected: stale.length > 0 || alreadyCurrent.length !== 2,
      currentBindingCount: alreadyCurrent.length,
      staleBindingCount: stale.length,
      exactHostValueExcluded: true,
      passwordsExcludedFromOutputAndEvidence: true,
    }
    if (!process.argv.includes('--apply')) {
      console.log(JSON.stringify(preview))
      return
    }

    const createdCurrent = alreadyCurrent.length === 0
    try {
      await provisionSeparatedMysqlAccounts(dba as unknown as PoolConnection, {
        database: mysqlConfig.database,
        runtime,
        migration,
      })
      await verifyConnections(runtime, migration)
    } catch (error) {
      if (createdCurrent) {
        await dropMysqlAccount(dba as unknown as PoolConnection, runtime).catch(() => undefined)
        await dropMysqlAccount(dba as unknown as PoolConnection, migration).catch(() => undefined)
      }
      throw error
    }

    for (const account of stale) {
      await dropMysqlAccount(dba as unknown as PoolConnection, account)
    }
    const after = await accountBindings(dba, usernames)
    if (after.length !== 2 || after.some((row) => row.host !== host)) {
      throw new Error('[mysql-host-rotation] stale account bindings remain after rotation')
    }
    const report = {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      ok: true,
      mode: 'apply',
      hostScope: 'exact-observed-client-host',
      oldBindingCountRemoved: stale.length,
      currentBindingCount: after.length,
      runtimePrincipalSha256: identityHash(`${runtime.username}@${runtime.host}`),
      migrationPrincipalSha256: identityHash(`${migration.username}@${migration.host}`),
      exactHostValueExcluded: true,
      passwordsExcludedFromOutputAndEvidence: true,
      runtimeAndMigrationCredentialsUnchanged: true,
      staleBindingsRemovedAfterLiveVerification: true,
    }
    await writePrivateAtomic(evidencePath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({
      ok: true,
      mode: report.mode,
      hostScope: report.hostScope,
      oldBindingCountRemoved: report.oldBindingCountRemoved,
      currentBindingCount: report.currentBindingCount,
      exactHostValueExcluded: true,
      passwordsExcludedFromOutputAndEvidence: true,
      runtimeAndMigrationCredentialsUnchanged: true,
      staleBindingsRemovedAfterLiveVerification: true,
    }))
  } finally {
    await dba.end()
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message.replace(/'[^']+'@'[^']+'/g, '<redacted-principal>'))
  process.exitCode = 1
})
