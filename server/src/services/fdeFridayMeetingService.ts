import { createHash, randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { meetingParticipants, meetings, meetingWorkflowEvents, meetingWorkflowNotices, projectWeeklyPlans, projects } from '../db/schema.js'
import { fridayActionSchema, fridayCreateSchema, fridaySaveSchema, nextMeetingWeek, type FridayMinutes } from '../contracts/fdeFridayMeetingContract.js'
import { shiftDate } from '../contracts/fdeWeeklyPlanContract.js'
import { fdeWeeklyProjectContext, fdeWeeklyRoster, seedWeeklyPlanFromMeeting } from './fdeWeeklyPlanService.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { lockSchedulePeople, requireMeetingSlot } from './fdeScheduleService.js'
import { scheduleTransaction } from './fdeScheduleTransactionService.js'
import { appendFridayMeetingRecord } from './fdeProjectRecordService.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Meeting = typeof meetings.$inferSelect
type Result = { meetingId: string; planId?: string; weekStart?: string }
const fail = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }) }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function writeContext(tx: Tx, projectId: string, userId: string) {
  await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
  const context = await fdeWeeklyProjectContext(tx, projectId, userId)
  if (context.project.lifecycle !== 'active') return fail('FDE_PROJECT_INACTIVE', '关闭或归档项目不能修改例会')
  if (!context.canDraft && !context.canPublish) return fail('FDE_MEETING_MANAGER_REQUIRED', '只有本项目负责人或推进秘书可以维护例会', 403)
  return context
}
async function previous(tx: Tx, requestId: string, requestHash: string) {
  const [event] = await tx.select().from(meetingWorkflowEvents).where(eq(meetingWorkflowEvents.requestId, requestId))
  if (event && event.requestHash !== requestHash) return fail('FDE_MEETING_REQUEST_REUSED', '请求编号已用于其他操作')
  return event?.result
}
async function find(tx: Tx, projectId: string, meetingId: string, version: number) {
  const [row] = await tx.select().from(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.projectId, projectId), eq(meetings.workflowKind, 'friday')))
  if (!row) return fail('FDE_MEETING_NOT_FOUND', '例会不存在', 404)
  if (row.version !== version) return fail('VERSION_CONFLICT', '例会已被修改，请刷新后重试')
  return row
}
async function participants(tx: Tx, meetingId: string) {
  return tx.select().from(meetingParticipants).where(eq(meetingParticipants.meetingId, meetingId)).orderBy(asc(meetingParticipants.userId))
}
async function validatePeopleAndActions(tx: Tx, project: typeof projects.$inferSelect, ids: string[], minutes: FridayMinutes, startsAt: string | Date) {
  const roster = await fdeWeeklyRoster(tx, project), members = new Set(roster.map((member) => member.id))
  if (ids.some((id) => !members.has(id))) return fail('FDE_MEETING_PARTICIPANT_INVALID', '参会人必须是启用的项目人员', 403)
  const week = nextMeetingWeek(startsAt)
  for (const action of minutes.nextActions) {
    if (!members.has(action.ownerUserId)) return fail('FDE_MEETING_OWNER_INVALID', '下周行动负责人必须是启用的项目人员', 403)
    if (action.dueDate < week || action.dueDate > shiftDate(week, 6)) return fail('FDE_MEETING_ACTION_DATE', '拟定行动必须安排在会议所在周的下一周', 400)
    if (project.targetDate && action.dueDate > project.targetDate) return fail('FDE_MEETING_EXCEEDS_PROJECT', '拟定行动超过项目最终日期，请先审批调整计划')
  }
  return roster
}
async function record(tx: Tx, meetingId: string, userId: string, requestId: string, requestHash: string, action: string, reason: string, result: Result) {
  const [meeting] = await tx.select().from(meetings).where(eq(meetings.id, meetingId))
  await tx.insert(meetingWorkflowEvents).values({ meetingId, actorId: userId, requestId, requestHash, action, reason, version: meeting.version, snapshot: { meeting, participants: await participants(tx, meetingId) }, result })
  const identity = createMySqlIdentityRepositoryContext(tx), actor = await identity.users.findById(userId)
  await identity.audits.append({ userId, userName: actor?.name ?? '未知用户', module: '周五例会', action, target: `${meeting.projectId} / ${meetingId} / v${meeting.version} / ${requestId}` })
}
async function notify(tx: Tx, meeting: Meeting, kind: string, extraRecipients: string[] = []) {
  await tx.update(meetingWorkflowNotices).set({ closedAt: new Date() }).where(and(eq(meetingWorkflowNotices.meetingId, meeting.id), isNull(meetingWorkflowNotices.closedAt)))
  const recipientIds = [...new Set([...(await participants(tx, meeting.id)).map((item) => item.userId), ...extraRecipients])]
  if (recipientIds.length) await tx.insert(meetingWorkflowNotices).values(recipientIds.map((recipientId) => ({ meetingId: meeting.id, recipientId, kind, version: meeting.version })))
}

export async function createFdeFridayMeeting(projectId: string, userId: string, raw: unknown) {
  const input = fridayCreateSchema.parse(raw), requestHash = digest({ projectId, userId, kind: 'create', input })
  return scheduleTransaction(async (tx) => {
    const { project } = await writeContext(tx, projectId, userId)
    const replay = await previous(tx, input.clientRequestId, requestHash)
    if (replay) return replay
    const roster = await validatePeopleAndActions(tx, project, input.participantIds, input.minutes, input.startsAt)
    const names = new Map(roster.map((member) => [member.id, member.name])), meetingId = randomUUID()
    await tx.insert(meetings).values({ id: meetingId, projectId, projectName: project.name, title: input.title, type: '周五例会', workflowKind: 'friday', workflowStatus: 'draft', host: names.get(input.hostUserId)!, hostUserId: input.hostUserId, attendees: input.participantIds.map((id) => names.get(id)!), startedAt: new Date(`${input.startsAt}:00+08:00`), endsAt: new Date(`${input.endsAt}:00+08:00`), weeklyReview: input.minutes, createdBy: userId })
    await tx.insert(meetingParticipants).values(input.participantIds.map((id) => ({ meetingId, userId: id, sourceName: names.get(id)! })))
    const result = { meetingId }
    await record(tx, meetingId, userId, input.clientRequestId, requestHash, 'create', '', result)
    return result
  })
}

export async function saveFdeFridayMeeting(projectId: string, meetingId: string, userId: string, raw: unknown) {
  const input = fridaySaveSchema.parse(raw), requestHash = digest({ projectId, meetingId, userId, kind: 'save', input })
  return scheduleTransaction(async (tx) => {
    const { project } = await writeContext(tx, projectId, userId)
    const replay = await previous(tx, input.clientRequestId, requestHash)
    if (replay) return replay
    const meeting = await find(tx, projectId, meetingId, input.expectedVersion)
    if (!['draft', 'scheduled'].includes(meeting.workflowStatus)) return fail('FDE_MEETING_IMMUTABLE', '已确认或已取消例会不能覆盖历史纪要')
    const roster = await validatePeopleAndActions(tx, project, input.participantIds, input.minutes, input.startsAt)
    const names = new Map(roster.map((member) => [member.id, member.name]))
    const oldPeople = (await participants(tx, meetingId)).map((item) => item.userId)
    await lockSchedulePeople(tx, [...oldPeople, ...input.participantIds, input.hostUserId, ...(meeting.hostUserId ? [meeting.hostUserId] : [])])
    if (meeting.workflowStatus === 'scheduled') await requireMeetingSlot(tx, meetingId, input.participantIds, new Date(`${input.startsAt}:00+08:00`), new Date(`${input.endsAt}:00+08:00`))
    await tx.update(meetings).set({ title: input.title, host: names.get(input.hostUserId)!, hostUserId: input.hostUserId, attendees: input.participantIds.map((id) => names.get(id)!), startedAt: new Date(`${input.startsAt}:00+08:00`), endsAt: new Date(`${input.endsAt}:00+08:00`), weeklyReview: input.minutes, version: meeting.version + 1 }).where(eq(meetings.id, meetingId))
    await tx.delete(meetingParticipants).where(eq(meetingParticipants.meetingId, meetingId))
    await tx.insert(meetingParticipants).values(input.participantIds.map((id) => ({ meetingId, userId: id, sourceName: names.get(id)! })))
    const [updated] = await tx.select().from(meetings).where(eq(meetings.id, meetingId))
    // Removed attendees receive an update only if they still have project access when reading it.
    if (meeting.workflowStatus === 'scheduled') await notify(tx, updated, 'updated', oldPeople)
    const result = { meetingId }
    await record(tx, meetingId, userId, input.clientRequestId, requestHash, 'save', input.reason, result)
    return result
  }, { isolationLevel: 'read committed' })
}

export async function actOnFdeFridayMeeting(projectId: string, meetingId: string, userId: string, raw: unknown) {
  const input = fridayActionSchema.parse(raw), requestHash = digest({ projectId, meetingId, userId, input })
  return scheduleTransaction(async (tx) => {
    const { project, canDraft } = await writeContext(tx, projectId, userId)
    if (input.action === 'derive' && !canDraft) return fail('FDE_WEEKLY_SECRETARY_REQUIRED', '只有推进秘书可以生成下周计划草稿', 403)
    const replay = await previous(tx, input.clientRequestId, requestHash)
    if (replay) return replay
    const meeting = await find(tx, projectId, meetingId, input.expectedVersion)
    const schedulePeople = (await participants(tx, meetingId)).map(item => item.userId)
    await lockSchedulePeople(tx, [...schedulePeople, ...(meeting.hostUserId ? [meeting.hostUserId] : [])])
    let result: Result = { meetingId }
    if (input.action === 'derive') {
      result = { ...result, ...await seedWeeklyPlanFromMeeting(tx, projectId, meetingId, userId, input.clientRequestId) }
    } else {
      const expected = input.action === 'schedule' ? ['draft'] : input.action === 'confirm' ? ['scheduled'] : ['draft', 'scheduled']
      if (!expected.includes(meeting.workflowStatus)) return fail('FDE_MEETING_STATE_INVALID', '例会当前状态不允许此操作')
      if (input.action !== 'cancel') {
        const ids = (await participants(tx, meetingId)).map((item) => item.userId)
        await validatePeopleAndActions(tx, project, ids, meeting.weeklyReview!, meeting.startedAt)
        if (!ids.includes(meeting.hostUserId ?? '')) return fail('FDE_MEETING_PARTICIPANT_INVALID', '主持人不在有效参会名单中', 403)
      }
      if (input.action === 'confirm') {
        const review = meeting.weeklyReview
        if (!review || [review.result, review.decision, review.nextGoal].some((value) => value.trim().length < 2)) return fail('FDE_MEETING_MINUTES_REQUIRED', '确认纪要前请补全会议结果、决定和下周目标')
        if (!meeting.endsAt || meeting.endsAt.getTime() > Date.now()) return fail('FDE_MEETING_NOT_ENDED', '未来或尚未结束的会议不能确认成已完成')
      }
      if (input.action === 'schedule') await requireMeetingSlot(tx, meetingId, schedulePeople, meeting.startedAt, meeting.endsAt)
      const status = { schedule: 'scheduled', confirm: 'completed', cancel: 'cancelled' }[input.action]
      await tx.update(meetings).set({ workflowStatus: status, version: meeting.version + 1,
        ...(input.action === 'confirm' ? { confirmedBy: userId, confirmedAt: new Date(), aiSummary: meeting.weeklyReview!.result, conclusions: [meeting.weeklyReview!.decision], rawTranscript: `议题：${meeting.weeklyReview!.agenda}\n结果：${meeting.weeklyReview!.result}\n阻塞：${meeting.weeklyReview!.blocked}\n决定：${meeting.weeklyReview!.decision}\n下周目标：${meeting.weeklyReview!.nextGoal}` } : {}),
      }).where(eq(meetings.id, meetingId))
      const [updated] = await tx.select().from(meetings).where(eq(meetings.id, meetingId))
      if (input.action === 'confirm') await appendFridayMeetingRecord(tx, meetingId, userId)
      if (input.action !== 'cancel' || meeting.workflowStatus === 'scheduled') await notify(tx, updated, status)
    }
    await record(tx, meetingId, userId, input.clientRequestId, requestHash, input.action, input.reason, result)
    return result
  }, { isolationLevel: 'read committed' })
}

export async function getFdeFridayMeetings(projectId: string, userId: string) {
  return db.transaction(async (tx) => {
    const { project, canDraft, canPublish } = await fdeWeeklyProjectContext(tx, projectId, userId)
    const manager = canDraft || canPublish
    const visible = or(inArray(meetings.workflowStatus, ['scheduled', 'completed']), and(eq(meetings.workflowStatus, 'cancelled'), inArray(meetings.id, tx.select({ id: meetingWorkflowNotices.meetingId }).from(meetingWorkflowNotices))))
    const rows = await tx.select().from(meetings).where(and(eq(meetings.projectId, projectId), eq(meetings.workflowKind, 'friday'), manager ? undefined : visible)).orderBy(desc(meetings.startedAt), desc(meetings.id)).limit(201)
    if (rows.length > 200) return fail('FDE_MEETING_LIST_LIMIT', '例会超过 200 场，需要分页查询，不能截断显示')
    const list = await Promise.all(rows.map(async (meeting) => {
      const events = manager ? await tx.select().from(meetingWorkflowEvents).where(eq(meetingWorkflowEvents.meetingId, meeting.id)).orderBy(desc(meetingWorkflowEvents.createdAt)) : []
      const linked = await tx.select({ id: projectWeeklyPlans.id, weekStart: projectWeeklyPlans.weekStart, status: projectWeeklyPlans.status, revision: projectWeeklyPlans.revision }).from(projectWeeklyPlans).where(and(eq(projectWeeklyPlans.sourceMeetingId, meeting.id), manager ? undefined : eq(projectWeeklyPlans.status, 'published'))).orderBy(desc(projectWeeklyPlans.revision))
      // Working minutes are visible only to the meeting managers until manual confirmation.
      const visibleReview = manager || meeting.workflowStatus === 'completed' ? meeting.weeklyReview : meeting.weeklyReview ? { agenda: meeting.weeklyReview.agenda, result: '', blocked: '', decision: '', nextGoal: '', nextActions: [] } : null
      return { ...meeting, weeklyReview: visibleReview, participants: await participants(tx, meeting.id), events, plans: linked, nextWeek: nextMeetingWeek(meeting.startedAt) }
    }))
    const ids = rows.map((row) => row.id)
    const notices = ids.length ? await tx.select().from(meetingWorkflowNotices).where(and(inArray(meetingWorkflowNotices.meetingId, ids), eq(meetingWorkflowNotices.recipientId, userId), isNull(meetingWorkflowNotices.closedAt))) : []
    return { list, notices, members: await fdeWeeklyRoster(tx, project), canManage: manager && project.lifecycle === 'active', canDerive: canDraft && project.lifecycle === 'active' }
  })
}

export async function readFdeFridayNotice(projectId: string, noticeId: string, userId: string) {
  return db.transaction(async (tx) => {
    await fdeWeeklyProjectContext(tx, projectId, userId)
    const [notice] = await tx.select({ id: meetingWorkflowNotices.id }).from(meetingWorkflowNotices).innerJoin(meetings, eq(meetings.id, meetingWorkflowNotices.meetingId)).where(and(eq(meetingWorkflowNotices.id, noticeId), eq(meetingWorkflowNotices.recipientId, userId), isNull(meetingWorkflowNotices.closedAt), eq(meetings.projectId, projectId), eq(meetings.workflowKind, 'friday'), ne(meetings.workflowStatus, 'draft')))
    if (!notice) return fail('FDE_MEETING_NOTICE_NOT_FOUND', '通知不存在或不属于当前用户', 404)
    await tx.update(meetingWorkflowNotices).set({ readAt: new Date() }).where(and(eq(meetingWorkflowNotices.id, noticeId), isNull(meetingWorkflowNotices.readAt)))
    return { ok: true }
  })
}
