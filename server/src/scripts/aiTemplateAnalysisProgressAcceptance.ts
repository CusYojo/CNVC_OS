import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'
import {
  completeAiTemplateAnalysisProgress,
  failAiTemplateAnalysisProgress,
  getAiTemplateAnalysisProgress,
  recoverInterruptedAiTemplateAnalysisProgress,
  startAiTemplateAnalysisProgress,
  updateAiTemplateAnalysisProgress,
} from '../services/aiTemplateAnalysisProgressService.js'

const usersTable = quoteMysqlIdentifier(mysqlTableName('users'))
const projectsTable = quoteMysqlIdentifier(mysqlTableName('projects'))
const tasksTable = quoteMysqlIdentifier(mysqlTableName('ai_tasks'))
const progressTable = quoteMysqlIdentifier(mysqlTableName('ai_template_analysis_progress'))
const userId = randomUUID()
const projectId = randomUUID()
const taskId = randomUUID()
const progressId = randomUUID()
const interruptedId = randomUUID()
const failedId = randomUUID()
const checks: string[] = []

function check(condition: unknown, name: string): asserts condition {
  if (!condition) throw new Error(`[template progress] failed: ${name}`)
  checks.push(name)
}

async function main() {
  await ensureSchema()
  await pool.query(
    `INSERT INTO ${usersTable}
      (id,email,name,role,department,password_hash,status,created_at)
     VALUES (?,?,?,'系统管理员','测试部',?,'启用',NOW(3))`,
    [userId, `template-progress-${userId}@example.invalid`, '模板进度验收', '$2b$12$012345678901234567890u012345678901234567890123456789012'],
  )
  await pool.query(
    `INSERT INTO ${projectsTable}
      (id,name,stage,owner,collaborators,risk_level,score,progress,tags,pinned,created_at,updated_at)
     VALUES (?,?,'线索','模板进度验收',JSON_ARRAY(),'低',0,0,JSON_ARRAY(),0,NOW(3),NOW(3))`,
    [projectId, `模板进度项目-${projectId.slice(0, 8)}`],
  )
  await pool.query(
    `INSERT INTO ${tasksTable}
      (id,user_id,project_id,type,parameters,template_version,status,stage,progress,
       cancellation_requested,execution_attempts,idempotency_key,request_hash,created_at,updated_at)
     VALUES (?,?,?,'investment_recommendation_ppt',JSON_OBJECT(),'acceptance','pending','模板准备',0,
       0,0,?,?,NOW(3),NOW(3))`,
    [taskId, userId, projectId, `template-progress-${taskId}`, taskId.replaceAll('-', '')],
  )
  try {
    const input = {
      id: progressId,
      userId,
      projectId,
      taskId,
      fileName: '模板.pptx',
      purpose: 'investment_recommendation_ppt',
    }
    const started = await startAiTemplateAnalysisProgress(input)
    const duplicate = await startAiTemplateAnalysisProgress(input)
    check(started.created && !duplicate.created && duplicate.progress.status === 'running', 'mysql-start-is-persistent-and-idempotent')

    const hidden = await getAiTemplateAnalysisProgress(randomUUID(), progressId)
    check(hidden === undefined, 'progress-is-isolated-by-stable-user-id')

    let conflictCode = ''
    try {
      await startAiTemplateAnalysisProgress({ ...input, fileName: '另一个模板.pptx' })
    } catch (error) {
      conflictCode = String((error as { code?: string }).code || '')
    }
    check(conflictCode === 'TEMPLATE_PROGRESS_ID_CONFLICT', 'same-progress-id-cannot-be-rebound')

    await updateAiTemplateAnalysisProgress(progressId, { stage: '解析页面', progress: 60 })
    await updateAiTemplateAnalysisProgress(progressId, { stage: '旧进度', progress: 20 })
    const updated = await getAiTemplateAnalysisProgress(userId, progressId)
    check(updated?.progress === 60 && updated.stage === '旧进度', 'progress-percent-is-monotonic-and-stage-is-persistent')

    await completeAiTemplateAnalysisProgress(progressId, { templateId: 'template-1', analysis: { pages: 5 } })
    const completed = await getAiTemplateAnalysisProgress(userId, progressId)
    check(completed?.status === 'succeeded' && (completed.result as { templateId?: string })?.templateId === 'template-1', 'terminal-result-is-persistent-json')

    await startAiTemplateAnalysisProgress({
      ...input,
      id: interruptedId,
      taskId: undefined,
      purpose: 'custom_template_document',
      fileName: '中断模板.docx',
    })
    const recovered = await recoverInterruptedAiTemplateAnalysisProgress()
    const interrupted = await getAiTemplateAnalysisProgress(userId, interruptedId)
    check(recovered === 1 && interrupted?.status === 'failed' && interrupted.errorMessage?.includes('重新提交'), 'startup-marks-unresumable-running-analysis-failed')

    await startAiTemplateAnalysisProgress({
      ...input,
      id: failedId,
      taskId: undefined,
      purpose: 'custom_template_document',
      fileName: '失败模板.docx',
    })
    const fakeSecret = `sk-${'x'.repeat(32)}`
    await failAiTemplateAnalysisProgress(failedId, `gateway rejected ${fakeSecret}`)
    const failed = await getAiTemplateAnalysisProgress(userId, failedId)
    check(failed?.status === 'failed' && !failed.errorMessage?.includes(fakeSecret), 'failure-message-is-redacted-before-persistence')

    await pool.query(
      `UPDATE ${progressTable} SET expires_at=DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE id=?`,
      [progressId],
    )
    const expired = await getAiTemplateAnalysisProgress(userId, progressId)
    check(expired === undefined, 'expired-terminal-progress-is-cleaned-from-mysql')
  } finally {
    await pool.query(`DELETE FROM ${projectsTable} WHERE id=?`, [projectId])
    await pool.query(`DELETE FROM ${usersTable} WHERE id=?`, [userId])
  }
  const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) AS count FROM ${progressTable} WHERE user_id=? OR project_id=?`,
    [userId, projectId],
  )
  check(Number(rows[0]?.count || 0) === 0, 'user-or-project-delete-cascades-progress')
  console.log(JSON.stringify({ ok: true, checks, count: checks.length }))
}

await main().finally(() => pool.end())
