import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { directiveEvents, leaderTimeRequests, oaApprovalRequests, projectDirectives, projectDutyAssignments, projectMembers, projectFiles, projectFileVersions, projects, todos, users, knowledgeChunks, auditLogs } from '../db/schema.js'
import { shanghaiToday, shiftDate, weekStartFor } from '../contracts/fdeWeeklyPlanContract.js'
import { identityRepositories } from '../repositories/index.js'
import { createProject, classifyProject, deleteProject } from '../services/projectService.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { createFdeDirective, actOnFdeDirective, getFdeDirectives, readFdeDirectiveNotice } from '../services/fdeDirectiveService.js'
import { cancelFdeTask, feedbackFdeTask, decideFdeTask, getFdeTasks, requestFdeTaskExtension } from '../services/fdeTaskService.js'
import { actOnOaApprovalRequest, listOaApprovalRequests } from '../services/oaWorkflowService.js'
import { createFdeWeeklyPlan, getFdeWeeklyPlans, actOnFdeWeeklyPlan, saveFdeWeeklyPlan } from '../services/fdeWeeklyPlanService.js'
import { createWeeklyReport, actOnWeeklyReport, listWeeklyReports, weeklyReportRecipients } from '../services/fdeWeeklyReportService.js'
import { listTodos, getTodo, updateTodo } from '../services/meetingService.js'
import { closeProjectDirectiveSchedules } from '../services/fdeDirectiveLinksService.js'
import { saveProjectFile, readProjectFileBuffer } from '../services/projectFileStorageService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const marker = randomUUID().slice(0, 8), checks: string[] = [], week = weekStartFor(shanghaiToday())
const accounts = ['投资经理', '投资经理', '投资经理', '董事长', '投资经理', '系统管理员'].map((role, i) => ({ id: randomUUID(), name: `批示-${marker}-${i}`, role, department: `批示-${marker}`, email: `directive-${marker}-${i}@example.invalid`, passwordHash: 'not-for-login' }))
const [owner, secretary, member, leader, outsider, admin] = accounts
async function expectCode(promise: Promise<unknown>, code: string) { const error = await promise.then(() => null, (cause) => cause as { code?: string; message: string }); assert.equal(error?.code, code, `${code}: ${error?.message ?? 'unexpected success'}`) }
try {
  await db.insert(users).values(accounts)
  for (const account of accounts) await identityRepositories.users.synchronizeAdministrationBindings(account.id, account.role, account.department)
  let project = await createProject({ name: `批示隔离闭环-${marker}`, owner: owner.name, ownerUserId: owner.id, collaborators: [], targetDate: shiftDate(week, 90) }, owner.id)
  project = await classifyProject({ projectId: project.id, userId: owner.id, expectedVersion: project.version, toClassification: 'normal', reason: '完成批示夹具项目初筛' })
  await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '配置批示执行与项目权限', assignments: [{ duty: 'secretary', userId: secretary.id }, { duty: 'member', userId: member.id }, { duty: 'member', userId: outsider.id }, { duty: 'concerned_leader', userId: leader.id }] })
  const input = { clientRequestId: randomUUID(), content: `受限批示正文-${marker}`, ownerUserId: member.id, dueAt: `${shiftDate(week, 3)}T16:45`, conversion: 'action', requiresReceipt: true }
  const board = (userId = owner.id) => getFdeDirectives(project.id, userId)
  const row = async (id: string) => (await board()).list.find((item) => item.id === id)!
  const task = async (id: string) => (await getFdeTasks(project.id, owner.id)).tasks.find((item) => item.id === id)!
  const baselineTasks = await db.select().from(todos).where(eq(todos.projectId, project.id))
  const baselineTimes = await db.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.projectId, project.id))
  assert.ok(baselineTimes.every(item => item.sourceTimelineTaskId && !item.sourceDirectiveId))
  const outsiderTaskIds = (await getFdeTasks(project.id, outsider.id)).tasks.map(item => item.id).sort()
  const outsiderTodoIds = (await listTodos(undefined, project.id, { uid: outsider.id, name: outsider.name, role: outsider.role })).map(item => item.id).sort()
  await expectCode(createFdeDirective(project.id, owner.id, input), 'FDE_DIRECTIVE_LEADER_REQUIRED')
  await expectCode(board(admin.id), 'PROJECT_FORBIDDEN')
  await expectCode(createFdeDirective(project.id, leader.id, { ...input, ownerUserId: admin.id }), 'FDE_TASK_OWNER_INVALID')
  const { directiveId } = await createFdeDirective(project.id, leader.id, input)
  assert.deepEqual(await createFdeDirective(project.id, leader.id, input), { directiveId })
  await expectCode(createFdeDirective(project.id, leader.id, { ...input, content: '不许重用请求号改变内容' }), 'FDE_DIRECTIVE_REQUEST_REUSED')
  const created = await row(directiveId), taskId = created.task.id
  assert.equal(created.task.dueTime, '16:45'); assert.equal(created.task.status, '未开始')
  const afterTasks = await db.select().from(todos).where(eq(todos.projectId, project.id))
  assert.equal(afterTasks.length, baselineTasks.length + 1)
  assert.deepEqual(afterTasks.filter(item => item.id !== taskId), baselineTasks)
  assert.equal((await board(outsider.id)).list.length, 0)
  const outsiderTasks = (await getFdeTasks(project.id, outsider.id)).tasks
  assert.deepEqual(outsiderTasks.map(item => item.id).sort(), outsiderTaskIds)
  assert.ok(!JSON.stringify(outsiderTasks).includes(input.content)); assert.ok(!outsiderTasks.some(item => item.id === taskId))
  assert.deepEqual((await listTodos(undefined, project.id, { uid: outsider.id, name: outsider.name, role: outsider.role })).map(item => item.id).sort(), outsiderTodoIds)
  assert.equal(await getTodo(taskId, { uid: outsider.id, name: outsider.name, role: outsider.role }), undefined)
  checks.push('FDE-COLLAB-005/010:stable-leader-unique-task-precise-time-and-cross-entry-resource-isolation')

  await expectCode(cancelFdeTask(project.id, taskId, owner.id, 1, '不能绕过批示进行任务取消'), 'FDE_DIRECTIVE_WITHDRAW_REQUIRED')
  await expectCode(updateTodo(taskId, { status: '已完成' }, 1), 'FDE_TASK_EXECUTION_REQUIRED')
  await expectCode(actOnFdeDirective(project.id, directiveId, owner.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'withdraw', reason: '项目负责人不能代为撤回' }), 'FDE_DIRECTIVE_ISSUER_REQUIRED')
  const notice = (await board(member.id)).notices[0]
  await readFdeDirectiveNotice(project.id, notice.id, member.id)
  const readAt = (await board(member.id)).notices[0].readAt
  await readFdeDirectiveNotice(project.id, notice.id, member.id)
  assert.deepEqual((await board(member.id)).notices[0].readAt, readAt)
  await expectCode(readFdeDirectiveNotice(project.id, notice.id, outsider.id), 'FDE_DIRECTIVE_NOTICE_NOT_FOUND')
  const ack = { clientRequestId: randomUUID(), expectedVersion: 1, action: 'acknowledge', reason: '已收到并安排执行' }
  await actOnFdeDirective(project.id, directiveId, member.id, ack)
  await actOnFdeDirective(project.id, directiveId, member.id, ack)
  assert.equal((await row(directiveId)).version, 2)
  checks.push('FDE-COLLAB-010:issuer-only-withdraw-receipt-idempotency-notice-auth-and-generic-cancel-blocked')

  const weekly = await createFdeWeeklyPlan(project.id, secretary.id, { clientRequestId: randomUUID(), weekStart: week })
  let plan = (await getFdeWeeklyPlans(project.id, secretary.id, week)).plans.find((item) => item.id === weekly.planId)!
  assert.equal(plan.items[0].dueTime, '16:45')
  await saveFdeWeeklyPlan(project.id, plan.id, secretary.id, { clientRequestId: randomUUID(), expectedVersion: plan.version, goal: '执行已发布批示并保留成果证据', manualItems: [] })
  plan = (await getFdeWeeklyPlans(project.id, secretary.id, week)).plans.find((item) => item.id === plan.id)!
  await actOnFdeWeeklyPlan(project.id, plan.id, secretary.id, { clientRequestId: randomUUID(), expectedVersion: plan.version, action: 'submit' })
  plan = (await getFdeWeeklyPlans(project.id, owner.id, week)).plans.find((item) => item.id === plan.id)!
  await actOnFdeWeeklyPlan(project.id, plan.id, owner.id, { clientRequestId: randomUUID(), expectedVersion: plan.version, action: 'publish' })
  assert.equal((await getFdeWeeklyPlans(project.id, outsider.id, week)).plans[0].items.length, 0)
  assert.ok(!JSON.stringify(await getFdeWeeklyPlans(project.id, outsider.id, week)).includes(input.content))
  checks.push('FDE-COLLAB-006/010:weekly-reuses-task-keeps-time-and-restricts-directive-content')

  const extension = { expectedVersion: (await task(taskId)).version, requestedDueDate: created.task.dueDate, requestedDueTime: '17:30', reviewerUserId: owner.id, reason: '客户需要晚些时间反馈' }
  await expectCode(requestFdeTaskExtension(project.id, taskId, member.id, { ...extension, requestedDueTime: null }), 'FDE_EXTENSION_TIME_REQUIRED')
  await requestFdeTaskExtension(project.id, taskId, member.id, extension)
  assert.equal((await task(taskId)).dueTime, '16:45')
  const request = (await db.select().from(oaApprovalRequests).where(eq(oaApprovalRequests.taskId, taskId)))[0]
  const [approvalTodo] = await db.select().from(todos).where(eq(todos.approvalRequestId, request.id))
  assert.equal(approvalTodo.dueTime, '16:45')
  assert.ok(!(await listOaApprovalRequests(outsider.id)).some((item) => item.id === request.id))
  const hiddenApprovalTodos = await listTodos(undefined, project.id, { uid: outsider.id, name: outsider.name, role: outsider.role })
  assert.deepEqual(hiddenApprovalTodos.map(item => item.id).sort(), outsiderTodoIds)
  assert.ok(!hiddenApprovalTodos.some(item => item.id === approvalTodo.id || item.id === taskId))
  await actOnOaApprovalRequest({ userId: owner.id, requestId: request.id, action: 'approve', comment: '同意按新时刻执行', expectedVersion: request.lockVersion })
  assert.equal((await task(taskId)).dueTime, '17:30'); assert.equal((await task(taskId)).dueDate, created.task.dueDate)
  checks.push('FDE-TODO-005/AUTH:same-day-precise-extension-only-approved-time-takes-effect-and-oa-isolated')

  const report = await createWeeklyReport(member.id, { clientRequestId: randomUUID(), weekStart: week, projectIds: [project.id] })
  const recipients = await weeklyReportRecipients(report.reportId, member.id)
  assert.ok(recipients.recipients.some((item) => item.id === owner.id)); assert.ok(!recipients.recipients.some((item) => item.id === outsider.id))
  await expectCode(actOnWeeklyReport(report.reportId, member.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'publish', recipientIds: [outsider.id] }), 'REPORT_DIRECTIVE_SCOPE')
  await actOnWeeklyReport(report.reportId, member.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'publish', recipientIds: [owner.id, secretary.id] })
  assert.ok((await listWeeklyReports(owner.id, week)).reports[0].body.includes('17:30'))
  checks.push('FDE-COLLAB-008/AUTH:report-publication-checks-directive-sources-not-only-project-membership')

  const secretaryDuties = await db.select().from(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, project.id), eq(projectDutyAssignments.userId, secretary.id)))
  await db.delete(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, project.id), eq(projectDutyAssignments.userId, secretary.id)))
  assert.equal((await listWeeklyReports(secretary.id, week)).reports.length, 0)
  assert.equal((await board(secretary.id)).list.length, 0)
  await db.insert(projectDutyAssignments).values(secretaryDuties)
  const memberDuties = await db.select().from(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, project.id), eq(projectDutyAssignments.userId, member.id)))
  const memberships = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, member.id)))
  await db.delete(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, project.id), eq(projectDutyAssignments.userId, member.id)))
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, member.id)))
  assert.equal(await getTodo(taskId, { uid: member.id, name: member.name, role: member.role }), undefined)
  assert.ok(!(await listOaApprovalRequests(member.id)).some((item) => item.id === request.id))
  assert.equal((await listWeeklyReports(member.id, week)).reports[0].body, '')
  await db.insert(projectDutyAssignments).values(memberDuties)
  await db.insert(projectMembers).values(memberships)
  checks.push('FDE-AUTH-003:revoked-directive-duty-and-project-membership-hide-old-report-and-oa-snapshots')

  const fileId = randomUUID(), bytes = Buffer.from(`批示真实成果-${marker}`), sha256 = createHash('sha256').update(bytes).digest('hex'), storagePath = await saveProjectFile(project.id, fileId, bytes)
  await db.insert(projectFiles).values({ id: fileId, projectId: project.id, name: '批示成果.txt', type: 'TXT', category: '项目资料', uploader: member.name, uploadedBy: member.id, storagePath, byteSize: bytes.length, sha256 })
  await db.insert(projectFileVersions).values({ fileId, version: 1, storagePath, byteSize: bytes.length, sha256, createdBy: member.id })
  const chunkId = randomUUID()
  await db.insert(knowledgeChunks).values({ id: chunkId, scope: 'project', refId: project.id, sourceType: 'file', sourceId: fileId, content: '受保留策略保护的批示成果索引' })
  const auditBeforeDelete = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.target, project.name), eq(auditLogs.action, '删除项目(连带知识库)')))
  await expectCode(deleteProject(project.id, owner.id), 'PROJECT_DIRECTIVE_HISTORY_PROTECTED')
  assert.equal((await db.select().from(knowledgeChunks).where(eq(knowledgeChunks.id, chunkId))).length, 1)
  assert.equal((await db.select().from(projects).where(eq(projects.id, project.id))).length, 1)
  assert.deepEqual(await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.target, project.name), eq(auditLogs.action, '删除项目(连带知识库)'))), auditBeforeDelete)
  assert.deepEqual(await readProjectFileBuffer(storagePath), bytes)
  checks.push('FDE-LIFE-004:protected-deletion-keeps-project-knowledge-index-original-file-and-audit-atomic')
  await feedbackFdeTask(project.id, taskId, member.id, { expectedVersion: (await task(taskId)).version, kind: 'submission', progress: 100, result: '按批示提交真实核对成果', evidence: [{ fileId, version: 1 }] })
  assert.equal((await row(directiveId)).status, '待验收')
  const submitted = await task(taskId), decision = { expectedVersion: submitted.version, feedbackId: submitted.feedbacks[0].id, action: 'accept', reason: '经核对符合要求' }
  await expectCode(decideFdeTask(project.id, taskId, member.id, decision), 'FDE_TASK_SELF_ACCEPTANCE')
  const decisions = await Promise.allSettled([owner.id, leader.id].map((userId) => decideFdeTask(project.id, taskId, userId, decision)))
  assert.equal(decisions.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal((await row(directiveId)).status, '已落实')
  assert.equal((await row(directiveId)).capabilities.canWithdraw, false)
  checks.push('FDE-COLLAB-005:real-evidence-independent-concurrent-acceptance-single-authoritative-task')

  const pending = await createFdeDirective(project.id, leader.id, { ...input, clientRequestId: randomUUID(), conversion: 'pending', requiresReceipt: false })
  const pendingTask = (await row(pending.directiveId)).task
  await expectCode(feedbackFdeTask(project.id, pendingTask.id, member.id, { expectedVersion: 1, kind: 'progress', progress: 10, result: '尚未接办不能反馈' }), 'FDE_DIRECTIVE_CONFIRM_REQUIRED')
  await actOnFdeDirective(project.id, pending.directiveId, member.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'acknowledge', reason: '确认接办这项工作' })
  assert.equal((await row(pending.directiveId)).task.status, '未开始')
  const scheduled = await createFdeDirective(project.id, leader.id, { ...input, clientRequestId: randomUUID(), conversion: 'leadership' })
  const schedule = (await row(scheduled.directiveId)).schedules[0]
  assert.equal(schedule.status, 'draft'); assert.equal(schedule.durationMinutes, 30)
  assert.equal(schedule.preferredStart.toISOString(), new Date(`${input.dueAt}:00+08:00`).toISOString())
  const withdraw = { clientRequestId: randomUUID(), expectedVersion: 1, action: 'withdraw', reason: '业务调整不再安排该事项' }
  await actOnFdeDirective(project.id, scheduled.directiveId, leader.id, withdraw)
  await actOnFdeDirective(project.id, scheduled.directiveId, leader.id, withdraw)
  assert.equal((await row(scheduled.directiveId)).schedules[0].status, 'withdrawn')
  assert.equal((await row(scheduled.directiveId)).task.status, '已取消')
  checks.push('FDE-COLLAB-010:pending-confirmation-leadership-draft-not-confirmed-withdrawal-atomic-history')

  assert.deepEqual((await db.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.projectId, project.id))).filter(item => baselineTimes.some(prior => prior.id === item.id)), baselineTimes, '批示操作不改写独立流程来源时间')

  const closing = await createFdeDirective(project.id, leader.id, { ...input, clientRequestId: randomUUID(), conversion: 'leadership' })
  await db.transaction(async (tx) => { await tx.update(projects).set({ lifecycle: 'closed' }).where(eq(projects.id, project.id)); await tx.update(todos).set({ status: '已关闭' }).where(eq(todos.id, (await row(closing.directiveId)).task.id)); await closeProjectDirectiveSchedules(tx, project.id, owner.id, '项目 Close 关闭未确认安排') })
  assert.equal((await row(closing.directiveId)).status, '已关闭')
  assert.equal((await row(closing.directiveId)).schedules[0].status, 'withdrawn')
  await expectCode(createFdeDirective(project.id, leader.id, { ...input, clientRequestId: randomUUID() }), 'FDE_PROJECT_INACTIVE')
  await db.update(users).set({ status: '停用' }).where(eq(users.id, member.id))
  await expectCode(board(member.id), 'USER_DISABLED_OR_MISSING')
  assert.ok((await db.select().from(directiveEvents).where(eq(directiveEvents.directiveId, directiveId))).length >= 5)
  assert.equal((await db.select().from(projectDirectives).where(eq(projectDirectives.projectId, project.id))).length, 4)
  const finalTimes = await db.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.projectId, project.id))
  assert.equal(finalTimes.length, baselineTimes.length + 2)
  assert.deepEqual(finalTimes.filter(item => item.sourceDirectiveId).map(item => item.sourceDirectiveId).sort(), [scheduled.directiveId, closing.directiveId].sort())
  assert.deepEqual(finalTimes.filter(item => !item.sourceDirectiveId).map(item => item.id).sort(), baselineTimes.map(item => item.id).sort())
  assert.ok(finalTimes.every(item => item.status === 'withdrawn'), '项目关闭后原流程来源时间与批示草稿均须受控终结')
  checks.push('FDE-AUTH/LIFE:disabled-users-inactive-projects-and-close-retain-directive-history')
  console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, passed: checks.length, checks }))
} finally { await pool.end() }
