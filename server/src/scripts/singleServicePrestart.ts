import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { RowDataPacket } from 'mysql2/promise'

const execFileAsync = promisify(execFile)
const requiredPorts = [3100, 3584, 8121] as const

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[single-service prestart] ${message}`)
}

async function lstatIfExists(target: string) {
  try { return await lstat(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function regularFile(target: string, label: string) {
  const info = await lstatIfExists(target)
  assertContract(info !== null && info.isFile() && !info.isSymbolicLink(), `${label} must be a regular non-symlink file`)
  return info
}

async function collectFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => null)
    assertContract(entries, 'build output directory is missing or unreadable')
    for (const entry of entries) {
      const absolute = path.resolve(current, entry.name)
      assertContract(!entry.isSymbolicLink(), 'build output contains a symbolic link')
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) files.push(path.relative(directory, absolute).split(path.sep).join('/'))
      else throw new Error('[single-service prestart] build output contains an unsupported entry')
    }
  }
  await walk(directory)
  return files.sort()
}

export async function validatePrestartFiles(root: string) {
  const envFile = path.join(root, '.env')
  const envInfo = await regularFile(envFile, '.env')
  assertContract((envInfo.mode & 0o777) === 0o600, '.env mode must be 0600')

  const dist = path.join(root, 'dist')
  const serverDist = path.join(root, 'server-dist')
  const indexFile = path.join(dist, 'index.html')
  const serverEntry = path.join(serverDist, 'index.js')
  await regularFile(indexFile, 'dist/index.html')
  await regularFile(serverEntry, 'server-dist/index.js')
  const [index, distFiles, serverFiles] = await Promise.all([
    readFile(indexFile, 'utf8'), collectFiles(dist), collectFiles(serverDist),
  ])
  assertContract(index.includes('<div id="root">'), 'Web build has no React root')
  assertContract(distFiles.some((file) => file.startsWith('assets/')), 'Web build has no assets')
  assertContract(serverFiles.includes('index.js'), 'server build has no unified entry')
  assertContract(![...distFiles, ...serverFiles].some((file) => /(^|\/)\.env(?:\.|$)/.test(file)), 'build output contains an environment file')
  await execFileAsync(process.execPath, ['--check', serverEntry], { cwd: root, maxBuffer: 1024 * 1024 })

  const pendingCandidate = await lstatIfExists(path.join(root, '.runtime', 'build-candidate.json'))
  assertContract(!pendingCandidate, 'a staged build candidate is still pending activation')
  return {
    distFiles: distFiles.length,
    serverFiles: serverFiles.length,
    distIndexSha256: createHash('sha256').update(await readFile(indexFile)).digest('hex'),
    serverEntrySha256: createHash('sha256').update(await readFile(serverEntry)).digest('hex'),
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const finish = (open: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

export async function assertPortsFree(ports: readonly number[]) {
  assertContract(ports.length > 0 && ports.every((port) => Number.isInteger(port) && port > 0 && port <= 65535), 'invalid port contract')
  const states = await Promise.all(ports.map(async (port) => ({ port, open: await portOpen(port) })))
  const occupied = states.filter((state) => state.open).map((state) => state.port)
  assertContract(occupied.length === 0, `required prestart ports are already listening: ${occupied.join(',')}`)
}

async function validateReadOnlyDatabase() {
  process.env.MIGRATION_WRITE_FREEZE = 'true'
  process.env.MIGRATION_WRITE_FREEZE_MODE = 'rollback-window'
  const [{ validateRuntimeConfiguration }, { assertSchemaReady }, { pool }, { mysqlConfig, mysqlTableName, quoteMysqlIdentifier }] = await Promise.all([
    import('../config/runtimeSafety.js'),
    import('../db/migrate.js'),
    import('../db/client.js'),
    import('../db/config.js'),
  ])
  try {
    const runtime = validateRuntimeConfiguration(process.env)
    assertContract(runtime.port === 3100, 'API_PORT must remain 3100 for the unified service')
    assertContract(mysqlConfig.port === 3306, 'DB_PORT must remain 3306 for the approved MySQL target')
    await assertSchemaReady()
    const connection = await pool.getConnection()
    try {
      const [sessionRows] = await connection.query<Array<RowDataPacket & { transactionReadOnly: number }>>(
        'SELECT @@SESSION.transaction_read_only AS transactionReadOnly',
      )
      assertContract(Number(sessionRows[0]?.transactionReadOnly) === 1, 'MySQL prestart session is not read-only')
      await connection.query('START TRANSACTION READ ONLY')
      const [journalRows] = await connection.query<Array<RowDataPacket & { count: number; latest: number }>>(
        `SELECT COUNT(*) AS count, MAX(created_at) AS latest FROM ${quoteMysqlIdentifier(mysqlTableName('__drizzle_migrations'))}`,
      )
      await connection.rollback()
      return {
        migrationCount: Number(journalRows[0]?.count || 0),
        latestMigrationPresent: Number(journalRows[0]?.latest || 0) > 0,
        sessionReadOnly: true,
        writeFreezeMode: runtime.migrationWriteFreeze.mode,
        runtimeMode: runtime.production ? 'production' : 'non-production',
      }
    } finally {
      connection.release()
    }
  } finally {
    await pool.end()
  }
}

async function writeEvidence(root: string, report: Record<string, unknown>) {
  const configuredDirectory = process.env.SINGLE_SERVICE_PRESTART_EVIDENCE_DIR?.trim()
  assertContract(!configuredDirectory || path.isAbsolute(configuredDirectory), 'SINGLE_SERVICE_PRESTART_EVIDENCE_DIR must be absolute')
  const directory = configuredDirectory
    ? path.resolve(configuredDirectory)
    : path.join(root, '.runtime', 'migration-evidence', 'single-service-prestart')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryInfo = await lstat(directory)
  assertContract(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink(), 'prestart evidence directory must be a non-symlink directory')
  await chmod(directory, 0o700)
  const target = path.join(directory, 'report.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, target)
}

export async function runSingleServicePrestart(root = path.resolve(process.cwd())) {
  await assertPortsFree(requiredPorts)
  const build = await validatePrestartFiles(root)
  const database = await validateReadOnlyDatabase()
  const report = {
    ok: true,
    checkedAt: new Date().toISOString(),
    checks: [
      'unified-and-retired-ports-free-before-start',
      'owner-only-runtime-environment',
      'paired-symlink-free-web-and-server-build',
      'unified-server-entry-syntax',
      'no-unactivated-build-candidate',
      'runtime-configuration-fail-closed',
      'mysql-3306-read-only-connectivity',
      'current-schema-journal-and-required-tables',
    ],
    build: { distFiles: build.distFiles, serverFiles: build.serverFiles },
    database,
    configuredValuesExcluded: true,
    pathsExcluded: true,
    databaseWrites: 0,
    processMutation: false,
    evidenceFilesWritten: 1,
  }
  await writeEvidence(root, report)
  console.log(JSON.stringify(report))
  return report
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invoked) {
  await runSingleServicePrestart().catch((error: unknown) => {
    console.error(JSON.stringify({
      ok: false,
      code: 'SINGLE_SERVICE_PRESTART_NOT_READY',
      message: error instanceof Error ? error.message.slice(0, 1_000) : 'unknown prestart error',
      configuredValuesExcluded: true,
      databaseWrites: 0,
      processMutation: false,
    }))
    process.exitCode = 2
  })
}
