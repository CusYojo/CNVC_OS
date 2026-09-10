import { createHash } from 'node:crypto'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { pool } from '../../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../../db/config.js'
import { weixinIntakeStoredBody, type LinkIntakeSession } from '../../contracts/weixinLinkIntakeContract.js'

const table = quoteMysqlIdentifier(mysqlTableName('weixin_link_intakes'))
export async function attachWeixinKnowledgeBody(taskId: string, userId: string, knowledgeId: string) {
  const [result] = await pool.query<ResultSetHeader>(`UPDATE ${table} SET knowledge_entry_id=?,updated_at=NOW(3) WHERE id=? AND user_id=?`, [knowledgeId, taskId, userId])
  if (result.affectedRows !== 1) throw Object.assign(new Error('收录任务关联失败'), { code: 'WEIXIN_INTAKE_LINK_FAILED' })
}
export type WithIntakeResourceLock = <T>(key: string, operation: () => Promise<T>) => Promise<T>

export async function withWeixinLinkIntake<T>(
  bindingId: string, userId: string, messageId: string,
  operation: (session: LinkIntakeSession, save: (session: LinkIntakeSession) => Promise<void>, withResourceLock: WithIntakeResourceLock) => Promise<T>,
): Promise<T> {
  const id = createHash('sha256').update(`${bindingId}:${userId}`).digest('hex')
  const lock = `wx-intake:${id.slice(0, 48)}`
  const connection = await pool.getConnection()
  let acquired = false
  try {
    const [locks] = await connection.query<Array<RowDataPacket & { acquired: number }>>('SELECT GET_LOCK(?, 0) AS acquired', [lock])
    acquired = Number(locks[0]?.acquired) === 1
    if (!acquired) throw Object.assign(new Error('当前收录任务正在处理，请稍后回复“收录状态”。'), { code: 'WEIXIN_INTAKE_BUSY' })
    // Find a historical receipt first so a redelivered choice can never affect the newest task.
    const receiptPath = `$.receipts.${JSON.stringify(messageId)}`
    const [replayed] = await connection.query<Array<RowDataPacket & { payload: LinkIntakeSession | string }>>(
      `SELECT payload FROM ${table} WHERE session_key=? AND binding_id=? AND user_id=?
       AND (initial_message_id=? OR JSON_CONTAINS_PATH(payload,'one',?)) ORDER BY sequence DESC LIMIT 1`,
      [id, bindingId, userId, messageId, receiptPath],
    )
    const [rows] = replayed.length ? [replayed] : await connection.query<Array<RowDataPacket & { payload: LinkIntakeSession | string }>>(
      `SELECT payload FROM ${table} WHERE session_key=? AND binding_id=? AND user_id=? ORDER BY sequence DESC LIMIT 1`, [id, bindingId, userId],
    )
    const raw = rows[0]?.payload
    const session: LinkIntakeSession = typeof raw === 'string' ? JSON.parse(raw) : raw || { receipts: {} }
    if (replayed.length && session.task?.initialMessageId === messageId && !session.receipts[messageId]) {
      // A crash may occur after the task insert but before its first receipt. A late redelivery
      // must not recreate a cancelled task or change the current conversation's task.
      session.receipts[messageId] = '该链接请求已经登记。请回复“收录状态”查看当前任务，未完成时可回复“重试”。'
    }
    const save = async (value: LinkIntakeSession) => {
      if (!value.task) return
      const task = value.task
      await connection.query(`INSERT INTO ${table} (id,session_key,binding_id,user_id,initial_message_id,status,mode,article_body,payload,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,CAST(? AS JSON),NOW(3),NOW(3))
        ON DUPLICATE KEY UPDATE status=VALUES(status),mode=VALUES(mode),article_body=VALUES(article_body),payload=VALUES(payload),updated_at=NOW(3)`,
      [task.id, id, bindingId, userId, task.initialMessageId, task.status, task.mode || null, weixinIntakeStoredBody(task.article), JSON.stringify(value)])
    }
    const withResourceLock: WithIntakeResourceLock = async (key, work) => {
      const resourceLock = `wx-article:${createHash('sha256').update(key).digest('hex').slice(0, 48)}`
      const [result] = await connection.query<Array<RowDataPacket & { acquired: number }>>('SELECT GET_LOCK(?, 5) AS acquired', [resourceLock])
      if (Number(result[0]?.acquired) !== 1) throw Object.assign(new Error('文章正在收录，请重试'), { code: 'WEIXIN_INTAKE_BUSY' })
      try { return await work() }
      finally { await connection.query('SELECT RELEASE_LOCK(?)', [resourceLock]) }
    }
    return await operation(session, save, withResourceLock)
  } finally {
    if (acquired) await connection.query('SELECT RELEASE_LOCK(?)', [lock]).catch(() => connection.destroy())
    connection.release()
  }
}
