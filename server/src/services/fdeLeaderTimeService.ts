import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { leaderTimeRequests, leaderTimeEvents, leaderTimeNotices, personalCalendarEvents, meetings, meetingParticipants, projects, roles, userRoles, users } from '../db/schema.js'
import { fdeWeekStart, shiftDate } from '../contracts/fdeWeeklyPlanContract.js'
import { timeActionSchema, timeCreateSchema, timeSaveSchema, timeDefinitionSchema, timeEnd, timeInstant, timeLocal, timeTerminal, validLeaderSlot, intervalsOverlap } from '../contracts/fdeTimeContract.js'
import { timeActor, timeFail, timeScope, type TimeReader, type TimeTx } from './fdeTimeAccessService.js'
import { recordTimeEvent, timeHash } from './fdeTimeEventsService.js'
import { projectAccessCondition } from './projectAccessService.js'
import { canReadReferencedDirectiveTasks } from './fdeDirectiveLinksService.js'
import { scheduleConflicts } from './fdeScheduleService.js'
import { scheduleTransaction } from './fdeScheduleTransactionService.js'
import { readTimelineTimeSource } from './fdeTimelineTimeService.js'

type TimeRequest = typeof leaderTimeRequests.$inferSelect
async function lockedScope(tx: TimeTx, userId: string, projectId: string, leaderId: string) {
  // No consistent read before these locks: subsequent conflict reads see the latest committed schedule.
  await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
  await tx.execute(sql`SELECT ${users.id} FROM ${users} WHERE ${users.id}=${leaderId} FOR UPDATE`)
  const scope = await timeScope(tx, userId, projectId)
  if (scope.project.lifecycle !== 'active') return timeFail('TIME_PROJECT_INACTIVE', '已关闭或归档项目不能继续安排领导时间')
  return scope
}
async function readable(reader: TimeReader, userId: string, row: TimeRequest) {
  const scope = await timeScope(reader, userId, row.projectId)
  if (row.status === 'draft') {
    const allowed = scope.full && (scope.manager || row.submittedBy === userId || row.leaderId === userId)
    if (!allowed || (row.taskId && !await canReadReferencedDirectiveTasks(reader, [row.taskId], userId))) return null
  } else if (!scope.full && !scope.coordinator) return null
  return scope
}
async function previous(tx: TimeTx, requestId: string, hash: string) {
  const [event] = await tx.select().from(leaderTimeEvents).where(eq(leaderTimeEvents.requestId, requestId))
  if (event && event.requestHash !== hash) return timeFail('TIME_REQUEST_REUSED', '请求编号已用于其他内容，请重新打开操作')
  return event
}
function definition(row: TimeRequest) {
  return { title: row.title, reason: row.reason ?? '', outcome: row.outcome ?? '', impact: row.impact ?? '', priority: row.priority, latestFinish: row.latestFinish ? timeLocal(row.latestFinish) : null, preferredStart: timeLocal(row.preferredStart), alternativeStart: row.alternativeStart ? timeLocal(row.alternativeStart) : '', durationMinutes: row.durationMinutes, location: row.location }
}

// Do not return conflicting object IDs/titles: private calendar and other project content remain private.
export async function leaderTimeConflicts(reader: TimeReader, leaderId: string, startsAt: Date, duration: number, exceptId = '', confirmedOnly = false, exceptCalendarId = '') {
  return scheduleConflicts(reader, leaderId, startsAt, timeEnd(startsAt, duration), { confirmedOnly, excludeTimeIds: exceptId ? [exceptId] : [], excludeCalendarId: exceptCalendarId })
}

export async function createLeaderTime(userId: string, raw: unknown) {
  const input = timeCreateSchema.parse(raw), hash = timeHash({ userId, action: 'create', input })
  return scheduleTransaction(async (tx) => {
    const scope = await lockedScope(tx, userId, input.projectId, input.leaderId)
    if (!scope.manager) return timeFail('TIME_REQUESTOR_REQUIRED', '仅有权项目负责人、推进秘书或领导可申请', 403)
    const leader = await timeScope(tx, input.leaderId, input.projectId)
    if (!leader.leader || !leader.full) return timeFail('TIME_LEADER_INVALID', '申请领导须有当前项目权限及有效领导职责', 400)
    const replay = await previous(tx, input.clientRequestId, hash)
    if (replay) return { id: replay.timeRequestId }
    const id = randomUUID(), { clientRequestId: _request, preferredStart, alternativeStart, latestFinish, ...fields } = input
    await tx.insert(leaderTimeRequests).values({ ...fields, id, submittedBy: userId, preferredStart: timeInstant(preferredStart), alternativeStart: timeInstant(alternativeStart), latestFinish: timeInstant(latestFinish) })
    await recordTimeEvent(tx, id, userId, 'create', '创建申请草稿', input.clientRequestId, hash)
    return { id }
  })
}
export async function saveLeaderTime(id: string, userId: string, raw: unknown) {
  const input = timeSaveSchema.parse(raw), hash = timeHash({ id, userId, action: 'save', input })
  const [initial] = await db.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.id, id))
  if (!initial) return timeFail('TIME_NOT_FOUND', '时间需求不存在', 404)
  return scheduleTransaction(async (tx) => {
    await lockedScope(tx, userId, initial.projectId, initial.leaderId)
    const [row] = await tx.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.id, id))
    const scope = await readable(tx, userId, row)
    if (!scope || !(scope.manager || scope.coordinator || row.submittedBy === userId)) return timeFail('TIME_EDIT_FORBIDDEN', '无权编辑该需求', 403)
    if (await previous(tx, input.clientRequestId, hash)) return { id }
    if (row.version !== input.expectedVersion) return timeFail('VERSION_CONFLICT', '时间需求已变化，请刷新')
    if (timeTerminal(row.status)) return timeFail('TIME_CLOSED', '已结束需求不可修改')
    const source = await readTimelineTimeSource(tx, row)
    if (source && !source.view.needed) return timeFail('TIME_SOURCE_OBSOLETE', source.view.reason)
    const { clientRequestId: _request, expectedVersion: _version, preferredStart, alternativeStart, latestFinish, ...fields } = input
    await tx.update(leaderTimeRequests).set({ ...fields, preferredStart: timeInstant(preferredStart), alternativeStart: timeInstant(alternativeStart), latestFinish: timeInstant(latestFinish), scheduledStart: row.status === 'draft' ? null : timeInstant(preferredStart), status: row.status === 'draft' ? 'draft' : 'requested', confirmedAt: null, confirmedBy: null, supplementNote: null, scheduleNote: null, version: row.version + 1 }).where(eq(leaderTimeRequests.id, id))
    await recordTimeEvent(tx, id, userId, 'save', '更新申请信息；已确认安排须重新确认', input.clientRequestId, hash)
    return { id }
  })
}
export async function actOnLeaderTime(id: string, userId: string, raw: unknown) {
  const input = timeActionSchema.parse(raw), hash = timeHash({ id, userId, input })
  const [initial] = await db.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.id, id))
  if (!initial) return timeFail('TIME_NOT_FOUND', '时间需求不存在', 404)
  return scheduleTransaction(async (tx) => {
    await lockedScope(tx, userId, initial.projectId, initial.leaderId)
    const [row] = await tx.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.id, id))
    const scope = await readable(tx, userId, row)
    if (!scope) return timeFail('TIME_FORBIDDEN', '无权处理该时间需求', 403)
    const decider = scope.full && scope.leader && row.leaderId === userId
    const allowed = ['confirm', 'reject'].includes(input.action) ? decider
      : ['coordinate', 'supplement'].includes(input.action) ? scope.coordinator || decider
      : input.action === 'refresh-source' ? scope.manager || decider
      : scope.manager || (scope.full && row.submittedBy === userId)
    if (!allowed) return timeFail('TIME_ACTION_FORBIDDEN', '当前角色不能执行该操作；协调人不能代替领导确认', 403)
    if (await previous(tx, input.clientRequestId, hash)) return { id }
    if (row.version !== input.expectedVersion) return timeFail('VERSION_CONFLICT', '时间需求已变化，请刷新')
    if (timeTerminal(row.status)) return timeFail('TIME_CLOSED', '该需求已结束，不能重复处理')
    const source = await readTimelineTimeSource(tx, row)
    if (source?.view.changed && ['submit', 'coordinate', 'confirm'].includes(input.action)) return timeFail('TIME_SOURCE_CHANGED', source.view.reason)
    const patch: Partial<typeof leaderTimeRequests.$inferInsert> = { version: row.version + 1, confirmedAt: null, confirmedBy: null, scheduleNote: null }
    if (input.action === 'refresh-source') {
      if (!source?.view.needed || !source.definition) return timeFail('TIME_SOURCE_OBSOLETE', source?.view.reason ?? '该需求不是流程行动来源')
      Object.assign(patch, { title: source.definition.title, outcome: source.definition.outcome, latestFinish: timeInstant(source.definition.slots.latestFinish), sourceFingerprint: source.definition.fingerprint, sourceRetired: false, status: row.status === 'draft' ? 'draft' : 'requested', scheduledStart: row.scheduledStart ?? row.preferredStart })
    } else if (input.action === 'submit') {
      if (row.status !== 'draft') return timeFail('TIME_STATE_INVALID', '仅草稿可以提交')
      timeDefinitionSchema.parse(definition(row))
      Object.assign(patch, { status: 'requested', scheduledStart: row.preferredStart })
    } else if (input.action === 'coordinate') {
      if (['draft', 'supplement'].includes(row.status)) return timeFail('TIME_STATE_INVALID', '请先提交或补齐申请信息')
      Object.assign(patch, { status: 'pending', scheduledStart: timeInstant(input.scheduledStart!), durationMinutes: input.durationMinutes })
    } else if (input.action === 'confirm') {
      if (!['requested', 'pending'].includes(row.status) || !row.scheduledStart || !row.reason || !row.outcome || !row.impact || !validLeaderSlot(timeLocal(row.scheduledStart), row.durationMinutes)) return timeFail('TIME_STATE_INVALID', '申请信息或时间尚未满足确认条件')
      if ((await leaderTimeConflicts(tx, row.leaderId, row.scheduledStart, row.durationMinutes, id)).length) return timeFail('TIME_CONFLICT', '当前时间与其他有效安排重叠，请先调整时间')
      Object.assign(patch, { status: 'confirmed', confirmedAt: new Date(), confirmedBy: userId })
    } else if (input.action === 'supplement') {
      if (row.status === 'draft') return timeFail('TIME_STATE_INVALID', '草稿尚未提交')
      Object.assign(patch, { status: 'supplement', supplementNote: input.reason })
    } else if (input.action === 'reject') {
      if (row.status === 'draft') return timeFail('TIME_STATE_INVALID', '草稿尚未提交')
      Object.assign(patch, { status: 'rejected', closureReason: input.reason })
    } else {
      if ((input.action === 'cancel') !== (row.status === 'confirmed')) return timeFail('TIME_STATE_INVALID', '已确认安排须取消，未确认需求须撤回')
      Object.assign(patch, { status: input.action === 'cancel' ? 'cancelled' : 'withdrawn', closureReason: input.reason })
    }
    await tx.update(leaderTimeRequests).set(patch).where(eq(leaderTimeRequests.id, id))
    await recordTimeEvent(tx, id, userId, input.action, `${input.method}: ${input.reason}`, input.clientRequestId, hash)
    return { id }
  })
}

export async function listLeaderTimes(userId: string, rawWeek: string) {
  const week = fdeWeekStart.parse(rawWeek), start = timeInstant(`${week}T00:00`), end = timeInstant(`${shiftDate(week, 7)}T00:00`)
  return db.transaction(async (tx) => {
    const identity = await timeActor(tx, userId)
    const rows = await tx.select().from(leaderTimeRequests).where(or(and(gte(leaderTimeRequests.preferredStart, start), lt(leaderTimeRequests.preferredStart, end)), and(gte(leaderTimeRequests.scheduledStart, start), lt(leaderTimeRequests.scheduledStart, end)), and(lt(leaderTimeRequests.preferredStart, start), inArray(leaderTimeRequests.status, ['draft', 'requested', 'pending', 'supplement'])))).orderBy(desc(leaderTimeRequests.createdAt)).limit(501)
    if (rows.length > 500) return timeFail('TIME_LIST_LIMIT', '当前周及未处理历史需求超过单次容量，请分批处理；不会静默截断')
    const list = []
    for (const row of rows) {
      const scope = await readable(tx, userId, row).catch((error) => { if (error.code === 'TIME_PROJECT_UNAVAILABLE') return null; throw error })
      if (!scope) continue
      const active = scope.project.lifecycle === 'active' && !timeTerminal(row.status), ownLeader = scope.full && scope.leader && row.leaderId === userId
      const source = await readTimelineTimeSource(tx, row), sourceReady = !source?.view.changed
      const events = await tx.select({ id: leaderTimeEvents.id, action: leaderTimeEvents.action, reason: leaderTimeEvents.reason, version: leaderTimeEvents.version, createdAt: leaderTimeEvents.createdAt }).from(leaderTimeEvents).where(eq(leaderTimeEvents.timeRequestId, row.id)).orderBy(desc(leaderTimeEvents.version))
      const [leader] = await tx.select({ name: users.name }).from(users).where(eq(users.id, row.leaderId))
      const notices = await tx.select({ id: leaderTimeNotices.id, readAt: leaderTimeNotices.readAt }).from(leaderTimeNotices).where(and(eq(leaderTimeNotices.timeRequestId, row.id), eq(leaderTimeNotices.recipientId, userId), isNull(leaderTimeNotices.closedAt)))
      list.push({ ...row, timelineSource: source?.view ?? null, projectName: scope.full ? scope.project.name : '项目时间需求', leaderName: leader.name, events, notices, conflicts: row.scheduledStart && !timeTerminal(row.status) ? await leaderTimeConflicts(tx, row.leaderId, row.scheduledStart, row.durationMinutes, row.id) : [], capabilities: { edit: active && (!source || source.view.needed) && (scope.manager || scope.coordinator || row.submittedBy === userId), submit: active && sourceReady && row.status === 'draft' && (scope.manager || row.submittedBy === userId), coordinate: active && sourceReady && !['draft', 'supplement'].includes(row.status) && (scope.coordinator || ownLeader), confirm: active && sourceReady && ['requested', 'pending'].includes(row.status) && ownLeader, reject: active && row.status !== 'draft' && ownLeader, supplement: active && row.status !== 'draft' && (scope.coordinator || ownLeader), withdraw: active && (scope.manager || row.submittedBy === userId), 'refresh-source': active && Boolean(source?.view.changed && source.view.needed) && (scope.manager || ownLeader) } })
    }
    const available = await tx.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workflowModel, 'fde-v1'), eq(projects.lifecycle, 'active'), projectAccessCondition({ uid: userId, name: identity.actor.name, role: identity.actor.role })))
    const requestProjects = []
    for (const p of available) if ((await timeScope(tx, userId, p.id)).manager) requestProjects.push(p)
    const leaders = await tx.selectDistinct({ id: users.id, name: users.name }).from(users).innerJoin(userRoles, eq(userRoles.userId, users.id)).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(eq(users.status, '启用'), eq(roles.status, '启用'), eq(roles.fdeCategory, 'institution_leader'))).orderBy(asc(users.name))
    return { weekStart: week, list, projects: requestProjects, leaders }
  })
}
export async function readLeaderTimeNotice(id: string, userId: string) {
  return db.transaction(async (tx) => {
    await timeActor(tx, userId)
    const [notice] = await tx.select().from(leaderTimeNotices).where(and(eq(leaderTimeNotices.id, id), eq(leaderTimeNotices.recipientId, userId), isNull(leaderTimeNotices.closedAt)))
    if (!notice) return timeFail('TIME_NOTICE_NOT_FOUND', '通知不存在或已失效', 404)
    const [row] = await tx.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.id, notice.timeRequestId))
    if (!await readable(tx, userId, row)) return timeFail('TIME_FORBIDDEN', '需求权限已变化', 403)
    await tx.update(leaderTimeNotices).set({ readAt: new Date() }).where(and(eq(leaderTimeNotices.id, id), isNull(leaderTimeNotices.readAt)))
    return { ok: true }
  })
}
