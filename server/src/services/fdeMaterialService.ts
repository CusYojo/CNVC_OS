import { createHash, randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projectDutyAssignments, projectFileEvents, projectFileGrants, projectFiles, projectFileVersions, projectMaterialEvents, projectMaterialNotices, projectMaterialRecipients, projectMaterialRequestClosures, projectMaterialSubmissions, projects, roles, userRoles, users } from '../db/schema.js'
import { aggregateMaterialStatus, materialCreateCommand, materialDecisionCommand, materialHistoryQuery, materialListQuery, materialReadCommand, materialResolveCommand, materialStatusLabels, materialWithdrawCommand, type MaterialStatus } from '../contracts/fdeMaterialContract.js'
import { createMySqlIdentityRepositoryContext, identityRepositories } from '../repositories/index.js'
import { projectAccessCondition } from './projectAccessService.js'
import { fileError, projectFileAccessCondition, requireProjectFileAccess, type FileTx } from './projectFileAccessService.js'
import { readProjectFileBuffer } from './projectFileStorageService.js'

type Submission = typeof projectMaterialSubmissions.$inferSelect
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (code: string, message: string, status = 409): never => { throw fileError(code, message, status) }
const terminal = (status: string) => ['approved', 'returned', 'withdrawn'].includes(status)

async function context(tx: FileTx, projectId: string, userId: string) {
  const [actor] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.status, '启用')))
  if (!actor) return fail('MATERIAL_FORBIDDEN', '当前账号不可用', 403)
  const [project] = await tx.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.workflowModel, 'fde-v1'), projectAccessCondition({ uid: userId, role: actor.role, name: actor.name })))
  if (!project) return fail('MATERIAL_FORBIDDEN', '无权访问该项目的材料送审', 403)
  const bindings = await tx.select({ code: roles.code, category: roles.fdeCategory }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(eq(userRoles.userId, userId), eq(roles.status, '启用')))
  const duties = await tx.select().from(projectDutyAssignments).where(eq(projectDutyAssignments.projectId, projectId))
  const owner = project.ownerUserId === userId, secretary = duties.some(row => row.userId === userId && row.duty === 'secretary')
  const leader = bindings.some(row => row.category === 'institution_leader')
  if (!owner && !secretary && !bindings.some(row => row.category && !['system_admin', 'coordinator'].includes(row.category))) return fail('MATERIAL_FORBIDDEN', '系统管理或时间协调权限不扩大材料权限', 403)
  return { actor, project, duties, leader, manager: owner || secretary || leader, canSubmit: project.lifecycle === 'active' && !leader }
}
type Context = Awaited<ReturnType<typeof context>>
async function run<T>(projectId: string, userId: string, write: boolean, operation: (tx: FileTx, scope: Context) => Promise<T>) {
  try {
    return await db.transaction(async tx => {
      // Same project-first order as file ACL, lifecycle, governance, tasks and gates.
      if (write) await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
      return operation(tx, await context(tx, projectId, userId))
    })
  } catch (error) {
    if ((error as { status?: number }).status === 403) {
      const actor = await identityRepositories.users.findById(userId)
      if (actor?.status === '启用') await identityRepositories.audits.append({ userId, userName: actor.name, module: '材料送审', action: '拒绝访问', target: projectId })
    }
    throw error
  }
}
async function recipients(tx: FileTx, scope: Context) {
  const { project, duties, actor } = scope
  const selected = new Set([project.ownerUserId, ...duties.filter(row => row.duty === 'concerned_leader').map(row => row.userId)].filter(Boolean) as string[])
  const seniorStages = ['尽调', '内核', '投决', '打款']
  if (seniorStages.includes(project.stage)) {
    for (const [duty, code] of [['chairman', 'FDE_CHAIRMAN'], ['president', 'FDE_PRESIDENT']] as const) {
      const assigned = duties.filter(row => row.duty === duty)
      const candidates = await tx.select({ id: users.id }).from(users).innerJoin(userRoles, eq(userRoles.userId, users.id)).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(eq(users.status, '启用'), eq(roles.status, '启用'), eq(roles.code, code), assigned.length ? inArray(users.id, assigned.map(row => row.userId)) : undefined))
      candidates.forEach(row => selected.add(row.id))
    }
  }
  selected.delete(actor.id)
  if (!selected.size) return []
  const people = await tx.select({ id: users.id, name: users.name }).from(users).where(and(inArray(users.id, [...selected]), eq(users.status, '启用'))).orderBy(asc(users.name), asc(users.id))
  const allowed = []
  for (const person of people) {
    try {
      const candidate = await context(tx, project.id, person.id)
      // A stale concerned-leader assignment cannot promote a demoted member.
      if (person.id === project.ownerUserId || candidate.leader && candidate.duties.some(row => row.userId === person.id && ['concerned_leader', 'chairman', 'president'].includes(row.duty)) || seniorStages.includes(project.stage) && candidate.leader) allowed.push(person)
    } catch (error) { if ((error as { status?: number }).status !== 403) throw error }
  }
  return allowed
}
async function find(tx: FileTx, projectId: string, id: string) {
  const [row] = await tx.select().from(projectMaterialSubmissions).where(and(eq(projectMaterialSubmissions.id, id), eq(projectMaterialSubmissions.projectId, projectId)))
  if (!row) return fail('MATERIAL_NOT_FOUND', '材料送审不存在', 404)
  return row
}
async function states(tx: FileTx, id: string) {
  return tx.select({ recipient: projectMaterialRecipients, name: users.name }).from(projectMaterialRecipients).innerJoin(users, eq(users.id, projectMaterialRecipients.userId)).where(eq(projectMaterialRecipients.submissionId, id)).orderBy(asc(projectMaterialRecipients.userId))
}
async function requireParticipant(tx: FileTx, row: Submission, scope: Context) {
  const members = await states(tx, row.id)
  if (!scope.manager && row.senderId !== scope.actor.id && !members.some(item => item.recipient.userId === scope.actor.id)) return fail('MATERIAL_FORBIDDEN', '仅送审参与人或有权项目管理人员可查看', 403)
  return members
}
async function replay(tx: FileTx, projectId: string, userId: string, requestId: string, hash: string) {
  const [closed] = await tx.select({ requestId: projectMaterialRequestClosures.requestId }).from(projectMaterialRequestClosures).where(and(eq(projectMaterialRequestClosures.projectId, projectId), eq(projectMaterialRequestClosures.actorId, userId), eq(projectMaterialRequestClosures.requestId, requestId)))
  if (closed) return fail('MATERIAL_REQUEST_CLOSED', '该请求已核对为未提交并封闭，请重新确认操作')
  const [previous] = await tx.select().from(projectMaterialEvents).where(eq(projectMaterialEvents.requestId, requestId))
  if (previous && previous.requestHash !== hash) return fail('MATERIAL_REQUEST_REUSED', '请求编号已用于其他内容，请重新确认')
  return previous ? { id: previous.submissionId } : null
}
async function record(tx: FileTx, row: Submission, userId: string, action: string, reason: string, requestId: string, hash: string) {
  const members = await states(tx, row.id)
  await tx.insert(projectMaterialEvents).values({ submissionId: row.id, actorId: userId, action, reason, requestId, requestHash: hash, version: row.version, snapshot: { submission: row, recipients: members.map(item => item.recipient) } })
  const identity = createMySqlIdentityRepositoryContext(tx), actor = await identity.users.findById(userId)
  await identity.audits.append({ userId, userName: actor!.name, module: '材料送审', action, target: `${row.projectId} / ${row.id} / v${row.version} / ${requestId}` })
}
async function original(tx: FileTx, row: Pick<Submission, 'fileId' | 'fileVersion' | 'fileSha256' | 'fileByteSize'>) {
  const [revision] = await tx.select().from(projectFileVersions).where(and(eq(projectFileVersions.fileId, row.fileId), eq(projectFileVersions.version, row.fileVersion)))
  if (!revision || revision.sha256 !== row.fileSha256 || revision.byteSize !== row.fileByteSize) return fail('MATERIAL_FILE_INTEGRITY', '送审原始版本记录不一致，不能继续处理')
  const bytes = await readProjectFileBuffer(revision.storagePath).catch(error => {
    if ((error as { code?: string }).code === 'FILE_CONTENT_NOT_FOUND') return fail('MATERIAL_FILE_INTEGRITY', '送审原文件缺失或不可安全读取，不能继续处理')
    throw error
  })
  if (!bytes || bytes.length !== row.fileByteSize || createHash('sha256').update(bytes).digest('hex') !== row.fileSha256) return fail('MATERIAL_FILE_INTEGRITY', '送审原文件缺失或哈希不一致，不能继续处理')
  return bytes
}
async function updateAggregate(tx: FileTx, row: Submission) {
  const status = aggregateMaterialStatus((await states(tx, row.id)).map(item => item.recipient))
  await tx.update(projectMaterialSubmissions).set({ status, version: row.version + 1, updatedAt: new Date() }).where(eq(projectMaterialSubmissions.id, row.id))
  return find(tx, row.projectId, row.id)
}

export async function getMaterialContext(projectId: string, userId: string) {
  return run(projectId, userId, false, async (tx, scope) => ({ canSubmit: scope.canSubmit, projectVersion: scope.project.version, governanceVersion: scope.project.governanceVersion, stage: scope.project.stage, recipients: scope.canSubmit ? await recipients(tx, scope) : [] }))
}

export async function resolveMaterialRequest(projectId: string, userId: string, raw: unknown) {
  const { clientRequestId } = materialResolveCommand.parse(raw)
  // Serialize with all material writes. A plain "not found" GET cannot rule out
  // a delayed POST; persist a fence before allowing a new request ID.
  return run(projectId, userId, true, async (tx, scope) => {
    const [event] = await tx.select({ id: projectMaterialEvents.submissionId, actorId: projectMaterialEvents.actorId, action: projectMaterialEvents.action, projectId: projectMaterialSubmissions.projectId })
      .from(projectMaterialEvents).innerJoin(projectMaterialSubmissions, eq(projectMaterialSubmissions.id, projectMaterialEvents.submissionId)).where(eq(projectMaterialEvents.requestId, clientRequestId))
    if (event) {
      if (event.actorId !== userId || event.projectId !== projectId) return fail('MATERIAL_REQUEST_REUSED', '请求编号不属于当前操作')
      // Only one's own receipt metadata; file/feedback still require current ACL.
      return { state: 'committed' as const, id: event.id, action: event.action }
    }
    const [closed] = await tx.select().from(projectMaterialRequestClosures).where(and(eq(projectMaterialRequestClosures.projectId, projectId), eq(projectMaterialRequestClosures.actorId, userId), eq(projectMaterialRequestClosures.requestId, clientRequestId)))
    if (!closed) {
      await tx.insert(projectMaterialRequestClosures).values({ requestId: clientRequestId, projectId, actorId: userId })
      await createMySqlIdentityRepositoryContext(tx).audits.append({ userId, userName: scope.actor.name, module: '材料送审', action: '核对未提交并封闭请求', target: `${projectId} / ${clientRequestId}` })
    }
    return { state: 'not_applied' as const }
  })
}

export async function createMaterialSubmission(projectId: string, userId: string, raw: unknown) {
  const input = materialCreateCommand.parse(raw), hash = digest({ projectId, userId, action: 'submit', input })
  return run(projectId, userId, true, async (tx, scope) => {
    if (!scope.canSubmit) return fail('MATERIAL_SUBMIT_FORBIDDEN', '当前项目状态或角色不能发起材料送审', 403)
    const prior = await replay(tx, projectId, userId, input.clientRequestId, hash); if (prior) return prior
    if (scope.project.version !== input.expectedProjectVersion || scope.project.governanceVersion !== input.expectedGovernanceVersion) return fail('VERSION_CONFLICT', '项目阶段或人员已变化，请刷新接收人后重试')
    const candidates = new Set((await recipients(tx, scope)).map(person => person.id))
    if (input.recipientIds.some(id => !candidates.has(id))) return fail('MATERIAL_RECIPIENT_INVALID', '只能选择当前有效的项目负责人、关注领导或阶段必需领导', 403)
    await tx.execute(sql`SELECT ${projectFiles.id} FROM ${projectFiles} WHERE ${projectFiles.id}=${input.fileId} FOR UPDATE`)
    const file = await requireProjectFileAccess(tx, input.fileId, userId)
    if (file.projectId !== projectId) return fail('MATERIAL_FILE_INVALID', '不能使用其他项目文件', 403)
    if (file.version !== input.fileVersion || file.accessVersion !== input.expectedAccessVersion) return fail('VERSION_CONFLICT', '文件内容或权限已变化，请重新选择')
    if (!file.sha256 || !file.byteSize) return fail('MATERIAL_FILE_INTEGRITY', '请先上传真实原件，不能用文件名或空记录送审')
    await original(tx, { fileId: file.id, fileVersion: file.version, fileSha256: file.sha256, fileByteSize: file.byteSize })
    let revision = 1
    if (input.previousSubmissionId) {
      const previous = await find(tx, projectId, input.previousSubmissionId)
      if (previous.senderId !== userId || !['returned', 'withdrawn'].includes(previous.status)) return fail('MATERIAL_RESUBMIT_INVALID', '仅原发送人可在已退回或已撤回后建立新轮次')
      const [next] = await tx.select({ id: projectMaterialSubmissions.id }).from(projectMaterialSubmissions).where(eq(projectMaterialSubmissions.previousId, previous.id))
      if (next) return fail('MATERIAL_ALREADY_RESUBMITTED', '已有后续轮次，请打开该送审继续处理')
      revision = previous.revision + 1
    }
    const id = randomUUID()
    await tx.insert(projectMaterialSubmissions).values({ id, projectId, fileId: file.id, fileVersion: file.version, fileName: file.name, fileSha256: file.sha256, fileByteSize: file.byteSize, senderId: userId, title: input.title, note: input.note, stage: scope.project.stage, previousId: input.previousSubmissionId ?? null, revision })
    await tx.insert(projectMaterialRecipients).values(input.recipientIds.map(recipientId => ({ submissionId: id, userId: recipientId })))
    const granted: string[] = []
    // FDE reference grants persist until an explicit ACL change; withdrawal does not
    // remove independent grants. Production retention/grant policy remains DEC-007.
    if (file.accessMode === 'explicit') {
      for (const recipientId of input.recipientIds) {
        const [grant] = await tx.select().from(projectFileGrants).where(and(eq(projectFileGrants.fileId, file.id), eq(projectFileGrants.userId, recipientId)))
        if (grant?.canView) continue
        if (grant) await tx.update(projectFileGrants).set({ canView: true, updatedAt: new Date(), grantedBy: userId }).where(eq(projectFileGrants.id, grant.id))
        else await tx.insert(projectFileGrants).values({ fileId: file.id, userId: recipientId, canView: true, canDownload: false, grantedBy: userId })
        granted.push(recipientId)
      }
    }
    // Recheck the effective algorithm, not just the newly inserted grants.
    for (const recipientId of input.recipientIds) await requireProjectFileAccess(tx, file.id, recipientId)
    if (granted.length) {
      await tx.update(projectFiles).set({ accessVersion: file.accessVersion + 1 }).where(eq(projectFiles.id, file.id))
      await tx.insert(projectFileEvents).values({ fileId: file.id, actorId: userId, requestId: input.clientRequestId, requestHash: hash, action: 'material-view', version: file.accessVersion + 1, reason: '材料送审仅补足指定接收人查看权', snapshot: { submissionId: id, grantedViewUserIds: granted, addedDownloadUserIds: [] } })
    }
    await tx.insert(projectMaterialNotices).values(input.recipientIds.map(recipientId => ({ submissionId: id, recipientId, kind: 'review', version: 1 })))
    await record(tx, await find(tx, projectId, id), userId, input.previousSubmissionId ? 'resubmit' : 'submit', '材料送审及站内投递已保存', input.clientRequestId, hash)
    return { id }
  })
}

export async function readMaterialSubmission(projectId: string, id: string, userId: string, raw: unknown) {
  const input = materialReadCommand.parse(raw), hash = digest({ projectId, id, userId, action: 'read', input })
  return run(projectId, userId, true, async (tx, scope) => {
    const row = await find(tx, projectId, id), members = await requireParticipant(tx, row, scope)
    await requireProjectFileAccess(tx, row.fileId, userId)
    const previous = await replay(tx, projectId, userId, input.clientRequestId, hash); if (previous) return previous
    if (row.status === 'withdrawn') return { id }
    const own = members.find(item => item.recipient.userId === userId)?.recipient
    const notices = await tx.select().from(projectMaterialNotices).where(and(eq(projectMaterialNotices.submissionId, id), eq(projectMaterialNotices.recipientId, userId), isNull(projectMaterialNotices.readAt), isNull(projectMaterialNotices.closedAt)))
    const markRecipient = own && !own.readAt && !terminal(row.status)
    if (!markRecipient && !notices.length) return { id }
    const now = new Date()
    if (markRecipient) await tx.update(projectMaterialRecipients).set({ readAt: now }).where(eq(projectMaterialRecipients.id, own.id))
    for (const notice of notices) await tx.update(projectMaterialNotices).set({ readAt: now, ...(notice.kind === 'feedback' ? { closedAt: now } : {}) }).where(eq(projectMaterialNotices.id, notice.id))
    const updated = await updateAggregate(tx, row)
    await record(tx, updated, userId, 'read', '阅读送审及本人站内反馈', input.clientRequestId, hash)
    return { id }
  })
}

export async function decideMaterialSubmission(projectId: string, id: string, userId: string, raw: unknown) {
  const input = materialDecisionCommand.parse(raw), hash = digest({ projectId, id, userId, action: 'decide', input })
  return run(projectId, userId, true, async (tx, scope) => {
    const row = await find(tx, projectId, id), members = await requireParticipant(tx, row, scope)
    await requireProjectFileAccess(tx, row.fileId, userId)
    const own = members.find(item => item.recipient.userId === userId)?.recipient
    if (!own) return fail('MATERIAL_DECISION_FORBIDDEN', '只有本轮指定接收人可反馈', 403)
    const previous = await replay(tx, projectId, userId, input.clientRequestId, hash); if (previous) return previous
    if (scope.project.lifecycle !== 'active' || terminal(row.status) || own.decision) return fail('MATERIAL_DECISION_CLOSED', '项目或送审已结束，或您已提交反馈')
    if (own.version !== input.expectedRecipientVersion) return fail('VERSION_CONFLICT', '您的处理状态已变化，请刷新后确认')
    await original(tx, row)
    const now = new Date()
    await tx.update(projectMaterialRecipients).set({ decision: input.decision, feedback: input.feedback, readAt: own.readAt ?? now, decidedAt: now, version: own.version + 1 }).where(eq(projectMaterialRecipients.id, own.id))
    await tx.update(projectMaterialNotices).set({ readAt: own.readAt ?? now, closedAt: now }).where(and(eq(projectMaterialNotices.submissionId, id), eq(projectMaterialNotices.recipientId, userId), eq(projectMaterialNotices.kind, 'review'), isNull(projectMaterialNotices.closedAt)))
    const updated = await updateAggregate(tx, row)
    await tx.insert(projectMaterialNotices).values({ submissionId: id, recipientId: row.senderId, kind: 'feedback', version: updated.version })
    await record(tx, updated, userId, input.decision, input.feedback, input.clientRequestId, hash)
    return { id }
  })
}

export async function withdrawMaterialSubmission(projectId: string, id: string, userId: string, raw: unknown) {
  const input = materialWithdrawCommand.parse(raw), hash = digest({ projectId, id, userId, action: 'withdraw', input })
  return run(projectId, userId, true, async (tx) => {
    const row = await find(tx, projectId, id)
    if (row.senderId !== userId) return fail('MATERIAL_WITHDRAW_FORBIDDEN', '只有发送人可撤回本轮送审', 403)
    const previous = await replay(tx, projectId, userId, input.clientRequestId, hash); if (previous) return previous
    if (row.version !== input.expectedVersion) return fail('VERSION_CONFLICT', '送审状态已变化，请刷新后确认')
    if (terminal(row.status) || (await states(tx, id)).some(item => item.recipient.decision)) return fail('MATERIAL_WITHDRAW_CLOSED', '已有反馈或已终结的送审不能撤回，请保留原轮次')
    const now = new Date()
    await tx.update(projectMaterialSubmissions).set({ status: 'withdrawn', withdrawnAt: now, withdrawalReason: input.reason, version: row.version + 1, updatedAt: now }).where(eq(projectMaterialSubmissions.id, id))
    await tx.update(projectMaterialNotices).set({ closedAt: now }).where(and(eq(projectMaterialNotices.submissionId, id), isNull(projectMaterialNotices.closedAt)))
    await record(tx, await find(tx, projectId, id), userId, 'withdraw', input.reason, input.clientRequestId, hash)
    return { id }
  })
}

function readableFiles(userId: string) { return db.select({ id: projectFiles.id }).from(projectFiles).where(projectFileAccessCondition(userId)) }
function participantCondition(userId: string, manager = false) {
  return manager ? sql`TRUE` : or(eq(projectMaterialSubmissions.senderId, userId), inArray(projectMaterialSubmissions.id, db.select({ id: projectMaterialRecipients.submissionId }).from(projectMaterialRecipients).where(eq(projectMaterialRecipients.userId, userId))))!
}
async function present(tx: FileTx, row: Submission, scope: Context) {
  const [file] = await tx.select({ id: projectFiles.id, version: projectFiles.version, download: sql<boolean>`${projectFileAccessCondition(scope.actor.id, 'download')}`.mapWith(Boolean) }).from(projectFiles).where(and(eq(projectFiles.id, row.fileId), projectFileAccessCondition(scope.actor.id)))
  const members = file ? await states(tx, row.id) : [], own = members.find(item => item.recipient.userId === scope.actor.id)?.recipient
  const [sender] = await tx.select({ name: users.name }).from(users).where(eq(users.id, row.senderId))
  const [next] = await tx.select({ id: projectMaterialSubmissions.id }).from(projectMaterialSubmissions).where(eq(projectMaterialSubmissions.previousId, row.id))
  const anyDecision = file ? members.some(item => item.recipient.decision) : Boolean((await states(tx, row.id)).some(item => item.recipient.decision))
  return { id: row.id, projectId: row.projectId, status: row.status as MaterialStatus, statusLabel: materialStatusLabels[row.status as MaterialStatus], version: row.version, revision: row.revision,
    restricted: !file, title: file ? row.title : '关联文件权限已失效的送审', note: file ? row.note : '', senderId: row.senderId, senderName: sender.name,
    file: file ? { id: row.fileId, name: row.fileName, version: row.fileVersion, currentVersion: file.version, sha256: row.fileSha256, byteSize: row.fileByteSize } : null,
    recipients: members.map(({ recipient, name }) => ({ userId: recipient.userId, name, readAt: recipient.readAt, decision: recipient.decision, feedback: recipient.feedback, decidedAt: recipient.decidedAt, version: recipient.version })),
    previousId: file ? row.previousId : null, nextId: file ? next?.id ?? null : null, stage: file ? row.stage : '', createdAt: row.createdAt, withdrawnAt: row.withdrawnAt, withdrawalReason: file ? row.withdrawalReason : null,
    capabilities: { read: Boolean(file), download: Boolean(file?.download), decide: Boolean(file && own && !own.decision && !terminal(row.status) && scope.project.lifecycle === 'active'), withdraw: row.senderId === scope.actor.id && !terminal(row.status) && !anyDecision, resubmit: Boolean(file && scope.canSubmit && row.senderId === scope.actor.id && ['returned', 'withdrawn'].includes(row.status) && !next) },
    ownRecipientVersion: own?.version ?? null }
}
export async function listMaterialSubmissions(projectId: string, userId: string, raw: unknown = {}) {
  const input = materialListQuery.parse(raw)
  return run(projectId, userId, false, async (tx, scope) => {
    const received = tx.select({ id: projectMaterialRecipients.submissionId }).from(projectMaterialRecipients).where(and(eq(projectMaterialRecipients.userId, userId), input.view === 'pending' ? isNull(projectMaterialRecipients.decision) : undefined))
    const visible = inArray(projectMaterialSubmissions.fileId, readableFiles(userId))
    const where = and(eq(projectMaterialSubmissions.projectId, projectId), participantCondition(userId, scope.manager), or(visible, eq(projectMaterialSubmissions.senderId, userId)),
      input.view === 'sent' ? eq(projectMaterialSubmissions.senderId, userId) : ['received', 'pending'].includes(input.view) ? inArray(projectMaterialSubmissions.id, received) : undefined,
      input.view === 'withdrawn' ? eq(projectMaterialSubmissions.status, 'withdrawn') : input.view === 'pending' ? inArray(projectMaterialSubmissions.status, ['pending', 'read', 'partial', 'partial_returned']) : undefined,
      input.keyword ? and(visible, sql`LOCATE(${input.keyword},${projectMaterialSubmissions.title})>0`) : undefined)
    const [total] = await tx.select({ value: count() }).from(projectMaterialSubmissions).where(where)
    const rows = await tx.select().from(projectMaterialSubmissions).where(where).orderBy(desc(projectMaterialSubmissions.createdAt), desc(projectMaterialSubmissions.id)).limit(input.pageSize).offset((input.page - 1) * input.pageSize)
    return { list: await Promise.all(rows.map(row => present(tx, row, scope))), total: total.value, ...input, canSubmit: scope.canSubmit }
  })
}
export async function getMaterialSubmission(projectId: string, id: string, userId: string, raw: unknown = {}) {
  const input = materialHistoryQuery.parse(raw)
  return run(projectId, userId, false, async (tx, scope) => {
    const row = await find(tx, projectId, id); await requireParticipant(tx, row, scope)
    const submission = await present(tx, row, scope)
    if (submission.restricted && row.senderId !== userId) return fail('MATERIAL_FORBIDDEN', '关联文件查看权限已失效', 403)
    const [total] = await tx.select({ value: count() }).from(projectMaterialEvents).where(eq(projectMaterialEvents.submissionId, id))
    const events = submission.restricted ? [] : await tx.select({ id: projectMaterialEvents.id, actorName: users.name, action: projectMaterialEvents.action, reason: projectMaterialEvents.reason, version: projectMaterialEvents.version, createdAt: projectMaterialEvents.createdAt }).from(projectMaterialEvents).innerJoin(users, eq(users.id, projectMaterialEvents.actorId)).where(eq(projectMaterialEvents.submissionId, id)).orderBy(desc(projectMaterialEvents.version)).limit(input.pageSize).offset((input.page - 1) * input.pageSize)
    return { submission, events, historyTotal: submission.restricted ? 0 : total.value, ...input }
  })
}
export async function getMaterialOriginal(projectId: string, id: string, userId: string) {
  return run(projectId, userId, false, async (tx, scope) => {
    const row = await find(tx, projectId, id); await requireParticipant(tx, row, scope); await requireProjectFileAccess(tx, row.fileId, userId)
    return { bytes: await original(tx, row), name: row.fileName, version: row.fileVersion, sha256: row.fileSha256 }
  })
}
export async function listMaterialInbox(userId: string, raw: unknown = {}) {
  const input = materialHistoryQuery.parse(raw)
  const where = and(eq(projectMaterialNotices.recipientId, userId), isNull(projectMaterialNotices.closedAt), inArray(projectMaterialSubmissions.fileId, readableFiles(userId)),
    inArray(projectMaterialSubmissions.projectId, db.select({ id: projects.id }).from(projects).where(and(eq(projects.lifecycle, 'active'), projectAccessCondition({ uid: userId, role: '', name: '' })))), participantCondition(userId))
  const [total] = await db.select({ value: count() }).from(projectMaterialNotices).innerJoin(projectMaterialSubmissions, eq(projectMaterialSubmissions.id, projectMaterialNotices.submissionId)).where(where)
  const list = await db.select({ id: projectMaterialNotices.id, submissionId: projectMaterialSubmissions.id, projectId: projectMaterialSubmissions.projectId, title: projectMaterialSubmissions.title, status: projectMaterialSubmissions.status, kind: projectMaterialNotices.kind, readAt: projectMaterialNotices.readAt, createdAt: projectMaterialNotices.createdAt }).from(projectMaterialNotices).innerJoin(projectMaterialSubmissions, eq(projectMaterialSubmissions.id, projectMaterialNotices.submissionId)).where(where).orderBy(desc(projectMaterialNotices.createdAt), desc(projectMaterialNotices.id)).limit(input.pageSize).offset((input.page - 1) * input.pageSize)
  return { list, total: total.value, ...input, channel: '站内通知', externalDelivery: '未配置外部投递' }
}
