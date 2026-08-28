import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { meetingParticipants, meetings, oaApprovalRecords, personalWeeklyReportEvents, personalWeeklyReportRecipients, personalWeeklyReports, projectDutyAssignments, projectMembers, todos, users } from '../db/schema.js'
import { shanghaiToday, shiftDate, weekStartFor } from '../contracts/fdeWeeklyPlanContract.js'
import { reportWindow } from '../contracts/fdeWeeklyReportContract.js'
import { identityRepositories } from '../repositories/index.js'
import { createProject, classifyProject } from '../services/projectService.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { createFdeTask, feedbackFdeTask, requestFdeTaskExtension } from '../services/fdeTaskService.js'
import { actOnWeeklyReport, createWeeklyReport, listWeeklyReports, readWeeklyReport, saveWeeklyReport, weeklyReportRecipients } from '../services/fdeWeeklyReportService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const marker = randomUUID().slice(0, 8), week = weekStartFor(shanghaiToday()), checks: string[] = []
const accounts = ['作者', '负责人', '接收人', '部分权限', '项目外', '管理员'].map((label, index) => ({ id: randomUUID(), name: `周报${label}-${marker}`, email: `weekly-report-${marker}-${index}@example.invalid`, department: `周报隔离-${marker}`, role: index === 5 ? '系统管理员' : '投资经理', passwordHash: 'not-for-login' }))
const [author, manager, recipient, limited, outsider, admin] = accounts
const expectCode = async (promise: Promise<unknown>, code: string) => { const error = await promise.then(() => null, (cause) => cause); assert.equal(error?.code, code, `${code}: ${error?.message ?? 'unexpected success'}`) }
try {
  await db.insert(users).values(accounts)
  for (const user of accounts) await identityRepositories.users.synchronizeAdministrationBindings(user.id, user.role, user.department)
  const projectIds: string[] = []
  for (let index = 0; index < 2; index++) {
    let project = await createProject({ name: `周报来源-${marker}-${index}`, owner: manager.name, ownerUserId: manager.id, collaborators: [], targetDate: shiftDate(week, 90) }, manager.id)
    project = await classifyProject({ projectId: project.id, userId: manager.id, expectedVersion: project.version, toClassification: 'normal', reason: '周报验收项目初筛完成' })
    await proposeFdeGovernance({ projectId: project.id, userId: manager.id, ownerUserId: manager.id, expectedVersion: project.governanceVersion, reason: '配置周报验收项目成员', assignments: [author, recipient, ...(index === 0 ? [limited] : [])].map((person) => ({ duty: 'member', userId: person.id })) })
    projectIds.push(project.id)
  }
  const makeTask = async (title: string, dueDate: string, ownerId = author.id) => { const id = randomUUID(); await createFdeTask(projectIds[0], manager.id, { clientRequestId: id, title, dueDate, ownerUserId: ownerId, deliverable: '可核验成果' }); return id }
  const currentTask = await makeTask('本周期限', shiftDate(week, 3))
  const overdue = await makeTask('前期遗留', shiftDate(week, -2))
  const completedNow = await makeTask('旧期限本周验收', shiftDate(week, -5))
  const completedOld = await makeTask('历史完成不算本周', shiftDate(week, -8))
  const future = await makeTask('未来周任务', shiftDate(week, 9))
  const cancelled = await makeTask('本周期限已取消', shiftDate(week, 2))
  await makeTask('其他成员任务不进入本人周报', week, manager.id)
  const { start, end } = reportWindow(week)
  await db.update(todos).set({ status: '已完成', progress: 100, completedAt: start }).where(eq(todos.id, completedNow))
  await db.update(todos).set({ status: '已完成', progress: 100, completedAt: new Date(start.getTime() - 1) }).where(eq(todos.id, completedOld))
  await db.update(todos).set({ status: '已取消', closureReason: '合成取消夹具' }).where(eq(todos.id, cancelled))
  await requestFdeTaskExtension(projectIds[0], currentTask, author.id, { expectedVersion: 1, requestedDueDate: shiftDate(week, 5), reviewerUserId: manager.id, reason: '等待客户资料需要延期' })
  const [operation] = await db.select().from(oaApprovalRecords).where(eq(oaApprovalRecords.operatorUserId, author.id))
  assert.ok(operation)
  await db.insert(oaApprovalRecords).values({ ...operation, id: randomUUID(), createdAt: new Date(start.getTime() - 1) })
  const meetingId = randomUUID()
  await db.insert(meetings).values([
    { id: meetingId, projectId: projectIds[0], projectName: `周报来源-${marker}-0`, title: '本周参与会议', host: manager.name, hostUserId: manager.id, startedAt: start },
    { id: randomUUID(), projectId: projectIds[0], projectName: `周报来源-${marker}-0`, title: '下周会议不纳入', host: author.name, hostUserId: author.id, startedAt: end },
    { id: randomUUID(), projectId: projectIds[0], projectName: `周报来源-${marker}-0`, title: '其他成员会议不纳入', host: manager.name, hostUserId: manager.id, startedAt: start },
  ])
  await db.insert(meetingParticipants).values({ meetingId, userId: author.id, sourceName: author.name })
  const command = { clientRequestId: randomUUID(), weekStart: week, projectIds }
  for (const user of [outsider, admin, limited]) await expectCode(createWeeklyReport(user.id, { ...command, clientRequestId: randomUUID() }), 'REPORT_SOURCE_FORBIDDEN')
  const { reportId } = await createWeeklyReport(author.id, command)
  assert.equal((await createWeeklyReport(author.id, command)).reportId, reportId)
  await expectCode(createWeeklyReport(author.id, { ...command, projectIds: [projectIds[0]] }), 'REPORT_REQUEST_REUSED')
  await expectCode(createWeeklyReport(author.id, { ...command, clientRequestId: randomUUID() }), 'REPORT_DRAFT_EXISTS')
  assert.equal((await listWeeklyReports(recipient.id, week)).reports.length, 0)
  const getReport = async (id = reportId) => (await listWeeklyReports(author.id, week)).reports.find((report) => report.id === id)!
  let report = await getReport()
  assert.equal(report.facts?.metrics.completedInWeek, 1)
  assert.equal(report.facts?.metrics.overdueOpen, 1)
  assert.equal(report.facts?.metrics.cancelledDueInWeek, 1)
  assert.equal(report.facts?.metrics.approvalActions, 1)
  assert.equal(report.facts?.metrics.meetingRecords, 1)
  assert.deepEqual(report.facts?.tasks.map((task) => task.id).sort(), [currentTask, overdue, completedNow, cancelled].sort())
  assert.ok(!report.facts?.tasks.some((task) => task.id === future))
  assert.ok(report.facts?.unavailable.some((item) => item.includes('日历')))
  checks.push('FDE-COLLAB-008:explicit-project-scope-personal-facts-shanghai-window-and-no-fabricated-calendar')
  const beforeTasks = JSON.stringify(await db.select().from(todos).orderBy(todos.id))
  const save = { clientRequestId: randomUUID(), expectedVersion: report.version, body: `${report.body}\n人工补充：下周开展访谈。` }
  await expectCode(saveWeeklyReport(reportId, recipient.id, save), 'REPORT_NOT_FOUND')
  await saveWeeklyReport(reportId, author.id, save); await saveWeeklyReport(reportId, author.id, save)
  assert.equal((await getReport()).version, 2)
  await expectCode(saveWeeklyReport(reportId, author.id, { ...save, clientRequestId: randomUUID() }), 'VERSION_CONFLICT')
  assert.equal(JSON.stringify(await db.select().from(todos).orderBy(todos.id)), beforeTasks)
  checks.push('FDE-COLLAB-004:author-only-edit-request-replay-and-source-records-unchanged')
  const action = async (kind: 'regenerate' | 'publish' | 'withdraw' | 'discard', id = reportId, recipientIds: string[] = []) => actOnWeeklyReport(id, author.id, { clientRequestId: randomUUID(), expectedVersion: (await getReport(id)).version, action: kind, recipientIds, reason: '隔离验收人工确认操作' })
  const [current] = await db.select().from(todos).where(eq(todos.id, currentTask))
  await feedbackFdeTask(projectIds[0], currentTask, author.id, { expectedVersion: current.version, kind: 'progress', progress: 20, result: '已完成部分访谈' })
  assert.equal((await getReport()).sourceChanged, true)
  await expectCode(action('publish'), 'REPORT_SOURCE_CHANGED')
  await action('regenerate')
  assert.equal((await getReport()).sourceChanged, false)
  assert.equal((await getReport()).body.includes('人工补充：下周开展访谈。'), false)
  const savedEvent = (await db.select().from(personalWeeklyReportEvents).where(and(eq(personalWeeklyReportEvents.reportId, reportId), eq(personalWeeklyReportEvents.action, 'save'))))[0]
  assert.ok(JSON.stringify(savedEvent.snapshot).includes('人工补充：下周开展访谈。'))
  checks.push('FDE-COLLAB-008:changed-source-blocks-publication-regenerate-retains-prior-edit-snapshot')
  const candidates = await weeklyReportRecipients(reportId, author.id)
  assert.ok(candidates.recipients.some((user) => user.id === recipient.id))
  assert.ok(!candidates.recipients.some((user) => user.id === limited.id || user.id === outsider.id || user.id === admin.id))
  const recipientsBeforeDeniedPublish = await db.select().from(personalWeeklyReportRecipients).orderBy(personalWeeklyReportRecipients.id)
  await expectCode(action('publish', reportId, [limited.id]), 'REPORT_SOURCE_FORBIDDEN')
  assert.deepEqual(await db.select().from(personalWeeklyReportRecipients).orderBy(personalWeeklyReportRecipients.id), recipientsBeforeDeniedPublish, '拒绝分享不得修改任何既有接收记录')
  assert.equal((await db.select().from(personalWeeklyReportRecipients).where(eq(personalWeeklyReportRecipients.reportId, reportId))).length, 0)
  report = await getReport()
  const publish = { clientRequestId: randomUUID(), expectedVersion: report.version, action: 'publish', recipientIds: [recipient.id] }
  const outcomes = await Promise.allSettled([publish, { ...publish, clientRequestId: randomUUID() }].map((input) => actOnWeeklyReport(reportId, author.id, input)))
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
  const publishedEvent = (await db.select().from(personalWeeklyReportEvents).where(and(eq(personalWeeklyReportEvents.reportId, reportId), eq(personalWeeklyReportEvents.action, 'publish'))))[0]
  await actOnWeeklyReport(reportId, author.id, { ...publish, clientRequestId: publishedEvent.requestId })
  assert.equal((await db.select().from(personalWeeklyReportRecipients).where(eq(personalWeeklyReportRecipients.reportId, reportId))).length, 1)
  assert.equal((await listWeeklyReports(recipient.id, week)).reports.length, 1)
  await expectCode(readWeeklyReport(reportId, limited.id), 'REPORT_NOT_FOUND')
  await readWeeklyReport(reportId, recipient.id); await readWeeklyReport(reportId, recipient.id)
  assert.ok((await listWeeklyReports(recipient.id, week)).reports[0].recipients[0].readAt)
  checks.push('FDE-COLLAB-004:recipient-intersection-concurrent-publish-once-and-persistent-read-receipt')
  const [frozen] = await db.select().from(personalWeeklyReports).where(eq(personalWeeklyReports.id, reportId))
  await expectCode(saveWeeklyReport(reportId, author.id, { ...save, clientRequestId: randomUUID(), expectedVersion: frozen.version }), 'REPORT_STATE_INVALID')
  const second = await createWeeklyReport(author.id, { ...command, clientRequestId: randomUUID() })
  assert.equal((await getReport(second.reportId)).revision, 2)
  await action('discard', second.reportId)
  const [stillFrozen] = await db.select().from(personalWeeklyReports).where(eq(personalWeeklyReports.id, reportId))
  assert.equal(JSON.stringify(stillFrozen), JSON.stringify(frozen))
  checks.push('FDE-COLLAB-008:published-body-immutable-new-revision-and-discard-do-not-overwrite-history')
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectIds[1]), eq(projectMembers.userId, recipient.id)))
  await db.delete(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, projectIds[1]), eq(projectDutyAssignments.userId, recipient.id)))
  assert.equal((await listWeeklyReports(recipient.id, week)).reports.length, 0)
  await expectCode(readWeeklyReport(reportId, recipient.id), 'REPORT_SOURCE_FORBIDDEN')
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectIds[1]), eq(projectMembers.userId, author.id)))
  await db.delete(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, projectIds[1]), eq(projectDutyAssignments.userId, author.id)))
  const restricted = await getReport()
  assert.equal(restricted.restricted, true); assert.equal(restricted.body, ''); assert.equal(restricted.facts, null)
  await action('withdraw')
  assert.equal((await getReport()).status, 'withdrawn')
  assert.ok((await db.select().from(personalWeeklyReportRecipients).where(eq(personalWeeklyReportRecipients.reportId, reportId)))[0].closedAt)
  checks.push('FDE-AUTH-003:revoked-source-scope-hides-snapshot-and-author-can-still-withdraw')
  await db.update(users).set({ status: '停用' }).where(eq(users.id, author.id))
  await expectCode(listWeeklyReports(author.id, week), 'REPORT_ACTOR_UNAVAILABLE')
  checks.push('FDE-COLLAB-004:disabled-identity-denied-and-history-retained')
  console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, checks, passed: checks.length }))
} finally { await pool.end() }
