import { createHash, randomUUID } from 'node:crypto'
import { db, pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { auditLogs } from '../db/schema.js'

export const jobCoordinationModule = '任务协调'
const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))

export const jobCoordinationActions = {
  leaseContention: '租约领取争抢未获',
  duplicateSuppressed: '重复任务入队已抑制',
  leaseRecovered: '过期租约已恢复',
  staleCompletionRejected: '过期执行结果已拒绝',
} as const

export type JobCoordinationEvent = keyof typeof jobCoordinationActions
export type JobCoordinationDomain = 'runtime-job' | 'lead-score' | 'project-score' | 'ai-task'

export function jobCoordinationTarget(domain: JobCoordinationDomain, entityId: string) {
  const identityHash = createHash('sha256').update(entityId).digest('hex')
  return `${domain}:${identityHash}`
}

export async function recordJobCoordinationEvent(input: {
  domain: JobCoordinationDomain
  entityId: string
  event: JobCoordinationEvent
}) {
  const target = jobCoordinationTarget(input.domain, input.entityId)
  if (input.event === 'leaseContention') {
    await pool.query(
      `INSERT INTO ${auditTable}
        (id,user_id,user_name,module,action,target,result,request_id,created_at)
       SELECT ?,NULL,'（系统）',?,?,?,'success',?,NOW(3)
       WHERE NOT EXISTS (
         SELECT 1 FROM ${auditTable}
         WHERE module=? AND action=? AND target=?
           AND created_at >= NOW(3) - INTERVAL 1 MINUTE
       )`,
      [
        randomUUID(), jobCoordinationModule, jobCoordinationActions[input.event], target, randomUUID(),
        jobCoordinationModule, jobCoordinationActions[input.event], target,
      ],
    )
    return
  }
  await db.insert(auditLogs).values({
    id: randomUUID(),
    userId: null,
    userName: '（系统）',
    module: jobCoordinationModule,
    action: jobCoordinationActions[input.event],
    target,
    result: 'success',
    requestId: randomUUID(),
  })
}

export async function recordJobCoordinationEvents(input: {
  domain: JobCoordinationDomain
  entityIds: string[]
  event: JobCoordinationEvent
}) {
  await Promise.all(input.entityIds.map((entityId) => recordJobCoordinationEvent({
    domain: input.domain,
    entityId,
    event: input.event,
  })))
}

export function recordJobCoordinationEventSafely(input: {
  domain: JobCoordinationDomain
  entityId: string
  event: JobCoordinationEvent
}) {
  return recordJobCoordinationEvent(input).catch(() => {
    console.error(`[job-coordination] failed to persist ${input.event} event for ${input.domain}`)
  })
}

export function recordJobCoordinationEventsSafely(input: {
  domain: JobCoordinationDomain
  entityIds: string[]
  event: JobCoordinationEvent
}) {
  return recordJobCoordinationEvents(input).catch(() => {
    console.error(`[job-coordination] failed to persist ${input.event} events for ${input.domain}`)
  })
}
