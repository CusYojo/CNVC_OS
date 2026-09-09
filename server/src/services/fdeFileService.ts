import { createHash, randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, getTableColumns, inArray, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companyKnowledge, knowledgeChunks, oaApprovalRequests, projectDutyAssignments, projectFileEvents, projectFileGrants, projectFiles, projectFileVersions, projectMaterialSubmissions, projectMembers, projects, roles, todoFeedbackEvidence, userRoles, users } from '../db/schema.js'
import { FDE_FILE_TRASH_DAYS, fileHistoryQuery, fileLifecycleCommand, filePermissionCommand, fileWorkspaceQuery, normalizeFileGrants } from '../contracts/fdeFileContract.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { requireAccessibleProject } from './projectAccessService.js'
import { fileError, projectFileAccessCondition, requireProjectFileAccess, requireProjectFileUpload, type FileExecutor, type FileTx } from './projectFileAccessService.js'
import { readProjectFileBuffer } from './projectFileStorageService.js'
import { responsibilityEvidenceLinks } from '../db/schema.js'
import { committeeFiles, fdeTypeExecutionFiles } from '../db/schema.js'

type FileRow = typeof projectFiles.$inferSelect
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function eligiblePeople(tx: FileExecutor, projectId: string, managerId: string) {
  const [project] = await tx.select({ owner: projects.ownerUserId }).from(projects).where(eq(projects.id, projectId))
  const members = await tx.select({ id: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, projectId))
  const duties = await tx.select().from(projectDutyAssignments).where(eq(projectDutyAssignments.projectId, projectId))
  const ids = [...new Set([project?.owner, managerId, ...members.map(row => row.id), ...duties.filter(row => row.duty !== 'coordinator').map(row => row.userId)].filter(Boolean) as string[])]
  if (!ids.length) return []
  const rows = await tx.select({ id: users.id, name: users.name, role: users.role }).from(users).where(and(inArray(users.id, ids), eq(users.status, '启用'))).orderBy(asc(users.name), asc(users.id))
  const bindings = await tx.select({ userId: userRoles.userId, category: roles.fdeCategory }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(inArray(userRoles.userId, ids), eq(roles.status, '启用')))
  return rows.filter(row => row.id === project?.owner || duties.some(duty => duty.userId === row.id && duty.duty === 'secretary') || bindings.some(binding => binding.userId === row.id && binding.category && !['system_admin', 'coordinator'].includes(binding.category))).map(row => ({ ...row, owner: row.id === project?.owner, secretary: duties.some(duty => duty.userId === row.id && duty.duty === 'secretary'), leader: bindings.some(binding => binding.userId === row.id && binding.category === 'institution_leader') }))
}

export async function initializeFdeFileGrants(tx: FileTx, file: FileRow, userId: string) {
  const [project] = await tx.select().from(projects).where(eq(projects.id, file.projectId))
  if (project?.workflowModel !== 'fde-v1') return
  const people = await eligiblePeople(tx, file.projectId, userId)
  await tx.update(projectFiles).set({ accessMode: 'explicit' }).where(eq(projectFiles.id, file.id))
  if (people.length) await tx.insert(projectFileGrants).values(people.map(person => ({ fileId: file.id, userId: person.id, canView: true, canDownload: person.id === userId || person.owner || person.secretary || person.leader, grantedBy: userId })))
}

export async function fileDeletionBlockers(tx: FileExecutor, fileId: string) {
  const result: string[] = []
  const [committee] = await tx.select({ id: committeeFiles.id }).from(committeeFiles).where(eq(committeeFiles.fileId, fileId)).limit(1)
  if (committee) result.push('投决会议题、纪要或正式决议历史正在引用该原件版本')
  const [typeEvidence] = await tx.select({ id: fdeTypeExecutionFiles.id }).from(fdeTypeExecutionFiles).where(eq(fdeTypeExecutionFiles.fileId, fileId)).limit(1)
  if (typeEvidence) result.push('非投资项目阶段审批历史正在引用该文件版本')
  const [material] = await tx.select({ id: projectMaterialSubmissions.id }).from(projectMaterialSubmissions).where(and(eq(projectMaterialSubmissions.fileId, fileId), sql`${projectMaterialSubmissions.status} NOT IN ('returned','withdrawn')`)).limit(1)
  if (material) result.push('活动送审或已批复材料正在引用该文件版本')
  const [task] = await tx.select({ id: todoFeedbackEvidence.id }).from(todoFeedbackEvidence).where(eq(todoFeedbackEvidence.fileId, fileId)).limit(1)
  if (task) result.push('任务成果及验收证据正在引用该文件版本')
  const [responsibility] = await tx.select({ id: responsibilityEvidenceLinks.id }).from(responsibilityEvidenceLinks).where(eq(responsibilityEvidenceLinks.fileId, fileId)).limit(1)
  if (responsibility) result.push('责任记录及申诉复核历史正在引用该文件版本')
  const [approval] = await tx.select({ id: oaApprovalRequests.id }).from(oaApprovalRequests).where(and(sql`${oaApprovalRequests.status} NOT IN ('草稿','已撤回','已退回','已驳回','已拒绝')`, sql`JSON_CONTAINS(${oaApprovalRequests.materialSnapshot}, JSON_OBJECT('fileId',${fileId}))`)).limit(1)
  if (approval) result.push('活动审批或已通过门禁正在引用该文件')
  const [knowledge] = await tx.select({ id: knowledgeChunks.id }).from(knowledgeChunks).where(and(eq(knowledgeChunks.sourceId, fileId), eq(knowledgeChunks.scope, 'org'))).limit(1)
  if (knowledge) result.push('公司知识正在引用该文件')
  const [entry] = await tx.select({ id: companyKnowledge.id }).from(companyKnowledge).where(and(eq(companyKnowledge.fileId, fileId), sql`${companyKnowledge.status}<>'archived'`)).limit(1)
  if (entry) result.push('公司知识条目正在引用该文件版本')
  return result
}

async function capabilities(tx: FileExecutor, file: FileRow, userId: string) {
  const rows = await tx.select({
    view: sql<boolean>`${projectFileAccessCondition(userId, 'view')}`.mapWith(Boolean),
    download: sql<boolean>`${projectFileAccessCondition(userId, 'download')}`.mapWith(Boolean),
    manage: sql<boolean>`${projectFileAccessCondition(userId, 'manage', true)}`.mapWith(Boolean),
    delete: sql<boolean>`${projectFileAccessCondition(userId, 'delete', true)}`.mapWith(Boolean),
  }).from(projectFiles).where(eq(projectFiles.id, file.id))
  const [project] = await tx.select({ lifecycle: projects.lifecycle }).from(projects).where(eq(projects.id, file.projectId))
  const active = project?.lifecycle === 'active'
  return { ...rows[0], replace: active && file.lifecycle === 'active' && rows[0].delete, trash: file.lifecycle === 'active' && rows[0].delete, restore: active && file.lifecycle === 'deleted' && rows[0].delete && Boolean(file.retentionUntil && file.retentionUntil > new Date()) }
}
function metadata(file: FileRow) {
  const { storagePath, contentText: _contentText, parseError: _parseError, ...row } = file
  return { ...row, hasOriginal: Boolean(storagePath) }
}

export async function listFdeFiles(projectId: string, userId: string, raw: unknown = {}) {
  const query = fileWorkspaceQuery.parse(raw), project = await requireAccessibleProject(userId, projectId)
  if (project.workflowModel !== 'fde-v1') throw fileError('FILE_WORKSPACE_UNAVAILABLE', '该项目使用原资料工作区', 400)
  const where = and(eq(projectFiles.projectId, projectId), eq(projectFiles.lifecycle, query.view), projectFileAccessCondition(userId, query.view === 'deleted' ? 'delete' : 'view', query.view === 'deleted'), query.keyword ? sql`LOCATE(${query.keyword},${projectFiles.name})>0` : undefined)
  const [total] = await db.select({ value: count() }).from(projectFiles).where(where)
  const rows = await db.select({
    ...getTableColumns(projectFiles),
    canDelete: sql<boolean>`${projectFileAccessCondition(userId, 'delete', true)}`.mapWith(Boolean),
  }).from(projectFiles).where(where).orderBy(desc(projectFiles.uploadedAt), desc(projectFiles.id)).limit(query.pageSize).offset((query.page - 1) * query.pageSize)
  let canUpload = false
  try { await requireProjectFileUpload(db, projectId, userId); canUpload = true } catch { /* scope already checked, upload may be forbidden */ }
  return {
    list: rows.map(({ canDelete, ...file }) => ({
      ...metadata(file),
      capabilities: {
        trash: query.view === 'active' && canDelete,
        restore: query.view === 'deleted' && project.lifecycle === 'active' && canDelete && Boolean(file.retentionUntil && file.retentionUntil > new Date()),
      },
    })),
    total: total.value, ...query, canUpload,
  }
}

export async function getFdeFile(fileId: string, userId: string, raw: unknown = {}) {
  const query = fileHistoryQuery.parse(raw)
  return db.transaction(async tx => {
    const [candidate] = await tx.select().from(projectFiles).where(eq(projectFiles.id, fileId))
    if (!candidate) throw fileError('PROJECT_FILE_NOT_FOUND', '文件不存在', 404)
    const file = await requireProjectFileAccess(tx, fileId, userId, candidate.lifecycle === 'deleted' ? 'delete' : 'view', candidate.lifecycle === 'deleted')
    const actions = await capabilities(tx, file, userId)
    const [total] = await tx.select({ value: count() }).from(projectFileEvents).where(eq(projectFileEvents.fileId, fileId))
    const events = await tx.select({ id: projectFileEvents.id, action: projectFileEvents.action, version: projectFileEvents.version, actorName: users.name, reason: projectFileEvents.reason, createdAt: projectFileEvents.createdAt }).from(projectFileEvents).innerJoin(users, eq(users.id, projectFileEvents.actorId)).where(eq(projectFileEvents.fileId, fileId)).orderBy(desc(projectFileEvents.version)).limit(query.pageSize).offset((query.page - 1) * query.pageSize)
    const people = actions.manage ? await eligiblePeople(tx, file.projectId, userId) : []
    const grants = actions.manage ? await tx.select({ userId: projectFileGrants.userId, canView: projectFileGrants.canView, canDownload: projectFileGrants.canDownload }).from(projectFileGrants).where(eq(projectFileGrants.fileId, fileId)) : []
    const effectiveGrants = file.accessMode === 'project' ? people.map(person => ({ userId: person.id, canView: true, canDownload: true })) : grants
    return { file: metadata(file), capabilities: actions, blockers: actions.delete ? await fileDeletionBlockers(tx, fileId) : [], people, grants: effectiveGrants, events, historyTotal: total.value, ...query }
  })
}

async function write(fileId: string, userId: string, operation: 'manage' | 'delete', requestId: string, expected: number, payload: unknown, reason: string, apply: (tx: FileTx, file: FileRow) => Promise<void>) {
  const hash = digest({ fileId, userId, payload })
  return db.transaction(async tx => {
    const [initial] = await tx.select().from(projectFiles).where(eq(projectFiles.id, fileId))
    if (!initial) throw fileError('PROJECT_FILE_NOT_FOUND', '文件不存在', 404)
    // All file, evidence, stage and project lifecycle writers share project-first order.
    await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${initial.projectId} FOR UPDATE`)
    await tx.execute(sql`SELECT ${projectFiles.id} FROM ${projectFiles} WHERE ${projectFiles.id}=${fileId} FOR UPDATE`)
    const file = await requireProjectFileAccess(tx, fileId, userId, operation, true)
    const [project] = await tx.select().from(projects).where(eq(projects.id, file.projectId))
    if (project.workflowModel !== 'fde-v1') throw fileError('FILE_WORKSPACE_UNAVAILABLE', '旧项目继续使用原文件流程', 400)
    const [previous] = await tx.select().from(projectFileEvents).where(eq(projectFileEvents.requestId, requestId))
    if (previous) { if (previous.requestHash !== hash) throw fileError('FILE_REQUEST_REUSED', '请求编号已用于其他内容'); return { id: fileId } }
    if (file.accessVersion !== expected) throw fileError('VERSION_CONFLICT', '文件权限或状态已变化，请刷新后重新确认')
    const before = await tx.select().from(projectFileGrants).where(eq(projectFileGrants.fileId, fileId))
    await apply(tx, file)
    await tx.update(projectFiles).set({ accessVersion: file.accessVersion + 1 }).where(eq(projectFiles.id, fileId))
    const [after] = await tx.select().from(projectFiles).where(eq(projectFiles.id, fileId))
    const grants = await tx.select().from(projectFileGrants).where(eq(projectFileGrants.fileId, fileId))
    const action = operation === 'manage' ? 'permissions' : after.lifecycle === 'deleted' ? 'trash' : 'restore'
    await tx.insert(projectFileEvents).values({ fileId, actorId: userId, requestId, requestHash: hash, action, version: after.accessVersion, reason, snapshot: { previous: { lifecycle: file.lifecycle, mode: file.accessMode, grants: before }, current: { lifecycle: after.lifecycle, mode: after.accessMode, grants }, contentVersion: after.version } })
    const identity = createMySqlIdentityRepositoryContext(tx), actor = await identity.users.findById(userId)
    await identity.audits.append({ userId, userName: actor!.name, module: '文件权限与生命周期', action, target: `${file.projectId} / ${fileId} / v${after.accessVersion} / ${requestId}` })
    return { id: fileId }
  })
}

export async function setFdeFilePermissions(fileId: string, userId: string, raw: unknown) {
  const input = filePermissionCommand.parse(raw)
  return write(fileId, userId, 'manage', input.clientRequestId, input.expectedVersion, input, input.reason, async (tx, file) => {
    if (file.lifecycle !== 'active') throw fileError('FILE_READONLY', '回收站文件不可修改权限')
    const people = await eligiblePeople(tx, file.projectId, userId), allowed = new Set(people.map(person => person.id))
    const grants = normalizeFileGrants(input.grants)
    if (grants.some(grant => !allowed.has(grant.userId))) throw fileError('FILE_GRANTEE_INVALID', '只能授权当前项目内启用的业务人员', 403)
    // Match the reference: retain current operator and uploader view, not download.
    for (const id of [userId, file.uploadedBy].filter(id => id && allowed.has(id)) as string[]) {
      const existing = grants.find(grant => grant.userId === id)
      if (existing) existing.canView = true
      else grants.push({ userId: id, canView: true, canDownload: false })
    }
    await tx.delete(projectFileGrants).where(eq(projectFileGrants.fileId, fileId))
    if (grants.length) await tx.insert(projectFileGrants).values(grants.map(grant => ({ ...grant, fileId, grantedBy: userId })))
    await tx.update(projectFiles).set({ accessMode: 'explicit' }).where(eq(projectFiles.id, fileId))
  })
}

export async function actOnFdeFile(fileId: string, userId: string, raw: unknown) {
  const input = fileLifecycleCommand.parse(raw)
  return write(fileId, userId, 'delete', input.clientRequestId, input.expectedVersion, input, input.reason, async (tx, file) => {
    if (input.action === 'trash') {
      if (file.lifecycle !== 'active') throw fileError('FILE_STATE_INVALID', '文件已在回收站')
      const blockers = await fileDeletionBlockers(tx, fileId)
      if (blockers.length) throw fileError('FILE_REFERENCED', blockers.join('；'))
      const now = new Date()
      await tx.update(projectFiles).set({ lifecycle: 'deleted', deletedBy: userId, deletedAt: now, deleteReason: input.reason, retentionUntil: new Date(now.getTime() + FDE_FILE_TRASH_DAYS * 86400000) }).where(eq(projectFiles.id, fileId))
    } else {
      const [project] = await tx.select().from(projects).where(eq(projects.id, file.projectId))
      if (project.lifecycle !== 'active' || file.lifecycle !== 'deleted' || !file.retentionUntil || file.retentionUntil <= new Date()) throw fileError('FILE_RESTORE_UNAVAILABLE', '恢复要求项目处于活动状态且文件仍在保留窗口内')
      const revisions = await tx.select().from(projectFileVersions).where(eq(projectFileVersions.fileId, fileId))
      if (!revisions.length) throw fileError('FILE_CONTENT_NOT_FOUND', '历史版本缺失，不能伪造恢复')
      const current = revisions.find(revision => revision.version === file.version)
      if (!current || current.storagePath !== file.storagePath || current.sha256 !== file.sha256 || current.byteSize !== file.byteSize) throw fileError('FILE_INTEGRITY_FAILED', '当前文件与版本记录不一致，恢复未执行')
      for (const revision of revisions) {
        const bytes = await readProjectFileBuffer(revision.storagePath).catch(() => null)
        if (!bytes || bytes.length !== revision.byteSize || !revision.sha256 || createHash('sha256').update(bytes).digest('hex') !== revision.sha256) throw fileError('FILE_INTEGRITY_FAILED', '原始文件版本缺失或哈希不一致，恢复未执行')
      }
      await tx.update(projectFiles).set({ lifecycle: 'active', deletedBy: null, deletedAt: null, deleteReason: null, retentionUntil: null }).where(eq(projectFiles.id, fileId))
    }
  })
}
