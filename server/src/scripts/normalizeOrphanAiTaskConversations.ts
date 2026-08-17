import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'

type CopyTable = { columns: string[]; rows: string[][] }
type SourceTask = { id: string; userId: string; projectId: string; conversationId: string }
type SourceArtifact = { taskId: string; conversationId: string }
type Candidate = SourceTask & { sourceArtifactCount: number; targetArtifactCount: number }

const apply = process.argv.includes('--apply')
const dumpPath = path.resolve(process.env.PG_DUMP_PATH?.trim() || 'cybernaut_mvp_dump.sql')
const outputDir = path.resolve(process.cwd(), '.runtime/migration-evidence/ai-task-orphan-conversations')
const issueCode = 'SOURCE_ORPHAN_CONVERSATION_REFERENCE'

function table(name: string): string {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

function parseCopyTable(text: string, tableName: string): CopyTable {
  const lines = text.split('\n')
  const prefix = `COPY public.${tableName} (`
  const start = lines.findIndex((line) => line.startsWith(prefix) && line.endsWith(') FROM stdin;'))
  if (start < 0) throw new Error(`required COPY block public.${tableName} is missing`)
  const header = lines[start]
  const columns = header.slice(prefix.length, -') FROM stdin;'.length).split(', ')
  const rows: string[][] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index]
    if (line === String.raw`\.`) return { columns, rows }
    const values = line.split('\t')
    if (values.length !== columns.length) throw new Error(`invalid COPY row in public.${tableName}`)
    rows.push(values)
  }
  throw new Error(`unterminated COPY block public.${tableName}`)
}

function value(row: string[], columns: string[], name: string): string | null {
  const index = columns.indexOf(name)
  if (index < 0) throw new Error(`required source column ${name} is missing`)
  const raw = row[index]
  return raw === String.raw`\N` ? null : raw
}

function countByTask(artifacts: SourceArtifact[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const artifact of artifacts) result.set(artifact.taskId, (result.get(artifact.taskId) ?? 0) + 1)
  return result
}

async function writeReport(report: Record<string, unknown>): Promise<void> {
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  const reportPath = path.resolve(outputDir, 'report.json')
  const summaryPath = path.resolve(outputDir, 'summary.md')
  const suffix = `.${process.pid}-${Date.now()}`
  await writeFile(`${reportPath}${suffix}`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  const counts = report.counts as Record<string, number>
  const markdown = [
    '# AI 任务孤立会话引用迁移处置', '',
    `生成时间：${report.generatedAt}`, '',
    `- 模式：${report.mode}`,
    `- dump 中 AI 任务：${counts.sourceTasks}`,
    `- dump 中会话：${counts.sourceConversations}`,
    `- 源端孤立会话引用：${counts.sourceOrphans}`,
    `- 本次计划规范化：${counts.planned}`,
    `- 已有可追溯规范化：${counts.alreadyNormalized}`,
    `- 阻断问题：${counts.blockers}`, '',
    '处置只把源端不存在会话记录的任务/产物 `conversation_id` 改为 `NULL`；原 ID、dump SHA-256、任务和产物计数写入 `migration_runs/migration_issues`。不会创建空会话，也不会修改任务正文、产物或来源内容。', '',
    '完整记录见 `report.json`。',
  ].join('\n')
  await writeFile(`${summaryPath}${suffix}`, markdown, { mode: 0o600 })
  await rename(`${reportPath}${suffix}`, reportPath)
  await rename(`${summaryPath}${suffix}`, summaryPath)
}

async function main(): Promise<void> {
  await ensureSchema()
  const dumpBuffer = await readFile(dumpPath)
  const dumpSha256 = createHash('sha256').update(dumpBuffer).digest('hex')
  const dumpText = dumpBuffer.toString('utf8')
  const conversationBlock = parseCopyTable(dumpText, 'chat_conversations')
  const taskBlock = parseCopyTable(dumpText, 'ai_tasks')
  const artifactBlock = parseCopyTable(dumpText, 'ai_artifacts')
  const sourceConversationIds = new Set(conversationBlock.rows.map((row) => value(row, conversationBlock.columns, 'id')!))
  const sourceTasks: SourceTask[] = taskBlock.rows.flatMap((row) => {
    const conversationId = value(row, taskBlock.columns, 'conversation_id')
    if (!conversationId) return []
    return [{
      id: value(row, taskBlock.columns, 'id')!,
      userId: value(row, taskBlock.columns, 'user_id')!,
      projectId: value(row, taskBlock.columns, 'project_id')!,
      conversationId,
    }]
  })
  const sourceArtifacts: SourceArtifact[] = artifactBlock.rows.flatMap((row) => {
    const conversationId = value(row, artifactBlock.columns, 'conversation_id')
    if (!conversationId) return []
    return [{ taskId: value(row, artifactBlock.columns, 'task_id')!, conversationId }]
  })
  const sourceArtifactCounts = countByTask(sourceArtifacts)
  const sourceOrphans = sourceTasks.filter((task) => !sourceConversationIds.has(task.conversationId))
  const sourceTaskIds = sourceOrphans.map((task) => task.id)
  if (!sourceTaskIds.length) throw new Error('dump contains no orphan AI task conversation references')

  const placeholders = sourceTaskIds.map(() => '?').join(',')
  const [targetRows] = await pool.query<Array<RowDataPacket & {
    id: string; userId: string; projectId: string; conversationId: string | null;
    chatConversationId: string | null; agentConversationId: string | null; targetArtifactCount: number | string;
    nonMatchingArtifactCount: number | string
  }>>(`
    SELECT t.id,t.user_id AS userId,t.project_id AS projectId,t.conversation_id AS conversationId,
           c.id AS chatConversationId,ac.id AS agentConversationId,
           (SELECT COUNT(*) FROM ${table('ai_artifacts')} a WHERE a.task_id=t.id) AS targetArtifactCount,
           (SELECT COUNT(*) FROM ${table('ai_artifacts')} a WHERE a.task_id=t.id AND NOT (a.conversation_id <=> t.conversation_id)) AS nonMatchingArtifactCount
    FROM ${table('ai_tasks')} t
    LEFT JOIN ${table('chat_conversations')} c ON c.id=t.conversation_id
    LEFT JOIN ${table('agent_conversations')} ac ON ac.id=t.conversation_id
    WHERE t.id IN (${placeholders})
  `, sourceTaskIds)
  const targetById = new Map(targetRows.map((row) => [row.id, row]))

  const [issueRows] = await pool.query<Array<RowDataPacket & { sourceKey: string; payload: unknown }>>(`
    SELECT i.source_key AS sourceKey,i.payload
    FROM ${table('migration_issues')} i JOIN ${table('migration_runs')} r ON r.id=i.run_id
    WHERE i.source_system='postgres_dump' AND i.code=? AND r.status='succeeded'
  `, [issueCode])
  const issueByTask = new Map(issueRows.map((row) => [row.sourceKey, typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload]))
  const planned: Candidate[] = []
  const alreadyNormalized: Candidate[] = []
  const blockers: Array<{ taskId: string; code: string }> = []

  for (const sourceTask of sourceOrphans) {
    const target = targetById.get(sourceTask.id)
    const sourceArtifactCount = sourceArtifactCounts.get(sourceTask.id) ?? 0
    if (!target) {
      blockers.push({ taskId: sourceTask.id, code: 'TARGET_TASK_MISSING' })
      continue
    }
    const candidate = { ...sourceTask, sourceArtifactCount, targetArtifactCount: Number(target.targetArtifactCount) }
    if (target.userId !== sourceTask.userId || target.projectId !== sourceTask.projectId) {
      blockers.push({ taskId: sourceTask.id, code: 'TARGET_TASK_IDENTITY_MISMATCH' })
      continue
    }
    if (sourceArtifacts.some((artifact) => artifact.taskId === sourceTask.id && artifact.conversationId !== sourceTask.conversationId)) {
      blockers.push({ taskId: sourceTask.id, code: 'SOURCE_ARTIFACT_CONVERSATION_MISMATCH' })
      continue
    }
    if (target.conversationId === null) {
      const payload = issueByTask.get(sourceTask.id) as { originalConversationId?: unknown; dumpSha256?: unknown } | undefined
      const [artifactCountRows] = await pool.query<Array<RowDataPacket & { count: number | string }>>(
        `SELECT COUNT(*) AS count FROM ${table('ai_artifacts')} WHERE task_id=? AND conversation_id IS NOT NULL`,
        [sourceTask.id],
      )
      if (payload?.originalConversationId === sourceTask.conversationId
        && payload.dumpSha256 === dumpSha256 && Number(artifactCountRows[0]?.count ?? 0) === 0) {
        alreadyNormalized.push(candidate)
      } else blockers.push({ taskId: sourceTask.id, code: 'UNTRACKED_TARGET_NULL_REFERENCE' })
      continue
    }
    if (target.conversationId !== sourceTask.conversationId || target.chatConversationId || target.agentConversationId) {
      blockers.push({ taskId: sourceTask.id, code: 'TARGET_CONVERSATION_STATE_MISMATCH' })
      continue
    }
    if (Number(target.nonMatchingArtifactCount) !== 0 || Number(target.targetArtifactCount) !== sourceArtifactCount) {
      blockers.push({ taskId: sourceTask.id, code: 'TARGET_ARTIFACT_SET_MISMATCH' })
      continue
    }
    planned.push(candidate)
  }

  const generatedAt = new Date().toISOString()
  const baseReport = {
    schemaVersion: '1.0', generatedAt, mode: apply ? 'apply' : 'preview', dumpSha256,
    counts: {
      sourceTasks: taskBlock.rows.length,
      sourceConversations: conversationBlock.rows.length,
      sourceArtifacts: artifactBlock.rows.length,
      sourceOrphans: sourceOrphans.length,
      planned: planned.length,
      alreadyNormalized: alreadyNormalized.length,
      blockers: blockers.length,
    },
    blockers,
    policy: 'normalize-missing-source-conversation-reference-to-null-with-durable-issue-ledger',
  }
  if (blockers.length) {
    await writeReport({ ...baseReport, ok: false, applied: false })
    throw new Error(`AI task orphan conversation normalization blocked by ${blockers.length} issue(s)`)
  }
  if (!apply || planned.length === 0) {
    const report = { ...baseReport, ok: true, applied: false, idempotent: planned.length === 0 }
    await writeReport(report)
    console.log(JSON.stringify(report))
    return
  }

  const runId = randomUUID()
  const normalizedTupleHash = createHash('sha256').update(JSON.stringify(sourceOrphans
    .map((task) => [task.id, task.conversationId, sourceArtifactCounts.get(task.id) ?? 0])
    .sort(([left], [right]) => String(left).localeCompare(String(right))))).digest('hex')
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [locked] = await connection.query<RowDataPacket[]>(
      `SELECT id,conversation_id FROM ${table('ai_tasks')} WHERE id IN (${planned.map(() => '?').join(',')}) FOR UPDATE`,
      planned.map((item) => item.id),
    )
    if (locked.length !== planned.length) throw new Error('target task set changed before normalization')
    for (const item of planned) {
      const lockedTask = locked.find((row) => row.id === item.id)
      if (lockedTask?.conversation_id !== item.conversationId) throw new Error(`target task changed before normalization: ${item.id}`)
      await connection.query(
        `UPDATE ${table('ai_artifacts')} SET conversation_id=NULL WHERE task_id=? AND conversation_id=?`,
        [item.id, item.conversationId],
      )
      await connection.query(
        `UPDATE ${table('ai_tasks')} SET conversation_id=NULL WHERE id=? AND conversation_id=?`,
        [item.id, item.conversationId],
      )
    }
    const targetCounts = {
      chat_conversations: await countWithConnection(connection, 'chat_conversations'),
      ai_tasks: await countWithConnection(connection, 'ai_tasks'),
      ai_artifacts: await countWithConnection(connection, 'ai_artifacts'),
    }
    const runReport = {
      ...baseReport, ok: true, applied: true, runId,
      tables: [
        tableEvidence('chat_conversations', conversationBlock.rows.length, 0),
        tableEvidence('ai_tasks', taskBlock.rows.length, planned.length),
        tableEvidence('ai_artifacts', artifactBlock.rows.length, planned.reduce((sum, item) => sum + item.targetArtifactCount, 0)),
      ],
    }
    await connection.query(`
      INSERT INTO ${table('migration_runs')}
        (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,
         source_checksum,target_checksum,report,started_at,completed_at)
      VALUES (?,?,?,?,?,'succeeded',?,?,?,?,?,NOW(3),NOW(3))
    `, [
      runId, 'postgres-dump-orphan-conversation-normalization', path.basename(dumpPath), dumpSha256, 'apply',
      JSON.stringify({ chat_conversations: conversationBlock.rows.length, ai_tasks: taskBlock.rows.length, ai_artifacts: artifactBlock.rows.length }),
      JSON.stringify(targetCounts), normalizedTupleHash, normalizedTupleHash, JSON.stringify(runReport),
    ])
    for (const item of planned) {
      await connection.query(`
        INSERT INTO ${table('migration_issues')}
          (id,run_id,severity,source_system,source_table,source_key,code,message,payload)
        VALUES (?,?,'warning','postgres_dump','ai_tasks',?,?,?,?)
      `, [
        randomUUID(), runId, item.id, issueCode,
        'Source task referenced a conversation ID absent from the source conversation table; reference normalized to NULL.',
        JSON.stringify({
          originalConversationId: item.conversationId, dumpSha256,
          sourceArtifactCount: item.sourceArtifactCount, targetArtifactCount: item.targetArtifactCount,
          decision: 'normalized-to-null-no-source-conversation-row',
        }),
      ])
    }
    await connection.commit()
    await writeReport(runReport)
    console.log(JSON.stringify(runReport))
  } catch (error) {
    await connection.rollback().catch(() => undefined)
    throw error
  } finally {
    connection.release()
  }
}

function tableEvidence(name: string, sourceRows: number, writtenRows: number) {
  return {
    table: name, sourceRows, readRows: sourceRows, writtenRows,
    skippedRows: Math.max(0, sourceRows - writtenRows), failedRows: 0, status: 'verified',
  }
}

async function countWithConnection(connection: import('mysql2/promise').PoolConnection, name: string): Promise<number> {
  const [rows] = await connection.query<Array<RowDataPacket & { count: number | string }>>(
    `SELECT COUNT(*) AS count FROM ${table(name)}`,
  )
  return Number(rows[0]?.count ?? 0)
}

await main().finally(async () => pool.end())
