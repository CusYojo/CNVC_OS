import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlConfig, quoteMysqlIdentifier } from '../db/config.js'
import {
  assessMysqlGrants,
  mysqlAccountLiteral,
  MYSQL_MIGRATION_PRIVILEGES,
  validatedAccountSpec,
} from '../services/mysqlAccountProvisioningService.js'

const root = process.cwd()
const credentialPath = path.resolve(root, '.runtime/secrets/mysql-migration.env')
const evidencePath = path.resolve(root, '.runtime/migration-evidence/mysql-account-separation/migration-account-repair.json')

function parseCredential(source: string) {
  const values = new Map<string, string>()
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 1) throw new Error('[mysql-migration-repair] malformed credential file')
    const key = line.slice(0, index)
    const value = line.slice(index + 1)
    if (!['DB_MIGRATION_USERNAME', 'DB_MIGRATION_PASSWORD'].includes(key) || values.has(key) || !value) {
      throw new Error('[mysql-migration-repair] invalid credential file')
    }
    values.set(key, value)
  }
  if (values.size !== 2) throw new Error('[mysql-migration-repair] migration credentials are incomplete')
  return { username: values.get('DB_MIGRATION_USERNAME')!, password: values.get('DB_MIGRATION_PASSWORD')! }
}

async function requirePrivateFile(file: string) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('[mysql-migration-repair] migration credential file must be owner-only and non-symlink')
  }
}

async function observedClientHost() {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT SUBSTRING_INDEX(USER(),'@',-1) AS clientHost")
  const host = String(rows[0]?.clientHost || '').trim()
  if (!host || host === '%' || !/^[A-Za-z0-9_.:%-]+$/.test(host)) {
    throw new Error('[mysql-migration-repair] could not derive a safe exact client host')
  }
  return host
}

async function writeEvidence(value: Record<string, unknown>) {
  await mkdir(path.dirname(evidencePath), { recursive: true, mode: 0o700 })
  await chmod(path.dirname(evidencePath), 0o700)
  const temporary = `${evidencePath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await rename(temporary, evidencePath)
  await chmod(evidencePath, 0o600)
}

async function main() {
  await requirePrivateFile(credentialPath)
  const migrationCredential = parseCredential(await readFile(credentialPath, 'utf8'))
  const host = await observedClientHost()
  const migration = validatedAccountSpec({ ...migrationCredential, host }, 'migration')
  const account = mysqlAccountLiteral(migration)
  const [bindingRows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS count FROM mysql.user WHERE User=? AND Host=?',
    [migration.username, migration.host],
  )
  const exactBindingExisted = Number(bindingRows[0]?.count || 0) === 1
  const preview = {
    ok: true,
    mode: 'preview',
    database: mysqlConfig.database,
    exactBindingExisted,
    hostScope: 'exact-observed-client-host',
    privileges: [...MYSQL_MIGRATION_PRIVILEGES],
    runtimeAccountChanged: false,
    staleBindingsRemoved: false,
    exactHostValueExcluded: true,
    passwordExcluded: true,
  }
  if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify(preview))
    return
  }
  if (process.env.ALLOW_PRODUCTION_MYSQL_ACCOUNT_REPAIR !== '1') {
    throw new Error('[mysql-migration-repair] apply requires ALLOW_PRODUCTION_MYSQL_ACCOUNT_REPAIR=1')
  }

  const database = quoteMysqlIdentifier(mysqlConfig.database)
  const lockName = `mysql-migration-account-repair-${createHash('sha256')
    .update(`${mysqlConfig.host}:${mysqlConfig.database}:${migration.username}:${migration.host}`)
    .digest('hex').slice(0, 24)}`
  const connection = await pool.getConnection()
  let locked = false
  try {
    const [lockRows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?,10) AS acquired', [lockName])
    locked = Number(lockRows[0]?.acquired || 0) === 1
    if (!locked) throw new Error('[mysql-migration-repair] could not acquire repair lock')
    await connection.query(`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ?`, [migration.password])
    await connection.query(`ALTER USER ${account} IDENTIFIED BY ?`, [migration.password])
    await connection.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account}`)
    await connection.query(`GRANT ${MYSQL_MIGRATION_PRIVILEGES.join(', ')} ON ${database}.* TO ${account}`)
  } finally {
    if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined)
    connection.release()
  }

  const verification = await mysql.createConnection({
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    database: mysqlConfig.database,
    user: migration.username,
    password: migration.password,
    connectTimeout: mysqlConfig.connectTimeoutMs,
  })
  try {
    const [identityRows] = await verification.query<RowDataPacket[]>('SELECT CURRENT_USER() AS principal')
    if (String(identityRows[0]?.principal) !== `${migration.username}@${migration.host}`) {
      throw new Error('[mysql-migration-repair] migration connection used an unexpected principal binding')
    }
    const [grantRows] = await verification.query<RowDataPacket[]>('SHOW GRANTS FOR CURRENT_USER()')
    const grants = grantRows.map((row) => String(Object.values(row)[0] || ''))
    const assessment = assessMysqlGrants(
      grants,
      mysqlConfig.database,
      MYSQL_MIGRATION_PRIVILEGES,
      ['CREATE USER', 'GRANT OPTION', 'FILE', 'PROCESS', 'RELOAD', 'REPLICATION CLIENT', 'REPLICATION SLAVE'],
    )
    if (!assessment.ok) throw new Error(`[mysql-migration-repair] grant verification failed: ${JSON.stringify(assessment)}`)
    const evidence = {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      ok: true,
      mode: 'apply',
      database: mysqlConfig.database,
      migrationPrincipalSha256: createHash('sha256').update(String(identityRows[0]?.principal || '')).digest('hex'),
      exactBindingPreviouslyExisted: exactBindingExisted,
      hostScope: 'exact-observed-client-host',
      privileges: [...MYSQL_MIGRATION_PRIVILEGES],
      runtimeAccountChanged: false,
      staleBindingsRemoved: false,
      exactHostValueExcluded: true,
      passwordExcluded: true,
      assessment,
    }
    await writeEvidence(evidence)
    console.log(JSON.stringify({
      ok: true,
      mode: 'apply',
      database: mysqlConfig.database,
      exactBindingPreviouslyExisted: exactBindingExisted,
      hostScope: 'exact-observed-client-host',
      privileges: [...MYSQL_MIGRATION_PRIVILEGES],
      runtimeAccountChanged: false,
      staleBindingsRemoved: false,
      exactHostValueExcluded: true,
      passwordExcluded: true,
    }))
  } finally {
    await verification.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message.replace(/'[^']+'@'[^']+'/g, '<redacted-principal>') : String(error))
  process.exitCode = 1
}).finally(async () => await pool.end())
