import { and, eq, gt, gte, inArray, isNotNull, lt, ne, notInArray, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { leaderTimeRequests, meetings, meetingParticipants, personalCalendarEvents, users } from '../db/schema.js'
import { intervalsOverlap, timeEnd } from '../contracts/fdeTimeContract.js'

type Reader = Pick<typeof db, 'select'>
export type ScheduleTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Options = { confirmedOnly?: boolean; excludeTimeIds?: string[]; excludeCalendarId?: string; excludeMeetingId?: string }

// All schedule writers lock projects first (when applicable), then stable people IDs in this order.
// Transactions which read before these locks must use READ COMMITTED, not a stale RR snapshot.
// Notification/identity foreign keys can still acquire locks in another order;
// schedule write entrypoints also use scheduleTransaction for whole-tx deadlock retry.
export async function lockSchedulePeople(tx: ScheduleTx, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) await tx.execute(sql`SELECT ${users.id} FROM ${users} WHERE ${users.id}=${id} FOR UPDATE`)
}

export async function scheduleConflicts(reader: Reader, userId: string, startsAt: Date, endsAt: Date, options: Options = {}) {
  const times = await reader.select({ startsAt: leaderTimeRequests.scheduledStart, duration: leaderTimeRequests.durationMinutes }).from(leaderTimeRequests)
    .where(and(eq(leaderTimeRequests.leaderId, userId), options.excludeTimeIds?.length ? notInArray(leaderTimeRequests.id, options.excludeTimeIds) : undefined,
      inArray(leaderTimeRequests.status, options.confirmedOnly ? ['confirmed'] : ['requested', 'pending', 'confirmed']), isNotNull(leaderTimeRequests.scheduledStart),
      gte(leaderTimeRequests.scheduledStart, new Date(startsAt.getTime() - 780 * 60000)), lt(leaderTimeRequests.scheduledStart, endsAt)))
  const personal = await reader.select({ startsAt: personalCalendarEvents.startsAt, endsAt: personalCalendarEvents.endsAt }).from(personalCalendarEvents)
    .where(and(eq(personalCalendarEvents.ownerId, userId), options.excludeCalendarId ? ne(personalCalendarEvents.id, options.excludeCalendarId) : undefined,
      eq(personalCalendarEvents.status, 'active'), lt(personalCalendarEvents.startsAt, endsAt), gt(personalCalendarEvents.endsAt, startsAt)))
  const scheduled = await reader.select({ startsAt: meetings.startedAt, endsAt: meetings.endsAt }).from(meetings)
    .where(and(options.excludeMeetingId ? ne(meetings.id, options.excludeMeetingId) : undefined, isNotNull(meetings.endsAt), lt(meetings.startedAt, endsAt), gt(meetings.endsAt, startsAt),
      or(
        and(eq(meetings.workflowKind, 'legacy'), notInArray(meetings.workflowStatus, ['cancelled', 'deleted'])),
        and(ne(meetings.workflowKind, 'legacy'), inArray(meetings.workflowStatus, ['scheduled', 'completed'])),
      ),
      or(eq(meetings.hostUserId, userId), inArray(meetings.id, reader.select({ id: meetingParticipants.meetingId }).from(meetingParticipants).where(eq(meetingParticipants.userId, userId))))))
  // Never disclose another object's ID, title, project, or private reason in conflict responses.
  return [...times.map(row => ({ startsAt: row.startsAt!, endsAt: timeEnd(row.startsAt!, row.duration) })), ...personal,
    ...scheduled.map(row => ({ startsAt: row.startsAt, endsAt: row.endsAt! }))]
    .filter(row => intervalsOverlap(startsAt, endsAt, row.startsAt, row.endsAt))
    .map(row => ({ startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), title: '已占用' }))
}

export async function requireMeetingSlot(tx: ScheduleTx, meetingId: string, participantIds: string[], startsAt: Date, endsAt: Date | null) {
  if (!endsAt) return // Historical minutes without an end time are not a fabricated timed reservation.
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) {
    throw Object.assign(new Error('会议结束时间必须晚于开始时间'), { code: 'MEETING_TIME_INVALID', status: 400 })
  }
  for (const id of [...new Set(participantIds)]) {
    if ((await scheduleConflicts(tx, id, startsAt, endsAt, { confirmedOnly: true, excludeMeetingId: meetingId })).length) {
      throw Object.assign(new Error('参会人存在重叠的有效安排，请调整会议时间；无权事项仅作为占用校验'), { code: 'MEETING_TIME_CONFLICT', status: 409 })
    }
  }
}
