import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'

const EXPECTED_SOURCE_SHA256 = 'f7b4df01f3e04481860cd4d7d1c94a3ac18ec1bba5dfbecbb4541494fbbe8163'
const EXPECTED_REJECTED_CONVERSATIONS = 37
const EXPECTED_REJECTED_MESSAGES = 2168
const REQUIRED_TABLES = ['agent_conversations', 'agent_messages'] as const
// The reviewed backup contains no approved generic JW Runtime history. Keep this
// explicit and fail closed if a future source needs a newly reviewed source value.
const APPROVED_CONVERSATION_SOURCES = [] as const
const REJECTED_CONVERSATION_SOURCES = ['aipin-data-processing'] as const
const outputDir = path.resolve('.runtime/migration-evidence/jw-sqlite-migration')
const apply = process.argv.includes('--apply')

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const defaultSource = path.resolve(
  process.env.JW_MIGRATION_BACKUP_ROOT
    || '/Users/hyw/Desktop/sbl_jedi-migration-backup-20260808/jw-runtime',
  'sessions.db',
)
const sourcePath = path.resolve(arg('--source') || defaultSource)

function table(base: string): string {
  return quoteMysqlIdentifier(mysqlTableName(base))
}

function placeholders(values: readonly string[]): string {
  return values.map(() => '?').join(',')
}

function sqliteCount(database: DatabaseSync, sql: string, values: readonly string[] = []): number {
  const row = database.prepare(sql).get(...values) as Record<string, unknown> | undefined
  return Number(row ? Object.values(row)[0] : 0)
}

async function targetSentinel(): Promise<Record<string, number>> {
  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT
      (SELECT COUNT(*) FROM ${table('agent_conversations')}) AS conversations,
      (SELECT COUNT(*) FROM ${table('agent_messages')}) AS messages,
      (SELECT COUNT(*) FROM ${table('agent_conversation_source_mappings')}) AS conversationMappings,
      (SELECT COUNT(*) FROM ${table('agent_message_source_mappings')}) AS messageMappings
  `)
  return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)]))
}

async function writeEvidence(report: Record<string, unknown>): Promise<void> {
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  await chmod(outputDir, 0o700)
  const target = path.resolve(outputDir, 'report.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  await chmod(target, 0o600)
}

async function main(): Promise<void> {
  const sourceStat = await lstat(sourcePath)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('JW SQLite source must be a regular non-symlink file')
  const sourceBytes = await readFile(sourcePath)
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
  const database = new DatabaseSync(sourcePath, { readOnly: true })
  let inspection: {
    integrity: string
    missingTables: string[]
    totalConversations: number
    approvedConversations: number
    rejectedConversations: number
    unreviewedConversations: number
    totalMessages: number
    approvedMessages: number
    rejectedMessages: number
    orphanMessages: number
  }
  try {
    const integrityRow = database.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined
    const integrity = String(integrityRow ? Object.values(integrityRow)[0] : '')
    const tables = new Set((database.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>).map((row) => row.name))
    const missingTables = REQUIRED_TABLES.filter((name) => !tables.has(name))
    if (missingTables.length) {
      inspection = {
        integrity, missingTables, totalConversations: 0, approvedConversations: 0,
        rejectedConversations: 0, unreviewedConversations: 0, totalMessages: 0,
        approvedMessages: 0, rejectedMessages: 0, orphanMessages: 0,
      }
    } else {
      const approvedPredicate = APPROVED_CONVERSATION_SOURCES.length
        ? `LOWER(COALESCE(source,'')) IN (${placeholders(APPROVED_CONVERSATION_SOURCES)})`
        : '0=1'
      const rejectedPredicate = `LOWER(COALESCE(source,'')) IN (${placeholders(REJECTED_CONVERSATION_SOURCES)})`
      const approvedValues = [...APPROVED_CONVERSATION_SOURCES]
      const rejectedValues = [...REJECTED_CONVERSATION_SOURCES]
      const totalConversations = sqliteCount(database, 'SELECT COUNT(*) FROM agent_conversations')
      const approvedConversations = sqliteCount(database, `SELECT COUNT(*) FROM agent_conversations WHERE ${approvedPredicate}`, approvedValues)
      const rejectedConversations = sqliteCount(database, `SELECT COUNT(*) FROM agent_conversations WHERE ${rejectedPredicate}`, rejectedValues)
      inspection = {
        integrity,
        missingTables,
        totalConversations,
        approvedConversations,
        rejectedConversations,
        unreviewedConversations: totalConversations - approvedConversations - rejectedConversations,
        totalMessages: sqliteCount(database, 'SELECT COUNT(*) FROM agent_messages'),
        approvedMessages: sqliteCount(database, `
          SELECT COUNT(*) FROM agent_messages m
          JOIN agent_conversations c ON c.id=m.conversation_id
          WHERE ${approvedPredicate.replaceAll('source', 'c.source')}
        `, approvedValues),
        rejectedMessages: sqliteCount(database, `
          SELECT COUNT(*) FROM agent_messages m
          JOIN agent_conversations c ON c.id=m.conversation_id
          WHERE ${rejectedPredicate.replaceAll('source', 'c.source')}
        `, rejectedValues),
        orphanMessages: sqliteCount(database, `
          SELECT COUNT(*) FROM agent_messages m
          LEFT JOIN agent_conversations c ON c.id=m.conversation_id
          WHERE c.id IS NULL
        `),
      }
    }
  } finally {
    database.close()
  }

  const issues: Array<{ severity: 'error' | 'warning'; code: string; message: string; count?: number }> = []
  if (sourceSha256 !== EXPECTED_SOURCE_SHA256) issues.push({ severity: 'error', code: 'JW_SOURCE_CHECKSUM_CHANGED', message: 'JW source is not the checksum-approved backup.' })
  if (inspection.integrity !== 'ok') issues.push({ severity: 'error', code: 'JW_SOURCE_INTEGRITY_FAILED', message: 'JW SQLite integrity check failed.' })
  if (inspection.missingTables.length) issues.push({ severity: 'error', code: 'JW_REQUIRED_TABLE_MISSING', message: 'One or more reviewed JW tables are missing.', count: inspection.missingTables.length })
  if (inspection.unreviewedConversations !== 0) issues.push({ severity: 'error', code: 'JW_UNREVIEWED_SOURCE_PRESENT', message: 'JW source contains conversations outside the explicit allow/reject sets.', count: inspection.unreviewedConversations })
  if (inspection.approvedConversations !== 0 || inspection.approvedMessages !== 0) issues.push({ severity: 'error', code: 'JW_APPROVED_BASELINE_CHANGED', message: 'The reviewed JW migration allowlist baseline changed and requires a new approval.', count: inspection.approvedConversations })
  if (inspection.rejectedConversations !== EXPECTED_REJECTED_CONVERSATIONS || inspection.rejectedMessages !== EXPECTED_REJECTED_MESSAGES) issues.push({ severity: 'error', code: 'JW_REJECTED_BASELINE_CHANGED', message: 'The reviewed rejected-source counts changed.', count: inspection.rejectedConversations })
  if (inspection.orphanMessages !== 0) issues.push({ severity: 'error', code: 'JW_ORPHAN_MESSAGE_PRESENT', message: 'JW source contains orphan messages.', count: inspection.orphanMessages })
  if (!issues.some((issue) => issue.severity === 'error')) issues.push({
    severity: 'warning',
    code: 'JW_REJECTED_SOURCE_EXCLUDED',
    message: 'All reviewed JW conversations and messages are outside the migration allowlist; no message payload was read or written.',
    count: inspection.rejectedConversations,
  })

  await ensureSchema()
  const before = await targetSentinel()
  const approvedProjection = { conversations: 0, messages: 0, conversationMappings: 0, messageMappings: 0 }
  const normalizedChecksum = createHash('sha256').update(JSON.stringify(approvedProjection)).digest('hex')
  const errorCount = issues.filter((issue) => issue.severity === 'error').length
  const baseReport = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    ok: errorCount === 0,
    mode: apply ? 'apply' : 'preview',
    sourceReference: 'checksum-bound-jw-sessions-backup',
    sourceSha256,
    sourceIntegrity: inspection.integrity,
    sourceCounts: {
      conversations: inspection.totalConversations,
      messages: inspection.totalMessages,
      approvedConversations: inspection.approvedConversations,
      approvedMessages: inspection.approvedMessages,
      rejectedConversations: inspection.rejectedConversations,
      rejectedMessages: inspection.rejectedMessages,
      unreviewedConversations: inspection.unreviewedConversations,
      orphanMessages: inspection.orphanMessages,
    },
    approvedSourceValues: APPROVED_CONVERSATION_SOURCES.length,
    rejectedSourceValues: REJECTED_CONVERSATION_SOURCES.length,
    targetProjection: approvedProjection,
    sourceChecksum: normalizedChecksum,
    targetChecksum: normalizedChecksum,
    targetBusinessRowsChanged: 0,
    issueCounts: { errors: errorCount, warnings: issues.filter((issue) => issue.severity === 'warning').length },
    issues,
  }

  if (errorCount > 0) {
    await writeEvidence(baseReport)
    console.log(JSON.stringify(baseReport))
    process.exitCode = 2
    return
  }

  let runRecorded = false
  if (apply) {
    const [existing] = await pool.query<RowDataPacket[]>(`
      SELECT id FROM ${table('migration_runs')}
      WHERE migration_type='jw-sqlite-to-mysql' AND source_sha256=? AND status='succeeded'
      ORDER BY started_at LIMIT 1
    `, [sourceSha256])
    if (!existing.length) {
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        const runId = randomUUID()
        await connection.execute(`
          INSERT INTO ${table('migration_runs')}
            (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,source_checksum,target_checksum,report,started_at,completed_at)
          VALUES (?,?,?,?,?,'succeeded',?,?,?,?,?,NOW(3),NOW(3))
        `, [runId, 'jw-sqlite-to-mysql', `jw-sqlite:${sourceSha256}`, sourceSha256, 'apply',
          JSON.stringify(baseReport.sourceCounts), JSON.stringify(approvedProjection), normalizedChecksum,
          normalizedChecksum, JSON.stringify(baseReport)])
        const exclusion = issues.find((issue) => issue.code === 'JW_REJECTED_SOURCE_EXCLUDED')!
        await connection.execute(`
          INSERT INTO ${table('migration_issues')}
            (id,run_id,severity,source_system,source_table,source_key,code,message,payload,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,NOW(3))
        `, [randomUUID(), runId, exclusion.severity, 'jw-sqlite', 'agent_conversations', null,
          exclusion.code, exclusion.message, JSON.stringify({ conversations: inspection.rejectedConversations, messages: inspection.rejectedMessages })])
        await connection.commit()
      } catch (error) {
        await connection.rollback()
        throw error
      } finally {
        connection.release()
      }
    }
    runRecorded = true
  }

  const after = await targetSentinel()
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('JW migration changed Agent business or source-mapping rows outside the approved empty projection')
  const report = { ...baseReport, applied: apply, runRecorded, idempotent: true }
  await writeEvidence(report)
  console.log(JSON.stringify(report))
}

await main().finally(async () => pool.end())
