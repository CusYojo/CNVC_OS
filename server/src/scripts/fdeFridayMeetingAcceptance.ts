import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { meetings, meetingParticipants, meetingWorkflowEvents, meetingWorkflowNotices, personalWeeklyReports, projectRecords, projectTimelineTasks, projectWeeklyPlanItems, projectWeeklyPlans, projects, todos, users } from '../db/schema.js'
import { shanghaiToday, shiftDate, weekStartFor } from '../contracts/fdeWeeklyPlanContract.js'
import { identityRepositories } from '../repositories/index.js'
import { createProject, classifyProject } from '../services/projectService.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { actOnFdeFridayMeeting, createFdeFridayMeeting, getFdeFridayMeetings, readFdeFridayNotice, saveFdeFridayMeeting } from '../services/fdeFridayMeetingService.js'
import { actOnFdeWeeklyPlan, createFdeWeeklyPlan, getFdeWeeklyPlans } from '../services/fdeWeeklyPlanService.js'
import { collectWeeklyReportFacts, createWeeklyReport } from '../services/fdeWeeklyReportService.js'
import { getMeeting, listMeetings, updateMeeting } from '../services/meetingService.js'
import { syncMeetingIdentityBindings } from '../services/identityResolutionService.js'
import { actOnProjectRecord, getProjectRecord } from '../services/fdeProjectRecordService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const marker = randomUUID().slice(0, 8), checks: string[] = [], week = weekStartFor(shanghaiToday()), priorFriday = shiftDate(week, -3)
const accounts = ['投资经理', '投资经理', '投资经理', '投资经理', '系统管理员'].map((role, i) => ({ id: randomUUID(), name: `例会-${marker}-${i}`, role, department: `例会-${marker}`, email: `friday-${marker}-${i}@example.invalid`, passwordHash: 'not-for-login' }))
const [owner, secretary, member, stranger, admin] = accounts
async function expectCode(promise: Promise<unknown>, code: string) { const error = await promise.then(() => null, (cause) => cause as { code?: string; message: string }); assert.equal(error?.code, code, `${code}: ${error?.message ?? 'unexpected success'}`) }
try {
  await db.insert(users).values(accounts)
  for (const account of accounts) await identityRepositories.users.synchronizeAdministrationBindings(account.id, account.role, account.department)
  let project = await createProject({ name: `例会闭环-${marker}`, owner: owner.name, ownerUserId: owner.id, collaborators: [], targetDate: shiftDate(week, 90) }, owner.id)
  project = await classifyProject({ projectId: project.id, userId: owner.id, expectedVersion: project.version, toClassification: 'normal', reason: '例会隔离夹具完成初筛' })
  await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '配置真实例会秘书和成员', assignments: [{ duty: 'secretary', userId: secretary.id }, { duty: 'member', userId: member.id }] })
  const taskId = randomUUID()
  await db.insert(todos).values({ id: taskId, projectId: project.id, title: '已存在的本周工作', owner: member.name, ownerUserId: member.id, dueDate: shiftDate(week, 2), executionModel: 'fde-v1', deliverable: '既有工作成果', createdBy: owner.id })
  const input = { clientRequestId: randomUUID(), title: '周五业务例会', startsAt: `${priorFriday}T16:00`, endsAt: `${priorFriday}T17:00`, hostUserId: owner.id, participantIds: [owner.id, secretary.id, member.id], minutes: { agenda: '核对结果与阻塞', result: '', blocked: '等待客户确认', decision: '', nextGoal: '', nextActions: [{ key: randomUUID(), title: '例会拟定访谈行动', ownerUserId: member.id, dueDate: shiftDate(week, 3), deliverable: '客户访谈纪要及证据', priority: '中' }] } }
  const board = (actor = secretary.id) => getFdeFridayMeetings(project.id, actor)
  const row = async (id: string) => (await board()).list.find((item) => item.id === id)!
  const act = async (id: string, action: string, user = secretary.id, reason = '') => actOnFdeFridayMeeting(project.id, id, user, { clientRequestId: randomUUID(), expectedVersion: (await row(id)).version, action, reason })
  const tasks = () => db.select().from(todos).where(eq(todos.projectId, project.id))
  // Governance now generates real timeline actions before this meeting starts.
  // Assert their provenance and preserve the entire baseline; do not assume an empty workflow.
  const baselineTasks = await tasks()
  const timelineLinks = await db.select().from(projectTimelineTasks).where(eq(projectTimelineTasks.projectId, project.id))
  assert.equal(baselineTasks.length, timelineLinks.length + 1)
  assert.ok(baselineTasks.every(task => task.id === taskId || timelineLinks.some(link => link.taskId === task.id)))
  await expectCode(createFdeFridayMeeting(project.id, member.id, input), 'FDE_MEETING_MANAGER_REQUIRED')
  for (const user of [stranger, admin]) await expectCode(board(user.id), 'PROJECT_FORBIDDEN')
  await expectCode(createFdeFridayMeeting(project.id, secretary.id, { ...input, participantIds: [...input.participantIds, stranger.id] }), 'FDE_MEETING_PARTICIPANT_INVALID')
  const { meetingId } = await createFdeFridayMeeting(project.id, secretary.id, input)
  assert.equal((await createFdeFridayMeeting(project.id, secretary.id, input)).meetingId, meetingId)
  await expectCode(createFdeFridayMeeting(project.id, secretary.id, { ...input, title: '重用编号改变请求' }), 'FDE_MEETING_REQUEST_REUSED')
  assert.equal((await board(member.id)).list.length, 0)
  assert.equal((await listMeetings(project.id)).length, 0)
  assert.equal(await getMeeting(meetingId), undefined)
  assert.deepEqual(await tasks(), baselineTasks)
  checks.push('FDE-COLLAB-009:create-with-stable-identity-and-draft-hidden-idempotent-no-tasks')
  const snapshot = await row(meetingId)
  await syncMeetingIdentityBindings(meetingId, stranger.name, [stranger.name])
  assert.deepEqual((await row(meetingId)).participants.map((item) => item.userId), snapshot.participants.map((item) => item.userId))
  await expectCode(updateMeeting(meetingId, { rawTranscript: '绕过例会工作流', projectId: null }, 1), 'FDE_MEETING_WORKFLOW_REQUIRED')
  await act(meetingId, 'schedule')
  assert.equal((await board(member.id)).list[0].weeklyReview?.agenda, input.minutes.agenda)
  assert.equal((await board(member.id)).list[0].weeklyReview?.result, '')
  assert.equal((await board(member.id)).list[0].weeklyReview?.blocked, '')
  assert.equal((await board(member.id)).notices.length, 1)
  const notice = (await board(member.id)).notices[0]
  await expectCode(readFdeFridayNotice(project.id, notice.id, owner.id), 'FDE_MEETING_NOTICE_NOT_FOUND')
  await readFdeFridayNotice(project.id, notice.id, member.id)
  const readAt = (await board(member.id)).notices[0].readAt
  await readFdeFridayNotice(project.id, notice.id, member.id)
  assert.deepEqual((await board(member.id)).notices[0].readAt, readAt)
  await expectCode(act(meetingId, 'confirm'), 'FDE_MEETING_MINUTES_REQUIRED')
  await expectCode(act(meetingId, 'derive'), 'FDE_MEETING_NOT_CONFIRMED')
  checks.push('FDE-COLLAB-009:scheduled-notices-receipt-and-legacy-edit-rebinding-blocked')
  const { clientRequestId: _request, ...definition } = input
  const full = { ...definition, minutes: { ...input.minutes, result: '已核对当周成果', decision: '下周继续客户访谈', nextGoal: '完成下一周访谈与证据' } }
  const saved = { ...full, clientRequestId: randomUUID(), expectedVersion: 2, reason: '会议结束后补充实际纪要' }
  await saveFdeFridayMeeting(project.id, meetingId, secretary.id, saved)
  await saveFdeFridayMeeting(project.id, meetingId, secretary.id, saved)
  await expectCode(saveFdeFridayMeeting(project.id, meetingId, secretary.id, { ...saved, clientRequestId: randomUUID() }), 'VERSION_CONFLICT')
  assert.equal((await row(meetingId)).version, 3)
  assert.equal((await board(member.id)).notices.length, 1)
  assert.ok((await db.select().from(meetingWorkflowNotices).where(eq(meetingWorkflowNotices.id, notice.id)))[0].closedAt)
  const report = await createWeeklyReport(member.id, { clientRequestId: randomUUID(), weekStart: shiftDate(week, -7), projectIds: [project.id] })
  assert.equal((await db.select().from(personalWeeklyReports).where(eq(personalWeeklyReports.id, report.reportId)))[0].facts.metrics.meetingRecords, 0)
  const confirm = { clientRequestId: randomUUID(), expectedVersion: 3, action: 'confirm' }
  const concurrent = await Promise.allSettled([confirm, { ...confirm, clientRequestId: randomUUID() }].map((body) => actOnFdeFridayMeeting(project.id, meetingId, owner.id, body)))
  assert.equal(concurrent.filter((outcome) => outcome.status === 'fulfilled').length, 1)
  const event = (await db.select().from(meetingWorkflowEvents).where(and(eq(meetingWorkflowEvents.meetingId, meetingId), eq(meetingWorkflowEvents.action, 'confirm'))))[0]
  await actOnFdeFridayMeeting(project.id, meetingId, owner.id, { ...confirm, clientRequestId: event.requestId })
  assert.equal((await row(meetingId)).workflowStatus, 'completed')
  assert.equal((await listMeetings(project.id)).length, 1)
  assert.equal((await collectWeeklyReportFacts(db, member.id, [project.id], shiftDate(week, -7))).metrics.meetingRecords, 1)
  assert.deepEqual(await tasks(), baselineTasks)
  await expectCode(saveFdeFridayMeeting(project.id, meetingId, secretary.id, { ...saved, clientRequestId: randomUUID(), expectedVersion: 4 }), 'FDE_MEETING_IMMUTABLE')
  await expectCode(act(meetingId, 'cancel', owner.id, '不能取消已确认纪要'), 'FDE_MEETING_STATE_INVALID')
  checks.push('FDE-COLLAB-009:manual-minutes-concurrent-confirm-history-and-frozen-completed-record')
  const notes = await db.select().from(projectRecords).where(eq(projectRecords.sourceMeetingId, meetingId))
  assert.equal(notes.length, 1); assert.equal(notes[0].sourceVersion, 4)
  assert.ok((await getProjectRecord(project.id, notes[0].id, member.id)).record.content.includes(full.minutes.result))
  await actOnProjectRecord(project.id, notes[0].id, owner.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'withdraw', reason: '撤回协作记录不修改正式纪要' })
  await actOnFdeFridayMeeting(project.id, meetingId, owner.id, { ...confirm, clientRequestId: event.requestId })
  assert.equal((await db.select().from(projectRecords).where(eq(projectRecords.sourceMeetingId, meetingId))).length, 1)
  assert.equal((await getProjectRecord(project.id, notes[0].id, member.id)).record.status, 'withdrawn')
  assert.equal((await row(meetingId)).workflowStatus, 'completed')
  assert.deepEqual(await tasks(), baselineTasks)
  checks.push('FDE-COLLAB-009/010:confirmed-minutes-create-one-source-record-withdrawal-does-not-alter-or-resurrect-source')
  await expectCode(act(meetingId, 'derive', owner.id), 'FDE_WEEKLY_SECRETARY_REQUIRED')
  const existing = await createFdeWeeklyPlan(project.id, secretary.id, { clientRequestId: randomUUID(), weekStart: week })
  const eventsBefore = (await row(meetingId)).events.length
  await expectCode(act(meetingId, 'derive'), 'FDE_WEEKLY_DRAFT_EXISTS')
  assert.equal((await row(meetingId)).events.length, eventsBefore)
  await actOnFdeWeeklyPlan(project.id, existing.planId, secretary.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'discard', reason: '先处理既有草稿再派生例会计划' })
  const derive = { clientRequestId: randomUUID(), expectedVersion: 4, action: 'derive' }
  const result = await actOnFdeFridayMeeting(project.id, meetingId, secretary.id, derive)
  assert.equal(result.weekStart, week)
  assert.deepEqual(await actOnFdeFridayMeeting(project.id, meetingId, secretary.id, derive), result)
  await expectCode(act(meetingId, 'derive'), 'FDE_MEETING_PLAN_EXISTS')
  assert.deepEqual(await tasks(), baselineTasks)
  const plan = (await getFdeWeeklyPlans(project.id, secretary.id, week)).plans.find((item) => item.id === result.planId)!
  assert.equal(plan.sourceMeetingId, meetingId); assert.equal(plan.sourceMeetingVersion, 4); assert.equal(plan.status, 'draft')
  assert.equal(plan.items.length, 2); assert.ok(plan.items.some((item) => item.taskId === taskId))
  assert.equal((await getFdeWeeklyPlans(project.id, member.id, week)).plans.length, 0)
  assert.equal((await board(member.id)).list[0].plans.length, 0)
  checks.push('FDE-COLLAB-006/009:next-week-draft-atomic-idempotent-existing-draft-not-overwritten')
  await actOnFdeWeeklyPlan(project.id, plan.id, secretary.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'submit' })
  await expectCode(actOnFdeWeeklyPlan(project.id, plan.id, secretary.id, { clientRequestId: randomUUID(), expectedVersion: 2, action: 'publish' }), 'FDE_WEEKLY_ACTION_FORBIDDEN')
  await actOnFdeWeeklyPlan(project.id, plan.id, owner.id, { clientRequestId: randomUUID(), expectedVersion: 2, action: 'publish' })
  const after = await tasks()
  assert.equal(after.length, baselineTasks.length + 1)
  assert.deepEqual(after.filter(task => baselineTasks.some(original => original.id === task.id)), baselineTasks)
  assert.equal(after.find((item) => item.id === taskId)?.version, 1)
  const created = after.find((item) => item.meetingId === meetingId)!
  assert.ok(created); assert.equal(created.status, '未开始'); assert.equal(created.ownerUserId, member.id)
  assert.ok((await db.select().from(projectWeeklyPlanItems).where(eq(projectWeeklyPlanItems.planId, plan.id))).some((item) => item.taskId === created.id))
  assert.equal((await board(member.id)).list[0].plans[0].status, 'published')
  checks.push('FDE-COLLAB-006/009:owner-only-plan-publication-keeps-task-id-and-meeting-provenance')
  const future = await createFdeFridayMeeting(project.id, owner.id, { ...full, clientRequestId: randomUUID(), startsAt: `${shiftDate(week, 11)}T16:00`, endsAt: `${shiftDate(week, 11)}T17:00`, minutes: { ...full.minutes, nextActions: [] } })
  await act(future.meetingId, 'schedule')
  await expectCode(act(future.meetingId, 'confirm'), 'FDE_MEETING_NOT_ENDED')
  await act(future.meetingId, 'cancel', owner.id, '下周客户时间发生变化')
  const activeNotices = (await db.select().from(meetingWorkflowNotices).where(eq(meetingWorkflowNotices.meetingId, future.meetingId))).filter((item) => !item.closedAt)
  assert.equal(activeNotices.length, 3); assert.ok(activeNotices.every((item) => item.kind === 'cancelled'))
  const cancelledDraft = await createFdeFridayMeeting(project.id, owner.id, { ...full, clientRequestId: randomUUID() })
  await act(cancelledDraft.meetingId, 'cancel', owner.id, '会前草稿无需继续安排')
  assert.ok(!(await board(member.id)).list.some((item) => item.id === cancelledDraft.meetingId))
  assert.equal((await listMeetings(project.id)).length, 1)
  checks.push('FDE-COLLAB-009:future-confirm-blocked-cancellation-closes-notices-without-completing-tasks')
  await db.update(projects).set({ lifecycle: 'closed' }).where(eq(projects.id, project.id))
  await expectCode(createFdeFridayMeeting(project.id, owner.id, { ...full, clientRequestId: randomUUID() }), 'FDE_PROJECT_INACTIVE')
  assert.equal((await board()).canManage, false)
  await db.update(users).set({ status: '停用' }).where(eq(users.id, member.id))
  await expectCode(board(member.id), 'USER_DISABLED_OR_MISSING')
  assert.equal((await db.select().from(meetings).where(eq(meetings.projectId, project.id))).length, 3)
  assert.equal((await db.select().from(meetingParticipants).where(eq(meetingParticipants.meetingId, meetingId))).length, 3)
  assert.equal((await db.select().from(projectWeeklyPlans).where(eq(projectWeeklyPlans.sourceMeetingId, meetingId))).length, 1)
  checks.push('FDE-AUTH/LIFE:closed-project-disabled-user-and-retained-meeting-plan-history')
  console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, checks, passed: checks.length }))
} finally { await pool.end() }
