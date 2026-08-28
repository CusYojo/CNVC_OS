import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { db, pool } from '../db/client.js'
import { companyKnowledge, companyKnowledgeComments, companyKnowledgeEvents, companyKnowledgeGrants, companyKnowledgeRatings, knowledgeChunks, projectFileVersions, projectFiles, projects, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { addFile, classifyProject, createProject, setFileStoragePath } from '../services/projectService.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { setFdeFilePermissions, actOnFdeFile, getFdeFile } from '../services/fdeFileService.js'
import { saveProjectFileRevision, readProjectFileBuffer } from '../services/projectFileStorageService.js'
import { actOnCompanyKnowledge, commentCompanyKnowledge, companyKnowledgeOriginal, companyKnowledgeSummary, getCompanyKnowledge, listCompanyKnowledge, rateCompanyKnowledge, saveCompanyKnowledge, withdrawCompanyKnowledgeComment } from '../services/fdeKnowledgeService.js'
import { retrieveKnowledge } from '../services/ragService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
const checks: string[] = [], marker = randomUUID().slice(0, 8)
const denied = async (operation: Promise<unknown>, code: string) => { const error = await operation.then(() => null, cause => cause); assert.equal(error?.code, code, error?.message ?? 'unexpected success') }
let server: Server | undefined
try {
  process.env.AUTH_COOKIE_SECURE = 'false'; process.env.AUTH_COOKIE_DOMAIN = ''; process.env.AUTH_ALLOW_LEGACY_BEARER = 'false'; process.env.JWT_SECRET = randomUUID() + randomUUID()
  const { hashNewPassword } = await import('../security/passwordPolicy.js')
  const password = `Knowledge-Fixture-${randomUUID()}!`, passwordHash = await hashNewPassword(password)
  const people = ['投资经理', '投资经理', '投资经理', '投资经理', '系统管理员', '董事长'].map((role, i) => ({ id: randomUUID(), name: `知识-${marker}-${i === 3 ? 2 : i}`, email: `knowledge-${marker}-${i}@example.invalid`, role, department: `知识验收-${marker}`, passwordHash }))
  const [author, editor, viewer, stranger, admin, leader] = people
  await db.insert(users).values(people)
  for (const user of people) await identityRepositories.users.synchronizeAdministrationBindings(user.id, user.role, user.department)
  let project = await createProject({ name: `知识项目-${marker}`, owner: author.name, ownerUserId: author.id, collaborators: [] }, author.id)
  project = await classifyProject({ projectId: project.id, userId: author.id, expectedVersion: project.version, toClassification: 'normal', reason: '知识验收初筛完成' })
  await proposeFdeGovernance({ projectId: project.id, userId: author.id, ownerUserId: author.id, expectedVersion: project.governanceVersion, reason: '配置知识原件权限夹具', assignments: [{ duty: 'member', userId: editor.id }, { duty: 'member', userId: viewer.id }, { duty: 'concerned_leader', userId: leader.id }] })
  const projectBefore = (await db.select().from(projects).where(eq(projects.id, project.id)))[0]
  const bytes = Buffer.from(`真实知识原件-${marker}`), sha256 = createHash('sha256').update(bytes).digest('hex')
  const file = await addFile({ projectId: project.id, name: `知识原件-${marker}.txt`, type: 'TXT', category: '项目资料', uploader: author.name, byteSize: bytes.length, sha256 }, author.id)
  const storagePath = await saveProjectFileRevision(project.id, file.id, bytes)
  await setFileStoragePath(file.id, storagePath, author.id)
  const permissions = [{ userId: author.id, canView: true, canDownload: true }, { userId: editor.id, canView: true, canDownload: true }, { userId: viewer.id, canView: true, canDownload: false }]
  await setFdeFilePermissions(file.id, author.id, { clientRequestId: randomUUID(), expectedVersion: 1, reason: '区分查看与原件下载权限', grants: permissions })
  const id = randomUUID(), definition = { kind: '方法论', title: `穿透核验-${marker}`, summary: `专有知识不可泄露-${marker}`, link: 'https://example.com/reference', audience: 'company', readerIds: [viewer.id], editorIds: [editor.id], fileId: file.id, fileVersion: 1 }
  const create = { clientRequestId: randomUUID(), expectedVersion: 0, definition }
  const first = await Promise.all([saveCompanyKnowledge(id, author.id, create), saveCompanyKnowledge(id, author.id, create)])
  assert.deepEqual(first[0], first[1]); assert.equal(first[0].version, 1)
  await denied(saveCompanyKnowledge(randomUUID(), admin.id, { ...create, clientRequestId: randomUUID() }), 'KNOWLEDGE_ACTOR_FORBIDDEN')
  await denied(saveCompanyKnowledge(id, author.id, { ...create, definition: { ...definition, title: '同键不同内容' } }), 'KNOWLEDGE_REQUEST_REUSED')
  await assert.rejects(saveCompanyKnowledge(randomUUID(), author.id, { ...create, clientRequestId: randomUUID(), definition: { ...definition, link: 'javascript:alert(1)' } }))
  assert.equal((await getCompanyKnowledge(id, editor.id)).entry.status, 'draft')
  await denied(getCompanyKnowledge(id, viewer.id), 'KNOWLEDGE_FORBIDDEN')
  assert.equal((await retrieveKnowledge('org', undefined, marker, 20, author.id)).some(row => row.sourceId === id), false)
  assert.equal((await db.select().from(companyKnowledgeEvents).where(eq(companyKnowledgeEvents.entryId, id))).length, 1)
  checks.push('FDE-KNOW-001/003/CONC:concurrent-create-one-entry-one-event-stable-identity-draft-private-no-fake-rating')

  await actOnCompanyKnowledge(id, author.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'publish', reason: '确认知识范围并正式发布' })
  const published = await getCompanyKnowledge(id, viewer.id)
  assert.equal(published.entry.ratings, 0); assert.equal(published.entry.rating, null)
  assert.equal(published.entry.capabilities.download, false)
  assert.deepEqual((await companyKnowledgeOriginal(id, viewer.id)).bytes, bytes)
  await denied(companyKnowledgeOriginal(id, viewer.id, true), 'PROJECT_FILE_FORBIDDEN')
  await denied(companyKnowledgeSummary(id, viewer.id), 'PROJECT_FILE_FORBIDDEN')
  for (const user of [stranger, admin]) {
    assert.equal((await listCompanyKnowledge(user.id, { keyword: marker })).total, 0)
    await denied(getCompanyKnowledge(id, user.id), 'KNOWLEDGE_FORBIDDEN')
    assert.equal((await retrieveKnowledge('org', undefined, marker, 20, user.id)).some(row => row.sourceId === id), false)
  }
  assert.equal((await retrieveKnowledge('org', undefined, marker, 20, viewer.id)).some(row => row.sourceId === id), true)
  assert.equal((await retrieveKnowledge('org', undefined, marker, 20)).some(row => row.sourceId === id), false)
  await denied(actOnFdeFile(file.id, author.id, { clientRequestId: randomUUID(), expectedVersion: 2, action: 'trash', reason: '有效知识引用必须阻断' }), 'FILE_REFERENCED')
  checks.push('FDE-KNOW-002/005/FILE:audience-intersects-file-access-preview-not-download-same-name-and-admin-denied-rag-filter-and-reference-protection')

  // Source IDs are not globally unique across entity types: a knowledge ID equal
  // to a visible file ID must not acquire that file's unrelated audience.
  await saveCompanyKnowledge(file.id, author.id, { clientRequestId: randomUUID(), expectedVersion: 0, definition: { ...definition, title: `跨类型ID碰撞-${marker}`, audience: 'selected', readerIds: [], editorIds: [], fileId: null, fileVersion: null } })
  await actOnCompanyKnowledge(file.id, author.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'publish', reason: '隔离测试跨类型同ID权限不可混用' })
  assert.equal((await retrieveKnowledge('org', file.id, marker, 5, viewer.id)).length, 0)
  await denied(getCompanyKnowledge(file.id, viewer.id), 'KNOWLEDGE_FORBIDDEN')
  await actOnCompanyKnowledge(file.id, author.id, { clientRequestId: randomUUID(), expectedVersion: 2, action: 'archive', reason: '关闭隔离的类型碰撞测试条目' })
  checks.push('FDE-KNOW-001/005:typed-source-identity-prevents-visible-file-id-from-authorizing-unrelated-knowledge')

  const getVersion = async () => (await getCompanyKnowledge(id, author.id)).entry.version
  const note = { clientRequestId: randomUUID(), expectedVersion: 2, content: `批注唯一正文-${marker}` }
  await commentCompanyKnowledge(id, viewer.id, note); await commentCompanyKnowledge(id, viewer.id, note)
  assert.equal((await getCompanyKnowledge(id, author.id)).commentTotal, 1)
  const vote = { clientRequestId: randomUUID(), expectedVersion: 3, score: 4 }
  await rateCompanyKnowledge(id, viewer.id, vote); await rateCompanyKnowledge(id, viewer.id, vote)
  await rateCompanyKnowledge(id, viewer.id, { clientRequestId: randomUUID(), expectedVersion: 4, score: 5 })
  assert.equal((await getCompanyKnowledge(id, author.id)).entry.ratings, 1)
  assert.equal((await getCompanyKnowledge(id, author.id)).entry.rating, 5)
  await rateCompanyKnowledge(id, viewer.id, { clientRequestId: randomUUID(), expectedVersion: 5, score: null })
  assert.equal((await getCompanyKnowledge(id, author.id)).entry.ratings, 0)
  const commentId = (await getCompanyKnowledge(id, author.id)).comments[0].id
  await denied(withdrawCompanyKnowledgeComment(id, commentId, author.id, { clientRequestId: randomUUID(), expectedVersion: 6, reason: '作者不能撤回他人批注' }), 'KNOWLEDGE_COMMENT_FORBIDDEN')
  await withdrawCompanyKnowledgeComment(id, commentId, viewer.id, { clientRequestId: randomUUID(), expectedVersion: 6, reason: '核验后撤回本人旧批注' })
  assert.ok(!JSON.stringify(await getCompanyKnowledge(id, author.id)).includes(note.content))
  assert.equal((await listCompanyKnowledge(author.id, { keyword: note.content })).total, 0)
  assert.equal((await db.select().from(companyKnowledgeComments).where(eq(companyKnowledgeComments.id, commentId)))[0].content, note.content)
  checks.push('FDE-KNOW-004:comment-and-rating-idempotency-single-account-update-withdraw-author-only-no-hidden-text-history-leak')

  await denied(saveCompanyKnowledge(id, editor.id, { clientRequestId: randomUUID(), expectedVersion: 7, definition: { ...definition, audience: 'selected', readerIds: [stranger.id] } }), 'KNOWLEDGE_AUDIENCE_FORBIDDEN')
  await saveCompanyKnowledge(id, editor.id, { clientRequestId: randomUUID(), expectedVersion: 7, definition: { ...definition, summary: `编辑后的版本-${marker}` } })
  assert.equal((await getCompanyKnowledge(id, author.id)).entry.version, 8)
  assert.equal((await retrieveKnowledge('org', id, '编辑后的版本', 5, viewer.id))[0].content.includes('编辑后的版本'), true)
  const race = await Promise.allSettled([commentCompanyKnowledge(id, viewer.id, { clientRequestId: randomUUID(), expectedVersion: 8, content: '并发新增批注' }), saveCompanyKnowledge(id, editor.id, { clientRequestId: randomUUID(), expectedVersion: 8, definition })])
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1)
  assert.ok(race.some(result => result.status === 'rejected' && result.reason.code === 'VERSION_CONFLICT'))
  checks.push('FDE-KNOW-003/CONC:authorized-editor-not-audience-admin-current-version-one-winner-and-atomic-rag-update')

  const beforeRow = (await db.select().from(companyKnowledge).where(eq(companyKnowledge.id, id)))[0]
  const beforeGrants = await db.select().from(companyKnowledgeGrants).where(eq(companyKnowledgeGrants.entryId, id))
  const beforeIndex = await db.select().from(knowledgeChunks).where(eq(knowledgeChunks.sourceId, id))
  const faultId = randomUUID()
  await db.insert(companyKnowledgeEvents).values({ id: faultId, entryId: id, actorId: author.id, requestId: randomUUID(), requestHash: 'x'.repeat(64), action: 'fixture-fault', version: beforeRow.version + 1, reason: '仅隔离环境注入后续唯一约束失败', snapshot: {} })
  await assert.rejects(saveCompanyKnowledge(id, author.id, { clientRequestId: randomUUID(), expectedVersion: beforeRow.version, definition: { ...definition, summary: '失败后不得保留的摘要', readerIds: [] } }))
  assert.deepEqual((await db.select().from(companyKnowledge).where(eq(companyKnowledge.id, id)))[0], beforeRow)
  assert.deepEqual(await db.select().from(companyKnowledgeGrants).where(eq(companyKnowledgeGrants.entryId, id)), beforeGrants)
  assert.deepEqual(await db.select().from(knowledgeChunks).where(eq(knowledgeChunks.sourceId, id)), beforeIndex)
  await db.delete(companyKnowledgeEvents).where(eq(companyKnowledgeEvents.id, faultId))
  checks.push('FDE-DATA/CONC:real-late-unique-constraint-failure-rolls-back-definition-grants-version-and-index')

  await setFdeFilePermissions(file.id, author.id, { clientRequestId: randomUUID(), expectedVersion: 2, reason: '撤销读者的原文件权限', grants: permissions.filter(grant => grant.userId !== viewer.id) })
  const revokedVersion = await getVersion()
  for (const operation of [() => getCompanyKnowledge(id, viewer.id), () => companyKnowledgeSummary(id, viewer.id), () => companyKnowledgeOriginal(id, viewer.id), () => rateCompanyKnowledge(id, viewer.id, { clientRequestId: randomUUID(), expectedVersion: revokedVersion, score: 4 })]) await denied(operation(), 'KNOWLEDGE_FORBIDDEN')
  assert.equal((await listCompanyKnowledge(viewer.id, { keyword: marker })).total, 0)
  assert.equal((await retrieveKnowledge('org', id, marker, 5, viewer.id)).length, 0)
  await setFdeFilePermissions(file.id, author.id, { clientRequestId: randomUUID(), expectedVersion: 3, reason: '恢复隔离夹具原文件授权', grants: permissions })
  checks.push('FDE-KNOW-005/AUTH:live-file-revocation-hides-list-detail-summary-original-rating-and-rag')

  const originalRevision = (await db.select().from(projectFileVersions).where(eq(projectFileVersions.fileId, file.id)))[0]
  const bytes2 = Buffer.from(`后续新版本-${marker}`), path2 = await saveProjectFileRevision(project.id, file.id, bytes2), sha2 = createHash('sha256').update(bytes2).digest('hex')
  await db.insert(projectFileVersions).values({ fileId: file.id, version: 2, storagePath: path2, byteSize: bytes2.length, sha256: sha2, createdBy: author.id })
  await db.update(projectFiles).set({ version: 2, storagePath: path2, byteSize: bytes2.length, sha256: sha2 }).where(eq(projectFiles.id, file.id))
  assert.deepEqual((await companyKnowledgeOriginal(id, viewer.id)).bytes, bytes)
  await db.update(projectFileVersions).set({ sha256: '0'.repeat(64) }).where(eq(projectFileVersions.id, originalRevision.id))
  await denied(companyKnowledgeOriginal(id, viewer.id), 'KNOWLEDGE_FILE_INTEGRITY')
  await db.update(projectFileVersions).set({ sha256 }).where(eq(projectFileVersions.id, originalRevision.id))
  checks.push('FDE-FILE-001/KNOW-001:knowledge-pins-original-version-replacement-does-not-retarget-and-integrity-fails-closed')

  const { authRouter } = await import('../routes/auth.js'), { companyKnowledgeRouter } = await import('../routes/companyKnowledge.js'), { requireAuth } = await import('../middleware/requireAuth.js'), { errorHandler } = await import('../middleware/errorHandler.js')
  const app = express(); app.use(express.json()); app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next)); app.use('/api/auth', authRouter); app.use('/api/company-knowledge', companyKnowledgeRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.AUTH_ALLOWED_ORIGINS = base
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: viewer.email, password }) }); assert.equal(login.status, 200)
  const cookies = login.headers.getSetCookie(), cookie = cookies.map(value => value.split(';')[0]).join('; '), csrf = decodeURIComponent(cookies.find(value => value.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length))
  assert.ok(cookies.some(value => value.startsWith('cybernaut_session=') && /HttpOnly/i.test(value)))
  const url = `${base}/api/company-knowledge/${id}`, request = (suffix: string, body?: unknown, extra: Record<string, string> = {}) => fetch(url + suffix, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  assert.equal((await fetch(url)).status, 401)
  const preview = await request('/preview'); assert.equal(preview.status, 200); assert.equal(preview.headers.get('cache-control'), 'private, no-store'); assert.equal(preview.headers.get('x-file-version'), '1'); assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes)
  assert.equal((await request('/download')).status, 403); assert.equal((await request('/summary')).status, 403)
  const rate = { clientRequestId: randomUUID(), expectedVersion: await getVersion(), score: 3 }
  assert.equal((await request('/rating', rate, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await request('/rating', rate, { Origin: 'https://invalid.example.invalid' })).status, 403)
  assert.equal((await request('/rating', rate)).status, 200); assert.equal((await request('/rating', rate)).status, 200)
  assert.equal((await db.select().from(companyKnowledgeRatings).where(and(eq(companyKnowledgeRatings.entryId, id), eq(companyKnowledgeRatings.userId, viewer.id)))).length, 1)
  await db.update(users).set({ status: '停用' }).where(eq(users.id, viewer.id)); assert.equal((await request('')).status, 401)
  await db.update(users).set({ status: '启用' }).where(eq(users.id, viewer.id))
  checks.push('FDE-AUTH/KNOW-002:real-session-csrf-origin-disabled-account-http-original-bytes-and-download-denial')

  for (let i = 0; i < 3; i++) await commentCompanyKnowledge(id, author.id, { clientRequestId: randomUUID(), expectedVersion: await getVersion(), content: `分页批注${i}` })
  const page1 = await getCompanyKnowledge(id, author.id, { pageSize: 2 }), page2 = await getCompanyKnowledge(id, author.id, { pageSize: 2, page: 2, historyPage: 2 })
  assert.equal(page1.comments.length, 2); assert.equal(page2.comments.length, 2); assert.equal(new Set([...page1.comments, ...page2.comments].map(c => c.id)).size, 4)
  assert.equal(new Set([...page1.history, ...page2.history].map(e => e.id)).size, 4)
  const archive = { clientRequestId: randomUUID(), expectedVersion: await getVersion(), action: 'archive', reason: '内容阶段结束归档保留证据' }
  await actOnCompanyKnowledge(id, author.id, archive); await actOnCompanyKnowledge(id, author.id, archive)
  assert.equal((await listCompanyKnowledge(author.id, { keyword: marker })).total, 0)
  assert.equal((await listCompanyKnowledge(author.id, { keyword: definition.title, view: 'archived' })).total, 1)
  assert.equal((await retrieveKnowledge('org', id, marker, 5, author.id)).length, 0)
  assert.deepEqual(await readProjectFileBuffer(storagePath), bytes)
  await denied(commentCompanyKnowledge(id, author.id, { clientRequestId: randomUUID(), expectedVersion: archive.expectedVersion + 1, content: '归档后禁止评论' }), 'KNOWLEDGE_READONLY')
  await actOnFdeFile(file.id, author.id, { clientRequestId: randomUUID(), expectedVersion: 4, action: 'trash', reason: '知识归档后可按文件政策回收' })
  assert.equal((await getFdeFile(file.id, author.id)).file.lifecycle, 'deleted')
  assert.deepEqual(await readProjectFileBuffer(storagePath), bytes)
  assert.deepEqual((await db.select().from(projects).where(eq(projects.id, project.id)))[0], projectBefore)
  checks.push('FDE-KNOW-004/005:bounded-history-comments-archive-removes-index-retains-original-and-project-facts-no-cascade-delete')

  const publicId = randomUUID(), publicDefinition = { ...definition, fileId: null, fileVersion: null, editorIds: [editor.id], readerIds: [], title: `独立公司知识-${marker}` }
  await saveCompanyKnowledge(publicId, author.id, { clientRequestId: randomUUID(), expectedVersion: 0, definition: publicDefinition })
  await actOnCompanyKnowledge(publicId, author.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'publish', reason: '人工确认公司可分享原创内容' })
  assert.equal((await getCompanyKnowledge(publicId, stranger.id)).entry.summary, definition.summary)
  assert.equal((await companyKnowledgeSummary(publicId, stranger.id)).text.includes(definition.summary), true)
  await denied(getCompanyKnowledge(publicId, admin.id), 'KNOWLEDGE_FORBIDDEN')
  await saveCompanyKnowledge(publicId, author.id, { clientRequestId: randomUUID(), expectedVersion: 2, definition: { ...publicDefinition, audience: 'selected', readerIds: [leader.id], editorIds: [] } })
  for (const user of [stranger, editor]) {
    await denied(getCompanyKnowledge(publicId, user.id), 'KNOWLEDGE_FORBIDDEN')
    assert.equal((await retrieveKnowledge('org', publicId, marker, 5, user.id)).length, 0)
  }
  const leaderArchive = { clientRequestId: randomUUID(), expectedVersion: 3, action: 'archive', reason: '有权领导归档且保留可核对结果' }
  await actOnCompanyKnowledge(publicId, leader.id, leaderArchive)
  await actOnCompanyKnowledge(publicId, leader.id, leaderArchive)
  assert.equal((await getCompanyKnowledge(publicId, leader.id)).entry.status, 'archived')
  assert.equal((await listCompanyKnowledge(leader.id, { view: 'archived', keyword: publicDefinition.title })).total, 1)
  assert.equal((await retrieveKnowledge('org', publicId, marker, 5, leader.id)).length, 0)
  checks.push('FDE-KNOW-002/003/005:independent-company-knowledge-summary-explicit-audience-and-editor-revocation-authorized-leader-archive-replay')
  console.log(JSON.stringify({ ok: true, suite: 'fde-company-knowledge', checks: checks.length, details: checks }))
} catch (error) { console.error(JSON.stringify({ suite: 'fde-company-knowledge', completedChecks: checks })); throw error }
finally { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }; await pool.end() }
