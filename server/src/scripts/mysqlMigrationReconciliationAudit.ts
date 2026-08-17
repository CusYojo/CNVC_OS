import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlConfig, quoteMysqlIdentifier } from '../db/config.js'
import { evaluateDumpTargetEvolution } from './postgresDumpReconciliationPolicy.js'

type ForeignKeyColumn = {
  constraintName: string
  tableName: string
  columnName: string
  referencedTableName: string
  referencedColumnName: string
  ordinalPosition: number
}

type Invariant = {
  id: string
  domain: string
  description: string
  violations: number
  blocking: boolean
}

type SourceTableEvidence = {
  table: string
  targetTable: string
  sourceRows: number | null
  targetRows: number | null
  read: number | null
  written: number | null
  skipped: number | null
  failed: number | null
  verifiedAtMigration: boolean
  evidence: 'live-source-count-only' | 'completed-migration-run' | 'unavailable'
}

type MigrationTableReport = {
  table?: unknown
  sourceRows?: unknown
  targetRowsAfter?: unknown
  readRows?: unknown
  writtenRows?: unknown
  skippedRows?: unknown
  failedRows?: unknown
  sourceHash?: unknown
  targetHash?: unknown
  status?: unknown
  sourceMissingInTarget?: unknown
  targetOnlyRows?: unknown
  changedSourceRows?: unknown
  changedColumns?: unknown
}

const SOURCE_TABLES = [
  'users', 'projects', 'project_files', 'meetings', 'todos', 'risks', 'ai_summaries', 'leads',
  'audit_logs', 'chat_conversations', 'file_chunks', 'knowledge_chunks', 'ai_tasks', 'ai_artifacts',
  'ai_task_sources', 'ai_custom_templates', 'radar_sync_state',
] as const
const DUMP_TABLES = [
  'users', 'projects', 'project_files', 'meetings', 'todos', 'risks', 'ai_summaries', 'leads',
  'lead_reserve', 'audit_logs', 'chat_conversations', 'file_chunks', 'knowledge_chunks',
  'ai_tasks', 'ai_artifacts', 'ai_task_sources',
] as const
const outputDir = path.resolve(process.cwd(), '.runtime/migration-evidence/mysql-reconciliation')
const strictTarget = process.argv.includes('--strict-target')
const strictFull = process.argv.includes('--strict-full')

function table(baseName: string): string {
  return quoteMysqlIdentifier(`${mysqlConfig.tablePrefix}${baseName}`)
}

function safeError(error: unknown): { code: string; message: string } {
  const value = error as Error & { code?: string }
  const code = value.code ?? 'SOURCE_UNAVAILABLE'
  const message = code === 'ECONNREFUSED'
    ? 'configured PostgreSQL source refused the connection'
    : code === 'ETIMEDOUT'
      ? 'configured PostgreSQL source timed out'
      : 'configured PostgreSQL source could not be inventoried'
  return { code, message }
}

function parseJsonCounts(value: unknown): Record<string, number> {
  if (!value) return {}
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return Object.fromEntries(Object.entries(parsed).flatMap(([key, item]) => {
    const count = Number(item)
    return Number.isFinite(count) && count >= 0 ? [[key, count]] : []
  }))
}

function parseMigrationTableReports(value: unknown): Record<string, MigrationTableReport> {
  if (!value) return {}
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const tables = (parsed as { tables?: unknown }).tables
  if (!Array.isArray(tables)) return {}
  return Object.fromEntries(tables.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const report = item as MigrationTableReport
    return typeof report.table === 'string' ? [[report.table, report]] : []
  }))
}

async function queryCount(sql: string, params: unknown[] = []): Promise<number> {
  const [rows] = await pool.query<Array<RowDataPacket & { count: number | string }>>(sql, params)
  return Number(rows[0]?.count ?? 0)
}

async function sourceInventory(): Promise<{
  configured: boolean
  reachable: boolean
  transaction: 'read-only' | null
  identitySha256: string | null
  error: { code: string; message: string } | null
  counts: Record<string, number>
  missingExpectedTables: string[]
}> {
  const sourceUrl = process.env.DATABASE_URL?.trim()
  if (!sourceUrl) return {
    configured: false, reachable: false, transaction: null,
    identitySha256: null,
    error: { code: 'DATABASE_URL_MISSING', message: 'PostgreSQL source is not configured' },
    counts: {}, missingExpectedTables: [...SOURCE_TABLES],
  }
  const client = new pg.Client({
    connectionString: sourceUrl,
    application_name: 'sbl_mysql_reconciliation_audit',
    connectionTimeoutMillis: 3_000,
    statement_timeout: 30_000,
    query_timeout: 35_000,
  })
  const identitySha256 = createHash('sha256').update(sourceUrl).digest('hex')
  try {
    await client.connect()
    await client.query('BEGIN READ ONLY')
    const tables = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'
    `)
    const available = new Set(tables.rows.map((row) => row.table_name))
    const counts: Record<string, number> = {}
    for (const sourceTable of SOURCE_TABLES) {
      if (!available.has(sourceTable)) continue
      const result = await client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM public."${sourceTable}"`)
      counts[sourceTable] = Number(result.rows[0]?.count ?? 0)
    }
    await client.query('ROLLBACK')
    return {
      configured: true, reachable: true, transaction: 'read-only', identitySha256, error: null, counts,
      missingExpectedTables: SOURCE_TABLES.filter((name) => !available.has(name)),
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    return {
      configured: true, reachable: false, transaction: null, identitySha256, error: safeError(error),
      counts: {}, missingExpectedTables: [...SOURCE_TABLES],
    }
  } finally {
    await client.end().catch(() => undefined)
  }
}

async function dumpInventory(): Promise<{
  available: boolean; fileName: string; sha256: string | null;
  tables: Array<{ table: string; rows: number; rawCopySha256: string }>;
  missingExpectedTables: string[]; error: string | null
}> {
  const dumpPath = path.resolve(process.env.PG_DUMP_PATH?.trim() || 'cybernaut_mvp_dump.sql')
  try {
    const buffer = await readFile(dumpPath)
    const lines = buffer.toString('utf8').split('\n')
    const wanted = new Set<string>(DUMP_TABLES)
    const counts = new Map<string, number>()
    const hashes = new Map<string, ReturnType<typeof createHash>>()
    let active: string | null = null
    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (!active) {
        const match = line.match(/^COPY public\.([A-Za-z0-9_]+) \([^)]+\) FROM stdin;$/)
        if (match && wanted.has(match[1])) {
          active = match[1]
          counts.set(active, 0)
          hashes.set(active, createHash('sha256'))
        }
        continue
      }
      if (line === String.raw`\.`) {
        active = null
        continue
      }
      counts.set(active, (counts.get(active) ?? 0) + 1)
      hashes.get(active)!.update(`${line}\n`)
    }
    const missingExpectedTables = DUMP_TABLES.filter((name) => !counts.has(name))
    return {
      available: true, fileName: path.basename(dumpPath),
      sha256: createHash('sha256').update(buffer).digest('hex'),
      tables: DUMP_TABLES.filter((name) => counts.has(name)).map((name) => ({
        table: name, rows: counts.get(name)!, rawCopySha256: hashes.get(name)!.digest('hex'),
      })),
      missingExpectedTables, error: null,
    }
  } catch (error) {
    return {
      available: false, fileName: path.basename(dumpPath), sha256: null, tables: [],
      missingExpectedTables: [...DUMP_TABLES], error: (error as NodeJS.ErrnoException).code ?? 'DUMP_UNAVAILABLE',
    }
  }
}

async function dumpPreviewEvidence(sourceSha256: string | null): Promise<{
  available: boolean
  tables: Record<string, MigrationTableReport>
}> {
  if (!sourceSha256) return { available: false, tables: {} }
  try {
    const report = JSON.parse(await readFile(path.resolve(
      process.cwd(), '.runtime/migration-evidence/postgres-dump', `${sourceSha256}.json`,
    ), 'utf8')) as { sourceSha256?: unknown; tables?: unknown }
    if (report.sourceSha256 !== sourceSha256 || !Array.isArray(report.tables)) return { available: false, tables: {} }
    return {
      available: true,
      tables: Object.fromEntries(report.tables.flatMap((item) => {
        if (!item || typeof item !== 'object' || typeof (item as MigrationTableReport).table !== 'string') return []
        return [[String((item as MigrationTableReport).table), item as MigrationTableReport]]
      })),
    }
  } catch {
    return { available: false, tables: {} }
  }
}

async function flueSourceEvidence(): Promise<Array<{
  fileName: string; sourceSha256: string; fileIntegrity: boolean; mode: string; applied: boolean;
  readyToApply: boolean; sourceCounts: Record<string, number>; targetCounts: Record<string, number>;
  selectedCounts: Record<string, number>; excludedDisposition: string | null; excludedCounts: Record<string, number>;
  sourceChecksum: string | null; targetChecksum: string | null; errors: number;
  issues: Array<{ code: string; sourceTable: string | null }>
}>> {
  const directory = path.resolve(process.cwd(), '.runtime/migration-evidence/flue-sources')
  try {
    const entries = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort()
    const result = []
    for (const entry of entries) {
      const raw = JSON.parse(await readFile(path.resolve(directory, entry), 'utf8')) as Record<string, unknown>
      const sourcePath = String(raw.source ?? '')
      const sourceSha256 = String(raw.sourceSha256 ?? '')
      let fileIntegrity = false
      try {
        const sourceBuffer = await readFile(sourcePath)
        fileIntegrity = createHash('sha256').update(sourceBuffer).digest('hex') === sourceSha256
      } catch {
        fileIntegrity = false
      }
      const issues = Array.isArray(raw.issues) ? raw.issues.flatMap((issue) => {
        if (!issue || typeof issue !== 'object') return []
        const item = issue as Record<string, unknown>
        return [{ code: String(item.code ?? 'UNKNOWN'), sourceTable: item.sourceTable ? String(item.sourceTable) : null }]
      }) : []
      result.push({
        fileName: path.basename(sourcePath), sourceSha256, fileIntegrity,
        mode: String(raw.mode ?? 'unknown'), applied: raw.applied === true,
        readyToApply: raw.readyToApply === true,
        sourceCounts: parseJsonCounts(raw.sourceCounts), targetCounts: parseJsonCounts(raw.targetCounts),
        selectedCounts: parseJsonCounts(raw.selectedCounts),
        excludedDisposition: typeof (raw.excludedSource as { disposition?: unknown } | undefined)?.disposition === 'string'
          ? String((raw.excludedSource as { disposition: string }).disposition) : null,
        excludedCounts: parseJsonCounts((raw.excludedSource as { counts?: unknown } | undefined)?.counts),
        sourceChecksum: typeof raw.sourceChecksum === 'string' ? raw.sourceChecksum : null,
        targetChecksum: typeof raw.targetChecksum === 'string' ? raw.targetChecksum : null,
        errors: Number((raw.issueCounts as { errors?: unknown } | undefined)?.errors ?? 0), issues,
      })
    }
    return result
  } catch {
    return []
  }
}

async function jwExclusionEvidence(): Promise<{ available: boolean; ready: boolean; rejectedConversations: number; rejectedMessages: number }> {
  try {
    const report = JSON.parse(await readFile(
      path.resolve(process.cwd(), '.runtime/migration-evidence/aipin-exclusion/report.json'), 'utf8',
    )) as { summary?: Record<string, unknown> }
    const summary = report.summary ?? {}
    return {
      available: true,
      ready: summary.ok === true && Number(summary.blockingIssues ?? -1) === 0,
      rejectedConversations: Number(summary.reviewedSourceConversationsRejected ?? 0),
      rejectedMessages: Number(summary.reviewedSourceMessagesRejected ?? 0),
    }
  } catch {
    return { available: false, ready: false, rejectedConversations: 0, rejectedMessages: 0 }
  }
}

async function productionSourceInventoryEvidence(
  expectedDumpSha256: string | null,
  expectedFlueSha256: string[],
): Promise<{
  available: boolean; ready: boolean; environment: string | null; hostIdentity: string | null;
  generatedAt: string | null; scannedRoots: number; unexpectedSources: number; reason: string | null
}> {
  try {
    const report = JSON.parse(await readFile(path.resolve(
      process.cwd(), '.runtime/migration-evidence/production-source-inventory/report.json',
    ), 'utf8')) as Record<string, unknown>
    const flueSourceSha256 = Array.isArray(report.flueSourceSha256)
      ? report.flueSourceSha256.map(String).sort() : []
    const expectedFlue = [...expectedFlueSha256].sort()
    const scannedRoots = Array.isArray(report.scannedRoots) ? report.scannedRoots.length : 0
    const unexpectedSources = Array.isArray(report.unexpectedSources) ? report.unexpectedSources.length : -1
    const skippedSymlinks = Array.isArray(report.skippedSymlinks) ? report.skippedSymlinks.length : -1
    const environment = typeof report.environment === 'string' ? report.environment : null
    const hostIdentity = typeof report.hostIdentity === 'string' ? report.hostIdentity : null
    const generatedAt = typeof report.generatedAt === 'string' ? report.generatedAt : null
    const hashesMatch = expectedDumpSha256 !== null
      && report.postgresDumpSha256 === expectedDumpSha256
      && JSON.stringify(flueSourceSha256) === JSON.stringify(expectedFlue)
    const approved = report.approved === true && typeof report.approvedBy === 'string'
      && report.approvedBy.trim().length > 0
    const ready = report.schemaVersion === '1.0' && environment === 'production'
      && Boolean(hostIdentity?.trim()) && Boolean(generatedAt) && scannedRoots > 0
      && unexpectedSources === 0 && skippedSymlinks === 0 && hashesMatch && approved
    return {
      available: true, ready, environment, hostIdentity, generatedAt, scannedRoots,
      unexpectedSources, reason: ready ? null : 'production source inventory is incomplete, changed, or not approved',
    }
  } catch {
    return {
      available: false, ready: false, environment: null, hostIdentity: null, generatedAt: null,
      scannedRoots: 0, unexpectedSources: -1,
      reason: 'production source inventory evidence is missing',
    }
  }
}

async function main(): Promise<void> {
  const schemaSource = await readFile(path.resolve(process.cwd(), 'server/src/db/schema.ts'), 'utf8')
  const codeTables = [...schemaSource.matchAll(/mysqlTable\('([a-z0-9_]+)'/g)].map((match) => match[1]).sort()
  const [tableRows] = await pool.query<Array<RowDataPacket & { tableName: string; tableRows: number | string }>>(`
    SELECT TABLE_NAME AS tableName, TABLE_ROWS AS tableRows
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' AND TABLE_NAME LIKE ?
    ORDER BY TABLE_NAME
  `, [mysqlConfig.database, `${mysqlConfig.tablePrefix}%`])
  const targetPhysicalTables = tableRows.map((row) => String(row.tableName))
  const targetBaseTables = targetPhysicalTables.map((name) => name.slice(mysqlConfig.tablePrefix.length))
  const internalTargetTables = targetBaseTables.filter((name) => name.startsWith('__drizzle_'))
  const targetApplicationTables = targetBaseTables.filter((name) => !internalTargetTables.includes(name))
  const targetTableSet = new Set(targetApplicationTables)
  const codeTableSet = new Set(codeTables)
  const missingTargetTables = codeTables.filter((name) => !targetTableSet.has(name))
  const unexpectedTargetTables = targetApplicationTables.filter((name) => !codeTableSet.has(name))

  const [primaryRows] = await pool.query<Array<RowDataPacket & {
    tableName: string; indexName: string; columnName: string; sequence: number
  }>>(`
    SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName, COLUMN_NAME AS columnName,
           SEQ_IN_INDEX AS sequence
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE ? AND NON_UNIQUE=0
    ORDER BY TABLE_NAME, CASE WHEN INDEX_NAME='PRIMARY' THEN 0 ELSE 1 END, INDEX_NAME, SEQ_IN_INDEX
  `, [mysqlConfig.database, `${mysqlConfig.tablePrefix}%`])
  const uniqueKeys = new Map<string, { name: string; columns: string[] }>()
  for (const row of primaryRows) {
    const current = uniqueKeys.get(row.tableName)
    if (!current) uniqueKeys.set(row.tableName, { name: row.indexName, columns: [row.columnName] })
    else if (current.name === row.indexName) current.columns.push(row.columnName)
  }

  const targetCounts: Record<string, number> = {}
  const targetTables: Array<{
    table: string; rows: number; keyColumns: string[]; keySha256: string | null
  }> = []
  for (const physicalName of targetPhysicalTables) {
    const baseName = physicalName.slice(mysqlConfig.tablePrefix.length)
    const rows = await queryCount(`SELECT COUNT(*) AS count FROM ${quoteMysqlIdentifier(physicalName)}`)
    targetCounts[baseName] = rows
    const uniqueKey = uniqueKeys.get(physicalName)
    let keySha256: string | null = null
    if (uniqueKey?.columns.length) {
      const projection = uniqueKey.columns.map(quoteMysqlIdentifier).join(', ')
      const order = uniqueKey.columns.map(quoteMysqlIdentifier).join(', ')
      const [keys] = await pool.query<RowDataPacket[]>(
        `SELECT ${projection} FROM ${quoteMysqlIdentifier(physicalName)} ORDER BY ${order}`,
      )
      const hash = createHash('sha256')
      for (const row of keys) hash.update(`${JSON.stringify(uniqueKey.columns.map((column) => row[column]))}\n`)
      keySha256 = hash.digest('hex')
    }
    targetTables.push({ table: baseName, rows, keyColumns: uniqueKey?.columns ?? [], keySha256 })
  }

  const [fkRows] = await pool.query<RowDataPacket[]>(`
    SELECT CONSTRAINT_NAME AS constraintName, TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
           REFERENCED_TABLE_NAME AS referencedTableName, REFERENCED_COLUMN_NAME AS referencedColumnName,
           ORDINAL_POSITION AS ordinalPosition
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA=? AND REFERENCED_TABLE_NAME IS NOT NULL AND TABLE_NAME LIKE ?
    ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION
  `, [mysqlConfig.database, `${mysqlConfig.tablePrefix}%`])
  const fkGroups = new Map<string, ForeignKeyColumn[]>()
  for (const raw of fkRows) {
    const column: ForeignKeyColumn = {
      constraintName: String(raw.constraintName), tableName: String(raw.tableName),
      columnName: String(raw.columnName), referencedTableName: String(raw.referencedTableName),
      referencedColumnName: String(raw.referencedColumnName), ordinalPosition: Number(raw.ordinalPosition),
    }
    const key = `${column.tableName}\u0000${column.constraintName}`
    fkGroups.set(key, [...(fkGroups.get(key) ?? []), column])
  }
  const foreignKeys: Array<{
    constraint: string; table: string; columns: string[]; referencedTable: string;
    referencedColumns: string[]; orphanRows: number
  }> = []
  for (const columns of fkGroups.values()) {
    const first = columns[0]
    const join = columns.map((column) => `c.${quoteMysqlIdentifier(column.columnName)}=p.${quoteMysqlIdentifier(column.referencedColumnName)}`).join(' AND ')
    const present = columns.map((column) => `c.${quoteMysqlIdentifier(column.columnName)} IS NOT NULL`).join(' AND ')
    const missing = `p.${quoteMysqlIdentifier(first.referencedColumnName)} IS NULL`
    const orphanRows = await queryCount(
      `SELECT COUNT(*) AS count FROM ${quoteMysqlIdentifier(first.tableName)} c LEFT JOIN ${quoteMysqlIdentifier(first.referencedTableName)} p ON ${join} WHERE ${present} AND ${missing}`,
    )
    foreignKeys.push({
      constraint: first.constraintName,
      table: first.tableName.slice(mysqlConfig.tablePrefix.length),
      columns: columns.map((column) => column.columnName),
      referencedTable: first.referencedTableName.slice(mysqlConfig.tablePrefix.length),
      referencedColumns: columns.map((column) => column.referencedColumnName),
      orphanRows,
    })
  }

  const invariantDefinitions: Array<Omit<Invariant, 'violations'>> = [
    { id: 'project-owner-membership', domain: 'identity', description: '已绑定负责人必须拥有项目 owner 成员关系', blocking: true },
    { id: 'open-identity-resolution', domain: 'identity', description: '姓名到稳定用户 ID 的未决冲突', blocking: true },
    { id: 'agent-message-sequence-unique', domain: 'conversation', description: '同一会话内消息 sequence 不得重复', blocking: true },
    { id: 'agent-part-order-contiguous', domain: 'conversation', description: '消息 part_index 必须从 0 连续排列', blocking: true },
    { id: 'ai-task-conversation-binding', domain: 'ai', description: 'AI 任务会话必须与用户和项目一致', blocking: true },
    { id: 'ai-artifact-task-binding', domain: 'ai', description: 'AI 产物的用户、项目、会话必须与任务一致', blocking: true },
    { id: 'ai-source-artifact-binding', domain: 'ai', description: 'AI 来源关联的产物必须属于同一任务', blocking: true },
    { id: 'pipeline-ready-has-lead', domain: 'lead', description: 'ready/accepted/converted Pipeline 项必须关联线索', blocking: true },
    { id: 'pipeline-evidence-event-binding', domain: 'lead', description: '证据 event_id 必须与所属决策一致', blocking: true },
    { id: 'pipeline-review-event-binding', domain: 'lead', description: '评审触发/解决决策必须属于同一事件', blocking: true },
    { id: 'pipeline-entity-match-event-binding', domain: 'lead', description: '实体匹配候选、复核和解决决策必须属于同一原始事件', blocking: true },
    { id: 'lead-reserve-missing-detail', domain: 'source', description: '储备池记录必须具备可迁移的 detail_json，或有精确批准的永久隔离处置', blocking: true },
    { id: 'lead-reserve-missing-detail-quarantine', domain: 'source', description: '缺失原始详情的储备记录必须处于 source_missing 隔离状态并有成功迁移问题台账', blocking: true },
    { id: 'lead-reserve-imported-link', domain: 'lead', description: '已导入储备记录必须绑定正式线索', blocking: true },
    { id: 'lead-reserve-raw-event-coverage', domain: 'lead', description: '有详情的储备记录必须进入不可变 Pipeline 原始事件', blocking: true },
    { id: 'radar-candidate-has-raw-event', domain: 'radar', description: 'Radar 当前候选必须存在同来源同内容原始事件', blocking: true },
    { id: 'project-file-current-version', domain: 'file', description: '已有 storage_path 的项目文件必须存在一致的当前版本记录', blocking: true },
    { id: 'project-file-original-missing', domain: 'file', description: '项目文件缺少 storage_path 且没有精确批准缺失处置', blocking: true },
    { id: 'project-file-missing-quarantine', domain: 'file', description: '缺少原件的项目文件必须保留成功迁移问题台账', blocking: true },
    { id: 'ai-artifact-source-file-missing', domain: 'source', description: 'AI 产物旧机器源文件必须恢复，或有精确批准的永久归档处置', blocking: true },
    { id: 'ai-artifact-legacy-absolute-path', domain: 'file', description: '在线可见 AI 产物仍指向旧用户目录绝对路径', blocking: true },
    { id: 'ai-artifact-missing-quarantine', domain: 'file', description: '缺少源文件的 AI 产物必须隐藏并保留成功迁移问题台账', blocking: true },
    { id: 'migration-run-incomplete', domain: 'migration', description: '迁移运行台账存在未收口的 running 状态', blocking: true },
    { id: 'cdc-checkpoint-watermark-order', domain: 'migration', description: 'CDC 检查点、源安全 watermark 和观测 watermark 必须单调且完成态已追平', blocking: true },
    { id: 'cdc-event-checkpoint-bound', domain: 'migration', description: 'CDC 已应用事件 sequence 不得超过所属目标检查点', blocking: true },
    { id: 'cdc-event-counter-coherence', domain: 'migration', description: 'CDC 插入、更新、删除计数必须与唯一事件账本一致', blocking: true },
    { id: 'cdc-tombstone-coherence', domain: 'migration', description: 'CDC tombstone 和级联标记必须只绑定删除事件', blocking: true },
  ]
  const invariantSql: Record<string, string> = {
    'project-owner-membership': `SELECT COUNT(*) count FROM ${table('projects')} p WHERE p.owner_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${table('project_members')} m WHERE m.project_id=p.id AND m.user_id=p.owner_user_id AND m.member_role='owner')`,
    'open-identity-resolution': `SELECT COUNT(*) count FROM ${table('identity_resolution_issues')} WHERE status='open'`,
    'agent-message-sequence-unique': `SELECT COUNT(*) count FROM (SELECT conversation_id,sequence FROM ${table('agent_messages')} GROUP BY conversation_id,sequence HAVING COUNT(*)>1) x`,
    'agent-part-order-contiguous': `SELECT COUNT(*) count FROM (SELECT message_id FROM ${table('agent_message_parts')} GROUP BY message_id HAVING MIN(part_index)<>0 OR MAX(part_index)<>COUNT(*)-1) x`,
    'ai-task-conversation-binding': `SELECT COUNT(*) count FROM ${table('ai_tasks')} t LEFT JOIN ${table('agent_conversations')} c ON c.id=t.conversation_id WHERE t.conversation_id IS NOT NULL AND (c.id IS NULL OR c.user_id<>t.user_id OR c.project_id<>t.project_id)`,
    'ai-artifact-task-binding': `SELECT COUNT(*) count FROM ${table('ai_artifacts')} a JOIN ${table('ai_tasks')} t ON t.id=a.task_id WHERE a.user_id<>t.user_id OR a.project_id<>t.project_id OR NOT (a.conversation_id <=> t.conversation_id)`,
    'ai-source-artifact-binding': `SELECT COUNT(*) count FROM ${table('ai_task_sources')} s JOIN ${table('ai_artifacts')} a ON a.id=s.artifact_id WHERE s.artifact_id IS NOT NULL AND s.task_id<>a.task_id`,
    'pipeline-ready-has-lead': `SELECT COUNT(*) count FROM ${table('lead_pipeline_items')} WHERE status IN ('ready','accepted','converted') AND lead_id IS NULL`,
    'pipeline-evidence-event-binding': `SELECT COUNT(*) count FROM ${table('lead_pipeline_evidence')} e JOIN ${table('lead_pipeline_decisions')} d ON d.id=e.decision_id WHERE e.event_id<>d.event_id`,
    'pipeline-review-event-binding': `SELECT COUNT(*) count FROM ${table('lead_pipeline_reviews')} r JOIN ${table('lead_pipeline_decisions')} d ON d.id=r.trigger_decision_id LEFT JOIN ${table('lead_pipeline_decisions')} rd ON rd.id=r.resolution_decision_id WHERE r.event_id<>d.event_id OR (rd.id IS NOT NULL AND r.event_id<>rd.event_id)`,
    'pipeline-entity-match-event-binding': `SELECT COUNT(*) count FROM ${table('lead_pipeline_entity_matches')} m LEFT JOIN ${table('lead_pipeline_decisions')} d ON d.id=m.decision_id LEFT JOIN ${table('lead_pipeline_reviews')} r ON r.id=m.review_id LEFT JOIN ${table('lead_pipeline_decisions')} rd ON rd.id=m.resolution_decision_id WHERE (d.id IS NOT NULL AND d.event_id<>m.event_id) OR (r.id IS NOT NULL AND r.event_id<>m.event_id) OR (rd.id IS NOT NULL AND rd.event_id<>m.event_id)`,
    'lead-reserve-missing-detail': `SELECT COUNT(*) count FROM ${table('lead_reserve')} r WHERE r.detail_json IS NULL AND NOT EXISTS (SELECT 1 FROM ${table('migration_issues')} i JOIN ${table('migration_runs')} mr ON mr.id=i.run_id WHERE i.source_system='business_decision' AND i.source_table='lead_reserve' AND CAST(i.source_key AS UNSIGNED)=r.id AND i.code='LEAD_RESERVE_PERMANENT_SOURCE_GAP_APPROVED' AND mr.migration_type='lead-reserve-source-gap-disposition' AND mr.status='succeeded' AND JSON_UNQUOTE(JSON_EXTRACT(i.payload,'$.disposition'))='approved-permanent-quarantine' AND JSON_UNQUOTE(JSON_EXTRACT(i.payload,'$.sourceKeySha256'))=SHA2(COALESCE(NULLIF(r.src_id,''),CONCAT('row:',r.id)),256))`,
    'lead-reserve-missing-detail-quarantine': `SELECT COUNT(*) count FROM ${table('lead_reserve')} r WHERE r.detail_json IS NULL AND (r.score_status<>'source_missing' OR NOT EXISTS (SELECT 1 FROM ${table('migration_issues')} i JOIN ${table('migration_runs')} mr ON mr.id=i.run_id WHERE i.source_system='postgres_dump' AND i.source_table='lead_reserve' AND CAST(i.source_key AS UNSIGNED)=r.id AND i.code='LEAD_RESERVE_SOURCE_DETAIL_MISSING' AND mr.migration_type='lead-reserve-missing-detail-quarantine' AND mr.status='succeeded'))`,
    'lead-reserve-imported-link': `SELECT COUNT(*) count FROM ${table('lead_reserve')} WHERE imported=1 AND imported_lead_id IS NULL`,
    'lead-reserve-raw-event-coverage': `SELECT COUNT(*) count FROM ${table('lead_reserve')} r WHERE r.detail_json IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${table('lead_pipeline_raw_events')} e WHERE e.source_type='lead_reserve' AND CAST(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.reserveId')) AS UNSIGNED)=r.id)`,
    'radar-candidate-has-raw-event': `SELECT COUNT(*) count FROM ${table('radar_candidates')} c WHERE NOT EXISTS (SELECT 1 FROM ${table('radar_raw_events')} e WHERE e.source_key_hash=c.source_key_hash AND e.content_hash=c.content_hash)`,
    'project-file-current-version': `SELECT COUNT(*) count FROM ${table('project_files')} f WHERE f.storage_path IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${table('project_file_versions')} v WHERE v.file_id=f.id AND v.version=f.version AND v.storage_path=f.storage_path AND (v.sha256 <=> f.sha256) AND v.byte_size=f.byte_size)`,
    'project-file-original-missing': `SELECT COUNT(*) count FROM ${table('project_files')} f WHERE (f.storage_path IS NULL OR TRIM(f.storage_path)='') AND NOT EXISTS (SELECT 1 FROM ${table('migration_issues')} i JOIN ${table('migration_runs')} mr ON mr.id=i.run_id WHERE i.source_system='business_decision' AND i.source_table='project_files' AND BINARY i.source_key=BINARY f.id AND i.code='PROJECT_FILE_SOURCE_FILE_MISSING_APPROVED' AND mr.migration_type='project-file-missing-disposition' AND mr.status='succeeded')`,
    'project-file-missing-quarantine': `SELECT COUNT(*) count FROM ${table('project_files')} f WHERE (f.storage_path IS NULL OR TRIM(f.storage_path)='') AND NOT EXISTS (SELECT 1 FROM ${table('migration_issues')} i JOIN ${table('migration_runs')} mr ON mr.id=i.run_id WHERE i.source_system='postgres_dump' AND i.source_table='project_files' AND BINARY i.source_key=BINARY f.id AND i.code='PROJECT_FILE_SOURCE_FILE_MISSING' AND mr.migration_type='missing-file-asset-quarantine' AND mr.status='succeeded')`,
    'ai-artifact-source-file-missing': `SELECT COUNT(*) count FROM ${table('ai_artifacts')} a JOIN ${table('ai_tasks')} t ON t.id=a.task_id WHERE a.storage_path REGEXP '^/Users/[^/]+/' AND NOT EXISTS (SELECT 1 FROM ${table('migration_issues')} i JOIN ${table('migration_runs')} mr ON mr.id=i.run_id WHERE i.source_system='business_decision' AND i.source_table='ai_artifacts' AND BINARY i.source_key=BINARY a.id AND i.code='AI_ARTIFACT_PERMANENT_SOURCE_GAP_APPROVED' AND mr.migration_type='ai-artifact-source-gap-disposition' AND mr.status='succeeded' AND JSON_UNQUOTE(JSON_EXTRACT(i.payload,'$.disposition'))='approved-permanent-archive' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(i.payload,'$.taskType'))=BINARY t.type AND BINARY JSON_UNQUOTE(JSON_EXTRACT(i.payload,'$.format'))=BINARY a.format AND JSON_UNQUOTE(JSON_EXTRACT(i.payload,'$.taskIdSha256'))=SHA2(a.task_id,256) AND JSON_UNQUOTE(JSON_EXTRACT(i.payload,'$.userIdSha256'))=SHA2(a.user_id,256) AND JSON_UNQUOTE(JSON_EXTRACT(i.payload,'$.projectIdSha256'))=SHA2(a.project_id,256) AND JSON_UNQUOTE(JSON_EXTRACT(i.payload,'$.fileNameSha256'))=SHA2(a.file_name,256) AND JSON_UNQUOTE(JSON_EXTRACT(i.payload,'$.storagePathSha256'))=SHA2(a.storage_path,256) AND BINARY JSON_UNQUOTE(JSON_EXTRACT(i.payload,'$.qualityStatus'))=BINARY a.quality_status AND CAST(JSON_UNQUOTE(JSON_EXTRACT(i.payload,'$.archived')) AS UNSIGNED)=a.archived)`,
    'ai-artifact-legacy-absolute-path': `SELECT COUNT(*) count FROM ${table('ai_artifacts')} WHERE archived=0 AND storage_path REGEXP '^/Users/[^/]+/'`,
    'ai-artifact-missing-quarantine': `SELECT COUNT(*) count FROM ${table('ai_artifacts')} a WHERE a.storage_path REGEXP '^/Users/[^/]+/' AND (a.archived<>1 OR a.quality_status<>'failed' OR NOT EXISTS (SELECT 1 FROM ${table('migration_issues')} i JOIN ${table('migration_runs')} mr ON mr.id=i.run_id WHERE i.source_system='postgres_dump' AND i.source_table='ai_artifacts' AND BINARY i.source_key=BINARY a.id AND i.code='AI_ARTIFACT_SOURCE_FILE_MISSING' AND mr.migration_type='missing-file-asset-quarantine' AND mr.status='succeeded'))`,
    'migration-run-incomplete': `SELECT COUNT(*) count FROM ${table('migration_runs')} WHERE status='running'`,
    'cdc-checkpoint-watermark-order': `SELECT COUNT(*) count FROM ${table('migration_cdc_checkpoints')} WHERE last_sequence>source_safe_watermark OR source_safe_watermark>source_observed_watermark OR (status='caught_up' AND last_sequence<source_safe_watermark)`,
    'cdc-event-checkpoint-bound': `SELECT COUNT(*) count FROM ${table('migration_cdc_events')} e JOIN ${table('migration_cdc_checkpoints')} c ON c.id=e.checkpoint_id WHERE e.source_sequence>c.last_sequence`,
    'cdc-event-counter-coherence': `SELECT COUNT(*) count FROM ${table('migration_cdc_checkpoints')} c LEFT JOIN (SELECT checkpoint_id,COUNT(*) total,SUM(operation='I') inserted,SUM(operation='U') updated,SUM(operation='D') deleted,SUM(operation='D' AND cascade_delete=1) cascaded FROM ${table('migration_cdc_events')} GROUP BY checkpoint_id) e ON e.checkpoint_id=c.id WHERE c.applied_events<>COALESCE(e.total,0) OR c.inserted_events<>COALESCE(e.inserted,0) OR c.updated_events<>COALESCE(e.updated,0) OR c.deleted_events<>COALESCE(e.deleted,0) OR c.cascade_deleted_events<>COALESCE(e.cascaded,0) OR c.applied_events<>c.inserted_events+c.updated_events+c.deleted_events`,
    'cdc-tombstone-coherence': `SELECT COUNT(*) count FROM ${table('migration_cdc_events')} WHERE (operation='D')<>tombstone OR (cascade_delete=1 AND (operation<>'D' OR tombstone<>1))`,
  }
  const invariants: Invariant[] = []
  for (const definition of invariantDefinitions) {
    invariants.push({ ...definition, violations: await queryCount(invariantSql[definition.id]) })
  }

  const [runRows] = await pool.query<Array<RowDataPacket & {
    id: string; migrationType: string; mode: string; status: string;
    sourceCounts: unknown; targetCounts: unknown; sourceSha256: string; sourceChecksum: string | null; targetChecksum: string | null;
    report: unknown
  }>>(`
    SELECT id, migration_type AS migrationType, mode, status, source_sha256 AS sourceSha256, source_counts AS sourceCounts,
           target_counts AS targetCounts, source_checksum AS sourceChecksum, target_checksum AS targetChecksum,
           report
    FROM ${table('migration_runs')} ORDER BY started_at DESC
  `)
  const successfulRuns = runRows.filter((row) => ['completed', 'verified', 'success', 'succeeded'].includes(row.status))
  const completedRuns = successfulRuns.filter((row) =>
    row.migrationType === 'postgres-online' && ['completed', 'verified', 'success', 'succeeded'].includes(row.status))
  const latestCompleted = completedRuns[0]
  const runSourceCounts = parseJsonCounts(latestCompleted?.sourceCounts)
  const runTargetCounts = parseJsonCounts(latestCompleted?.targetCounts)
  const runTableReports = parseMigrationTableReports(latestCompleted?.report)
  const [source, dumpSource, flueSources, jwSource] = await Promise.all([
    sourceInventory(), dumpInventory(), flueSourceEvidence(), jwExclusionEvidence(),
  ])
  const productionSourceInventory = await productionSourceInventoryEvidence(
    dumpSource.sha256, flueSources.map((item) => item.sourceSha256),
  )
  const dumpPreview = await dumpPreviewEvidence(dumpSource.sha256)
  const sourceTables: SourceTableEvidence[] = SOURCE_TABLES.map((name) => {
    const hasRunEvidence = Object.hasOwn(runSourceCounts, name) && Object.hasOwn(runTargetCounts, name)
    const tableReport = runTableReports[name]
    const numeric = (value: unknown): number | null => {
      const parsed = Number(value)
      return value !== null && value !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : null
    }
    const verifiedAtMigration = Boolean(
      tableReport
      && ['verified', 'verified-preserved'].includes(String(tableReport.status))
      && (tableReport.status === 'verified-preserved' || tableReport.sourceHash === tableReport.targetHash),
    )
    return {
      table: name,
      targetTable: name,
      sourceRows: source.counts[name] ?? runSourceCounts[name] ?? null,
      targetRows: targetCounts[name] ?? null,
      read: hasRunEvidence ? numeric(tableReport?.readRows) : null,
      written: hasRunEvidence ? numeric(tableReport?.writtenRows) : null,
      skipped: hasRunEvidence ? numeric(tableReport?.skippedRows) : null,
      failed: hasRunEvidence ? numeric(tableReport?.failedRows) : null,
      verifiedAtMigration,
      evidence: hasRunEvidence ? 'completed-migration-run' : source.reachable ? 'live-source-count-only' : 'unavailable',
    }
  })

  const schemaReady = missingTargetTables.length === 0 && unexpectedTargetTables.length === 0
  const foreignKeyReady = foreignKeys.every((foreignKey) => foreignKey.orphanRows === 0)
  const associationReady = invariants
    .filter((item) => !['file', 'identity', 'source'].includes(item.domain))
    .every((item) => !item.blocking || item.violations === 0)
  // “结构完整”只回答代码 Schema 是否落库、数据库已声明的 FK 是否无孤儿。
  // 没有 FK 的跨表业务关系单独进入 associationReady，不能用结构门禁掩盖。
  const targetStructuralIntegrityReady = schemaReady && foreignKeyReady
  const businessReconciliationReady = invariants.every((item) => !item.blocking || item.violations === 0)
  const executionCountsComplete = sourceTables.every((item) =>
    item.read !== null && item.written !== null && item.skipped !== null && item.failed !== null)
  const onlinePostgresReconciliationReady = source.reachable
    && latestCompleted?.sourceSha256 === source.identitySha256
    && source.missingExpectedTables.length === 0
    && executionCountsComplete
    && sourceTables.every((item) => item.verifiedAtMigration && item.sourceRows === item.read)
  const completedDumpRuns = successfulRuns.filter((row) =>
    ['postgres-dump', 'postgres-dump-baseline-reconciliation'].includes(row.migrationType))
  const latestDumpRun = completedDumpRuns[0]
  const sourceOrphanNormalizationReady = successfulRuns.some((row) =>
    row.migrationType === 'postgres-dump-orphan-conversation-normalization')
  const legacyConversationScopeNormalizationReady = successfulRuns.some((row) =>
    row.migrationType === 'legacy-conversation-scope-normalization')
  const missingFileAssetQuarantineReady = successfulRuns.some((row) =>
    row.migrationType === 'missing-file-asset-quarantine')
  const legacyScoringReady = successfulRuns.some((row) =>
    row.migrationType === 'legacy-scoring-classification')
  const dumpEvolution = DUMP_TABLES.map((name) => {
    const item = dumpPreview.tables[name]
    const sourceMissingInTarget = Number(item?.sourceMissingInTarget ?? Number.NaN)
    const targetOnlyRows = Number(item?.targetOnlyRows ?? Number.NaN)
    const changedSourceRows = Number(item?.changedSourceRows ?? Number.NaN)
    const changedColumns = item?.changedColumns && typeof item.changedColumns === 'object' && !Array.isArray(item.changedColumns)
      ? Object.keys(item.changedColumns as Record<string, unknown>) : []
    const evaluation = evaluateDumpTargetEvolution(name, {
      sourceMissingInTarget, targetOnlyRows, changedSourceRows, changedColumns,
    }, {
      sourceOrphanNormalizationReady,
      legacyConversationScopeNormalizationReady,
      missingFileAssetQuarantineReady,
      legacyScoringReady,
    })
    return {
      table: name, sourceMissingInTarget, targetOnlyRows, changedSourceRows, changedColumns,
      approved: evaluation.approved, reason: evaluation.reason,
    }
  })
  const dumpBaselineIdentityReady = dumpPreview.available
    && dumpSource.missingExpectedTables.length === 0
    && dumpEvolution.every((item) => item.sourceMissingInTarget === 0)
  const dumpTargetEvolutionApproved = dumpBaselineIdentityReady && dumpEvolution.every((item) => item.approved)
  const dumpRunReports = parseMigrationTableReports(latestDumpRun?.report)
  const dumpExecutionComplete = DUMP_TABLES.every((name) => {
    const item = dumpRunReports[name]
    return item && ['readRows', 'writtenRows', 'skippedRows', 'failedRows']
      .every((field) => Number.isFinite(Number(item[field as keyof MigrationTableReport])))
      && ['verified', 'verified-preserved'].includes(String(item.status))
      && (item.status === 'verified-preserved' || item.sourceHash === item.targetHash)
  })
  const dumpPostgresReconciliationReady = dumpSource.available
    && dumpSource.missingExpectedTables.length === 0
    && latestDumpRun?.sourceSha256 === dumpSource.sha256
    && dumpExecutionComplete
    && dumpTargetEvolutionApproved
  const postgresReconciliationReady = onlinePostgresReconciliationReady || dumpPostgresReconciliationReady
  const flueReconciliationReady = flueSources.length > 0 && flueSources.every((item) => {
    const conversations = Number(item.sourceCounts.conversations ?? 0)
    const selected = Number(item.selectedCounts.conversations ?? 0)
    const excluded = Number(item.excludedCounts.conversations ?? 0)
    const attachments = Number(item.sourceCounts.attachments ?? 0)
    const excludedAttachments = Number(item.excludedCounts.attachments ?? 0)
    const exclusionApproved = excluded === 0 || item.excludedDisposition === 'exclude-acceptance-fixture'
    return item.fileIntegrity && item.applied && item.errors === 0
      && item.sourceChecksum !== null && item.sourceChecksum === item.targetChecksum
      && selected + excluded === conversations && exclusionApproved
      && attachments === excludedAttachments
  })
  const sourceReconciliationReady = postgresReconciliationReady && flueReconciliationReady
    && jwSource.ready && productionSourceInventory.ready
  const fullMigrationReady = targetStructuralIntegrityReady && businessReconciliationReady && sourceReconciliationReady
  const invariantActions: Record<string, { ownerRole: string; nextAction: string }> = {
    'lead-reserve-missing-detail': {
      ownerRole: 'data-owner',
      nextAction: '补齐原始 detail_json，或逐项批准永久隔离处置后应用并复验',
    },
    'ai-artifact-source-file-missing': {
      ownerRole: 'data-owner',
      nextAction: '恢复可信源文件，或逐项批准永久归档处置后应用并复验',
    },
    'project-file-original-missing': {
      ownerRole: 'data-owner',
      nextAction: '补齐项目原件，或按精确清单批准缺失处置后复验',
    },
  }
  const blockers = [
    ...(!schemaReady ? [{
      code: 'TARGET_SCHEMA_DRIFT', category: 'target', count: missingTargetTables.length + unexpectedTargetTables.length,
      ownerRole: 'engineering', nextAction: '应用当前只前进迁移并消除缺失或意外目标表',
    }] : []),
    ...(!foreignKeyReady ? [{
      code: 'TARGET_FOREIGN_KEY_ORPHANS', category: 'target', count: foreignKeys.reduce((sum, item) => sum + item.orphanRows, 0),
      ownerRole: 'data-owner', nextAction: '逐外键修复孤儿记录并重新执行严格目标对账',
    }] : []),
    ...invariants.filter((item) => item.blocking && item.violations > 0).map((item) => ({
      code: `INVARIANT_${item.id.replaceAll('-', '_').toUpperCase()}`,
      category: item.domain,
      count: item.violations,
      ownerRole: invariantActions[item.id]?.ownerRole ?? 'engineering-and-data',
      nextAction: invariantActions[item.id]?.nextAction ?? `关闭不变量：${item.description}`,
    })),
    ...(!postgresReconciliationReady ? [{
      code: 'POSTGRES_RECONCILIATION_NOT_READY', category: 'source', count: 1,
      ownerRole: 'data-owner', nextAction: '提供可达在线源或 checksum 锁定的完整 dump，并完成逐表执行对账',
    }] : []),
    ...(!flueReconciliationReady ? [{
      code: 'FLUE_RECONCILIATION_NOT_READY', category: 'source', count: 1,
      ownerRole: 'data-owner', nextAction: '完成全部批准 Flue 源的内容级迁移或书面排除',
    }] : []),
    ...(!jwSource.ready ? [{
      code: 'JW_EXCLUSION_NOT_READY', category: 'source', count: 1,
      ownerRole: 'technology-and-data', nextAction: '完成 JW 白名单与 Aipin 拒绝源核验',
    }] : []),
    ...(!productionSourceInventory.ready ? [{
      code: 'PRODUCTION_SOURCE_INVENTORY_NOT_APPROVED', category: 'production', count: 1,
      ownerRole: 'data-owner', nextAction: '在目标生产机扫描全部源根并提交无异常源的批准报告',
    }] : []),
  ]

  const report = {
    schemaVersion: '1.0', generatedAt: new Date().toISOString(), mode: 'read-only',
    target: {
      tablePrefix: mysqlConfig.tablePrefix,
      schema: {
        codeTables: codeTables.length, targetApplicationTables: targetApplicationTables.length,
        internalTargetTables, missingTargetTables, unexpectedTargetTables,
      },
      tables: targetTables,
      totalRows: Object.values(targetCounts).reduce((sum, value) => sum + value, 0),
      foreignKeys,
      foreignKeyOrphans: foreignKeys.reduce((sum, item) => sum + item.orphanRows, 0),
      invariants,
    },
    sources: {
      onlinePostgres: source, postgresDump: dumpSource, flue: flueSources,
      jwExclusion: jwSource, productionInventory: productionSourceInventory,
    },
    executionEvidence: {
      migrationRuns: runRows.length,
      successfulRuns: successfulRuns.length,
      runsByType: Object.fromEntries([...new Set(runRows.map((row) => row.migrationType))].map((type) => [
        type, runRows.filter((row) => row.migrationType === type).length,
      ])),
      completedOnlinePostgresRuns: completedRuns.length,
      completedDumpRuns: completedDumpRuns.length,
      latestCompletedRun: latestCompleted ? {
        id: latestCompleted.id, migrationType: latestCompleted.migrationType, mode: latestCompleted.mode,
        status: latestCompleted.status,
        sourceIdentityMatch: latestCompleted.sourceSha256 === source.identitySha256,
        checksumMatch: Boolean(latestCompleted.sourceChecksum && latestCompleted.sourceChecksum === latestCompleted.targetChecksum),
      } : null,
      tables: sourceTables,
      dumpTables: dumpSource.tables.map((item) => ({ ...item, targetRows: targetCounts[item.table] ?? null })),
      dumpBaseline: {
        previewAvailable: dumpPreview.available,
        identityContained: dumpBaselineIdentityReady,
        targetEvolutionApproved: dumpTargetEvolutionApproved,
        latestReconciliationRun: latestDumpRun ? {
          id: latestDumpRun.id,
          migrationType: latestDumpRun.migrationType,
          mode: latestDumpRun.mode,
          sourceIdentityMatch: latestDumpRun.sourceSha256 === dumpSource.sha256,
        } : null,
        tables: dumpEvolution,
      },
      perTableReadWriteSkipFailComplete: executionCountsComplete,
    },
    readiness: {
      schemaReady, foreignKeyReady, associationReady, targetStructuralIntegrityReady,
      businessReconciliationReady, onlinePostgresReconciliationReady, dumpPostgresReconciliationReady,
      dumpBaselineIdentityReady, dumpTargetEvolutionApproved, sourceOrphanNormalizationReady,
      legacyConversationScopeNormalizationReady,
      missingFileAssetQuarantineReady, legacyScoringReady,
      postgresReconciliationReady, flueReconciliationReady, jwExclusionReady: jwSource.ready,
      productionSourceInventoryReady: productionSourceInventory.ready,
      sourceReconciliationReady, fullMigrationReady,
    },
    blockers,
  }

  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  const reportPath = path.resolve(outputDir, 'report.json')
  const summaryPath = path.resolve(outputDir, 'summary.md')
  const nonce = `${process.pid}-${Date.now()}`
  await writeFile(`${reportPath}.${nonce}`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  const invariantRows = invariants.map((item) =>
    `| ${item.domain} | ${item.description} | ${item.violations} | ${item.violations === 0 ? '通过' : '阻塞'} |`).join('\n')
  const sourceRows = sourceTables.map((item) =>
    `| ${item.table} | ${item.sourceRows ?? '不可用'} | ${item.targetRows ?? '不可用'} | ${item.read ?? '无证据'} | ${item.written ?? '无证据'} | ${item.skipped ?? '无证据'} | ${item.failed ?? '无证据'} | ${item.verifiedAtMigration ? '通过' : '无证据'} |`).join('\n')
  const flueRows = flueSources.map((item) =>
    `| ${item.fileName} | ${item.sourceCounts.conversations ?? 0} | ${item.sourceCounts.messages ?? 0} | ${item.sourceCounts.parts ?? 0} | ${item.fileIntegrity ? '通过' : '失败'} | ${item.applied ? `已应用${item.excludedDisposition ? `（${item.excludedDisposition}）` : ''}` : item.readyToApply ? '可应用' : `阻塞：${item.issues.map((issue) => issue.code).join(',') || '未知'}`} |`).join('\n')
  const dumpRows = dumpEvolution.map((item) => {
    const sourceRows = dumpSource.tables.find((tableItem) => tableItem.table === item.table)?.rows ?? '不可用'
    const run = dumpRunReports[item.table]
    return `| ${item.table} | ${sourceRows} | ${targetCounts[item.table] ?? '不可用'} | ${run?.readRows ?? '无证据'} | ${run?.writtenRows ?? '无证据'} | ${run?.skippedRows ?? '无证据'} | ${run?.failedRows ?? '无证据'} | ${item.sourceMissingInTarget} | ${item.targetOnlyRows} | ${item.changedSourceRows} | ${item.changedColumns.join(',') || '-'} | ${item.approved ? '通过' : '阻塞'} |`
  }).join('\n')
  const blockerRows = blockers.map((item) =>
    `| ${item.code} | ${item.category} | ${item.count} | ${item.ownerRole} | ${item.nextAction} |`).join('\n')
  const markdown = [
    '# MySQL 迁移对账摘要', '',
    `生成时间：${report.generatedAt}`, '',
    `- 目标 Schema：${schemaReady ? '通过' : '失败'}（代码 ${codeTables.length} 张业务表 / MySQL ${targetApplicationTables.length} 张业务表；内部迁移表 ${internalTargetTables.length} 张）`,
    `- 外键完整性：${foreignKeyReady ? '通过' : '失败'}（${foreignKeys.length} 个外键，${report.target.foreignKeyOrphans} 条孤儿）`,
    `- 关键关联完整性：${associationReady ? '通过' : '失败'}`,
    `- 目标结构就绪：${targetStructuralIntegrityReady ? '是' : '否'}`,
    `- 业务数据待处置项清零：${businessReconciliationReady ? '是' : '否'}`,
    `- 源端迁移对账就绪：${sourceReconciliationReady ? '是' : '否'}`,
    `- 全量迁移就绪：${fullMigrationReady ? '是' : '否'}`,
    `- 当前机器可判定阻断：${blockers.length} 项`, '',
    '## 当前阻断与下一动作', '',
    '| 代码 | 类别 | 数量 | 责任角色 | 下一动作 |',
    '| --- | --- | ---: | --- | --- |', blockerRows || '| 无 | - | 0 | - | - |', '',
    '## 关键业务不变量', '',
    '| 域 | 检查 | 违规数 | 结论 |', '| --- | --- | ---: | --- |', invariantRows, '',
    '## 源端逐表执行证据', '',
    `在线 PostgreSQL：${source.reachable ? '只读连接成功' : `不可用（${source.error?.code ?? 'UNKNOWN'}）`}`,
    `PostgreSQL dump：${dumpSource.available ? `可用，${dumpSource.tables.length} 张表，SHA-256 已记录` : `不可用（${dumpSource.error ?? 'UNKNOWN'}）`}`,
    `dump 源 ID 覆盖：${dumpBaselineIdentityReady ? '通过，源记录在目标均有对应 ID' : '失败或无预览证据'}`,
    `dump 后目标演进：${dumpTargetEvolutionApproved ? '通过显式字段白名单与迁移台账核验' : '存在未批准差异'}`,
    `JW SQLite 排除证据：${jwSource.ready ? `通过（拒绝 ${jwSource.rejectedConversations} 个会话/${jwSource.rejectedMessages} 条消息）` : '缺失或阻塞'}`,
    `生产源资产盘点：${productionSourceInventory.ready ? '已批准且与当前源哈希一致' : `阻塞（${productionSourceInventory.reason}）`}`,
    `迁移运行台账：${runRows.length} 条，成功 ${successfulRuns.length} 条；在线 PostgreSQL 完成运行 ${completedRuns.length} 条，dump 完成运行 ${completedDumpRuns.length} 条。`, '',
    '| 来源表 | 来源当前数 | 目标当前数 | 读取 | 写入 | 跳过 | 失败 | 迁移时哈希 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |', sourceRows, '',
    '## PostgreSQL dump 基线', '',
    '| 表 | dump 行数 | 目标当前数 | 读取 | 写入 | 跳过 | 失败 | 源 ID 缺失 | 目标新增 | 源行变化 | 变化字段 | 白名单结论 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |', dumpRows, '',
    '## Flue 来源', '',
    '| 文件 | 会话 | 消息 | Part | 文件哈希 | 处置状态 |',
    '| --- | ---: | ---: | ---: | --- | --- |', flueRows || '| 无证据 | 0 | 0 | 0 | 失败 | 阻塞 |', '',
    '“目标当前数”不能替代“本次写入数”。只有已完成迁移运行台账同时给出读取、写入、跳过、失败和校验和，才关闭源端对账。', '',
    '完整逐表主键哈希、外键定义和孤儿数见 `report.json`。报告不包含连接串、密码或业务正文。',
  ].join('\n')
  await writeFile(`${summaryPath}.${nonce}`, markdown, { mode: 0o600 })
  await rename(`${reportPath}.${nonce}`, reportPath)
  await rename(`${summaryPath}.${nonce}`, summaryPath)
  console.log(JSON.stringify({ ok: strictFull ? fullMigrationReady : strictTarget ? targetStructuralIntegrityReady : true, outputDir, readiness: report.readiness }))
  if (strictTarget && !targetStructuralIntegrityReady) process.exitCode = 2
  if (strictFull && !fullMigrationReady) process.exitCode = 3
}

await main().finally(async () => pool.end())
