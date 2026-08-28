import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { directiveEvents, directiveNotices, leaderTimeRequests, projectDirectives, projects, roles, todos, userRoles, users } from '../db/schema.js'
import { directiveActionSchema, directiveCreateSchema, directiveStatus } from '../contracts/fdeDirectiveContract.js'
import { taskTerminal } from '../contracts/fdeTaskContract.js'
import { fdeWeeklyProjectContext, fdeWeeklyRoster } from './fdeWeeklyPlanService.js'
import { closeTaskExtensions, prepareFdeTodo } from './fdeTaskService.js'
import { directiveDigest, directiveTaskAccessCondition, recordDirectiveEvent } from './fdeDirectiveLinksService.js'
import { closeTimeRequests } from './fdeTimeEventsService.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'select'>
const fail = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }) }
async function isLeader(reader: Reader, userId: string) {
  const [role] = await reader.select({ id: roles.id }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.userId, userId), eq(roles.status, '启用'), eq(roles.fdeCategory, 'institution_leader'))).limit(1)
  return Boolean(role)
}
async function writeContext(tx: Tx, projectId: string, userId: string) {
  await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
  const result = await fdeWeeklyProjectContext(tx, projectId, userId)
  if (result.project.lifecycle !== 'active') return fail('FDE_PROJECT_INACTIVE', '关闭或归档项目不能继续处理批示')
  return result
}
async function replay(tx: Tx, requestId: string, requestHash: string) {
  const [event] = await tx.select().from(directiveEvents).where(eq(directiveEvents.requestId, requestId))
  if (event && event.requestHash !== requestHash) return fail('FDE_DIRECTIVE_REQUEST_REUSED', '请求编号已用于其他内容，请重新打开操作')
  return event
}

export async function createFdeDirective(projectId: string, userId: string, raw: unknown) {
  const input = directiveCreateSchema.parse(raw), requestHash = directiveDigest({ projectId, userId, input })
  return db.transaction(async (tx) => {
    const { project } = await writeContext(tx, projectId, userId)
    if (!await isLeader(tx, userId)) return fail('FDE_DIRECTIVE_LEADER_REQUIRED', '仅有项目权限的机构领导可以发布批示', 403)
    const previous = await replay(tx, input.clientRequestId, requestHash)
    if (previous) return { directiveId: previous.directiveId }
    const dueDate = input.dueAt.slice(0, 10), dueTime = input.dueAt.slice(11, 16)
    if (project.targetDate && dueDate > project.targetDate) return fail('FDE_DIRECTIVE_EXCEEDS_PROJECT', '批示期限超过项目最终日期，请先审批调整正式计划')
    const taskId = randomUUID(), directiveId = randomUUID()
    const task = await prepareFdeTodo(tx, { projectId, title: input.content.slice(0, 255), owner: '', ownerUserId: input.ownerUserId, dueDate, dueTime, deliverable: '按批示要求提交实际成果与证据', type: '待办' }, userId)
    await tx.insert(todos).values({ ...task, id: taskId, status: input.conversion === 'pending' ? '待确认' : '未开始' })
    await tx.insert(projectDirectives).values({ id: directiveId, projectId, taskId, issuerId: userId, content: input.content, conversion: input.conversion, requiresReceipt: input.requiresReceipt })
    if (input.conversion === 'leadership') {
      const preferredStart = new Date(`${input.dueAt}:00+08:00`)
      await tx.insert(leaderTimeRequests).values({ projectId, sourceDirectiveId: directiveId, taskId, leaderId: userId, submittedBy: userId, title: input.content, preferredStart, alternativeStart: new Date(preferredStart.getTime() + 86400000), durationMinutes: 30 })
    }
    await recordDirectiveEvent(tx, directiveId, userId, 'publish', '', input.clientRequestId, requestHash)
    return { directiveId }
  })
}

export async function actOnFdeDirective(projectId: string, directiveId: string, userId: string, raw: unknown) {
  const input = directiveActionSchema.parse(raw), requestHash = directiveDigest({ projectId, directiveId, userId, input })
  return db.transaction(async (tx) => {
    await writeContext(tx, projectId, userId)
    const [entry] = await tx.select({ directive: projectDirectives, task: todos }).from(projectDirectives).innerJoin(todos, eq(todos.id, projectDirectives.taskId))
      .where(and(eq(projectDirectives.id, directiveId), eq(projectDirectives.projectId, projectId), directiveTaskAccessCondition(userId)))
    if (!entry) return fail('FDE_DIRECTIVE_FORBIDDEN', '批示不存在或无权访问', 403)
    const { directive, task } = entry
    if (input.action === 'withdraw' && (directive.issuerId !== userId || !await isLeader(tx, userId))) return fail('FDE_DIRECTIVE_ISSUER_REQUIRED', '仅发出批示且当前有权的领导可以撤回', 403)
    if (input.action === 'acknowledge' && task.ownerUserId !== userId) return fail('FDE_DIRECTIVE_OWNER_REQUIRED', '只有执行人可以提交回执或确认接办', 403)
    if (await replay(tx, input.clientRequestId, requestHash)) return { directiveId }
    if (directive.version !== input.expectedVersion) return fail('VERSION_CONFLICT', '批示或关联任务已变化，请刷新后重试')
    if (directive.withdrawnAt || taskTerminal(task.status)) return fail('FDE_DIRECTIVE_CLOSED', '批示已结束，不能重复处理')
    if (input.action === 'acknowledge') {
      if (directive.acknowledgedAt) return fail('FDE_DIRECTIVE_ACKNOWLEDGED', '已经提交回执，不需要重复确认')
      await tx.update(projectDirectives).set({ acknowledgedAt: new Date(), acknowledgedBy: userId, version: directive.version + 1 }).where(eq(projectDirectives.id, directiveId))
      if (task.status === '待确认') await tx.update(todos).set({ status: '未开始', version: task.version + 1 }).where(eq(todos.id, task.id))
    } else {
      await tx.update(projectDirectives).set({ withdrawnAt: new Date(), withdrawalReason: input.reason, version: directive.version + 1 }).where(eq(projectDirectives.id, directiveId))
      await tx.update(todos).set({ status: '已取消', closureReason: input.reason, version: task.version + 1 }).where(eq(todos.id, task.id))
      await closeTimeRequests(tx, projectId, userId, `批示撤回：${input.reason}`, directiveId)
      await closeTaskExtensions(tx, [task.id], userId, `批示撤回：${input.reason}`)
    }
    await recordDirectiveEvent(tx, directiveId, userId, input.action, input.reason, input.clientRequestId, requestHash)
    return { directiveId }
  })
}

export async function getFdeDirectives(projectId: string, userId: string) {
  return db.transaction(async (tx) => {
    const { project } = await fdeWeeklyProjectContext(tx, projectId, userId), leader = await isLeader(tx, userId)
    const entries = await tx.select({ directive: projectDirectives, task: todos, issuerName: users.name }).from(projectDirectives).innerJoin(todos, eq(todos.id, projectDirectives.taskId)).innerJoin(users, eq(users.id, projectDirectives.issuerId))
      .where(and(eq(projectDirectives.projectId, projectId), directiveTaskAccessCondition(userId))).orderBy(desc(projectDirectives.createdAt), asc(projectDirectives.id)).limit(201)
    if (entries.length > 200) return fail('FDE_DIRECTIVE_LIST_LIMIT', '批示超过当前展示上限，请扩展分页；不会截断结果')
    const ids = entries.map(({ directive }) => directive.id)
    const events = ids.length ? await tx.select({ directiveId: directiveEvents.directiveId, id: directiveEvents.id, action: directiveEvents.action, actorId: directiveEvents.actorId, reason: directiveEvents.reason, version: directiveEvents.version, createdAt: directiveEvents.createdAt }).from(directiveEvents).where(inArray(directiveEvents.directiveId, ids)).orderBy(desc(directiveEvents.version)) : []
    const notices = ids.length ? await tx.select().from(directiveNotices).where(and(inArray(directiveNotices.directiveId, ids), eq(directiveNotices.recipientId, userId), isNull(directiveNotices.closedAt))).orderBy(desc(directiveNotices.createdAt)) : []
    const schedules = ids.length ? await tx.select().from(leaderTimeRequests).where(inArray(leaderTimeRequests.sourceDirectiveId, ids)) : []
    return { canCreate: leader && project.lifecycle === 'active', members: await fdeWeeklyRoster(tx, project), notices, list: entries.map(({ directive, task, issuerName }) => {
      const active = project.lifecycle === 'active' && !directive.withdrawnAt && !taskTerminal(task.status)
      return { ...directive, issuerName, task: { id: task.id, title: task.title, owner: task.owner, ownerUserId: task.ownerUserId, dueDate: task.dueDate, dueTime: task.dueTime, status: task.status, progress: task.progress, version: task.version }, status: directiveStatus(directive, task.status), events: events.filter((item) => item.directiveId === directive.id), schedules: schedules.filter((item) => item.sourceDirectiveId === directive.id), capabilities: { canAcknowledge: active && !directive.acknowledgedAt && task.ownerUserId === userId, canWithdraw: active && leader && directive.issuerId === userId } }
    }) }
  })
}

export async function readFdeDirectiveNotice(projectId: string, noticeId: string, userId: string) {
  return db.transaction(async (tx) => {
    await fdeWeeklyProjectContext(tx, projectId, userId)
    const [notice] = await tx.select({ id: directiveNotices.id }).from(directiveNotices).innerJoin(projectDirectives, eq(projectDirectives.id, directiveNotices.directiveId)).innerJoin(todos, eq(todos.id, projectDirectives.taskId))
      .where(and(eq(directiveNotices.id, noticeId), eq(directiveNotices.recipientId, userId), eq(projectDirectives.projectId, projectId), directiveTaskAccessCondition(userId)))
    if (!notice) return fail('FDE_DIRECTIVE_NOTICE_NOT_FOUND', '通知不存在或无权访问', 404)
    await tx.update(directiveNotices).set({ readAt: new Date() }).where(and(eq(directiveNotices.id, noticeId), isNull(directiveNotices.readAt)))
    return { ok: true }
  })
}
