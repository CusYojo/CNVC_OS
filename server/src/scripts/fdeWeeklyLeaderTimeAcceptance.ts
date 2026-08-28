import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { leaderTimeEvents, leaderTimeNotices, leaderTimeRequests, oaApprovalRequests, projectTimelineSyncs, projectWeeklyPlanEvents, projectWeeklyPlanItems, projectWeeklyPlanNotices, projectWeeklyPlans, projects, todos, userRoles, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { createProject, classifyProject } from '../services/projectService.js'
import { proposeFdeGovernance, decideFdeGovernance } from '../services/fdeGovernanceService.js'
import { actOnFdeWeeklyPlan, createFdeWeeklyPlan, getFdeWeeklyPlans, saveFdeWeeklyPlan } from '../services/fdeWeeklyPlanService.js'
import { actOnLeaderTime, createLeaderTime, listLeaderTimes } from '../services/fdeLeaderTimeService.js'
import { readTimelineTimeSource } from '../services/fdeTimelineTimeService.js'
import { actOnFdeTaskExtension, cancelFdeTask, requestFdeTaskExtension } from '../services/fdeTaskService.js'
import { previewAutoSchedule } from '../services/fdeAutoScheduleService.js'
import { timeLocal } from '../contracts/fdeTimeContract.js'
import { shiftDate } from '../contracts/fdeWeeklyPlanContract.js'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
process.env.AUTH_COOKIE_SECURE = 'false'; process.env.AUTH_COOKIE_DOMAIN = ''; process.env.AUTH_ALLOW_LEGACY_BEARER = 'false'; process.env.JWT_SECRET = randomUUID() + randomUUID()
const { hashNewPassword } = await import('../security/passwordPolicy.js')
const password = `Weekly-Only-${randomUUID()}!`, passwordHash = await hashNewPassword(password)
const marker = randomUUID().slice(0, 8), week = '2027-03-01', checks: string[] = []
const people = ['投资经理', '投资经理', '投资经理', '董事长', '时间协调人', '投资经理', '系统管理员'].map((role, i) => ({ id: randomUUID(), role, name: `周计划领导-${marker}-${i}`, email: `weekly-time-${marker}-${i}@example.invalid`, department: `周计划领导-${marker}`, passwordHash }))
const [owner, secretary, member, leader, coordinator, outsider, admin] = people
const code = async (promise: Promise<unknown>, expected: string) => { const error = await promise.then(() => null, cause => cause); assert.equal(error?.code, expected, error?.message ?? 'unexpected success') }
let server: Server | undefined
try {
  await db.insert(users).values(people)
  for (const person of people) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
  let project = await createProject({ name: `周计划领导闭环-${marker}`, targetDate: '2027-05-31', cycleDays: 30 }, owner.id)
  project = await classifyProject({ projectId: project.id, userId: owner.id, expectedVersion: project.version, toClassification: 'normal', reason: '隔离验收人工行动领导需求' })
  const change = await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '配置正式秘书成员领导及协调职责', assignments: [{ duty: 'secretary', userId: secretary.id }, { duty: 'member', userId: member.id }, { duty: 'concerned_leader', userId: leader.id }, { duty: 'coordinator', userId: coordinator.id }] })
  let gv = change.version
  for (const userId of change.requiredConfirmers) gv = (await decideFdeGovernance({ projectId: project.id, changeId: change.id, userId, expectedVersion: gv, decision: 'confirm', comment: '确认隔离测试领导职责' })).version
  const board = (actor = secretary.id, date = week) => getFdeWeeklyPlans(project.id, actor, date)
  const { planId } = await createFdeWeeklyPlan(project.id, secretary.id, { clientRequestId: randomUUID(), weekStart: week })
  const plan = async () => (await board()).plans.find(item => item.id === planId)!
  const rows = () => db.select().from(leaderTimeRequests).where(and(eq(leaderTimeRequests.projectId, project.id), isNotNull(leaderTimeRequests.sourceWeeklyItemId)))
  const row = async (id: string) => (await rows()).find(item => item.id === id)!
  const task = async (id: string) => (await db.select().from(todos).where(eq(todos.id, id)))[0]
  const weekly = async (action: string, actor = secretary.id) => actOnFdeWeeklyPlan(project.id, planId, actor, { clientRequestId: randomUUID(), expectedVersion: (await plan()).version, action, reason: '隔离验收正式周计划动作' })
  const timeAction = async (id: string, action: string, actor = leader.id) => actOnLeaderTime(id, actor, { clientRequestId: randomUUID(), expectedVersion: (await row(id)).version, action, reason: '隔离核对实际行动来源与排期' })
  const snapshot = async () => ({
    tasks: await db.select().from(todos).where(eq(todos.projectId, project.id)),
    plans: await db.select().from(projectWeeklyPlans).where(eq(projectWeeklyPlans.projectId, project.id)),
    items: await db.select().from(projectWeeklyPlanItems).where(eq(projectWeeklyPlanItems.planId, planId)),
    events: await db.select().from(projectWeeklyPlanEvents).where(eq(projectWeeklyPlanEvents.planId, planId)),
    notices: await db.select().from(projectWeeklyPlanNotices).where(eq(projectWeeklyPlanNotices.planId, planId)),
    times: await db.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.projectId, project.id)),
    timeEvents: await db.select().from(leaderTimeEvents), timeNotices: await db.select().from(leaderTimeNotices),
    syncs: await db.select().from(projectTimelineSyncs).where(eq(projectTimelineSyncs.projectId, project.id)),
  })
  const manual = [0, 1, 2].map(i => ({ key: randomUUID(), title: `人工行动-${i}`, ownerUserId: member.id, dueDate: shiftDate(week, i), deliverable: '可复核访谈成果', priority: '中', ...(i < 2 ? { needLeader: true, dueTime: '18:07' } : {}) }))
  const beforeTasks = (await snapshot()).tasks.length
  await saveFdeWeeklyPlan(project.id, planId, secretary.id, { clientRequestId: randomUUID(), expectedVersion: 1, goal: '本周领导访谈和执行', manualItems: manual })
  assert.equal((await snapshot()).tasks.length, beforeTasks); assert.equal((await rows()).length, 0)
  assert.equal((await plan()).items[0].dueTime, '18:07')
  await weekly('submit'); assert.equal((await rows()).length, 0)
  await code(weekly('publish', secretary.id), 'FDE_WEEKLY_ACTION_FORBIDDEN')
  await code(weekly('sync-leader-time'), 'FDE_WEEKLY_STATE_INVALID')
  checks.push('draft-submit:no-tasks-or-time-needs:precise-time-persisted:secretary-cannot-publish')

  const beforeFault = await snapshot()
  // Add a constraint only to this random test prefix. Failure occurs after the
  // publisher has created tasks and a time request, proving actual rollback.
  const faultConstraint = sql.raw(quoteMysqlIdentifier(mysqlTableName('ck_weekly_publish_fault')))
  await db.execute(sql`ALTER TABLE ${leaderTimeEvents} ADD CONSTRAINT ${faultConstraint} CHECK (action <> 'weekly-create')`)
  try {
    await assert.rejects(weekly('publish', owner.id), (error: unknown) => {
      const cause = error as { code?: string; cause?: { code?: string } }
      assert.equal(cause.cause?.code ?? cause.code, 'ER_CHECK_CONSTRAINT_VIOLATED'); return true
    })
    assert.deepEqual(await snapshot(), beforeFault)
  } finally { await db.execute(sql`ALTER TABLE ${leaderTimeEvents} DROP CHECK ${faultConstraint}`) }
  checks.push('real-publish-late-SQL-failure-rolls-back-tasks-plan-items-demands-events-notices-and-source-journal')

  const publish = { clientRequestId: randomUUID(), expectedVersion: (await plan()).version, action: 'publish' }
  await Promise.all([1, 2].map(() => actOnFdeWeeklyPlan(project.id, planId, owner.id, publish)))
  const published = await snapshot(), requests = await rows(), [first, second] = manual.slice(0, 2).map(item => requests.find(request => request.title === item.title)!)
  assert.equal(published.tasks.length, beforeTasks + 3); assert.equal(requests.length, 2)
  assert.ok(first && second); assert.equal(first.status, 'requested'); assert.equal(first.confirmedAt, null)
  assert.equal(first.submittedBy, owner.id, 'formal publisher, not executing member, owns the generated request')
  await code(timeAction(first.id, 'withdraw', member.id), 'TIME_ACTION_FORBIDDEN')
  assert.equal(timeLocal(first.latestFinish!), `${week}T18:07`); assert.equal((await task(first.taskId!)).dueTime, '18:07')
  assert.equal(first.sourceTimelineTaskId, null); assert.equal(first.sourceDirectiveId, null)
  assert.equal(published.items.find(item => item.id === first.sourceWeeklyItemId)?.sourceStage, '立项')
  const ordinary = published.items.find(item => item.title === manual[2].title)!
  assert.equal(ordinary.needLeader, false); assert.equal(ordinary.sourceStage, null); assert.equal(ordinary.dueTime, null)
  await actOnFdeWeeklyPlan(project.id, planId, owner.id, publish)
  await board(); await listLeaderTimes(leader.id, week)
  assert.deepEqual(await snapshot(), published)
  assert.equal((await listLeaderTimes(leader.id, week)).list.find(item => item.id === first.id)?.timelineSource?.kind, 'weekly')
  checks.push('concurrent-publish-and-replay:stable-independent-source:one-per-leader:old-date-only-unchanged:GET-readonly')

  await assert.rejects(db.insert(leaderTimeRequests).values({ ...first, id: randomUUID() }))
  await assert.rejects(db.update(projectWeeklyPlanItems).set({ needLeader: true }).where(eq(projectWeeklyPlanItems.id, ordinary.id)))
  const flowSource = published.times.find(item => item.sourceTimelineTaskId)
  assert.ok(flowSource?.sourceTimelineTaskId)
  await assert.rejects(db.update(leaderTimeRequests).set({ sourceTimelineTaskId: flowSource.sourceTimelineTaskId }).where(eq(leaderTimeRequests.id, first.id)))
  assert.deepEqual(await snapshot(), published)
  checks.push('database-contract:unique-weekly-leader-required-time-and-exclusive-source-enforced-without-partial-writes')

  await code(weekly('sync-leader-time', member.id), 'FDE_WEEKLY_ACTION_FORBIDDEN')
  for (const person of [outsider, admin]) await code(weekly('sync-leader-time', person.id), 'PROJECT_FORBIDDEN')
  await db.update(users).set({ status: '停用' }).where(eq(users.id, secretary.id))
  await code(actOnFdeWeeklyPlan(project.id, planId, secretary.id, { clientRequestId: randomUUID(), expectedVersion: 4, action: 'sync-leader-time' }), 'USER_DISABLED_OR_MISSING')
  await db.update(users).set({ status: '启用' }).where(eq(users.id, secretary.id))
  assert.equal((await listLeaderTimes(outsider.id, week)).list.some(item => item.projectId === project.id), false)
  checks.push('recovery-and-read-scope:member-outsider-admin-and-disabled-actor-cannot-bypass-authorization')

  const bindings = await db.select().from(userRoles).where(eq(userRoles.userId, leader.id))
  await db.delete(userRoles).where(eq(userRoles.userId, leader.id))
  try {
    await weekly('sync-leader-time', owner.id)
    assert.ok((await board()).leaderTimePendingCount > 0)
    assert.equal((await row(first.id)).status, 'withdrawn'); assert.equal((await row(first.id)).sourceRetired, true)
    assert.equal((await db.select().from(userRoles).where(eq(userRoles.userId, leader.id))).length, 0)
    for (let i = 0; i < 21; i++) await weekly('sync-leader-time')
    const pending = await board(); assert.ok(pending.leaderTimePendingCount > 20); assert.equal(pending.leaderTimePending.length, 20)
  } finally { await db.insert(userRoles).values(bindings) }
  await weekly('sync-leader-time')
  assert.equal((await board()).leaderTimePendingCount, 0); assert.equal((await rows()).length, 2)
  assert.equal((await row(first.id)).status, 'requested')
  checks.push('missing-role-pending:explicit-count-beyond-20:no-role-grant:recovery-restores-original-request-ids')

  const extend = async (id: string) => {
    const original = await task(id), before = await rows()
    await requestFdeTaskExtension(project.id, id, member.id, { expectedVersion: original.version, requestedDueDate: shiftDate(original.dueDate!, 2), requestedDueTime: '19:13', reviewerUserId: owner.id, reason: '等待客户补充真实访谈资料' })
    assert.deepEqual(await rows(), before)
    const [request] = await db.select().from(oaApprovalRequests).where(eq(oaApprovalRequests.activeKey, id))
    await actOnFdeTaskExtension({ requestId: request.id, userId: owner.id, expectedVersion: request.lockVersion, action: 'approve', comment: '独立审批通过合理延期' })
  }
  await extend(first.taskId!)
  assert.equal(timeLocal((await row(first.id)).latestFinish!), `${shiftDate(week, 2)}T19:13`)
  const frozenItems = await db.select().from(projectWeeklyPlanItems).where(eq(projectWeeklyPlanItems.planId, planId))
  assert.deepEqual(frozenItems, published.items)
  assert.equal((await plan()).items.find(item => item.taskId === first.taskId)?.task?.dueTime, '19:13')
  checks.push('unapproved-extension-no-change:approved-extension-follows-real-task-deadline:published-snapshot-unchanged')

  await timeAction(second.id, 'confirm')
  const confirmed = await row(second.id)
  await extend(second.taskId!)
  assert.deepEqual(await row(second.id), confirmed)
  await code(timeAction(second.id, 'confirm'), 'TIME_SOURCE_CHANGED')
  const auto = await previewAutoSchedule(coordinator.id, { weekStart: week, requests: [{ id: second.id, expectedVersion: confirmed.version }] })
  assert.equal(auto.items[0].result, 'skipped')
  await timeAction(second.id, 'refresh-source', owner.id)
  assert.equal((await row(second.id)).status, 'requested'); assert.equal((await row(second.id)).confirmedAt, null)
  assert.deepEqual((await row(second.id)).scheduledStart, confirmed.scheduledStart)
  await timeAction(second.id, 'confirm')
  checks.push('confirmed-time-protected:stale-source-not-confirmable-or-auto-scheduled:explicit-refresh-requires-new-confirmation')

  const nextWeek = shiftDate(week, 7)
  await createFdeWeeklyPlan(project.id, secretary.id, { clientRequestId: randomUUID(), weekStart: nextWeek })
  const next = (await board(secretary.id, nextWeek)).plans[0].items.find(item => item.taskId === first.taskId)!
  assert.equal(next.leaderTimeSource?.itemId, first.sourceWeeklyItemId); assert.equal(next.leaderTimeSource?.planId, planId)
  assert.equal((await rows()).length, 2)
  const independent = await createLeaderTime(owner.id, { clientRequestId: randomUUID(), projectId: project.id, leaderId: leader.id, title: '独立人工时间', reason: '独立时间不受周计划联动改写', outcome: '独立讨论成果', impact: '独立安排影响', priority: 'P2', latestFinish: '2027-04-20T18:00', preferredStart: '2027-04-20T09:00', alternativeStart: '2027-04-20T14:00', durationMinutes: 60, location: '隔离会议室' })
  const independentRow = async () => (await db.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.id, independent.id)))[0]
  const independentBefore = await independentRow()
  const flowBefore = await db.select().from(leaderTimeRequests).where(and(eq(leaderTimeRequests.projectId, project.id), isNotNull(leaderTimeRequests.sourceTimelineTaskId)))
  await cancelFdeTask(project.id, first.taskId!, owner.id, (await task(first.taskId!)).version, '取消人工来源并核对未处理领导需求')
  assert.equal((await row(first.id)).status, 'withdrawn')
  await cancelFdeTask(project.id, second.taskId!, owner.id, (await task(second.taskId!)).version, '来源取消但不擅自取消已确认排期')
  assert.equal((await row(second.id)).status, 'confirmed'); assert.equal((await readTimelineTimeSource(db, await row(second.id)))?.view.needed, false)
  await timeAction(second.id, 'cancel', owner.id); await weekly('sync-leader-time')
  assert.equal((await row(second.id)).status, 'cancelled')
  assert.deepEqual(await independentRow(), independentBefore)
  assert.deepEqual(await db.select().from(leaderTimeRequests).where(and(eq(leaderTimeRequests.projectId, project.id), isNotNull(leaderTimeRequests.sourceTimelineTaskId))), flowBefore)
  checks.push('next-week-reuses-source:cancel-only-unprocessed:confirmed-requires-explicit-cancel:independent-and-timeline-sources-unchanged')

  const missingWeek = shiftDate(week, 14), missingPlan = await createFdeWeeklyPlan(project.id, secretary.id, { clientRequestId: randomUUID(), weekStart: missingWeek })
  await saveFdeWeeklyPlan(project.id, missingPlan.planId, secretary.id, { clientRequestId: randomUUID(), expectedVersion: 1, goal: '缺岗发布仍保留真实执行任务', manualItems: [{ ...manual[0], key: randomUUID(), title: '发布时缺岗的人工行动', dueDate: missingWeek }] })
  await actOnFdeWeeklyPlan(project.id, missingPlan.planId, secretary.id, { clientRequestId: randomUUID(), expectedVersion: 2, action: 'submit' })
  await db.delete(userRoles).where(eq(userRoles.userId, leader.id))
  try {
    await actOnFdeWeeklyPlan(project.id, missingPlan.planId, owner.id, { clientRequestId: randomUUID(), expectedVersion: 3, action: 'publish' })
    const missing = (await board(secretary.id, missingWeek)).plans[0]
    assert.equal(missing.status, 'published'); assert.ok(missing.items.find(item => item.title === '发布时缺岗的人工行动')?.taskId)
    assert.equal((await rows()).length, 2); assert.ok((await board()).leaderTimePendingCount > 0)
  } finally { await db.insert(userRoles).values(bindings) }
  await weekly('sync-leader-time')
  assert.equal((await rows()).length, 3); assert.equal((await board()).leaderTimePendingCount, 0)
  assert.equal((await row(second.id)).status, 'cancelled')
  checks.push('publish-with-missing-leader:real-task-and-visible-pending:no-fake-grant:later-recovery-creates-only-missing-request')

  const { requireAuth } = await import('../middleware/requireAuth.js'), { errorHandler } = await import('../middleware/errorHandler.js')
  const { authRouter } = await import('../routes/auth.js'), { projectsRouter } = await import('../routes/projects.js')
  const app = express(); app.use(express.json()); app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next)); app.use('/api/auth', authRouter); app.use('/api/projects', projectsRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.AUTH_ALLOWED_ORIGINS = base
  // Synthetic session credentials stay in memory and are never printed or saved.
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: owner.email, password }) }); assert.equal(login.status, 200)
  const cookies = login.headers.getSetCookie(), cookie = cookies.map(line => line.split(';')[0]).join('; '), csrf = decodeURIComponent(cookies.find(line => line.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length))
  const url = `${base}/api/projects/${project.id}/weekly-plans`, beforeHttp = await snapshot()
  assert.equal((await fetch(`${url}?weekStart=${week}`)).status, 401)
  const response = await fetch(`${url}?weekStart=${week}`, { headers: { Cookie: cookie } }); assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal((await response.json()).plans.find((item: { id: string }) => item.id === planId).items.find((item: { taskId: string }) => item.taskId === first.taskId).dueTime, '18:07')
  const command = { clientRequestId: randomUUID(), expectedVersion: (await plan()).version, action: 'sync-leader-time' }
  const post = (body: unknown, extra = {}) => fetch(`${url}/${planId}/actions`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) })
  assert.equal((await post(command, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await post(command, { Origin: 'https://untrusted.invalid' })).status, 403)
  assert.equal((await post({ ...command, sourceStage: '打款', leaderId: outsider.id })).status, 400)
  assert.deepEqual(await snapshot(), beforeHttp)
  assert.equal((await post(command, { Origin: base })).status, 200)
  const afterHttp = await snapshot()
  assert.equal((await post(command, { Origin: base })).status, 200); assert.deepEqual(await snapshot(), afterHttp)
  checks.push('real-session-http:401-CSRF-Origin-strict-source-rejection:no-failed-write-effects:authorized-recovery-idempotent')
  console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, passed: checks.length, checks, realModelCalls: 0 }))
} finally { if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); await pool.end() }
