import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const backupRoot = path.resolve(
  process.env.MIGRATION_BACKUP_ROOT || '/Users/hyw/Desktop/sbl_jedi-migration-backup-20260808',
)
const postgresDump = path.resolve(process.env.PG_DUMP_PATH?.trim() || 'cybernaut_mvp_dump.sql')
const outputDir = path.resolve('.runtime/migration-evidence/legacy-source-backups')

const sqliteBackups = [
  {
    kind: 'jw-runtime',
    file: path.join(backupRoot, 'jw-runtime/sessions.db'),
    expectedSha256: 'f7b4df01f3e04481860cd4d7d1c94a3ac18ec1bba5dfbecbb4541494fbbe8163',
  },
  {
    kind: 'jw-project-master',
    file: path.join(backupRoot, 'jw-runtime/project-master.db'),
    expectedSha256: '26659c5e74c1f277daa93a59c30716f05d2c20ec3cca70ee9064b2755e3bd77f',
  },
  {
    kind: 'jw-lead-memory',
    file: path.join(backupRoot, 'jw-runtime/lead-memory.sqlite'),
    expectedSha256: 'a7892beaf3dadcf859370ce086c70fc9cbf854747dd1ab011943f880bf236ccb',
  },
  {
    kind: 'flue-data-candidate',
    file: path.join(backupRoot, 'flue-candidates/sbl_code-data-flue.db'),
    expectedSha256: '1d3a56f02881d8892916382266d4bb4464d102da4aa89723ff579964c2beeb9d',
  },
  {
    kind: 'flue-runtime-candidate',
    file: path.join(backupRoot, 'flue-candidates/sbl_code-runtime-flue.db'),
    expectedSha256: '51aa2a0d8cb74ca735e58c897f034e41b04b184a6d113137f4d40eb06f022589',
  },
] as const

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function sqliteInspection(file: string): {
  integrity: string
  tables: Array<{ table: string; rows: number; maxTimestamp: string | null }>
  tableCount: number
  rowCount: number
  maxTimestamp: string | null
} {
  const database = new DatabaseSync(file, { readOnly: true })
  try {
    const row = database.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined
    const tables = (database.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map(({ name }) => {
      const quotedName = `"${name.replaceAll('"', '""')}"`
      const countRow = database.prepare(`SELECT COUNT(*) AS count FROM ${quotedName}`).get() as { count?: number | bigint }
      const timeColumns = (database.prepare(`PRAGMA table_info(${quotedName})`).all() as Array<{ name: string }>)
        .map((column) => column.name)
        .filter((column) => /(?:^|_)(?:created|updated|started|ended|deleted|uploaded|recorded|modified|timestamp|time|at)(?:_|$)/i.test(column))
      const timestamps = timeColumns.flatMap((column) => {
        const quotedColumn = `"${column.replaceAll('"', '""')}"`
        const maximum = database.prepare(`SELECT MAX(${quotedColumn}) AS value FROM ${quotedName}`).get() as { value?: unknown }
        const raw = maximum.value
        if (raw == null || raw === '') return []
        const numeric = typeof raw === 'bigint' || typeof raw === 'number' ? Number(raw) : Number.NaN
        const milliseconds = Number.isFinite(numeric)
          ? (numeric < 100_000_000_000 ? numeric * 1000 : numeric)
          : Date.parse(String(raw))
        return Number.isFinite(milliseconds) ? [new Date(milliseconds).toISOString()] : []
      })
      return {
        table: name,
        rows: Number(countRow.count || 0),
        maxTimestamp: timestamps.sort().at(-1) || null,
      }
    })
    return {
      integrity: String(row ? Object.values(row)[0] : ''),
      tables,
      tableCount: tables.length,
      rowCount: tables.reduce((sum, table) => sum + table.rows, 0),
      maxTimestamp: tables.flatMap((table) => table.maxTimestamp ? [table.maxTimestamp] : []).sort().at(-1) || null,
    }
  } finally {
    database.close()
  }
}

function postgresCopyCounts(text: string): Array<{ table: string; rows: number; maxTimestamp: string | null }> {
  const counts: Array<{ table: string; rows: number; maxTimestamp: string | null }> = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^COPY public\.([A-Za-z0-9_]+) \(([^)]+)\) FROM stdin;$/)
    if (!match) continue
    const columns = match[2].split(',').map((column) => column.trim().replace(/^"|"$/g, ''))
    const timeIndexes = columns.map((column, columnIndex) => ({ column, columnIndex }))
      .filter(({ column }) => /(?:^|_)(?:created|updated|started|ended|deleted|uploaded|recorded|modified|timestamp|time|at)(?:_|$)/i.test(column))
      .map(({ columnIndex }) => columnIndex)
    let rows = 0
    let terminated = false
    let maxTimestamp: string | null = null
    for (index += 1; index < lines.length; index += 1) {
      if (lines[index] === String.raw`\.`) {
        terminated = true
        break
      }
      rows += 1
      const values = lines[index].split('\t')
      for (const timeIndex of timeIndexes) {
        const raw = values[timeIndex]
        if (!raw || raw === String.raw`\N`) continue
        const milliseconds = Date.parse(raw)
        if (!Number.isFinite(milliseconds)) continue
        const timestamp = new Date(milliseconds).toISOString()
        if (!maxTimestamp || timestamp > maxTimestamp) maxTimestamp = timestamp
      }
    }
    if (!terminated) throw new Error(`[legacy-source-backups] unterminated COPY block: ${match[1]}`)
    counts.push({ table: match[1], rows, maxTimestamp })
  }
  return counts.sort((left, right) => left.table.localeCompare(right.table))
}

async function writePrivate(file: string, value: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, file)
  await chmod(file, 0o600)
}

async function main() {
  const sqlite = await Promise.all(sqliteBackups.map(async (backup) => {
    const metadata = await lstat(backup.file)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`[legacy-source-backups] unsafe SQLite backup: ${backup.kind}`)
    }
    const actualSha256 = sha256(await readFile(backup.file))
    const inspection = sqliteInspection(backup.file)
    return {
      kind: backup.kind,
      fileName: path.basename(backup.file),
      bytes: metadata.size,
      mode: (metadata.mode & 0o777).toString(8).padStart(3, '0'),
      expectedSha256: backup.expectedSha256,
      actualSha256,
      hashMatches: actualSha256 === backup.expectedSha256,
      ...inspection,
      ownerOnly: (metadata.mode & 0o077) === 0,
    }
  }))
  const dumpMetadata = await lstat(postgresDump)
  if (!dumpMetadata.isFile() || dumpMetadata.isSymbolicLink()) {
    throw new Error('[legacy-source-backups] PostgreSQL dump is missing or unsafe')
  }
  const dumpBuffer = await readFile(postgresDump)
  const copyTables = postgresCopyCounts(dumpBuffer.toString('utf8'))
  const dump = {
    fileName: path.basename(postgresDump),
    bytes: dumpMetadata.size,
    sha256: sha256(dumpBuffer),
    copyTables,
    copyTableCount: copyTables.length,
    rowCount: copyTables.reduce((sum, table) => sum + table.rows, 0),
    maxTimestamp: copyTables.flatMap((table) => table.maxTimestamp ? [table.maxTimestamp] : []).sort().at(-1) || null,
  }
  const checks = {
    allSqliteBackupsPresentAndRegular: sqlite.length === sqliteBackups.length,
    allSqliteHashesMatchApprovedBaseline: sqlite.every((item) => item.hashMatches),
    allSqliteIntegrityChecksPass: sqlite.every((item) => item.integrity === 'ok'),
    allSqliteBackupsOwnerOnly: sqlite.every((item) => item.ownerOnly),
    postgresDumpHasExpectedCopyTables: dump.copyTableCount === 16,
    postgresDumpHasExpectedRows: dump.rowCount === 16_574,
  }
  const report = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    ok: Object.values(checks).every(Boolean),
    backupRoot,
    postgresDump: dump,
    sqlite,
    checks,
    scope: 'local discovered and approved backup candidates; not proof of complete production source inventory',
  }
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  await chmod(outputDir, 0o700)
  await writePrivate(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const summary = [
    '# 旧源备份验收',
    '',
    `生成时间：${report.generatedAt}`,
    '',
    `- PostgreSQL dump：${dump.copyTableCount} 个 COPY 表，${dump.rowCount} 行，最大时间 ${dump.maxTimestamp || '无'}，${dump.bytes} bytes，SHA-256 \`${dump.sha256}\``,
    `- SQLite 一致性备份：${sqlite.length} 个，哈希匹配 ${sqlite.filter((item) => item.hashMatches).length}/${sqlite.length}，integrity_check=ok ${sqlite.filter((item) => item.integrity === 'ok').length}/${sqlite.length}`,
    '- 范围限制：仅证明本机已发现并批准的备份候选，不证明生产部署机不存在其他数据源。',
    '',
    '## SQLite 备份',
    '',
    ...sqlite.map((item) => `- ${item.kind} / \`${item.fileName}\`：${item.tableCount} 表/${item.rowCount} 行，${item.bytes} bytes，mode ${item.mode}，SHA-256 匹配=${item.hashMatches}，integrity=${item.integrity}`),
    '',
  ].join('\n')
  await writePrivate(path.join(outputDir, 'summary.md'), summary)
  console.log(JSON.stringify({
    ok: report.ok,
    outputDir,
    postgresDump: {
      copyTableCount: dump.copyTableCount,
      rowCount: dump.rowCount,
      bytes: dump.bytes,
      sha256: dump.sha256,
      maxTimestamp: dump.maxTimestamp,
    },
    sqliteBackups: sqlite.map((item) => ({
      kind: item.kind,
      bytes: item.bytes,
      hashMatches: item.hashMatches,
      integrity: item.integrity,
      ownerOnly: item.ownerOnly,
      tableCount: item.tableCount,
      rowCount: item.rowCount,
      maxTimestamp: item.maxTimestamp,
    })),
    checks,
  }))
  if (!report.ok) process.exitCode = 2
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
