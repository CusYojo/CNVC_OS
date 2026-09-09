import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { leaderTimeRequests, meetingParticipants, meetings, personalCalendarEvents, todos } from '../db/schema.js'
import { reportWindow, type WeeklyReportCalendarFact, type WeeklyReportFacts, type WeeklyReportSourceOptions } from '../contracts/fdeWeeklyReportContract.js'
import { canReadReferencedDirectiveTasks } from './fdeDirectiveLinksService.js'
import { approvedOfficeCalendar, canReadOfficeSnapshot, officeSourceAudience } from './fdeOfficeSourcesService.js'
import { canReadMilestoneSnapshot } from './fdeMilestoneSourcesService.js'
import { canReadCommitteeMeeting, committeeMeetingAccess } from './fdeCommitteeAccessService.js'

type Reader = Pick<typeof db, 'select'>
export async function meetingAudience(reader: Reader, id: string, hostId: string | null, creatorId: string | null) {
  const people = await reader.select({ id: meetingParticipants.userId }).from(meetingParticipants).where(eq(meetingParticipants.meetingId, id))
  const ids = [...new Set([hostId, creatorId, ...people.map(row => row.id)].filter((value): value is string => Boolean(value)))].sort()
  const [meeting] = await reader.select({ kind: meetings.workflowKind }).from(meetings).where(eq(meetings.id, id))
  if (meeting?.kind !== 'committee') return ids
  const permitted: string[] = []
  for (const uid of ids) if (await canReadCommitteeMeeting(reader, id, uid)) permitted.push(uid)
  return permitted
}

export async function collectReportCalendar(reader: Reader, authorId: string, projectIds: string[], week: string, options: WeeklyReportSourceOptions) {
  if (!options.calendar) return undefined
  const { start, end } = reportWindow(week), result: WeeklyReportCalendarFact[] = []
  const personal = await reader.select().from(personalCalendarEvents).where(and(eq(personalCalendarEvents.ownerId, authorId),
    options.privateCalendar ? undefined : eq(personalCalendarEvents.visibility, 'company'),
    lt(personalCalendarEvents.startsAt, end), gt(personalCalendarEvents.endsAt, start))).limit(501)
  for (const row of personal) result.push({ id: row.id, source: 'personal', projectId: null, ownerId: row.ownerId, title: row.title, version: row.version,
    startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), status: row.status, visibility: row.visibility as 'private' | 'company' })
  const times = await reader.select().from(leaderTimeRequests).where(and(inArray(leaderTimeRequests.projectId, projectIds),
    or(eq(leaderTimeRequests.leaderId, authorId), eq(leaderTimeRequests.submittedBy, authorId)), inArray(leaderTimeRequests.status, ['confirmed', 'cancelled']),
    isNotNull(leaderTimeRequests.scheduledStart), lt(leaderTimeRequests.scheduledStart, end),
    gt(sql`DATE_ADD(${leaderTimeRequests.scheduledStart}, INTERVAL ${leaderTimeRequests.durationMinutes} MINUTE)`, start))).limit(501)
  for (const row of times) {
    if (row.taskId && !await canReadReferencedDirectiveTasks(reader, [row.taskId], authorId)) continue
    result.push({ id: row.id, source: 'leader', projectId: row.projectId, ownerId: row.leaderId, title: row.title, version: row.version,
      startsAt: row.scheduledStart!.toISOString(), endsAt: new Date(row.scheduledStart!.getTime() + row.durationMinutes * 60000).toISOString(), status: row.status, visibility: 'project', taskId: row.taskId })
  }
  const participant = reader.select({ id: meetingParticipants.meetingId }).from(meetingParticipants).where(eq(meetingParticipants.userId, authorId))
  const meetingRows = await reader.select().from(meetings).where(and(
    or(ne(meetings.workflowKind, 'committee'), committeeMeetingAccess(authorId)),
    or(inArray(meetings.projectId, projectIds), options.independentWork ? isNull(meetings.projectId) : undefined),
    or(eq(meetings.hostUserId, authorId), inArray(meetings.id, participant)),
    or(
      and(eq(meetings.workflowKind, 'legacy'), notInArray(meetings.workflowStatus, ['cancelled', 'deleted'])),
      and(ne(meetings.workflowKind, 'legacy'), inArray(meetings.workflowStatus, ['scheduled', 'completed'])),
    ),
    lt(meetings.startedAt, end), or(gt(meetings.endsAt, start), and(isNull(meetings.endsAt), gte(meetings.startedAt, start))),
  )).limit(501)
  for (const row of meetingRows) result.push({ id: row.id, source: 'meeting', projectId: row.projectId, ownerId: row.hostUserId ?? authorId,
    title: row.title, version: row.version, startsAt: row.startedAt.toISOString(), endsAt: row.endsAt?.toISOString() ?? null, status: row.workflowStatus,
    visibility: row.projectId ? 'project' : 'private', ...(row.workflowKind === 'committee' ? { committee: true } : {}), ...(!row.projectId ? { accessUserIds: await meetingAudience(reader, row.id, row.hostUserId, row.createdBy) } : {}) })
  if (options.office) for (const { row, window, ownerId } of await approvedOfficeCalendar(reader, authorId, week, 'personal', projectIds)) {
    result.push({ id: row.id, source: 'office', projectId: row.projectId, ownerId, title: row.title, version: row.lockVersion, revision: row.officeRevision,
      startsAt: window.startsAt.toISOString(), endsAt: window.endsAt.toISOString(), status: 'approved', visibility: 'private', accessUserIds: await officeSourceAudience(reader, row) })
  }
  if (personal.length > 500 || times.length > 500 || meetingRows.length > 500 || result.length > 500) {
    throw Object.assign(new Error('日历来源超过单次快照容量，请缩小范围；不会截断生成'), { code: 'REPORT_SOURCE_LIMIT', status: 409 })
  }
  return result.sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id))
}

// Current authorization AND the snapshot's original sharing boundary; making a formerly
// private source public must not expose its earlier private snapshot through a report.
export async function canReadReportSupplementSources(reader: Reader, facts: WeeklyReportFacts, userId: string) {
  for (const item of facts.milestones ?? []) if (!facts.projects.some(project => project.id === item.projectId) || !await canReadMilestoneSnapshot(reader, item, userId)) return false
  for (const task of facts.tasks.filter(row => !row.projectId)) {
    const [current] = await reader.select().from(todos).where(eq(todos.id, task.id))
    if (!current || current.projectId || current.ownerUserId !== userId || task.ownerUserId !== userId) return false
  }
  for (const item of facts.calendar ?? []) {
    if (item.source === 'personal') {
      const [current] = await reader.select().from(personalCalendarEvents).where(eq(personalCalendarEvents.id, item.id))
      if (!current || current.ownerId !== item.ownerId || !(current.ownerId === userId || item.visibility === 'company' && current.visibility === 'company')) return false
    } else if (item.source === 'leader') {
      const [current] = await reader.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.id, item.id))
      if (!current || current.projectId !== item.projectId || !facts.projects.some(p => p.id === current.projectId)) return false
      if (!await canReadReferencedDirectiveTasks(reader, [item.taskId, current.taskId].filter((id): id is string => Boolean(id)), userId)) return false
    } else if (item.source === 'office') {
      if (!await canReadOfficeSnapshot(reader, item, userId)) return false
    }
  }
  for (const item of facts.office ?? []) if (!await canReadOfficeSnapshot(reader, item, userId)) return false
  const meetingRefs = [...facts.meetings, ...(facts.calendar ?? []).filter(row => row.source === 'meeting')]
  for (const item of meetingRefs) {
    const [current] = await reader.select().from(meetings).where(eq(meetings.id, item.id))
    if (!current || current.projectId !== item.projectId) return false
    if (!item.projectId && (!item.accessUserIds?.includes(userId) || !(await meetingAudience(reader, item.id, current.hostUserId, current.createdBy)).includes(userId))) return false
  }
  return true
}
