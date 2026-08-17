import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projectMembers, projects } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'

export async function getAccessibleProject(userId: string, projectId: string) {
  const user = await identityRepositories.users.findById(userId)
  if (!user || user.status !== '启用') return null
  const where = user.role === '系统管理员'
    ? eq(projects.id, projectId)
    : and(eq(projects.id, projectId), projectAccessCondition({ uid: user.id, name: user.name, role: user.role }))
  const [project] = await db.select().from(projects).where(where).limit(1)
  return project ?? null
}

export async function requireAccessibleProject(userId: string, projectId: string) {
  const project = await getAccessibleProject(userId, projectId)
  if (!project) {
    throw Object.assign(new Error('项目不存在或无权访问'), { status: 403, code: 'PROJECT_FORBIDDEN' })
  }
  return project
}

export type ProjectAccessActor = {
  uid: string
  name: string
  role: string
}

export function isSystemAdmin(actor: ProjectAccessActor): boolean {
  return actor.role === '系统管理员'
}

// 供会议、待办、风险、摘要等项目从表复用同一 SQL 访问边界。
export function projectAccessCondition(actor: ProjectAccessActor) {
  if (isSystemAdmin(actor)) return sql<boolean>`TRUE`
  return or(
    eq(projects.createdBy, actor.uid),
    eq(projects.ownerUserId, actor.uid),
    inArray(
      projects.id,
      db.select({ id: projectMembers.projectId }).from(projectMembers)
        .where(eq(projectMembers.userId, actor.uid)),
    ),
  )!
}
