import { and, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { permissions, projectDutyAssignments, projectMembers, projects, rolePermissions, roles, userDepartments, userRoles, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'

export async function getAccessibleProject(userId: string, projectId: string) {
  const user = await identityRepositories.users.findById(userId)
  if (!user || user.status !== '启用') return null
  const where = and(eq(projects.id, projectId), projectAccessCondition({ uid: user.id, name: user.name, role: user.role }))
  const [project] = await db.select().from(projects).where(where).limit(1)
  return project ?? null
}

export async function requireAccessibleProject(userId: string, projectId: string) {
  const project = await getAccessibleProject(userId, projectId)
  if (!project) {
    const [existing] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1)
    if (!existing) throw Object.assign(new Error('项目不存在'), { status: 404, code: 'PROJECT_NOT_FOUND' })
    const actor = await identityRepositories.users.findById(userId)
    if (actor) await identityRepositories.audits.append({ userId, userName: actor.name, module: '项目授权', action: '拒绝访问', target: projectId })
    throw Object.assign(new Error('无权访问该项目'), { status: 403, code: 'PROJECT_FORBIDDEN' })
  }
  return project
}

export async function requireAiAssistantProject(userId: string, projectId: string) {
  const project = await requireAccessibleProject(userId, projectId)
  if (
    project.lifecycle !== 'active'
    || (project.classification !== 'normal' && project.classification !== 'key')
  ) {
    throw Object.assign(new Error('所选项目不是可用于 AI 助手的活动普通项目或重点项目'), {
      status: 403,
      code: 'AI_PROJECT_FORBIDDEN',
    })
  }
  return project
}

export type ProjectAccessActor = {
  uid: string
  name: string
  role: string
}

export function isSystemAdmin(actor: Pick<ProjectAccessActor, 'role'>): boolean {
  return actor.role === '系统管理员'
}

// 供会议、待办、风险、摘要等项目从表复用同一 SQL 访问边界。
// SQL identifiers are internal correlated actors; request identities remain strings.
export function projectAccessCondition(actor: Omit<ProjectAccessActor, 'uid'> & { uid: string | SQL }) {
  const membership = inArray(projects.id, db.select({ id: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.userId, actor.uid)))
  const legacyAccess = isSystemAdmin(actor) ? sql<boolean>`TRUE` : or(
    eq(projects.createdBy, actor.uid),
    eq(projects.ownerUserId, actor.uid),
    membership,
  )!
  const legacy = and(ne(projects.lifecycle, 'deleted'), legacyAccess)
  const organizationScope = sql<boolean>`EXISTS (
    SELECT 1 FROM ${userRoles} ur
    JOIN ${roles} rr ON rr.id=ur.role_id
    JOIN ${rolePermissions} rp ON rp.role_id=rr.id
    JOIN ${permissions} pp ON pp.id=rp.permission_id
    WHERE ur.user_id=${actor.uid} AND rr.status='启用'
      AND rr.fde_category IS NOT NULL AND rr.fde_category<>'system_admin'
      AND pp.code='fde.project.read'
      AND (rr.data_scope='all' OR (rr.data_scope='department' AND EXISTS (
        SELECT 1 FROM ${userDepartments} mine JOIN ${userDepartments} owned ON owned.department_id=mine.department_id
        WHERE mine.user_id=${actor.uid} AND owned.user_id=${projects.ownerUserId}
      )))
  )`
  const fde = and(
    ne(projects.lifecycle, 'deleted'),
    sql<boolean>`EXISTS (SELECT 1 FROM ${users} active_actor WHERE active_actor.id=${actor.uid} AND active_actor.status='启用')`,
    or(
      eq(projects.ownerUserId, actor.uid), membership, organizationScope,
      inArray(projects.id, db.select({ id: projectDutyAssignments.projectId }).from(projectDutyAssignments).where(and(eq(projectDutyAssignments.userId, actor.uid), ne(projectDutyAssignments.duty, 'coordinator')))),
    ),
  )
  return or(and(ne(projects.workflowModel, 'fde-v1'), legacy), and(eq(projects.workflowModel, 'fde-v1'), fde))!
}
