import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { auditLogs, oaApprovalNodes as nodes, oaApprovalRequests as requests, oaOfficePolicyCommands as commands, oaOfficePolicyVersions as versions, oaOfficeNotices as notices, userRoles, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { saveOfficePolicy, publishOfficePolicy, setOfficePolicyEnabled, resolveOfficePolicyCommand, listOfficePolicies } from '../services/fdeOfficePolicyService.js'
import { saveOfficeRequest, previewOfficeRequest, actOnOfficeRequest, getOfficeRequest } from '../services/fdeOfficeService.js'
import { listApprovalCenter, readOfficeNotice } from '../services/fdeApprovalCenterService.js'
import { officeDefinition } from '../contracts/fdeOfficeContract.js'
import { seedApprovalCenterFixture } from './fdeApprovalCenterFixture.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
const checks: string[] = [], marker = randomUUID().slice(0, 8)
let server: Server | undefined
const denied = async (work: Promise<unknown>, code: string) => { const error = await work.then(() => null, e => e); assert.equal(error?.code, code, error?.message ?? 'unexpected success') }
try {
  const people = ['系统管理员', '系统管理员', '投资经理', '财务', '财务', '董事长', '投资经理'].map((role, i) => ({ id: randomUUID(), name: `联动-${marker}-${i}`, email: `inbox-${marker}-${i}@example.invalid`, role, department: `联动验收-${marker}`, passwordHash: 'not-a-login-password' }))
  const [admin, admin2, author, b, c, d, outsider] = people
  await db.insert(users).values(people)
  for (const user of people) await identityRepositories.users.synchronizeAdministrationBindings(user.id, user.role, user.department)
  const roleId = async (uid: string) => (await db.select().from(userRoles).where(eq(userRoles.userId, uid)))[0].roleId
  const financeRole = await roleId(b.id), leaderRole = await roleId(d.id)
  const config = { kind: '合同', requiredFields: [], attachmentRequired: false, rejectResubmission: false, routes: [{ key: 'default', when: {}, nodes: [
    { key: 'finance', name: '财务双人会签', roleIds: [financeRole], fixedUserIds: [b.id, c.id], scope: 'institution', mode: '会签', allowTransfer: true },
    { key: 'leader', name: '下一节点领导', roleIds: [leaderRole], fixedUserIds: [d.id], scope: 'institution', mode: '或签', allowTransfer: false },
  ] }] }
  const id = randomUUID(), save = { clientRequestId: randomUUID(), expectedVersion: 0, configuration: config, reason: '隔离审批联动规则，不是生产政策' }, target = { id, action: 'save', clientRequestId: save.clientRequestId }
  const [saved, replay] = await Promise.all([saveOfficePolicy(id, admin.id, save), saveOfficePolicy(id, admin.id, save)])
  assert.deepEqual(saved, replay); assert.equal(saved.version, 1)
  assert.deepEqual(await resolveOfficePolicyCommand(admin.id, target), { state: 'committed', receipt: saved })
  await denied(saveOfficePolicy(id, admin.id, { ...save, reason: '不同内容不得复用原命令' }), 'OFFICE_POLICY_COMMAND_REUSED')
  await denied(resolveOfficePolicyCommand(admin.id, { ...target, id: randomUUID() }), 'OFFICE_POLICY_COMMAND_REUSED')
  await denied(resolveOfficePolicyCommand(admin.id, { ...target, action: 'publish' }), 'OFFICE_POLICY_COMMAND_REUSED')
  await assert.rejects(saveOfficePolicy(randomUUID(), admin.id, { expectedVersion: 0, configuration: config, reason: save.reason }))
  checks.push('rule-save-mandatory-command-concurrent-replay-action-target-hash-binding')
  assert.deepEqual(await resolveOfficePolicyCommand(outsider.id, target), { state: 'not_applied' })
  assert.deepEqual(await resolveOfficePolicyCommand(admin.id, target), { state: 'committed', receipt: saved })
  const sealedId = randomUUID(), sealed = { id: sealedId, action: 'save', clientRequestId: randomUUID() }
  await resolveOfficePolicyCommand(admin.id, sealed); await resolveOfficePolicyCommand(admin.id, sealed)
  await denied(saveOfficePolicy(sealedId, admin.id, { ...save, clientRequestId: sealed.clientRequestId }), 'OFFICE_POLICY_COMMAND_CLOSED')
  assert.equal((await db.select().from(versions).where(eq(versions.id, sealedId))).length, 0)
  checks.push('rule-unsent-create-fence-no-draft-cross-account-keys-independent')
  const head = (await listOfficePolicies(admin.id)).find(p => p.id === saved.policyId)!
  const publish = { clientRequestId: randomUUID(), expectedVersion: 1, expectedPolicyVersion: head.version, reason: '发布双人会签隔离规则版本' }
  const published = await publishOfficePolicy(id, admin.id, publish)
  assert.deepEqual(await publishOfficePolicy(id, admin.id, publish), published)
  const toggle = { clientRequestId: randomUUID(), expectedVersion: published.policyVersion, enabled: false, reason: '停用测试，再明确启用此规则' }
  const disabled = await setOfficePolicyEnabled(saved.policyId, admin.id, toggle)
  assert.deepEqual(await setOfficePolicyEnabled(saved.policyId, admin.id, toggle), disabled)
  const enabled = await setOfficePolicyEnabled(saved.policyId, admin.id, { ...toggle, clientRequestId: randomUUID(), expectedVersion: disabled.version, enabled: true })
  await denied(setOfficePolicyEnabled(saved.policyId, admin2.id, { ...toggle, clientRequestId: randomUUID(), expectedVersion: disabled.version }), 'VERSION_CONFLICT')
  checks.push('rule-publish-and-toggle-replay-version-conflict-no-history-rewrite')
  await db.delete(userRoles).where(eq(userRoles.userId, admin.id))
  assert.deepEqual(await resolveOfficePolicyCommand(admin.id, target), { state: 'committed', receipt: saved })
  assert.deepEqual(await saveOfficePolicy(id, admin.id, save), saved)
  await denied(saveOfficePolicy(randomUUID(), admin.id, { ...save, clientRequestId: randomUUID() }), 'OFFICE_POLICY_FORBIDDEN')
  await denied(listOfficePolicies(admin.id), 'OFFICE_POLICY_FORBIDDEN')
  await db.update(users).set({ status: '停用' }).where(eq(users.id, admin.id))
  await denied(resolveOfficePolicyCommand(admin.id, target), 'OFFICE_ACTOR_UNAVAILABLE')
  await db.update(users).set({ status: '启用' }).where(eq(users.id, admin.id))
  await identityRepositories.users.synchronizeAdministrationBindings(admin.id, admin.role, admin.department)
  checks.push('rule-own-minimal-receipt-after-role-loss-no-new-write-or-content-disabled-account-denied')
  const fault = randomUUID(), faultId = randomUUID(), table = quoteMysqlIdentifier(mysqlTableName('oa_office_policy_commands'))
  // Real MySQL constraint at the final receipt update, after draft/head/audit
  // writes. The exact random-prefix table is the only altered target.
  const constraint = `fixture_policy_receipt_${marker}`
  await db.execute(sql.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (command_id <> '${fault}' OR receipt IS NULL)`))
  const beforeHead = (await listOfficePolicies(admin.id)).find(p => p.id === saved.policyId)!
  const beforeAudit = await db.select().from(auditLogs).where(and(eq(auditLogs.userId, admin.id), eq(auditLogs.module, '通用OA规则')))
  try { await assert.rejects(saveOfficePolicy(faultId, admin.id, { ...save, clientRequestId: fault })) }
  finally { await db.execute(sql.raw(`ALTER TABLE ${table} DROP CHECK ${constraint}`)) }
  assert.equal((await db.select().from(versions).where(eq(versions.id, faultId))).length, 0)
  assert.equal((await db.select().from(commands).where(eq(commands.commandId, fault))).length, 0)
  assert.deepEqual((await listOfficePolicies(admin.id)).find(p => p.id === saved.policyId), beforeHead)
  assert.deepEqual(await db.select().from(auditLogs).where(and(eq(auditLogs.userId, admin.id), eq(auditLogs.module, '通用OA规则'))), beforeAudit)
  checks.push('rule-real-late-mysql-check-failure-rolls-back-draft-head-command-and-audit')
  for (let i = 0; i < 6; i++) {
    const rid = randomUUID(), command = randomUUID(), intent = { id: rid, action: 'save', clientRequestId: command }
    const outcome = await Promise.allSettled(i % 2 ? [saveOfficePolicy(rid, admin.id, { ...save, clientRequestId: command }), resolveOfficePolicyCommand(admin.id, intent)] : [resolveOfficePolicyCommand(admin.id, intent), saveOfficePolicy(rid, admin.id, { ...save, clientRequestId: command })])
    const result = await resolveOfficePolicyCommand(admin.id, intent), rows = await db.select().from(versions).where(eq(versions.id, rid))
    assert.equal(rows.length, result.state === 'committed' ? 1 : 0)
    assert.ok(outcome.every(r => r.status === 'fulfilled' || r.reason.code === 'OFFICE_POLICY_COMMAND_CLOSED'))
  }
  checks.push('rule-six-create-versus-fence-races-one-authoritative-outcome')
  const requestId = randomUUID(), definition = officeDefinition.parse({ title: `会签待办-${marker}`, reason: '检验真实会签中间态及当前通知', projectId: null, priority: '普通', details: { kind: '合同' }, attachmentIds: [] })
  await saveOfficeRequest(requestId, author.id, { clientRequestId: randomUUID(), expectedVersion: 0, definition })
  const act = async (uid: string, action: string, extra = {}) => actOnOfficeRequest(requestId, uid, { clientRequestId: randomUUID(), expectedVersion: (await getOfficeRequest(requestId, author.id)).version, action, reason: '隔离测试明确执行审批操作', ...extra })
  const preview = await previewOfficeRequest(requestId, author.id)
  await act(author.id, 'submit', { expectedPolicyVersionId: preview.policyVersionId, expectedRouteHash: preview.routeHash, confirmAttachmentSharing: true })
  // Filter this request by its unique title. The center intentionally also
  // searches applicant names; the legacy fixtures share this applicant.
  const pending = (uid: string) => listApprovalCenter(uid, { view: 'pending', q: definition.title })
  assert.equal((await pending(b.id)).total, 1); assert.equal((await pending(c.id)).total, 1); assert.equal((await pending(d.id)).total, 0)
  assert.equal((await pending(author.id)).total, 0); assert.equal((await pending(admin.id)).total, 0); assert.equal((await pending(outsider.id)).total, 0)
  const noticeB = (await pending(b.id)).list[0].notice!, original = await getOfficeRequest(requestId, author.id)
  assert.equal(noticeB.readAt, null)
  const read = await readOfficeNotice(noticeB.id, b.id)
  assert.deepEqual(await readOfficeNotice(noticeB.id, b.id), read)
  assert.equal((await pending(b.id)).list[0].notice?.readAt, read.readAt)
  assert.deepEqual(await getOfficeRequest(requestId, author.id), original)
  await denied(readOfficeNotice(noticeB.id, c.id), 'OFFICE_NOTICE_FORBIDDEN')
  checks.push('inbox-authorized-current-node-only-GET-read-only-explicit-read-idempotent-no-approval-mutation')
  await act(b.id, 'approve')
  assert.equal((await db.select().from(nodes).where(eq(nodes.id, original.currentNodeId!)))[0].status, '会签中')
  assert.equal((await pending(b.id)).total, 0); assert.equal((await pending(c.id)).total, 1); assert.equal((await pending(d.id)).total, 0)
  assert.equal((await getOfficeRequest(requestId, c.id)).capabilities.review, true)
  await denied(readOfficeNotice(noticeB.id, b.id), 'OFFICE_NOTICE_STALE')
  const noticeC = (await pending(c.id)).list[0].notice!
  await db.delete(userRoles).where(eq(userRoles.userId, c.id))
  assert.equal((await pending(c.id)).total, 0); await denied(readOfficeNotice(noticeC.id, c.id), 'OFFICE_BUSINESS_ROLE_REQUIRED')
  await identityRepositories.users.synchronizeAdministrationBindings(c.id, c.role, c.department)
  assert.equal((await pending(c.id)).total, 1)
  checks.push('partial-countersign-keeps-remaining-approver-no-early-next-node-current-role-revocation')
  const legacy = await seedApprovalCenterFixture(author, b, financeRole)
  const legacyPending = legacy.rows.filter(r => r.status === '审批中' && r.businessType !== 'office')
  assert.deepEqual([...new Set(legacyPending.map(row => row.businessType))].sort(), ['project_stage', 'task_extension'])
  for (const row of legacyPending) {
    await db.update(nodes).set({ mode: '会签', status: '会签中', approverUserIds: [b.id, c.id], approvedByUserIds: [b.id] }).where(eq(nodes.requestId, row.id))
    assert.equal((await listApprovalCenter(c.id, { view: 'pending', q: legacy.marker })).list.some(item => item.id === row.id), true)
    assert.equal((await listApprovalCenter(b.id, { view: 'pending', q: legacy.marker })).list.some(item => item.id === row.id), false)
  }
  const broad = await listApprovalCenter(c.id, { view: 'pending', q: marker })
  assert.ok(broad.total > (await pending(c.id)).total, 'applicant search intentionally includes the added legacy fixtures')
  checks.push('legacy-investment-and-task-extension-persisted-partial-countersign-query-contract')
  const [approval, acknowledgement] = await Promise.allSettled([act(c.id, 'approve'), readOfficeNotice(noticeC.id, c.id)])
  assert.equal(approval.status, 'fulfilled'); assert.ok(acknowledgement.status === 'fulfilled' || acknowledgement.reason.code === 'OFFICE_NOTICE_STALE')
  assert.equal((await pending(c.id)).total, 0); assert.equal((await pending(d.id)).total, 1)
  const noticeD = (await pending(d.id)).list[0].notice!
  await act(author.id, 'withdraw')
  assert.equal((await pending(d.id)).total, 0); await denied(readOfficeNotice(noticeD.id, d.id), 'OFFICE_NOTICE_STALE')
  assert.equal((await db.select().from(notices).where(and(eq(notices.requestId, requestId), isNull(notices.closedAt)))).length, 0)
  checks.push('read-versus-approve-race-serializes-with-business-withdrawal-closes-current-notices')
  process.env.AUTH_COOKIE_SECURE = 'false'; process.env.AUTH_COOKIE_DOMAIN = ''; process.env.AUTH_ALLOW_LEGACY_BEARER = 'false'; process.env.JWT_SECRET = randomUUID() + randomUUID()
  const password = `Inbox-Fixture-${randomUUID()}!`, { hashNewPassword } = await import('../security/passwordPolicy.js')
  const hash = await hashNewPassword(password); await db.update(users).set({ passwordHash: hash }).where(eq(users.id, admin.id)); await db.update(users).set({ passwordHash: hash }).where(eq(users.id, c.id))
  const { authRouter } = await import('../routes/auth.js'), { oaRouter } = await import('../routes/oa.js'), { systemAdministrationRouter } = await import('../routes/systemAdministration.js'), { requireAuth } = await import('../middleware/requireAuth.js'), { errorHandler } = await import('../middleware/errorHandler.js')
  let faultMode = ''
  const app = express(); app.use(express.json()); app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next)); app.use('/api/auth', authRouter)
  app.use((req, res, next) => { if (req.method !== 'POST' || !req.path.includes('/office-policy') || !faultMode) return next(); const mode = faultMode; faultMode = ''; if (mode === 'before') { res.status(502).json({ code: 'FIXTURE_LOSS' }); return }; const json = res.json.bind(res); res.json = body => res.statusCode < 400 ? json.call(res.status(502), { code: 'FIXTURE_LOSS' }) : json(body); next() })
  app.use('/api/system-administration', systemAdministrationRouter); app.use('/api/oa', oaRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.AUTH_ALLOWED_ORIGINS = origin
  const login = async (email: string) => { const r = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }); assert.equal(r.status, 200); const cookies = r.headers.getSetCookie(); return { Cookie: cookies.map(v => v.split(';')[0]).join('; '), 'X-CSRF-Token': decodeURIComponent(cookies.find(v => v.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length)), 'Content-Type': 'application/json', Origin: origin } }
  const headers = await login(admin.email), http = (path: string, body: unknown, extra = {}) => fetch(origin + '/api' + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
  const resolvePath = '/system-administration/office-policy-commands/resolve', httpId = randomUUID(), httpSave = { ...save, clientRequestId: randomUUID() }, httpTarget = { id: httpId, action: 'save', clientRequestId: httpSave.clientRequestId }, writePath = `/system-administration/office-policy-versions/${httpId}/save`
  assert.equal((await http(resolvePath, httpTarget, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await http(resolvePath, httpTarget, { Origin: 'https://foreign.invalid' })).status, 403)
  assert.equal((await http(resolvePath, { ...httpTarget, actorId: admin2.id })).status, 400)
  faultMode = 'after'; assert.equal((await http(writePath, httpSave)).status, 502)
  const recovered = await http(resolvePath, httpTarget); assert.equal(recovered.status, 200); assert.equal(recovered.headers.get('cache-control'), 'private, no-store'); assert.equal((await recovered.json() as { state: string }).state, 'committed')
  assert.equal((await http(writePath, httpSave)).status, 200)
  const delayed = { ...httpTarget, id: randomUUID(), clientRequestId: randomUUID() }, delayedPath = `/system-administration/office-policy-versions/${delayed.id}/save`
  faultMode = 'before'; assert.equal((await http(delayedPath, { ...save, clientRequestId: delayed.clientRequestId })).status, 502)
  faultMode = 'after'; assert.equal((await http(resolvePath, delayed)).status, 502)
  assert.equal((await (await http(resolvePath, delayed)).json() as { state: string }).state, 'not_applied')
  assert.equal((await http(delayedPath, { ...save, clientRequestId: delayed.clientRequestId })).status, 409)
  await db.delete(userRoles).where(eq(userRoles.userId, admin.id))
  assert.equal((await http(resolvePath, httpTarget)).status, 200); assert.equal((await http(writePath, httpSave)).status, 403)
  checks.push('rule-real-auth-CSRF-Origin-role-loss-minimal-receipt-postcommit-loss-precommit-loss-resolver-loss-late-write-denied')
  const rePreview = await previewOfficeRequest(requestId, author.id)
  await act(author.id, 'submit', { expectedPolicyVersionId: rePreview.policyVersionId, expectedRouteHash: rePreview.routeHash, confirmAttachmentSharing: true })
  const cHeaders = await login(c.email), currentNotice = (await pending(c.id)).list[0].notice!, readPath = `/oa/office/notices/${currentNotice.id}/read`
  assert.equal((await http(readPath, {}, { ...cHeaders, 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await http(readPath, { actorId: c.id }, cHeaders)).status, 400)
  assert.equal((await http(readPath, {}, cHeaders)).status, 200)
  assert.equal((await http(readPath, {}, cHeaders)).status, 200)
  assert.equal((await pending(c.id)).total, 1)
  assert.equal((await getOfficeRequest(requestId, c.id)).revision, 2)
  checks.push('notice-real-session-CSRF-strict-body-revision-two-new-current-notice-read-not-approval')
  console.log(JSON.stringify({ ok: true, suite: 'fde-office-inbox-policy', checks: checks.length, details: checks, enabledPolicyVersion: enabled.policyVersion }))
} catch (error) { console.error(JSON.stringify({ suite: 'fde-office-inbox-policy', completedChecks: checks })); throw error }
finally { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }; await pool.end() }
