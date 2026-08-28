import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express from 'express'
import { and, eq } from 'drizzle-orm'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
process.env.AUTH_COOKIE_SECURE = 'false'; process.env.AUTH_COOKIE_DOMAIN = ''; process.env.AUTH_ALLOW_LEGACY_BEARER = 'false'; process.env.JWT_SECRET = randomUUID() + randomUUID()
const { db, pool } = await import('../db/client.js')
const { users, projects, projectDutyAssignments, projectMembers, projectStageDates, personalWeeklyReports, todos } = await import('../db/schema.js')
const { identityRepositories } = await import('../repositories/index.js')
const { hashNewPassword } = await import('../security/passwordPolicy.js')
const { createProject } = await import('../services/projectService.js')
const { proposeFdeGovernance, decideFdeGovernance } = await import('../services/fdeGovernanceService.js')
const { runProjectAgent, getProjectAgent, decideProjectAgent } = await import('../services/fdeProjectAgentService.js')
const { submitAgentSchedule, actAgentSchedule } = await import('../services/fdeAgentScheduleService.js')
const { collectApprovedMilestones, canReadMilestoneSnapshot } = await import('../services/fdeMilestoneSourcesService.js')
const { listCalendar, writeCalendarEvent } = await import('../services/fdeCalendarService.js')
const { collectWeeklyReportFacts, createWeeklyReport, actOnWeeklyReport, listWeeklyReports, readWeeklyReport } = await import('../services/fdeWeeklyReportService.js')
const { shanghaiToday, shiftDate, weekStartFor } = await import('../contracts/fdeWeeklyPlanContract.js')
const checks: string[] = [], marker = randomUUID().slice(0, 8), today = shanghaiToday(), thisWeek = weekStartFor(today)
const password = `Milestone-Fixture-${randomUUID()}!`, passwordHash = await hashNewPassword(password)
const people = ['投资经理', '投资经理', '总裁', '投资经理', '系统管理员', '投资经理'].map((role, i) => ({ id: randomUUID(), role, name: `节点来源-${marker}-${i}`, department: `节点来源-${marker}`, email: `milestone-${marker}-${i}@example.invalid`, passwordHash }))
const [owner, secretary, president, outsider, admin, member] = people
const expectCode = async (promise: Promise<unknown>, code: string) => { const cause = await promise.then(() => null, error => error); assert.equal(cause?.code, code, cause?.message ?? 'unexpected success') }
const decide = (version: number, action = 'approve') => ({ clientRequestId: randomUUID(), expectedVersion: version, action, reason: '独立核验节点日期与来源范围' })
const options = { calendar: false, privateCalendar: false, independentWork: false }
let server: Server | undefined
try {
  await db.insert(users).values(people)
  for (const person of people) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
  const project = await createProject({ name: `节点来源项目-${marker}`, owner: owner.name, ownerUserId: owner.id, collaborators: [], targetDate: shiftDate(today, 80), cycleDays: 40 }, owner.id)
  const id = project.id
  const governance = await proposeFdeGovernance({ projectId: id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '隔离节点来源测试配置正式职责', assignments: [{ duty: 'secretary', userId: secretary.id }, { duty: 'president', userId: president.id }, { duty: 'member', userId: member.id }] })
  let gv = governance.version
  for (const userId of governance.requiredConfirmers) gv = (await decideFdeGovernance({ projectId: id, changeId: governance.id, userId, expectedVersion: gv, decision: 'confirm', comment: '真实确认隔离测试职责移交' })).version
  const snapshot = async () => ({ project: await db.select().from(projects).where(eq(projects.id, id)), dates: await db.select().from(projectStageDates).where(eq(projectStageDates.projectId, id)), tasks: await db.select().from(todos).where(eq(todos.projectId, id)) })
  const baseline = await snapshot()
  assert.deepEqual(await collectApprovedMilestones(db, owner.id, thisWeek, { projectIds: [id], report: true }), [])
  await listCalendar(owner.id, thisWeek, 'company', true); await listCalendar(owner.id, thisWeek, 'personal', true)
  assert.deepEqual(await snapshot(), baseline)
  checks.push('GET-readonly:no-projected-or-unapproved-date-no-task-generation')

  async function submitDate(date?: string) {
    await runProjectAgent(id, owner.id, { clientRequestId: randomUUID(), expectedConfigVersion: 0 })
    const rec = (await getProjectAgent(id, owner.id)).runs[0].recommendation!
    assert.ok(rec?.suggestedDate)
    await decideProjectAgent(id, rec.id, secretary.id, { clientRequestId: randomUUID(), expectedVersion: 1, decision: 'accepted' })
    const requestedDate = date ?? rec.suggestedDate!
    return { ...(await submitAgentSchedule(id, rec.id, owner.id, { clientRequestId: randomUUID(), expectedVersion: 2, requestedDate, reason: '申请真实节点改期以验证来源闭环' })), requestedDate }
  }
  const first = await submitDate(shiftDate(today, 20)), dateWeek = weekStartFor(first.requestedDate)
  assert.deepEqual(await collectApprovedMilestones(db, owner.id, dateWeek), [])
  assert.deepEqual(await collectApprovedMilestones(db, secretary.id, thisWeek, { projectIds: [id], report: true }), [])
  await actAgentSchedule(id, first.id, president.id, decide(1))
  const [milestone] = await collectApprovedMilestones(db, owner.id, dateWeek)
  assert.equal(milestone.approvalId, first.id); assert.equal(milestone.date, first.requestedDate)
  const calendar = await listCalendar(owner.id, dateWeek, 'personal', true), markerItem = calendar.items.find(row => row.source === 'milestone' && row.id === milestone.id)!
  assert.ok(markerItem); assert.equal(markerItem.allDay, true); assert.equal(markerItem.endsAt, null); assert.equal(markerItem.editable, false)
  assert.ok(markerItem.target?.includes(first.id)); assert.equal(calendar.items.filter(row => row.key === markerItem.key).length, 1)
  assert.equal((await listCalendar(owner.id, dateWeek, 'personal')).items.some(row => row.source === 'milestone'), false)
  assert.equal((await listCalendar(owner.id, shiftDate(dateWeek, -7), 'personal', true)).items.some(row => row.id === milestone.id), false)
  checks.push('real-final-approval:single-stable-readonly-date-marker-not-occupancy-opt-in-and-week-boundary')

  for (const person of [owner, secretary]) assert.equal((await collectApprovedMilestones(db, person.id, dateWeek, { personal: true })).length, 1)
  assert.equal((await collectApprovedMilestones(db, member.id, dateWeek, { personal: true })).length, 0)
  assert.equal((await collectApprovedMilestones(db, member.id, dateWeek)).length, 1)
  for (const person of [outsider, admin]) { assert.deepEqual(await collectApprovedMilestones(db, person.id, dateWeek), []); assert.equal((await listCalendar(person.id, dateWeek, 'company', true)).items.some(row => row.id === milestone.id), false) }
  const noWrites = await snapshot(); await collectApprovedMilestones(db, owner.id, dateWeek); await listCalendar(secretary.id, dateWeek, 'company', true); assert.deepEqual(await snapshot(), noWrites)
  checks.push('current-project-scope:owner-secretary-personal-member-company-no-admin-or-outsider-date-leak')

  const legacyFacts = await collectWeeklyReportFacts(db, secretary.id, [id], thisWeek, options)
  assert.equal('milestones' in legacyFacts, false); assert.equal('projectTimeline' in legacyFacts.sourceOptions!, false)
  const report = await createWeeklyReport(secretary.id, { clientRequestId: randomUUID(), weekStart: thisWeek, projectIds: [id], sourceOptions: { ...options, projectTimeline: true } })
  let [stored] = await db.select().from(personalWeeklyReports).where(eq(personalWeeklyReports.id, report.reportId))
  assert.equal(stored.facts.milestones?.length, 1); assert.equal(stored.facts.milestones?.[0].approvalId, first.id)
  assert.deepEqual(stored.facts.metrics, legacyFacts.metrics); assert.match(stored.body, /不计任务完成、不代表阶段通过/)
  await expectCode(actOnWeeklyReport(report.reportId, secretary.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'publish', recipientIds: [admin.id] }), 'REPORT_SOURCE_FORBIDDEN')
  await actOnWeeklyReport(report.reportId, secretary.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'publish', recipientIds: [owner.id] })
  ;[stored] = await db.select().from(personalWeeklyReports).where(eq(personalWeeklyReports.id, report.reportId))
  const frozen = structuredClone(stored)
  const draft = await createWeeklyReport(secretary.id, { clientRequestId: randomUUID(), weekStart: dateWeek, projectIds: [id], sourceOptions: { ...options, projectTimeline: true } })
  checks.push('explicit-report-source:approval-week-and-planned-week-no-task-metric-inflation-no-old-option-rewrite')

  const second = await submitDate()
  await actAgentSchedule(id, second.id, president.id, decide(1))
  const [changed] = await collectApprovedMilestones(db, secretary.id, thisWeek, { projectIds: [id], report: true })
  assert.equal(changed.id, milestone.id); assert.equal(changed.version, 2); assert.equal(changed.approvalId, second.id)
  assert.equal((await listWeeklyReports(secretary.id, dateWeek)).reports.find(row => row.id === draft.reportId)?.sourceChanged, true)
  await expectCode(actOnWeeklyReport(draft.reportId, secretary.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'publish' }), 'REPORT_SOURCE_CHANGED')
  assert.deepEqual((await db.select().from(personalWeeklyReports).where(eq(personalWeeklyReports.id, report.reportId)))[0], frozen)
  assert.equal(await canReadMilestoneSnapshot(db, milestone, owner.id), true)
  await readWeeklyReport(report.reportId, owner.id)
  const currentLegacy = await collectWeeklyReportFacts(db, secretary.id, [id], thisWeek, options)
  const { generatedAt: _a, ...beforeLegacy } = legacyFacts, { generatedAt: _b, ...afterLegacy } = currentLegacy
  assert.deepEqual(afterLegacy, beforeLegacy)
  await actOnWeeklyReport(draft.reportId, secretary.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'regenerate' })
  assert.equal((await listWeeklyReports(secretary.id, dateWeek)).reports.find(row => row.id === draft.reportId)?.sourceChanged, false)
  checks.push('later-approval:stale-draft-blocks-publish-explicit-regenerate-frozen-published-and-legacy-facts-unchanged')

  const calendarDefinition = { title: '来源日期不可改写', detail: '', startsAt: `${today}T09:00`, endsAt: `${today}T10:00`, visibility: 'private' }
  await expectCode(writeCalendarEvent(owner.id, { clientRequestId: randomUUID(), expectedVersion: 2, definition: calendarDefinition }, milestone.id), 'CALENDAR_FORBIDDEN')
  const [effective] = await db.select().from(projectStageDates).where(eq(projectStageDates.id, milestone.id))
  await db.update(projectStageDates).set({ plannedDate: shiftDate(effective.plannedDate, 1) }).where(eq(projectStageDates.id, milestone.id))
  try { await expectCode(collectApprovedMilestones(db, owner.id, thisWeek, { projectIds: [id], report: true }), 'MILESTONE_SOURCE_INVALID') }
  finally { await db.update(projectStageDates).set({ plannedDate: effective.plannedDate }).where(eq(projectStageDates.id, milestone.id)) }
  const [unchangedProject] = await db.select().from(projects).where(eq(projects.id, id))
  assert.equal(unchangedProject.targetDate, project.targetDate); assert.equal(unchangedProject.stage, project.stage); assert.equal(unchangedProject.classification, 'pool')
  checks.push('source-integrity:calendar-cannot-write-date-corrupt-approval-binding-fails-closed-project-target-and-pool-preserved')

  const { authRouter } = await import('../routes/auth.js'), { calendarRouter } = await import('../routes/fdeTime.js'), { weeklyReportsRouter } = await import('../routes/weeklyReports.js')
  const { requireAuth } = await import('../middleware/requireAuth.js'), { errorHandler } = await import('../middleware/errorHandler.js')
  const app = express(); app.use(express.json()); app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next)); app.use('/api/auth', authRouter); app.use('/api/calendar', calendarRouter); app.use('/api/weekly-reports', weeklyReportsRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.AUTH_ALLOWED_ORIGINS = base
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: owner.email, password }) }); assert.equal(login.status, 200)
  const cookies = login.headers.getSetCookie(), cookie = cookies.map(line => line.split(';')[0]).join('; '), csrf = decodeURIComponent(cookies.find(line => line.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length))
  const url = `${base}/api/calendar?weekStart=${thisWeek}&view=company&includeMilestones=true`
  assert.equal((await fetch(url)).status, 401)
  const response = await fetch(url, { headers: { Cookie: cookie } }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.ok((await response.json()).items.some((row: { id: string }) => row.id === milestone.id))
  assert.equal((await fetch(url.replace('includeMilestones=true', 'includeMilestones=1'), { headers: { Cookie: cookie } })).status, 400)
  const post = (body: unknown, extra = {}) => fetch(`${base}/api/weekly-reports`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) })
  assert.equal((await post({}, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await post({}, { Origin: 'https://untrusted.invalid' })).status, 403)
  assert.equal((await post({ clientRequestId: randomUUID(), weekStart: thisWeek, projectIds: [id], sourceOptions: { projectTimeline: true }, milestones: [milestone] })).status, 400)
  checks.push('real-session:private-no-store-strict-query-unauthenticated-CSRF-Origin-and-injected-facts-denied')

  await db.delete(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, id), eq(projectDutyAssignments.userId, secretary.id)))
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, secretary.id)))
  assert.deepEqual(await collectApprovedMilestones(db, secretary.id, thisWeek, { report: true }), [])
  assert.equal(await canReadMilestoneSnapshot(db, milestone, secretary.id), false)
  const restricted = (await listWeeklyReports(secretary.id, thisWeek)).reports.find(row => row.id === report.reportId)!
  assert.equal(restricted.restricted, true); assert.equal(restricted.body, ''); assert.equal(restricted.facts, null)
  await actOnWeeklyReport(report.reportId, secretary.id, { clientRequestId: randomUUID(), expectedVersion: frozen.version, action: 'withdraw', reason: '来源权限变化后撤回已发布周报' })
  assert.equal((await listWeeklyReports(owner.id, thisWeek)).reports.some(row => row.id === report.reportId), false)
  await db.update(users).set({ status: '禁用' }).where(eq(users.id, owner.id))
  assert.equal((await fetch(url, { headers: { Cookie: cookie } })).status, 401)
  await expectCode(collectApprovedMilestones(db, owner.id, thisWeek), 'MILESTONE_ACTOR_UNAVAILABLE')
  checks.push('live-revocation:hide-date-and-body-author-can-withdraw-without-content-disabled-session-denied')
  console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, checks, passed: checks.length, realModelCalls: 0, scope: 'approved-milestone-sources-not-global-reschedule' }))
} finally { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) } await pool.end() }
