import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  canonicalDisplayValue as displayCanonical,
  leadDuplicateGroupId,
  leadDuplicateComparisonKey as comparisonKey,
  sha256,
  LEAD_DUPLICATE_NORMALIZATION,
} from './leadDuplicateDispositionContract.js'

type SourceField = 'users.email' | 'projects.name' | 'projects.company_name' | 'leads.name' | 'leads.company_name'
type ValueRow = { id: string; value: string }
type Collision = {
  field: SourceField
  comparisonKey: string
  kind: 'exact-duplicate' | 'normalized-collision'
  records: ValueRow[]
  disposition?: 'keep-separate' | 'exception' | null
  blocking?: boolean
}

const strict = process.argv.includes('--strict')
const outputDir = path.resolve(process.env.NORMALIZATION_AUDIT_OUTPUT_DIR || '.runtime/migration-evidence/mysql-normalization')

function table(name: string) {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

async function queryValues(sql: string): Promise<ValueRow[]> {
  const [rows] = await pool.query<Array<RowDataPacket & { id: string; value: string | null }>>(sql)
  return rows.flatMap((row) => typeof row.value === 'string' && row.value.trim()
    ? [{ id: row.id, value: row.value }]
    : [])
}

async function main() {
  const [approvedRows] = await pool.query<Array<RowDataPacket & {
    groupId: string; code: string; payload: unknown
  }>>(`SELECT i.source_key groupId,i.code,i.payload
       FROM ${table('migration_issues')} i JOIN ${table('migration_runs')} r ON r.id=i.run_id
       WHERE r.migration_type='lead-duplicate-disposition' AND r.status='succeeded'
         AND i.source_system='business_decision' AND i.source_table='leads'
         AND i.code IN ('LEAD_DUPLICATE_KEEP_SEPARATE_APPROVED','LEAD_DUPLICATE_EXCEPTION_APPROVED')`)
  const approvedDispositions = new Map<string, { action: 'keep-separate' | 'exception'; payload: Record<string, unknown> }>()
  for (const row of approvedRows) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) as Record<string, unknown>
      : row.payload as Record<string, unknown>
    const action = row.code === 'LEAD_DUPLICATE_KEEP_SEPARATE_APPROVED' ? 'keep-separate' : 'exception'
    approvedDispositions.set(row.groupId, { action, payload })
  }
  const sources: Array<{ field: SourceField; rows: ValueRow[] }> = [
    { field: 'users.email', rows: await queryValues(`SELECT id,email AS value FROM ${table('users')}`) },
    { field: 'projects.name', rows: await queryValues(`SELECT id,name AS value FROM ${table('projects')}`) },
    { field: 'projects.company_name', rows: await queryValues(`SELECT id,company_name AS value FROM ${table('projects')}`) },
    { field: 'leads.name', rows: await queryValues(`SELECT id,name AS value FROM ${table('leads')} WHERE pool_status<>'已合并'`) },
    { field: 'leads.company_name', rows: await queryValues(`SELECT id,company_name AS value FROM ${table('leads')} WHERE pool_status<>'已合并'`) },
  ]
  const collisions: Collision[] = []
  const nonCanonicalEmails: ValueRow[] = []
  for (const source of sources) {
    const groups = new Map<string, ValueRow[]>()
    for (const row of source.rows) {
      const key = comparisonKey(row.value)
      groups.set(key, [...(groups.get(key) || []), row])
      if (source.field === 'users.email' && row.value !== displayCanonical(row.value).toLowerCase()) {
        nonCanonicalEmails.push(row)
      }
    }
    for (const [key, records] of groups) {
      if (records.length < 2) continue
      const collision: Collision = {
        field: source.field,
        comparisonKey: key,
        kind: new Set(records.map((record) => record.value)).size === 1 ? 'exact-duplicate' : 'normalized-collision',
        records: records.sort((left, right) => left.id.localeCompare(right.id)),
      }
      if (source.field === 'leads.name' || source.field === 'leads.company_name') {
        const groupId = leadDuplicateGroupId({
          field: source.field,
          comparisonKey: collision.comparisonKey,
          kind: collision.kind,
          records: collision.records,
        })
        const approved = approvedDispositions.get(groupId)
        const identityMatches = approved
          && approved.payload.field === collision.field
          && approved.payload.kind === collision.kind
          && approved.payload.comparisonKeySha256 === sha256(collision.comparisonKey)
        collision.disposition = identityMatches ? approved.action : null
        collision.blocking = !identityMatches
      } else {
        collision.disposition = null
        collision.blocking = true
      }
      collisions.push(collision)
    }
  }
  collisions.sort((left, right) => left.field.localeCompare(right.field) || left.comparisonKey.localeCompare(right.comparisonKey))
  const summary = {
    scanned: Object.fromEntries(sources.map((source) => [source.field, source.rows.length])),
    collisionGroups: collisions.length,
    collisionRecords: collisions.reduce((total, group) => total + group.records.length, 0),
    exactDuplicateGroups: collisions.filter((group) => group.kind === 'exact-duplicate').length,
    normalizedCollisionGroups: collisions.filter((group) => group.kind === 'normalized-collision').length,
    nonCanonicalEmails: nonCanonicalEmails.length,
    approvedDispositionGroups: collisions.filter((group) => group.disposition).length,
    blockingCollisionGroups: collisions.filter((group) => group.blocking !== false).length,
    blockingIssues: collisions.filter((group) => group.blocking !== false).length + nonCanonicalEmails.length,
  }
  const report = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    normalization: LEAD_DUPLICATE_NORMALIZATION,
    strict,
    summary,
    collisions,
    nonCanonicalEmails,
  }
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  const reportPath = path.join(outputDir, 'report.json')
  const summaryPath = path.join(outputDir, 'summary.md')
  const suffix = `.tmp-${process.pid}`
  await writeFile(`${reportPath}${suffix}`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  const rows = collisions.map((group) => {
    const safeKey = group.comparisonKey.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ')
    return `| ${group.field} | ${group.kind} | ${safeKey} | ${group.records.length} | ${group.disposition || '未裁决'} | ${group.blocking === false ? '否' : '是'} |`
  })
  const markdown = [
    '# MySQL 规范化冲突审计', '',
    `生成时间：${report.generatedAt}`, '',
    `- 冲突组：${summary.collisionGroups}`,
    `- 已批准保留/例外组：${summary.approvedDispositionGroups}`,
    `- 阻断冲突组：${summary.blockingCollisionGroups}`,
    `- 涉及记录：${summary.collisionRecords}`,
    `- 非规范邮箱：${summary.nonCanonicalEmails}`, '',
    '比较规则为 NFKC、首尾去空白、Unicode 连续空白折叠和小写比较；工具只读扫描，不自动合并、改名或删除。完整 ID 和原值见 `report.json`。', '',
    '| 字段 | 类型 | 规范化键 | 记录数 | 裁决 | 阻断 |',
    '| --- | --- | --- | ---: | --- | --- |',
    ...rows, '',
  ].join('\n')
  await writeFile(`${summaryPath}${suffix}`, markdown, { mode: 0o600 })
  await rename(`${reportPath}${suffix}`, reportPath)
  await rename(`${summaryPath}${suffix}`, summaryPath)
  console.log(JSON.stringify({ ok: summary.blockingIssues === 0, strict, summary, outputDir }))
  if (strict && summary.blockingIssues > 0) process.exitCode = 2
}

await main().finally(async () => pool.end())
