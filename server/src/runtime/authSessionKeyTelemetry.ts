import { createHash } from 'node:crypto'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { formatShanghaiDateKey } from '../utils/shanghaiTime.js'

export const authSessionKeyTelemetryModule = '账号安全'
export const previousAuthSessionKeyAction = '历史会话密钥命中'
const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))

function stableUuid(value: string) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}

export function previousAuthSessionKeyTarget(sessionId: string, now = new Date()) {
  const sessionHash = createHash('sha256').update(sessionId).digest('hex')
  const day = formatShanghaiDateKey(now)
  return `session:${sessionHash};day=${day}`
}

export async function recordPreviousAuthSessionKeyUse(sessionId: string, now = new Date()) {
  const target = previousAuthSessionKeyTarget(sessionId, now)
  const [result] = await pool.query(
    `INSERT IGNORE INTO ${auditTable}
      (id,user_id,user_name,module,action,target,result,request_id,created_at)
     VALUES (?,NULL,'（系统）',?,?,?,'success',?,?)`,
    [
      stableUuid(`auth-previous-key:${target}`),
      authSessionKeyTelemetryModule,
      previousAuthSessionKeyAction,
      target,
      stableUuid(`auth-previous-key-request:${target}`),
      now,
    ],
  )
  return { recorded: Number((result as { affectedRows?: number }).affectedRows || 0) === 1, target }
}

export function recordPreviousAuthSessionKeyUseSafely(sessionId: string, now = new Date()) {
  return recordPreviousAuthSessionKeyUse(sessionId, now).catch(() => {
    console.error('[auth-session-key] failed to persist previous-key usage event')
  })
}
