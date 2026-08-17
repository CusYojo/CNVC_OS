import { db } from '../db/client.js'
import { auditLogs } from '../db/schema.js'

export async function writeAudit(input: {
  userId: string
  userName: string
  module: string
  action: string
  target: string
  ip?: string
  result?: 'success' | 'failed' | 'denied'
  requestId?: string
}) {
  await db.insert(auditLogs).values({
    userId: input.userId,
    userName: input.userName.slice(0, 64),
    module: input.module.slice(0, 32),
    action: input.action.slice(0, 64),
    target: input.target.slice(0, 8_000),
    ip: input.ip?.slice(0, 45),
    result: input.result ?? 'success',
    ...(input.requestId ? { requestId: input.requestId.slice(0, 64) } : {}),
  })
}
