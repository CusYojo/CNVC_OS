import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { and, eq } from 'drizzle-orm'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

// Never import the database or create resources before this explicit guard.
assertIsolatedMysqlAcceptanceDatabase('fdeOfficeExecutionAcceptance')
assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
process.env.AUTH_COOKIE_SECURE = 'false'; process.env.AUTH_COOKIE_DOMAIN = ''; process.env.AUTH_ALLOW_LEGACY_BEARER = 'false'; process.env.JWT_SECRET = randomUUID() + randomUUID()
const { db, pool } = await import('../db/client.js')
const { users, userRoles, oaApprovalRequests: requests, oaApprovalRevisions: revisions, oaOfficeExecutions: executions, oaOfficeEvents: events, oaOfficeAttachments: files, oaOfficeAttachmentGrants: grants, oaOfficeExecutionFiles: links } = await import('../db/schema.js')
const { identityRepositories } = await import('../repositories/index.js')
const office = await import('../services/fdeOfficeService.js')
const policies = await import('../services/fdeOfficePolicyService.js')
const { officeDefinition } = await import('../contracts/fdeOfficeContract.js')
const checks: string[] = [], marker = randomUUID().slice(0, 8)
const deny = async (work: Promise<unknown>, code?: string) => { const error = await work.then(() => null, e => e); assert.ok(error); if (code) assert.equal(error.code, code, error.message) }
let server: Server | undefined
try {
  const { hashNewPassword } = await import('../security/passwordPolicy.js'), password = `Execution-${randomUUID()}!`, passwordHash = await hashNewPassword(password)
  const people = ['投资经理', '财务', '财务', '系统管理员', '财务'].map((role, i) => ({ id: randomUUID(), role, name: `执行-${marker}-${i}`, email: `execution-${marker}-${i}@example.invalid`, department: `执行-${marker}`, passwordHash }))
  const [author, reviewer, executor, admin, stranger] = people
  await db.insert(users).values(people)
  for (const person of people) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
  const financeRole = (await db.select().from(userRoles).where(eq(userRoles.userId, executor.id)))[0].roleId
  const config = { kind: '合同', requiredFields: [], attachmentRequired: false, rejectResubmission: false,
    execution: { enabled: true, roleIds: [financeRole], userIds: [executor.id], scope: 'institution', requiredFields: ['reference'], authorizationNote: '仅隔离数据库合成执行角色，不启用正式业务' },
    routes: [{ key: 'default', when: {}, nodes: [{ key: 'finance', name: '合成审批', roleIds: [financeRole], scope: 'institution', mode: '或签', fixedUserIds: [reviewer.id], allowTransfer: false }] }] }
  const policyId = randomUUID()
  await policies.saveOfficePolicy(policyId, admin.id, { clientRequestId: randomUUID(), expectedVersion: 0, configuration: config, reason: '隔离执行回执验收规则草稿' })
  const head = (await policies.listOfficePolicies(admin.id)).find(p => p.kind === '合同')!
  await policies.publishOfficePolicy(policyId, admin.id, { clientRequestId: randomUUID(), expectedVersion: 1, expectedPolicyVersion: head.version, reason: '仅隔离测试正式提交此规则' })
  const id = randomUUID(), definition = officeDefinition.parse({ title: `执行回执-${marker}`, reason: '仅合成执行回执申请事由', priority: '普通', projectId: null, details: { kind: '合同' }, attachmentIds: [] })
  await office.saveOfficeRequest(id, author.id, { clientRequestId: randomUUID(), expectedVersion: 0, definition })
  const current = async () => (await db.select().from(requests).where(eq(requests.id, id)))[0]
  assert.equal((await office.getOfficeExecutions(id, author.id)).canRecord, false)
  const preview = await office.previewOfficeRequest(id, author.id)
  await office.actOnOfficeRequest(id, author.id, { clientRequestId: randomUUID(), expectedVersion: 1, reason: '提交合成审批申请', action: 'submit', expectedPolicyVersionId: preview.policyVersionId, expectedRouteHash: preview.routeHash })
  await office.actOnOfficeRequest(id, reviewer.id, { clientRequestId: randomUUID(), expectedVersion: (await current()).lockVersion, reason: '独立审批合成申请', action: 'approve' })
  const approved = await current(), frozenRevision = (await db.select().from(revisions).where(eq(revisions.requestId, id)))[0]
  assert.equal((await office.getOfficeExecutions(id, author.id)).canRecord, false)
  assert.equal((await office.getOfficeExecutions(id, reviewer.id)).canRecord, false)
  await deny(office.getOfficeExecutions(id, admin.id)); await deny(office.getOfficeExecutions(id, stranger.id))
  assert.equal((await office.getOfficeExecutions(id, executor.id)).canRecord, true)
  checks.push('approved-not-executed-explicit-account-and-role-no-admin-reviewer-or-applicant-default')
  const fileId = randomUUID(), bytes = Buffer.from('合成人工执行原件，不是正式签署')
  await office.uploadOfficeAttachment(id, fileId, executor.id, { clientRequestId: randomUUID(), expectedVersion: approved.lockVersion, reason: '上传隔离执行证明原件', name: '执行证明.txt', dataBase64: bytes.toString('base64'), purpose: 'execution' })
  const file = (await db.select().from(files).where(eq(files.id, fileId)))[0]
  const input = async (action: 'record' | 'retry' | 'correct' = 'record', previous: string | null = null) => ({ clientRequestId: randomUUID(), expectedVersion: (await current()).lockVersion, expectedLatestId: previous, action, outcome: 'failed', occurredAt: new Date().toISOString(), facts: { reference: 'SYNTHETIC-RECEIPT' }, reason: '仅隔离人工办理失败事实', files: [{ fileId, version: 1, sha256: file.sha256 }] })
  const first = await input()
  await deny(office.recordOfficeExecution(id, reviewer.id, first), 'OFFICE_EXECUTION_FORBIDDEN')
  await deny(office.recordOfficeExecution(id, author.id, first), 'OFFICE_EXECUTION_FORBIDDEN')
  await deny(office.recordOfficeExecution(id, executor.id, { ...first, files: [{ fileId: randomUUID(), version: 1, sha256: file.sha256 }] }), 'OFFICE_EXECUTION_FILE_INVALID')
  const [one, same] = await Promise.all([office.recordOfficeExecution(id, executor.id, first), office.recordOfficeExecution(id, executor.id, first)])
  assert.deepEqual(one, same)
  assert.deepEqual(await office.resolveOfficeCommand(id, executor.id, { clientRequestId: first.clientRequestId }), { state: 'committed', receipt: one })
  assert.equal((await db.select().from(executions).where(eq(executions.requestId, id))).length, 1)
  assert.equal((await office.getOfficeExecutions(id, author.id)).hiddenRecords, 1)
  assert.equal((await office.getOfficeExecutions(id, author.id)).records.length, 0)
  assert.ok(!(await office.getOfficeRequest(id, author.id)).history.some(e => e.reason.includes(first.reason)))
  checks.push('real-original-id-version-hash-no-content-leak-same-command-exactly-once-recovery')
  await office.grantOfficeAttachment(id, fileId, executor.id, { clientRequestId: randomUUID(), expectedVersion: (await current()).lockVersion, reason: '显式共享执行原件查看权', grants: [{ userId: author.id, canDownload: false }] })
  assert.equal((await office.getOfficeExecutions(id, author.id)).records.length, 1)
  assert.deepEqual((await office.getOfficeAttachment(id, fileId, author.id)).bytes, bytes)
  await deny(office.getOfficeAttachment(id, fileId, author.id, true), 'OFFICE_FILE_FORBIDDEN')
  const authorFile = (await office.getOfficeRequest(id, author.id)).attachments.find(f => f.id === fileId)!
  assert.equal(authorFile.canManageGrants, false); assert.equal(authorFile.grants, undefined)
  assert.equal((await office.getOfficeRequest(id, executor.id)).attachments.find(f => f.id === fileId)!.canManageGrants, true)
  const previous = (await office.getOfficeExecutions(id, executor.id)).latestId!, retry = { ...await input('retry', previous), outcome: 'succeeded' }
  const races = await Promise.allSettled([office.recordOfficeExecution(id, executor.id, retry), office.recordOfficeExecution(id, executor.id, { ...retry, clientRequestId: randomUUID() })])
  assert.equal(races.filter(r => r.status === 'fulfilled').length, 1)
  const success = (await office.getOfficeExecutions(id, executor.id)).latestId!
  await deny(office.recordOfficeExecution(id, executor.id, await input('retry', success)), 'OFFICE_EXECUTION_INVALID')
  await office.recordOfficeExecution(id, executor.id, { ...await input('correct', success), reason: '更正人工录入结果，旧记录必须保留' })
  assert.equal((await db.select().from(executions).where(eq(executions.requestId, id))).length, 3)
  assert.equal((await db.select().from(links)).filter(link => link.fileId === fileId).length, 3)
  assert.equal((await current()).status, '已通过'); assert.deepEqual((await current()).businessPayload, approved.businessPayload)
  assert.equal((await current()).completedAt!.getTime(), approved.completedAt!.getTime())
  assert.deepEqual((await db.select().from(revisions).where(eq(revisions.requestId, id)))[0], frozenRevision)
  for (const action of ['withdraw', 'delete']) await deny(office.actOnOfficeRequest(id, author.id, { clientRequestId: randomUUID(), expectedVersion: (await current()).lockVersion, action, reason: '不能抹掉已执行的历史' }))
  checks.push('concurrent-version-one-winner-success-no-retry-append-correction-approval-immutable')
  const last = (await office.getOfficeExecutions(id, executor.id)).latestId!, beforeFault = await current(), failure = await input('correct', last), faultId = randomUUID()
  await db.insert(events).values({ id: faultId, requestId: id, commandId: randomUUID(), commandHash: 'f'.repeat(64), version: beforeFault.lockVersion + 1, actorId: executor.id, action: 'fixture-fault', reason: '隔离后段事务失败夹具', snapshot: {} })
  await deny(office.recordOfficeExecution(id, executor.id, failure))
  assert.deepEqual(await current(), beforeFault); assert.equal((await db.select().from(executions).where(eq(executions.requestId, id))).length, 3)
  await db.delete(events).where(eq(events.id, faultId))
  assert.deepEqual(await office.resolveOfficeCommand(id, executor.id, { clientRequestId: failure.clientRequestId }), { state: 'not_applied' })
  await deny(office.recordOfficeExecution(id, executor.id, failure), 'OFFICE_COMMAND_CLOSED')
  checks.push('late-constraint-rolls-back-receipt-files-event-and-request-closed-command-cannot-commit')
  const { authRouter } = await import('../routes/auth.js'), { oaRouter } = await import('../routes/oa.js'), { requireAuth } = await import('../middleware/requireAuth.js'), { errorHandler } = await import('../middleware/errorHandler.js')
  let loseResponse = false
  const app = express(); app.use(express.json({ limit: '2mb' })); app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next)); app.use('/api/auth', authRouter)
  app.use((req, res, next) => { if (loseResponse && req.method === 'POST' && req.path.endsWith('/executions')) { loseResponse = false; const json = res.json.bind(res); res.json = body => res.statusCode < 400 ? json.call(res.status(502), { code: 'FIXTURE_RESPONSE_LOST' }) : json(body) }; next() })
  app.use('/api/oa', oaRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.AUTH_ALLOWED_ORIGINS = origin
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: executor.email, password }) }); assert.equal(login.status, 200)
  const cookies = login.headers.getSetCookie(), cookie = cookies.map(v => v.split(';')[0]).join('; '), csrf = decodeURIComponent(cookies.find(v => v.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length))
  const http = (suffix: string, body: unknown, extra = {}) => fetch(`${origin}/api/oa/office/requests/${id}/${suffix}`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: origin, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) })
  const authorLogin = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: author.email, password }) }); assert.equal(authorLogin.status, 200)
  const authorCookies = authorLogin.headers.getSetCookie(), authorCookie = authorCookies.map(v => v.split(';')[0]).join('; '), authorCsrf = decodeURIComponent(authorCookies.find(v => v.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length))
  const unchangedGrants = await db.select().from(grants).where(eq(grants.attachmentId, fileId)), unchangedRequest = await current()
  const authorDetail = await fetch(`${origin}/api/oa/office/requests/${id}`, { headers: { Cookie: authorCookie } }); assert.equal(authorDetail.status, 200)
  const authorHttpFile = (await authorDetail.json()).attachments.find((f: { id: string }) => f.id === fileId)
  assert.equal(authorHttpFile.canDownload, false); assert.equal(authorHttpFile.canManageGrants, false); assert.equal(Object.hasOwn(authorHttpFile, 'grants'), false)
  for (const replacement of [[{ userId: author.id, canDownload: true }], [{ userId: stranger.id, canDownload: true }], []]) {
    const response = await http(`attachments/${fileId}/grants`, { clientRequestId: randomUUID(), expectedVersion: unchangedRequest.lockVersion, reason: '仅查看申请人不得提权转授或清除授权', grants: replacement }, { Cookie: authorCookie, 'X-CSRF-Token': authorCsrf })
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'OFFICE_ATTACHMENT_GRANT_FORBIDDEN')
    assert.deepEqual(await db.select().from(grants).where(eq(grants.attachmentId, fileId)), unchangedGrants)
    assert.deepEqual(await current(), unchangedRequest)
  }
  assert.equal((await fetch(`${origin}/api/oa/office/requests/${id}/attachments/${fileId}/download`, { headers: { Cookie: authorCookie } })).status, 403)
  checks.push('http-read-only-applicant-cannot-upgrade-download-regrant-or-delete-execution-acl-no-mutation')
  const httpInput = await input('correct', last)
  assert.equal((await http('executions', httpInput, { Cookie: '' })).status, 401)
  assert.equal((await http('executions', httpInput, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await http('executions', httpInput, { Origin: 'https://untrusted.invalid' })).status, 403)
  loseResponse = true; assert.equal((await http('executions', httpInput)).status, 502)
  const recovered = await http('commands/resolve', { clientRequestId: httpInput.clientRequestId }); assert.equal(recovered.status, 200)
  assert.equal((await recovered.json()).state, 'committed'); assert.equal((await http('executions', httpInput)).status, 200)
  assert.equal((await db.select().from(events).where(eq(events.commandId, httpInput.clientRequestId))).length, 1)
  checks.push('real-http-auth-csrf-origin-and-postcommit-response-loss-original-command-recovery')
  await db.delete(userRoles).where(and(eq(userRoles.userId, executor.id), eq(userRoles.roleId, financeRole)))
  await deny(office.getOfficeExecutions(id, executor.id)); await deny(office.recordOfficeExecution(id, executor.id, await input('correct', last)))
  assert.equal((await office.resolveOfficeCommand(id, executor.id, { clientRequestId: httpInput.clientRequestId })).state, 'committed')
  checks.push('revoked-role-denies-content-and-new-write-own-minimal-receipt-remains')
  console.log(JSON.stringify({ ok: true, suite: 'fde-office-execution', checks: checks.length, details: checks }))
} finally { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }; await pool.end() }
