import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core'
import * as schema from '../db/schema.js'
import { pool } from '../db/client.js'
import { mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'

type EnumRule = {
  table: string
  column: string
  allowed: readonly string[]
  source?: boolean
}

const projectStages = ['线索', '初筛', '立项', '尽调', '上会', '投决', '投后', '退出', '放弃'] as const
const jobStatuses = ['queued', 'running', 'retrying', 'done', 'failed', 'discarded', 'dead_letter'] as const
const taskTypes = [
  'compliance_statement', 'investment_proposal', 'investment_recommendation_ppt',
  'due_diligence_report', 'project_qa', 'custom_template_document',
] as const

// These are closed application contracts stored as VARCHAR for PostgreSQL/MySQL compatibility.
// Free-form classification fields (for example risk.type or project_file.type) are intentionally
// excluded and must not be presented as database enums.
const ENUM_RULES: readonly EnumRule[] = [
  { table: 'users', column: 'role', source: true, allowed: ['投资经理', '投资总监', '风控与法务', '风控法务', '风险控制', '投委会秘书', '投委会委员', '投后管理组', '投后负责人', '平台运营', '财务', '董事长', '系统管理员', 'AI平台管理员', 'AI 平台管理员'] },
  { table: 'users', column: 'status', source: true, allowed: ['启用', '禁用'] },
  { table: 'projects', column: 'stage', source: true, allowed: projectStages },
  { table: 'projects', column: 'risk_level', source: true, allowed: ['高', '中', '低'] },
  { table: 'project_score_jobs', column: 'status', allowed: ['queued', 'running', 'retrying', 'done', 'dead_letter'] },
  { table: 'meetings', column: 'type', source: true, allowed: ['项目会议', '初筛会', '上会', '投决会'] },
  { table: 'todos', column: 'priority', source: true, allowed: ['高', '中', '低'] },
  { table: 'todos', column: 'status', source: true, allowed: ['未开始', '进行中', '已完成', '已退回'] },
  { table: 'todos', column: 'type', source: true, allowed: ['待办', '流程', '材料'] },
  { table: 'oa_approval_requests', column: 'type', allowed: ['初筛审批', '立项审批', '尽调启动审批', '上会申请', '投决审批', '投后移交审批', '项目终止审批'] },
  { table: 'oa_approval_requests', column: 'status', allowed: ['审批中', '已通过', '已退回', '已拒绝', '已撤回'] },
  { table: 'oa_approval_requests', column: 'priority', allowed: ['普通', '紧急'] },
  { table: 'oa_approval_nodes', column: 'mode', allowed: ['或签', '会签'] },
  { table: 'oa_approval_nodes', column: 'status', allowed: ['待审批', '审批中', '已通过', '已退回', '已拒绝', '已跳过', '已撤回'] },
  { table: 'oa_approval_records', column: 'action', allowed: ['approve', 'return', 'reject', 'withdraw', 'resubmit'] },
  { table: 'risks', column: 'level', source: true, allowed: ['高', '中', '低'] },
  { table: 'risks', column: 'source', source: true, allowed: ['人工录入', '系统检测', '外部数据'] },
  { table: 'risks', column: 'status', source: true, allowed: ['待处置', '处置中', '已解除', '已忽略'] },
  { table: 'identity_resolution_issues', column: 'status', allowed: ['open', 'resolved', 'ignored'] },
  { table: 'leads', column: 'pool_status', source: true, allowed: ['成功', '解析失败', '待处理', '公共池', '已转专属项目'] },
  { table: 'lead_reserve', column: 'score_status', source: true, allowed: ['not_requested', 'requested', 'pending', 'succeeded', 'failed', 'source_missing'] },
  { table: 'lead_score_jobs', column: 'status', allowed: jobStatuses },
  { table: 'lead_pipeline_items', column: 'status', allowed: ['discovered', 'ready', 'review', 'rejected', 'failed'] },
  { table: 'lead_pipeline_runs', column: 'runtime', allowed: ['claude-agent-sdk'] },
  { table: 'lead_pipeline_runs', column: 'status', allowed: ['running', 'succeeded', 'failed', 'cancelled'] },
  { table: 'lead_agent_runtime_permits', column: 'state', allowed: ['active', 'succeeded', 'failed'] },
  { table: 'lead_pipeline_decisions', column: 'outcome', allowed: ['accept', 'review', 'reject', 'failed'] },
  { table: 'lead_pipeline_decisions', column: 'actor_type', allowed: ['agent', 'human', 'system'] },
  { table: 'lead_pipeline_reviews', column: 'status', allowed: ['pending', 'resolved'] },
  { table: 'lead_pipeline_entity_matches', column: 'status', allowed: ['candidate', 'ambiguous', 'selected', 'created', 'rejected'] },
  { table: 'lead_pipeline_entity_matches', column: 'resolution_type', allowed: ['pending', 'automatic', 'manual', 'created', 'rejected'] },
  { table: 'runtime_jobs', column: 'schedule_kind', allowed: ['interval', 'daily'] },
  { table: 'runtime_jobs', column: 'last_status', allowed: ['running', 'succeeded', 'failed', 'dead_letter', 'cancelled'] },
  { table: 'runtime_job_runs', column: 'status', allowed: ['running', 'succeeded', 'failed', 'dead_letter', 'cancelled', 'abandoned'] },
  { table: 'audit_logs', column: 'result', allowed: ['success', 'denied', 'failed'] },
  { table: 'chat_conversations', column: 'scope', source: true, allowed: ['project', 'global'] },
  { table: 'agent_conversations', column: 'scope', allowed: ['project', 'global'] },
  { table: 'agent_conversations', column: 'status', allowed: ['idle', 'running', 'interrupted', 'failed', 'closed'] },
  { table: 'agent_conversations', column: 'runtime', allowed: ['jw', 'legacy-index', 'legacy-import'] },
  { table: 'agent_messages', column: 'role', allowed: ['user', 'assistant', 'tool', 'system'] },
  { table: 'agent_messages', column: 'status', allowed: ['streaming', 'complete', 'interrupted', 'failed', 'cancelled'] },
  { table: 'migration_runs', column: 'mode', allowed: ['preview', 'apply', 'reconcile', 'dry-run'] },
  { table: 'migration_runs', column: 'status', allowed: ['running', 'succeeded', 'failed'] },
  { table: 'migration_issues', column: 'severity', allowed: ['warning', 'error'] },
  { table: 'migration_entity_mappings', column: 'mapping_kind', allowed: ['preserved', 'resolved', 'generated'] },
  { table: 'ai_task_templates', column: 'output_format', allowed: ['docx', 'pptx'] },
  { table: 'ai_task_templates', column: 'status', allowed: ['enabled', 'disabled'] },
  { table: 'ai_model_providers', column: 'protocol', allowed: ['openai-compatible', 'anthropic-compatible'] },
  { table: 'ai_model_providers', column: 'last_test_status', allowed: ['succeeded', 'failed'] },
  { table: 'ai_capabilities', column: 'kind', allowed: ['skill', 'agent', 'mcp', 'plugin'] },
  { table: 'ai_capabilities', column: 'source', allowed: ['builtin', 'managed'] },
  { table: 'ai_capabilities', column: 'last_test_status', allowed: ['succeeded', 'failed'] },
  { table: 'ai_capability_bindings', column: 'scope_type', allowed: ['global', 'department', 'project'] },
  { table: 'ai_tasks', column: 'type', source: true, allowed: taskTypes },
  { table: 'ai_tasks', column: 'status', source: true, allowed: ['pending', 'running', 'succeeded', 'failed', 'cancelled'] },
  { table: 'ai_artifacts', column: 'format', source: true, allowed: ['md', 'docx', 'pdf', 'pptx', 'xlsx', 'png', 'jpg', 'jpeg'] },
  { table: 'ai_artifacts', column: 'editable_level', source: true, allowed: ['none', 'preview-only', 'image', 'core-content', 'core-elements', 'text-and-structure', 'all'] },
  { table: 'ai_artifacts', column: 'quality_status', source: true, allowed: ['unchecked', 'passed', 'failed'] },
  { table: 'ai_task_sources', column: 'verification_status', source: true, allowed: ['资料记载', 'AI推断', '待核验', '资料缺口', 'verified', 'unverified', 'conflicted'] },
  { table: 'ai_custom_templates', column: 'format', allowed: ['docx', 'pptx'] },
  { table: 'ai_custom_templates', column: 'status', allowed: ['pending', 'running', 'succeeded', 'failed'] },
  { table: 'ai_template_analysis_progress', column: 'status', allowed: ['running', 'succeeded', 'failed'] },
  { table: 'knowledge_chunks', column: 'scope', source: true, allowed: ['project', 'lead', 'org'] },
] as const

type SchemaConfig = ReturnType<typeof getTableConfig>

function schemaConfigs(): SchemaConfig[] {
  const result = new Map<string, SchemaConfig>()
  for (const value of Object.values(schema)) {
    try {
      const config = getTableConfig(value as MySqlTable)
      if (config?.name?.startsWith(mysqlConfig.tablePrefix)) result.set(config.name, config)
    } catch { /* non-table schema export */ }
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function decodeCopyValue(raw: string): string | null {
  if (raw === String.raw`\N`) return null
  let result = ''
  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index]
    if (current !== '\\') { result += current; continue }
    const next = raw[++index]
    if (next == null) throw new Error('invalid trailing PostgreSQL COPY escape')
    const escapes: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' }
    if (next in escapes) { result += escapes[next]; continue }
    if (next === 'x') {
      const hex = raw.slice(index + 1, index + 3).match(/^[0-9A-Fa-f]{1,2}/)?.[0]
      if (!hex) throw new Error('invalid PostgreSQL COPY hexadecimal escape')
      result += String.fromCharCode(Number.parseInt(hex, 16)); index += hex.length; continue
    }
    if (/[0-7]/.test(next)) {
      const octal = raw.slice(index, index + 3).match(/^[0-7]{1,3}/)?.[0] ?? next
      result += String.fromCharCode(Number.parseInt(octal, 8)); index += octal.length - 1; continue
    }
    result += next
  }
  return result
}

async function sourceEnumValues(dumpPath: string): Promise<Map<string, Set<string>>> {
  const wanted = new Map<string, Set<string>>()
  for (const rule of ENUM_RULES.filter((item) => item.source)) {
    const columns = wanted.get(rule.table) ?? new Set<string>()
    columns.add(rule.column); wanted.set(rule.table, columns)
  }
  const values = new Map<string, Set<string>>()
  let active: { table: string; columns: string[] } | null = null
  let buffered = ''
  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!active) {
      const match = line.match(/^COPY public\.([A-Za-z0-9_]+) \(([^)]+)\) FROM stdin;$/)
      if (match && wanted.has(match[1])) active = { table: match[1], columns: match[2].split(', ') }
      return
    }
    if (line === String.raw`\.`) { active = null; return }
    const row = line.split('\t')
    if (row.length !== active.columns.length) throw new Error(`invalid COPY column count for ${active.table}`)
    for (const column of wanted.get(active.table) ?? []) {
      const index = active.columns.indexOf(column)
      if (index < 0) continue
      const value = decodeCopyValue(row[index])
      if (value !== null) {
        const key = `${active.table}.${column}`
        const distinct = values.get(key) ?? new Set<string>()
        distinct.add(value); values.set(key, distinct)
      }
    }
  }
  for await (const chunk of createReadStream(dumpPath, { encoding: 'utf8' })) {
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      processLine(buffered.slice(0, newline)); buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  }
  if (buffered) processLine(buffered)
  if (active) throw new Error('unterminated PostgreSQL COPY block')
  return values
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function writeEvidence(report: Record<string, unknown>): Promise<void> {
  const directory = path.resolve(process.cwd(), '.runtime/migration-evidence/scalar-constraints')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const target = path.resolve(directory, 'report.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[migration-scalar-constraints] ${message}`)
}

async function main() {
  await ensureSchema()
  const configs = schemaConfigs()
  const byName = new Map(configs.map((config) => [config.name, config]))
  const dumpPath = path.resolve(process.env.PG_DUMP_PATH?.trim() || 'cybernaut_mvp_dump.sql')
  const sourceSha256 = await sha256File(dumpPath)
  const [sourceRuns] = await pool.query<Array<RowDataPacket & { count: number }>>(`
    SELECT COUNT(*) count FROM ${quoteMysqlIdentifier(mysqlTableName('migration_runs'))}
    WHERE migration_type='postgres-dump-baseline-reconciliation' AND status='succeeded' AND source_sha256=?
  `, [sourceSha256])
  requireCheck(Number(sourceRuns[0]?.count ?? 0) > 0, 'dump checksum is not bound to a successful reconciliation run')
  const sourceValues = await sourceEnumValues(dumpPath)

  const enumReport: Array<Record<string, unknown>> = []
  for (const rule of ENUM_RULES) {
    const tableName = mysqlTableName(rule.table)
    const config = byName.get(tableName)
    const column = config?.columns.find((item) => item.name === rule.column)
    requireCheck(column, `Schema column missing: ${rule.table}.${rule.column}`)
    const [rows] = await pool.query<Array<RowDataPacket & { value: string | null }>>(
      `SELECT DISTINCT ${quoteMysqlIdentifier(rule.column)} value FROM ${quoteMysqlIdentifier(tableName)}
       ORDER BY ${quoteMysqlIdentifier(rule.column)}`,
    )
    const targetValues = rows.map((row) => row.value).filter((value): value is string => value !== null)
    const sourceDistinct = [...(sourceValues.get(`${rule.table}.${rule.column}`) ?? new Set<string>())].sort()
    const targetInvalid = targetValues.filter((value) => !rule.allowed.includes(value))
    const sourceInvalid = sourceDistinct.filter((value) => !rule.allowed.includes(value))
    requireCheck(targetInvalid.length === 0, `target enum violation ${rule.table}.${rule.column}: ${targetInvalid.join(',')}`)
    requireCheck(sourceInvalid.length === 0, `source enum violation ${rule.table}.${rule.column}: ${sourceInvalid.join(',')}`)
    enumReport.push({ table: rule.table, column: rule.column, sourceValues: sourceDistinct, targetValues })
  }

  const booleanColumns = configs.flatMap((config) => config.columns
    .filter((column) => column.dataType === 'boolean')
    .map((column) => ({ table: config.name, column: column.name })))
  for (const item of booleanColumns) {
    const [metadata] = await pool.query<Array<RowDataPacket & { dataType: string; columnType: string }>>(`
      SELECT DATA_TYPE dataType,COLUMN_TYPE columnType FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?
    `, [mysqlConfig.database, item.table, item.column])
    requireCheck(metadata[0]?.dataType === 'tinyint' && metadata[0]?.columnType.toLowerCase() === 'tinyint(1)',
      `boolean physical type mismatch: ${item.table}.${item.column}`)
    const [invalid] = await pool.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) count FROM ${quoteMysqlIdentifier(item.table)}
       WHERE ${quoteMysqlIdentifier(item.column)} IS NOT NULL AND ${quoteMysqlIdentifier(item.column)} NOT IN (0,1)`,
    )
    requireCheck(Number(invalid[0]?.count ?? 0) === 0, `invalid boolean value: ${item.table}.${item.column}`)
  }

  const uuidPattern = '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$'
  const uuidColumns = configs.flatMap((config) => config.columns
    .filter((column) => column.columnType === 'MySqlVarChar' && (column as typeof column & { length?: number }).length === 36)
    .map((column) => ({ table: config.name, column: column.name })))
  for (const item of uuidColumns) {
    const [metadata] = await pool.query<Array<RowDataPacket & { dataType: string; length: number }>>(`
      SELECT DATA_TYPE dataType,CHARACTER_MAXIMUM_LENGTH length FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?
    `, [mysqlConfig.database, item.table, item.column])
    requireCheck(metadata[0]?.dataType === 'varchar' && Number(metadata[0]?.length) === 36,
      `UUID physical type mismatch: ${item.table}.${item.column}`)
    const [invalid] = await pool.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) count FROM ${quoteMysqlIdentifier(item.table)}
       WHERE ${quoteMysqlIdentifier(item.column)} IS NOT NULL
         AND ${quoteMysqlIdentifier(item.column)} NOT REGEXP ?`,
      [uuidPattern],
    )
    requireCheck(Number(invalid[0]?.count ?? 0) === 0, `invalid UUID value: ${item.table}.${item.column}`)
  }

  const expectedUnique = new Map<string, string[]>()
  for (const config of configs) {
    for (const index of config.indexes.filter((item) => item.config.unique)) {
      const columns = index.config.columns.map((column) => (column as { name?: string }).name)
      requireCheck(columns.every(Boolean), `unique index contains a non-column expression: ${index.config.name}`)
      expectedUnique.set(`${config.name}.${index.config.name}`, columns as string[])
    }
    for (const column of config.columns.filter((item) => item.isUnique)) {
      requireCheck(column.uniqueName, `inline unique column lacks a name: ${config.name}.${column.name}`)
      expectedUnique.set(`${config.name}.${column.uniqueName}`, [column.name])
    }
  }
  const tableNames = configs.map((config) => config.name)
  const [databaseUniqueRows] = await pool.query<Array<RowDataPacket & {
    tableName: string; indexName: string; columnName: string; sequence: number
  }>>(`
    SELECT TABLE_NAME tableName,INDEX_NAME indexName,COLUMN_NAME columnName,SEQ_IN_INDEX sequence
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=? AND NON_UNIQUE=0 AND INDEX_NAME<>'PRIMARY'
      AND TABLE_NAME IN (${tableNames.map(() => '?').join(',')})
    ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX
  `, [mysqlConfig.database, ...tableNames])
  const actualUnique = new Map<string, string[]>()
  for (const row of databaseUniqueRows) {
    const key = `${row.tableName}.${row.indexName}`
    const columns = actualUnique.get(key) ?? []
    columns.push(row.columnName); actualUnique.set(key, columns)
  }
  requireCheck(expectedUnique.size === actualUnique.size,
    `unique index count mismatch: schema=${expectedUnique.size} mysql=${actualUnique.size}`)
  for (const [key, columns] of expectedUnique) {
    requireCheck(JSON.stringify(actualUnique.get(key)) === JSON.stringify(columns), `unique index mismatch: ${key}`)
    const separator = key.indexOf('.')
    const tableName = key.slice(0, separator)
    const where = columns.map((column) => `${quoteMysqlIdentifier(column)} IS NOT NULL`).join(' AND ')
    const group = columns.map(quoteMysqlIdentifier).join(',')
    const [duplicates] = await pool.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) count FROM (
         SELECT 1 FROM ${quoteMysqlIdentifier(tableName)} WHERE ${where}
         GROUP BY ${group} HAVING COUNT(*)>1
       ) duplicate_groups`,
    )
    requireCheck(Number(duplicates[0]?.count ?? 0) === 0, `duplicate group under unique contract: ${key}`)
  }

  const report = {
    schemaVersion: '1.0', ok: true, sourceFile: path.basename(dumpPath), sourceSha256,
    checks: [
      'source-and-target-controlled-enum-values-within-versioned-contracts',
      'all-schema-booleans-are-mysql-tinyint-one-with-zero-one-values',
      'all-schema-uuid-columns-are-varchar-36-with-valid-rfc4122-values',
      'all-code-unique-indexes-match-mysql-column-order-and-have-no-duplicate-groups',
      'json-and-time-contracts-remain-separate-mandatory-release-gates',
    ],
    counts: {
      enumContracts: enumReport.length,
      sourceEnumContracts: ENUM_RULES.filter((item) => item.source).length,
      booleanColumns: booleanColumns.length,
      uuidColumns: uuidColumns.length,
      uniqueIndexes: expectedUnique.size,
    },
    enums: enumReport,
  }
  await writeEvidence(report)
  console.log(JSON.stringify({ ok: true, ...report.counts, checks: report.checks }))
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
}).finally(() => pool.end())
