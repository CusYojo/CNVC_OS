import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projects, roles, userRoles, users } from '../db/schema.js'
import { projectAccessCondition } from './projectAccessService.js'

export async function isFdeTaskManager(tx: Pick<typeof db, 'select'>, project: typeof projects.$inferSelect, userId: string) {
  const [actor] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.status, '启用')))
  if (!actor) return false
  const [visible] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, project.id), projectAccessCondition({ uid: actor.id, name: actor.name, role: actor.role })))
  if (!visible) return false
  if (project.ownerUserId === userId) return true
  const [leader] = await tx.select({ id: roles.id }).from(userRoles).innerJoin(roles, eq(userRoles.roleId, roles.id)).where(and(eq(userRoles.userId, userId), eq(roles.status, '启用'), eq(roles.fdeCategory, 'institution_leader'))).limit(1)
  return Boolean(leader)
}
