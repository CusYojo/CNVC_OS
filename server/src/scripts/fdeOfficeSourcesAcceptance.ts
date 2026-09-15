import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { and, eq, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { users, userRoles, projects, projectMembers, oaApprovalRequests as requests, oaApprovalNodes as nodes, oaOfficeEvents as events, personalWeeklyReports, personalWeeklyReportEvents, auditLogs } from '../db/schema.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { identityRepositories } from '../repositories/index.js'
import { officeKinds } from '../contracts/fdeOfficeContract.js'
import { shanghaiToday, weekStartFor, shiftDate } from '../contracts/fdeWeeklyPlanContract.js'
import { saveOfficePolicy, publishOfficePolicy, listOfficePolicies } from '../services/fdeOfficePolicyService.js'
import { saveOfficeRequest, previewOfficeRequest, actOnOfficeRequest, getOfficeRequest, uploadOfficeAttachment, grantOfficeAttachment } from '../services/fdeOfficeService.js'
import { listCalendar } from '../services/fdeCalendarService.js'
import { createWeeklyReport, collectWeeklyReportFacts, listWeeklyReports, actOnWeeklyReport, weeklyReportRecipients, readWeeklyReport } from '../services/fdeWeeklyReportService.js'
import { canReadOfficeSnapshot, readableOfficeSource } from '../services/fdeOfficeSourcesService.js'
import { createProject } from '../services/projectService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
const marker = randomUUID().slice(0, 8), week = weekStartFor(shanghaiToday()), checks: string[] = []
const denied = async (work: Promise<unknown>, code: string) => { const error = await work.then(() => null, e => e); assert.equal(error?.code, code, error?.message ?? 'unexpected success') }
let server: Server | undefined
try {
  const people = ['系统管理员', '投资经理', '财务', '财务', '投资经理'].map((role, i) => ({ id: randomUUID(), name: `办公来源-${marker}-${i === 4 ? 1 : i}`, email: `office-source-${marker}-${i}@example.invalid`, role, department: `来源-${marker}`, passwordHash: 'not-for-login' }))
  const [admin, author, reviewer, traveler, outsider] = people
  await db.insert(users).values(people)
  for (const p of people) await identityRepositories.users.synchronizeAdministrationBindings(p.id, p.role, p.department)
  const officeProject = await createProject({ name: `办公来源关联项目-${marker}`, owner: author.name, ownerUserId: author.id }, author.id)
  await db.insert(projectMembers).values({ projectId: officeProject.id, userId: reviewer.id, memberRole: 'collaborator', sourceName: reviewer.name })
  const role = (await db.select().from(userRoles).where(eq(userRoles.userId, reviewer.id)))[0].roleId
  for (const kind of officeKinds) {
    const id = randomUUID(), saved = await saveOfficePolicy(id, admin.id, { clientRequestId: randomUUID(), expectedVersion: 0, reason: '隔离办公来源政策，不是正式规则', configuration: { kind, requiredFields: [], attachmentRequired: false, rejectResubmission: true, routes: [{ key: 'default', when: {}, nodes: [{ key: 'finance', name: '独立财务审核', roleIds: [role], fixedUserIds: [reviewer.id], scope: 'institution', mode: '或签', allowTransfer: true }] }] } })
    const head = (await listOfficePolicies(admin.id)).find(p => p.id === saved.policyId)!
    await publishOfficePolicy(id, admin.id, { clientRequestId: randomUUID(), expectedVersion: saved.version, expectedPolicyVersion: head.version, reason: '发布隔离办公来源规则' })
  }
  const create = async (details: unknown, title: string, projectId: string | null = null) => {
    const id = randomUUID(), definition = { title: `${title}-${marker}`, reason: '敏感事由不能经日历或周报扩权泄露', projectId, priority: '普通' as const, attachmentIds: [], details }
    await saveOfficeRequest(id, author.id, { clientRequestId: randomUUID(), expectedVersion: 0, definition })
    if ((details as { kind?: string }).kind === '报销') {
      const attachmentId = randomUUID()
      await uploadOfficeAttachment(id, attachmentId, author.id, { clientRequestId: randomUUID(), expectedVersion: 1, name: '来源报销发票.pdf', dataBase64: Buffer.from('%PDF-1.4\n% isolated source fixture\n%%EOF').toString('base64'), purpose: 'application', reason: '准备来源报销材料' })
      await saveOfficeRequest(id, author.id, { clientRequestId: randomUUID(), expectedVersion: 2, definition: { ...definition, attachmentIds: [attachmentId], details: { kind: '报销', currency: 'CNY', amount: '10', projectExplanation: '隔离来源报销事项说明', items: [{ id: randomUUID(), date: shanghaiToday(), category: '其他', description: '隔离来源费用', amount: '10', invoiceNumber: `SRC-${marker}`, attachmentId }] } } })
    }
    return id
  }
  const act = async (id: string, uid: string, action: string) => { const preview = action === 'submit' ? await previewOfficeRequest(id, author.id) : null; return actOnOfficeRequest(id, uid, { clientRequestId: randomUUID(), expectedVersion: (await getOfficeRequest(id, author.id)).version, action, reason: '真实执行隔离审批决定', ...(preview ? { expectedPolicyVersionId: preview.policyVersionId, expectedRouteHash: preview.routeHash, confirmAttachmentSharing: true } : {}) }) }
  const travel = await create({ kind: '出差', travelerIds: [author.id, traveler.id], startDate: shiftDate(week, -1), endDate: week }, '跨周获批行程', officeProject.id)
  const leave = await create({ kind: '请假', startAt: `${shiftDate(week, 1)}T09:00`, endAt: `${shiftDate(week, 1)}T10:30` }, '私人请假')
  assert.ok(!(await listCalendar(author.id, week, 'personal')).items.some(i => i.id === travel || i.id === leave))
  await act(travel, author.id, 'submit'); await act(leave, author.id, 'submit')
  assert.ok(!(await listCalendar(author.id, week, 'personal')).items.some(i => i.id === travel || i.id === leave))
  await act(travel, reviewer.id, 'approve'); await act(leave, reviewer.id, 'approve')
  const beforeEvents = await db.select().from(events).where(eq(events.requestId, travel))
  const personal = await listCalendar(author.id, week, 'personal')
  assert.equal(personal.items.filter(i => i.source === 'office').length, 2)
  assert.equal(personal.items.find(i => i.id === travel)?.startsAt, `${shiftDate(week, -2)}T16:00:00.000Z`)
  assert.ok(personal.items.filter(i => i.source === 'office').every(i => !i.editable && i.target?.includes('/workflow?view=completed&office=') && i.detail.includes('不是实际执行证明')))
  const company = await listCalendar(reviewer.id, week, 'company'), travelRows = company.items.filter(i => i.id === travel)
  assert.equal(travelRows.length, 2); assert.equal(new Set(travelRows.map(i => i.key)).size, 2)
  assert.deepEqual(await db.select().from(events).where(eq(events.requestId, travel)), beforeEvents)
  checks.push('approved-only-cross-week-Shanghai-personal-company-multiple-travelers-read-only-original-links')
  for (const uid of [admin.id, outsider.id, traveler.id]) {
    const data = await listCalendar(uid, week, uid === traveler.id ? 'personal' : 'company')
    assert.ok(!JSON.stringify(data).includes(travel)); assert.ok(!JSON.stringify(data).includes(leave)); assert.ok(!JSON.stringify(data).includes('敏感事由不能经日历或周报扩权泄露'))
    assert.ok(!data.items.some(i => i.title.includes(marker))); assert.ok(data.items.some(i => i.source === 'busy' && !i.id && !i.target))
  }
  checks.push('same-name-outsider-admin-and-traveler-without-application-access-see-only-busy-no-auto-grant')
  const unprojected = await create({ kind: '出差' }, '缺少行程不可虚构', officeProject.id)
  await act(unprojected, author.id, 'submit'); await act(unprojected, reviewer.id, 'approve')
  assert.ok(!(await listCalendar(author.id, week, 'personal')).items.some(i => i.id === unprojected))
  const boundary = await create({ kind: '请假', startAt: `${shiftDate(week, -1)}T23:00`, endAt: `${week}T00:00` }, '边界外请假')
  await act(boundary, author.id, 'submit'); await act(boundary, reviewer.id, 'approve')
  assert.ok(!(await listCalendar(author.id, week, 'personal')).items.some(i => i.id === boundary))
  checks.push('missing-dates-and-half-open-boundary-not-fabricated-as-calendar-items')
  for (const kind of ['用印', '报销', '合同'] as const) { const id = await create({ kind }, kind); await act(id, author.id, 'submit'); await act(id, reviewer.id, 'approve') }
  const report = async (id: string) => (await listWeeklyReports(author.id, week)).reports.find(r => r.id === id)!
  const reportAct = async (id: string, action: string, recipientIds: string[] = []) => actOnWeeklyReport(id, author.id, { clientRequestId: randomUUID(), expectedVersion: (await report(id)).version, action, recipientIds, reason: '明确确认本次办公来源操作' })
  const makeReport = (office: boolean, calendar = true) => createWeeklyReport(author.id, { clientRequestId: randomUUID(), weekStart: week, projectIds: [officeProject.id], sourceOptions: { office, calendar } })
  const old = await makeReport(false)
  assert.equal((await report(old.reportId)).facts?.office, undefined)
  assert.ok(!(await report(old.reportId)).facts?.calendar?.some(i => i.source === 'office'))
  await reportAct(old.reportId, 'discard')
  const made = await makeReport(true), initial = await report(made.reportId)
  assert.deepEqual([...new Set(initial.facts!.office!.map(i => i.kind))].sort(), [...officeKinds].sort())
  assert.equal(initial.facts?.metrics.completedInWeek, 0); assert.equal(initial.facts?.metrics.approvalActions, 0)
  assert.ok(initial.body.includes('办公事项')); assert.ok(initial.facts?.calendar?.some(i => i.id === leave && i.source === 'office'))
  assert.ok(initial.facts?.office?.every(i => i.actions.every(a => a.action === '提交')))
  assert.ok((await weeklyReportRecipients(made.reportId, author.id)).recipients.some(p => p.id === reviewer.id))
  assert.ok(!(await weeklyReportRecipients(made.reportId, author.id)).recipients.some(p => [admin.id, traveler.id, outsider.id].some(id => id === p.id)))
  await denied(reportAct(made.reportId, 'publish', [outsider.id]), 'REPORT_SOURCE_FORBIDDEN')
  checks.push('explicit-office-selection-five-types-own-week-actions-not-completion-current-source-sharing')
  // A source change after preview invalidates publication even if all content remains readable.
  const returned = await create({ kind: '合同' }, '退回再提交')
  await act(returned, author.id, 'submit'); await act(returned, reviewer.id, 'return')
  assert.equal((await report(made.reportId)).sourceChanged, true)
  await denied(reportAct(made.reportId, 'publish', [reviewer.id]), 'REPORT_SOURCE_CHANGED')
  await reportAct(made.reportId, 'regenerate'); await reportAct(made.reportId, 'publish', [reviewer.id])
  assert.ok((await listWeeklyReports(reviewer.id, week)).reports.some(r => r.id === made.reportId))
  await readWeeklyReport(made.reportId, reviewer.id)
  const snap = (await report(made.reportId)).facts!.office!.find(i => i.id === travel)!
  const [travelNode] = await db.select().from(nodes).where(eq(nodes.requestId, travel))
  await db.update(nodes).set({ approverUserIds: [reviewer.id, traveler.id], approverNames: [reviewer.name, traveler.name] }).where(eq(nodes.id, travelNode.id))
  await db.insert(projectMembers).values({ projectId: officeProject.id, userId: traveler.id, memberRole: 'collaborator', sourceName: traveler.name })
  assert.ok(await readableOfficeSource(db, travel, traveler.id))
  assert.equal(await canReadOfficeSnapshot(db, snap, traveler.id), false)
  await db.update(nodes).set({ approverUserIds: travelNode.approverUserIds, approverNames: travelNode.approverNames }).where(eq(nodes.id, travelNode.id))
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, officeProject.id), eq(projectMembers.userId, traveler.id)))
  checks.push('source-change-blocks-publish-regeneration-and-frozen-audience-cannot-expand-after-new-grant')
  await db.delete(userRoles).where(eq(userRoles.userId, reviewer.id))
  assert.ok(!(await listWeeklyReports(reviewer.id, week)).reports.some(r => r.id === made.reportId))
  await denied(readWeeklyReport(made.reportId, reviewer.id), 'REPORT_SUPPLEMENT_SCOPE')
  await identityRepositories.users.synchronizeAdministrationBindings(reviewer.id, reviewer.role, reviewer.department)
  await db.delete(userRoles).where(eq(userRoles.userId, author.id))
  assert.equal((await report(made.reportId)).restricted, true); assert.equal((await report(made.reportId)).body, '')
  await reportAct(made.reportId, 'withdraw')
  await identityRepositories.users.synchronizeAdministrationBindings(author.id, author.role, author.department)
  checks.push('current-role-revocation-hides-published-content-and-author-can-withdraw-without-retrieving-body')
  await act(returned, author.id, 'submit')
  const current = await makeReport(true, false), currentRow = await report(current.reportId)
  assert.equal(currentRow.facts?.office?.find(i => i.id === returned)?.revision, 2)
  assert.equal(currentRow.facts?.office?.find(i => i.id === returned)?.actions.length, 1)
  await reportAct(current.reportId, 'discard')
  checks.push('resubmission-keeps-current-revision-and-does-not-relabel-old-revision-events')
  const faultId = randomUUID(), table = quoteMysqlIdentifier(mysqlTableName('personal_weekly_report_events')), constraint = `fixture_report_source_${marker}`
  const prior = await db.select().from(personalWeeklyReports).where(eq(personalWeeklyReports.authorId, author.id)), priorAudit = await db.select().from(auditLogs).where(eq(auditLogs.userId, author.id))
  await db.execute(sql.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (request_id <> '${faultId}')`))
  try { await assert.rejects(createWeeklyReport(author.id, { clientRequestId: faultId, weekStart: week, projectIds: [], sourceOptions: { office: true } })) }
  finally { await db.execute(sql.raw(`ALTER TABLE ${table} DROP CHECK ${constraint}`)) }
  assert.deepEqual(await db.select().from(personalWeeklyReports).where(eq(personalWeeklyReports.authorId, author.id)), prior)
  assert.deepEqual(await db.select().from(auditLogs).where(eq(auditLogs.userId, author.id)), priorAudit)
  assert.equal((await db.select().from(personalWeeklyReportEvents).where(eq(personalWeeklyReportEvents.requestId, faultId))).length, 0)
  checks.push('late-real-MySQL-failure-rolls-back-office-report-snapshot-and-event-audit')

  const projectId = randomUUID()
  await db.insert(projects).values({ id: projectId, name: `来源项目-${marker}`, owner: author.name, ownerUserId: author.id, workflowModel: 'fde-v1', createdBy: author.id })
  await db.insert(projectMembers).values([{ projectId, userId: author.id, memberRole: '负责人', sourceName: author.name }, { projectId, userId: reviewer.id, memberRole: '成员', sourceName: reviewer.name }])
  const projectRequest = await create({ kind: '请假', startAt: `${week}T13:00`, endAt: `${week}T14:00` }, '项目授权请假', projectId)
  await act(projectRequest, author.id, 'submit'); await act(projectRequest, reviewer.id, 'approve')
  assert.ok(!(await collectWeeklyReportFacts(db, author.id, [], week, { calendar: true, privateCalendar: false, independentWork: false, office: true })).office?.some(i => i.id === projectRequest))
  const withProject = await createWeeklyReport(author.id, { clientRequestId: randomUUID(), weekStart: week, projectIds: [projectId], sourceOptions: { office: true, calendar: true } })
  assert.ok((await report(withProject.reportId)).facts?.calendar?.some(i => i.id === projectRequest))
  await reportAct(withProject.reportId, 'publish', [reviewer.id])
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, reviewer.id)))
  assert.equal(await readableOfficeSource(db, projectRequest, reviewer.id), null)
  assert.ok(!(await listWeeklyReports(reviewer.id, week)).reports.some(r => r.id === withProject.reportId))
  checks.push('explicit-project-selection-and-current-project-revocation-protect-office-calendar-and-report')

  const attached = await create({ kind: '合同' }, '带受控原件的办公来源'), fileId = randomUUID()
  await uploadOfficeAttachment(attached, fileId, author.id, { clientRequestId: randomUUID(), expectedVersion: 1, name: '来源权限合成原件.txt', dataBase64: Buffer.from('合成原件不能经周报绕过权限').toString('base64'), reason: '记录真实申请级原始附件' })
  const attachedRow = await getOfficeRequest(attached, author.id)
  await saveOfficeRequest(attached, author.id, { clientRequestId: randomUUID(), expectedVersion: attachedRow.version, definition: { ...attachedRow.definition, attachmentIds: [fileId] } })
  await act(attached, author.id, 'submit'); await act(attached, reviewer.id, 'approve')
  const attachmentReport = await makeReport(true, false)
  await reportAct(attachmentReport.reportId, 'publish', [reviewer.id])
  await grantOfficeAttachment(attached, fileId, author.id, { clientRequestId: randomUUID(), expectedVersion: (await getOfficeRequest(attached, author.id)).version, reason: '明确撤回该原件查看授权', grants: [] })
  assert.ok(!(await listWeeklyReports(reviewer.id, week)).reports.some(r => r.id === attachmentReport.reportId))
  await denied(readWeeklyReport(attachmentReport.reportId, reviewer.id), 'REPORT_SUPPLEMENT_SCOPE')
  const reviewFacts = await collectWeeklyReportFacts(db, reviewer.id, [], week, { calendar: false, privateCalendar: false, independentWork: false, office: true })
  assert.ok(reviewFacts.office?.every(i => !i.actions.some(a => a.action === '提交')))
  assert.ok(!reviewFacts.office?.some(i => i.id === attached))
  checks.push('real-original-attachment-revocation-removes-published-report-and-approver-source-facts')

  process.env.AUTH_COOKIE_SECURE = 'false'; process.env.AUTH_COOKIE_DOMAIN = ''; process.env.AUTH_ALLOW_LEGACY_BEARER = 'false'; process.env.JWT_SECRET = randomUUID() + randomUUID()
  const password = `Office-Source-Fixture-${randomUUID()}!`, { hashNewPassword } = await import('../security/passwordPolicy.js')
  await db.update(users).set({ passwordHash: await hashNewPassword(password) }).where(eq(users.id, author.id))
  const { authRouter } = await import('../routes/auth.js'), { calendarRouter } = await import('../routes/fdeTime.js'), { weeklyReportsRouter } = await import('../routes/weeklyReports.js'), { requireAuth } = await import('../middleware/requireAuth.js'), { errorHandler } = await import('../middleware/errorHandler.js')
  const app = express(); app.use(express.json()); app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next)); app.use('/api/auth', authRouter); app.use('/api/calendar', calendarRouter); app.use('/api/weekly-reports', weeklyReportsRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.AUTH_ALLOWED_ORIGINS = origin
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: author.email, password }) }); assert.equal(login.status, 200)
  const cookies = login.headers.getSetCookie(), headers = { Cookie: cookies.map(v => v.split(';')[0]).join('; '), 'X-CSRF-Token': decodeURIComponent(cookies.find(v => v.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length)), 'Content-Type': 'application/json', Origin: origin }
  const url = `${origin}/api/weekly-reports`, input = { clientRequestId: randomUUID(), weekStart: week, projectIds: [], sourceOptions: { office: true } }
  const post = (body: unknown, extra = {}) => fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
  assert.equal((await fetch(`${origin}/api/calendar?weekStart=${week}`)).status, 401)
  const calendarHttp = await fetch(`${origin}/api/calendar?weekStart=${week}`, { headers }); assert.equal(calendarHttp.status, 200); assert.equal(calendarHttp.headers.get('cache-control'), 'private, no-store')
  assert.ok((await calendarHttp.json() as { items: Array<{ id: string }> }).items.some(i => i.id === leave))
  assert.equal((await post(input, { 'X-CSRF-Token': '' })).status, 403); assert.equal((await post(input, { Origin: 'https://foreign.invalid' })).status, 403)
  assert.equal((await post({ ...input, authorId: outsider.id })).status, 400)
  const created = await post(input); assert.equal(created.status, 201); assert.equal(created.headers.get('cache-control'), 'private, no-store')
  const replay = await post(input); assert.equal(replay.status, 201); assert.deepEqual(await replay.json(), await created.json())
  checks.push('real-session-CSRF-Origin-strict-input-private-no-store-and-idempotent-report-creation')
  console.log(JSON.stringify({ ok: true, suite: 'fde-office-sources', checks: checks.length, details: checks }))
} finally { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }; await pool.end() }
