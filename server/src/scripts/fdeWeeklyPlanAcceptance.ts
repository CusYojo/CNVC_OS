import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { projectWeeklyPlanEvents, projectWeeklyPlanItems, projectWeeklyPlanNotices, projectWeeklyPlans, projects, todos, users } from '../db/schema.js'
import { shanghaiToday, shiftDate, weekStartFor } from '../contracts/fdeWeeklyPlanContract.js'
import { createProject, classifyProject } from '../services/projectService.js'
import { identityRepositories } from '../repositories/index.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { createFdeTask, feedbackFdeTask, getFdeTasks, requestFdeTaskExtension } from '../services/fdeTaskService.js'
import { actOnOaApprovalRequest, listOaApprovalRequests } from '../services/oaWorkflowService.js'
import { actOnFdeWeeklyPlan, createFdeWeeklyPlan, getFdeWeeklyPlans, readFdeWeeklyNotice, saveFdeWeeklyPlan } from '../services/fdeWeeklyPlanService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/, '仅允许随机隔离前缀验收')
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const checks: string[] = [], marker = randomUUID().slice(0, 8)
const week = weekStartFor(shanghaiToday())
const accounts = ['投资经理', '投资经理', '投资经理', '投资经理', '董事长', '系统管理员'].map((role, index) => ({ id: randomUUID(), name: `周计划-${marker}-${index}`, role, department: `周协同-${marker}`, email: `fde-week-${marker}-${index}@example.invalid`, passwordHash: 'not-for-login' }))
const [owner, secretary, member, stranger, leader, admin] = accounts
const expectCode = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(() => null, (cause) => cause as { code?: string; message: string })
  assert.equal(error?.code, code, `${code}: ${error?.message ?? 'unexpected success'}`)
}
try {
  await db.insert(users).values(accounts)
  for (const account of accounts) await identityRepositories.users.synchronizeAdministrationBindings(account.id, account.role, account.department)
  let project = await createProject({ name: `周计划闭环-${marker}`, owner: owner.name, ownerUserId: owner.id, collaborators: [], targetDate: shiftDate(week, 90) }, owner.id)
  project = await classifyProject({ projectId: project.id, userId: owner.id, expectedVersion: project.version, toClassification: 'normal', reason: '周计划隔离验收入库初筛' })
  await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '明确秘书、成员及关注领导', assignments: [{ duty: 'secretary', userId: secretary.id }, { duty: 'member', userId: member.id }, { duty: 'concerned_leader', userId: leader.id }] })
  const board = (actor = secretary.id, date = week) => getFdeWeeklyPlans(project.id, actor, date)
  const taskRows = () => db.select().from(todos).where(eq(todos.projectId, project.id))
  const getPlan = async (id: string) => (await board()).plans.find((plan) => plan.id === id)!
  const action = async (id: string, kind: 'reconcile' | 'submit' | 'publish' | 'return' | 'discard', actor = secretary.id, reason = '') => actOnFdeWeeklyPlan(project.id, id, actor, { clientRequestId: randomUUID(), expectedVersion: (await getPlan(id)).version, action: kind, reason })
  const createTask = async (title: string, dueDate: string) => { const input = { clientRequestId: randomUUID(), title, dueDate, ownerUserId: member.id, deliverable: '可核验成果' }; await createFdeTask(project.id, owner.id, input); return input.clientRequestId }
  const currentTask = await createTask('本周执行', shiftDate(week, 1))
  const overdueTask = await createTask('上周遗留', shiftDate(week, -2))
  const futureTask = await createTask('下周执行', shiftDate(week, 8))
  const cancelledTask = await createTask('取消不复活', week)
  await db.update(todos).set({ status: '已取消', closureReason: '隔离夹具终态' }).where(eq(todos.id, cancelledTask))
  const before = (await taskRows()).length
  for (const actor of [owner, member, leader]) await expectCode(createFdeWeeklyPlan(project.id, actor.id, { clientRequestId: randomUUID(), weekStart: week }), 'FDE_WEEKLY_SECRETARY_REQUIRED')
  for (const actor of [stranger, admin]) await expectCode(board(actor.id), 'PROJECT_FORBIDDEN')
  const createInput = { clientRequestId: randomUUID(), weekStart: week }
  const { planId } = await createFdeWeeklyPlan(project.id, secretary.id, createInput)
  assert.equal((await createFdeWeeklyPlan(project.id, secretary.id, createInput)).planId, planId)
  await expectCode(createFdeWeeklyPlan(project.id, secretary.id, { ...createInput, weekStart: shiftDate(week, 7) }), 'FDE_WEEKLY_REQUEST_REUSED')
  await expectCode(createFdeWeeklyPlan(project.id, secretary.id, { ...createInput, clientRequestId: randomUUID() }), 'FDE_WEEKLY_DRAFT_EXISTS')
  assert.equal((await taskRows()).length, before)
  assert.equal((await board(member.id)).plans.length, 0)
  assert.equal((await board(leader.id)).plans.length, 0)
  checks.push('FDE-COLLAB-001:secretary-only-draft-and-project-scope-with-no-task-publication')
  let plan = await getPlan(planId)
  assert.deepEqual(plan.items.map((item) => item.taskId).sort(), [currentTask, overdueTask].sort())
  assert.ok(!plan.items.some((item) => item.taskId === futureTask || item.taskId === cancelledTask))
  const eventCount = (await db.select().from(projectWeeklyPlanEvents)).length
  await board(); await board(owner.id)
  assert.equal((await db.select().from(projectWeeklyPlanEvents)).length, eventCount)
  checks.push('FDE-COLLAB-007:current-and-overdue-selection-excludes-future-cancelled-and-get-is-readonly')
  const manual = { key: randomUUID(), title: '新增访谈安排', ownerUserId: member.id, dueDate: shiftDate(week, 2), deliverable: '访谈结果与证据', priority: '中' }
  const saveInput = { clientRequestId: randomUUID(), expectedVersion: plan.version, goal: '完成本周业务访谈', manualItems: [manual] }
  await expectCode(saveFdeWeeklyPlan(project.id, planId, secretary.id, { ...saveInput, manualItems: [{ ...manual, ownerUserId: stranger.id }] }), 'FDE_WEEKLY_OWNER_INVALID')
  await expectCode(saveFdeWeeklyPlan(project.id, planId, secretary.id, { ...saveInput, manualItems: [{ ...manual, dueDate: shiftDate(week, 7) }] }), 'FDE_WEEKLY_DATE_INVALID')
  await saveFdeWeeklyPlan(project.id, planId, secretary.id, saveInput)
  await saveFdeWeeklyPlan(project.id, planId, secretary.id, saveInput)
  plan = await getPlan(planId)
  assert.equal(plan.version, 2); assert.equal((await taskRows()).length, before)
  await expectCode(saveFdeWeeklyPlan(project.id, planId, secretary.id, { ...saveInput, clientRequestId: randomUUID() }), 'VERSION_CONFLICT')
  checks.push('FDE-COLLAB-006:manual-drafts-validate-identity-date-and-save-replay-without-tasks')
  await action(planId, 'submit')
  await expectCode(action(planId, 'publish', secretary.id), 'FDE_WEEKLY_ACTION_FORBIDDEN')
  assert.equal((await board(owner.id)).notices.filter((notice) => notice.kind === 'review').length, 1)
  const task = (await taskRows()).find((item) => item.id === currentTask)!
  await feedbackFdeTask(project.id, currentTask, member.id, { expectedVersion: task.version, kind: 'progress', progress: 20, result: '本周访谈执行中' })
  assert.equal((await getPlan(planId)).sourceChanged, true)
  await expectCode(action(planId, 'publish', owner.id), 'FDE_WEEKLY_SOURCE_CHANGED')
  await action(planId, 'return', owner.id, '来源已变化请重新对账')
  assert.equal((await board()).notices.filter((notice) => notice.kind === 'returned').length, 1)
  await action(planId, 'reconcile')
  await action(planId, 'submit')
  assert.equal((await board(owner.id)).notices.filter((notice) => notice.kind === 'review').length, 1)
  assert.equal((await board()).notices.filter((notice) => notice.kind === 'returned').length, 0)
  assert.ok((await db.select().from(projectWeeklyPlanNotices).where(and(eq(projectWeeklyPlanNotices.planId, planId), eq(projectWeeklyPlanNotices.kind, 'returned'))))[0]?.closedAt)
  checks.push('FDE-COLLAB-006:submit-freezes-review-and-stale-task-requires-return-reconciliation')
  await db.update(users).set({ status: '停用' }).where(eq(users.id, member.id))
  await expectCode(action(planId, 'publish', owner.id), 'FDE_WEEKLY_OWNER_INVALID')
  await db.update(users).set({ status: '启用' }).where(eq(users.id, member.id))
  plan = await getPlan(planId)
  const publish = { clientRequestId: randomUUID(), expectedVersion: plan.version, action: 'publish' }
  const outcomes = await Promise.allSettled([publish, { ...publish, clientRequestId: randomUUID() }].map((input) => actOnFdeWeeklyPlan(project.id, planId, owner.id, input)))
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1)
  const publishedEvent = (await db.select().from(projectWeeklyPlanEvents).where(and(eq(projectWeeklyPlanEvents.planId, planId), eq(projectWeeklyPlanEvents.action, 'publish'))))[0]
  await actOnFdeWeeklyPlan(project.id, planId, owner.id, { ...publish, clientRequestId: publishedEvent.requestId })
  assert.equal((await taskRows()).length, before + 1)
  assert.equal((await taskRows()).find((item) => item.id === currentTask)?.progress, 20)
  assert.equal((await taskRows()).find((item) => item.id === cancelledTask)?.status, '已取消')
  assert.equal((await board(member.id)).plans.length, 1)
  assert.equal((await board(member.id)).notices.filter((notice) => notice.kind === 'published').length, 1)
  checks.push('FDE-COLLAB-006:concurrent-publish-one-task-one-recipient-notice-and-idempotent-retry')
  plan = await getPlan(planId)
  const frozen = JSON.stringify(plan.items)
  await expectCode(saveFdeWeeklyPlan(project.id, planId, secretary.id, { ...saveInput, clientRequestId: randomUUID(), expectedVersion: plan.version }), 'FDE_WEEKLY_STATE_INVALID')
  const notice = (await board(member.id)).notices.find((item) => item.kind === 'published')!
  await expectCode(readFdeWeeklyNotice(project.id, notice.id, secretary.id), 'FDE_WEEKLY_NOTICE_NOT_FOUND')
  await readFdeWeeklyNotice(project.id, notice.id, member.id)
  assert.ok((await board(member.id)).notices[0].readAt)
  checks.push('FDE-COLLAB-006:published-definition-immutable-and-notice-read-is-recipient-only')
  const [extensionTask] = (await getFdeTasks(project.id, owner.id)).tasks.filter((item) => item.id === currentTask)
  await requestFdeTaskExtension(project.id, currentTask, member.id, { expectedVersion: extensionTask.version, requestedDueDate: shiftDate(week, 5), reason: '需要等待客户提供访谈证据', reviewerUserId: owner.id })
  const extension = (await listOaApprovalRequests(owner.id)).find((item) => item.taskId === currentTask)!
  await actOnOaApprovalRequest({ requestId: extension.id, userId: owner.id, action: 'approve', comment: '同意合理延长执行期限', expectedVersion: extension.lockVersion })
  const second = await createFdeWeeklyPlan(project.id, secretary.id, { clientRequestId: randomUUID(), weekStart: week })
  const secondPlan = await getPlan(second.planId)
  assert.equal(secondPlan.revision, 2)
  assert.equal(secondPlan.items.find((item) => item.taskId === currentTask)?.dueDate, shiftDate(week, 5))
  assert.equal((await getPlan(planId)).items.find((item) => item.taskId === currentTask)?.dueDate, shiftDate(week, 1))
  assert.equal((await getPlan(planId)).items.find((item) => item.taskId === currentTask)?.task?.dueDate, shiftDate(week, 5))
  const persistedItems = await db.select().from(projectWeeklyPlanItems).where(eq(projectWeeklyPlanItems.planId, planId))
  assert.equal(persistedItems.find((item) => item.taskId === currentTask)?.dueDate, shiftDate(week, 1))
  assert.ok(frozen.includes(shiftDate(week, 1)))
  assert.equal((await taskRows()).length, before + 2) // one manual task and one real OA projection
  checks.push('FDE-COLLAB-007:approved-extension-used-by-new-revision-with-old-published-snapshot-retained')
  await action(second.planId, 'discard', secretary.id, '本周暂不追加新计划版本')
  assert.equal((await getPlan(second.planId)).status, 'discarded')
  assert.equal((await taskRows()).find((item) => item.id === currentTask)?.dueDate, shiftDate(week, 5))
  const future = await createFdeWeeklyPlan(project.id, secretary.id, { clientRequestId: randomUUID(), weekStart: shiftDate(week, 7) })
  assert.ok((await board(secretary.id, shiftDate(week, 7))).plans[0].items.some((item) => item.taskId === futureTask))
  await db.update(projects).set({ lifecycle: 'closed' }).where(eq(projects.id, project.id))
  await expectCode(saveFdeWeeklyPlan(project.id, future.planId, secretary.id, { ...saveInput, clientRequestId: randomUUID(), expectedVersion: 1, manualItems: [] }), 'FDE_PROJECT_INACTIVE')
  assert.equal((await board()).canDraft, false)
  await db.update(projects).set({ lifecycle: 'active' }).where(eq(projects.id, project.id))
  checks.push('FDE-LIFE-001:discard-retains-tasks-and-closed-project-rejects-weekly-writes')
  assert.ok((await db.select().from(projectWeeklyPlans).where(eq(projectWeeklyPlans.projectId, project.id))).length >= 3)
  assert.ok((await db.select().from(projectWeeklyPlanNotices).where(eq(projectWeeklyPlanNotices.planId, planId))).some((item) => item.closedAt))
  console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, checks, passed: checks.length }))
} finally { await pool.end() }
