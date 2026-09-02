import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, inArray, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { meetingParticipants, meetingWorkflowNotices, meetings, todos, auditLogs, projectFiles, projectMembers, projects, users } from '../db/schema.js'
import {
  isSystemAdmin,
  projectAccessCondition,
  type ProjectAccessActor,
} from './projectAccessService.js'
import {
  syncMeetingIdentityBindings,
  syncTodoOwnerIdentity,
} from './identityResolutionService.js'
import { businessVersionConflict } from './businessOptimisticLock.js'
import { prepareFdeTodo } from './fdeTaskService.js'
import { directiveTaskAccessCondition } from './fdeDirectiveLinksService.js'
import { scheduleTransaction } from './fdeScheduleTransactionService.js'
import { requireProjectFileAccess } from './projectFileAccessService.js'

type MeetingContribution = {
  id: string
  authorId: string
  authorName: string
  content: string
  files: Array<{ id: string; name: string; version: number }>
  createdAt: string
}
type ProjectMeetingWorkspace = {
  kind: 'project_meeting_workspace'
  purpose: string
  requirements: string
  contributions: MeetingContribution[]
}

function projectMeetingWorkspace(value: unknown): ProjectMeetingWorkspace {
  const source = value && typeof value === 'object' ? value as Partial<ProjectMeetingWorkspace> : {}
  if (source.kind !== 'project_meeting_workspace') return { kind: 'project_meeting_workspace', purpose: '', requirements: '', contributions: [] }
  const contributions = Array.isArray(source.contributions) ? source.contributions.filter((item): item is MeetingContribution => Boolean(item && typeof item === 'object' && typeof item.id === 'string' && typeof item.authorName === 'string')) : []
  return { kind: 'project_meeting_workspace', purpose: typeof source.purpose === 'string' ? source.purpose : '', requirements: typeof source.requirements === 'string' ? source.requirements : '', contributions }
}

function meetingAccessCondition(actor: ProjectAccessActor) {
  const accessibleProjectIds = db.select({ id: projects.id }).from(projects)
    .where(projectAccessCondition(actor))
  return or(
    inArray(meetings.projectId, accessibleProjectIds),
    and(
      isNull(meetings.projectId),
      isSystemAdmin(actor) ? sql<boolean>`TRUE` : or(
        eq(meetings.createdBy, actor.uid),
        eq(meetings.hostUserId, actor.uid),
        inArray(
          meetings.id,
          db.select({ id: meetingParticipants.meetingId }).from(meetingParticipants)
            .where(eq(meetingParticipants.userId, actor.uid)),
        ),
      ),
    ),
  )!
}

export function todoAccessCondition(actor: ProjectAccessActor) {
  const accessibleProjectIds = db.select({ id: projects.id }).from(projects)
    .where(projectAccessCondition(actor))
  return and(directiveTaskAccessCondition(actor.uid), or(
    inArray(todos.projectId, accessibleProjectIds),
    and(
      isNull(todos.projectId),
      isSystemAdmin(actor) ? sql<boolean>`TRUE` : or(eq(todos.createdBy, actor.uid), eq(todos.ownerUserId, actor.uid)),
    ),
  ))!
}

export async function listMeetings(projectId?: string, actor?: ProjectAccessActor) {
  const conditions = [and(ne(meetings.workflowKind, 'committee'), or(eq(meetings.workflowKind, 'legacy'), eq(meetings.workflowStatus, 'completed')))]
  if (projectId) conditions.push(eq(meetings.projectId, projectId))
  if (actor) conditions.push(meetingAccessCondition(actor))
  const where = conditions.length ? and(...conditions) : undefined
  return db.select().from(meetings).where(where as never).orderBy(desc(meetings.startedAt)).limit(50)
}

export async function getMeeting(id: string, actor?: ProjectAccessActor) {
  const visible = and(ne(meetings.workflowKind, 'committee'), or(eq(meetings.workflowKind, 'legacy'), eq(meetings.workflowStatus, 'completed')))
  const where = actor
    ? and(eq(meetings.id, id), meetingAccessCondition(actor), visible)
    : and(eq(meetings.id, id), visible)
  const rows = await db.select().from(meetings).where(where).limit(1)
  return rows[0]
}

export type PublicMeeting = {
  id: string
  projectId: string
  projectName: string
  title: string
  meetingTime: string
  meetingEndTime: string | null
  participants: string[]
  host: string
  type: string
  status: '待开始' | '进行中' | '已结束' | '已取消'
  purpose: string
  requirements: string
  summary: string
  conclusions: string[]
  rawText: string
  todoCount: number
  contributions: MeetingContribution[]
  unreadNoticeId: string | null
  canContribute: boolean
  canManage: boolean
  minutesConfirmedAt: string | null
  version: number
}

function publicMeeting(row: typeof meetings.$inferSelect, todoCount: number, unreadNoticeId: string | null, canContribute: boolean, canManage: boolean): PublicMeeting {
  const workspace = projectMeetingWorkspace(row.weeklyReview)
  const now = Date.now()
  const status = row.workflowStatus === 'cancelled' ? '已取消' : row.workflowStatus === 'completed' || Boolean(row.confirmedAt) || Boolean(row.endsAt && row.endsAt.getTime() <= now) ? '已结束' : row.startedAt.getTime() <= now ? '进行中' : '待开始'
  return {
    id: row.id,
    projectId: row.projectId ?? '',
    projectName: row.projectName,
    title: row.title,
    meetingTime: row.startedAt.toISOString(),
    meetingEndTime: row.endsAt?.toISOString() ?? null,
    participants: Array.isArray(row.attendees) ? row.attendees : [],
    host: row.host,
    type: row.type,
    status,
    purpose: workspace.purpose,
    requirements: workspace.requirements,
    summary: row.aiSummary ?? '',
    conclusions: Array.isArray(row.conclusions) ? row.conclusions : [],
    rawText: row.rawTranscript ?? '',
    todoCount,
    contributions: workspace.contributions,
    unreadNoticeId,
    canContribute,
    canManage,
    minutesConfirmedAt: row.confirmedAt?.toISOString() ?? null,
    version: row.version,
  }
}

export async function presentMeetings(rows: (typeof meetings.$inferSelect)[], actorId?: string) {
  if (!rows.length) return []
  const ids = rows.map((row) => row.id)
  const counts = await db.select({
    meetingId: todos.meetingId,
    value: sql<number>`count(*)`,
  }).from(todos).where(inArray(todos.meetingId, ids)).groupBy(todos.meetingId)
  const byMeeting = new Map(counts.map((row) => [row.meetingId, Number(row.value)]))
  const participation = actorId ? await db.select({ meetingId: meetingParticipants.meetingId }).from(meetingParticipants).where(and(inArray(meetingParticipants.meetingId, ids), eq(meetingParticipants.userId, actorId))) : []
  const participantMeetings = new Set(participation.map((row) => row.meetingId))
  const notices = actorId ? await db.select({ id: meetingWorkflowNotices.id, meetingId: meetingWorkflowNotices.meetingId }).from(meetingWorkflowNotices).where(and(inArray(meetingWorkflowNotices.meetingId, ids), eq(meetingWorkflowNotices.recipientId, actorId), isNull(meetingWorkflowNotices.readAt), isNull(meetingWorkflowNotices.closedAt))) : []
  const noticeByMeeting = new Map(notices.map((row) => [row.meetingId, row.id]))
  return rows.map((row) => publicMeeting(row, byMeeting.get(row.id) ?? 0, noticeByMeeting.get(row.id) ?? null, Boolean(actorId && row.workflowStatus !== 'cancelled' && (row.createdBy === actorId || row.hostUserId === actorId || participantMeetings.has(row.id))), Boolean(actorId && (row.createdBy === actorId || row.hostUserId === actorId))))
}

export async function presentMeeting(row: typeof meetings.$inferSelect, actorId?: string) {
  const [presented] = await presentMeetings([row], actorId)
  return presented
}


// 会议纪要自动汇入统一知识库 scope=project(仅当挂了项目)
async function ingestMeeting(row: typeof meetings.$inferSelect) {
  try {
    if (!row.projectId) return
    const { ingestToKnowledge } = await import('./ragService.js')
    const parts = [
      `会议：${row.title}(${row.type})`,
      row.host ? `主持：${row.host}` : '',
      Array.isArray(row.attendees) && row.attendees.length ? `参会：${(row.attendees as string[]).join('、')}` : '',
      row.aiSummary ? `纪要摘要：${row.aiSummary}` : '',
      Array.isArray(row.conclusions) && row.conclusions.length ? `结论：${(row.conclusions as string[]).join('；')}` : '',
      row.rawTranscript ? `转录：${row.rawTranscript}` : '',
    ].filter(Boolean).join('\n')
    await ingestToKnowledge({ scope: 'project', refId: row.projectId, sourceType: 'meeting', sourceId: row.id, sourceName: row.title, text: parts })
  } catch { /* 不阻断 */ }
}

export async function createMeeting(
  input: typeof meetings.$inferInsert,
  newTodos: (typeof todos.$inferInsert)[],
  userId: string,
  userName = '（系统）',
  participantUserIds?: string[],
) {
  if (input.workflowKind === 'friday' || input.type === '周五例会') throw Object.assign(new Error('请通过周五例会工作区创建、排期和确认纪要'), { status: 409, code: 'FDE_MEETING_WORKFLOW_REQUIRED' })
  const insertedId = await scheduleTransaction(async (tx) => {
    const projectIds = [...new Set([input.projectId, ...newTodos.map(todo => todo.projectId)].filter((id): id is string => Boolean(id)))].sort()
    for (const projectId of projectIds) await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
    let meetingInput = input
    const stableParticipantIds = participantUserIds?.length ? [...new Set([userId, ...participantUserIds])] : []
    if (stableParticipantIds.length) {
      const people = await tx.select({ id: users.id, name: users.name }).from(users).where(and(inArray(users.id, stableParticipantIds), eq(users.status, '启用')))
      if (people.length !== stableParticipantIds.length) throw Object.assign(new Error('参会人员中包含不存在或已停用的账号'), { status: 400, code: 'MEETING_PARTICIPANT_INVALID' })
      if (input.projectId) {
        const allowed = await tx.select({ id: projectMembers.userId }).from(projectMembers).where(and(eq(projectMembers.projectId, input.projectId), inArray(projectMembers.userId, stableParticipantIds)))
        if (allowed.length !== stableParticipantIds.length) throw Object.assign(new Error('参会人员必须全部来自当前项目组'), { status: 400, code: 'MEETING_PARTICIPANT_OUTSIDE_PROJECT' })
      }
      const byId = new Map(people.map((person) => [person.id, person.name]))
      meetingInput = { ...input, host: byId.get(userId) ?? userName, hostUserId: userId, attendees: stableParticipantIds.map((id) => byId.get(id)!) }
    }
    const [inserted] = await tx.insert(meetings).values({ ...meetingInput, createdBy: userId }).$returningId()
    await syncMeetingIdentityBindings(inserted.id, meetingInput.host, meetingInput.attendees, tx)
    if (stableParticipantIds.length) {
      const byId = new Map((await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, stableParticipantIds))).map((person) => [person.id, person.name]))
      await tx.delete(meetingParticipants).where(eq(meetingParticipants.meetingId, inserted.id))
      await tx.insert(meetingParticipants).values(stableParticipantIds.map((participantId) => ({ meetingId: inserted.id, userId: participantId, sourceName: byId.get(participantId)! })))
      const recipients = stableParticipantIds.filter((participantId) => participantId !== userId)
      if (recipients.length) await tx.insert(meetingWorkflowNotices).values(recipients.map((recipientId) => ({ meetingId: inserted.id, recipientId, kind: 'invited', version: 1 })))
    }
    if (newTodos?.length) {
      const prepared = []
      for (const todo of newTodos) prepared.push(await prepareFdeTodo(tx, {
        ...todo,
        projectId: todo.projectId ?? input.projectId,
        projectName: todo.projectName ?? input.projectName,
        meetingId: inserted.id,
        createdBy: userId,
      }, userId))
      await tx.insert(todos).values(prepared)
    }
    await tx.insert(auditLogs).values({
      userId,
      userName,
      module: '会议纪要',
      action: '新建并生成纪要',
      target: input.title,
    })
    return inserted.id
  }, { isolationLevel: 'read committed' })

  let [row] = await db.select().from(meetings).where(eq(meetings.id, insertedId)).limit(1)
  if (newTodos?.length) {
    const createdTodos = await db.select().from(todos).where(eq(todos.meetingId, row.id))
    await Promise.all(createdTodos.filter((todo) => !todo.ownerUserId).map((todo) => syncTodoOwnerIdentity(todo.id, todo.owner)))
  }
  ;[row] = await db.select().from(meetings).where(eq(meetings.id, insertedId)).limit(1)
  void ingestMeeting(row)
  return row
}

export async function updateMeeting(id: string, patch: Partial<typeof meetings.$inferInsert>, expectedVersion?: number) {
  const { id: _id, createdBy: _createdBy, hostUserId: _hostUserId, version: _version, workflowKind: _kind, workflowStatus: _status, weeklyReview: _review, confirmedBy: _confirmedBy, confirmedAt: _confirmedAt, ...safePatch } = patch
  const condition = expectedVersion === undefined
    ? eq(meetings.id, id)
    : and(eq(meetings.id, id), eq(meetings.version, expectedVersion))
  const result = await scheduleTransaction(async (tx) => {
    const [existing] = await tx.select().from(meetings).where(eq(meetings.id, id))
    const projectIds = [...new Set([existing?.projectId, safePatch.projectId].filter((value): value is string => Boolean(value)))].sort()
    for (const projectId of projectIds) await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
    const [current] = await tx.select().from(meetings).where(eq(meetings.id, id)).for('update')
    if (current?.projectId !== existing?.projectId) throw businessVersionConflict('会议')
    // Specialized meetings cannot be edited/rebound through legacy PATCH or internal callers.
    if (current && current.workflowKind !== 'legacy' || safePatch.type === '周五例会') throw Object.assign(new Error('请在对应专用会议工作区修改；已确认纪要不可覆盖'), { status: 409, code: 'FDE_MEETING_WORKFLOW_REQUIRED' })
    const [updated] = await tx.update(meetings).set({ ...safePatch, version: sql`${meetings.version} + 1` }).where(condition)
    if (updated.affectedRows === 1) {
      const [row] = await tx.select().from(meetings).where(eq(meetings.id, id))
      await syncMeetingIdentityBindings(row.id, row.host, row.attendees, tx)
    }
    return updated
  }, { isolationLevel: 'read committed' })
  if (expectedVersion !== undefined && result.affectedRows !== 1) throw businessVersionConflict('会议')
  let [row] = await db.select().from(meetings).where(eq(meetings.id, id)).limit(1)
  if (row) void ingestMeeting(row)
  return row
}

export async function addMeetingContribution(input: { meetingId: string; userId: string; content: string; fileIds: string[]; expectedVersion: number }) {
  return scheduleTransaction(async (tx) => {
    const [meeting] = await tx.select().from(meetings).where(eq(meetings.id, input.meetingId)).for('update')
    if (!meeting || meeting.workflowKind !== 'legacy') throw Object.assign(new Error('会议不存在或不支持此操作'), { status: 404, code: 'MEETING_NOT_FOUND' })
    if (meeting.version !== input.expectedVersion) throw businessVersionConflict('会议')
    const [participant] = await tx.select({ id: meetingParticipants.userId }).from(meetingParticipants).where(and(eq(meetingParticipants.meetingId, meeting.id), eq(meetingParticipants.userId, input.userId))).limit(1)
    if (!participant && meeting.createdBy !== input.userId && meeting.hostUserId !== input.userId) throw Object.assign(new Error('只有本场会议的参会人员可以发布想法和文件'), { status: 403, code: 'MEETING_CONTRIBUTION_FORBIDDEN' })
    const [author] = await tx.select({ name: users.name }).from(users).where(and(eq(users.id, input.userId), eq(users.status, '启用'))).limit(1)
    if (!author) throw Object.assign(new Error('当前账号不可用'), { status: 403, code: 'USER_DISABLED_OR_MISSING' })
    const fileIds = [...new Set(input.fileIds)]
    if (fileIds.length && !meeting.projectId) throw Object.assign(new Error('未关联项目的会议不能挂接项目文件'), { status: 400, code: 'MEETING_FILE_PROJECT_REQUIRED' })
    for (const fileId of fileIds) await requireProjectFileAccess(tx, fileId, input.userId, 'view')
    const fileRows = fileIds.length ? await tx.select({ id: projectFiles.id, name: projectFiles.name, version: projectFiles.version, projectId: projectFiles.projectId }).from(projectFiles).where(inArray(projectFiles.id, fileIds)) : []
    if (fileRows.length !== fileIds.length || fileRows.some((file) => file.projectId !== meeting.projectId)) throw Object.assign(new Error('附件必须来自当前会议关联项目'), { status: 400, code: 'MEETING_FILE_INVALID' })
    const workspace = projectMeetingWorkspace(meeting.weeklyReview)
    workspace.contributions.push({ id: randomUUID(), authorId: input.userId, authorName: author.name, content: input.content.trim(), files: fileRows.map(({ id, name, version }) => ({ id, name, version })), createdAt: new Date().toISOString() })
    await tx.update(meetings).set({ weeklyReview: workspace as never, version: meeting.version + 1 }).where(and(eq(meetings.id, meeting.id), eq(meetings.version, meeting.version)))
    const [updated] = await tx.select().from(meetings).where(eq(meetings.id, meeting.id))
    return updated
  }, { isolationLevel: 'read committed' })
}

export async function updateMeetingLifecycle(input: { meetingId: string; userId: string; expectedVersion: number; action: 'start' | 'end' | 'cancel' }) {
  return scheduleTransaction(async (tx) => {
    const [meeting] = await tx.select().from(meetings).where(eq(meetings.id, input.meetingId)).for('update')
    if (!meeting || meeting.workflowKind !== 'legacy') throw Object.assign(new Error('会议不存在或不支持此操作'), { status: 404, code: 'MEETING_NOT_FOUND' })
    if (meeting.createdBy !== input.userId && meeting.hostUserId !== input.userId) throw Object.assign(new Error('只有会议发起人可以修改会议状态'), { status: 403, code: 'MEETING_LIFECYCLE_FORBIDDEN' })
    if (meeting.version !== input.expectedVersion) throw businessVersionConflict('会议')
    if (meeting.workflowStatus === 'cancelled' || meeting.confirmedAt) throw Object.assign(new Error('当前会议状态不可修改'), { status: 409, code: 'MEETING_LIFECYCLE_INVALID' })
    const nextStatus = input.action === 'cancel' ? 'cancelled' : input.action === 'end' ? 'completed' : 'in_progress'
    await tx.update(meetings).set({ workflowStatus: nextStatus, ...(input.action === 'start' ? { startedAt: new Date() } : {}), ...(input.action === 'end' ? { endsAt: new Date() } : {}), version: meeting.version + 1 }).where(and(eq(meetings.id, meeting.id), eq(meetings.version, meeting.version)))
    const [updated] = await tx.select().from(meetings).where(eq(meetings.id, meeting.id))
    return updated
  }, { isolationLevel: 'read committed' })
}

export async function finalizeMeeting(input: { meetingId: string; userId: string; userName: string; expectedVersion: number; summary: string; conclusions: string[]; tasks: Array<{ title: string; ownerUserId: string; dueDate: string }> }) {
  const updated = await scheduleTransaction(async (tx) => {
    const [meeting] = await tx.select().from(meetings).where(eq(meetings.id, input.meetingId)).for('update')
    if (!meeting || meeting.workflowKind !== 'legacy') throw Object.assign(new Error('会议不存在或不支持此操作'), { status: 404, code: 'MEETING_NOT_FOUND' })
    if (meeting.createdBy !== input.userId && meeting.hostUserId !== input.userId) throw Object.assign(new Error('只有会议发起人可以确认最终纪要'), { status: 403, code: 'MEETING_MINUTES_FORBIDDEN' })
    if (meeting.version !== input.expectedVersion) throw businessVersionConflict('会议')
    if (meeting.workflowStatus === 'cancelled' || meeting.confirmedAt) throw Object.assign(new Error('会议已取消或纪要已确认'), { status: 409, code: 'MEETING_MINUTES_IMMUTABLE' })
    if (meeting.workflowStatus === 'scheduled' && (!meeting.endsAt || meeting.endsAt.getTime() > Date.now())) throw Object.assign(new Error('会议结束后才能确认最终纪要'), { status: 409, code: 'MEETING_NOT_ENDED' })
    const assignees = input.tasks.length ? await tx.select({ id: users.id, name: users.name }).from(users).where(and(inArray(users.id, [...new Set(input.tasks.map(task => task.ownerUserId))]), eq(users.status, '启用'))) : []
    const names = new Map(assignees.map(person => [person.id, person.name]))
    if (names.size !== new Set(input.tasks.map(task => task.ownerUserId)).size) throw Object.assign(new Error('任务负责人不存在或已停用'), { status: 400, code: 'MEETING_TASK_OWNER_INVALID' })
    const participantIds = new Set((await tx.select({ id: meetingParticipants.userId }).from(meetingParticipants).where(eq(meetingParticipants.meetingId, meeting.id))).map(row => row.id))
    if (input.tasks.some(task => !participantIds.has(task.ownerUserId))) throw Object.assign(new Error('会议任务只能分配给参会人员'), { status: 400, code: 'MEETING_TASK_OWNER_NOT_PARTICIPANT' })
    for (const task of input.tasks) {
      const prepared = await prepareFdeTodo(tx, { projectId: meeting.projectId, projectName: meeting.projectName, title: task.title, owner: names.get(task.ownerUserId)!, ownerUserId: task.ownerUserId, dueDate: task.dueDate, priority: '中', status: '未开始', type: '会议', meetingId: meeting.id, createdBy: input.userId }, input.userId)
      await tx.insert(todos).values(prepared)
    }
    await tx.update(meetings).set({ aiSummary: input.summary, conclusions: input.conclusions, workflowStatus: 'completed', confirmedBy: input.userId, confirmedAt: new Date(), endsAt: meeting.endsAt && meeting.endsAt < new Date() ? meeting.endsAt : new Date(), version: meeting.version + 1 }).where(and(eq(meetings.id, meeting.id), eq(meetings.version, meeting.version)))
    await tx.insert(auditLogs).values({ userId: input.userId, userName: input.userName, module: '会议纪要', action: '确认最终纪要', target: meeting.title })
    const [updated] = await tx.select().from(meetings).where(eq(meetings.id, meeting.id))
    return updated
  }, { isolationLevel: 'read committed' })
  void ingestMeeting(updated)
  return updated
}

export async function readMeetingNotice(meetingId: string, noticeId: string, userId: string) {
  const [notice] = await db.select({ id: meetingWorkflowNotices.id }).from(meetingWorkflowNotices).where(and(eq(meetingWorkflowNotices.id, noticeId), eq(meetingWorkflowNotices.meetingId, meetingId), eq(meetingWorkflowNotices.recipientId, userId), isNull(meetingWorkflowNotices.closedAt))).limit(1)
  if (!notice) throw Object.assign(new Error('会议提醒不存在或不属于当前账号'), { status: 404, code: 'MEETING_NOTICE_NOT_FOUND' })
  await db.update(meetingWorkflowNotices).set({ readAt: new Date() }).where(and(eq(meetingWorkflowNotices.id, notice.id), isNull(meetingWorkflowNotices.readAt)))
  return { id: notice.id, read: true }
}

export async function listTodos(owner?: string, projectId?: string, actor?: ProjectAccessActor, personal?: { personalOwnerUserId: string; dateFrom?: string; dateTo?: string }) {
  const conds = []
  if (owner) conds.push(eq(todos.owner, owner))
  if (projectId) conds.push(eq(todos.projectId, projectId))
  if (actor) conds.push(todoAccessCondition(actor))
  if (personal) {
    conds.push(isNull(todos.projectId), eq(todos.ownerUserId, personal.personalOwnerUserId), isNull(todos.approvalRequestId), notInArray(todos.type, ['流程', '审批']), notInArray(todos.status, ['已完成', '已关闭', '已取消', '已归档']))
    if (personal.dateFrom) conds.push(gte(todos.dueDate, personal.dateFrom))
    if (personal.dateTo) conds.push(lte(todos.dueDate, personal.dateTo))
  }
  const where = conds.length ? and(...conds) : undefined
  return db.select().from(todos).where(where as never).orderBy(desc(todos.createdAt)).limit(100)
}

export async function listMeetingTodos(meetingId: string, actor?: ProjectAccessActor) {
  const where = actor
    ? and(eq(todos.meetingId, meetingId), todoAccessCondition(actor))
    : eq(todos.meetingId, meetingId)
  return db.select().from(todos).where(where).orderBy(desc(todos.createdAt))
}

export async function getTodo(id: string, actor?: ProjectAccessActor) {
  const where = actor
    ? and(eq(todos.id, id), todoAccessCondition(actor))
    : eq(todos.id, id)
  const [row] = await db.select().from(todos).where(where).limit(1)
  return row
}

export async function createTodo(input: typeof todos.$inferInsert, userId: string) {
  const inserted = await db.transaction(async (tx) => {
    const prepared = await prepareFdeTodo(tx, input, userId)
    const [created] = await tx.insert(todos).values({ ...prepared, createdBy: userId }).$returningId()
    await tx.insert(auditLogs).values({ userId, userName: '（系统）', module: '待办管理', action: '创建待办', target: prepared.title })
    return created
  })
  let [row] = await db.select().from(todos).where(eq(todos.id, inserted.id)).limit(1)
  if (!row.ownerUserId) await syncTodoOwnerIdentity(row.id, row.owner)
  ;[row] = await db.select().from(todos).where(eq(todos.id, inserted.id)).limit(1)
  return row
}

async function assertLegacyTodoMutation(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], id: string, targetProjectId?: string | null) {
  const [row] = await tx.select().from(todos).where(eq(todos.id, id))
  if (row?.approvalRequestId) throw Object.assign(new Error('流程待办只能通过正式审批处理'), { status: 409, code: 'TODO_APPROVAL_REQUIRED' })
  const projectIds = [...new Set([row?.projectId, targetProjectId].filter((value): value is string => Boolean(value)))]
  for (const projectId of projectIds.sort()) {
    await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId))
    if (project?.workflowModel === 'fde-v1') throw Object.assign(new Error('请在 FDE 项目待办中反馈、验收、延期或取消，不能直接修改或删除'), { status: 409, code: 'FDE_TASK_EXECUTION_REQUIRED' })
  }
  return row
}

export async function updateTodo(id: string, patch: Partial<typeof todos.$inferInsert>, expectedVersion?: number) {
  const { id: _id, createdBy: _createdBy, ownerUserId: _ownerUserId, version: _version, executionModel: _executionModel, creationFingerprint: _creationFingerprint, planActionId: _planActionId, progress: _progress, completedAt: _completedAt, closureReason: _closureReason, approvalRequestId: _approvalRequestId, ...safePatch } = patch
  const condition = expectedVersion === undefined
    ? eq(todos.id, id)
    : and(eq(todos.id, id), eq(todos.version, expectedVersion))
  const result = await db.transaction(async (tx) => {
    await assertLegacyTodoMutation(tx, id, patch.projectId)
    const [updated] = await tx.update(todos).set({ ...safePatch, version: sql`${todos.version} + 1` }).where(condition)
    return updated
  })
  if (expectedVersion !== undefined && result.affectedRows !== 1) throw businessVersionConflict('待办')
  let [row] = await db.select().from(todos).where(eq(todos.id, id)).limit(1)
  if (row) {
    await syncTodoOwnerIdentity(row.id, row.owner)
    ;[row] = await db.select().from(todos).where(eq(todos.id, id)).limit(1)
  }
  return row
}

export async function deleteTodo(id: string) {
  return db.transaction(async (tx) => {
    const row = await assertLegacyTodoMutation(tx, id)
    if (row) await tx.delete(todos).where(eq(todos.id, id))
    return row
  })
}

export async function todoCounts(actor?: ProjectAccessActor) {
  const rows = await db.select({
    status: todos.status,
    c: sql<number>`count(*)`,
  }).from(todos).where(actor ? todoAccessCondition(actor) : undefined).groupBy(todos.status)
  const map: Record<string, number> = {}
  for (const r of rows) map[r.status] = r.c
  return map
}
