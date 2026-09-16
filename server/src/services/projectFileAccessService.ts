import { and, eq, inArray, isNull, ne, not, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { aiTasks, aiTaskSources, companyKnowledge, companyKnowledgeGrants, knowledgeChunks, oaApprovalNodes, oaApprovalRequests, projectDutyAssignments, projectFileGrants, projectFiles, projects, roles, userRoles, users } from '../db/schema.js'
import { projectAccessCondition } from './projectAccessService.js'

export type FileTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type FileExecutor = FileTx | typeof db
export type FileOperation = 'view' | 'download' | 'manage' | 'delete'
export const fileError = (code: string, message: string, status = 409) => Object.assign(new Error(message), { code, status })

function enabledSystemAdmin(userId: string | SQL) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${users} system_admin_actor
    WHERE system_admin_actor.id=${userId}
      AND system_admin_actor.status='启用'
      AND EXISTS (
        SELECT 1 FROM ${userRoles} system_admin_user_role
        JOIN ${roles} system_admin_role ON system_admin_role.id=system_admin_user_role.role_id
        WHERE system_admin_user_role.user_id=system_admin_actor.id
          AND system_admin_role.status='启用'
          AND system_admin_role.fde_category='system_admin'
      )
  )`
}

// Current identity and project scope are mandatory even when a historical grant remains.
function currentProjectScope(userId: string | SQL) {
  return or(projectAccessCondition({ uid: userId, name: '', role: '' }), and(ne(projects.workflowModel, 'fde-v1'), sql`EXISTS (SELECT 1 FROM ${users} admin_actor WHERE admin_actor.id=${userId} AND admin_actor.role='系统管理员')`))!
}
function businessRole(userId: string | SQL) {
  return sql<boolean>`(${projects.ownerUserId}=${userId} OR EXISTS (SELECT 1 FROM ${projectDutyAssignments} fd WHERE fd.project_id=${projects.id} AND fd.user_id=${userId} AND fd.duty='secretary') OR EXISTS (SELECT 1 FROM ${userRoles} fu JOIN ${roles} fr ON fr.id=fu.role_id WHERE fu.user_id=${userId} AND fr.status='启用' AND fr.fde_category NOT IN ('system_admin','coordinator')))`
}
function manager(userId: string | SQL) {
  return sql<boolean>`(${projects.ownerUserId}=${userId} OR EXISTS (SELECT 1 FROM ${userRoles} mu JOIN ${roles} mr ON mr.id=mu.role_id WHERE mu.user_id=${userId} AND mr.status='启用' AND mr.fde_category='institution_leader'))`
}
function financeScope(userId: string | SQL) {
  // Pure finance duty retains the reference's financial-document boundary. A separate
  // legal/business role is an explicit additional responsibility, not a display-name guess.
  return sql<boolean>`(NOT EXISTS (SELECT 1 FROM ${projectDutyAssignments} ff WHERE ff.project_id=${projects.id} AND ff.user_id=${userId} AND ff.duty='finance')
    OR EXISTS (SELECT 1 FROM ${projectDutyAssignments} fl WHERE fl.project_id=${projects.id} AND fl.user_id=${userId} AND fl.duty='legal')
    OR EXISTS (SELECT 1 FROM ${userRoles} fb JOIN ${roles} fr ON fr.id=fb.role_id WHERE fb.user_id=${userId} AND fr.status='启用' AND fr.fde_category IN ('institution_leader','project_lead','secretary','member'))
    OR ${projectFiles.category} REGEXP '财务|合同|协议|票据|预算|项目基础资料')`
}

// Only the current stable-ID approver may read files frozen into the active
// request. Advancing the node removes this narrow grant immediately.
function currentApprovalMaterialScope(userId: string | SQL) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${oaApprovalRequests} approval_request
    JOIN ${oaApprovalNodes} approval_node ON approval_node.id=approval_request.current_node_id
      AND approval_node.request_id=approval_request.id
    JOIN JSON_TABLE(approval_request.material_snapshot,'$[*]' COLUMNS(file_id varchar(36) PATH '$.fileId')) approval_material
      ON approval_material.file_id=${projectFiles.id}
    WHERE approval_request.project_id=${projects.id}
      AND approval_request.status='审批中'
      AND approval_node.status IN ('待审批','会签中')
      AND JSON_CONTAINS(approval_node.approver_user_ids,JSON_QUOTE(${userId}))
      AND NOT JSON_CONTAINS(approval_node.approved_by_user_ids,JSON_QUOTE(${userId})))`
}

export function projectFileAccessCondition(userId: string | SQL, operation: FileOperation = 'view', includeDeleted = false) {
  const grant = sql<boolean>`EXISTS (SELECT 1 FROM ${projectFileGrants} fg WHERE fg.file_id=${projectFiles.id} AND fg.user_id=${userId} AND fg.can_view=1 ${operation === 'download' ? sql`AND fg.can_download=1` : sql``})`
  const fdeOperation = operation === 'manage' ? manager(userId) : operation === 'delete' ? or(manager(userId), eq(projectFiles.uploadedBy, userId))! : or(and(financeScope(userId), or(eq(projectFiles.accessMode, 'project'), grant)), operation === 'view' ? currentApprovalMaterialScope(userId) : undefined)!
  const projectScope = and(currentProjectScope(userId), or(ne(projects.workflowModel, 'fde-v1'), and(businessRole(userId), fdeOperation)))
  return and(
    sql`EXISTS (SELECT 1 FROM ${users} enabled_file_actor WHERE enabled_file_actor.id=${userId} AND enabled_file_actor.status='启用')`,
    includeDeleted ? undefined : eq(projectFiles.lifecycle, 'active'),
    inArray(projectFiles.projectId, db.select({ id: projects.id }).from(projects).where(or(enabledSystemAdmin(userId), projectScope))),
  )!
}

export async function requireProjectFileAccess(executor: FileExecutor, fileId: string, userId: string, operation: FileOperation = 'view', includeDeleted = false) {
  const [row] = await executor.select().from(projectFiles).where(and(eq(projectFiles.id, fileId), projectFileAccessCondition(userId, operation, includeDeleted))).limit(1)
  if (!row) {
    const [exists] = await executor.select({ id: projectFiles.id, lifecycle: projectFiles.lifecycle }).from(projectFiles).where(eq(projectFiles.id, fileId)).limit(1)
    if (!exists || !includeDeleted && exists.lifecycle !== 'active') throw fileError('PROJECT_FILE_NOT_FOUND', '文件不存在或已移入回收站', 404)
    throw fileError('PROJECT_FILE_FORBIDDEN', operation === 'download' ? '当前账号没有该文件的下载权限' : '当前账号无权执行该文件操作', 403)
  }
  return row
}

// Workspace eligibility does not depend on whether any file has been uploaded.
// Individual files still require projectFileAccessCondition, including their ACL.
export function projectFileWorkspaceCondition(userId: string, operation: 'view' | 'upload' = 'view') {
  const standardWorkspaceScope = and(currentProjectScope(userId), or(ne(projects.workflowModel, 'fde-v1'), and(businessRole(userId), operation === 'upload' ? eq(projects.lifecycle, 'active') : undefined)))!
  return and(sql`EXISTS (SELECT 1 FROM ${users} workspace_actor WHERE workspace_actor.id=${userId} AND workspace_actor.status='启用')`, or(enabledSystemAdmin(userId), standardWorkspaceScope))!
}

export async function requireProjectFileUpload(executor: FileExecutor, projectId: string, userId: string) {
  const [row] = await executor.select().from(projects).where(and(eq(projects.id, projectId), projectFileWorkspaceCondition(userId, 'upload'))).limit(1)
  if (!row) throw fileError('PROJECT_FILE_UPLOAD_FORBIDDEN', '当前账号或项目状态不允许上传文件', 403)
  return row
}

// SQL filtering precedes ranking/limits so inaccessible documents neither leak nor
// displace accessible matches. Lead-only retrieval remains unchanged.
export function fileKnowledgeAccessCondition(userId?: string) {
  const visible = db.select({ id: projectFiles.id }).from(projectFiles).where(userId ? projectFileAccessCondition(userId) : and(eq(projectFiles.lifecycle, 'active'), eq(projectFiles.accessMode, 'project')))
  return or(
    and(sql`${knowledgeChunks.sourceType} NOT IN ('file','project_file','company_knowledge')`, or(isNull(knowledgeChunks.sourceId), not(inArray(knowledgeChunks.sourceId, db.select({ id: projectFiles.id }).from(projectFiles))))),
    and(ne(knowledgeChunks.sourceType, 'company_knowledge'), inArray(knowledgeChunks.sourceId, visible)),
    and(eq(knowledgeChunks.sourceType, 'company_knowledge'), inArray(knowledgeChunks.sourceId, db.select({ id: companyKnowledge.id }).from(companyKnowledge).where(and(eq(companyKnowledge.status, 'published'), companyKnowledgeAccessCondition(userId))))),
  )!
}

// Audience membership never grants an underlying file. Apply this before counting,
// searching and ranking, including cached summaries. Admin is not business access.
export function companyKnowledgeBusinessActor(userId: string) {
  return sql<boolean>`EXISTS (SELECT 1 FROM ${users} ka WHERE ka.id=${userId} AND ka.status='启用' AND
    (EXISTS (SELECT 1 FROM ${userRoles} kur JOIN ${roles} kr ON kr.id=kur.role_id WHERE kur.user_id=ka.id AND kr.status='启用' AND kr.fde_category IS NOT NULL AND kr.fde_category<>'system_admin')
    OR (ka.role<>'系统管理员' AND NOT EXISTS (SELECT 1 FROM ${userRoles} kur WHERE kur.user_id=ka.id))))`
}
export function companyKnowledgeAccessCondition(userId?: string) {
  if (!userId) return sql<boolean>`FALSE`
  const editor = sql<boolean>`EXISTS (SELECT 1 FROM ${companyKnowledgeGrants} kg WHERE kg.entry_id=${companyKnowledge.id} AND kg.user_id=${userId} AND kg.can_edit=1)`
  const member = sql<boolean>`EXISTS (SELECT 1 FROM ${companyKnowledgeGrants} kg WHERE kg.entry_id=${companyKnowledge.id} AND kg.user_id=${userId})`
  const leader = sql<boolean>`EXISTS (SELECT 1 FROM ${userRoles} kur JOIN ${roles} kr ON kr.id=kur.role_id WHERE kur.user_id=${userId} AND kr.status='启用' AND kr.fde_category='institution_leader')`
  return and(
    sql`EXISTS (SELECT 1 FROM ${users} ka WHERE ka.id=${userId} AND ka.status='启用')`,
    or(eq(companyKnowledge.authorId, userId), editor, and(or(eq(companyKnowledge.status, 'published'), and(eq(companyKnowledge.status, 'archived'), leader)), or(member, and(eq(companyKnowledge.audience, 'company'), companyKnowledgeBusinessActor(userId))))),
    or(isNull(companyKnowledge.fileId), inArray(companyKnowledge.fileId, db.select({ id: projectFiles.id }).from(projectFiles).where(projectFileAccessCondition(userId)))),
  )!
}

export async function canReadAllProjectFiles(executor: FileExecutor, projectId: string, userId: string) {
  const [hidden] = await executor.select({ id: projectFiles.id }).from(projectFiles).where(and(eq(projectFiles.projectId, projectId), not(projectFileAccessCondition(userId)))).limit(1)
  return !hidden
}

// Legacy summaries have only names, not reliable file IDs: do not expose an
// unresolvable cached summary when some project source is no longer readable.
export function projectSummaryFileAccessCondition(userId: string) {
  return not(inArray(projects.id, db.select({ id: projectFiles.projectId }).from(projectFiles).where(not(projectFileAccessCondition(userId)))))
}

export async function readableAiTaskIds(userId: string, taskIds: string[]) {
  if (!taskIds.length) return new Set<string>()
  const visibleFiles = db.select({ id: projectFiles.id }).from(projectFiles).where(projectFileAccessCondition(userId))
  const blocked = db.select({ id: aiTaskSources.taskId }).from(aiTaskSources).where(and(
    inArray(aiTaskSources.taskId, taskIds),
    or(sql`${aiTaskSources.sourceType} IN ('file','project_file')`, inArray(aiTaskSources.sourceId, db.select({ id: projectFiles.id }).from(projectFiles))),
    or(isNull(aiTaskSources.sourceId), not(inArray(aiTaskSources.sourceId, visibleFiles))),
  ))
  const rows = await db.select({ id: aiTasks.id }).from(aiTasks).where(and(inArray(aiTasks.id, taskIds), eq(aiTasks.userId, userId), not(inArray(aiTasks.id, blocked)), inArray(aiTasks.projectId, db.select({ id: projects.id }).from(projects).where(currentProjectScope(userId))), sql`EXISTS (SELECT 1 FROM ${users} task_actor WHERE task_actor.id=${userId} AND task_actor.status='启用')`))
  return new Set(rows.map(row => row.id))
}
