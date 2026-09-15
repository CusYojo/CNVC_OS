import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { projectTimelineSyncs, projectTimelineTasks, projects, todos, userRoles, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { createProject, deleteProject } from '../services/projectService.js'
import { decideFdeGovernance, proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { previewTimelineTasks, syncTimelineTasks } from '../services/fdeTimelineTaskService.js'
import { resolveProjectAgentCommand } from '../services/fdeProjectAgentService.js'
import { bindFdeMaterial } from '../services/fdeWorkflowService.js'
import { createFdeTask, feedbackFdeTask, requestFdeTaskExtension } from '../services/fdeTaskService.js'
import { actOnOaApprovalRequest } from '../services/oaWorkflowService.js'
import { listCalendar, writeTaskCalendarSchedule } from '../services/fdeCalendarService.js'
import { createFdeWeeklyPlan, getFdeWeeklyPlans } from '../services/fdeWeeklyPlanService.js'
import { createWeeklyReport, listWeeklyReports } from '../services/fdeWeeklyReportService.js'
import { shanghaiToday, shiftDate, weekStartFor } from '../contracts/fdeWeeklyPlanContract.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const marker = randomUUID().slice(0, 8), checks: string[] = []
const people = ['投资经理', '投资经理', '投资经理', '总裁', '系统管理员'].map((role, i) => ({ id: randomUUID(), role, name: `流程行动-${marker}-${i}`, email: `timeline-${marker}-${i}@example.invalid`, department: `流程行动-${marker}`, passwordHash: 'not-for-login' }))
const [owner, secretary, outsider, president, admin] = people
const expectCode = async (promise: Promise<unknown>, expected: string) => { const error = await promise.then(() => null, error => error); assert.equal(error?.code, expected, error?.message ?? 'unexpected success') }
try {
  await db.insert(users).values(people)
  for (const person of people) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
  const project = await createProject({ name: `流程行动-${marker}`, owner: owner.name, ownerUserId: owner.id, collaborators: [] }, owner.id)
  const change = await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '隔离配置流程行动稳定职责', assignments: [{ duty: 'secretary', userId: secretary.id }, { duty: 'president', userId: president.id }] })
  let version = change.version
  for (const userId of change.requiredConfirmers) version = (await decideFdeGovernance({ projectId: project.id, changeId: change.id, userId, expectedVersion: version, decision: 'confirm', comment: '确认隔离流程行动职责' })).version
  await db.update(projects).set({ stage: '立项', classification: 'normal', targetDate: shiftDate(shanghaiToday(), 40), cycleDays: 40 }).where(eq(projects.id, project.id))
  const preview = () => previewTimelineTasks(project.id, secretary.id)
  const task = async (id: string) => (await db.select().from(todos).where(eq(todos.id, id)))[0]
  const linked = () => db.select().from(projectTimelineTasks).where(eq(projectTimelineTasks.projectId, project.id))
  const sync = async () => syncTimelineTasks(project.id, secretary.id, { clientRequestId: randomUUID(), fingerprint: (await preview()).fingerprint })
  for (const person of [outsider, admin]) await expectCode(previewTimelineTasks(project.id, person.id), 'AGENT_FORBIDDEN')
  const before = await preview(); assert.equal(before.changes.filter(item => item.action === 'add').length, 4); assert.deepEqual(before.issues, [])
  assert.equal((await linked()).length, 0)
  checks.push('timeline-preview-is-readonly-and-enforces-project-content-access')

  const input = { clientRequestId: randomUUID(), fingerprint: before.fingerprint }
  const results = await Promise.all([syncTimelineTasks(project.id, secretary.id, input), syncTimelineTasks(project.id, secretary.id, input)])
  assert.deepEqual(results[0], results[1]); assert.equal((await linked()).length, 4)
  assert.equal((await db.select().from(projectTimelineSyncs).where(eq(projectTimelineSyncs.projectId, project.id))).length, 1)
  assert.equal((await resolveProjectAgentCommand(project.id, secretary.id, { clientRequestId: input.clientRequestId })).receipt?.kind, 'timeline')
  const versions = await Promise.all((await linked()).map(async link => [link.taskId, (await task(link.taskId)).version]))
  await sync(); assert.deepEqual(await Promise.all((await linked()).map(async link => [link.taskId, (await task(link.taskId)).version])), versions)
  await expectCode(deleteProject(project.id, owner.id), 'PROJECT_TIMELINE_HISTORY_PROTECTED')
  checks.push('concurrent-same-command-one-result:no-duplicate-tasks-no-op-preserves-versions-history-protected')

  const independentId = randomUUID()
  await createFdeTask(project.id, owner.id, { clientRequestId: independentId, title: '独立任务不随模板改期', ownerUserId: owner.id, dueDate: shanghaiToday(), dueTime: '11:45', deliverable: '独立可核验成果' })
  const independent = await task(independentId), links = await linked(), conclusion = links.find(item => item.actionKey === 'conclusion')!, material = links.find(item => item.actionKey === 'material:business_plan')!, leadership = links.find(item => item.actionKey === 'leadership_review')!
  const week = weekStartFor((await task(conclusion.taskId)).dueDate!)
  const planId = (await createFdeWeeklyPlan(project.id, secretary.id, { clientRequestId: randomUUID(), weekStart: week })).planId
  const reportId = (await createWeeklyReport(secretary.id, { clientRequestId: randomUUID(), weekStart: week, projectIds: [project.id], sourceOptions: { calendar: true } })).reportId
  let calendar = await listCalendar(secretary.id, week, 'personal')
  assert.equal(calendar.items.filter(item => item.id === conclusion.taskId).length, 1)
  assert.equal(calendar.items.find(item => item.id === conclusion.taskId)?.editable, false)
  const conclusionTask = await task(conclusion.taskId)
  await expectCode(writeTaskCalendarSchedule(conclusion.taskId, secretary.id, { clientRequestId: randomUUID(), expectedVersion: 0, sourceVersion: conclusionTask.version, startsAt: `${conclusionTask.dueDate}T09:00`, endsAt: `${conclusionTask.dueDate}T10:00`, hidden: false, reason: '隔离验证流程任务不可绕过来源直接改期' }), 'CALENDAR_TASK_FORBIDDEN')
  const stale = await preview()
  await db.update(projects).set({ targetDate: shiftDate(shanghaiToday(), 41), version: project.version + 10 }).where(eq(projects.id, project.id))
  await expectCode(syncTimelineTasks(project.id, secretary.id, { clientRequestId: randomUUID(), fingerprint: stale.fingerprint }), 'TIMELINE_SOURCE_CHANGED')
  const racePreview = await preview()
  const race = await Promise.allSettled([1, 2].map(() => syncTimelineTasks(project.id, secretary.id, { clientRequestId: randomUUID(), fingerprint: racePreview.fingerprint })))
  assert.equal(race.filter(item => item.status === 'fulfilled').length, 1)
  assert.ok(race.some(item => item.status === 'rejected' && item.reason.code === 'TIMELINE_SOURCE_CHANGED'))
  assert.deepEqual(await task(independentId), independent)
  assert.equal((await getFdeWeeklyPlans(project.id, secretary.id, week)).plans.find(item => item.id === planId)?.sourceChanged, true)
  assert.equal((await listWeeklyReports(secretary.id, week)).reports.find(item => item.id === reportId)?.sourceChanged, true)
  calendar = await listCalendar(secretary.id, weekStartFor((await task(conclusion.taskId)).dueDate!), 'personal')
  assert.equal(calendar.items.find(item => item.id === conclusion.taskId)?.sourceVersion, (await task(conclusion.taskId)).version)
  const hidden = (await listCalendar(outsider.id, weekStartFor((await task(conclusion.taskId)).dueDate!), 'company')).items
  assert.ok(!JSON.stringify(hidden).includes(conclusion.taskId)); assert.ok(!hidden.some(item => item.title === '提交立项阶段结论'))
  checks.push('stale-preview-and-concurrent-change-blocked:independent-task-preserved-calendar-single-source-weekly-drafts-stale')

  await bindFdeMaterial({ projectId: project.id, userId: owner.id, stage: '立项', requirementKey: 'business_plan', waiverReason: '仅隔离验收确认当前材料免传' })
  await sync(); assert.equal((await task(material.taskId)).status, '已取消')
  const current = await task(conclusion.taskId)
  await requestFdeTaskExtension(project.id, conclusion.taskId, secretary.id, { expectedVersion: current.version, requestedDueDate: shiftDate(current.dueDate!, 2), requestedDueTime: '16:00', reason: '隔离验证独立延期不可覆盖', reviewerUserId: owner.id })
  const { oaApprovalRequests } = await import('../db/schema.js')
  const [extension] = await db.select().from(oaApprovalRequests).where(and(eq(oaApprovalRequests.taskId, conclusion.taskId), eq(oaApprovalRequests.status, '审批中')))
  assert.ok((await preview()).changes.find(item => item.taskId === conclusion.taskId)?.reason.includes('未决延期'))
  await actOnOaApprovalRequest({ userId: owner.id, requestId: extension.id, action: 'approve', expectedVersion: extension.lockVersion, comment: '独立批准期限并保留来源' })
  const extended = await task(conclusion.taskId)
  await db.update(projects).set({ targetDate: shiftDate(shanghaiToday(), 42) }).where(eq(projects.id, project.id))
  await sync(); assert.deepEqual(await task(conclusion.taskId), extended)
  const executed = await task(leadership.taskId)
  await feedbackFdeTask(project.id, leadership.taskId, secretary.id, { expectedVersion: executed.version, kind: 'progress', progress: 30, result: '已有真实过程反馈，不得归档抹除', evidence: [] })
  await db.update(projects).set({ stage: '尽调计划审核' }).where(eq(projects.id, project.id))
  await sync(); assert.equal((await task(leadership.taskId)).status, '进行中')
  assert.equal((await linked()).length, 4)
  checks.push('material-retirement-keeps-id:pending-approved-extension-and-executed-stage-history-preserved')

  const restorable = links.find(item => item.actionKey === 'material:initial_meeting')!
  assert.equal((await task(restorable.taskId)).status, '已取消')
  await db.update(projects).set({ stage: '立项' }).where(eq(projects.id, project.id))
  await sync(); assert.equal((await task(restorable.taskId)).status, '未开始'); assert.equal((await linked()).length, 4)
  // Synthetic historical completion fixture: does not assert the real acceptance chain was executed here.
  await db.update(todos).set({ status: '已完成', progress: 100, completedAt: new Date() }).where(eq(todos.id, restorable.taskId))
  const completed = await task(restorable.taskId)
  await db.update(projects).set({ targetDate: shiftDate(shanghaiToday(), 43) }).where(eq(projects.id, project.id))
  await sync(); assert.deepEqual(await task(restorable.taskId), completed)
  checks.push('restore-reuses-retired-task-id:historical-completion-fixture-remains-byte-for-byte-unchanged')

  const beforeRoleChange = await previewTimelineTasks(project.id, owner.id)
  const savedRoles = await db.select().from(userRoles).where(eq(userRoles.userId, secretary.id))
  await db.delete(userRoles).where(eq(userRoles.userId, secretary.id)) // Exact synthetic actor; restored below.
  try {
    const invalid = await previewTimelineTasks(project.id, owner.id)
    assert.ok(invalid.issues.some(item => item.includes('岗位资格')))
    await expectCode(syncTimelineTasks(project.id, owner.id, { clientRequestId: randomUUID(), fingerprint: beforeRoleChange.fingerprint }), 'TIMELINE_SOURCE_CHANGED')
    await expectCode(syncTimelineTasks(project.id, owner.id, { clientRequestId: randomUUID(), fingerprint: invalid.fingerprint }), 'TIMELINE_ASSIGNEE_REQUIRED')
  } finally { await db.insert(userRoles).values(savedRoles) }
  checks.push('revoked-assignee-role-invalidates-preview-and-blocks-new-work-without-implicit-regrant')

  await db.update(projects).set({ stage: '尽调' }).where(eq(projects.id, project.id))
  const missingDuties = await preview(); assert.ok(missingDuties.issues.some(item => item.includes('财务')))
  await expectCode(syncTimelineTasks(project.id, secretary.id, { clientRequestId: randomUUID(), fingerprint: missingDuties.fingerprint }), 'TIMELINE_ASSIGNEE_REQUIRED')
  const unknown = randomUUID(); await resolveProjectAgentCommand(project.id, secretary.id, { clientRequestId: unknown })
  await expectCode(syncTimelineTasks(project.id, secretary.id, { clientRequestId: unknown, fingerprint: missingDuties.fingerprint }), 'AGENT_REQUEST_CLOSED')
  checks.push('missing-real-duties-block-writes:unknown-command-fence-rejects-late-arrival')
  console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, passed: checks.length, checks, realModelCalls: 0 }))
} finally { await pool.end() }
