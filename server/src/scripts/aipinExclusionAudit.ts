import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlConfig, quoteMysqlIdentifier } from '../db/config.js'

type Issue = {
  severity: 'blocking' | 'info'
  code: string
  detail: string
}

const strict = process.argv.includes('--strict')
const root = process.cwd()
const outputDir = path.resolve(process.env.AIPIN_EXCLUSION_OUTPUT_DIR || '.runtime/migration-evidence/aipin-exclusion')
const backupRoot = path.resolve(
  process.env.JW_MIGRATION_BACKUP_ROOT
    || '/Users/hyw/Desktop/sbl_jedi-migration-backup-20260808/jw-runtime',
)
const expectedBackupHashes = {
  'sessions.db': 'f7b4df01f3e04481860cd4d7d1c94a3ac18ec1bba5dfbecbb4541494fbbe8163',
  'project-master.db': '26659c5e74c1f277daa93a59c30716f05d2c20ec3cca70ee9064b2755e3bd77f',
  'lead-memory.sqlite': 'a7892beaf3dadcf859370ce086c70fc9cbf854747dd1ab011943f880bf236ccb',
} as const
const approvedPostgresTables = new Set([
  'users', 'projects', 'project_files', 'meetings', 'todos', 'risks', 'ai_summaries', 'leads',
  'lead_reserve', 'audit_logs', 'chat_conversations', 'file_chunks', 'knowledge_chunks',
  'ai_tasks', 'ai_artifacts', 'ai_task_sources', 'ai_custom_templates', 'radar_sync_state',
])
const approvedFlueTables = new Set([
  'flue_meta', 'flue_conversation_streams', 'flue_conversation_stream_batches',
  'flue_attachments', 'flue_attachment_chunks', 'flue_agent_attempt_markers',
  'flue_agent_dispatch_receipts', 'flue_agent_submissions', 'flue_event_stream_entries',
  'flue_event_stream_keys', 'flue_event_streams', 'flue_image_chunks', 'flue_runs', 'sqlite_sequence',
])
const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.sh'])

async function activeRuntimeFiles() {
  const files: string[] = []
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const absolute = path.resolve(directory, entry.name)
      if (entry.isDirectory()) {
        if (absolute === path.resolve(root, 'server/src/scripts')) continue
        await walk(absolute)
      } else if (textExtensions.has(path.extname(entry.name))) files.push(path.relative(root, absolute))
    }
  }
  await walk(path.resolve(root, 'server/src'))
  await walk(path.resolve(root, 'src'))
  files.push('deploy.sh', '.env.example')
  return files
}

function sqliteScalar(database: DatabaseSync, query: string): number {
  const row = database.prepare(query).get() as Record<string, unknown> | undefined
  return Number(row ? Object.values(row)[0] : 0)
}

function sqliteText(database: DatabaseSync, query: string): string {
  const row = database.prepare(query).get() as Record<string, unknown> | undefined
  return String(row ? Object.values(row)[0] : '')
}

function quotedNames(source: string, constantName: string): string[] {
  const match = source.match(new RegExp(`const\\s+${constantName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`))
  if (!match) return []
  return [...match[1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g)].map((item) => item[1])
}

async function main() {
  const issues: Issue[] = []
  const runtimeMatches: string[] = []
  for (const file of await activeRuntimeFiles()) {
    if (/aipin/i.test(await readFile(path.resolve(root, file), 'utf8'))) runtimeMatches.push(file)
  }
  if (runtimeMatches.length) issues.push({
    severity: 'blocking', code: 'ACTIVE_RUNTIME_REFERENCE',
    detail: `active runtime/config files contain excluded identity: ${runtimeMatches.join(', ')}`,
  })

  const environmentKeyMatches = Object.keys(process.env).filter((name) => /aipin/i.test(name)).sort()
  if (environmentKeyMatches.length) issues.push({
    severity: 'blocking', code: 'ENVIRONMENT_KEY_PRESENT',
    detail: `excluded environment key names are configured: ${environmentKeyMatches.join(', ')}`,
  })

  const [tableRows] = await pool.query<Array<RowDataPacket & { tableName: string }>>(
    `SELECT table_name AS tableName FROM information_schema.tables
     WHERE table_schema=? AND table_name LIKE ? ORDER BY table_name`,
    [mysqlConfig.database, `${mysqlConfig.tablePrefix}%`],
  )
  const excludedTargetTables = tableRows.map((row) => row.tableName).filter((name) => /aipin/i.test(name))
  if (excludedTargetTables.length) issues.push({
    severity: 'blocking', code: 'TARGET_TABLE_PRESENT',
    detail: `target MySQL contains excluded tables: ${excludedTargetTables.join(', ')}`,
  })

  const [textColumns] = await pool.query<Array<RowDataPacket & { tableName: string; columnName: string }>>(
    `SELECT table_name AS tableName, column_name AS columnName
     FROM information_schema.columns
     WHERE table_schema=? AND table_name LIKE ?
       AND data_type IN ('char','varchar','tinytext','text','mediumtext','longtext','json')
     ORDER BY table_name, ordinal_position`,
    [mysqlConfig.database, `${mysqlConfig.tablePrefix}%`],
  )
  const targetValueMatches: Array<{ table: string; column: string; rows: number }> = []
  const identityPattern = '(^|[^a-z0-9_])aipin([^a-z0-9_]|$)'
  const [patternRows] = await pool.query<Array<RowDataPacket & {
    exactIdentity: number; sourceIdentity: number; chineseIdentity: number; brandDomain: number; companyName: number
  }>>(
    `SELECT
       LOWER('aipin') REGEXP ? AS exactIdentity,
       LOWER('aipin-data-processing') REGEXP ? AS sourceIdentity,
       LOWER('Aipin项目') REGEXP ? AS chineseIdentity,
       LOWER('naipintx.com') REGEXP ? AS brandDomain,
       LOWER('Taiping Pharmaceutical') REGEXP ? AS companyName`,
    [identityPattern, identityPattern, identityPattern, identityPattern, identityPattern],
  )
  const patternControl = patternRows[0]
  if (Number(patternControl?.exactIdentity) !== 1 || Number(patternControl?.sourceIdentity) !== 1 || Number(patternControl?.chineseIdentity) !== 1
    || Number(patternControl?.brandDomain) !== 0 || Number(patternControl?.companyName) !== 0) {
    issues.push({ severity: 'blocking', code: 'IDENTITY_PATTERN_INVALID', detail: 'exact identity matcher failed positive or false-positive controls' })
  }
  for (const column of textColumns) {
    const [rows] = await pool.query<Array<RowDataPacket & { matches: number }>>(
      `SELECT COUNT(*) AS matches FROM ${quoteMysqlIdentifier(column.tableName)}
       WHERE LOWER(CAST(${quoteMysqlIdentifier(column.columnName)} AS CHAR))
         REGEXP ?`,
      [identityPattern],
    )
    const matches = Number(rows[0]?.matches || 0)
    if (matches) targetValueMatches.push({ table: column.tableName, column: column.columnName, rows: matches })
  }
  if (targetValueMatches.length) issues.push({
    severity: 'blocking', code: 'TARGET_VALUE_PRESENT',
    detail: `target MySQL contains excluded markers in ${targetValueMatches.length} table columns`,
  })

  const postgresOnlineSource = await readFile(path.resolve(root, 'server/src/scripts/migratePostgresToMySql.ts'), 'utf8')
  const postgresDumpSource = await readFile(path.resolve(root, 'server/src/scripts/migratePostgresDumpToMySql.ts'), 'utf8')
  const flueSource = await readFile(path.resolve(root, 'server/src/scripts/migrateFlueSqliteToMySql.ts'), 'utf8')
  const postgresTables = quotedNames(postgresOnlineSource, 'TABLE_ORDER')
  const dumpTables = quotedNames(postgresDumpSource, 'LOAD_ORDER')
  const flueRequired = quotedNames(flueSource, 'REQUIRED_TABLES')
  const flueKnownBlock = flueSource.match(/const KNOWN_TABLES = new Set\(\[([\s\S]*?)\]\)/)?.[1] || ''
  const flueKnown = [...flueRequired, ...[...flueKnownBlock.matchAll(/['"]([A-Za-z0-9_]+)['"]/g)].map((item) => item[1])]
  const unapprovedTables = [...postgresTables, ...dumpTables]
    .filter((name) => !approvedPostgresTables.has(name) || /aipin/i.test(name))
  const unapprovedFlueTables = flueKnown.filter((name) => !approvedFlueTables.has(name) || /aipin/i.test(name))
  if (!postgresTables.length || !dumpTables.length || unapprovedTables.length) issues.push({
    severity: 'blocking', code: 'POSTGRES_ALLOWLIST_INVALID',
    detail: `PostgreSQL importer allowlist is missing or unapproved: ${[...new Set(unapprovedTables)].join(', ') || 'not parsed'}`,
  })
  if (!flueRequired.length || unapprovedFlueTables.length
    || !/AIPIN_SOURCE_REJECTED/.test(flueSource) || !/AIPIN_TABLE_REJECTED/.test(flueSource)) issues.push({
    severity: 'blocking', code: 'FLUE_REJECTION_INVALID',
    detail: `Flue importer reject boundary is missing or unapproved: ${[...new Set(unapprovedFlueTables)].join(', ') || 'contract missing'}`,
  })

  const backupFiles: Record<string, { path: string; exists: boolean; sha256?: string; expectedSha256: string; integrity?: string }> = {}
  for (const [name, expectedSha256] of Object.entries(expectedBackupHashes)) {
    const file = path.resolve(backupRoot, name)
    const exists = Boolean((await stat(file).catch(() => null))?.isFile())
    const sha256 = exists ? createHash('sha256').update(await readFile(file)).digest('hex') : undefined
    backupFiles[name] = { path: file, exists, sha256, expectedSha256 }
    if (!exists || sha256 !== expectedSha256) issues.push({
      severity: 'blocking', code: 'JW_BACKUP_MISSING_OR_CHANGED', detail: `${name} is missing or its SHA-256 changed`,
    })
  }

  let sourceEvidence = {
    sessionIntegrity: 'missing', totalConversations: 0, excludedConversations: 0,
    nonExcludedConversations: 0, excludedMessages: 0, orphanMessages: 0,
    projectMasterIntegrity: 'missing', projectMasterRows: 0,
    leadMemoryIntegrity: 'missing', leadQueryCacheRows: 0, leadEntityRows: 0,
    leadEvidenceRows: 0, leadRelationRows: 0, leadSnapshotRows: 0,
  }
  if (Object.values(backupFiles).every((item) => item.exists && item.sha256 === item.expectedSha256)) {
    const sessions = new DatabaseSync(path.resolve(backupRoot, 'sessions.db'), { readOnly: true })
    const projects = new DatabaseSync(path.resolve(backupRoot, 'project-master.db'), { readOnly: true })
    const leads = new DatabaseSync(path.resolve(backupRoot, 'lead-memory.sqlite'), { readOnly: true })
    try {
      sourceEvidence = {
        sessionIntegrity: sqliteText(sessions, 'PRAGMA integrity_check'),
        totalConversations: sqliteScalar(sessions, 'SELECT COUNT(*) FROM agent_conversations'),
        excludedConversations: sqliteScalar(sessions, "SELECT COUNT(*) FROM agent_conversations WHERE LOWER(COALESCE(source,'')) LIKE '%aipin%'"),
        nonExcludedConversations: sqliteScalar(sessions, "SELECT COUNT(*) FROM agent_conversations WHERE LOWER(COALESCE(source,'')) NOT LIKE '%aipin%'"),
        excludedMessages: sqliteScalar(sessions, "SELECT COUNT(*) FROM agent_messages m JOIN agent_conversations c ON c.id=m.conversation_id WHERE LOWER(COALESCE(c.source,'')) LIKE '%aipin%'"),
        orphanMessages: sqliteScalar(sessions, 'SELECT COUNT(*) FROM agent_messages m LEFT JOIN agent_conversations c ON c.id=m.conversation_id WHERE c.id IS NULL'),
        projectMasterIntegrity: sqliteText(projects, 'PRAGMA integrity_check'),
        projectMasterRows: sqliteScalar(projects, 'SELECT COUNT(*) FROM project_master_records'),
        leadMemoryIntegrity: sqliteText(leads, 'PRAGMA integrity_check'),
        leadQueryCacheRows: sqliteScalar(leads, 'SELECT COUNT(*) FROM lead_queries'),
        leadEntityRows: sqliteScalar(leads, 'SELECT COUNT(*) FROM lead_entities'),
        leadEvidenceRows: sqliteScalar(leads, 'SELECT COUNT(*) FROM lead_evidence'),
        leadRelationRows: sqliteScalar(leads, 'SELECT COUNT(*) FROM lead_relations'),
        leadSnapshotRows: sqliteScalar(leads, 'SELECT COUNT(*) FROM lead_snapshots'),
      }
    } finally {
      sessions.close(); projects.close(); leads.close()
    }
    if (sourceEvidence.sessionIntegrity !== 'ok' || sourceEvidence.projectMasterIntegrity !== 'ok' || sourceEvidence.leadMemoryIntegrity !== 'ok') {
      issues.push({ severity: 'blocking', code: 'JW_BACKUP_INTEGRITY_FAILED', detail: 'one or more JW SQLite backups failed integrity_check' })
    }
    if (sourceEvidence.totalConversations !== sourceEvidence.excludedConversations
      || sourceEvidence.nonExcludedConversations !== 0
      || sourceEvidence.excludedMessages !== 2168
      || sourceEvidence.orphanMessages !== 0
      || sourceEvidence.projectMasterRows !== 0
      || sourceEvidence.leadEntityRows !== 0
      || sourceEvidence.leadEvidenceRows !== 0
      || sourceEvidence.leadRelationRows !== 0
      || sourceEvidence.leadSnapshotRows !== 0) {
      issues.push({ severity: 'blocking', code: 'JW_SOURCE_BASELINE_CHANGED', detail: 'JW source counts no longer match the reviewed exclusion baseline' })
    }
  }

  const blockingIssues = issues.filter((issue) => issue.severity === 'blocking').length
  const report = {
    generatedAt: new Date().toISOString(), strict, backupRoot,
    summary: {
      ok: blockingIssues === 0,
      blockingIssues,
      activeRuntimeFilesScanned: (await activeRuntimeFiles()).length,
      activeRuntimeMatches: runtimeMatches.length,
      environmentKeyMatches: environmentKeyMatches.length,
      targetTablesScanned: tableRows.length,
      targetTextColumnsScanned: textColumns.length,
      targetValueMatches: targetValueMatches.reduce((sum, item) => sum + item.rows, 0),
      reviewedSourceConversationsRejected: sourceEvidence.excludedConversations,
      reviewedSourceMessagesRejected: sourceEvidence.excludedMessages,
      targetRowsWrittenFromExcludedSource: targetValueMatches.reduce((sum, item) => sum + item.rows, 0),
    },
    sourceEvidence, backupFiles,
    migrationAllowlists: { postgresTables, dumpTables, flueTables: [...new Set(flueKnown)].sort() },
    identityPatternControl: patternControl,
    targetValueMatches,
    issues,
  }
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  await writeFile(path.resolve(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  const markdown = [
    '# Aipin 排除审计', '',
    `生成时间：${report.generatedAt}`, '',
    `结论：${report.summary.ok ? '通过' : '阻断'}`, '',
    `- 活动代码/配置扫描：${report.summary.activeRuntimeFilesScanned} 个文件，命中 ${report.summary.activeRuntimeMatches}`, 
    `- 环境变量名命中：${report.summary.environmentKeyMatches}`,
    `- 目标 MySQL：${report.summary.targetTablesScanned} 张表、${report.summary.targetTextColumnsScanned} 个文本/JSON 列，排除标记行 ${report.summary.targetValueMatches}`,
    `- JW 备份拒绝：${report.summary.reviewedSourceConversationsRejected} 个会话、${report.summary.reviewedSourceMessagesRejected} 条消息`,
    `- 写入目标的拒绝源记录：${report.summary.targetRowsWrittenFromExcludedSource}`,
    `- 阻断问题：${report.summary.blockingIssues}`, '',
    '审计只输出计数、表列名和哈希，不输出消息正文、密钥值或个人敏感内容。完整结构证据见 `report.json`。', '',
  ].join('\n')
  await writeFile(path.resolve(outputDir, 'summary.md'), markdown, { mode: 0o600 })
  console.log(JSON.stringify({ ok: report.summary.ok, strict, summary: report.summary, outputDir }))
  if (strict && !report.summary.ok) process.exitCode = 2
}

await main().finally(async () => pool.end())
