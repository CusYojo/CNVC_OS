import { createHash, randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { meetings, projectDutyAssignments, projectMembers, projectPlanActions, projectPlans, projectTimelineSyncs, projectWeeklyPlanEvents, projectWeeklyPlanItems, projectWeeklyPlanNotices, projectWeeklyPlans, projects, roles, todos, userRoles, users } from '../db/schema.js'
import { nextMeetingWeek } from '../contracts/fdeFridayMeetingContract.js'
import { fdeWeekStart, shiftDate, taskInWeek, weeklyActionSchema, weeklyCreateSchema, weeklySaveSchema, type WeeklyManualItem } from '../contracts/fdeWeeklyPlanContract.js'
import { projectAccessCondition } from './projectAccessService.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { materializeFdePlanTasks, prepareFdeTodo } from './fdeTaskService.js'
import { directiveTaskAccessCondition } from './fdeDirectiveLinksService.js'
import { reconcileWeeklyLeaderTimes } from './fdeTimelineTimeService.js'

type Reader = Pick<typeof db, 'select'>
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Project = typeof projects.$inferSelect
type Plan = typeof projectWeeklyPlans.$inferSelect
type Item = typeof projectWeeklyPlanItems.$inferInsert
const fail = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }) }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function context(reader: Reader, projectId: string, userId: string) {
  const [actor] = await reader.select().from(users).where(and(eq(users.id, userId), eq(users.status, '启用')))
  if (!actor) return fail('USER_DISABLED_OR_MISSING', '当前账号不可用', 403)
  const [project] = await reader.select().from(projects).where(and(eq(projects.id, projectId), projectAccessCondition({ uid: actor.id, name: actor.name, role: actor.role })))
  if (!project) return fail('PROJECT_FORBIDDEN', '无权访问当前项目', 403)
  if (project.workflowModel !== 'fde-v1') return fail('FDE_LEGACY_PROJECT', '历史项目保留原协作流程')
  const [secretary] = await reader.select({ id: projectDutyAssignments.id }).from(projectDutyAssignments)
    .innerJoin(userRoles, eq(userRoles.userId, projectDutyAssignments.userId)).innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(projectDutyAssignments.projectId, projectId), eq(projectDutyAssignments.userId, userId), eq(projectDutyAssignments.duty, 'secretary'), eq(roles.status, '启用'), inArray(roles.fdeCategory, ['secretary', 'project_lead', 'member']))).limit(1)
  return { project, actor, canDraft: Boolean(secretary), canPublish: project.ownerUserId === userId }
}

async function writeContext(tx: Tx, projectId: string, userId: string) {
  // 与任务、治理、OA 保持同样的 project-first 锁顺序。
  await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
  const result = await context(tx, projectId, userId)
  if (result.project.lifecycle !== 'active') return fail('FDE_PROJECT_INACTIVE', '关闭或归档项目不能修改周计划')
  return result
}

async function roster(reader: Reader, project: Project) {
  return reader.select({ id: users.id, name: users.name }).from(users)
    .where(and(eq(users.status, '启用'), or(eq(users.id, project.ownerUserId ?? ''), inArray(users.id, reader.select({ id: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, project.id)))))).orderBy(asc(users.name), asc(users.id))
}

export { context as fdeWeeklyProjectContext, roster as fdeWeeklyRoster }

// Caller owns the project-first transaction. Both meeting linkage and draft are committed together.
export async function seedWeeklyPlanFromMeeting(tx: Tx, projectId: string, meetingId: string, userId: string, requestId: string) {
  const { project, canDraft } = await writeContext(tx, projectId, userId)
  if (!canDraft) return fail('FDE_WEEKLY_SECRETARY_REQUIRED', '只有项目推进秘书可以生成下周计划草稿', 403)
  const [meeting] = await tx.select().from(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.projectId, projectId)))
  if (meeting?.workflowKind !== 'friday' || meeting.workflowStatus !== 'completed' || !meeting.weeklyReview) return fail('FDE_MEETING_NOT_CONFIRMED', '请先人工确认例会纪要')
  const [derived] = await tx.select().from(projectWeeklyPlans).where(and(eq(projectWeeklyPlans.sourceMeetingId, meetingId), ne(projectWeeklyPlans.status, 'discarded'))).limit(1)
  if (derived) return fail('FDE_MEETING_PLAN_EXISTS', '本次例会已生成下周计划，请继续原计划；已发布计划不能重复派生')
  const weekStart = nextMeetingWeek(meeting.startedAt), activeKey = `${projectId}:${weekStart}`
  const [active] = await tx.select().from(projectWeeklyPlans).where(eq(projectWeeklyPlans.activeKey, activeKey))
  if (active) return fail('FDE_WEEKLY_DRAFT_EXISTS', '下周已有草稿或待确认版本，不能覆盖；请先处理现有计划')
  const review = meeting.weeklyReview
  validateManual(review.nextActions, weekStart, project.targetDate, new Set((await roster(tx, project)).map((member) => member.id)))
  const [latest] = await tx.select().from(projectWeeklyPlans).where(and(eq(projectWeeklyPlans.projectId, projectId), eq(projectWeeklyPlans.weekStart, weekStart))).orderBy(desc(projectWeeklyPlans.revision)).limit(1)
  const planId = randomUUID()
  await tx.insert(projectWeeklyPlans).values({ id: planId, projectId, weekStart, revision: (latest?.revision ?? 0) + 1, activeKey, goal: review.nextGoal, sourceFingerprint: '', createdBy: userId, sourceMeetingId: meetingId, sourceMeetingVersion: meeting.version })
  const [plan] = await tx.select().from(projectWeeklyPlans).where(eq(projectWeeklyPlans.id, planId))
  await syncDraft(tx, plan, project)
  if (review.nextActions.length) await tx.insert(projectWeeklyPlanItems).values(review.nextActions.map(({ key, ...item }, index) => ({ ...item, planId, itemKey: `manual:${key}`, sourceKind: 'manual', sortOrder: 1000 + index })))
  await record(tx, planId, userId, requestId, hash({ kind: 'meeting', projectId, meetingId, version: meeting.version, userId, requestId }), 'meeting', `来自已确认例会 ${meetingId} v${meeting.version}`)
  return { planId, weekStart }
}

async function sources(reader: Reader, project: Project, weekStart: string) {
  const taskRows = await reader.select().from(todos).where(and(eq(todos.projectId, project.id), isNull(todos.approvalRequestId), ne(todos.type, '流程'))).orderBy(asc(todos.id))
  const [approved] = await reader.select().from(projectPlans).where(and(eq(projectPlans.projectId, project.id), eq(projectPlans.status, 'locked'))).orderBy(desc(projectPlans.revision)).limit(1)
  const actions = approved ? await reader.select().from(projectPlanActions).where(eq(projectPlanActions.planId, approved.id)).orderBy(asc(projectPlanActions.id)) : []
  const items: Omit<Item, 'planId' | 'sortOrder'>[] = []
  for (const task of taskRows.filter((item) => taskInWeek(item, weekStart))) {
    if (!task.ownerUserId) return fail('FDE_WEEKLY_SOURCE_OWNER_MISSING', '本周来源任务缺少稳定负责人，请先修复任务身份')
    items.push({ itemKey: `task:${task.id}`, sourceKind: 'task', taskId: task.id, planActionId: task.planActionId, sourceVersion: task.version, title: task.title, ownerUserId: task.ownerUserId, dueDate: task.dueDate!, dueTime: task.dueTime, deliverable: task.deliverable ?? '', priority: task.priority })
  }
  for (const action of actions) {
    if (taskRows.some((task) => task.planActionId === action.id) || !taskInWeek(action, weekStart)) continue
    items.push({ itemKey: `plan:${action.id}`, sourceKind: 'plan', planActionId: action.id, sourceVersion: action.version, title: action.title, ownerUserId: action.ownerUserId, dueDate: action.dueDate, deliverable: action.deliverable, priority: '中' })
  }
  if (items.length > 500) return fail('FDE_WEEKLY_SOURCE_LIMIT', '本周来源超过 500 项，请先清理历史未结束事项，不能截断发布')
  const fingerprint = hash({ governance: project.governanceVersion, stage: project.stage, target: project.targetDate, approvedPlan: approved ? { id: approved.id, version: approved.version } : null, items })
  return { items, fingerprint, approved, taskRows }
}

async function planItems(reader: Reader, planId: string) {
  return reader.select().from(projectWeeklyPlanItems).where(eq(projectWeeklyPlanItems.planId, planId)).orderBy(asc(projectWeeklyPlanItems.sortOrder), asc(projectWeeklyPlanItems.id))
}
async function findPlan(tx: Tx, projectId: string, planId: string, version: number) {
  const [plan] = await tx.select().from(projectWeeklyPlans).where(and(eq(projectWeeklyPlans.id, planId), eq(projectWeeklyPlans.projectId, projectId)))
  if (!plan) return fail('FDE_WEEKLY_PLAN_NOT_FOUND', '周计划不存在', 404)
  if (plan.version !== version) return fail('VERSION_CONFLICT', '周计划已被修改，请刷新后重试')
  return plan
}
async function replay(tx: Tx, requestId: string, requestHash: string) {
  const [event] = await tx.select().from(projectWeeklyPlanEvents).where(eq(projectWeeklyPlanEvents.requestId, requestId))
  if (event && event.requestHash !== requestHash) return fail('FDE_WEEKLY_REQUEST_REUSED', '请求编号已用于其他操作，请重新打开操作')
  return event
}
async function record(tx: Tx, planId: string, actorId: string, requestId: string, requestHash: string, action: string, reason = '') {
  const [plan] = await tx.select().from(projectWeeklyPlans).where(eq(projectWeeklyPlans.id, planId))
  const items = await planItems(tx, planId)
  await tx.insert(projectWeeklyPlanEvents).values({ planId, actorId, requestId, requestHash, action, reason, planVersion: plan.version, snapshot: { plan, items } })
  const identity = createMySqlIdentityRepositoryContext(tx)
  const actor = await identity.users.findById(actorId)
  await identity.audits.append({ userId: actorId, userName: actor?.name ?? '未知用户', module: '周计划', action, target: `${plan.projectId} / ${planId} / v${plan.version} / ${requestId} / ${reason}` })
}
async function syncDraft(tx: Tx, plan: Plan, project: Project) {
  const source = await sources(tx, project, plan.weekStart)
  // 仅替换草稿内的来源快照；正式任务、旧事件和发布版本不受影响。
  await tx.delete(projectWeeklyPlanItems).where(and(eq(projectWeeklyPlanItems.planId, plan.id), ne(projectWeeklyPlanItems.sourceKind, 'manual')))
  if (source.items.length) await tx.insert(projectWeeklyPlanItems).values(source.items.map((item, index) => ({ ...item, planId: plan.id, sortOrder: index })))
  await tx.update(projectWeeklyPlans).set({ sourceFingerprint: source.fingerprint }).where(eq(projectWeeklyPlans.id, plan.id))
}
function validateManual(items: WeeklyManualItem[], weekStart: string, target: string | null, memberIds: Set<string>) {
  for (const item of items) {
    if (item.needLeader && !item.dueTime) return fail('FDE_WEEKLY_LEADER_TIME_REQUIRED', '需领导参与的人工行动必须填写精确截止时刻', 400)
    if (!memberIds.has(item.ownerUserId)) return fail('FDE_WEEKLY_OWNER_INVALID', '新增行动负责人必须是启用的项目成员', 403)
    if (item.dueDate < weekStart || item.dueDate > shiftDate(weekStart, 6)) return fail('FDE_WEEKLY_DATE_INVALID', '新增行动截止日期必须位于本周', 400)
    if (target && item.dueDate > target) return fail('FDE_WEEKLY_EXCEEDS_PROJECT', '新增行动超过项目最终日期，须先审批调整计划')
  }
}

export async function createFdeWeeklyPlan(projectId: string, userId: string, raw: unknown) {
  const input = weeklyCreateSchema.parse(raw), requestHash = hash({ projectId, userId, kind: 'create', input })
  const planId = await db.transaction(async (tx) => {
    const { project, canDraft } = await writeContext(tx, projectId, userId)
    if (!canDraft) return fail('FDE_WEEKLY_SECRETARY_REQUIRED', '只有项目推进秘书可以草拟周计划', 403)
    const previousRequest = await replay(tx, input.clientRequestId, requestHash)
    if (previousRequest) return previousRequest.planId
    const activeKey = `${projectId}:${input.weekStart}`
    const [active] = await tx.select().from(projectWeeklyPlans).where(eq(projectWeeklyPlans.activeKey, activeKey))
    if (active) return fail('FDE_WEEKLY_DRAFT_EXISTS', '本周已有草稿或待确认版本，请继续处理现有计划')
    const [latest] = await tx.select().from(projectWeeklyPlans).where(and(eq(projectWeeklyPlans.projectId, projectId), eq(projectWeeklyPlans.weekStart, input.weekStart))).orderBy(desc(projectWeeklyPlans.revision)).limit(1)
    const id = randomUUID()
    await tx.insert(projectWeeklyPlans).values({ id, projectId, weekStart: input.weekStart, revision: (latest?.revision ?? 0) + 1, activeKey, goal: latest?.goal ?? '', sourceFingerprint: '', createdBy: userId })
    const [plan] = await tx.select().from(projectWeeklyPlans).where(eq(projectWeeklyPlans.id, id))
    await syncDraft(tx, plan, project)
    await record(tx, id, userId, input.clientRequestId, requestHash, 'create')
    return id
  })
  return { planId }
}

export async function saveFdeWeeklyPlan(projectId: string, planId: string, userId: string, raw: unknown) {
  const input = weeklySaveSchema.parse(raw), requestHash = hash({ projectId, planId, userId, kind: 'save', input })
  await db.transaction(async (tx) => {
    const { project, canDraft } = await writeContext(tx, projectId, userId)
    if (!canDraft) return fail('FDE_WEEKLY_SECRETARY_REQUIRED', '只有项目推进秘书可以编辑草稿', 403)
    if (await replay(tx, input.clientRequestId, requestHash)) return
    const plan = await findPlan(tx, projectId, planId, input.expectedVersion)
    if (plan.status !== 'draft') return fail('FDE_WEEKLY_STATE_INVALID', '只有草稿可以编辑；已发布计划请创建新版本')
    validateManual(input.manualItems, plan.weekStart, project.targetDate, new Set((await roster(tx, project)).map((member) => member.id)))
    await tx.delete(projectWeeklyPlanItems).where(and(eq(projectWeeklyPlanItems.planId, planId), eq(projectWeeklyPlanItems.sourceKind, 'manual')))
    if (input.manualItems.length) await tx.insert(projectWeeklyPlanItems).values(input.manualItems.map(({ key, ...item }, index) => ({ ...item, planId, itemKey: `manual:${key}`, sourceKind: 'manual', sortOrder: 1000 + index })))
    await tx.update(projectWeeklyPlans).set({ goal: input.goal, version: plan.version + 1, updatedAt: new Date() }).where(eq(projectWeeklyPlans.id, planId))
    await record(tx, planId, userId, input.clientRequestId, requestHash, 'save')
  })
  return { planId }
}

export async function actOnFdeWeeklyPlan(projectId: string, planId: string, userId: string, raw: unknown) {
  const input = weeklyActionSchema.parse(raw), requestHash = hash({ projectId, planId, userId, input })
  await db.transaction(async (tx) => {
    const { project, canDraft, canPublish } = await writeContext(tx, projectId, userId)
    if (input.action === 'sync-leader-time' ? !canPublish && !canDraft : ['publish', 'return'].includes(input.action) ? !canPublish : !canDraft) return fail('FDE_WEEKLY_ACTION_FORBIDDEN', '秘书维护草稿，项目负责人确认发布或退回', 403)
    if (await replay(tx, input.clientRequestId, requestHash)) return
    const plan = await findPlan(tx, projectId, planId, input.expectedVersion)
    if (input.action === 'sync-leader-time') {
      if (plan.status !== 'published') return fail('FDE_WEEKLY_STATE_INVALID', '只有已发布计划可以核对正式领导需求')
      await reconcileWeeklyLeaderTimes(tx, projectId, userId, `weekly-reconcile:${input.clientRequestId}`)
      await record(tx, planId, userId, input.clientRequestId, requestHash, input.action, input.reason)
      return
    }
    const expectedState = ['publish', 'return'].includes(input.action) ? 'submitted' : 'draft'
    if (plan.status !== expectedState) return fail('FDE_WEEKLY_STATE_INVALID', '当前周计划状态不能执行该操作')
    const nextVersion = plan.version + 1
    if (input.action === 'reconcile') await syncDraft(tx, plan, project)
    if (['submit', 'publish'].includes(input.action)) {
      if (plan.sourceMeetingId) {
        const [meeting] = await tx.select().from(meetings).where(eq(meetings.id, plan.sourceMeetingId))
        if (meeting?.workflowStatus !== 'completed' || meeting.version !== plan.sourceMeetingVersion) return fail('FDE_WEEKLY_MEETING_CHANGED', '来源例会已变化，不能发布旧纪要派生的计划')
      }
      const source = await sources(tx, project, plan.weekStart)
      if (source.fingerprint !== plan.sourceFingerprint) return fail('FDE_WEEKLY_SOURCE_CHANGED', '任务、期限或项目职责已变化，请退回草稿并重新对账确认')
      const items = await planItems(tx, planId)
      if (!plan.goal.trim() || !items.length) return fail('FDE_WEEKLY_INCOMPLETE', '请填写本周目标并至少保留一项行动')
      const members = new Set((await roster(tx, project)).map((member) => member.id))
      if (items.some((item) => !members.has(item.ownerUserId))) return fail('FDE_WEEKLY_OWNER_INVALID', '计划包含已停用或已移出项目的负责人', 403)
      validateManual(items.filter((item) => item.sourceKind === 'manual').map((item) => ({ key: item.itemKey.slice(7), title: item.title, ownerUserId: item.ownerUserId, dueDate: item.dueDate, dueTime: item.dueTime, needLeader: item.needLeader, deliverable: item.deliverable, priority: item.priority as WeeklyManualItem['priority'] })), plan.weekStart, project.targetDate, members)
      const [owner] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, project.ownerUserId ?? ''), eq(users.status, '启用')))
      if (!owner) return fail('FDE_WEEKLY_REVIEWER_MISSING', '项目负责人已停用或缺失，不能提交或发布')
      if (input.action === 'submit') {
        await tx.insert(projectWeeklyPlanNotices).values({ planId, recipientId: owner.id, kind: 'review', planVersion: nextVersion })
      } else {
        if (items.some((item) => item.sourceKind === 'plan') && source.approved) await materializeFdePlanTasks(tx, projectId, source.approved.id)
        for (const item of items) {
          if (item.sourceKind === 'manual') {
            const prepared = await prepareFdeTodo(tx, { projectId, meetingId: plan.sourceMeetingId, title: item.title, owner: '', ownerUserId: item.ownerUserId, dueDate: item.dueDate, dueTime: item.dueTime, deliverable: item.deliverable, priority: item.priority, type: '待办' }, userId)
            const taskId = randomUUID()
            await tx.insert(todos).values({ ...prepared, id: taskId })
            await tx.update(projectWeeklyPlanItems).set({ taskId, sourceVersion: 1, sourceStage: item.needLeader ? project.stage : null }).where(eq(projectWeeklyPlanItems.id, item.id))
          } else if (item.sourceKind === 'plan') {
            const [task] = await tx.select().from(todos).where(eq(todos.planActionId, item.planActionId!))
            if (!task) return fail('FDE_WEEKLY_TASK_MISSING', '已批准计划任务生成失败')
            await tx.update(projectWeeklyPlanItems).set({ taskId: task.id, sourceVersion: task.version }).where(eq(projectWeeklyPlanItems.id, item.id))
          }
        }
        const recipients = [...new Set(items.map((item) => item.ownerUserId))]
        await tx.insert(projectWeeklyPlanNotices).values(recipients.map((recipientId) => ({ planId, recipientId, kind: 'published', planVersion: nextVersion })))
      }
    }
    if (['publish', 'return', 'discard'].includes(input.action)) await tx.update(projectWeeklyPlanNotices).set({ closedAt: new Date() }).where(and(eq(projectWeeklyPlanNotices.planId, planId), eq(projectWeeklyPlanNotices.kind, 'review'), isNull(projectWeeklyPlanNotices.closedAt)))
    // 重新送审或终结草稿后，旧的“请修改”通知不再是有效待办，历史仍保留。
    if (['submit', 'publish', 'discard'].includes(input.action)) await tx.update(projectWeeklyPlanNotices).set({ closedAt: new Date() }).where(and(eq(projectWeeklyPlanNotices.planId, planId), eq(projectWeeklyPlanNotices.kind, 'returned'), isNull(projectWeeklyPlanNotices.closedAt)))
    if (input.action === 'return') await tx.insert(projectWeeklyPlanNotices).values({ planId, recipientId: plan.createdBy, kind: 'returned', planVersion: nextVersion })
    await tx.update(projectWeeklyPlans).set({
      version: nextVersion, updatedAt: new Date(),
      ...(input.action === 'submit' ? { status: 'submitted' } : {}),
      ...(input.action === 'return' ? { status: 'draft' } : {}),
      ...(input.action === 'publish' ? { status: 'published', activeKey: null, publishedAt: new Date(), publishedBy: userId } : {}),
      ...(input.action === 'discard' ? { status: 'discarded', activeKey: null } : {}),
    }).where(eq(projectWeeklyPlans.id, planId))
    if (input.action === 'publish') await reconcileWeeklyLeaderTimes(tx, projectId, userId, `weekly-publish:${planId}:${nextVersion}`)
    await record(tx, planId, userId, input.clientRequestId, requestHash, input.action, input.reason)
  })
  return { planId }
}

export async function getFdeWeeklyPlans(projectId: string, userId: string, requestedWeek: string) {
  const weekStart = fdeWeekStart.parse(requestedWeek)
  return db.transaction(async (tx) => {
    const { project, canDraft, canPublish } = await context(tx, projectId, userId)
    const source = await sources(tx, project, weekStart)
    const planRows = await tx.select().from(projectWeeklyPlans).where(and(eq(projectWeeklyPlans.projectId, projectId), eq(projectWeeklyPlans.weekStart, weekStart), canDraft || canPublish ? undefined : eq(projectWeeklyPlans.status, 'published'))).orderBy(desc(projectWeeklyPlans.revision))
    const taskById = new Map(source.taskRows.map((task) => [task.id, task]))
    const weeklySources = await tx.select({ taskId: projectWeeklyPlanItems.taskId, planId: projectWeeklyPlanItems.planId, itemId: projectWeeklyPlanItems.id, stage: projectWeeklyPlanItems.sourceStage }).from(projectWeeklyPlanItems)
      .innerJoin(projectWeeklyPlans, eq(projectWeeklyPlans.id, projectWeeklyPlanItems.planId))
      .where(and(eq(projectWeeklyPlans.projectId, projectId), eq(projectWeeklyPlans.status, 'published'), eq(projectWeeklyPlanItems.sourceKind, 'manual'), eq(projectWeeklyPlanItems.needLeader, true)))
    const weeklySourceByTask = new Map(weeklySources.map(({ taskId, ...source }) => [taskId, source]))
    const visibleTasks = new Set((await tx.select({ id: todos.id }).from(todos).where(and(eq(todos.projectId, projectId), directiveTaskAccessCondition(userId)))).map((task) => task.id))
    const plans = await Promise.all(planRows.map(async (plan) => {
      const items = await planItems(tx, plan.id)
      const events = await tx.select({ id: projectWeeklyPlanEvents.id, action: projectWeeklyPlanEvents.action, version: projectWeeklyPlanEvents.planVersion, actorId: projectWeeklyPlanEvents.actorId, reason: projectWeeklyPlanEvents.reason, createdAt: projectWeeklyPlanEvents.createdAt }).from(projectWeeklyPlanEvents).where(eq(projectWeeklyPlanEvents.planId, plan.id)).orderBy(desc(projectWeeklyPlanEvents.planVersion))
      const visibleItems = items.filter((item) => !item.taskId || visibleTasks.has(item.taskId)), restricted = visibleItems.length !== items.length
      return { ...plan, goal: restricted ? '计划含受限事项，仅展示您有权访问的任务。' : plan.goal, sourceFingerprint: restricted ? '' : plan.sourceFingerprint, sourceChanged: ['draft', 'submitted'].includes(plan.status) && source.fingerprint !== plan.sourceFingerprint,
        items: visibleItems.map((item) => { const task = item.taskId ? taskById.get(item.taskId) : null; return { ...item, leaderTimeSource: item.taskId ? weeklySourceByTask.get(item.taskId) ?? null : null, task: task ? { id: task.id, version: task.version, status: task.status, progress: task.progress, dueDate: task.dueDate, dueTime: task.dueTime } : null } }), events: restricted ? [] : events }
    }))
    const ids = plans.map((plan) => plan.id)
    const notices = ids.length ? await tx.select().from(projectWeeklyPlanNotices).where(and(inArray(projectWeeklyPlanNotices.planId, ids), eq(projectWeeklyPlanNotices.recipientId, userId), isNull(projectWeeklyPlanNotices.closedAt))).orderBy(desc(projectWeeklyPlanNotices.createdAt)) : []
    const leaderTimePending = await tx.select({ id: projectTimelineSyncs.id, issues: projectTimelineSyncs.issues }).from(projectTimelineSyncs).where(and(eq(projectTimelineSyncs.projectId, projectId), eq(projectTimelineSyncs.source, 'weekly'), eq(projectTimelineSyncs.status, 'pending'))).orderBy(desc(projectTimelineSyncs.createdAt)).limit(20)
    const [pendingCount] = await tx.select({ count: sql<number>`count(*)` }).from(projectTimelineSyncs).where(and(eq(projectTimelineSyncs.projectId, projectId), eq(projectTimelineSyncs.source, 'weekly'), eq(projectTimelineSyncs.status, 'pending')))
    return { weekStart, weekEnd: shiftDate(weekStart, 6), canDraft: canDraft && project.lifecycle === 'active', canPublish: canPublish && project.lifecycle === 'active', members: await roster(tx, project), plans, notices, leaderTimePending, leaderTimePendingCount: Number(pendingCount.count) }
  })
}

export async function readFdeWeeklyNotice(projectId: string, noticeId: string, userId: string) {
  await db.transaction(async (tx) => {
    await context(tx, projectId, userId)
    const [notice] = await tx.select({ id: projectWeeklyPlanNotices.id }).from(projectWeeklyPlanNotices).innerJoin(projectWeeklyPlans, eq(projectWeeklyPlans.id, projectWeeklyPlanNotices.planId))
      .where(and(eq(projectWeeklyPlanNotices.id, noticeId), eq(projectWeeklyPlanNotices.recipientId, userId), eq(projectWeeklyPlans.projectId, projectId)))
    if (!notice) return fail('FDE_WEEKLY_NOTICE_NOT_FOUND', '通知不存在或不属于当前用户', 404)
    await tx.update(projectWeeklyPlanNotices).set({ readAt: new Date() }).where(and(eq(projectWeeklyPlanNotices.id, noticeId), isNull(projectWeeklyPlanNotices.readAt)))
  })
  return { ok: true }
}
