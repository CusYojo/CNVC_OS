import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { departments, oaApprovalRequests as requests, oaApprovalNodes as nodes, oaApprovalRecords as records, oaOfficeAttachments as files, oaOfficeAttachmentGrants as grants, oaOfficePolicyVersions as policyVersions, projects, roles, userDepartments, userRoles, users } from '../db/schema.js'
import { projectAccessCondition } from './projectAccessService.js'
import type { OfficeNodeRule } from '../contracts/fdeOfficeContract.js'

export type OfficeTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type OfficeReader = Pick<typeof db, 'select'>
export const officeFail = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }) }
export async function officeActor(reader: OfficeReader, userId: string) {
  const [actor] = await reader.select().from(users).where(and(eq(users.id, userId), eq(users.status, '启用')))
  if (!actor) return officeFail('OFFICE_ACTOR_UNAVAILABLE', '当前账号不可用', 403)
  const bindings = await reader.select({ id: roles.id, category: roles.fdeCategory }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(eq(userRoles.userId, userId), eq(roles.status, '启用')))
  if (!bindings.some(role => role.category && role.category !== 'system_admin')) return officeFail('OFFICE_BUSINESS_ROLE_REQUIRED', '当前账号没有已启用的业务岗位', 403)
  const units = await reader.select({ id: departments.id }).from(userDepartments).innerJoin(departments, eq(departments.id, userDepartments.departmentId)).where(and(eq(userDepartments.userId, userId), eq(departments.status, '启用')))
  return { actor, roleIds: bindings.map(r => r.id), businessRoleIds: bindings.filter(r => r.category && r.category !== 'system_admin').map(r => r.id), departmentIds: units.map(d => d.id) }
}
export async function officeProject(reader: OfficeReader, userId: string, projectId: string | null, writing = false) {
  if (!projectId) return null
  const { actor } = await officeActor(reader, userId)
  const [project] = await reader.select().from(projects).where(and(eq(projects.id, projectId), projectAccessCondition({ uid: userId, name: actor.name, role: actor.role })))
  if (!project) return officeFail('OFFICE_PROJECT_FORBIDDEN', '关联项目不存在或当前无权访问', 403)
  if (writing && project.lifecycle !== 'active') return officeFail('OFFICE_PROJECT_INACTIVE', '关闭或归档项目不能新增办公申请')
  return project
}
export async function officeRoleEligible(reader: OfficeReader, userId: string, rule: OfficeNodeRule, departmentIds: string[]) {
  try {
    const actor = await officeActor(reader, userId)
    return actor.roleIds.some(id => rule.roleIds.includes(id)) && (rule.scope === 'institution' || actor.departmentIds.some(id => departmentIds.includes(id)))
  } catch (error) { if ((error as { code?: string }).code?.startsWith('OFFICE_')) return false; throw error }
}
export function officeBusinessRoleCondition(userId: string) {
  return sql<boolean>`EXISTS (SELECT 1 FROM ${userRoles} business_binding JOIN ${roles} business_role ON business_role.id=business_binding.role_id
    WHERE business_binding.user_id=${userId} AND business_role.status='启用'
      AND business_role.fde_category IS NOT NULL AND business_role.fde_category<>'system_admin')`
}
export function officeCurrentNodeCondition(userId: string) {
  return sql<boolean>`EXISTS (SELECT 1 FROM ${nodes} current_office
    JOIN ${userRoles} current_binding ON current_binding.user_id=${userId}
    JOIN ${roles} current_role ON current_role.id=current_binding.role_id
    WHERE current_office.id=${requests.currentNodeId} AND current_office.request_id=${requests.id}
      AND current_office.office_revision=${requests.officeRevision} AND current_role.status='启用'
      AND current_role.fde_category IS NOT NULL AND current_role.fde_category<>'system_admin'
      AND JSON_CONTAINS(current_office.office_rule,JSON_QUOTE(current_role.id),'$.roleIds')
      AND (JSON_UNQUOTE(JSON_EXTRACT(current_office.office_rule,'$.scope'))='institution'
        OR EXISTS (SELECT 1 FROM ${userDepartments} current_unit JOIN ${departments} current_department ON current_department.id=current_unit.department_id
          WHERE current_unit.user_id=${userId} AND current_department.status='启用'
            AND JSON_CONTAINS(${requests.businessPayload},JSON_QUOTE(current_department.id),'$.departmentIds'))))`
}
export function officeAccessCondition(userId: string) {
  // Current enabled stable bindings are checked even for frozen historical nodes.
  // A system administrator cannot inherit business content through configuration access.
  const roleMember = sql<boolean>`EXISTS (SELECT 1 FROM ${nodes} onode JOIN ${userRoles} our ON our.user_id=${userId}
    JOIN ${roles} orole ON orole.id=our.role_id AND orole.status='启用' AND orole.fde_category IS NOT NULL AND orole.fde_category<>'system_admin'
    WHERE onode.request_id=${requests.id} AND JSON_CONTAINS(onode.office_rule,JSON_QUOTE(orole.id),'$.roleIds')
    AND (JSON_UNQUOTE(JSON_EXTRACT(onode.office_rule,'$.scope'))='institution' OR EXISTS (SELECT 1 FROM ${userDepartments} oud JOIN ${departments} od ON od.id=oud.department_id AND od.status='启用' WHERE oud.user_id=${userId} AND JSON_CONTAINS(${requests.businessPayload},JSON_QUOTE(od.id),'$.departmentIds')))
    AND ((onode.office_revision=${requests.officeRevision} AND JSON_CONTAINS(onode.approver_user_ids,JSON_QUOTE(${userId})))
      OR EXISTS (SELECT 1 FROM ${records} orecord WHERE orecord.node_id=onode.id AND orecord.operator_user_id=${userId} AND orecord.action IN ('同意','退回','拒绝'))))`
  const allFilesVisible = sql<boolean>`COALESCE(JSON_LENGTH(JSON_EXTRACT(${requests.businessPayload},'$.definition.attachmentIds')),0) =
    (SELECT COUNT(*) FROM ${files} ofile WHERE ofile.request_id=${requests.id} AND ofile.purpose='application'
      AND JSON_CONTAINS(${requests.businessPayload},JSON_QUOTE(ofile.id),'$.definition.attachmentIds')
      AND (ofile.uploaded_by=${userId} OR EXISTS (SELECT 1 FROM ${grants} ogrant WHERE ogrant.attachment_id=ofile.id AND ogrant.user_id=${userId})))`
  const executionMember = sql<boolean>`EXISTS (SELECT 1 FROM ${policyVersions} execution_policy
    JOIN ${userRoles} execution_binding ON execution_binding.user_id=${userId}
    JOIN ${roles} execution_role ON execution_role.id=execution_binding.role_id
    WHERE execution_policy.id=${requests.officePolicyVersionId} AND execution_policy.status='published'
      AND ${requests.status}='已通过' AND execution_role.status='启用' AND execution_role.fde_category IS NOT NULL AND execution_role.fde_category<>'system_admin'
      AND JSON_UNQUOTE(JSON_EXTRACT(execution_policy.configuration,'$.execution.enabled'))='true'
      AND JSON_CONTAINS(execution_policy.configuration,JSON_QUOTE(${userId}),'$.execution.userIds')
      AND JSON_CONTAINS(execution_policy.configuration,JSON_QUOTE(execution_role.id),'$.execution.roleIds')
      AND (JSON_UNQUOTE(JSON_EXTRACT(execution_policy.configuration,'$.execution.scope'))='institution'
        OR EXISTS (SELECT 1 FROM ${userDepartments} execution_unit JOIN ${departments} execution_department ON execution_department.id=execution_unit.department_id
          WHERE execution_unit.user_id=${userId} AND execution_department.status='启用'
            AND JSON_CONTAINS(${requests.businessPayload},JSON_QUOTE(execution_department.id),'$.departmentIds'))))`
  return and(eq(requests.businessType, 'office'), officeBusinessRoleCondition(userId), sql`${requests.status}<>'已删除'`, sql`EXISTS (SELECT 1 FROM ${users} ou WHERE ou.id=${userId} AND ou.status='启用')`,
    sql`(${requests.applicantUserId}=${userId} OR (${requests.status}<>'草稿' AND (${roleMember} OR ${executionMember}) AND ${allFilesVisible}))`)
}
export async function officeReadable(reader: OfficeReader, requestId: string, userId: string) {
  await officeActor(reader, userId)
  const [row] = await reader.select().from(requests).where(and(eq(requests.id, requestId), officeAccessCondition(userId)))
  if (!row) return officeFail('OFFICE_FORBIDDEN', '申请不存在或无权访问', 403)
  await officeProject(reader, userId, row.projectId)
  return row
}
export async function officeFileGrant(reader: OfficeReader, file: typeof files.$inferSelect, userId: string, download = false) {
  const [grant] = await reader.select().from(grants).where(and(eq(grants.attachmentId, file.id), eq(grants.userId, userId)))
  return Boolean(file.uploadedBy === userId || (grant && (!download || grant.canDownload)))
}
export async function officeSelectedFiles(reader: OfficeReader, requestId: string, ids: string[]) {
  const rows = ids.length ? await reader.select().from(files).where(and(eq(files.requestId, requestId), inArray(files.id, ids))) : []
  if (rows.length !== ids.length || rows.some(r => r.purpose !== 'application')) return officeFail('OFFICE_ATTACHMENT_BINDING_INVALID', '附件须为本申请的真实送审原件')
  return rows
}
