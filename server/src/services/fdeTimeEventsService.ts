import { createHash, randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { leaderTimeRequests, leaderTimeEvents, leaderTimeNotices, projectDutyAssignments, projects, roles, userRoles, users } from '../db/schema.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import type { TimeTx } from './fdeTimeAccessService.js'

export const timeHash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
export async function recordTimeEvent(tx: TimeTx, id: string, actorId: string, action: string, reason: string, requestId: string = randomUUID(), requestHash = timeHash({ id, actorId, action, reason, requestId })) {
  const [row] = await tx.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.id, id))
  await tx.insert(leaderTimeEvents).values({ timeRequestId: id, actorId, action, reason, requestId, requestHash, version: row.version, snapshot: { ...row } })
  await tx.update(leaderTimeNotices).set({ closedAt: new Date() }).where(and(eq(leaderTimeNotices.timeRequestId, id), isNull(leaderTimeNotices.closedAt)))
  if (row.status !== 'draft') {
    const [project] = await tx.select({ ownerId: projects.ownerUserId }).from(projects).where(eq(projects.id, row.projectId))
    const assigned = await tx.select({ id: projectDutyAssignments.userId }).from(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, row.projectId), inArray(projectDutyAssignments.duty, ['secretary', 'coordinator'])))
    const coordinators = await tx.select({ id: userRoles.userId }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(eq(roles.fdeCategory, 'coordinator'), eq(roles.status, '启用')))
    const ids = [...new Set([row.leaderId, row.submittedBy, project.ownerId, ...assigned.map((v) => v.id), ...coordinators.map((v) => v.id)].filter((v): v is string => Boolean(v && v !== actorId)))]
    const enabled = ids.length ? await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.status, '启用'))) : []
    if (enabled.length) await tx.insert(leaderTimeNotices).values(enabled.map((v) => ({ timeRequestId: id, recipientId: v.id, version: row.version, kind: action })))
  }
  const identity = createMySqlIdentityRepositoryContext(tx), actor = await identity.users.findById(actorId)
  await identity.audits.append({ userId: actorId, userName: actor?.name ?? '未知用户', module: '领导时间', action, target: `${row.projectId} / ${id} / v${row.version} / ${requestId}` })
}
// Caller locks the project first; leader locks serialize conflicts with other projects/calendar writes.
export async function closeTimeRequests(tx: TimeTx, projectId: string, actorId: string, reason: string, sourceDirectiveId?: string) {
  const condition = and(eq(leaderTimeRequests.projectId, projectId), sourceDirectiveId ? eq(leaderTimeRequests.sourceDirectiveId, sourceDirectiveId) : undefined, notInArray(leaderTimeRequests.status, ['rejected', 'withdrawn', 'cancelled']))
  const rows = await tx.select().from(leaderTimeRequests).where(condition).orderBy(asc(leaderTimeRequests.leaderId), asc(leaderTimeRequests.id))
  for (const row of rows) {
    await tx.execute(sql`SELECT ${users.id} FROM ${users} WHERE ${users.id}=${row.leaderId} FOR UPDATE`)
    await tx.update(leaderTimeRequests).set({ status: row.status === 'confirmed' ? 'cancelled' : 'withdrawn', closureReason: reason, confirmedAt: null, confirmedBy: null, scheduleNote: null, version: row.version + 1 }).where(eq(leaderTimeRequests.id, row.id))
    await recordTimeEvent(tx, row.id, actorId, sourceDirectiveId ? 'directive-withdraw' : 'project-close', reason)
  }
}
