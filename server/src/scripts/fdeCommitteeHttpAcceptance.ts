import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express from 'express'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'
import { committeeCommand, committeeEditorAccessQuery, committeeReceipt } from '../contracts/fdeCommitteeContract.js'

assertIsolatedMysqlAcceptanceDatabase('fdeCommitteeHttpAcceptance')
assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
process.env.AUTH_COOKIE_SECURE = 'false'; process.env.AUTH_COOKIE_DOMAIN = ''; process.env.AUTH_ALLOW_LEGACY_BEARER = 'false'
process.env.JWT_SECRET = randomUUID() + randomUUID()
const { db, pool } = await import('../db/client.js')
const { users, projects, todos, auditLogs, meetings, committeeMeetings, committeeAgendas, committeeFiles, committeeCommands, meetingWorkflowEvents, meetingWorkflowNotices, projectFileGrants, projectFileVersions, oaApprovalRequests } = await import('../db/schema.js')
const { identityRepositories } = await import('../repositories/index.js')
const { hashNewPassword } = await import('../security/passwordPolicy.js')
const { seedCommitteeBrowser } = await import('./fdeCommitteeBrowserFixture.js')
const { getCommittee } = await import('../services/fdeCommitteeService.js')
const { authRouter } = await import('../routes/auth.js')
const { committeeRouter } = await import('../routes/committee.js')
const { requireAuth } = await import('../middleware/requireAuth.js')
const { errorHandler } = await import('../middleware/errorHandler.js')
const checks: string[] = [], marker = randomUUID().slice(0, 8), faults: Array<'after' | 'before'> = []
let server: Server | undefined
type Session = { cookie: string; csrf: string }
try {
  const password = `Committee-Fixture-${randomUUID()}!`, passwordHash = await hashNewPassword(password)
  const people = ['投资经理', '投资经理', '投资经理', '系统管理员'].map((role, i) => ({ id: randomUUID(), role, name: `投决HTTP-${marker}-${i}`, email: `committee-http-${marker}-${i}@example.invalid`, department: `投决HTTP-${marker}`, passwordHash }))
  const [owner, member, other, admin] = people
  await db.insert(users).values(people)
  for (const user of people) await identityRepositories.users.synchronizeAdministrationBindings(user.id, user.role, user.department)
  const fixture = await seedCommitteeBrowser(owner, member, other), meetingId = fixture.meetingId
  const app = express(); app.use(express.json())
  app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next))
  app.use('/api/auth', authRouter)
  app.use((req, res, next) => {
    if (req.method !== 'POST' || req.path !== '/api/committee/commands' || !faults.length) { next(); return }
    const fault = faults.shift(), body = { code: 'FIXTURE_RESPONSE_LOST', message: '隔离模拟响应丢失' }
    if (fault === 'before') { res.status(502).json(body); return }
    const json = res.json.bind(res); res.json = value => res.statusCode < 400 ? json.call(res.status(502), body) : json(value); next()
  })
  app.use('/api/committee', committeeRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.AUTH_ALLOWED_ORIGINS = base
  const request = (url: string, session?: Session, body?: unknown, extra: Record<string, string> = {}) => fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}), 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const login = async (email: string): Promise<Session> => {
    const res = await request('/api/auth/login', undefined, { email, password }); assert.equal(res.status, 200)
    const cookies = res.headers.getSetCookie(), cookie = cookies.map(row => row.split(';')[0]).join('; ')
    const csrf = decodeURIComponent(cookies.find(row => row.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length))
    assert.ok(cookies.some(row => row.startsWith('cybernaut_session=') && row.includes('HttpOnly')))
    return { cookie, csrf }
  }
  assert.equal((await request('/api/committee')).status, 401)
  const [ownerSession, memberSession, otherSession, adminSession] = await Promise.all(people.map(row => login(row.email)))
  const command = { action: 'schedule', commandId: randomUUID(), meetingId, expectedVersion: 1, reason: '真实登录会话确认投决会排期' }
  assert.equal((await request('/api/committee/commands', ownerSession, command, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await request('/api/committee/commands', ownerSession, command, { Origin: 'https://untrusted.invalid' })).status, 403)
  assert.equal((await request(`/api/committee/${meetingId}`, memberSession)).status, 404)
  assert.equal((await request(`/api/committee/${meetingId}`, adminSession)).status, 404)
  checks.push('FDE-IC/AUTH:real-session-http-only-cookie-csrf-origin-and-draft-administrator-boundary')
  faults.push('after')
  assert.equal((await request('/api/committee/commands', ownerSession, command)).status, 502)
  const resolve = () => request('/api/committee/commands/recover', ownerSession, { commandId: command.commandId })
  const resolution = await resolve(); assert.equal(resolution.status, 200); assert.equal(resolution.headers.get('cache-control'), 'private, no-store')
  const resolved = await resolution.json(); assert.equal(resolved.state, 'committed'); assert.equal(resolved.receipt.meetingId, meetingId)
  assert.deepEqual(Object.keys(resolved.receipt).sort(), ['action', 'commandId', 'meetingId', 'version'])
  assert.deepEqual(await (await resolve()).json(), resolved)
  assert.equal((await db.select().from(meetingWorkflowEvents).where(and(eq(meetingWorkflowEvents.meetingId, meetingId), eq(meetingWorkflowEvents.action, 'schedule')))).length, 1)
  const visible = await request(`/api/committee/${meetingId}`, memberSession); assert.equal(visible.status, 200); assert.equal(visible.headers.get('cache-control'), 'private, no-store')
  const detail = await visible.json(); assert.equal(detail.agendas.length, 1); assert.ok(!JSON.stringify(detail).includes(fixture.agendas[1].id))
  checks.push('FDE-REC-002:post-commit-response-loss-recovers-one-exact-minimal-receipt-and-one-schedule-event')
  const a = fixture.agendas[0], source = a.materials[0], url = `/api/committee/${meetingId}/agendas/${a.id}/files/${source.fileId}/1/preview`
  const preview = await request(url, memberSession); assert.equal(preview.status, 200)
  const bytes = Buffer.from(await preview.arrayBuffer())
  assert.equal(bytes.toString(), '投决甲项目页面验收原件，不包含真实客户数据。')
  assert.equal(preview.headers.get('x-content-sha256'), createHash('sha256').update(bytes).digest('hex'))
  assert.equal(preview.headers.get('x-file-version'), '1'); assert.equal(preview.headers.get('cache-control'), 'private, no-store')
  assert.equal(preview.headers.get('x-content-type-options'), 'nosniff'); assert.ok(preview.headers.get('content-security-policy')?.includes('sandbox'))
  assert.equal((await request(url, otherSession)).status, 404); assert.equal((await request(url, adminSession)).status, 404)
  assert.equal((await request(url.replace('/1/preview', '/2/preview'), memberSession)).status, 404)
  const [grant] = await db.select().from(projectFileGrants).where(and(eq(projectFileGrants.fileId, source.fileId), eq(projectFileGrants.userId, member.id)))
  await db.update(projectFileGrants).set({ canView: false, canDownload: false }).where(eq(projectFileGrants.id, grant.id))
  assert.equal((await request(url, memberSession)).status, 404)
  assert.equal((await request(`/api/committee/${meetingId}`, memberSession)).status, 404)
  await db.update(projectFileGrants).set({ canView: grant.canView, canDownload: grant.canDownload }).where(eq(projectFileGrants.id, grant.id))
  checks.push('FDE-IC-002/FILE:authenticated-exact-version-preview-real-bytes-sha-no-store-no-download-grant-and-source-revocation')
  const before = { ...command, action: 'cancel', commandId: randomUUID(), expectedVersion: 2 }
  faults.push('before'); assert.equal((await request('/api/committee/commands', ownerSession, before)).status, 502)
  assert.deepEqual(await (await request('/api/committee/commands/recover', ownerSession, { commandId: before.commandId })).json(), { state: 'not_committed', receipt: null })
  const delayed = await request('/api/committee/commands', ownerSession, before); assert.equal(delayed.status, 409); assert.equal((await delayed.json()).code, 'COMMITTEE_COMMAND_CLOSED')
  assert.equal((await getCommittee(owner.id, meetingId)).status, 'scheduled')
  assert.deepEqual(await (await request('/api/committee/commands/recover', otherSession, { commandId: command.commandId })).json(), { state: 'not_committed', receipt: null })
  assert.equal((await db.select().from(committeeCommands).where(and(eq(committeeCommands.actorId, owner.id), eq(committeeCommands.commandId, before.commandId)))).length, 1)
  checks.push('FDE-REC-002:pre-commit-loss-fences-delayed-command-without-mutating-meeting-or-returning-another-actor-receipt')

  // New coverage-only batch: these HTTP/SQL cases require a separately approved
  // dedicated database. Type checking this file does not execute these cases.
  type PageInfo = { total: number; page: number; pageSize: number; hasMore: boolean }
  type HistoryPage = PageInfo & { rows: Array<{ id: string; version: number; action: string; reason: string }> }
  type OptionsPage = { projectId: string; people: Array<{ id: string; name: string }>; files: Array<{ fileId: string; version: number }>; approvals: Array<{ id: string }>; pagination: Record<string, PageInfo> }
  type EditorReply = { allowed: true; version: number | null; writable: boolean }
  const json = async <T>(work: Promise<Response>): Promise<T> => {
    const response = await work
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    return await response.json() as T
  }
  const rejected = async (work: Promise<Response>, status: number, code?: string) => {
    const response = await work, body = await response.json() as Record<string, unknown>
    assert.equal(response.status, status)
    if (code) assert.equal(body.code, code)
    for (const key of ['total', 'rows', 'people', 'files', 'approvals', 'version', 'receipt']) assert.equal(key in body, false, `denial must not disclose ${key}`)
    assert.ok(!JSON.stringify(body).includes(fixture.agendas[1].title), 'denial must not include the other agenda')
  }
  const historyUrl = `/api/committee/${meetingId}/history`
  const optionsUrl = (kind: string, query: Record<string, string> = {}) => `/api/committee/options?${new URLSearchParams({ projectId: a.projectId, kind, ...query })}`
  const readOnlyState = async () => ({
    meeting: await db.select().from(meetings).where(eq(meetings.id, meetingId)),
    head: await db.select().from(committeeMeetings).where(eq(committeeMeetings.meetingId, meetingId)),
    agendas: await db.select().from(committeeAgendas).where(eq(committeeAgendas.meetingId, meetingId)).orderBy(asc(committeeAgendas.id)),
    files: await db.select().from(committeeFiles).where(inArray(committeeFiles.agendaId, fixture.agendas.map(row => row.id))).orderBy(asc(committeeFiles.id)),
    commands: await db.select().from(committeeCommands).where(inArray(committeeCommands.actorId, people.map(row => row.id))).orderBy(asc(committeeCommands.id)),
    events: await db.select().from(meetingWorkflowEvents).where(eq(meetingWorkflowEvents.meetingId, meetingId)).orderBy(asc(meetingWorkflowEvents.id)),
    notices: await db.select().from(meetingWorkflowNotices).where(eq(meetingWorkflowNotices.meetingId, meetingId)).orderBy(asc(meetingWorkflowNotices.id)),
    audits: await db.select().from(auditLogs).where(and(inArray(auditLogs.userId, people.map(row => row.id)), eq(auditLogs.module, '投决会'))).orderBy(asc(auditLogs.id)),
  })
  const editorRequest = committeeEditorAccessQuery.parse({ action: 'record', meetingId, agendaId: a.id, projectIds: [a.projectId],
    files: [{ projectId: a.projectId, ...source }], participants: [{ projectId: a.projectId, userId: member.id }] })
  const beforeReads = await readOnlyState()
  const history1 = await json<HistoryPage>(request(`${historyUrl}?pageSize=1`, ownerSession))
  const history2 = await json<HistoryPage>(request(`${historyUrl}?pageSize=1&page=2`, ownerSession))
  assert.equal(history1.total, history2.total); assert.ok(history1.total >= 2)
  assert.equal(history1.rows.length, 1); assert.equal(history2.rows.length, 1)
  assert.notEqual(history1.rows[0].id, history2.rows[0].id); assert.ok(history1.rows[0].version > history2.rows[0].version)
  const emptyHistory = await json<HistoryPage>(request(`${historyUrl}?q=%25`, ownerSession))
  assert.equal(emptyHistory.total, 0); assert.deepEqual(emptyHistory.rows, [])
  const lastHistory = await json<HistoryPage>(request(`${historyUrl}?pageSize=1&page=100000`, ownerSession))
  assert.equal(lastHistory.page, history1.total); assert.equal(lastHistory.hasMore, false)
  await rejected(request(historyUrl), 401)
  for (const deniedSession of [memberSession, otherSession, adminSession]) await rejected(request(historyUrl, deniedSession), 403, 'COMMITTEE_HISTORY_FORBIDDEN')
  await rejected(request(`${historyUrl}?pageSize=51`, ownerSession), 400, 'INVALID_ARGUMENT')
  for (const kind of ['people', 'files', 'approvals']) {
    const page = await json<OptionsPage>(request(optionsUrl(kind, { pageSize: '1' }), ownerSession))
    assert.equal(page.projectId, a.projectId); assert.equal(page.pagination[kind].pageSize, 1)
    assert.ok(page.pagination[kind].total > 0)
    await rejected(request(optionsUrl(kind), memberSession), 403, 'COMMITTEE_PROJECT_FORBIDDEN')
    await rejected(request(optionsUrl(kind), adminSession), 403, 'COMMITTEE_PROJECT_FORBIDDEN')
    await rejected(request(optionsUrl(kind)), 401)
  }
  const members = await json<OptionsPage>(request(optionsUrl('people', { q: member.name }), ownerSession))
  assert.deepEqual(members.people.map(row => row.id), [member.id]); assert.equal(members.pagination.people.total, 1)
  const originals = await json<OptionsPage>(request(optionsUrl('files'), ownerSession))
  assert.ok(originals.files.some(row => row.fileId === source.fileId && row.version === source.version))
  assert.ok(originals.files.every(row => row.fileId !== fixture.agendas[1].materials[0].fileId))
  const emptyFiles = await json<OptionsPage>(request(optionsUrl('files', { q: '%' }), ownerSession))
  assert.equal(emptyFiles.pagination.files.total, 0); assert.deepEqual(emptyFiles.files, [])
  await rejected(request('/api/committee/options?kind=files', ownerSession), 400, 'INVALID_ARGUMENT')
  checks.push('FDE-IC/HTTP-PAGE:authorized-history-and-candidate-counts-search-clamping-no-cross-project-or-denial-count-leaks')

  assert.deepEqual(await json<EditorReply>(request('/api/committee/editor-access', ownerSession, editorRequest)), { allowed: true, version: 2, writable: true })
  assert.deepEqual(await json<EditorReply>(request('/api/committee/editor-access', ownerSession, editorRequest)), { allowed: true, version: 2, writable: true })
  await rejected(request('/api/committee/editor-access', undefined, editorRequest), 401)
  await rejected(request('/api/committee/editor-access', memberSession, editorRequest), 403, 'COMMITTEE_PROJECT_FORBIDDEN')
  await rejected(request('/api/committee/editor-access', adminSession, editorRequest), 403, 'COMMITTEE_EDITOR_FORBIDDEN')
  await rejected(request('/api/committee/editor-access', ownerSession, editorRequest, { 'X-CSRF-Token': '' }), 403)
  await rejected(request('/api/committee/editor-access', ownerSession, editorRequest, { Origin: 'https://untrusted.invalid' }), 403)
  await rejected(request('/api/committee/editor-access', ownerSession, { ...editorRequest, minutes: '未保存正文不得进入权限核对' }), 400, 'INVALID_ARGUMENT')
  await rejected(request('/api/committee/editor-access', ownerSession, { ...editorRequest, agendaId: randomUUID() }), 403, 'COMMITTEE_EDITOR_FORBIDDEN')
  await rejected(request('/api/committee/editor-access', ownerSession, { ...editorRequest, files: [{ projectId: a.projectId, ...fixture.agendas[1].materials[0] }] }), 403, 'COMMITTEE_EDITOR_FORBIDDEN')
  await rejected(request('/api/committee/editor-access', ownerSession, { ...editorRequest, files: [{ projectId: a.projectId, ...source, version: 99999 }] }), 403, 'COMMITTEE_EDITOR_FORBIDDEN')
  await rejected(request('/api/committee/editor-access', ownerSession, { ...editorRequest, participants: [{ projectId: a.projectId, userId: other.id }] }), 403, 'COMMITTEE_PROJECT_FORBIDDEN')
  assert.deepEqual(await readOnlyState(), beforeReads, 'read/search/revalidation and their denials must not write business state, audit or command fences')
  checks.push('FDE-IC/HTTP-EDITOR:real-session-csrf-origin-source-scope-minimal-reply-and-select-only-business-snapshot')

  const [ownerGrant] = await db.select().from(projectFileGrants).where(and(eq(projectFileGrants.fileId, source.fileId), eq(projectFileGrants.userId, owner.id)))
  assert.ok(ownerGrant?.canView)
  await db.update(projectFileGrants).set({ canView: false, canDownload: false }).where(eq(projectFileGrants.id, ownerGrant.id))
  try {
    await rejected(request('/api/committee/editor-access', ownerSession, editorRequest), 403, 'COMMITTEE_EDITOR_FORBIDDEN')
    await rejected(request(historyUrl, ownerSession), 403, 'COMMITTEE_HISTORY_FORBIDDEN')
    const afterRevoke = await json<OptionsPage>(request(optionsUrl('files'), ownerSession))
    assert.equal(afterRevoke.pagination.files.total, 0); assert.deepEqual(afterRevoke.files, [])
  } finally {
    await db.update(projectFileGrants).set({ canView: ownerGrant.canView, canDownload: ownerGrant.canDownload }).where(eq(projectFileGrants.id, ownerGrant.id))
  }
  assert.deepEqual(await readOnlyState(), beforeReads)
  assert.deepEqual(await json<EditorReply>(request('/api/committee/editor-access', ownerSession, editorRequest)), { allowed: true, version: 2, writable: true })
  const currentCommand = async (action: string, fields: Record<string, unknown> = {}) => committeeCommand.parse({ commandId: randomUUID(), meetingId, expectedVersion: (await getCommittee(owner.id, meetingId)).version, action, reason: '认证接口办理与固定版本验收', ...fields })
  await json(request('/api/committee/commands', ownerSession, await currentCommand('check_materials')))
  assert.deepEqual(await json<EditorReply>(request('/api/committee/editor-access', ownerSession, editorRequest)), { allowed: true, version: 3, writable: true })
  const oldRecord = { action: 'record', commandId: randomUUID(), meetingId, expectedVersion: 2, agendaId: a.id, minutes: '旧表单输入不得静默套用新版本', minutesFile: source, resolutionNote: '', resolutionFile: null, approvalId: null, reason: '拒绝旧版本表单提交' }
  const beforeOldForm = await readOnlyState()
  await rejected(request('/api/committee/commands', ownerSession, oldRecord), 409, 'VERSION_CONFLICT')
  assert.deepEqual(await readOnlyState(), beforeOldForm)
  checks.push('FDE-IC/HTTP-FOCUS:original-file-revocation-hides-history-count-and-editor-restore-returns-new-version-stale-command-rejected')

  const projectIds = fixture.agendas.map(row => row.projectId)
  const businessState = async () => ({ projects: await db.select().from(projects).where(inArray(projects.id, projectIds)).orderBy(asc(projects.id)), tasks: await db.select().from(todos).where(inArray(todos.projectId, projectIds)).orderBy(asc(todos.id)) })
  const originalBusiness = await businessState()
  for (const agenda of fixture.agendas) await json(request('/api/committee/commands', ownerSession, await currentCommand('record', {
    agendaId: agenda.id, minutes: `仅供认证接口验收的人工纪要-${agenda.id}`, minutesFile: agenda.materials[0], resolutionNote: '', resolutionFile: null, approvalId: null,
  })))
  await json(request('/api/committee/commands', ownerSession, await currentCommand('complete')))
  const confirmed = await readOnlyState()
  assert.equal(confirmed.meeting[0].workflowStatus, 'completed')
  assert.deepEqual(await json<EditorReply>(request('/api/committee/editor-access', ownerSession, editorRequest)), { allowed: true, version: confirmed.meeting[0].version, writable: false })
  const appendAccess = { ...editorRequest, action: 'link_decision' }
  assert.deepEqual(await json<EditorReply>(request('/api/committee/editor-access', ownerSession, appendAccess)), { allowed: true, version: confirmed.meeting[0].version, writable: true })
  // Synthetic approval transitions below are fixture preparation, NOT a claim
  // that the real investment approval workflow has been exercised end-to-end.
  const lateApprovals = fixture.agendas.map(agenda => ({ id: randomUUID(), agenda }))
  for (const { id, agenda } of lateApprovals) await db.insert(oaApprovalRequests).values({ id, requestNo: `IC-${id}`, projectId: agenda.projectId, projectName: agenda.title,
    title: `会后批准-${marker}-${agenda.title}`, type: '投决审批', businessType: 'project_stage', fromStage: '投决', targetStage: '打款', status: '审批中',
    applicantUserId: owner.id, applicantName: owner.name, department: owner.department, currentNodeName: '待独立审批', reason: '合成正式审批来源，仅验证会议关联合同，不冒充审批流程验收', completedAt: null,
    materialSnapshot: [{ requirementKey: 'http-late', fileId: agenda.materials[0].fileId, fileVersion: agenda.materials[0].version, waiverReason: null }] })
  const lateQuery = optionsUrl('approvals', { q: `会后批准-${marker}`, pageSize: '1' })
  const beforeApproval = await json<OptionsPage>(request(lateQuery, ownerSession))
  assert.equal(beforeApproval.pagination.approvals.total, 0); assert.deepEqual(beforeApproval.approvals, [])
  const linkA = await currentCommand('link_decision', { agendaId: a.id, approvalId: lateApprovals[0].id, resolutionFile: source })
  await rejected(request('/api/committee/commands', ownerSession, linkA), 409, 'COMMITTEE_APPROVAL_REQUIRED')
  assert.deepEqual(await readOnlyState(), confirmed)
  await db.update(oaApprovalRequests).set({ status: '已通过', completedAt: new Date(), currentNodeName: '已完成' }).where(inArray(oaApprovalRequests.id, lateApprovals.map(row => row.id)))
  const approved = await db.select().from(oaApprovalRequests).where(inArray(oaApprovalRequests.id, lateApprovals.map(row => row.id))).orderBy(asc(oaApprovalRequests.id))
  const afterApproval = await json<OptionsPage>(request(lateQuery, ownerSession))
  assert.equal(afterApproval.pagination.approvals.total, 1); assert.deepEqual(afterApproval.approvals.map(row => row.id), [lateApprovals[0].id])
  await rejected(request('/api/committee/commands', undefined, linkA), 401)
  await rejected(request('/api/committee/commands', ownerSession, linkA, { 'X-CSRF-Token': '' }), 403)
  await rejected(request('/api/committee/commands', ownerSession, linkA, { Origin: 'https://untrusted.invalid' }), 403)
  await rejected(request('/api/committee/commands', memberSession, linkA), 403, 'COMMITTEE_PROJECT_FORBIDDEN')
  await rejected(request('/api/committee/commands', ownerSession, { ...linkA, approvalId: lateApprovals[1].id }), 409, 'COMMITTEE_APPROVAL_REQUIRED')
  await rejected(request('/api/committee/commands', ownerSession, { ...linkA, resolutionFile: fixture.agendas[1].materials[0] }), 409, 'COMMITTEE_FILE_PROJECT')
  await rejected(request('/api/committee/commands', ownerSession, { ...linkA, minutes: '不能通过追加更改已确认纪要' }), 400, 'INVALID_ARGUMENT')
  const [originalRevision] = await db.select().from(projectFileVersions).where(and(eq(projectFileVersions.fileId, source.fileId), eq(projectFileVersions.version, source.version)))
  assert.ok(originalRevision?.sha256)
  await db.update(projectFileVersions).set({ sha256: '0'.repeat(64) }).where(eq(projectFileVersions.id, originalRevision.id))
  try { await rejected(request('/api/committee/commands', ownerSession, linkA), 409, 'COMMITTEE_FILE_INTEGRITY') }
  finally { await db.update(projectFileVersions).set({ sha256: originalRevision.sha256 }).where(eq(projectFileVersions.id, originalRevision.id)) }
  assert.deepEqual(await readOnlyState(), confirmed, 'rejected append cannot commit a fence, partial file link or changed minutes')
  checks.push('FDE-IC/HTTP-LINK-GUARD:pending-not-candidate-formal-approval-source-csrf-cross-project-file-hash-and-no-minutes-overwrite')

  faults.push('after')
  assert.equal((await request('/api/committee/commands', ownerSession, linkA)).status, 502)
  const recoveredA = await json<{ state: string; receipt: unknown }>(request('/api/committee/commands/recover', ownerSession, { commandId: linkA.commandId }))
  assert.equal(recoveredA.state, 'committed')
  const receiptA = committeeReceipt.parse(recoveredA.receipt)
  assert.equal(receiptA.action, 'link_decision'); assert.equal(receiptA.version, confirmed.meeting[0].version + 1)
  assert.deepEqual(await json(request('/api/committee/commands', ownerSession, linkA)), receiptA)
  await rejected(request('/api/committee/commands', ownerSession, { ...linkA, reason: '同请求号不同内容不能重新办理' }), 409, 'COMMITTEE_COMMAND_REUSED')
  const linkB = await currentCommand('link_decision', { agendaId: fixture.agendas[1].id, approvalId: lateApprovals[1].id, resolutionFile: fixture.agendas[1].materials[0] })
  const competitors = [linkB, { ...linkB, commandId: randomUUID() }]
  const raced = await Promise.all(competitors.map(async body => { const response = await request('/api/committee/commands', ownerSession, body); return { commandId: body.commandId, status: response.status, body: await response.json() } }))
  assert.deepEqual(raced.map(row => row.status).sort(), [200, 409])
  const winner = raced.find(row => row.status === 200)!, loser = raced.find(row => row.status === 409)!
  assert.equal(loser.body.code, 'VERSION_CONFLICT')
  const receiptB = committeeReceipt.parse(winner.body)
  assert.equal(receiptB.commandId, winner.commandId); assert.equal(receiptB.version, receiptA.version + 1)
  const recoverB = await json<{ state: string; receipt: unknown }>(request('/api/committee/commands/recover', ownerSession, { commandId: winner.commandId }))
  assert.equal(recoverB.state, 'committed'); assert.deepEqual(recoverB.receipt, receiptB)
  const linked = await readOnlyState()
  for (const original of confirmed.agendas) {
    const row = linked.agendas.find(row => row.id === original.id)!
    assert.deepEqual({ ...row, approvalId: original.approvalId }, original)
    assert.equal(row.approvalId, lateApprovals.find(candidate => candidate.agenda.id === original.id)!.id)
  }
  for (const original of confirmed.files) assert.deepEqual(linked.files.find(row => row.id === original.id), original)
  assert.equal(linked.files.length, confirmed.files.length + 4)
  assert.deepEqual({ ...linked.meeting[0], version: confirmed.meeting[0].version }, confirmed.meeting[0]); assert.deepEqual(linked.head, confirmed.head)
  assert.equal(linked.events.filter(row => row.action === 'link_decision').length, 2)
  assert.deepEqual(await businessState(), originalBusiness)
  assert.deepEqual(await db.select().from(oaApprovalRequests).where(inArray(oaApprovalRequests.id, lateApprovals.map(row => row.id))).orderBy(asc(oaApprovalRequests.id)), approved)
  await rejected(request('/api/committee/commands', ownerSession, { ...linkA, commandId: randomUUID(), expectedVersion: receiptB.version }), 409, 'COMMITTEE_DECISION_LINK_STATE')
  assert.deepEqual(await readOnlyState(), linked)
  checks.push('FDE-IC/HTTP-LINK-RECOVERY:post-commit-loss-idempotency-two-command-race-one-winner-minutes-confirmation-original-links-and-business-retained')

  await json(request('/api/committee/commands', ownerSession, await currentCommand('archive')))
  const archived = await readOnlyState()
  assert.ok(archived.head[0].archivedAt)
  assert.deepEqual(await json<EditorReply>(request('/api/committee/editor-access', ownerSession, appendAccess)), { allowed: true, version: archived.meeting[0].version, writable: false })
  await rejected(request('/api/committee/commands', ownerSession, { ...linkA, commandId: randomUUID(), expectedVersion: archived.meeting[0].version }), 409, 'COMMITTEE_ARCHIVED')
  assert.deepEqual(await readOnlyState(), archived)
  const archivedHistory = await json<HistoryPage>(request(`${historyUrl}?pageSize=2`, ownerSession))
  assert.equal(archivedHistory.total, archived.events.length); assert.equal(archivedHistory.rows[0].action, 'archive')
  assert.deepEqual(await businessState(), originalBusiness)
  checks.push('FDE-IC/HTTP-ARCHIVE:append-remains-readonly-after-archive-history-retained-no-project-or-task-mutation')
  assert.equal((await request('/api/auth/logout', memberSession, {})).status, 200)
  assert.equal((await request(url, memberSession)).status, 401)
  await rejected(request(historyUrl, memberSession), 401)
  await rejected(request('/api/committee/editor-access', memberSession, editorRequest), 401)
  await db.update(users).set({ status: '停用' }).where(eq(users.id, owner.id))
  assert.equal((await resolve()).status, 401)
  await rejected(request(historyUrl, ownerSession), 401)
  await rejected(request(optionsUrl('files'), ownerSession), 401)
  await rejected(request('/api/committee/editor-access', ownerSession, appendAccess), 401)
  assert.equal((await db.select().from(projects).where(eq(projects.id, a.projectId)))[0].stage, '立项')
  checks.push('FDE-AUTH-003:revoked-session-disabled-account-denied-and-meeting-never-advances-investment-stage')
  console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, suite: 'fde-committee-authenticated-http', passed: checks.length, checks }))
} finally {
  if (server) { server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())) }
  await pool.end()
}
