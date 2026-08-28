import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, projectDutyAssignments, projectFiles, projectFileGrants, projectFileVersions, projectMembers, projects, roles, userRoles, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { addFile, classifyProject, createProject, setFileStoragePath } from '../services/projectService.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { actOnFdeFile, setFdeFilePermissions } from '../services/fdeFileService.js'
import { saveProjectFileRevision } from '../services/projectFileStorageService.js'
import { exportProjectArchives, getArchiveFile, listArchiveAudit, listProjectArchives } from '../services/fdeArchiveService.js'
import { ARCHIVE_EXPORT_LIMIT } from '../contracts/fdeArchiveContract.js'
import { getDataKnowledgeCapabilities } from '../services/fdeDataKnowledgeAccessService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
const checks: string[] = [], marker = randomUUID().slice(0, 8)
const denied = async (op: Promise<unknown>, code: string) => { const error = await op.then(() => null, value => value); assert.equal(error?.code, code, error?.message ?? 'unexpected success') }
let server: Server | undefined
try {
  process.env.AUTH_COOKIE_SECURE = 'false'; process.env.AUTH_COOKIE_DOMAIN = ''; process.env.AUTH_ALLOW_LEGACY_BEARER = 'false'; process.env.JWT_SECRET = randomUUID() + randomUUID()
  const { hashNewPassword } = await import('../security/passwordPolicy.js')
  const password = `Archive-Fixture-${randomUUID()}!`, passwordHash = await hashNewPassword(password)
  const people = ['投资经理', '投资经理', '投资经理', '董事长', '系统管理员', '时间协调人', '财务'].map((role, i) => ({ id: randomUUID(), name: `档案-${marker}-${i === 2 ? 0 : i}`, email: `archive-${marker}-${i}@example.invalid`, role, department: `档案验收-${marker}`, passwordHash }))
  const [owner, member, outsider, leader, admin, coordinator, finance] = people
  await db.insert(users).values(people)
  for (const user of people) await identityRepositories.users.synchronizeAdministrationBindings(user.id, user.role, user.department)
  async function projectFor(actor: typeof owner, members = true) {
    let project = await createProject({ name: `同名档案项目-${marker}`, owner: actor.name, ownerUserId: actor.id, collaborators: [] }, actor.id)
    project = await classifyProject({ projectId: project.id, userId: actor.id, expectedVersion: project.version, toClassification: 'normal', reason: '隔离档案初筛完成' })
    if (members) await proposeFdeGovernance({ projectId: project.id, userId: actor.id, ownerUserId: actor.id, expectedVersion: project.governanceVersion, reason: '档案授权角色验收', assignments: [{ duty: 'member', userId: member.id }, { duty: 'concerned_leader', userId: leader.id }, { duty: 'coordinator', userId: coordinator.id }, { duty: 'finance', userId: finance.id }] })
    return project
  }
  const p1 = await projectFor(owner), p2 = await projectFor(owner), hidden = await projectFor(outsider, false)
  const baseline = await db.select().from(projects).where(inArray(projects.id, [p1.id, p2.id, hidden.id]))
  const bytes = Buffer.from(`真实档案原件-${marker}`), sha256 = createHash('sha256').update(bytes).digest('hex')
  const files: Array<{ id: string; name: string }> = []
  const fileContents: Buffer[] = []
  for (let i = 0; i < 12; i++) {
    const fileBytes = Buffer.concat([bytes, Buffer.from(`\n合成样本 ${i}`)])
    fileContents.push(fileBytes)
    const name = i === 1 ? '=SUM(1),"引号"\n第二行.txt' : `档案样本-${String(i).padStart(2, '0')}.txt`
    const file = await addFile({ projectId: p1.id, name, type: 'TXT', category: i % 2 ? '财务尽调' : '项目基础资料', uploader: owner.name, byteSize: fileBytes.length, sha256: createHash('sha256').update(fileBytes).digest('hex') }, owner.id)
    await setFileStoragePath(file.id, await saveProjectFileRevision(p1.id, file.id, fileBytes), owner.id)
    await setFdeFilePermissions(file.id, owner.id, { clientRequestId: randomUUID(), expectedVersion: 1, reason: '隔离档案区分查看下载', grants: [{ userId: owner.id, canView: true, canDownload: true }, { userId: leader.id, canView: true, canDownload: true }, { userId: finance.id, canView: true, canDownload: true }, ...(i % 3 === 2 ? [] : [{ userId: member.id, canView: true, canDownload: i % 3 === 1 }])] })
    files.push(file)
  }
  await db.update(projectFiles).set({ uploadedAt: new Date('2026-01-01T00:00:00Z') }).where(eq(projectFiles.projectId, p1.id))
  const second = await addFile({ projectId: p2.id, name: '旧分类样本.pdf', type: 'PDF', category: '历史尽调资料', uploader: owner.name }, owner.id)
  await addFile({ projectId: hidden.id, name: '不可泄露标题', type: 'SECRET', category: '不可泄露分类', uploader: outsider.name }, outsider.id)
  const first = await listProjectArchives(member.id, { projectId: p1.id }), page2 = await listProjectArchives(member.id, { projectId: p1.id, page: 2 })
  assert.equal(first.total, 8); assert.equal(first.list.length, 6); assert.equal(page2.list.length, 2)
  assert.equal(new Set([...first.list, ...page2.list].map(row => row.id)).size, 8)
  assert.equal((await listProjectArchives(member.id, { projectId: p1.id, page: 1000 })).page, 2)
  const all = await listProjectArchives(member.id)
  assert.equal(all.total, 9); assert.deepEqual(new Set(all.projects.map(row => row.id)), new Set([p1.id, p2.id])); assert.equal(all.types.includes('SECRET'), false)
  assert.equal(all.categories.some(row => row.name === '不可泄露分类'), false); assert.ok(all.categories.some(row => row.name === '历史尽调资料'))
  assert.equal((await listProjectArchives(member.id, { projectId: p2.id })).list[0].id, second.id)
  assert.equal((await listProjectArchives(member.id, { keyword: owner.name, projectId: p1.id, category: '财务尽调', type: 'TXT' })).total, 4)
  assert.equal((await listProjectArchives(member.id, { keyword: '%' })).total, 0)
  assert.equal(JSON.stringify(all).includes('storagePath'), false); assert.equal(JSON.stringify(all).includes('contentText'), false)
  checks.push('FDE-FILE-001/AUTH/CONC:SQL-scoped-facets-stable-IDs-two-pages-tied-order-clamped-page-literal-search-no-private-metadata')
  const legacyProjects = await db.select({ id: projects.id }).from(projects).where(ne(projects.workflowModel, 'fde-v1'))
  if (legacyProjects.length) assert.equal((await listProjectArchives(admin.id, { projectId: p1.id })).total, 0)
  else await denied(listProjectArchives(admin.id), 'ARCHIVE_ACCESS_FORBIDDEN')
  await denied(listProjectArchives(coordinator.id), 'ARCHIVE_ACCESS_FORBIDDEN')
  assert.equal((await listProjectArchives(outsider.id, { projectId: p1.id })).total, 0)
  assert.equal((await listProjectArchives(finance.id, { projectId: p1.id, category: '财务尽调' })).total, 6)
  const viewOnly = await getArchiveFile(files[0].id, member.id)
  assert.equal(viewOnly.file.canDownload, false); assert.equal(viewOnly.file.canAudit, false); assert.equal(viewOnly.versions.length, 1)
  await denied(getArchiveFile(files[0].id, outsider.id), 'PROJECT_FILE_FORBIDDEN')
  await denied(listArchiveAudit(member.id, { fileId: files[0].id }), 'ARCHIVE_AUDIT_FORBIDDEN')
  assert.equal((await listArchiveAudit(member.id)).total, 0)
  checks.push('FDE-AUTH-003/004/005:admin-coordinator-no-business-access-same-name-outsider-denied-view-not-download-audit-independent')
  const manifest = await exportProjectArchives(member.id, { projectId: p1.id, type: 'TXT', category: '财务尽调', keyword: '档案样本', page: 2 })
  assert.equal(manifest.count, 1); assert.ok(manifest.csv.includes(files[7].id)); assert.equal(manifest.csv.includes(files[1].id), false)
  const whole = await exportProjectArchives(member.id, { projectId: p1.id })
  assert.equal(whole.count, 4); assert.ok(whole.csv.includes('"\'=SUM(1),""引号""\n第二行.txt"')); assert.equal(whole.csv.includes(files[0].id), false)
  assert.equal((await exportProjectArchives(member.id, { projectId: p1.id, keyword: '没有这个文件' })).count, 0)
  const permissions = await listArchiveAudit(owner.id, { projectId: p1.id, kind: 'permissions' })
  assert.equal(permissions.total, 12); assert.ok(permissions.list.every(row => row.action === 'permissions'))
  checks.push('FDE-FILE-003/AUDIT/DATA:CSV-all-filter-conditions-not-page-download-intersection-safe-formulas-empty-result-real-permission-events')

  const { authRouter } = await import('../routes/auth.js'), { projectArchivesRouter } = await import('../routes/projectArchives.js'), { projectsRouter } = await import('../routes/projects.js'), { requireAuth } = await import('../middleware/requireAuth.js'), { errorHandler } = await import('../middleware/errorHandler.js')
  const { dataKnowledgeRouter } = await import('../routes/dataKnowledge.js')
  const app = express(); app.use(express.json()); app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next)); app.use('/api/auth', authRouter); app.use('/api/data-knowledge', dataKnowledgeRouter); app.use('/api/project-archives', projectArchivesRouter); app.use('/api/projects', projectsRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.AUTH_ALLOWED_ORIGINS = base
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: member.email, password }) }); assert.equal(login.status, 200)
  const cookies = login.headers.getSetCookie(), cookie = cookies.map(value => value.split(';')[0]).join('; '), csrf = decodeURIComponent(cookies.find(value => value.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length))
  const request = (url: string, body?: unknown, extra: Record<string, string> = {}) => fetch(base + '/api' + url, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  assert.equal((await fetch(`${base}/api/project-archives`)).status, 401)
  assert.equal((await fetch(`${base}/api/data-knowledge/capabilities`)).status, 401)
  const capabilitiesResponse = await request('/data-knowledge/capabilities?userId=' + admin.id)
  assert.equal(capabilitiesResponse.status, 200); assert.equal(capabilitiesResponse.headers.get('cache-control'), 'private, no-store')
  const memberCapabilities = await capabilitiesResponse.json() as { company: boolean; archives: boolean; uploadProjectIds: string[] }
  assert.equal(memberCapabilities.company, true); assert.equal(memberCapabilities.archives, true)
  assert.deepEqual(new Set(memberCapabilities.uploadProjectIds), new Set([p1.id, p2.id]))
  const listResponse = await request('/project-archives'); assert.equal(listResponse.status, 200); assert.equal(listResponse.headers.get('cache-control'), 'private, no-store')
  assert.equal((await request('/project-archives?pageSize=999')).status, 400)
  assert.equal((await request('/project-archives/export', {}, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await request('/project-archives/export', {}, { Origin: 'https://forbidden.invalid' })).status, 403)
  const exported = await request('/project-archives/export', { projectId: p1.id }); assert.equal(exported.status, 200); assert.equal(exported.headers.get('x-archive-file-count'), '4'); assert.ok(exported.headers.get('content-type')?.includes('text/csv'))
  assert.equal(await exported.text(), whole.csv.slice(1)) // Fetch decodes/removes the BOM.
  const preview = await request(`/projects/files/${files[0].id}/preview`); assert.equal(preview.status, 200); assert.deepEqual(Buffer.from(await preview.arrayBuffer()), fileContents[0])
  assert.equal((await request(`/projects/files/${files[0].id}/download`)).status, 403)
  for (const suffix of ['download', 'versions/1/download']) { const result = await request(`/projects/files/${files[1].id}/${suffix}`); assert.equal(result.status, 200); assert.equal(createHash('sha256').update(Buffer.from(await result.arrayBuffer())).digest('hex'), createHash('sha256').update(fileContents[1]).digest('hex')) }
  const access = await listArchiveAudit(owner.id, { projectId: p1.id, kind: 'access' })
  assert.equal(access.total, 3); assert.ok(access.list.some(row => row.action === '下载项目资料历史版本'))
  await db.insert(auditLogs).values({ userId: owner.id, userName: owner.name, module: '项目资料', action: '下载项目资料', target: `${p1.name} / ${files[0].name}` })
  assert.equal((await listArchiveAudit(owner.id, { projectId: p1.id })).total, 3)
  checks.push('FDE-AUTH-007/FILE-002/003/AUDIT:real-session-CSRF-Origin-private-cache-current-historical-bytes-and-stable-target-only-access-audit')

  await db.delete(projectFileGrants).where(and(eq(projectFileGrants.fileId, files[1].id), eq(projectFileGrants.userId, member.id)))
  assert.equal((await request(`/project-archives/${files[1].id}`)).status, 403); assert.equal((await request(`/projects/files/${files[1].id}/versions/1/download`)).status, 403)
  assert.equal((await exportProjectArchives(member.id, { projectId: p1.id })).count, 3)
  await actOnFdeFile(files[0].id, owner.id, { clientRequestId: randomUUID(), expectedVersion: 2, action: 'trash', reason: '隔离回收档案样本', })
  await denied(getArchiveFile(files[0].id, member.id), 'PROJECT_FILE_NOT_FOUND')
  await actOnFdeFile(files[0].id, owner.id, { clientRequestId: randomUUID(), expectedVersion: 3, action: 'restore', reason: '恢复原ID和原件权限' })
  assert.equal((await getArchiveFile(files[0].id, member.id)).file.id, files[0].id)
  await db.delete(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, p1.id), eq(projectDutyAssignments.userId, member.id)))
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, p1.id), eq(projectMembers.userId, member.id)))
  assert.equal((await listProjectArchives(member.id, { projectId: p1.id })).total, 0)
  await db.update(users).set({ status: '禁用' }).where(eq(users.id, member.id))
  assert.ok([401, 403].includes((await request('/project-archives')).status))
  await denied(exportProjectArchives(member.id, {}), 'ARCHIVE_ACTOR_FORBIDDEN')
  checks.push('FDE-FILE-005/006/LIFE/AUTH:live-revocation-download-list-membership-disabled-session-trash-restore-stable-identity')

  // Export is bounded and audit is atomic with generation. The over-limit fixture
  // is explicitly synthetic metadata, not a claim of stored original bytes.
  const bulk = Array.from({ length: ARCHIVE_EXPORT_LIMIT + 1 }, (_, i) => ({ id: randomUUID(), projectId: p1.id, name: `限量测试-${i}`, type: 'TXT', category: '限量测试', uploader: owner.name, uploadedBy: owner.id, accessMode: 'project' }))
  await db.insert(projectFiles).values(bulk)
  const beforeAudit = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.userId, owner.id), eq(auditLogs.module, '项目档案')))
  await denied(exportProjectArchives(owner.id, { category: '限量测试' }), 'ARCHIVE_EXPORT_TOO_LARGE')
  assert.deepEqual(await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.userId, owner.id), eq(auditLogs.module, '项目档案'))), beforeAudit)
  await db.delete(projectFiles).where(inArray(projectFiles.id, bulk.map(row => row.id)))
  assert.deepEqual(await db.select().from(projects).where(inArray(projects.id, [p1.id, p2.id, hidden.id])), baseline)
  checks.push('FDE-REC/DATA/SCOPE:bounded-export-no-silent-truncation-or-success-audit-no-project-transition')

  // These identities deliberately have no inherited organization-wide permission.
  const secondaryRole = randomUUID(), emptyId = randomUUID()
  await db.insert(roles).values({ id: secondaryRole, code: `archive-${marker}`, name: `档案兼任-${marker}`, fdeCategory: 'member', dataScope: 'self' })
  await db.insert(users).values({ id: emptyId, email: `empty-${marker}@example.invalid`, name: '暂无档案业务人员', role: '投资经理', department: owner.department, passwordHash })
  await db.insert(userRoles).values([{ userId: emptyId, roleId: secondaryRole }, { userId: coordinator.id, roleId: secondaryRole, isPrimary: false }])
  const empty = await getDataKnowledgeCapabilities(emptyId), mixed = await getDataKnowledgeCapabilities(coordinator.id)
  assert.equal(empty.archives, true); assert.equal(empty.company, true); assert.equal(empty.upload, false); assert.deepEqual(empty.uploadProjectIds, [])
  assert.equal((await listProjectArchives(emptyId)).total, 0)
  assert.equal(mixed.archives, true); assert.equal(mixed.upload, false); assert.equal((await listProjectArchives(coordinator.id)).total, 0)
  await db.update(roles).set({ status: '停用' }).where(eq(roles.id, secondaryRole))
  assert.equal((await getDataKnowledgeCapabilities(coordinator.id)).archives, false)
  await denied(listProjectArchives(coordinator.id), 'ARCHIVE_ACCESS_FORBIDDEN')
  await denied(getArchiveFile(files[0].id, coordinator.id), 'ARCHIVE_ACCESS_FORBIDDEN')
  await denied(listArchiveAudit(coordinator.id), 'ARCHIVE_ACCESS_FORBIDDEN')
  await denied(exportProjectArchives(coordinator.id, {}), 'ARCHIVE_ACCESS_FORBIDDEN')
  checks.push('FDE-AUTH/UI:real-capability-route-actor-bound-private-cache-mixed-enabled-roles-empty-business-workspace-disabled-role-all-archive-routes-denied')

  await db.insert(projectDutyAssignments).values({ projectId: p1.id, userId: coordinator.id, duty: 'secretary', assignedBy: owner.id })
  const duty = await getDataKnowledgeCapabilities(coordinator.id)
  assert.equal(duty.archives, true); assert.equal(duty.upload, true); assert.deepEqual(duty.uploadProjectIds, [p1.id])
  assert.equal((await listProjectArchives(coordinator.id, { projectId: p1.id })).total, 0, 'workspace eligibility must not create file grants')
  await db.delete(projectDutyAssignments).where(and(eq(projectDutyAssignments.userId, coordinator.id), eq(projectDutyAssignments.duty, 'secretary')))
  assert.equal((await getDataKnowledgeCapabilities(coordinator.id)).archives, false)
  const legacyId = randomUUID()
  await db.insert(projects).values({ id: legacyId, name: '原系统有权空项目', owner: owner.name, ownerUserId: owner.id, workflowModel: 'legacy', createdBy: owner.id })
  const adminCapability = await getDataKnowledgeCapabilities(admin.id)
  assert.equal(adminCapability.company, false); assert.equal(adminCapability.archives, true); assert.ok(adminCapability.uploadProjectIds.includes(legacyId))
  assert.equal(adminCapability.uploadProjectIds.includes(p1.id), false, 'legacy administrator exception cannot grant FDE uploads')
  assert.equal((await listProjectArchives(admin.id, { projectId: p1.id })).total, 0)
  await db.update(users).set({ status: '禁用' }).where(eq(users.id, emptyId))
  await denied(getDataKnowledgeCapabilities(emptyId), 'DATA_KNOWLEDGE_ACTOR_FORBIDDEN')
  checks.push('FDE-AUTH/SCOPE:UI-eligibility-reuses-project-duty-without-file-grants-revocation-legacy-admin-resource-compatibility-no-FDE-expansion-disabled-actor')
  console.log(JSON.stringify({ ok: true, checks, projectIds: [p1.id, p2.id], fileIds: files.map(row => row.id) }))
} finally { if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); await pool.end() }
