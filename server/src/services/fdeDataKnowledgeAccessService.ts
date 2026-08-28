import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companyKnowledge, projects, roles, userRoles, users } from '../db/schema.js'
import { companyKnowledgeAccessCondition, companyKnowledgeBusinessActor, fileError, projectFileWorkspaceCondition, type FileExecutor } from './projectFileAccessService.js'
import type { DataKnowledgeCapabilities } from '../contracts/fdeDataKnowledgeContract.js'

function archiveEligibility(userId: string) {
  // All enabled role bindings count, not the primary role label. Preserve legacy
  // unmapped business identities and already-authorized legacy/project workspaces.
  return sql<boolean>`(EXISTS (SELECT 1 FROM ${userRoles} aur JOIN ${roles} ar ON ar.id=aur.role_id WHERE aur.user_id=${userId} AND ar.status='启用' AND ar.fde_category IS NOT NULL AND ar.fde_category NOT IN ('system_admin','coordinator'))
    OR EXISTS (SELECT 1 FROM ${users} legacy_actor WHERE legacy_actor.id=${userId} AND legacy_actor.role<>'系统管理员' AND NOT EXISTS (SELECT 1 FROM ${userRoles} lur WHERE lur.user_id=legacy_actor.id))
    OR EXISTS (SELECT 1 FROM ${projects} WHERE ${projectFileWorkspaceCondition(userId)}))`
}

export async function getDataKnowledgeCapabilities(userId: string, executor: FileExecutor = db): Promise<DataKnowledgeCapabilities> {
  const [row] = await executor.select({
    company: sql<boolean>`(${companyKnowledgeBusinessActor(userId)} OR EXISTS (SELECT 1 FROM ${companyKnowledge} WHERE ${companyKnowledgeAccessCondition(userId)}))`.mapWith(Boolean),
    archives: sql<boolean>`${archiveEligibility(userId)}`.mapWith(Boolean),
    upload: sql<boolean>`EXISTS (SELECT 1 FROM ${projects} WHERE ${projectFileWorkspaceCondition(userId, 'upload')})`.mapWith(Boolean),
  }).from(users).where(and(eq(users.id, userId), eq(users.status, '启用'))).limit(1)
  if (!row) throw fileError('DATA_KNOWLEDGE_ACTOR_FORBIDDEN', '账号不可用，请重新登录', 403)
  const uploadProjects = row.upload ? await executor.select({ id: projects.id }).from(projects).where(projectFileWorkspaceCondition(userId, 'upload')) : []
  return { ...row, input: row.upload, meetings: row.archives, uploadProjectIds: uploadProjects.map(project => project.id) }
}

export async function requireProjectArchiveAccess(executor: FileExecutor, userId: string) {
  const [row] = await executor.select({ allowed: sql<boolean>`${archiveEligibility(userId)}`.mapWith(Boolean) }).from(users).where(and(eq(users.id, userId), eq(users.status, '启用'))).limit(1)
  if (!row) throw fileError('ARCHIVE_ACTOR_FORBIDDEN', '账号不可用', 403)
  if (!row.allowed) throw fileError('ARCHIVE_ACCESS_FORBIDDEN', '当前职责无项目档案访问资格', 403)
}
