import { and, asc, eq, gte, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm'
import { oaApprovalRequests as requests, oaApprovalNodes as nodes, oaApprovalRecords as records, oaOfficeEvents as events } from '../db/schema.js'
import { officeCalendarWindow, officeSourceActionLabels, type OfficeReportSource } from '../contracts/fdeOfficeSourcesContract.js'
import { reportWindow } from '../contracts/fdeWeeklyReportContract.js'
import { shiftDate } from '../contracts/fdeWeeklyPlanContract.js'
import { officeAccessCondition, officeFail, officeReadable, type OfficeReader } from './fdeOfficeAccessService.js'

export async function readableOfficeSource(reader: OfficeReader, requestId: string, userId: string) {
  try { return await officeReadable(reader, requestId, userId) }
  catch (error) { if ((error as { status?: number }).status === 403 && String((error as { code?: string }).code).startsWith('OFFICE_')) return null; throw error }
}

// Snapshot sharing can only become narrower. A later role/grant change does not
// silently add an audience to an already generated report.
export async function officeSourceAudience(reader: OfficeReader, row: typeof requests.$inferSelect) {
  const chain = await reader.select({ ids: nodes.approverUserIds }).from(nodes).where(eq(nodes.requestId, row.id))
  const processed = await reader.select({ id: records.operatorUserId }).from(records).where(eq(records.requestId, row.id))
  const candidates = [...new Set([row.applicantUserId, ...chain.flatMap(n => n.ids), ...processed.map(r => r.id)].filter((id): id is string => Boolean(id)))].sort()
  if (candidates.length > 500) return officeFail('REPORT_SOURCE_LIMIT', '办公来源接收范围超过快照容量，不截断授权')
  const audience: string[] = []
  for (const id of candidates) if (await readableOfficeSource(reader, row.id, id)) audience.push(id)
  return audience
}

export async function approvedOfficeCalendar(reader: OfficeReader, userId: string, week: string, view: 'personal' | 'company', projectIds?: string[]) {
  const next = shiftDate(week, 7), { start, end } = reportWindow(week)
  const details = sql`JSON_EXTRACT(${requests.businessPayload}, '$.definition.details')`
  const travel = and(eq(requests.type, '出差'), sql`JSON_UNQUOTE(JSON_EXTRACT(${details},'$.startDate')) < ${next}`, sql`JSON_UNQUOTE(JSON_EXTRACT(${details},'$.endDate')) >= ${week}`)
  const leave = and(eq(requests.type, '请假'), sql`JSON_UNQUOTE(JSON_EXTRACT(${details},'$.startAt')) < ${`${next}T00:00`}`, sql`JSON_UNQUOTE(JSON_EXTRACT(${details},'$.endAt')) > ${`${week}T00:00`}`)
  const rows = await reader.select().from(requests).where(and(eq(requests.businessType, 'office'), eq(requests.status, '已通过'), or(travel, leave),
    view === 'personal' ? or(and(eq(requests.type, '请假'), eq(requests.applicantUserId, userId)), and(eq(requests.type, '出差'), sql`JSON_CONTAINS(${details},JSON_QUOTE(${userId}),'$.travelerIds')`)) : undefined,
    projectIds ? and(or(isNull(requests.projectId), inArray(requests.projectId, projectIds)), officeAccessCondition(userId)) : undefined,
  )).orderBy(asc(requests.id)).limit(501)
  if (rows.length > 500) return officeFail('CALENDAR_LIST_LIMIT', '办公日历来源超过单次容量，不会静默截断')
  const items = []
  for (const row of rows) {
    const window = officeCalendarWindow(row.businessPayload.definition, row.applicantUserId)
    if (!window || window.startsAt >= end || window.endsAt <= start) continue
    const readable = Boolean(await readableOfficeSource(reader, row.id, userId))
    // Reports never collect redacted busy slots as business facts.
    if (projectIds && !readable) continue
    for (const ownerId of window.ownerIds.filter(id => view === 'company' || id === userId)) items.push({ row, window, ownerId, readable })
  }
  if (items.length > 500) return officeFail('CALENDAR_LIST_LIMIT', '办公日历人员投影超过单次容量，不会静默截断')
  return items
}

export async function collectReportOffice(reader: OfficeReader, authorId: string, projectIds: string[], week: string): Promise<OfficeReportSource[]> {
  const { start, end } = reportWindow(week)
  const activity = reader.select({ id: events.requestId }).from(events).where(and(eq(events.actorId, authorId), inArray(events.action, Object.keys(officeSourceActionLabels)), gte(events.createdAt, start), lt(events.createdAt, end)))
  const rows = await reader.select().from(requests).where(and(officeAccessCondition(authorId), notInArray(requests.status, ['草稿', '已删除']),
    or(isNull(requests.projectId), inArray(requests.projectId, projectIds)), inArray(requests.id, activity))).orderBy(asc(requests.id)).limit(501)
  if (rows.length > 500) return officeFail('REPORT_SOURCE_LIMIT', '办公来源超过单次快照容量，不会截断生成')
  const facts: OfficeReportSource[] = []
  let actionCount = 0
  for (const row of rows) {
    if (!await readableOfficeSource(reader, row.id, authorId)) continue
    const actions = await reader.select({ id: events.id, action: events.action, occurredAt: events.createdAt }).from(events).where(and(
      eq(events.requestId, row.id), eq(events.actorId, authorId), inArray(events.action, Object.keys(officeSourceActionLabels)),
      gte(events.createdAt, start), lt(events.createdAt, end), sql`JSON_EXTRACT(${events.snapshot},'$.request.officeRevision') = ${row.officeRevision}`,
    )).orderBy(asc(events.version)).limit(501)
    actionCount += actions.length
    if (actionCount > 500) return officeFail('REPORT_SOURCE_LIMIT', '办公操作超过单次快照容量，不会截断生成')
    if (!actions.length) continue
    facts.push({ id: row.id, projectId: row.projectId, title: row.title, kind: row.type, status: row.status, version: row.lockVersion, revision: row.officeRevision,
      accessUserIds: await officeSourceAudience(reader, row), actions: actions.map(a => ({ ...a, action: officeSourceActionLabels[a.action], occurredAt: a.occurredAt.toISOString() })) })
  }
  return facts
}

export async function canReadOfficeSnapshot(reader: OfficeReader, source: { id: string; projectId: string | null; revision?: number; accessUserIds?: string[] }, userId: string) {
  if (!source.accessUserIds?.includes(userId) || !source.revision) return false
  const current = await readableOfficeSource(reader, source.id, userId)
  return Boolean(current && current.projectId === source.projectId && current.officeRevision === source.revision)
}
