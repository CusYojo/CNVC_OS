import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { meetingParticipants, meetings, todos, auditLogs, projects } from '../db/schema.js'
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
  participants: string[]
  type: string
  status: '成功'
  summary: string
  conclusions: string[]
  rawText: string
  todoCount: number
  version: number
}

function publicMeeting(row: typeof meetings.$inferSelect, todoCount: number): PublicMeeting {
  return {
    id: row.id,
    projectId: row.projectId ?? '',
    projectName: row.projectName,
    title: row.title,
    meetingTime: row.startedAt.toISOString(),
    participants: Array.isArray(row.attendees) ? row.attendees : [],
    type: row.type,
    status: '成功',
    summary: row.aiSummary ?? '',
    conclusions: Array.isArray(row.conclusions) ? row.conclusions : [],
    rawText: row.rawTranscript ?? '',
    todoCount,
    version: row.version,
  }
}

export async function presentMeetings(rows: (typeof meetings.$inferSelect)[]) {
  if (!rows.length) return []
  const counts = await db.select({
    meetingId: todos.meetingId,
    value: sql<number>`count(*)`,
  }).from(todos).where(inArray(todos.meetingId, rows.map((row) => row.id))).groupBy(todos.meetingId)
  const byMeeting = new Map(counts.map((row) => [row.meetingId, Number(row.value)]))
  return rows.map((row) => publicMeeting(row, byMeeting.get(row.id) ?? 0))
}

export async function presentMeeting(row: typeof meetings.$inferSelect) {
  const [presented] = await presentMeetings([row])
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
) {
  if (input.workflowKind === 'friday' || input.type === '周五例会') throw Object.assign(new Error('请通过周五例会工作区创建、排期和确认纪要'), { status: 409, code: 'FDE_MEETING_WORKFLOW_REQUIRED' })
  const insertedId = await scheduleTransaction(async (tx) => {
    const projectIds = [...new Set([input.projectId, ...newTodos.map(todo => todo.projectId)].filter((id): id is string => Boolean(id)))].sort()
    for (const projectId of projectIds) await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
    const [inserted] = await tx.insert(meetings).values({ ...input, createdBy: userId }).$returningId()
    await syncMeetingIdentityBindings(inserted.id, input.host, input.attendees, tx)
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
  const { id: _id, createdBy: _createdBy, hostUserId: _hostUserId, version: _version, workflowKind: _kind, workflowStatus: _status, weeklyReview: _review, confirmedBy: _confirmedBy, confirmedAt: _confirmedAt, endsAt: _endsAt, ...safePatch } = patch
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

export async function listTodos(owner?: string, projectId?: string, actor?: ProjectAccessActor) {
  const conds = []
  if (owner) conds.push(eq(todos.owner, owner))
  if (projectId) conds.push(eq(todos.projectId, projectId))
  if (actor) conds.push(todoAccessCondition(actor))
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
