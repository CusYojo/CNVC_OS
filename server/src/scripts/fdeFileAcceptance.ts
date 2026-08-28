import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express from 'express'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { aiArtifacts, aiSummaries, aiTasks, aiTaskSources, knowledgeChunks, projectDutyAssignments, projectFileEvents, projectFiles, projectFileVersions, projectMembers, projects, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { addFile, classifyProject, createProject, deleteFile, listFiles, replaceFileContent, setFileStoragePath } from '../services/projectService.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { actOnFdeFile, getFdeFile, listFdeFiles, setFdeFilePermissions } from '../services/fdeFileService.js'
import { fileKnowledgeAccessCondition, readableAiTaskIds, requireProjectFileAccess } from '../services/projectFileAccessService.js'
import { readProjectFileBuffer, saveProjectFileRevision } from '../services/projectFileStorageService.js'
import { getSummary, listAllSummaries } from '../services/aiSummaryService.js'
import { getAiTask, getArtifactDownload, getArtifactPreview, listAiArtifacts } from '../services/aiTaskService.js'
import { ingestFile } from '../services/ragService.js'
import { projectsRouter } from '../routes/projects.js'
import { errorHandler } from '../middleware/errorHandler.js'
import type { AuthedRequest } from '../middleware/requireAuth.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
assert.ok(process.env.AI_ARTIFACT_ROOT?.includes('fde-migration-acceptance-'))
const marker = randomUUID().slice(0, 8), checks: string[] = []
const people = ['投资经理', '投资经理', '投资经理', '董事长', '系统管理员', '时间协调人', '投资经理'].map((role, i) => ({ id: randomUUID(), role, name: `文件-${marker}-${i}`, email: `files-${marker}-${i}@example.invalid`, department: `文件验收-${marker}`, passwordHash: 'not-for-login' }))
const [owner, secretary, member, leader, admin, coordinator, outsider] = people
const code = async (op: Promise<unknown>, expected: string) => { const error = await op.then(() => null, cause => cause); assert.equal(error?.code, expected, `${expected}: ${error?.message ?? 'unexpected success'}`) }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const command = (expectedVersion: number, extra: Record<string, unknown> = {}) => ({ clientRequestId: randomUUID(), expectedVersion, reason: '隔离文件权限及回收验收', ...extra })
let httpServer: Server | undefined
try {
  await db.insert(users).values(people)
  for (const person of people) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
  let project = await createProject({ name: `文件闭环-${marker}`, owner: owner.name, ownerUserId: owner.id, collaborators: [] }, owner.id)
  project = await classifyProject({ projectId: project.id, userId: owner.id, expectedVersion: project.version, toClassification: 'normal', reason: '文件隔离验收入库初筛' })
  await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '配置文件验收项目职责', assignments: [{ duty: 'secretary', userId: secretary.id }, { duty: 'member', userId: member.id }, { duty: 'concerned_leader', userId: leader.id }, { duty: 'coordinator', userId: coordinator.id }] })
  const bytes = Buffer.from(`文件独立查看下载与原字节验收-${marker}`)
  const file = await addFile({ projectId: project.id, name: `材料-${marker}.txt`, type: 'TXT', category: '项目基础资料', uploader: owner.name, byteSize: bytes.length, sha256: hash(bytes) }, owner.id)
  const storage = await saveProjectFileRevision(project.id, file.id, bytes)
  await setFileStoragePath(file.id, storage, owner.id)
  // Loopback-only HTTP integration with synthetic trusted actor context. Login,
  // sessions and CSRF are separately exercised by auth/browser acceptance.
  const app = express()
  app.use((req: AuthedRequest, res, next) => {
    const person = people.find(item => item.id === req.header('x-fixture-actor'))
    if (!person) { res.status(401).end(); return }
    req.user = { uid: person.id, name: person.name, role: person.role, email: person.email, department: person.department }
    next()
  })
  app.use('/api/projects', projectsRouter); app.use(errorHandler)
  httpServer = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => httpServer!.once('listening', resolve))
  const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/api/projects/files/${file.id}`
  const request = (suffix: string, actor = member) => fetch(`${base}/${suffix}`, { headers: { 'x-fixture-actor': actor.id } })
  const preview = await request('preview')
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes)
  assert.equal((await request('download')).status, 403)
  assert.equal((await request('versions/1/download')).status, 403)
  const original = await request('download', owner)
  assert.equal(original.status, 200); assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes)
  assert.equal((await request('preview', outsider)).status, 403)
  checks.push('FDE-FILE-001/002/005:loopback-http-preview-original-bytes-no-store-and-current-historical-download-403')
  assert.deepEqual(await readProjectFileBuffer(storage), bytes)
  const detail = await getFdeFile(file.id, owner.id)
  assert.equal(detail.file.accessMode, 'explicit'); assert.equal(detail.file.version, 1)
  assert.equal('storagePath' in detail.file, false); assert.equal('contentText' in detail.file, false)
  for (const person of [owner, secretary, member, leader]) await requireProjectFileAccess(db, file.id, person.id)
  await code(requireProjectFileAccess(db, file.id, member.id, 'download'), 'PROJECT_FILE_FORBIDDEN')
  for (const person of [owner, secretary, leader]) await requireProjectFileAccess(db, file.id, person.id, 'download')
  for (const person of [admin, coordinator, outsider]) await code(requireProjectFileAccess(db, file.id, person.id), 'PROJECT_FILE_FORBIDDEN')
  assert.equal((await listFiles(project.id, member.id)).length, 1)
  assert.equal((await listFiles(project.id, outsider.id)).length, 0)
  checks.push('FDE-FILE-001/002/005:real-bytes-explicit-view-download-current-project-scope-no-storage-path')

  const grant = command(1, { grants: [{ userId: member.id, canView: false, canDownload: true }] })
  await setFdeFilePermissions(file.id, owner.id, grant)
  await setFdeFilePermissions(file.id, owner.id, grant)
  assert.equal((await getFdeFile(file.id, owner.id)).file.accessVersion, 2)
  assert.equal((await db.select().from(projectFileEvents).where(eq(projectFileEvents.fileId, file.id))).length, 1)
  await requireProjectFileAccess(db, file.id, member.id, 'download')
  await code(requireProjectFileAccess(db, file.id, owner.id, 'download'), 'PROJECT_FILE_FORBIDDEN')
  await code(requireProjectFileAccess(db, file.id, secretary.id), 'PROJECT_FILE_FORBIDDEN')
  await code(setFdeFilePermissions(file.id, owner.id, { ...grant, reason: '同键不同内容不可覆盖' }), 'FILE_REQUEST_REUSED')
  await code(setFdeFilePermissions(file.id, owner.id, command(2, { grants: [{ userId: outsider.id, canView: true, canDownload: false }] })), 'FILE_GRANTEE_INVALID')
  await code(setFdeFilePermissions(file.id, member.id, command(2, { grants: [] })), 'PROJECT_FILE_FORBIDDEN')
  checks.push('FDE-FILE-002/004:matrix-download-implies-view-manager-not-implicit-download-replay-and-grantee-validation')

  await db.insert(knowledgeChunks).values({ scope: 'project', refId: project.id, sourceType: 'file', sourceId: file.id, sourceName: file.name, chunkIndex: 0, content: bytes.toString() })
  await db.insert(aiSummaries).values({ projectId: project.id, sources: [file.name] })
  const taskId = randomUUID()
  await db.insert(aiTasks).values({ id: taskId, userId: member.id, projectId: project.id, type: 'project_qa', templateVersion: 'isolated-file-acl', idempotencyKey: randomUUID(), status: 'succeeded', resultSummary: '文件派生结果' })
  await db.insert(aiTaskSources).values({ taskId, sourceType: 'file', sourceId: file.id, sourceName: file.name })
  await mkdir(process.env.AI_ARTIFACT_ROOT!, { recursive: true })
  const artifactId = randomUUID(), artifactPath = path.join(process.env.AI_ARTIFACT_ROOT!, `${artifactId}.md`)
  await writeFile(artifactPath, '# 文件派生内容的当前权限验收\n', { flag: 'wx', mode: 0o600 })
  await db.insert(aiArtifacts).values({ id: artifactId, taskId, userId: member.id, projectId: project.id, fileName: '隔离问答.md', format: 'md', mimeType: 'text/markdown', storagePath: artifactPath, templateVersion: 'isolated-file-acl', qualityStatus: 'passed' })
  assert.ok((await readableAiTaskIds(member.id, [taskId])).has(taskId))
  assert.ok(await getAiTask(member.id, taskId))
  assert.ok((await listAiArtifacts(member.id, project.id)).some(item => item.id === artifactId))
  assert.ok((await getArtifactPreview(member.id, artifactId))?.content.includes('文件派生内容'))
  const download = await getArtifactDownload(member.id, artifactId)
  assert.ok(download); download.stream.destroy()
  assert.ok(await getSummary(project.id, member.id))
  const visibleKnowledge = (id: string) => db.select().from(knowledgeChunks).where(and(eq(knowledgeChunks.refId, project.id), fileKnowledgeAccessCondition(id)))
  assert.equal((await visibleKnowledge(member.id)).length, 1)
  await setFdeFilePermissions(file.id, owner.id, command(2, { grants: [] }))
  assert.equal((await visibleKnowledge(member.id)).length, 0)
  assert.equal((await request('preview')).status, 403)
  assert.equal((await request('versions')).status, 403)
  assert.equal((await readableAiTaskIds(member.id, [taskId])).size, 0)
  assert.equal(await getAiTask(member.id, taskId), undefined)
  assert.equal((await listAiArtifacts(member.id, project.id)).length, 0)
  assert.equal(await getArtifactPreview(member.id, artifactId), undefined)
  assert.equal(await getArtifactDownload(member.id, artifactId), undefined)
  assert.equal(await getSummary(project.id, member.id), undefined)
  assert.ok(!(await listAllSummaries({ uid: member.id, name: member.name, role: member.role })).some(row => row.projectId === project.id))
  await code(addFile({ projectId: project.id, name: '重复内容不能泄露原文件名.txt', type: 'TXT', category: '项目基础资料', uploader: member.name, byteSize: bytes.length, sha256: hash(bytes) }, member.id).catch(error => { assert.ok(!error.message.includes(file.name)); throw error }), 'DUPLICATE_CONTENT')
  checks.push('FDE-FILE-005/KNOW-005:revoked-file-sql-retrieval-task-sources-summary-and-duplicate-name-redaction')

  await db.insert(knowledgeChunks).values({ scope: 'org', refId: project.id, sourceType: 'file', sourceId: file.id, sourceName: file.name, chunkIndex: 0, content: '公司知识引用' })
  await code(actOnFdeFile(file.id, owner.id, command(3, { action: 'trash' })), 'FILE_REFERENCED')
  assert.deepEqual(await readProjectFileBuffer(storage), bytes)
  await db.delete(knowledgeChunks).where(and(eq(knowledgeChunks.sourceId, file.id), eq(knowledgeChunks.scope, 'org')))
  await code(deleteFile(file.id, owner.id), 'FILE_LIFECYCLE_REQUIRED')
  const trash = command(3, { action: 'trash' })
  await actOnFdeFile(file.id, owner.id, trash); await actOnFdeFile(file.id, owner.id, trash)
  assert.equal((await listFdeFiles(project.id, owner.id)).total, 0)
  assert.equal((await listFdeFiles(project.id, owner.id, { view: 'deleted' })).total, 1)
  for (const operation of ['view', 'download'] as const) await code(requireProjectFileAccess(db, file.id, owner.id, operation), 'PROJECT_FILE_NOT_FOUND')
  assert.equal((await request('preview', owner)).status, 404)
  assert.equal((await request('download', owner)).status, 404)
  assert.equal((await visibleKnowledge(owner.id)).length, 0)
  assert.equal(await getSummary(project.id, owner.id), undefined)
  assert.deepEqual(await readProjectFileBuffer(storage), bytes)
  checks.push('FDE-FILE-006/007:knowledge-reference-blocks-trash-no-hard-delete-hidden-index-keeps-original-bytes')

  await db.update(projectFileVersions).set({ sha256: '0'.repeat(64) }).where(eq(projectFileVersions.fileId, file.id))
  await code(actOnFdeFile(file.id, owner.id, command(4, { action: 'restore' })), 'FILE_INTEGRITY_FAILED')
  assert.equal((await getFdeFile(file.id, owner.id)).file.lifecycle, 'deleted')
  await db.update(projectFileVersions).set({ sha256: hash(bytes) }).where(eq(projectFileVersions.fileId, file.id))
  await actOnFdeFile(file.id, owner.id, command(4, { action: 'restore' }))
  assert.equal((await getFdeFile(file.id, owner.id)).file.id, file.id)
  assert.equal((await getFdeFile(file.id, owner.id)).file.version, 1)
  assert.equal((await visibleKnowledge(owner.id)).length, 1)
  const secondBytes = Buffer.from(`新版本不同内容-${marker}`), secondStorage = await saveProjectFileRevision(project.id, file.id, secondBytes)
  await code(replaceFileContent(file.id, secondStorage, '1KB', secondBytes.length, hash(secondBytes), owner.id), 'BUSINESS_VERSION_CONFLICT')
  await replaceFileContent(file.id, secondStorage, '1KB', secondBytes.length, hash(secondBytes), owner.id, 1)
  assert.equal((await getFdeFile(file.id, owner.id)).file.version, 2)
  assert.deepEqual(await readProjectFileBuffer(storage), bytes)
  assert.deepEqual(await readProjectFileBuffer(secondStorage), secondBytes)
  assert.equal((await visibleKnowledge(owner.id)).length, 0, '替换后不能将旧索引标成新内容版本')
  assert.equal((await ingestFile(file.id, project.id, file.name, secondBytes, 'text/plain')).ok, true)
  const indexed = (await visibleKnowledge(owner.id))[0].content
  assert.equal((await ingestFile(file.id, project.id, file.name, bytes, 'text/plain')).ok, false, '旧解析任务不能回写新版本')
  assert.equal((await visibleKnowledge(owner.id))[0].content, indexed)
  assert.equal((await db.select().from(projectFiles).where(eq(projectFiles.id, file.id)))[0].parseStatus, '成功')
  checks.push('FDE-FILE-001/007:restore-validates-current-version-integrity-and-replacement-keeps-original-history')
  checks.push('FDE-FILE-001:replacement-invalidates-old-index-stale-ingestion-cannot-overwrite-new-content-or-status')

  const concurrent = await Promise.allSettled([setFdeFilePermissions(file.id, owner.id, command(5, { grants: [] })), actOnFdeFile(file.id, owner.id, command(5, { action: 'trash' }))])
  assert.equal(concurrent.filter(row => row.status === 'fulfilled').length, 1)
  assert.ok(concurrent.some(row => row.status === 'rejected' && row.reason.code === 'VERSION_CONFLICT'))
  let current = (await getFdeFile(file.id, owner.id)).file
  if (current.lifecycle === 'active') { await actOnFdeFile(file.id, owner.id, command(current.accessVersion, { action: 'trash' })); current = (await getFdeFile(file.id, owner.id)).file }
  await db.update(projectFiles).set({ retentionUntil: new Date(Date.now() - 1000), deletedAt: new Date(Date.now() - 86400000) }).where(eq(projectFiles.id, file.id))
  await code(actOnFdeFile(file.id, owner.id, command(current.accessVersion, { action: 'restore' })), 'FILE_RESTORE_UNAVAILABLE')
  checks.push('FDE-CONC-001/002:permissions-trash-serialize-one-version-expired-restore-does-not-purge')

  await db.delete(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, project.id), eq(projectDutyAssignments.userId, member.id)))
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, member.id)))
  assert.equal((await readableAiTaskIds(member.id, [taskId])).size, 0)
  await code(getFdeFile(file.id, member.id), 'PROJECT_FILE_FORBIDDEN')
  assert.deepEqual(await readProjectFileBuffer(storage), bytes)
  checks.push('FDE-AUTH-003:removed-membership-invalidates-historical-identity-with-originals-retained')
  console.log(JSON.stringify({ ok: true, suite: 'fde-file-access-lifecycle', checks: checks.length, details: checks }))
} finally {
  if (httpServer) await new Promise<void>((resolve, reject) => { httpServer!.close(error => error ? reject(error) : resolve()); httpServer!.closeIdleConnections() })
  await pool.end()
}
