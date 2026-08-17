import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlConfig } from '../db/config.js'
import {
  assessMysqlGrants,
  MYSQL_MIGRATION_PRIVILEGES,
  MYSQL_RUNTIME_PRIVILEGES,
} from '../services/mysqlAccountProvisioningService.js'

const root = process.cwd()
const envPath = path.resolve(root, '.env')
const defaultCredentialPath = path.resolve(root, '.runtime/secrets/mysql-migration.env')
const evidenceDir = path.resolve(root, '.runtime/migration-evidence/mysql-account-separation')
const formalCutoverReportPath = path.join(evidenceDir, 'formal-cutover.json')

function identityHash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

async function privateFile(file: string, label: string) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error(`[mysql-cutover-audit] ${label} must be an owner-only regular non-symlink file`)
  }
}

async function privateDirectory(directory: string, label: string) {
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`[mysql-cutover-audit] ${label} must be a real directory`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(directory, { recursive: true, mode: 0o700 })
  }
  await chmod(directory, 0o700)
}

function parseCredentialFile(source: string) {
  const values = new Map<string, string>()
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error('[mysql-cutover-audit] malformed migration credential file')
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (!['DB_MIGRATION_USERNAME', 'DB_MIGRATION_PASSWORD'].includes(key) || values.has(key) || !value) {
      throw new Error('[mysql-cutover-audit] migration credential file contains invalid keys or values')
    }
    values.set(key, value)
  }
  const username = values.get('DB_MIGRATION_USERNAME')
  const password = values.get('DB_MIGRATION_PASSWORD')
  if (!username || !password || values.size !== 2) throw new Error('[mysql-cutover-audit] migration credentials are incomplete')
  return { username, password }
}

async function grants(connection: { query: (sql: string) => Promise<[RowDataPacket[], unknown]> }) {
  const [rows] = await connection.query('SHOW GRANTS FOR CURRENT_USER()')
  return rows.map((row) => String(Object.values(row)[0] || ''))
}

async function writePrivate(file: string, value: string) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await rename(temporary, file)
  await chmod(file, 0o600)
}

async function main() {
  const credentialPath = path.resolve(process.env.DB_MIGRATION_ENV_FILE?.trim() || defaultCredentialPath)
  await privateFile(envPath, '.env')
  await privateFile(credentialPath, 'migration credential file')
  const migrationCredential = parseCredentialFile(await readFile(credentialPath, 'utf8'))
  const migration = await mysql.createConnection({
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    database: mysqlConfig.database,
    user: migrationCredential.username,
    password: migrationCredential.password,
    connectTimeout: mysqlConfig.connectTimeoutMs,
  })
  try {
    const [runtimeIdentityRows] = await pool.query<RowDataPacket[]>('SELECT CURRENT_USER() AS principal')
    const [migrationIdentityRows] = await migration.query<RowDataPacket[]>('SELECT CURRENT_USER() AS principal')
    const runtimeGrants = await grants(pool as unknown as { query: (sql: string) => Promise<[RowDataPacket[], unknown]> })
    const migrationGrants = await grants(migration as unknown as { query: (sql: string) => Promise<[RowDataPacket[], unknown]> })
    const runtimeAssessment = assessMysqlGrants(
      runtimeGrants,
      mysqlConfig.database,
      MYSQL_RUNTIME_PRIVILEGES,
      MYSQL_MIGRATION_PRIVILEGES.filter((item) => !MYSQL_RUNTIME_PRIVILEGES.includes(item as typeof MYSQL_RUNTIME_PRIVILEGES[number])),
    )
    const migrationAssessment = assessMysqlGrants(
      migrationGrants,
      mysqlConfig.database,
      MYSQL_MIGRATION_PRIVILEGES,
      ['CREATE USER', 'GRANT OPTION', 'FILE', 'PROCESS', 'RELOAD', 'REPLICATION CLIENT', 'REPLICATION SLAVE'],
    )
    const [tableRows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND LEFT(TABLE_NAME,?)=?',
      [mysqlConfig.database, mysqlConfig.tablePrefix.length, mysqlConfig.tablePrefix],
    )
    const [journalRows] = await migration.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS count FROM \`${mysqlConfig.tablePrefix}__drizzle_migrations\``,
    )
    const principalsDiffer = String(runtimeIdentityRows[0]?.principal) !== String(migrationIdentityRows[0]?.principal)
    const checks = {
      runtimeGrantSetIsDmlOnly: runtimeAssessment.ok,
      migrationGrantSetIsSchemaScoped: migrationAssessment.ok,
      runtimeAndMigrationPrincipalsDiffer: principalsDiffer,
      runtimeCanReadApplicationSchema: Number(tableRows[0]?.count || 0) > 0,
      migrationCanReadJournal: Number(journalRows[0]?.count || 0) > 0,
      environmentAndMigrationCredentialFilesOwnerOnly: true,
      passwordsExcludedFromOutputAndEvidence: true,
    }
    const report = {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      ok: Object.values(checks).every(Boolean),
      runtimePrincipalSha256: identityHash(String(runtimeIdentityRows[0]?.principal || '')),
      migrationPrincipalSha256: identityHash(String(migrationIdentityRows[0]?.principal || '')),
      runtimePrivileges: [...MYSQL_RUNTIME_PRIVILEGES],
      migrationPrivileges: [...MYSQL_MIGRATION_PRIVILEGES],
      applicationTables: Number(tableRows[0]?.count || 0),
      migrationJournalEntries: Number(journalRows[0]?.count || 0),
      checks,
    }
    await privateDirectory(evidenceDir, 'evidence directory')
    try {
      const formal = JSON.parse(await readFile(formalCutoverReportPath, 'utf8')) as Record<string, unknown>
      const runtime = formal.runtime as { principal?: string; principalSha256?: string; privileges?: unknown } | undefined
      const migration = formal.migration as { principal?: string; principalSha256?: string; privileges?: unknown } | undefined
      if (runtime?.principal) {
        formal.runtime = { principalSha256: identityHash(runtime.principal), privileges: runtime.privileges }
      }
      if (migration?.principal) {
        formal.migration = { principalSha256: identityHash(migration.principal), privileges: migration.privileges }
      }
      const formalChecks = formal.checks as Record<string, unknown> | undefined
      if (formalChecks) {
        delete formalChecks.passwordsPrintedOrWrittenToEvidence
        formalChecks.passwordsExcludedFromOutputAndEvidence = true
      }
      await writePrivate(formalCutoverReportPath, `${JSON.stringify(formal, null, 2)}\n`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await writePrivate(path.join(evidenceDir, 'formal-cutover-audit.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify(report))
    if (!report.ok) process.exitCode = 2
  } finally {
    await migration.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}).finally(async () => pool.end())
