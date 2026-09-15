import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { and, count, eq, isNull } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { oaApprovalNodes, oaApprovalRecords, oaApprovalRequests, oaApprovalRevisions, oaOfficeEvents, oaOfficeNotices, projects, userRoles, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { officeDefinition, officeKinds, type OfficeDefinition } from '../contracts/fdeOfficeContract.js'
import { listOfficePolicies, publishOfficePolicy, saveOfficePolicy, setOfficePolicyEnabled } from '../services/fdeOfficePolicyService.js'
import { actOnOfficeRequest, getOfficeAttachment, getOfficeRequest, getOfficeRevision, grantOfficeAttachment, listOfficeRequests, officeCommandReceipt, officeTransferCandidates, previewOfficeRequest, saveOfficeRequest, uploadOfficeAttachment } from '../services/fdeOfficeService.js'
import { actOnOaApprovalRequest, listOaApprovalRequests } from '../services/oaWorkflowService.js'
import { listApprovalCenter } from '../services/fdeApprovalCenterService.js'
import { seedApprovalCenterFixture } from './fdeApprovalCenterFixture.js'
import { createProject } from '../services/projectService.js'
import { shanghaiToday } from '../contracts/fdeWeeklyPlanContract.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
const checks: string[] = [], marker = randomUUID().slice(0, 8)
let server: Server | undefined
const denied = async (work: Promise<unknown>, code: string) => { const error = await work.then(() => null, e => e); assert.equal(error?.code, code, error?.message ?? 'unexpected success') }
try {
  const people = ['投资经理', '财务', '财务', '董事长', '系统管理员', '投资经理', '法务'].map((role, i) => ({ id: randomUUID(), name: `办公-${marker}-${i === 5 ? 0 : i}`, role, email: `office-${marker}-${i}@example.invalid`, department: `OA验收-${marker}`, passwordHash: 'not-a-login-password' }))
  const [author, reviewer, backup, leader, admin, stranger, legal] = people
  await db.insert(users).values(people)
  for (const user of people) await identityRepositories.users.synchronizeAdministrationBindings(user.id, user.role, user.department)
  const roleId = async (uid: string) => (await db.select().from(userRoles).where(eq(userRoles.userId, uid)))[0].roleId
  const financeRole = await roleId(reviewer.id), leaderRole = await roleId(leader.id)
  const node = { key: 'finance', name: '财务审核', roleIds: [financeRole], scope: 'institution', mode: '或签', fixedUserIds: [reviewer.id], allowTransfer: true }
  const configurations = new Map<string, unknown>()
  for (const kind of officeKinds) {
    const config = { kind, requiredFields: [], attachmentRequired: false, rejectResubmission: false, routes: [{ key: 'default', when: {}, nodes: [node, { ...node, key: 'leader', name: '领导审核', roleIds: [leaderRole], fixedUserIds: [leader.id], allowTransfer: false }] }] }
    configurations.set(kind, config)
    const vid = randomUUID()
    await saveOfficePolicy(vid, admin.id, { clientRequestId: randomUUID(), expectedVersion: 0, configuration: config, reason: '隔离合成规则，不是生产默认规则' })
    const head = (await listOfficePolicies(admin.id)).find(p => p.kind === kind)!
    await publishOfficePolicy(vid, admin.id, { clientRequestId: randomUUID(), expectedVersion: 1, expectedPolicyVersion: head.version, reason: '发布隔离测试审批规则版本' })
    await denied(saveOfficePolicy(vid, admin.id, { clientRequestId: randomUUID(), expectedVersion: 2, configuration: config, reason: '已发布版本不能原地修改' }), 'OFFICE_POLICY_IMMUTABLE')
  }
  await denied(listOfficePolicies(author.id), 'OFFICE_POLICY_FORBIDDEN')
  checks.push('FDE-OA-004:admin-only-published-typed-policies-immutable-history-no-demo-defaults')
  const officeProject = await createProject(
    { name: `办公关联项目-${marker}` },
    author.id,
    { ownerUserId: author.id, assignments: [{ duty: 'project_manager', userId: author.id }, { duty: 'finance', userId: reviewer.id }, { duty: 'legal', userId: legal.id }, { duty: 'boss', userId: leader.id }] },
  )
  const projectCount = (await db.select({ value: count() }).from(projects))[0].value
  const draft = async (kind: typeof officeKinds[number]) => {
    const id = randomUUID(), definition = officeDefinition.parse({ title: `${kind}-${marker}`, reason: '完整合成测试申请理由', projectId: kind === '出差' ? officeProject.id : null, priority: '普通', details: { kind }, attachmentIds: [] })
    await saveOfficeRequest(id, author.id, { clientRequestId: randomUUID(), expectedVersion: 0, definition })
    if (kind === '报销') {
      const attachmentId = randomUUID()
      await uploadOfficeAttachment(id, attachmentId, author.id, { clientRequestId: randomUUID(), expectedVersion: 1, name: '报销发票.txt', dataBase64: Buffer.from('隔离报销发票').toString('base64'), purpose: 'application', reason: '准备报销验收材料' })
      const expenseDefinition = officeDefinition.parse({ ...definition, attachmentIds: [attachmentId], details: { kind, currency: 'CNY', amount: '10', projectExplanation: '隔离测试报销事项说明', items: [{ id: randomUUID(), date: shanghaiToday(), category: '其他', description: '隔离测试费用', amount: '10', invoiceNumber: `INV-${marker}`, attachmentId }] } })
      await saveOfficeRequest(id, author.id, { clientRequestId: randomUUID(), expectedVersion: 2, definition: expenseDefinition })
      return { id, definition: expenseDefinition }
    }
    return { id, definition }
  }
  const version = async (id: string) => (await getOfficeRequest(id, author.id)).version
  const action = async (id: string, uid: string, act: string, extra = {}) => actOnOfficeRequest(id, uid, { clientRequestId: randomUUID(), expectedVersion: await version(id), action: act, reason: '明确执行合成测试操作', ...extra })
  const submit = async (id: string) => { const preview = await previewOfficeRequest(id, author.id); assert.deepEqual(preview.issues, []); return action(id, author.id, 'submit', { expectedPolicyVersionId: preview.policyVersionId, expectedRouteHash: preview.routeHash, confirmAttachmentSharing: true }) }
  for (const kind of officeKinds) {
    const { id } = await draft(kind)
    await denied(getOfficeRequest(id, stranger.id), 'OFFICE_FORBIDDEN')
    await submit(id)
    assert.equal((await getOfficeRequest(id, reviewer.id)).capabilities.review, true)
    await denied(action(id, author.id, 'approve'), 'OFFICE_REVIEWER_FORBIDDEN')
    await denied(action(id, leader.id, 'approve'), 'OFFICE_REVIEWER_FORBIDDEN')
    await action(id, reviewer.id, 'approve'); assert.equal((await getOfficeRequest(id, author.id)).status, '审批中')
    await action(id, leader.id, 'approve'); assert.equal((await getOfficeRequest(id, author.id)).status, '已通过')
    assert.equal((await db.select().from(oaOfficeNotices).where(and(eq(oaOfficeNotices.requestId, id), isNull(oaOfficeNotices.closedAt)))).length, 0)
    assert.equal((await getOfficeRevision(id, 1, author.id)).snapshot.definition != null, true)
  }
  assert.equal((await db.select({ value: count() }).from(projects))[0].value, projectCount)
  assert.equal((await listOaApprovalRequests(author.id)).some(r => r.businessType === 'office'), false)
  checks.push('FDE-OA-001/002/003/015:typed-project-requirement-sequential-approval-only-current-node-no-project-mutation-no-fake-execution')
  const { id: fileRequest, definition: fileDefinition } = await draft('合同'), fileId = randomUUID(), bytes = Buffer.from(`冻结批准件-${marker}`)
  const upload = { clientRequestId: randomUUID(), expectedVersion: await version(fileRequest), name: '合同批准原件.txt', dataBase64: bytes.toString('base64'), purpose: 'application', reason: '保存真实申请级原始附件' }
  const uploaded = await uploadOfficeAttachment(fileRequest, fileId, author.id, upload)
  assert.deepEqual(await uploadOfficeAttachment(fileRequest, fileId, author.id, upload), uploaded)
  await saveOfficeRequest(fileRequest, author.id, { clientRequestId: randomUUID(), expectedVersion: await version(fileRequest), definition: { ...fileDefinition, attachmentIds: [fileId] } })
  await submit(fileRequest)
  assert.deepEqual((await getOfficeAttachment(fileRequest, fileId, reviewer.id)).bytes, bytes)
  await denied(getOfficeAttachment(fileRequest, fileId, reviewer.id, true), 'OFFICE_FILE_FORBIDDEN')
  await denied(getOfficeAttachment(fileRequest, randomUUID(), reviewer.id), 'OFFICE_FILE_FORBIDDEN')
  await grantOfficeAttachment(fileRequest, fileId, author.id, { clientRequestId: randomUUID(), expectedVersion: await version(fileRequest), reason: '仅授予备选人查看权限', grants: [{ userId: reviewer.id, canDownload: false }, { userId: leader.id, canDownload: false }, { userId: backup.id, canDownload: false }] })
  assert.equal((await officeTransferCandidates(fileRequest, reviewer.id)).some(p => p.id === backup.id), false)
  await denied(action(fileRequest, reviewer.id, 'transfer', { targetUserId: backup.id }), 'OFFICE_FILE_FORBIDDEN')
  await grantOfficeAttachment(fileRequest, fileId, author.id, { clientRequestId: randomUUID(), expectedVersion: await version(fileRequest), reason: '显式授予合法转交查看和下载权', grants: [{ userId: reviewer.id, canDownload: false }, { userId: leader.id, canDownload: false }, { userId: backup.id, canDownload: true }] })
  assert.equal((await officeTransferCandidates(fileRequest, reviewer.id)).some(p => p.id === backup.id), true)
  const transfer = { clientRequestId: randomUUID(), expectedVersion: await version(fileRequest), reason: '同岗位受控转交合成测试', action: 'transfer', targetUserId: backup.id }
  const transferred = await actOnOfficeRequest(fileRequest, reviewer.id, transfer)
  await denied(getOfficeRequest(fileRequest, reviewer.id), 'OFFICE_FORBIDDEN')
  assert.deepEqual(await actOnOfficeRequest(fileRequest, reviewer.id, transfer), transferred)
  assert.deepEqual((await officeCommandReceipt(fileRequest, transfer.clientRequestId, reviewer.id)).receipt, transferred)
  assert.equal((await officeCommandReceipt(fileRequest, transfer.clientRequestId, stranger.id)).found, false)
  await action(fileRequest, backup.id, 'approve'); await action(fileRequest, leader.id, 'approve')
  const frozen = (await getOfficeRevision(fileRequest, 1, author.id)).snapshot
  await uploadOfficeAttachment(fileRequest, randomUUID(), author.id, { ...upload, clientRequestId: randomUUID(), expectedVersion: await version(fileRequest), purpose: 'signed', name: '合同签署件.txt', dataBase64: Buffer.from('独立签署归档版本').toString('base64') })
  assert.deepEqual((await getOfficeRevision(fileRequest, 1, author.id)).snapshot, frozen)
  await grantOfficeAttachment(fileRequest, fileId, author.id, { clientRequestId: randomUUID(), expectedVersion: await version(fileRequest), reason: '撤销原件访问以复核全部读取入口', grants: [] })
  await denied(getOfficeRequest(fileRequest, backup.id), 'OFFICE_FORBIDDEN')
  assert.equal((await listOfficeRequests(backup.id, { view: 'processed', q: `合同-${marker}` })).total, 0)
  const hiddenOriginal = await listApprovalCenter(backup.id, { view: 'processed', q: `合同-${marker}` })
  assert.equal(hiddenOriginal.total, 0); assert.equal(hiddenOriginal.counts.processed, 0)
  checks.push('FDE-OA-007/011/013/014:real-bytes-application-acl-FDE-transfer-download-requirement-replay-after-access-loss-approved-vs-signed-revocation')
  const { id: returned } = await draft('出差')
  await submit(returned); await action(returned, reviewer.id, 'return')
  assert.equal((await getOfficeRequest(returned, author.id)).capabilities.edit, true)
  await submit(returned)
  assert.equal((await getOfficeRequest(returned, author.id)).revision, 2)
  assert.equal((await db.select().from(oaApprovalRevisions).where(eq(oaApprovalRevisions.requestId, returned))).length, 2)
  await action(returned, reviewer.id, 'reject')
  await denied(submit(returned), 'OFFICE_NOT_EDITABLE')
  const { id: cancelled } = await draft('请假')
  await submit(cancelled); await action(cancelled, author.id, 'withdraw'); await submit(cancelled)
  const { id: deleted } = await draft('用印')
  const deletion = { clientRequestId: randomUUID(), expectedVersion: 1, action: 'delete', reason: '删除本人从未提交的测试草稿' }
  const receipt = await actOnOfficeRequest(deleted, author.id, deletion)
  assert.deepEqual(await actOnOfficeRequest(deleted, author.id, deletion), receipt)
  await denied(getOfficeRequest(deleted, author.id), 'OFFICE_FORBIDDEN')
  checks.push('FDE-OA-005/008:distinct-return-reject-withdraw-draft-delete-new-revisions-old-snapshots-retained-and-minimal-replay')
  const before = (await db.select().from(oaApprovalRequests).where(eq(oaApprovalRequests.id, cancelled)))[0]
  const beforeNotices = await db.select().from(oaOfficeNotices).where(eq(oaOfficeNotices.requestId, cancelled))
  const faultId = randomUUID()
  await db.insert(oaOfficeEvents).values({ id: faultId, requestId: cancelled, commandId: randomUUID(), commandHash: 'f'.repeat(64), version: before.lockVersion + 1, actorId: author.id, action: 'fixture-fault', reason: '仅隔离测试唯一约束失败', snapshot: {} })
  await assert.rejects(action(cancelled, reviewer.id, 'approve'))
  assert.deepEqual((await db.select().from(oaApprovalRequests).where(eq(oaApprovalRequests.id, cancelled)))[0], before)
  assert.deepEqual(await db.select().from(oaOfficeNotices).where(eq(oaOfficeNotices.requestId, cancelled)), beforeNotices)
  await db.delete(oaOfficeEvents).where(eq(oaOfficeEvents.id, faultId))
  await denied(actOnOaApprovalRequest({ requestId: cancelled, userId: reviewer.id, action: 'approve', comment: '旧入口不得处理通用办公申请' }), 'OA_BUSINESS_ROUTE_REQUIRED')
  checks.push('FDE-OA-002/009/CONC:real-late-constraint-rollback-request-nodes-notices-legacy-route-denies-office')
  const { id: raceId, definition: raceDefinition } = await draft('报销')
  const save = { clientRequestId: randomUUID(), expectedVersion: 1, definition: { ...raceDefinition, title: '并发保存只执行一次' } }
  assert.deepEqual(...await Promise.all([saveOfficeRequest(raceId, author.id, save), saveOfficeRequest(raceId, author.id, save)]))
  const races = await Promise.allSettled([saveOfficeRequest(raceId, author.id, { ...save, clientRequestId: randomUUID(), expectedVersion: 2 }), saveOfficeRequest(raceId, author.id, { ...save, clientRequestId: randomUUID(), expectedVersion: 2 })])
  assert.equal(races.filter(r => r.status === 'fulfilled').length, 1)
  const stale = await previewOfficeRequest(raceId, author.id)
  const head = (await listOfficePolicies(admin.id)).find(p => p.kind === '报销')!
  await setOfficePolicyEnabled(head.id, admin.id, { clientRequestId: randomUUID(), expectedVersion: head.version, enabled: false, reason: '停用新申请但保留在途历史规则' })
  await denied(action(raceId, author.id, 'submit', { expectedPolicyVersionId: stale.policyVersionId, expectedRouteHash: stale.routeHash }), 'OFFICE_POLICY_NOT_PUBLISHED')
  assert.equal((await listOfficeRequests(stranger.id, { view: 'tracking', q: marker })).total, 0)
  checks.push('FDE-OA-004/CONC/AUTH:same-command-idempotent-version-race-one-winner-disabled-policy-blocks-new-submission-same-name-isolation')
  const center = await seedApprovalCenterFixture(author, reviewer, financeRole)
  const pages = await Promise.all([1, 2, 3].map(page => listApprovalCenter(author.id, { view: 'mine', q: center.marker, page })))
  assert.deepEqual(pages.map(p => p.list.length), [20, 20, 2])
  assert.deepEqual(pages.flatMap(p => p.list.map(r => r.id)), center.rows.map(r => r.id))
  assert.ok(pages.every(p => p.total === 42 && p.counts.mine === 42))
  assert.ok(pages.slice(0, 2).every(p => new Set(p.list.map(r => r.businessType)).size === 3))
  const overshoot = await listApprovalCenter(author.id, { view: 'mine', q: center.marker, page: 999 })
  assert.equal(overshoot.page, 3); assert.equal(overshoot.list.length, 2)
  for (const kind of ['立项审批', '任务延期', ...officeKinds]) {
    const filtered = await listApprovalCenter(author.id, { view: 'mine', q: center.marker, kind })
    assert.equal(filtered.total, 6); assert.equal(filtered.counts.mine, 6); assert.ok(filtered.list.every(r => r.kind === kind))
  }
  assert.equal((await listApprovalCenter(author.id, { view: 'mine', q: `${center.marker}关联项目` })).total, 12)
  assert.equal((await listApprovalCenter(author.id, { view: 'mine', q: '%' })).total, 0)
  checks.push('FDE-OA-001/002/010:single-table-mixed-types-three-pages-stable-tie-order-filter-counts-project-search-literal-wildcards-and-page-clamp')
  const terminal = ['已通过', '已拒绝', '已撤回'], visible = center.rows.filter(r => r.businessType !== 'office' || r.status !== '草稿')
  const expected = {
    pending: visible.filter(r => r.status === '审批中'), tracking: visible.filter(r => !terminal.includes(r.status) && !['草稿', '审批中'].includes(r.status)),
    processed: visible.filter(r => r.processed), mine: [], draft: [], completed: visible.filter(r => terminal.includes(r.status)),
  }
  for (const [view, rows] of Object.entries(expected)) {
    const result = await listApprovalCenter(reviewer.id, { view, q: center.marker, pageSize: 100 })
    assert.deepEqual(result.list.map(r => r.id), rows.map(r => r.id), view)
    for (const [key, matching] of Object.entries(expected)) assert.equal(result.counts[key as keyof typeof result.counts], matching.length, key)
  }
  assert.equal((await listApprovalCenter(stranger.id, { view: 'tracking', q: center.marker })).total, 0)
  const adminCenter = await listApprovalCenter(admin.id, { view: 'completed', q: center.marker })
  assert.equal(adminCenter.canCreateOffice, false); assert.ok(adminCenter.list.every(r => r.businessType !== 'office'))
  const oldRows = (await listOaApprovalRequests(reviewer.id)).filter(r => r.title.includes(center.marker))
  assert.deepEqual(oldRows.map(r => r.id).sort(), center.rows.filter(r => r.businessType !== 'office').map(r => r.id).sort())
  checks.push('FDE-OA-001/010/AUTH:six-view-disjoint-tracking-current-node-only-same-name-isolation-admin-not-office-and-legacy-scope-equivalence')
  await db.delete(userRoles).where(eq(userRoles.userId, reviewer.id))
  const revoked = await listApprovalCenter(reviewer.id, { view: 'pending', q: center.marker, pageSize: 100 })
  assert.equal(revoked.canCreateOffice, false); assert.ok(revoked.list.every(r => r.businessType !== 'office'))
  assert.equal(revoked.total, center.rows.filter(r => r.businessType !== 'office' && r.status === '审批中').length)
  await identityRepositories.users.synchronizeAdministrationBindings(reviewer.id, reviewer.role, reviewer.department)
  checks.push('FDE-OA-007/011/AUTH:current-office-role-revocation-removes-rows-counts-and-creation-without-changing-legacy-contract')
  const changedNodeRequest = center.rows.find(r => r.businessType === 'office' && r.status === '审批中')!, historicalNode = randomUUID()
  await db.insert(oaApprovalNodes).values({ id: historicalNode, requestId: changedNodeRequest.id, name: '历史独立岗位', approverRole: '领导', sequence: 2, mode: '或签', status: '已通过',
    officeRevision: 0, officeRule: { ...node, roleIds: [leaderRole] }, approverUserIds: [reviewer.id], approverNames: [reviewer.name], approvedByUserIds: [reviewer.id], approvedByNames: [reviewer.name] })
  await db.insert(oaApprovalRecords).values({ requestId: changedNodeRequest.id, nodeId: historicalNode, nodeName: '历史独立岗位', operatorUserId: reviewer.id, operatorName: reviewer.name, action: '同意', comment: '隔离历史节点读取权限夹具' })
  await db.insert(userRoles).values({ userId: reviewer.id, roleId: leaderRole })
  await db.delete(userRoles).where(and(eq(userRoles.userId, reviewer.id), eq(userRoles.roleId, financeRole)))
  const noCurrentRole = await listApprovalCenter(reviewer.id, { view: 'pending', q: center.marker, pageSize: 100 })
  assert.equal(noCurrentRole.list.some(r => r.id === changedNodeRequest.id), false)
  assert.equal((await listOfficeRequests(reviewer.id, { view: 'pending', q: center.marker })).list.some(r => r.id === changedNodeRequest.id), false)
  assert.equal((await listApprovalCenter(reviewer.id, { view: 'tracking', q: center.marker, pageSize: 100 })).list.some(r => r.id === changedNodeRequest.id), true)
  await db.delete(userRoles).where(eq(userRoles.userId, reviewer.id))
  await identityRepositories.users.synchronizeAdministrationBindings(reviewer.id, reviewer.role, reviewer.department)
  checks.push('FDE-OA-007/011:historical-role-does-not-substitute-current-node-role-and-office-only-query-shares-center-contract')
  process.env.AUTH_COOKIE_SECURE = 'false'; process.env.AUTH_COOKIE_DOMAIN = ''; process.env.AUTH_ALLOW_LEGACY_BEARER = 'false'; process.env.JWT_SECRET = randomUUID() + randomUUID()
  const password = `Office-Fixture-${randomUUID()}!`, { hashNewPassword } = await import('../security/passwordPolicy.js')
  await db.update(users).set({ passwordHash: await hashNewPassword(password) }).where(eq(users.id, author.id))
  const { authRouter } = await import('../routes/auth.js'), { oaRouter } = await import('../routes/oa.js'), { requireAuth } = await import('../middleware/requireAuth.js'), { errorHandler } = await import('../middleware/errorHandler.js')
  const app = express(); app.use(express.json({ limit: '2mb' })); app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next)); app.use('/api/auth', authRouter)
  // Synthetic loopback HTTP server only. Simulate a committed response loss,
  // not a production endpoint, bypass or fabricated successful response.
  app.use('/api/oa', (req, res, next) => { if (req.headers['x-fixture-drop-response'] === 'after-commit') res.json = () => { req.socket.destroy(); return res }; next() })
  app.use('/api/oa', oaRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.AUTH_ALLOWED_ORIGINS = origin
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: author.email, password }) }); assert.equal(login.status, 200)
  const cookies = login.headers.getSetCookie(), cookie = cookies.map(v => v.split(';')[0]).join('; '), csrf = decodeURIComponent(cookies.find(v => v.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length))
  const url = `${origin}/api/oa/office/requests/${raceId}`, http = (suffix: string, body?: unknown, extra: Record<string, string> = {}) => fetch(url + suffix, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  assert.equal((await fetch(url)).status, 401)
  assert.equal((await http('')).status, 200)
  const centerUrl = `${origin}/api/oa/center?view=mine&q=${encodeURIComponent(center.marker)}&page=2`
  assert.equal((await fetch(centerUrl)).status, 401)
  const centerResponse = await fetch(centerUrl, { headers: { Cookie: cookie } })
  assert.equal(centerResponse.status, 200); assert.equal(centerResponse.headers.get('cache-control'), 'private, no-store')
  const centerBody = await centerResponse.json() as { list: Array<{ id: string }>; total: number }
  assert.equal(centerBody.total, 42); assert.deepEqual(centerBody.list.map(r => r.id), center.rows.slice(20, 40).map(r => r.id))
  const httpSave = { clientRequestId: randomUUID(), expectedVersion: await version(raceId), definition: { ...raceDefinition, title: '真实认证HTTP响应丢失后恢复' } }
  assert.equal((await http('/save', httpSave, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await http('/save', httpSave, { Origin: 'https://invalid.example.invalid' })).status, 403)
  await assert.rejects(http('/save', httpSave, { 'X-Fixture-Drop-Response': 'after-commit' }))
  const recovered = await http(`/commands/${httpSave.clientRequestId}`); assert.equal(recovered.status, 200); assert.equal((await recovered.json() as { found: boolean }).found, true)
  assert.equal((await http('/save', httpSave)).status, 200)
  assert.equal((await db.select().from(oaOfficeEvents).where(eq(oaOfficeEvents.commandId, httpSave.clientRequestId))).length, 1)
  const original = await fetch(`${origin}/api/oa/office/requests/${fileRequest}/attachments/${fileId}/preview`, { headers: { Cookie: cookie } })
  assert.equal(original.status, 200); assert.equal(original.headers.get('cache-control'), 'private, no-store'); assert.equal(original.headers.get('x-content-type-options'), 'nosniff'); assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes)
  await db.update(users).set({ status: '停用' }).where(eq(users.id, author.id)); assert.equal((await http('')).status, 401)
  await db.update(users).set({ status: '启用' }).where(eq(users.id, author.id))
  checks.push('FDE-OA-009/011/014/AUTH:real-session-csrf-origin-private-original-bytes-disabled-account-and-committed-response-loss-recovery')
  console.log(JSON.stringify({ ok: true, suite: 'fde-office', checks: checks.length, details: checks }))
} catch (e) { console.error(JSON.stringify({ suite: 'fde-office', completedChecks: checks })); throw e }
finally { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }; await pool.end() }
