import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import { MYSQL_CONNECTION_COLLATION, mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { assertPortsFree, validatePrestartFiles } from './singleServicePrestart.js'

const execFileAsync = promisify(execFile)
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'single-service-prestart-'))
const reportPath = path.join(temporaryRoot, 'prestart-evidence', 'report.json')

async function listenerPids() {
  const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP:3100', '-sTCP:LISTEN', '-t']).catch(() => ({ stdout: '' }))
  return stdout.split(/\s+/).filter(Boolean).sort()
}

async function counts(connection: mysql.Connection) {
  const [rows] = await connection.query<RowDataPacket[]>(`
    SELECT
      (SELECT COUNT(*) FROM ${quoteMysqlIdentifier(mysqlTableName('users'))}) AS users,
      (SELECT COUNT(*) FROM ${quoteMysqlIdentifier(mysqlTableName('migration_runs'))}) AS migrationRuns,
      (SELECT COUNT(*) FROM ${quoteMysqlIdentifier(mysqlTableName('audit_logs'))}) AS auditLogs
  `)
  return rows[0]
}

const connection = await mysql.createConnection({
  host: mysqlConfig.host,
  port: mysqlConfig.port,
  database: mysqlConfig.database,
  user: mysqlConfig.user,
  password: mysqlConfig.password,
  charset: MYSQL_CONNECTION_COLLATION,
  timezone: '+08:00',
  connectTimeout: mysqlConfig.connectTimeoutMs,
})

try {
  await mkdir(path.join(temporaryRoot, 'dist', 'assets'), { recursive: true })
  await mkdir(path.join(temporaryRoot, 'server-dist'), { recursive: true })
  await writeFile(path.join(temporaryRoot, '.env'), 'DB_PASSWORD=private\n', { mode: 0o600 })
  await writeFile(path.join(temporaryRoot, 'dist', 'index.html'), '<div id="root"></div><script src="/assets/app.js"></script>\n')
  await writeFile(path.join(temporaryRoot, 'dist', 'assets', 'app.js'), 'console.log("ok")\n')
  await writeFile(path.join(temporaryRoot, 'server-dist', 'index.js'), 'export const service = "cybernaut-app"\n')
  const valid = await validatePrestartFiles(temporaryRoot)
  assert.equal(valid.distFiles, 2)
  assert.equal(valid.serverFiles, 1)

  await chmod(path.join(temporaryRoot, '.env'), 0o644)
  await assert.rejects(validatePrestartFiles(temporaryRoot), /\.env mode must be 0600/)
  await chmod(path.join(temporaryRoot, '.env'), 0o600)
  const external = path.join(temporaryRoot, 'external.js')
  await writeFile(external, 'external\n')
  const linked = path.join(temporaryRoot, 'dist', 'assets', 'linked.js')
  await symlink(external, linked)
  await assert.rejects(validatePrestartFiles(temporaryRoot), /symbolic link/)
  await rm(linked)

  const occupied = net.createServer()
  await new Promise<void>((resolve, reject) => occupied.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = occupied.address()
  assert(address && typeof address === 'object')
  await assert.rejects(assertPortsFree([address.port]), /already listening/)
  await new Promise<void>((resolve) => occupied.close(() => resolve()))

  const beforeCounts = await counts(connection)
  const beforePids = await listenerPids()
  const result = await execFileAsync(process.execPath, [
    '--env-file-if-exists=.env', '--import', 'tsx', 'server/src/scripts/singleServicePrestart.ts',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, SINGLE_SERVICE_PRESTART_EVIDENCE_DIR: path.dirname(reportPath) },
    maxBuffer: 10 * 1024 * 1024,
  })
  const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) || '{}') as {
    ok?: boolean; database?: { sessionReadOnly?: boolean; migrationCount?: number };
    configuredValuesExcluded?: boolean; pathsExcluded?: boolean; databaseWrites?: number;
    processMutation?: boolean; evidenceFilesWritten?: number
  }
  assert.equal(output.ok, true)
  assert.equal(output.database?.sessionReadOnly, true)
  assert(Number(output.database?.migrationCount || 0) > 0)
  assert.equal(output.configuredValuesExcluded, true)
  assert.equal(output.pathsExcluded, true)
  assert.equal(output.databaseWrites, 0)
  assert.equal(output.processMutation, false)
  assert.equal(output.evidenceFilesWritten, 1)
  const afterCounts = await counts(connection)
  const afterPids = await listenerPids()
  assert.deepEqual(afterCounts, beforeCounts)
  assert.deepEqual(afterPids, beforePids)

  const reportInfo = await lstat(reportPath)
  assert(reportInfo.isFile() && !reportInfo.isSymbolicLink())
  assert.equal(reportInfo.mode & 0o077, 0)
  const reportText = await readFile(reportPath, 'utf8')
  for (const value of [mysqlConfig.host, mysqlConfig.database, mysqlConfig.user, mysqlConfig.password]) {
    if (value.length >= 4) assert(!reportText.includes(value), 'prestart report exposed a configured database value')
  }
  assert(!reportText.includes(process.cwd()), 'prestart report exposed the deployment path')

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'valid-paired-build-and-owner-only-env',
      'env-permission-failure-closed',
      'build-symlink-failure-closed',
      'occupied-port-failure-closed',
      'current-runtime-config-build-schema-and-mysql-prestart',
      'mysql-authoritative-counts-unchanged',
      'listener-process-set-unchanged',
      'owner-only-configured-value-and-path-free-evidence',
    ],
    databaseWrites: 0,
    processMutation: false,
  }))
} finally {
  await connection.end()
  await rm(temporaryRoot, { recursive: true, force: true })
}
