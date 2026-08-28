import { randomUUID } from 'node:crypto'
import { and, asc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { personalCalendarEvents, personalCalendarHistory, leaderTimeRequests, projects, todos, meetings, meetingParticipants, users } from '../db/schema.js'
import { calendarCancelSchema, calendarWriteSchema, timeInstant } from '../contracts/fdeTimeContract.js'
import { fdeWeekStart, shiftDate } from '../contracts/fdeWeeklyPlanContract.js'
import { timeActor, timeFail, type TimeTx } from './fdeTimeAccessService.js'
import { leaderTimeConflicts } from './fdeLeaderTimeService.js'
import { timeHash } from './fdeTimeEventsService.js'
import { projectAccessCondition } from './projectAccessService.js'
import { canReadReferencedDirectiveTasks } from './fdeDirectiveLinksService.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { scheduleTransaction } from './fdeScheduleTransactionService.js'
import { approvedOfficeCalendar } from './fdeOfficeSourcesService.js'
import { collectApprovedMilestones } from './fdeMilestoneSourcesService.js'
import { milestoneSourceTarget } from '../contracts/fdeMilestoneSourcesContract.js'
import { canReadCommitteeMeeting } from './fdeCommitteeAccessService.js'

async function record(tx: TimeTx, eventId: string, userId: string, action: string, reason: string, requestId: string, requestHash: string) {
  const [event] = await tx.select().from(personalCalendarEvents).where(eq(personalCalendarEvents.id, eventId))
  await tx.insert(personalCalendarHistory).values({ eventId, actorId: userId, action, reason, requestId, requestHash, version: event.version, snapshot: { ...event } })
  const identity = createMySqlIdentityRepositoryContext(tx), actor = await identity.users.findById(userId)
  await identity.audits.append({ userId, userName: actor!.name, module: '个人日历', action, target: `${eventId} / v${event.version} / ${requestId}` })
}
async function previous(tx: TimeTx, requestId: string, hash: string) {
  const [event] = await tx.select().from(personalCalendarHistory).where(eq(personalCalendarHistory.requestId, requestId))
  if (event && event.requestHash !== hash) return timeFail('CALENDAR_REQUEST_REUSED', '请求编号已用于其他内容')
  return event
}
export async function writeCalendarEvent(userId: string, raw: unknown, id?: string) {
  const input = calendarWriteSchema.parse(raw), hash = timeHash({ userId, id, input })
  return scheduleTransaction(async (tx) => {
    await tx.execute(sql`SELECT ${users.id} FROM ${users} WHERE ${users.id}=${userId} FOR UPDATE`)
    await timeActor(tx, userId)
    const replay = await previous(tx, input.clientRequestId, hash)
    if (replay) return { id: replay.eventId }
    const [current] = id ? await tx.select().from(personalCalendarEvents).where(and(eq(personalCalendarEvents.id, id), eq(personalCalendarEvents.ownerId, userId))) : []
    if (id && !current) return timeFail('CALENDAR_FORBIDDEN', '只能编辑本人独立安排，不能修改业务投影', 403)
    if (current && (current.version !== input.expectedVersion || current.status !== 'active')) return timeFail('VERSION_CONFLICT', '安排已变化或已取消，请刷新')
    const { startsAt, endsAt, ...fields } = input.definition, starts = timeInstant(startsAt), ends = timeInstant(endsAt)
    if ((await leaderTimeConflicts(tx, userId, starts, (ends.getTime() - starts.getTime()) / 60000, '', true, id)).length) return timeFail('CALENDAR_CONFLICT', '与本人现有安排或已确认领导时间冲突，请先调整')
    const eventId = current?.id ?? randomUUID()
    if (current) await tx.update(personalCalendarEvents).set({ ...fields, startsAt: starts, endsAt: ends, version: current.version + 1 }).where(eq(personalCalendarEvents.id, current.id))
    else await tx.insert(personalCalendarEvents).values({ ...fields, id: eventId, ownerId: userId, startsAt: starts, endsAt: ends })
    await record(tx, eventId, userId, current ? 'edit' : 'create', '本人确认独立日程', input.clientRequestId, hash)
    return { id: eventId }
  })
}
export async function cancelCalendarEvent(id: string, userId: string, raw: unknown) {
  const input = calendarCancelSchema.parse(raw), hash = timeHash({ id, userId, input })
  return scheduleTransaction(async (tx) => {
    await tx.execute(sql`SELECT ${users.id} FROM ${users} WHERE ${users.id}=${userId} FOR UPDATE`)
    await timeActor(tx, userId)
    const [current] = await tx.select().from(personalCalendarEvents).where(and(eq(personalCalendarEvents.id, id), eq(personalCalendarEvents.ownerId, userId)))
    if (!current) return timeFail('CALENDAR_FORBIDDEN', '只能取消本人独立安排', 403)
    if (await previous(tx, input.clientRequestId, hash)) return { id }
    if (current.version !== input.expectedVersion || current.status !== 'active') return timeFail('VERSION_CONFLICT', '安排已变化或已取消')
    await tx.update(personalCalendarEvents).set({ status: 'cancelled', version: current.version + 1 }).where(eq(personalCalendarEvents.id, id))
    await record(tx, id, userId, 'cancel', input.reason, input.clientRequestId, hash)
    return { id }
  })
}

type CalendarItem = { key: string; id: string | null; source: string; title: string; detail: string; ownerId: string; ownerName: string; startsAt: string; endsAt: string | null; allDay: boolean; version: number | null; visibility?: string; editable: boolean; target: string | null }
export async function listCalendar(userId: string, rawWeek: string, view: 'personal' | 'company', includeMilestones = false) {
  const week = fdeWeekStart.parse(rawWeek), next = shiftDate(week, 7), start = timeInstant(`${week}T00:00`), end = timeInstant(`${next}T00:00`)
  return db.transaction(async (tx) => {
    const { actor } = await timeActor(tx, userId)
    const visible = await tx.select({ id: projects.id }).from(projects).where(projectAccessCondition({ uid: userId, name: actor.name, role: actor.role }))
    const projectIds = new Set(visible.map((p) => p.id))
    const people = await tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.status, '启用'))
    const names = new Map(people.map((p) => [p.id, p.name])), items: CalendarItem[] = []
    function add(input: Omit<CalendarItem, 'key'>, readable: boolean) {
      const sourceKey = input.source === 'office' ? `${input.id}:${input.ownerId}` : input.id
      items.push(readable ? { ...input, key: `${input.source}:${sourceKey}` } : { key: timeHash({ id: sourceKey, source: input.source, userId }), id: null, source: 'busy', title: '已占用', detail: '', ownerId: input.ownerId, ownerName: input.ownerName, startsAt: input.startsAt, endsAt: input.endsAt, allDay: input.allDay, version: null, editable: false, target: null })
    }
    const personal = await tx.select().from(personalCalendarEvents).where(and(eq(personalCalendarEvents.status, 'active'), view === 'personal' ? eq(personalCalendarEvents.ownerId, userId) : undefined, lt(personalCalendarEvents.startsAt, end), gt(personalCalendarEvents.endsAt, start))).limit(501)
    for (const row of personal) add({ id: row.id, source: 'personal', title: row.title, detail: row.detail, ownerId: row.ownerId, ownerName: names.get(row.ownerId) ?? '已停用人员', startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), allDay: false, version: row.version, visibility: row.visibility, editable: row.ownerId === userId, target: null }, row.ownerId === userId || row.visibility === 'company')
    const times = await tx.select().from(leaderTimeRequests).where(and(eq(leaderTimeRequests.status, 'confirmed'), view === 'personal' ? or(eq(leaderTimeRequests.leaderId, userId), eq(leaderTimeRequests.submittedBy, userId)) : undefined, gte(leaderTimeRequests.scheduledStart, start), lt(leaderTimeRequests.scheduledStart, end))).limit(501)
    for (const row of times) {
      const allowed = projectIds.has(row.projectId) && (!row.taskId || await canReadReferencedDirectiveTasks(tx, [row.taskId], userId))
      add({ id: row.id, source: 'leader', title: row.title, detail: row.location, ownerId: row.leaderId, ownerName: names.get(row.leaderId) ?? '已停用人员', startsAt: row.scheduledStart!.toISOString(), endsAt: new Date(row.scheduledStart!.getTime() + row.durationMinutes * 60000).toISOString(), allDay: false, version: row.version, editable: false, target: `/collaboration?view=time&week=${week}&request=${row.id}` }, allowed)
    }
    const tasks = await tx.select().from(todos).where(and(view === 'personal' ? eq(todos.ownerUserId, userId) : undefined, gte(todos.dueDate, week), lt(todos.dueDate, next), isNull(todos.approvalRequestId), ne(todos.type, '流程'), inArray(todos.status, ['未开始', '进行中', '待验收', '已退回', '待确认']))).limit(501)
    for (const row of tasks) {
      const allowed = (row.projectId ? projectIds.has(row.projectId) : row.ownerUserId === userId) && await canReadReferencedDirectiveTasks(tx, [row.id], userId)
      add({ id: row.id, source: 'task', title: row.title, detail: `任务截止 · ${row.status}`, ownerId: row.ownerUserId ?? '', ownerName: row.ownerUserId ? names.get(row.ownerUserId) ?? '已停用人员' : '待绑定', startsAt: timeInstant(`${row.dueDate}T${row.dueTime ?? '00:00'}`).toISOString(), endsAt: null, allDay: !row.dueTime, version: row.version, editable: false, target: row.projectId ? `/projects/${row.projectId}?tab=tasks` : '/' }, allowed)
    }
    const attended = new Set((await tx.select({ id: meetingParticipants.meetingId }).from(meetingParticipants).where(eq(meetingParticipants.userId, userId))).map(row => row.id))
    const meetingRows = await tx.select().from(meetings).where(and(or(eq(meetings.workflowKind, 'legacy'), inArray(meetings.workflowStatus, ['scheduled', 'completed'])),
      lt(meetings.startedAt, end), or(gt(meetings.endsAt, start), and(isNull(meetings.endsAt), gte(meetings.startedAt, start))),
      view === 'personal' ? or(eq(meetings.hostUserId, userId), inArray(meetings.id, tx.select({ id: meetingParticipants.meetingId }).from(meetingParticipants).where(eq(meetingParticipants.userId, userId)))) : undefined)).limit(501)
    for (const row of meetingRows) add({ id: row.id, source: 'meeting', title: row.title, detail: row.endsAt ? '已登记会议时间' : '未记录结束时间，不推定占用时长', ownerId: row.hostUserId ?? '', ownerName: row.hostUserId ? names.get(row.hostUserId) ?? '已停用人员' : '待绑定', startsAt: row.startedAt.toISOString(), endsAt: row.endsAt?.toISOString() ?? null, allDay: false, version: row.version, editable: false, target: row.workflowKind === 'committee' ? `/committee?meeting=${row.id}` : row.projectId ? `/projects/${row.projectId}?tab=collaboration` : '/collaboration?view=meetings' }, row.workflowKind === 'committee' ? await canReadCommitteeMeeting(tx, row.id, userId) : row.projectId ? projectIds.has(row.projectId) : row.hostUserId === userId || row.createdBy === userId || attended.has(row.id))
    for (const { row, window, ownerId, readable } of await approvedOfficeCalendar(tx, userId, week, view)) add({ id: row.id, source: 'office', title: row.title,
      detail: `${row.type} · 获批安排 · 修订 ${row.officeRevision}；不是实际执行证明`, ownerId, ownerName: names.get(ownerId) ?? '已停用人员',
      startsAt: window.startsAt.toISOString(), endsAt: window.endsAt.toISOString(), allDay: window.allDay, version: row.lockVersion, editable: false,
      target: `/workflow?view=completed&office=${row.id}` }, readable)
    if (includeMilestones) for (const row of await collectApprovedMilestones(tx, userId, week, { personal: view === 'personal' })) add({
      id: row.id, source: 'milestone', title: `${row.projectName} · ${row.stage}节点日期`, detail: `正式批准日期 v${row.version} · ${row.previousDate} → ${row.date}；不是阶段通过或时间占用`,
      ownerId: row.ownerId ?? '', ownerName: row.ownerName, startsAt: timeInstant(`${row.date}T00:00`).toISOString(), endsAt: null, allDay: true, version: row.version, editable: false, target: milestoneSourceTarget(row),
    }, true)
    if ([personal, times, tasks, meetingRows].some((rows) => rows.length > 500) || items.length > 500) return timeFail('CALENDAR_LIST_LIMIT', '当前周数据超过单次容量，不能静默截断日历')
    return { weekStart: week, view, timezone: 'Asia/Shanghai', items: items.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.key.localeCompare(b.key)), notice: '任务为截止点；OA 仅展示获批出差/请假范围，日期型行程的结束边界为末日次日零点，不代表全天独占或执行完成。缺少日期/出差人时不推定日程；硬冲突和额度政策尚待确认。来源业务只能在原入口修改。' }
  })
}
