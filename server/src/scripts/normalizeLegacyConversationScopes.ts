import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'

type Candidate = {
  id: string
  chatScope: string
  agentScope: string
  legacySource: string | null
  messageCount: number | string
  taskCount: number | string
}

const apply = process.argv.includes('--apply')
const issueCode = 'LEGACY_CONVERSATION_PROJECT_SCOPE_MISSING'
const migrationType = 'legacy-conversation-scope-normalization'
const outputDir = path.resolve('.runtime/migration-evidence/legacy-conversation-scope-normalization')

function table(name: string): string {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

function checksum(values: string[]): string {
  return createHash('sha256').update(JSON.stringify([...values].sort())).digest('hex')
}

async function writeEvidence(report: Record<string, unknown>) {
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  await chmod(outputDir, 0o700)
  const target = path.join(outputDir, 'report.json')
  const summary = path.join(outputDir, 'summary.md')
  const suffix = `.${process.pid}-${Date.now()}`
  await writeFile(`${target}${suffix}`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await writeFile(`${summary}${suffix}`, [
    '# 历史会话缺失项目范围规范化', '',
    `- 模式：${report.mode}`,
    `- 符合严格条件的记录：${report.candidates}`,
    `- 本次写入：${report.written}`,
    `- 阻断记录：${report.blockers}`,
    '- 仅处理 legacy_postgres、项目 ID 为空、两张索引 scope 均为 project、且无消息/AI 任务的历史空会话。',
    '- 不猜测项目、不改用户或会话 ID；原 scope 与处置原因保存在迁移问题台账，可按台账回滚。', '',
  ].join('\n'), { mode: 0o600 })
  await rename(`${target}${suffix}`, target)
  await rename(`${summary}${suffix}`, summary)
  await Promise.all([chmod(target, 0o600), chmod(summary, 0o600)])
}

async function main() {
  await ensureSchema()
  const [invalidRows] = await pool.query<Array<RowDataPacket & Candidate>>(`
    SELECT c.id,c.scope AS chatScope,a.scope AS agentScope,a.legacy_source AS legacySource,
      (SELECT COUNT(*) FROM ${table('agent_messages')} m WHERE m.conversation_id=c.id) AS messageCount,
      (SELECT COUNT(*) FROM ${table('ai_tasks')} t WHERE t.conversation_id=c.id) AS taskCount
    FROM ${table('chat_conversations')} c
    JOIN ${table('agent_conversations')} a ON a.id=c.id
    WHERE c.scope='project' AND c.project_id IS NULL
  `)
  const candidates = invalidRows.filter((row) =>
    row.agentScope === 'project'
      && row.legacySource === 'legacy_postgres'
      && Number(row.messageCount) === 0
      && Number(row.taskCount) === 0)
  const blockers = invalidRows.length - candidates.length
  if (blockers) throw new Error(`legacy conversation scope normalization has ${blockers} blocking row(s)`)
  const sourceChecksum = checksum(candidates.map((row) => `${row.id}:project:null`))
  const targetChecksum = checksum(candidates.map((row) => `${row.id}:global:null`))
  const baseReport = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    ok: true,
    mode: apply ? 'apply' : 'preview',
    mutatesDatabase: apply,
    candidates: candidates.length,
    blockers,
    sourceChecksum,
    targetChecksum,
    selection: {
      source: 'legacy_postgres',
      originalScope: 'project',
      projectId: 'null',
      messages: 0,
      aiTasks: 0,
    },
  }
  if (!apply || !candidates.length) {
    const report = { ...baseReport, written: 0, alreadyNormalized: candidates.length === 0 }
    await writeEvidence(report)
    console.log(JSON.stringify(report))
    return
  }

  const connection = await pool.getConnection()
  const runId = randomUUID()
  try {
    await connection.beginTransaction()
    let chatWritten = 0
    let agentWritten = 0
    for (const candidate of candidates) {
      const [chatResult] = await connection.execute<ResultSetHeader>(`
        UPDATE ${table('chat_conversations')}
        SET scope='global',updated_at=NOW(3)
        WHERE id=? AND scope='project' AND project_id IS NULL
      `, [candidate.id])
      const [agentResult] = await connection.execute<ResultSetHeader>(`
        UPDATE ${table('agent_conversations')}
        SET scope='global',updated_at=NOW(3)
        WHERE id=? AND scope='project' AND project_id IS NULL
          AND legacy_source='legacy_postgres'
          AND NOT EXISTS (SELECT 1 FROM ${table('agent_messages')} m WHERE m.conversation_id=?)
          AND NOT EXISTS (SELECT 1 FROM ${table('ai_tasks')} t WHERE t.conversation_id=?)
      `, [candidate.id, candidate.id, candidate.id])
      chatWritten += chatResult.affectedRows
      agentWritten += agentResult.affectedRows
      if (chatResult.affectedRows !== 1 || agentResult.affectedRows !== 1) {
        throw new Error('legacy conversation scope changed after preview; transaction rolled back')
      }
    }
    const report = {
      ...baseReport,
      written: candidates.length,
      chatRowsWritten: chatWritten,
      agentRowsWritten: agentWritten,
      reversible: true,
    }
    await connection.execute(`
      INSERT INTO ${table('migration_runs')}
        (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,
         source_checksum,target_checksum,report,started_at,completed_at)
      VALUES (?,?,?,?,'apply','succeeded',?,?,?,?,?,NOW(3),NOW(3))
    `, [
      runId, migrationType, 'mysql:legacy_postgres/chat_conversations', sourceChecksum,
      JSON.stringify({ chat_conversations: candidates.length, agent_conversations: candidates.length }),
      JSON.stringify({ chat_conversations: chatWritten, agent_conversations: agentWritten }),
      sourceChecksum, targetChecksum, JSON.stringify(report),
    ])
    for (const candidate of candidates) {
      await connection.execute(`
        INSERT INTO ${table('migration_issues')}
          (id,run_id,severity,source_system,source_table,source_key,code,message,payload)
        VALUES (?,?,'warning','legacy_postgres','chat_conversations',?,?,?,?)
      `, [
        randomUUID(), runId, candidate.id, issueCode,
        'Legacy conversation declared project scope without a project ID; empty conversation normalized to global scope.',
        JSON.stringify({
          originalChatScope: candidate.chatScope,
          originalAgentScope: candidate.agentScope,
          originalProjectId: null,
          messageCount: 0,
          taskCount: 0,
          decision: 'normalize-empty-projectless-legacy-conversation-to-global',
        }),
      ])
    }
    await connection.commit()
    await writeEvidence(report)
    console.log(JSON.stringify(report))
  } catch (error) {
    await connection.rollback().catch(() => undefined)
    throw error
  } finally {
    connection.release()
  }
}

await main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => pool.end())
