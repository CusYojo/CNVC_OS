import { createHash, randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { meetings, oaApprovalRequests, projectDutyAssignments, projectRecordComments, projectRecordEvents, projectRecords, projects, roles, userRoles, users } from '../db/schema.js'
import { projectRecordAction, projectRecordComment, projectRecordCommentWithdrawal, projectRecordCreate, projectRecordDetailQuery, projectRecordQuery } from '../contracts/fdeProjectRecordContract.js'
import { projectAccessCondition } from './projectAccessService.js'
import { createMySqlIdentityRepositoryContext, identityRepositories } from '../repositories/index.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type RecordRow = typeof projectRecords.$inferSelect
const fail = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }) }
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex')

async function context(tx: Tx, projectId: string, userId: string) {
  const [actor] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.status, '启用')))
  if (!actor) return fail('RECORD_ACTOR_UNAVAILABLE', '当前账号不可用', 403)
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.workflowModel !== 'fde-v1' || project.lifecycle === 'deleted') return fail('RECORD_PROJECT_NOT_FOUND', '项目不存在或不适用此工作区', 404)
  const [visible] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), projectAccessCondition({ uid: actor.id, name: actor.name, role: actor.role })))
  const categories = await tx.select({ category: roles.fdeCategory }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(eq(userRoles.userId, userId), eq(roles.status, '启用')))
  const [secretary] = await tx.select({ id: projectDutyAssignments.id }).from(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, projectId), eq(projectDutyAssignments.userId, userId), eq(projectDutyAssignments.duty, 'secretary')))
  const owner = project.ownerUserId === userId
  const businessRole = categories.some(row => row.category && !['system_admin', 'coordinator'].includes(row.category))
  if (!visible || !(businessRole || owner || secretary)) return fail('RECORD_FORBIDDEN', '无权查看项目业务记录；系统管理或时间协调权限不扩大内容范围', 403)
  return { actor, project, canCreate: project.lifecycle === 'active', manager: owner || Boolean(secretary) || categories.some(row => row.category === 'institution_leader') }
}
type Context = Awaited<ReturnType<typeof context>>
async function run<T>(projectId: string, userId: string, write: boolean, operation: (tx: Tx, scope: Context) => Promise<T>) {
  try {
    return await db.transaction(async tx => {
      if (write) await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
      return operation(tx, await context(tx, projectId, userId))
    })
  } catch (error) {
    if ((error as { status?: number }).status === 403) {
      const identity = identityRepositories, actor = await identity.users.findById(userId)
      if (actor?.status === '启用') await identity.audits.append({ userId, userName: actor.name, module: '项目记录', action: '拒绝访问', target: projectId })
    }
    throw error
  }
}
async function find(tx: Tx, projectId: string, id: string) {
  const [row] = await tx.select().from(projectRecords).where(and(eq(projectRecords.id, id), eq(projectRecords.projectId, projectId)))
  if (!row) return fail('RECORD_NOT_FOUND', '项目记录不存在', 404)
  return row
}
async function replay(tx: Tx, requestId: string, hash: string) {
  const [event] = await tx.select().from(projectRecordEvents).where(eq(projectRecordEvents.requestId, requestId))
  if (event && event.requestHash !== hash) return fail('RECORD_REQUEST_REUSED', '请求编号已用于其他内容，请刷新操作')
  return event ? { id: event.recordId } : null
}
async function event(tx: Tx, row: RecordRow, actorId: string, requestId: string, hash: string, action: string, reason: string, comment?: typeof projectRecordComments.$inferSelect) {
  await tx.insert(projectRecordEvents).values({ recordId: row.id, actorId, requestId, requestHash: hash, action, reason, version: row.version, snapshot: { record: row, ...(comment ? { comment } : {}) } })
  const identity = createMySqlIdentityRepositoryContext(tx), actor = await identity.users.findById(actorId)
  await identity.audits.append({ userId: actorId, userName: actor?.name ?? '已停用人员', module: '项目记录', action, target: `${row.projectId} / ${row.id} / v${row.version} / ${requestId}` })
}
function version(row: RecordRow, expected: number) { if (row.version !== expected) return fail('VERSION_CONFLICT', '记录或评论已变化，请刷新后重新确认') }
function present(row: RecordRow, scope: Context, authorName: string, commentCount = 0) {
  const withdrawn = row.status === 'withdrawn', manage = scope.manager || row.authorId === scope.actor.id
  return { id: row.id, projectId: row.projectId, authorId: row.authorId, authorName, kind: row.kind, title: withdrawn ? '已撤回的项目记录' : row.title, content: withdrawn ? '' : row.content,
    status: row.status, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt, closedAt: row.closedAt, closedBy: row.closedBy, closureReason: row.closureReason,
    commentCount: withdrawn ? 0 : commentCount,
    source: withdrawn ? null : row.sourceMeetingId ? { kind: 'meeting', id: row.sourceMeetingId, version: row.sourceVersion } : row.sourceApprovalId ? { kind: 'approval', id: row.sourceApprovalId, version: row.sourceVersion } : null,
    capabilities: { comment: scope.canCreate && row.status === 'published', withdraw: manage && !withdrawn, archive: manage && row.status === 'published' } }
}

export async function createProjectRecord(projectId: string, userId: string, raw: unknown) {
  const input = projectRecordCreate.parse(raw), hash = digest({ projectId, userId, action: 'publish', input })
  return run(projectId, userId, true, async (tx, scope) => {
    const prior = await replay(tx, input.clientRequestId, hash); if (prior) return prior
    if (!scope.canCreate) return fail('RECORD_PROJECT_CLOSED', '已关闭或归档项目不能新增记录')
    const id = randomUUID()
    await tx.insert(projectRecords).values({ id, projectId, authorId: userId, kind: input.kind, title: input.title, content: input.content })
    await event(tx, await find(tx, projectId, id), userId, input.clientRequestId, hash, 'publish', '人工发布项目记录')
    return { id }
  })
}
export async function commentProjectRecord(projectId: string, id: string, userId: string, raw: unknown) {
  const input = projectRecordComment.parse(raw), hash = digest({ projectId, id, userId, action: 'comment', input })
  return run(projectId, userId, true, async (tx, scope) => {
    const row = await find(tx, projectId, id), prior = await replay(tx, input.clientRequestId, hash); if (prior) return prior
    version(row, input.expectedVersion)
    if (!scope.canCreate || row.status !== 'published') return fail('RECORD_READONLY', '记录或项目已关闭，不能继续评论')
    const commentId = randomUUID()
    await tx.insert(projectRecordComments).values({ id: commentId, recordId: id, authorId: userId, content: input.content })
    await tx.update(projectRecords).set({ version: row.version + 1, updatedAt: new Date() }).where(eq(projectRecords.id, id))
    const [comment] = await tx.select().from(projectRecordComments).where(eq(projectRecordComments.id, commentId))
    await event(tx, await find(tx, projectId, id), userId, input.clientRequestId, hash, 'comment', '补充项目讨论', comment)
    return { id }
  })
}
export async function actOnProjectRecord(projectId: string, id: string, userId: string, raw: unknown) {
  const input = projectRecordAction.parse(raw), hash = digest({ projectId, id, userId, input })
  return run(projectId, userId, true, async (tx, scope) => {
    const row = await find(tx, projectId, id)
    if (!scope.manager && row.authorId !== userId) return fail('RECORD_MANAGE_FORBIDDEN', '仅作者、项目负责人、推进秘书或有权领导可处理记录', 403)
    const prior = await replay(tx, input.clientRequestId, hash); if (prior) return prior
    version(row, input.expectedVersion)
    if (row.status === 'withdrawn' || input.action === 'archive' && row.status !== 'published') return fail('RECORD_STATE_INVALID', '记录当前状态不允许此操作')
    await tx.update(projectRecords).set({ status: input.action === 'withdraw' ? 'withdrawn' : 'archived', closedBy: userId, closedAt: new Date(), closureReason: input.reason, version: row.version + 1, updatedAt: new Date() }).where(eq(projectRecords.id, id))
    await event(tx, await find(tx, projectId, id), userId, input.clientRequestId, hash, input.action, input.reason)
    return { id }
  })
}
export async function withdrawProjectRecordComment(projectId: string, id: string, commentId: string, userId: string, raw: unknown) {
  const input = projectRecordCommentWithdrawal.parse(raw), hash = digest({ projectId, id, commentId, userId, input })
  return run(projectId, userId, true, async (tx, scope) => {
    const row = await find(tx, projectId, id)
    const [comment] = await tx.select().from(projectRecordComments).where(and(eq(projectRecordComments.id, commentId), eq(projectRecordComments.recordId, id)))
    if (!comment) return fail('RECORD_COMMENT_NOT_FOUND', '评论不存在', 404)
    if (!scope.manager && comment.authorId !== userId) return fail('RECORD_COMMENT_FORBIDDEN', '仅评论作者或有权项目管理人可撤回', 403)
    const prior = await replay(tx, input.clientRequestId, hash); if (prior) return prior
    version(row, input.expectedVersion)
    if (row.status === 'withdrawn' || comment.withdrawnAt) return fail('RECORD_STATE_INVALID', '记录或评论已撤回')
    await tx.update(projectRecordComments).set({ withdrawnBy: userId, withdrawnAt: new Date(), withdrawalReason: input.reason }).where(eq(projectRecordComments.id, commentId))
    await tx.update(projectRecords).set({ version: row.version + 1, updatedAt: new Date() }).where(eq(projectRecords.id, id))
    const [updated] = await tx.select().from(projectRecordComments).where(eq(projectRecordComments.id, commentId))
    await event(tx, await find(tx, projectId, id), userId, input.clientRequestId, hash, 'withdraw-comment', input.reason, updated)
    return { id }
  })
}

export async function listProjectRecords(projectId: string, userId: string, raw: unknown = {}) {
  const input = projectRecordQuery.parse(raw)
  return run(projectId, userId, false, async (tx, scope) => {
    const search = !input.keyword ? undefined : input.view === 'withdrawn' ? eq(projectRecords.id, input.keyword) : or(
      sql`LOCATE(${input.keyword}, ${projectRecords.title}) > 0`, sql`LOCATE(${input.keyword}, ${projectRecords.content}) > 0`,
      inArray(projectRecords.id, tx.select({ id: projectRecordComments.recordId }).from(projectRecordComments).where(and(isNull(projectRecordComments.withdrawnAt), sql`LOCATE(${input.keyword}, ${projectRecordComments.content}) > 0`))),
    )
    const where = and(eq(projectRecords.projectId, projectId), eq(projectRecords.status, input.view), search)
    const [total] = await tx.select({ value: count() }).from(projectRecords).where(where)
    const rows = await tx.select({ row: projectRecords, authorName: users.name }).from(projectRecords).innerJoin(users, eq(users.id, projectRecords.authorId)).where(where).orderBy(desc(projectRecords.updatedAt), desc(projectRecords.id)).limit(input.pageSize).offset((input.page - 1) * input.pageSize)
    const counts = rows.length && input.view !== 'withdrawn' ? await tx.select({ id: projectRecordComments.recordId, value: count() }).from(projectRecordComments).where(and(inArray(projectRecordComments.recordId, rows.map(r => r.row.id)), isNull(projectRecordComments.withdrawnAt))).groupBy(projectRecordComments.recordId) : []
    return { list: rows.map(({ row, authorName }) => present(row, scope, authorName, counts.find(item => item.id === row.id)?.value ?? 0)), total: total.value, page: input.page, pageSize: input.pageSize, canCreate: scope.canCreate }
  })
}
export async function getProjectRecord(projectId: string, id: string, userId: string, raw: unknown = {}) {
  const input = projectRecordDetailQuery.parse(raw)
  return run(projectId, userId, false, async (tx, scope) => {
    const row = await find(tx, projectId, id), [author] = await tx.select({ name: users.name }).from(users).where(eq(users.id, row.authorId))
    const [commentTotal] = await tx.select({ value: count(), active: sql<number>`COUNT(CASE WHEN ${projectRecordComments.withdrawnAt} IS NULL THEN 1 END)`.mapWith(Number) }).from(projectRecordComments).where(eq(projectRecordComments.recordId, id))
    const comments = row.status === 'withdrawn' ? [] : await tx.select({ comment: projectRecordComments, authorName: users.name }).from(projectRecordComments).innerJoin(users, eq(users.id, projectRecordComments.authorId)).where(eq(projectRecordComments.recordId, id)).orderBy(asc(projectRecordComments.createdAt), asc(projectRecordComments.id)).limit(input.pageSize).offset((input.page - 1) * input.pageSize)
    const [historyTotal] = await tx.select({ value: count() }).from(projectRecordEvents).where(eq(projectRecordEvents.recordId, id))
    // Deliberately do not expose immutable snapshots: withdrawn text cannot leak via history.
    const events = await tx.select({ id: projectRecordEvents.id, action: projectRecordEvents.action, actorId: projectRecordEvents.actorId, actorName: users.name, version: projectRecordEvents.version, reason: projectRecordEvents.reason, createdAt: projectRecordEvents.createdAt }).from(projectRecordEvents).innerJoin(users, eq(users.id, projectRecordEvents.actorId)).where(eq(projectRecordEvents.recordId, id)).orderBy(desc(projectRecordEvents.version)).limit(input.pageSize).offset((input.historyPage - 1) * input.pageSize)
    return { record: present(row, scope, author.name, commentTotal.active), comments: comments.map(({ comment, authorName }) => ({ id: comment.id, authorId: comment.authorId, authorName, content: comment.withdrawnAt ? '' : comment.content, createdAt: comment.createdAt, withdrawnAt: comment.withdrawnAt, withdrawalReason: comment.withdrawalReason, canWithdraw: !comment.withdrawnAt && (scope.manager || comment.authorId === userId) })), commentTotal: row.status === 'withdrawn' ? 0 : commentTotal.value, events, historyTotal: historyTotal.value, ...input }
  })
}

async function sourceRecord(tx: Tx, values: typeof projectRecords.$inferInsert, actorId: string) {
  const [prior] = await tx.select({ id: projectRecords.id }).from(projectRecords).where(eq(projectRecords.sourceKey, values.sourceKey!))
  if (prior) return prior.id // Withdrawn/archived projections must not be resurrected by replay.
  const id = randomUUID(), requestId = randomUUID()
  await tx.insert(projectRecords).values({ ...values, id, authorId: actorId })
  await event(tx, await find(tx, values.projectId, id), actorId, requestId, digest({ source: values.sourceKey }), 'source-publish', '由人工确认的正式来源生成关联记录')
  return id
}
// Called inside the source's existing transaction, after its project lock and final decision.
export async function appendFridayMeetingRecord(tx: Tx, meetingId: string, actorId: string) {
  const [meeting] = await tx.select().from(meetings).where(eq(meetings.id, meetingId))
  if (!meeting?.projectId || meeting.workflowKind !== 'friday' || meeting.workflowStatus !== 'completed' || !meeting.weeklyReview || !meeting.confirmedAt) return fail('RECORD_SOURCE_INVALID', '仅人工确认的正式例会纪要可生成项目记录')
  const review = meeting.weeklyReview
  return sourceRecord(tx, { projectId: meeting.projectId, authorId: actorId, kind: '会议结论', title: `${meeting.title} · 例会纪要`, content: `成果：${review.result}\n阻塞：${review.blocked}\n决定：${review.decision}\n下周目标：${review.nextGoal}`, sourceKey: `meeting:${meeting.id}:v${meeting.version}`, sourceMeetingId: meeting.id, sourceVersion: meeting.version }, actorId)
}
export async function appendPlanReviewRecord(tx: Tx, approvalId: string, actorId: string, action: string, reason: string) {
  if (!['approve', 'return', 'reject'].includes(action)) return
  const [request] = await tx.select().from(oaApprovalRequests).where(eq(oaApprovalRequests.id, approvalId))
  if (!request?.projectId || request.type !== '尽调计划审核') return
  const [project] = await tx.select().from(projects).where(eq(projects.id, request.projectId))
  if (project?.workflowModel !== 'fde-v1') return
  return sourceRecord(tx, { projectId: request.projectId, authorId: actorId, kind: action === 'approve' ? '审批结论' : '补充要求', title: action === 'approve' ? '尽调计划审核意见' : '尽调计划审核补充意见', content: `审批编号：${request.requestNo}\n本次处理：${action === 'approve' ? '同意' : action === 'return' ? '退回' : '拒绝'}\n申请状态：${request.status}\n意见：${reason}`, sourceKey: `approval:${request.id}:v${request.lockVersion}`, sourceApprovalId: request.id, sourceVersion: request.lockVersion }, actorId)
}
