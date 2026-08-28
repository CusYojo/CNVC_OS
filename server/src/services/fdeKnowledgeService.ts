import { createHash } from 'node:crypto'
import { and, asc, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companyKnowledge as entries, companyKnowledgeGrants as grants, companyKnowledgeComments as comments, companyKnowledgeRatings as ratings, companyKnowledgeEvents as events, knowledgeChunks, projectFiles, projectFileVersions, projects, roles, userRoles, users } from '../db/schema.js'
import { knowledgeAction, knowledgeCommentCommand, knowledgeCommentWithdrawal, knowledgeDefinition, knowledgeDetailQuery, knowledgeQuery, knowledgeRatingCommand, knowledgeSave } from '../contracts/fdeKnowledgeContract.js'
import { companyKnowledgeAccessCondition, companyKnowledgeBusinessActor, projectFileAccessCondition, requireProjectFileAccess, type FileTx } from './projectFileAccessService.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { readProjectFileBuffer } from './projectFileStorageService.js'
import type { z } from 'zod'
import { withKnowledgeCommand } from './fdeKnowledgeCommandService.js'

type Row = typeof entries.$inferSelect
type Definition = z.infer<typeof knowledgeDefinition>
const fail = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }) }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function actor(tx: FileTx, userId: string, creating = false) {
  const [user] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.status, '启用'), creating ? companyKnowledgeBusinessActor(userId) : undefined))
  if (!user) return fail('KNOWLEDGE_ACTOR_FORBIDDEN', '当前账号不可用或仅有系统管理职责', 403)
  return user
}
async function visible(tx: FileTx, id: string, userId: string) {
  const [row] = await tx.select().from(entries).where(and(eq(entries.id, id), companyKnowledgeAccessCondition(userId)))
  if (!row) return fail('KNOWLEDGE_FORBIDDEN', '知识不存在或当前无权访问', 403)
  return row
}
async function entryGrants(tx: FileTx, id: string) { return tx.select().from(grants).where(eq(grants.entryId, id)).orderBy(asc(grants.userId)) }
async function capabilities(tx: FileTx, row: Row, userId: string) {
  const members = await entryGrants(tx, row.id)
  const author = row.authorId === userId, edit = author || members.some(g => g.userId === userId && g.canEdit)
  const [leader] = await tx.select({ id: roles.id }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(eq(userRoles.userId, userId), eq(roles.status, '启用'), eq(roles.fdeCategory, 'institution_leader'))).limit(1)
  const [downloadable] = row.fileId ? await tx.select({ id: projectFiles.id }).from(projectFiles).where(and(eq(projectFiles.id, row.fileId), projectFileAccessCondition(userId, 'download'))) : [{ id: '' }]
  return { edit: edit && row.status !== 'archived', manageAudience: author && row.status !== 'archived', publish: edit && row.status === 'draft', archive: (author || Boolean(leader)) && row.status !== 'archived', interact: row.status === 'published', download: Boolean(downloadable) }
}
async function record(tx: FileTx, row: Row, userId: string, requestId: string, hash: string, action: string, reason: string, extra: object = {}) {
  await tx.insert(events).values({ entryId: row.id, actorId: userId, requestId, requestHash: hash, action, version: row.version, reason, snapshot: { entry: row, grants: await entryGrants(tx, row.id), ...extra } })
  const identity = createMySqlIdentityRepositoryContext(tx), user = await identity.users.findById(userId)
  await identity.audits.append({ userId, userName: user!.name, module: '公司知识', action, target: `${row.id} / v${row.version} / ${requestId}` })
  return { id: row.id, version: row.version }
}
async function syncIndex(tx: FileTx, row: Row) {
  await tx.delete(knowledgeChunks).where(and(eq(knowledgeChunks.sourceType, 'company_knowledge'), eq(knowledgeChunks.sourceId, row.id)))
  if (row.status === 'published') await tx.insert(knowledgeChunks).values({ scope: 'org', refId: row.id, sourceType: 'company_knowledge', sourceId: row.id, sourceName: row.title, chunkIndex: 0, content: `${row.title}\n${row.summary}` })
}
async function lockProjects(tx: FileTx, ids: Array<string | null>) {
  const fileIds = [...new Set(ids.filter(Boolean) as string[])]
  if (!fileIds.length) return
  const files = await tx.select({ projectId: projectFiles.projectId }).from(projectFiles).where(inArray(projectFiles.id, fileIds))
  for (const id of [...new Set(files.map(file => file.projectId))].sort()) await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${id} FOR UPDATE`)
}
async function locked<T>(tx: FileTx, id: string, userId: string, operation: (tx: FileTx, row: Row) => Promise<T>, nextFileId: string | null = null) {
  const [initial] = await tx.select({ fileId: entries.fileId }).from(entries).where(eq(entries.id, id))
  await lockProjects(tx, [initial?.fileId ?? null, nextFileId])
  await tx.execute(sql`SELECT ${entries.id} FROM ${entries} WHERE ${entries.id}=${id} FOR UPDATE`)
  await actor(tx, userId)
  const row = await visible(tx, id, userId)
  if (row.fileId !== initial?.fileId) return fail('VERSION_CONFLICT', '知识附件已变化，请重新核对')
  return operation(tx, row)
}
function version(row: Row, expected: number) { if (row.version !== expected) return fail('VERSION_CONFLICT', '知识或交流记录已变化，请刷新后重新确认') }
async function validateDefinition(tx: FileTx, value: Definition, userId: string) {
  const ids = [...new Set([...value.readerIds, ...value.editorIds])]
  const people = ids.length ? await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.status, '启用'))) : []
  if (people.length !== ids.length) return fail('KNOWLEDGE_MEMBER_UNAVAILABLE', '所选人员已失效，请重新选择')
  if (!value.fileId) return null
  await requireProjectFileAccess(tx, value.fileId, userId, 'download')
  const [revision] = await tx.select().from(projectFileVersions).where(and(eq(projectFileVersions.fileId, value.fileId), eq(projectFileVersions.version, value.fileVersion!)))
  if (!revision) return fail('KNOWLEDGE_FILE_VERSION_INVALID', '文件原始版本不存在')
  const bytes = await readProjectFileBuffer(revision.storagePath)
  if (bytes.length !== revision.byteSize || !revision.sha256 || digestBytes(bytes) !== revision.sha256) return fail('KNOWLEDGE_FILE_INTEGRITY', '关联文件原件校验失败')
  return revision.id
}
const digestBytes = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function setGrants(tx: FileTx, id: string, value: Definition) {
  await tx.delete(grants).where(eq(grants.entryId, id))
  const ids = [...new Set([...value.readerIds, ...value.editorIds])]
  if (ids.length) await tx.insert(grants).values(ids.map(userId => ({ entryId: id, userId, canEdit: value.editorIds.includes(userId) })))
}
async function changed(tx: FileTx, row: Row, patch: Partial<typeof entries.$inferInsert>) {
  await tx.update(entries).set({ ...patch, version: row.version + 1, updatedAt: new Date() }).where(eq(entries.id, row.id))
  return (await tx.select().from(entries).where(eq(entries.id, row.id)))[0]
}

export async function saveCompanyKnowledge(id: string, userId: string, raw: unknown) {
  const input = knowledgeSave.parse(raw), definition = input.definition, hash = digest({ id, userId, action: 'save', input })
  return withKnowledgeCommand({ id, action: 'save', clientRequestId: input.clientRequestId }, userId, hash, async tx => {
    if (input.expectedVersion === 0) {
      await actor(tx, userId, true)
      await lockProjects(tx, [definition.fileId])
      const fileVersionId = await validateDefinition(tx, definition, userId)
      // Client-owned stable entry ID makes uncertain create results recoverable without
      // a second entry. The unique insert serializes concurrent creates of that ID.
      await tx.insert(entries).values({ id, authorId: userId, kind: definition.kind, title: definition.title, summary: definition.summary, link: definition.link, audience: definition.audience, fileId: definition.fileId, fileVersionId }).onDuplicateKeyUpdate({ set: { id: sql`${entries.id}` } })
      const row = await visible(tx, id, userId)
      const [existing] = await tx.select({ id: events.id }).from(events).where(eq(events.entryId, id)).limit(1)
      if (existing || row.authorId !== userId) return fail('KNOWLEDGE_ALREADY_EXISTS', '知识已存在，请打开原条目核对')
      await setGrants(tx, id, definition)
      return record(tx, row, userId, input.clientRequestId, hash, 'create', '保存知识草稿；尚未发布')
    }
    return locked(tx, id, userId, async (tx, row) => {
      const caps = await capabilities(tx, row, userId)
      if (!caps.edit) return fail('KNOWLEDGE_EDIT_FORBIDDEN', '仅当前作者或授权协作编辑人可以修改未归档知识', 403)
      version(row, input.expectedVersion)
      const before = await entryGrants(tx, id)
      if (!caps.manageAudience && (definition.audience !== row.audience || JSON.stringify(before.filter(g => !g.canEdit).map(g => g.userId).sort()) !== JSON.stringify(definition.readerIds.filter(uid => !definition.editorIds.includes(uid))) || JSON.stringify(before.filter(g => g.canEdit).map(g => g.userId).sort()) !== JSON.stringify(definition.editorIds))) return fail('KNOWLEDGE_AUDIENCE_FORBIDDEN', '只有作者可调整知识分享与编辑范围', 403)
      const fileVersionId = await validateDefinition(tx, definition, userId)
      await setGrants(tx, id, definition)
      const next = await changed(tx, row, { kind: definition.kind, title: definition.title, summary: definition.summary, link: definition.link, audience: definition.audience, fileId: definition.fileId, fileVersionId })
      await syncIndex(tx, next)
      return record(tx, next, userId, input.clientRequestId, hash, 'edit', '人工更新知识内容与授权')
    }, definition.fileId)
  })
}

export async function actOnCompanyKnowledge(id: string, userId: string, raw: unknown) {
  const input = knowledgeAction.parse(raw), hash = digest({ id, userId, input })
  return withKnowledgeCommand({ id, action: input.action, clientRequestId: input.clientRequestId }, userId, hash, tx => locked(tx, id, userId, async (tx, row) => {
    const caps = await capabilities(tx, row, userId)
    version(row, input.expectedVersion)
    if (!caps[input.action]) return fail('KNOWLEDGE_ACTION_FORBIDDEN', '当前角色或知识状态不允许此操作', 403)
    if (input.action === 'publish' && row.fileId) {
      await requireProjectFileAccess(tx, row.fileId, userId, 'download')
      const [revision] = await tx.select().from(projectFileVersions).where(and(eq(projectFileVersions.id, row.fileVersionId!), eq(projectFileVersions.fileId, row.fileId)))
      if (!revision) return fail('KNOWLEDGE_FILE_VERSION_INVALID', '原始版本不存在')
      const bytes = await readProjectFileBuffer(revision.storagePath)
      if (!revision.sha256 || bytes.length !== revision.byteSize || digestBytes(bytes) !== revision.sha256) return fail('KNOWLEDGE_FILE_INTEGRITY', '关联原件已变化，不能发布')
    }
    const next = await changed(tx, row, input.action === 'publish' ? { status: 'published', publishedAt: new Date() } : { status: 'archived', archivedAt: new Date() })
    await syncIndex(tx, next)
    return record(tx, next, userId, input.clientRequestId, hash, input.action, input.reason)
  }))
}
export async function commentCompanyKnowledge(id: string, userId: string, raw: unknown) {
  const input = knowledgeCommentCommand.parse(raw), hash = digest({ id, userId, action: 'comment', input })
  return withKnowledgeCommand({ id, action: 'comment', clientRequestId: input.clientRequestId }, userId, hash, tx => locked(tx, id, userId, async (tx, row) => {
    version(row, input.expectedVersion)
    if (row.status !== 'published') return fail('KNOWLEDGE_READONLY', '仅已发布知识可以交流')
    const [comment] = await tx.insert(comments).values({ entryId: id, authorId: userId, content: input.content }).$returningId()
    return record(tx, await changed(tx, row, {}), userId, input.clientRequestId, hash, 'comment', '发布批注', { commentId: comment.id, content: input.content })
  }))
}
export async function withdrawCompanyKnowledgeComment(id: string, commentId: string, userId: string, raw: unknown) {
  const input = knowledgeCommentWithdrawal.parse(raw), hash = digest({ id, commentId, userId, input })
  return withKnowledgeCommand({ id, action: 'withdraw-comment', commentId, clientRequestId: input.clientRequestId }, userId, hash, tx => locked(tx, id, userId, async (tx, row) => {
    const [comment] = await tx.select().from(comments).where(and(eq(comments.id, commentId), eq(comments.entryId, id)))
    if (!comment || comment.authorId !== userId) return fail('KNOWLEDGE_COMMENT_FORBIDDEN', '仅批注作者可撤回自己的批注', 403)
    version(row, input.expectedVersion)
    if (row.status !== 'published' || comment.withdrawnAt) return fail('KNOWLEDGE_READONLY', '当前状态不能撤回批注')
    await tx.update(comments).set({ withdrawnAt: new Date(), withdrawalReason: input.reason }).where(eq(comments.id, commentId))
    return record(tx, await changed(tx, row, {}), userId, input.clientRequestId, hash, 'withdraw-comment', input.reason, { commentId })
  }))
}
export async function rateCompanyKnowledge(id: string, userId: string, raw: unknown) {
  const input = knowledgeRatingCommand.parse(raw), hash = digest({ id, userId, action: 'rate', input })
  return withKnowledgeCommand({ id, action: 'rate', clientRequestId: input.clientRequestId }, userId, hash, tx => locked(tx, id, userId, async (tx, row) => {
    version(row, input.expectedVersion)
    if (row.status !== 'published') return fail('KNOWLEDGE_READONLY', '仅已发布知识可以评价')
    await tx.insert(ratings).values({ entryId: id, userId, score: input.score }).onDuplicateKeyUpdate({ set: { score: input.score, updatedAt: new Date() } })
    return record(tx, await changed(tx, row, {}), userId, input.clientRequestId, hash, input.score === null ? 'withdraw-rating' : 'rate', '按本人稳定身份保存评价', { score: input.score })
  }))
}

async function present(tx: FileTx, row: Row, userId: string) {
  const [author] = await tx.select({ name: users.name }).from(users).where(eq(users.id, row.authorId))
  const [rating] = await tx.select({ value: sql<number | null>`AVG(${ratings.score})`.mapWith(v => v === null ? null : Number(v)), total: sql<number>`COUNT(${ratings.score})`.mapWith(Number) }).from(ratings).where(eq(ratings.entryId, row.id))
  const [commentTotal] = await tx.select({ value: count() }).from(comments).where(and(eq(comments.entryId, row.id), isNull(comments.withdrawnAt)))
  const [revision] = row.fileVersionId ? await tx.select({ version: projectFileVersions.version }).from(projectFileVersions).where(eq(projectFileVersions.id, row.fileVersionId)) : []
  const [file] = row.fileId ? await tx.select({ name: projectFiles.name }).from(projectFiles).where(eq(projectFiles.id, row.fileId)) : []
  return { id: row.id, authorId: row.authorId, authorName: author.name, kind: row.kind, title: row.title, summary: row.summary, link: row.link, audience: row.audience, status: row.status, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt, publishedAt: row.publishedAt, archivedAt: row.archivedAt, rating: rating.value, ratings: rating.total, commentCount: commentTotal.value, file: row.fileId ? { id: row.fileId, name: file.name, version: revision.version } : null, capabilities: await capabilities(tx, row, userId) }
}
export async function listCompanyKnowledge(userId: string, raw: unknown = {}) {
  const input = knowledgeQuery.parse(raw)
  return db.transaction(async tx => {
    await actor(tx, userId)
    const where = and(companyKnowledgeAccessCondition(userId), eq(entries.status, input.view), input.kind ? eq(entries.kind, input.kind) : undefined,
      input.keyword ? or(sql`LOCATE(${input.keyword},${entries.title})>0`, sql`LOCATE(${input.keyword},${entries.summary})>0`, inArray(entries.id, tx.select({ id: comments.entryId }).from(comments).where(and(isNull(comments.withdrawnAt), sql`LOCATE(${input.keyword},${comments.content})>0`)))) : undefined)
    const [total] = await tx.select({ value: count() }).from(entries).where(where)
    const rows = await tx.select().from(entries).where(where).orderBy(desc(entries.updatedAt), desc(entries.id)).limit(input.pageSize).offset((input.page - 1) * input.pageSize)
    const [creator] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, userId), companyKnowledgeBusinessActor(userId)))
    const list = []; for (const row of rows) list.push(await present(tx, row, userId))
    return { list, total: total.value, ...input, canCreate: Boolean(creator) }
  }, { isolationLevel: 'read committed' })
}
export async function getCompanyKnowledge(id: string, userId: string, raw: unknown = {}) {
  const input = knowledgeDetailQuery.parse(raw)
  return db.transaction(async tx => {
    await actor(tx, userId); const row = await visible(tx, id, userId), entry = await present(tx, row, userId), members = await entryGrants(tx, id)
    const [total] = await tx.select({ value: count() }).from(comments).where(eq(comments.entryId, id))
    const discussion = await tx.select({ comment: comments, name: users.name }).from(comments).innerJoin(users, eq(users.id, comments.authorId)).where(eq(comments.entryId, id)).orderBy(asc(comments.createdAt), asc(comments.id)).limit(input.pageSize).offset((input.page - 1) * input.pageSize)
    const [historyTotal] = await tx.select({ value: count() }).from(events).where(eq(events.entryId, id))
    // Snapshots are audit-only. Never disclose old text or old audiences via history.
    const history = await tx.select({ id: events.id, action: events.action, version: events.version, actorName: users.name, reason: events.reason, createdAt: events.createdAt }).from(events).innerJoin(users, eq(users.id, events.actorId)).where(eq(events.entryId, id)).orderBy(desc(events.version)).limit(input.pageSize).offset((input.historyPage - 1) * input.pageSize)
    const [ownRating] = await tx.select({ score: ratings.score }).from(ratings).where(and(eq(ratings.entryId, id), eq(ratings.userId, userId)))
    return { entry, readerIds: entry.capabilities.edit ? members.filter(g => !g.canEdit).map(g => g.userId) : [], editorIds: entry.capabilities.edit ? members.filter(g => g.canEdit).map(g => g.userId) : [], ownRating: ownRating?.score ?? null,
      comments: discussion.map(({ comment: c, name }) => ({ id: c.id, authorName: name, content: c.withdrawnAt ? '' : c.content, createdAt: c.createdAt, withdrawnAt: c.withdrawnAt, canWithdraw: entry.capabilities.interact && c.authorId === userId && !c.withdrawnAt })), commentTotal: total.value, history, historyTotal: historyTotal.value, ...input }
  }, { isolationLevel: 'read committed' })
}
export async function companyKnowledgeOptions(userId: string) {
  return db.transaction(async tx => {
    await actor(tx, userId)
    const people = await tx.select({ id: users.id, name: users.name, department: users.department }).from(users).where(eq(users.status, '启用')).orderBy(asc(users.name), asc(users.id))
    const files = await tx.select({ id: projectFiles.id, name: projectFiles.name, version: projectFiles.version }).from(projectFiles).where(projectFileAccessCondition(userId, 'download')).orderBy(desc(projectFiles.uploadedAt))
    return { people, files }
  })
}
export async function companyKnowledgeOriginal(id: string, userId: string, download = false) {
  return db.transaction(tx => locked(tx, id, userId, async (tx, row) => {
    if (!row.fileId || !row.fileVersionId) return fail('KNOWLEDGE_NO_FILE', '知识未关联原始附件', 404)
    const file = await requireProjectFileAccess(tx, row.fileId, userId, download ? 'download' : 'view')
    const [revision] = await tx.select().from(projectFileVersions).where(and(eq(projectFileVersions.id, row.fileVersionId), eq(projectFileVersions.fileId, file.id)))
    if (!revision) return fail('KNOWLEDGE_FILE_VERSION_INVALID', '原始版本不存在')
    const bytes = await readProjectFileBuffer(revision.storagePath)
    if (!revision.sha256 || bytes.length !== revision.byteSize || digestBytes(bytes) !== revision.sha256) return fail('KNOWLEDGE_FILE_INTEGRITY', '原件校验失败')
    return { bytes, name: file.name, version: revision.version, sha256: revision.sha256 }
  }), { isolationLevel: 'read committed' })
}
export async function companyKnowledgeSummary(id: string, userId: string) {
  return db.transaction(tx => locked(tx, id, userId, async (tx, row) => {
    if (row.fileId) await requireProjectFileAccess(tx, row.fileId, userId, 'download')
    return { name: `${row.title}.txt`, text: `${row.title}\n${row.kind} · v${row.version}\n\n${row.summary}\n\n${row.link}` }
  }), { isolationLevel: 'read committed' })
}
