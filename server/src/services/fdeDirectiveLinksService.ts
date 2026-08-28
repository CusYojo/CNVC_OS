import { createHash, randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { directiveEvents, directiveNotices, leaderTimeRequests, oaApprovalRequests, projectDirectives, projectDutyAssignments, projects, roles, todos, userRoles, users } from '../db/schema.js'
import { projectAccessCondition } from './projectAccessService.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { closeTimeRequests } from './fdeTimeEventsService.js'

type Reader = Pick<typeof db, 'select'>
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export const directiveDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// Additional resource scope, applied alongside projectAccessCondition by each consumer.
// Correlated to the outer todos row: prevents disclosure through generic task/weekly/report APIs.
export function directiveTaskAccessCondition(userId: string | SQL) {
  return directiveResourceAccessCondition(userId, sql`d.task_id=${todos.id} OR d.task_id=(SELECT da.task_id FROM ${oaApprovalRequests} da WHERE da.id=${todos.approvalRequestId})`)
}
export function directiveApprovalAccessCondition(userId: string) {
  return directiveResourceAccessCondition(userId, sql`d.task_id=${oaApprovalRequests.taskId}`)
}
function directiveResourceAccessCondition(userId: string | SQL, match: SQL) {
  return sql<boolean>`NOT EXISTS (
    SELECT 1 FROM ${projectDirectives} d JOIN ${todos} dt ON dt.id=d.task_id WHERE (${match})
      AND NOT ((d.issuer_id=${userId} OR COALESCE(dt.owner_user_id,'')=${userId}
        OR EXISTS (SELECT 1 FROM ${projects} dp WHERE dp.id=d.project_id AND dp.owner_user_id=${userId})
        OR EXISTS (SELECT 1 FROM ${projectDutyAssignments} dd
          JOIN ${userRoles} dr ON dr.user_id=dd.user_id JOIN ${roles} rr ON rr.id=dr.role_id
          WHERE dd.project_id=d.project_id AND dd.user_id=${userId} AND dd.duty='secretary'
            AND rr.status='启用' AND rr.fde_category IN ('secretary','project_lead','member')))
        AND EXISTS (SELECT 1 FROM ${projects} WHERE ${projects.id}=d.project_id
          AND ${projectAccessCondition({ uid: userId, name: '', role: '' })}))
  )`
}

export async function canReadReferencedDirectiveTasks(reader: Reader, taskIds: string[], userId: string) {
  if (!taskIds.length) return true
  const [actor] = await reader.select().from(users).where(and(eq(users.id, userId), eq(users.status, '启用')))
  if (!actor) return false
  const restricted = await reader.select({ id: projectDirectives.taskId }).from(projectDirectives).where(inArray(projectDirectives.taskId, taskIds))
  if (!restricted.length) return true
  const visible = await reader.select({ id: todos.id }).from(todos).innerJoin(projects, eq(projects.id, todos.projectId))
    .where(and(inArray(todos.id, restricted.map((item) => item.id)), projectAccessCondition({ uid: actor.id, name: actor.name, role: actor.role }), directiveTaskAccessCondition(userId)))
  return visible.length === restricted.length
}

export async function recordDirectiveEvent(tx: Tx, directiveId: string, actorId: string, action: string, reason: string, requestId: string = randomUUID(), requestHash = directiveDigest({ directiveId, actorId, action, reason, requestId })) {
  const [directive] = await tx.select().from(projectDirectives).where(eq(projectDirectives.id, directiveId))
  const [task] = await tx.select().from(todos).where(eq(todos.id, directive.taskId))
  const [project] = await tx.select().from(projects).where(eq(projects.id, directive.projectId))
  const schedules = await tx.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.sourceDirectiveId, directiveId))
  await tx.insert(directiveEvents).values({ directiveId, actorId, action, reason, requestId, requestHash, version: directive.version, snapshot: { directive, task, schedules } })
  await tx.update(directiveNotices).set({ closedAt: new Date() }).where(and(eq(directiveNotices.directiveId, directiveId), isNull(directiveNotices.closedAt)))
  const secretaries = await tx.select({ id: projectDutyAssignments.userId }).from(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, project.id), eq(projectDutyAssignments.duty, 'secretary')))
  for (const recipientId of new Set([directive.issuerId, task.ownerUserId, project.ownerUserId, ...secretaries.map((item) => item.id)].filter((id): id is string => Boolean(id)))) {
    if (recipientId === actorId || !await canReadReferencedDirectiveTasks(tx, [task.id], recipientId)) continue
    await tx.insert(directiveNotices).values({ directiveId, recipientId, kind: action, version: directive.version })
  }
  const identity = createMySqlIdentityRepositoryContext(tx), actor = await identity.users.findById(actorId)
  await identity.audits.append({ userId: actorId, userName: actor?.name ?? '未知用户', module: '领导批示', action, target: `${directive.projectId} / ${directiveId} / v${directive.version} / ${requestId}` })
}

// The caller owns project-first/task locks. Execution state remains authoritative in todos.
export async function directiveTaskChanged(tx: Tx, taskId: string, actorId: string, action: string, reason = '') {
  const [directive] = await tx.select().from(projectDirectives).where(eq(projectDirectives.taskId, taskId))
  if (!directive) return
  await tx.update(projectDirectives).set({ version: directive.version + 1 }).where(eq(projectDirectives.id, directive.id))
  await recordDirectiveEvent(tx, directive.id, actorId, action, reason)
}

export async function closeProjectDirectiveSchedules(tx: Tx, projectId: string, actorId: string, reason: string) {
  const directives = await tx.select().from(projectDirectives).where(and(eq(projectDirectives.projectId, projectId), isNull(projectDirectives.withdrawnAt)))
  await closeTimeRequests(tx, projectId, actorId, reason)
  for (const directive of directives) await directiveTaskChanged(tx, directive.taskId, actorId, 'project-close', reason)
}
