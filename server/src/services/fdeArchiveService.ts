import { and, asc, count, desc, eq, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { auditLogs, projectFileEvents, projectFiles, projectFileVersions, projects, roles, userRoles, users } from '../db/schema.js'
import { ARCHIVE_EXPORT_LIMIT, archiveAuditQuery, archiveCategories, archiveCsv, archiveQuery, type ArchiveQuery } from '../contracts/fdeArchiveContract.js'
import { fileError, projectFileAccessCondition, requireProjectFileAccess, type FileExecutor } from './projectFileAccessService.js'
import { requireProjectArchiveAccess } from './fdeDataKnowledgeAccessService.js'

// Audit access is separate from file reading. Preserve legacy access rules, but do
// not infer an audit role from a display name or legacy file-manage capability.
const auditScope = (userId: string) => and(projectFileAccessCondition(userId), or(eq(projects.ownerUserId, userId), sql`EXISTS (SELECT 1 FROM ${userRoles} ar JOIN ${roles} rr ON rr.id=ar.role_id WHERE ar.user_id=${userId} AND rr.status='启用' AND rr.fde_category='institution_leader')`))!
function filters(query: ArchiveQuery, omitCategory = false) {
  return and(query.projectId ? eq(projectFiles.projectId, query.projectId) : undefined,
    !omitCategory && query.category ? eq(projectFiles.category, query.category) : undefined,
    query.type ? eq(projectFiles.type, query.type) : undefined,
    query.keyword ? or(sql`LOCATE(${query.keyword},${projectFiles.name})>0`, sql`LOCATE(${query.keyword},${projects.name})>0`, sql`LOCATE(${query.keyword},COALESCE(${users.name},${projectFiles.uploader}))>0`) : undefined)
}
function fields(userId: string) {
  return { id: projectFiles.id, projectId: projectFiles.projectId, projectName: projects.name, workflowModel: projects.workflowModel,
    name: projectFiles.name, type: projectFiles.type, category: projectFiles.category, uploader: sql<string>`COALESCE(${users.name},${projectFiles.uploader})`,
    uploadedAt: projectFiles.uploadedAt, byteSize: projectFiles.byteSize, sha256: projectFiles.sha256, version: projectFiles.version,
    accessVersion: projectFiles.accessVersion, parseStatus: projectFiles.parseStatus,
    hasOriginal: sql<boolean>`(${projectFiles.storagePath} IS NOT NULL AND ${projectFiles.storagePath}<>'')`.mapWith(Boolean),
    canDownload: sql<boolean>`${projectFileAccessCondition(userId, 'download')}`.mapWith(Boolean), canAudit: sql<boolean>`${auditScope(userId)}`.mapWith(Boolean) }
}
const rowsQuery = (tx: FileExecutor, userId: string) => tx.select(fields(userId)).from(projectFiles).innerJoin(projects, eq(projects.id, projectFiles.projectId)).leftJoin(users, eq(users.id, projectFiles.uploadedBy))
const serialize = <T extends { uploadedAt: Date }>(row: T) => ({ ...row, uploadedAt: row.uploadedAt.toISOString() })
const actualPage = (page: number, size: number, total: number) => Math.min(page, Math.max(1, Math.ceil(total / size)))

export async function listProjectArchives(userId: string, raw: unknown = {}) {
  const query = archiveQuery.parse(raw), scope = projectFileAccessCondition(userId)
  return db.transaction(async tx => {
    await requireProjectArchiveAccess(tx, userId)
    const where = and(scope, filters(query))
    const [total] = await tx.select({ value: count() }).from(projectFiles).innerJoin(projects, eq(projects.id, projectFiles.projectId)).leftJoin(users, eq(users.id, projectFiles.uploadedBy)).where(where)
    const page = actualPage(query.page, query.pageSize, total.value)
    const list = await rowsQuery(tx, userId).where(where).orderBy(desc(projectFiles.uploadedAt), desc(projectFiles.id)).limit(query.pageSize).offset((page - 1) * query.pageSize)
    // Category counts honor all OTHER filters. Project/type options list only
    // currently readable files; none are built from unrestricted hydration data.
    const categories = await tx.select({ name: projectFiles.category, count: count() }).from(projectFiles).innerJoin(projects, eq(projects.id, projectFiles.projectId)).leftJoin(users, eq(users.id, projectFiles.uploadedBy)).where(and(scope, filters(query, true))).groupBy(projectFiles.category).orderBy(asc(projectFiles.category))
    const options = await tx.selectDistinct({ id: projects.id, name: projects.name }).from(projectFiles).innerJoin(projects, eq(projects.id, projectFiles.projectId)).where(scope).orderBy(asc(projects.name), asc(projects.id))
    const types = await tx.selectDistinct({ name: projectFiles.type }).from(projectFiles).where(scope).orderBy(asc(projectFiles.type))
    const [auditable] = await tx.select({ id: projectFiles.id }).from(projectFiles).innerJoin(projects, eq(projects.id, projectFiles.projectId)).leftJoin(users, eq(users.id, projectFiles.uploadedBy)).where(and(auditScope(userId), filters(query))).limit(1)
    const names = [...archiveCategories, ...categories.map(row => row.name).filter(name => !archiveCategories.includes(name as typeof archiveCategories[number]))]
    return { list: list.map(serialize), total: total.value, page, pageSize: query.pageSize, canAudit: Boolean(auditable), categories: names.map(name => ({ name, count: categories.find(row => row.name === name)?.count ?? 0 })), projects: options, types: types.map(row => row.name) }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function getArchiveFile(fileId: string, userId: string, raw: unknown = {}) {
  const query = archiveQuery.pick({ page: true, pageSize: true }).parse(raw)
  return db.transaction(async tx => {
    await requireProjectArchiveAccess(tx, userId)
    await requireProjectFileAccess(tx, fileId, userId)
    const [file] = await rowsQuery(tx, userId).where(and(eq(projectFiles.id, fileId), projectFileAccessCondition(userId)))
    if (!file) throw fileError('PROJECT_FILE_FORBIDDEN', '当前账号无权读取该文件', 403)
    const [total] = await tx.select({ value: count() }).from(projectFileVersions).where(eq(projectFileVersions.fileId, fileId))
    const page = actualPage(query.page, query.pageSize, total.value)
    const versions = await tx.select({ version: projectFileVersions.version, byteSize: projectFileVersions.byteSize, sha256: projectFileVersions.sha256, createdAt: projectFileVersions.createdAt }).from(projectFileVersions).where(eq(projectFileVersions.fileId, fileId)).orderBy(desc(projectFileVersions.version)).limit(query.pageSize).offset((page - 1) * query.pageSize)
    return { file: serialize(file), versions: versions.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })), page, pageSize: query.pageSize, total: total.value }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function exportProjectArchives(userId: string, raw: unknown) {
  const query = archiveQuery.parse(raw)
  return db.transaction(async tx => {
    await requireProjectArchiveAccess(tx, userId)
    const [actor] = await tx.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.id, userId), eq(users.status, '启用')))
    if (!actor) throw fileError('ARCHIVE_ACTOR_FORBIDDEN', '账号不可用', 403)
    const rows = await rowsQuery(tx, userId).where(and(projectFileAccessCondition(userId, 'download'), filters(query))).orderBy(desc(projectFiles.uploadedAt), desc(projectFiles.id)).limit(ARCHIVE_EXPORT_LIMIT + 1)
    if (rows.length > ARCHIVE_EXPORT_LIMIT) throw fileError('ARCHIVE_EXPORT_TOO_LARGE', `单次最多导出 ${ARCHIVE_EXPORT_LIMIT} 项，请缩小筛选范围`, 413)
    const csv = archiveCsv([['文件ID', '项目ID', '文件名', '项目', '分类', '文件类型', '上传人', '内容版本', '字节数', '原件登记状态'], ...rows.map(row => [row.id, row.projectId, row.name, row.projectName, row.category, row.type, row.uploader, row.version, row.byteSize, row.hasOriginal ? '已登记；下载时校验原件' : '未登记原件'])])
    const { page: _page, pageSize: _size, ...selection } = query
    await tx.insert(auditLogs).values({ userId, userName: actor.name, module: '项目档案', action: '生成可下载清单', target: JSON.stringify({ filters: selection, count: rows.length, originalBytesVerified: false }) })
    return { csv, count: rows.length }
  }, { isolationLevel: 'read committed' })
}

export async function listArchiveAudit(userId: string, raw: unknown = {}) {
  const query = archiveAuditQuery.parse(raw)
  return db.transaction(async tx => {
    await requireProjectArchiveAccess(tx, userId)
    if (query.fileId) {
      await requireProjectFileAccess(tx, query.fileId, userId)
      const [allowed] = await tx.select({ id: projectFiles.id }).from(projectFiles).innerJoin(projects, eq(projects.id, projectFiles.projectId)).where(and(eq(projectFiles.id, query.fileId), auditScope(userId)))
      if (!allowed) throw fileError('ARCHIVE_AUDIT_FORBIDDEN', '仅有权的项目负责人或机构领导可查阅文件审计', 403)
    }
    const where = and(auditScope(userId), filters(query), query.fileId ? eq(projectFiles.id, query.fileId) : undefined)
    if (query.kind === 'permissions') {
      const base = () => tx.select({ id: projectFileEvents.id, fileId: projectFiles.id, fileName: projectFiles.name, projectName: projects.name, actorName: sql<string>`COALESCE(actor.name,'已停用人员')`, action: projectFileEvents.action, result: sql<string>`'success'`, version: sql<string>`CAST(${projectFileEvents.version} AS CHAR)`, reason: projectFileEvents.reason, createdAt: projectFileEvents.createdAt }).from(projectFileEvents).innerJoin(projectFiles, eq(projectFiles.id, projectFileEvents.fileId)).innerJoin(projects, eq(projects.id, projectFiles.projectId)).leftJoin(users, eq(users.id, projectFiles.uploadedBy)).leftJoin(sql`${users} actor`, sql`actor.id=${projectFileEvents.actorId}`)
      const [total] = await tx.select({ value: count() }).from(projectFileEvents).innerJoin(projectFiles, eq(projectFiles.id, projectFileEvents.fileId)).innerJoin(projects, eq(projects.id, projectFiles.projectId)).leftJoin(users, eq(users.id, projectFiles.uploadedBy)).where(where)
      const page = actualPage(query.page, query.pageSize, total.value)
      const list = await base().where(where).orderBy(desc(projectFileEvents.createdAt), desc(projectFileEvents.id)).limit(query.pageSize).offset((page - 1) * query.pageSize)
      return { list, total: total.value, page, pageSize: query.pageSize, coverage: '当前有权文件的权限与状态变更；版本为权限版本，不包含原件访问日志。回收文件请到原项目回收站查阅。' }
    }
    // Only stable, structured file/project targets are linked. Never match names
    // or invent historical access records from permission changes.
    const link = sql`${auditLogs.target} LIKE CONCAT('project-file:',${projectFiles.id},';project:',${projectFiles.projectId},';version:%')`
    const accessWhere = and(where, eq(auditLogs.module, '项目资料'), sql`${auditLogs.action} IN ('预览项目资料','下载项目资料','下载项目资料历史版本')`)
    const [total] = await tx.select({ value: count() }).from(auditLogs).innerJoin(projectFiles, link).innerJoin(projects, eq(projects.id, projectFiles.projectId)).leftJoin(users, eq(users.id, projectFiles.uploadedBy)).where(accessWhere)
    const page = actualPage(query.page, query.pageSize, total.value)
    const list = await tx.select({ id: auditLogs.id, fileId: projectFiles.id, fileName: projectFiles.name, projectName: projects.name, actorName: auditLogs.userName, action: auditLogs.action, result: auditLogs.result, version: sql<string>`SUBSTRING_INDEX(SUBSTRING_INDEX(${auditLogs.target},';version:',-1),';',1)`, reason: sql<string>`''`, createdAt: auditLogs.createdAt }).from(auditLogs).innerJoin(projectFiles, link).innerJoin(projects, eq(projects.id, projectFiles.projectId)).leftJoin(users, eq(users.id, projectFiles.uploadedBy)).where(accessWhere).orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(query.pageSize).offset((page - 1) * query.pageSize)
    return { list, total: total.value, page, pageSize: query.pageSize, coverage: '仅展示带稳定文件/项目标识的原件访问记录；服务端准许访问不代表客户端完整收到文件。旧的名称型日志及未记录的拒绝访问不在此覆盖。版本为内容版本。' }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
