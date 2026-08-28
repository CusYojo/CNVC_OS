import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projects, projectDutyAssignments, roles, userRoles, users } from '../db/schema.js'
import { projectAccessCondition } from './projectAccessService.js'

export type TimeReader = Pick<typeof db, 'select'>
export type TimeTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export const timeFail = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }) }
export async function timeActor(reader: TimeReader, userId: string) {
  const [actor] = await reader.select().from(users).where(and(eq(users.id, userId), eq(users.status, '启用')))
  if (!actor) return timeFail('TIME_ACTOR_UNAVAILABLE', '当前账号不可用', 403)
  const categories = await reader.select({ category: roles.fdeCategory }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(eq(userRoles.userId, userId), eq(roles.status, '启用')))
  return { actor, leader: categories.some((r) => r.category === 'institution_leader'), coordinator: categories.some((r) => r.category === 'coordinator'), secretary: categories.some((r) => ['secretary', 'project_lead', 'member'].includes(r.category ?? '')), canCoordinateDuty: categories.some((r) => ['secretary', 'coordinator'].includes(r.category ?? '')) }
}
export async function timeScope(reader: TimeReader, userId: string, projectId: string) {
  const identity = await timeActor(reader, userId)
  const [project] = await reader.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.workflowModel !== 'fde-v1' || project.lifecycle === 'deleted') return timeFail('TIME_PROJECT_UNAVAILABLE', '时间需求所属项目不存在或不可用', 404)
  const [visible] = await reader.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), projectAccessCondition({ uid: userId, name: identity.actor.name, role: identity.actor.role })))
  const duties = await reader.select({ duty: projectDutyAssignments.duty }).from(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, projectId), eq(projectDutyAssignments.userId, userId), inArray(projectDutyAssignments.duty, ['secretary', 'coordinator'])))
  const manager = Boolean(visible && (project.ownerUserId === userId || identity.leader || (identity.secretary && duties.some((d) => d.duty === 'secretary'))))
  const coordinator = identity.coordinator || (identity.canCoordinateDuty && duties.some((d) => d.duty === 'coordinator'))
  return { ...identity, project, full: Boolean(visible), manager, coordinator }
}
