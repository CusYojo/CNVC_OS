import { createHash, randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { meetingParticipants, meetings, oaApprovalRecords, oaApprovalRequests, personalWeeklyReportEvents, personalWeeklyReportRecipients, personalWeeklyReports, projectDutyAssignments, projectMembers, projects, todos, users } from '../db/schema.js'
import { projectAccessCondition } from './projectAccessService.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { fdeWeekStart, shiftDate, taskInWeek } from '../contracts/fdeWeeklyPlanContract.js'
import { reportWindow, weeklyReportActionSchema, weeklyReportBody, weeklyReportCreateSchema, weeklyReportSaveSchema, weeklyReportSourceOptions, type WeeklyReportFacts, type WeeklyReportSourceOptions } from '../contracts/fdeWeeklyReportContract.js'
import { canReadReferencedDirectiveTasks, directiveApprovalAccessCondition } from './fdeDirectiveLinksService.js'
import { canReadReportSupplementSources, collectReportCalendar, meetingAudience } from './fdeWeeklyReportSourcesService.js'
import { collectReportOffice } from './fdeOfficeSourcesService.js'
import { collectApprovedMilestones } from './fdeMilestoneSourcesService.js'
import { committeeMeetingAccess } from './fdeCommitteeAccessService.js'

type Reader = Pick<typeof db, 'select'>
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Report = typeof personalWeeklyReports.$inferSelect
const fail = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }) }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sourceDigest = ({ generatedAt: _generatedAt, ...facts }: WeeklyReportFacts) => digest(facts)
const sourceTaskIds = (facts: WeeklyReportFacts) => [...facts.tasks.map((task) => task.id), ...facts.approvals.map((item) => item.taskId).filter((id): id is string => Boolean(id))]

async function actor(reader: Reader, userId: string) {
  const [user] = await reader.select().from(users).where(and(eq(users.id, userId), eq(users.status, '启用')))
  if (!user) return fail('REPORT_ACTOR_UNAVAILABLE', '当前账号不可用', 403)
  return user
}
async function scope(reader: Reader, userId: string, projectIds: string[]) {
  const user = await actor(reader, userId)
  return reader.select({ id: projects.id, name: projects.name }).from(projects).where(and(
    inArray(projects.id, projectIds), eq(projects.workflowModel, 'fde-v1'),
    projectAccessCondition({ uid: user.id, name: user.name, role: user.role }),
  )).orderBy(asc(projects.id))
}
async function requireScope(reader: Reader, userId: string, projectIds: string[]) {
  const visible = await scope(reader, userId, projectIds)
  if (visible.length !== projectIds.length) return fail('REPORT_SOURCE_FORBIDDEN', '周报含有当前无权访问的项目，不能读取、编辑或发布', 403)
  return visible
}
async function lockAuthor(tx: Tx, authorId: string, projectIds: string[]) {
  // 治理、任务先锁项目；周报按项目 ID 排序，再锁作者，避免反转既有锁顺序。
  for (const id of [...projectIds].sort()) await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${id} FOR UPDATE`)
  await tx.execute(sql`SELECT ${users.id} FROM ${users} WHERE ${users.id}=${authorId} FOR UPDATE`)
  await actor(tx, authorId)
}

export async function collectWeeklyReportFacts(reader: Reader, authorId: string, projectIds: string[], weekStart: string, sourceOptions?: WeeklyReportSourceOptions): Promise<WeeklyReportFacts> {
  const projectRows = await requireScope(reader, authorId, projectIds)
  // MySQL JSON reorders object keys. Rebuild options in schema order before source hashing.
  const options = weeklyReportSourceOptions.parse(sourceOptions ?? {})
  const { start, end } = reportWindow(weekStart), weekEnd = shiftDate(weekStart, 6)
  const taskRows = await reader.select({ id: todos.id, projectId: todos.projectId, ownerUserId: todos.ownerUserId, title: todos.title, version: todos.version, status: todos.status, dueDate: todos.dueDate, dueTime: todos.dueTime, completedAt: todos.completedAt, progress: todos.progress })
    .from(todos).where(and(or(inArray(todos.projectId, projectIds), options.independentWork ? isNull(todos.projectId) : undefined), eq(todos.ownerUserId, authorId), isNull(todos.approvalRequestId), ne(todos.type, '流程'))).orderBy(asc(todos.id))
  const completed = (task: typeof taskRows[number]) => task.status === '已完成' && Boolean(task.completedAt && task.completedAt >= start && task.completedAt < end)
  const cancelledDue = (task: typeof taskRows[number]) => task.status === '已取消' && Boolean(task.dueDate && task.dueDate >= weekStart && task.dueDate <= weekEnd)
  const relevant = taskRows.filter((task) => taskInWeek(task, weekStart) || completed(task) || cancelledDue(task))
  const approvals = await reader.select({ id: oaApprovalRecords.id, requestId: oaApprovalRequests.id, projectId: oaApprovalRequests.projectId, taskId: oaApprovalRequests.taskId, title: oaApprovalRequests.title, action: oaApprovalRecords.action, occurredAt: oaApprovalRecords.createdAt })
    .from(oaApprovalRecords).innerJoin(oaApprovalRequests, eq(oaApprovalRequests.id, oaApprovalRecords.requestId))
    .where(and(ne(oaApprovalRequests.businessType, 'office'), inArray(oaApprovalRequests.projectId, projectIds), directiveApprovalAccessCondition(authorId), eq(oaApprovalRecords.operatorUserId, authorId), gte(oaApprovalRecords.createdAt, start), lt(oaApprovalRecords.createdAt, end))).orderBy(asc(oaApprovalRecords.id)).limit(501)
  const meetingRows = await reader.select({ id: meetings.id, projectId: meetings.projectId, title: meetings.title, version: meetings.version, startedAt: meetings.startedAt, hostUserId: meetings.hostUserId, createdBy: meetings.createdBy, workflowKind: meetings.workflowKind })
    .from(meetings).where(and(or(ne(meetings.workflowKind, 'committee'), committeeMeetingAccess(authorId)), or(eq(meetings.workflowKind, 'legacy'), eq(meetings.workflowStatus, 'completed')), or(inArray(meetings.projectId, projectIds), options.independentWork ? isNull(meetings.projectId) : undefined), gte(meetings.startedAt, start), lt(meetings.startedAt, end), or(eq(meetings.hostUserId, authorId), inArray(meetings.id, reader.select({ id: meetingParticipants.meetingId }).from(meetingParticipants).where(eq(meetingParticipants.userId, authorId)))))).orderBy(asc(meetings.id)).limit(501)
  if (relevant.length > 500 || approvals.length > 500 || meetingRows.length > 500) return fail('REPORT_SOURCE_LIMIT', '本周记录超过单次快照容量，请减少所选项目；不会截断生成周报')
  const calendar = await collectReportCalendar(reader, authorId, projectIds, weekStart, options)
  const office = options.office ? await collectReportOffice(reader, authorId, projectIds, weekStart) : undefined
  const milestones = options.projectTimeline ? await collectApprovedMilestones(reader, authorId, weekStart, { projectIds, report: true }) : undefined
  const meetingFacts = await Promise.all(meetingRows.map(async ({ hostUserId, createdBy, workflowKind, ...item }) => ({ ...item, startedAt: item.startedAt.toISOString(), ...(workflowKind === 'committee' ? { committee: true } : {}),
    ...(!item.projectId ? { accessUserIds: await meetingAudience(reader, item.id, hostUserId, createdBy) } : {}) })))
  return {
    weekStart, weekEnd, generatedAt: new Date().toISOString(), projects: projectRows,
    ...(sourceOptions ? { sourceOptions: options } : {}), ...(calendar ? { calendar } : {}),
    ...(office ? { office } : {}),
    ...(milestones ? { milestones } : {}),
    tasks: relevant.map((task) => ({ ...task, completedAt: task.completedAt?.toISOString() ?? null })),
    approvals: approvals.filter((item) => item.projectId !== null).map((item) => ({ ...item, projectId: item.projectId!, occurredAt: item.occurredAt.toISOString() })),
    meetings: meetingFacts,
    metrics: {
      completedInWeek: relevant.filter(completed).length,
      dueInWeek: relevant.filter((task) => task.dueDate && task.dueDate >= weekStart && task.dueDate <= weekEnd && !['已取消', '已归档', '已关闭'].includes(task.status)).length,
      overdueOpen: relevant.filter((task) => task.dueDate && task.dueDate < weekStart && !['已完成', '已取消', '已归档', '已关闭'].includes(task.status)).length,
      cancelledDueInWeek: relevant.filter(cancelledDue).length, approvalActions: approvals.length, meetingRecords: meetingRows.length,
    },
    unavailable: [options.calendar ? '日历按与本周相交的区间取数，记录已安排/取消，不作为任务完成或出席证明；任务截止点在任务中统计，会议投影不重复计数。' : '本次未选择日历来源，不计作 0 项。',
      options.privateCalendar ? '已显式包含本人私人日历；含私人快照的周报不能分享给无权人员。' : '私人日历未纳入本次来源，不表示没有私人安排。',
      '任务状态为生成时快照；未记录完成时刻的历史任务不计入本周完成。', '会议按已登记开始时间及本人参与关系统计，不代表实际出席证明。',
      options.independentWork ? '已包含本人独立待办及本人主持/参与的非项目会议；接收人须同时有权访问原来源。' : '仅包含所选项目工作及显式选择的日历，不包含个人独立待办或非项目会议。',
      ...(options.office ? ['办公仅汇总本人本周在当前修订的提交/决定/撤回/转交事件；选择日历时另纳入本人获批出差/请假，按原申请及附件权限分享。批准不计入任务完成或付款/用印/签署结果；项目审批计数仍单列。'] : []),
      ...(options.projectTimeline ? ['节点日期为所选项目生成时有效的正式批准版本，纳入本周计划日期或本周最终获批记录；不包含周期推算、未批准草案或所有历史改期。节点日期不计任务完成、不产生时间占用，也不代表阶段已通过；已发布快照不会随以后改期重写。'] : []),
      '专用投决会仅在显式选择非项目会议范围时纳入本人有权读取的安排或已确认会议；不汇总其他议题材料，不代表出席或投决通过。',
      options.office ? '外部日历及尚未接入的其他记录不作为已完整取数的来源。' : '本次未选择办公来源，不计作零条；外部日历及尚未接入的其他记录不作为已完整取数的来源。'],
  }
}

async function record(tx: Tx, reportId: string, userId: string, requestId: string, requestHash: string, action: string, reason = '') {
  const [report] = await tx.select().from(personalWeeklyReports).where(eq(personalWeeklyReports.id, reportId))
  const recipients = await tx.select().from(personalWeeklyReportRecipients).where(eq(personalWeeklyReportRecipients.reportId, reportId))
  await tx.insert(personalWeeklyReportEvents).values({ reportId, actorId: userId, requestId, requestHash, action, reason, version: report.version, snapshot: { report, recipients } })
  const identity = createMySqlIdentityRepositoryContext(tx), user = await identity.users.findById(userId)
  await identity.audits.append({ userId, userName: user?.name ?? '未知用户', module: '个人周报', action, target: `${reportId} / v${report.version} / ${requestId}` })
}
async function replay(tx: Tx, requestId: string, requestHash: string) {
  const [event] = await tx.select().from(personalWeeklyReportEvents).where(eq(personalWeeklyReportEvents.requestId, requestId))
  if (event && event.requestHash !== requestHash) return fail('REPORT_REQUEST_REUSED', '请求编号已用于其他内容，请重新打开操作')
  return event
}
async function authored(reader: Reader, reportId: string, authorId: string) {
  const [report] = await reader.select().from(personalWeeklyReports).where(and(eq(personalWeeklyReports.id, reportId), eq(personalWeeklyReports.authorId, authorId)))
  if (!report) return fail('REPORT_NOT_FOUND', '周报不存在或不属于当前用户', 404)
  return report
}

export async function createWeeklyReport(userId: string, raw: unknown) {
  const input = weeklyReportCreateSchema.parse(raw), requestHash = digest({ userId, action: 'create', input })
  return db.transaction(async (tx) => {
    await lockAuthor(tx, userId, input.projectIds)
    await requireScope(tx, userId, input.projectIds)
    const previous = await replay(tx, input.clientRequestId, requestHash)
    if (previous) return { reportId: previous.reportId }
    const activeKey = `${userId}:${input.weekStart}`
    const [active] = await tx.select().from(personalWeeklyReports).where(eq(personalWeeklyReports.activeKey, activeKey))
    if (active) return fail('REPORT_DRAFT_EXISTS', '本周已有草稿，请继续编辑或丢弃后再生成')
    const [latest] = await tx.select().from(personalWeeklyReports).where(and(eq(personalWeeklyReports.authorId, userId), eq(personalWeeklyReports.weekStart, input.weekStart))).orderBy(desc(personalWeeklyReports.revision)).limit(1)
    const facts = await collectWeeklyReportFacts(tx, userId, input.projectIds, input.weekStart, input.sourceOptions), id = randomUUID()
    if (!await canReadReportSupplementSources(tx, facts, userId)) return fail('REPORT_SUPPLEMENT_SCOPE', '部分日历或独立工作来源不可读取', 403)
    await tx.insert(personalWeeklyReports).values({ id, authorId: userId, weekStart: input.weekStart, revision: (latest?.revision ?? 0) + 1, activeKey, facts, sourceHash: sourceDigest(facts), body: weeklyReportBody(facts) })
    await record(tx, id, userId, input.clientRequestId, requestHash, 'create')
    return { reportId: id }
  })
}

export async function saveWeeklyReport(reportId: string, userId: string, raw: unknown) {
  const input = weeklyReportSaveSchema.parse(raw), initial = await authored(db, reportId, userId), ids = initial.facts.projects.map((item) => item.id)
  const requestHash = digest({ reportId, userId, action: 'save', input })
  return db.transaction(async (tx) => {
    await lockAuthor(tx, userId, ids); await requireScope(tx, userId, ids)
    if (await replay(tx, input.clientRequestId, requestHash)) return { reportId }
    const report = await authored(tx, reportId, userId)
    if (!await canReadReportSupplementSources(tx, report.facts, userId)) return fail('REPORT_SUPPLEMENT_SCOPE', '来源权限已变化，不能编辑周报', 403)
    if (report.version !== input.expectedVersion) return fail('VERSION_CONFLICT', '周报已修改，请刷新')
    if (report.status !== 'draft') return fail('REPORT_STATE_INVALID', '已发布正文不可编辑，请生成新修订')
    await tx.update(personalWeeklyReports).set({ body: input.body, version: report.version + 1, updatedAt: new Date() }).where(eq(personalWeeklyReports.id, reportId))
    await record(tx, reportId, userId, input.clientRequestId, requestHash, 'save')
    return { reportId }
  })
}

export async function actOnWeeklyReport(reportId: string, userId: string, raw: unknown) {
  const input = weeklyReportActionSchema.parse(raw), initial = await authored(db, reportId, userId), ids = initial.facts.projects.map((item) => item.id)
  const requestHash = digest({ reportId, userId, input })
  return db.transaction(async (tx) => {
    await lockAuthor(tx, userId, ids)
    // 失去项目权限仍允许作者撤回自己曾发出的内容，但不允许取回正文或再次发布。
    if (!['withdraw', 'discard'].includes(input.action)) await requireScope(tx, userId, ids)
    if (await replay(tx, input.clientRequestId, requestHash)) return { reportId }
    const report = await authored(tx, reportId, userId)
    if (report.version !== input.expectedVersion) return fail('VERSION_CONFLICT', '周报已修改，请刷新')
    if (report.status !== (input.action === 'withdraw' ? 'published' : 'draft')) return fail('REPORT_STATE_INVALID', '当前周报状态不允许此操作')
    const patch: Partial<typeof personalWeeklyReports.$inferInsert> = { version: report.version + 1, updatedAt: new Date() }
    if (input.action === 'regenerate' || input.action === 'publish') {
      const facts = await collectWeeklyReportFacts(tx, userId, ids, report.weekStart, report.facts.sourceOptions), sourceHash = sourceDigest(facts)
      if (!await canReadReportSupplementSources(tx, facts, userId)) return fail('REPORT_SUPPLEMENT_SCOPE', '部分日历或独立工作来源不可读取', 403)
      if (input.action === 'regenerate') Object.assign(patch, { facts, sourceHash, body: weeklyReportBody(facts) })
      else {
        if (sourceHash !== report.sourceHash) return fail('REPORT_SOURCE_CHANGED', '来源记录已变化，请重新生成并核对正文后再发布')
        for (const recipientId of input.recipientIds) {
          if (recipientId === userId) return fail('REPORT_RECIPIENT_INVALID', '本人不需要重复加入接收名单', 400)
          await requireScope(tx, recipientId, ids)
          if (!await canReadReferencedDirectiveTasks(tx, sourceTaskIds(report.facts), recipientId)) return fail('REPORT_DIRECTIVE_SCOPE', '接收人无权查看周报中的批示来源，不能分享', 403)
          if (!await canReadReportSupplementSources(tx, report.facts, recipientId)) return fail('REPORT_SUPPLEMENT_SCOPE', '接收人无权查看日历或独立工作来源，不能分享', 403)
        }
        if (input.recipientIds.length) await tx.insert(personalWeeklyReportRecipients).values(input.recipientIds.map((recipientId) => ({ reportId, userId: recipientId })))
        Object.assign(patch, { status: 'published', activeKey: null, publishedAt: new Date() })
      }
    } else {
      Object.assign(patch, { status: input.action === 'withdraw' ? 'withdrawn' : 'discarded', activeKey: null })
      await tx.update(personalWeeklyReportRecipients).set({ closedAt: new Date() }).where(and(eq(personalWeeklyReportRecipients.reportId, reportId), isNull(personalWeeklyReportRecipients.closedAt)))
    }
    await tx.update(personalWeeklyReports).set(patch).where(eq(personalWeeklyReports.id, reportId))
    await record(tx, reportId, userId, input.clientRequestId, requestHash, input.action, input.reason)
    return { reportId }
  })
}

export async function listWeeklyReports(userId: string, rawWeek: string) {
  const weekStart = fdeWeekStart.parse(rawWeek)
  return db.transaction(async (tx) => {
    await actor(tx, userId)
    const received = tx.select({ id: personalWeeklyReportRecipients.reportId }).from(personalWeeklyReportRecipients).where(and(eq(personalWeeklyReportRecipients.userId, userId), isNull(personalWeeklyReportRecipients.closedAt)))
    const rows = await tx.select().from(personalWeeklyReports).where(and(eq(personalWeeklyReports.weekStart, weekStart), or(eq(personalWeeklyReports.authorId, userId), and(eq(personalWeeklyReports.status, 'published'), inArray(personalWeeklyReports.id, received))))).orderBy(desc(personalWeeklyReports.createdAt)).limit(201)
    if (rows.length > 200) return fail('REPORT_LIST_LIMIT', '当周周报超过展示上限，请联系管理员扩展分页，不会截断结果')
    const reports = []
    for (const report of rows) {
      const ids = report.facts.projects.map((item) => item.id), visible = await scope(tx, userId, ids), own = report.authorId === userId
      if (visible.length !== ids.length || !await canReadReferencedDirectiveTasks(tx, sourceTaskIds(report.facts), userId) || !await canReadReportSupplementSources(tx, report.facts, userId)) {
        if (own) reports.push({ id: report.id, weekStart, revision: report.revision, version: report.version, status: report.status, own, restricted: true, body: '', facts: null, sourceChanged: false, events: [], recipients: [] })
        continue
      }
      const events = own ? await tx.select({ action: personalWeeklyReportEvents.action, version: personalWeeklyReportEvents.version, reason: personalWeeklyReportEvents.reason, createdAt: personalWeeklyReportEvents.createdAt }).from(personalWeeklyReportEvents).where(eq(personalWeeklyReportEvents.reportId, report.id)).orderBy(desc(personalWeeklyReportEvents.version)) : []
      const recipients = await tx.select({ userId: personalWeeklyReportRecipients.userId, name: users.name, readAt: personalWeeklyReportRecipients.readAt, closedAt: personalWeeklyReportRecipients.closedAt }).from(personalWeeklyReportRecipients).innerJoin(users, eq(users.id, personalWeeklyReportRecipients.userId)).where(and(eq(personalWeeklyReportRecipients.reportId, report.id), own ? undefined : eq(personalWeeklyReportRecipients.userId, userId)))
      const current = report.status === 'draft' ? await collectWeeklyReportFacts(tx, userId, ids, weekStart, report.facts.sourceOptions) : null
      reports.push({ id: report.id, weekStart, revision: report.revision, version: report.version, status: report.status, own, restricted: false, body: report.body, facts: report.facts, sourceChanged: Boolean(current && sourceDigest(current) !== report.sourceHash), events, recipients })
    }
    return { reports }
  })
}

export async function weeklyReportRecipients(reportId: string, userId: string) {
  return db.transaction(async (tx) => {
    const report = await authored(tx, reportId, userId), ids = report.facts.projects.map((item) => item.id)
    await requireScope(tx, userId, ids)
    if (!await canReadReportSupplementSources(tx, report.facts, userId)) return fail('REPORT_SUPPLEMENT_SCOPE', '来源权限已变化，不能分享周报', 403)
    const candidates = await tx.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.status, '启用'), ne(users.id, userId), ids.length ? or(
      inArray(users.id, tx.select({ id: projectMembers.userId }).from(projectMembers).where(inArray(projectMembers.projectId, ids))),
      inArray(users.id, tx.select({ id: projects.ownerUserId }).from(projects).where(inArray(projects.id, ids))),
      inArray(users.id, tx.select({ id: projectDutyAssignments.userId }).from(projectDutyAssignments).where(inArray(projectDutyAssignments.projectId, ids))),
    ) : undefined)).orderBy(asc(users.name)).limit(501)
    if (candidates.length > 500) return fail('REPORT_RECIPIENT_LIMIT', '候选人员过多，请缩小项目范围')
    const allowed = []
    for (const candidate of candidates) if ((await scope(tx, candidate.id, ids)).length === ids.length && await canReadReferencedDirectiveTasks(tx, sourceTaskIds(report.facts), candidate.id) && await canReadReportSupplementSources(tx, report.facts, candidate.id)) allowed.push(candidate)
    return { recipients: allowed }
  })
}

export async function readWeeklyReport(reportId: string, userId: string) {
  return db.transaction(async (tx) => {
    // 与撤回串行，撤回之后不能将已失效通知重新标为有效。
    await tx.execute(sql`SELECT ${personalWeeklyReports.id} FROM ${personalWeeklyReports} WHERE ${personalWeeklyReports.id}=${reportId} FOR UPDATE`)
    const [report] = await tx.select().from(personalWeeklyReports).where(and(eq(personalWeeklyReports.id, reportId), eq(personalWeeklyReports.status, 'published')))
    const [recipient] = await tx.select().from(personalWeeklyReportRecipients).where(and(eq(personalWeeklyReportRecipients.reportId, reportId), eq(personalWeeklyReportRecipients.userId, userId), isNull(personalWeeklyReportRecipients.closedAt)))
    if (!report || !recipient) return fail('REPORT_NOT_FOUND', '周报不存在或当前不可读', 404)
    await requireScope(tx, userId, report.facts.projects.map((item) => item.id))
    if (!await canReadReferencedDirectiveTasks(tx, sourceTaskIds(report.facts), userId)) return fail('REPORT_DIRECTIVE_SCOPE', '批示来源权限已变化，不能读取周报', 403)
    if (!await canReadReportSupplementSources(tx, report.facts, userId)) return fail('REPORT_SUPPLEMENT_SCOPE', '日历或独立工作来源权限已变化，不能读取周报', 403)
    await tx.update(personalWeeklyReportRecipients).set({ readAt: new Date() }).where(and(eq(personalWeeklyReportRecipients.id, recipient.id), isNull(personalWeeklyReportRecipients.readAt)))
    return { ok: true }
  })
}
