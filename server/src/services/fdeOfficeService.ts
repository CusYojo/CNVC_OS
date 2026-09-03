import { createHash, randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.js'
import { oaApprovalRequests as requests, oaApprovalNodes as nodes, oaApprovalRecords as records, oaApprovalRevisions as revisions, oaOfficeEvents as events, oaOfficeCommands as commands, oaOfficeAttachments as files, oaOfficeAttachmentGrants as grants, oaOfficeNotices as notices, oaOfficePolicies as policies, projects, users } from '../db/schema.js'
import { officeAction, officeCommand, officeDefinition, officeGrantCommand, officeLeaveDays, officeLeaveType, officeQuery, officeResolveCommand, officeSave, validateOfficeSubmission, type OfficeDefinition, type OfficeNodeRule } from '../contracts/fdeOfficeContract.js'
import { approveNodeTransition } from '../contracts/approvalNodeTransition.js'
import { officeAccessCondition, officeActor, officeFail as fail, officeFileGrant, officeProject, officeReadable, officeRoleEligible, officeSelectedFiles, type OfficeTx } from './fdeOfficeAccessService.js'
import { pinnedOfficePolicy, resolveOfficeRoute } from './fdeOfficePolicyService.js'
import { policyHash } from './fdeWorkflowPolicyService.js'
import { projectAccessCondition } from './projectAccessService.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { decodeAndValidateProjectFile } from '../security/projectFileValidation.js'
import { readProjectFileBuffer, saveProjectFileRevision } from './projectFileStorageService.js'
import { listApprovalCenter } from './fdeApprovalCenterService.js'
import { oaOfficeExecutions as executions, oaOfficeExecutionFiles as executionFiles } from '../db/schema.js'
import { officeAttachmentGrantAuthority, officeExecutionAuthorized, officeExecutionCommand, officeExecutionFields, validateOfficeExecution, type OfficeExecutionView } from '../contracts/fdeOfficeExecutionContract.js'

type Request = typeof requests.$inferSelect
type Node = typeof nodes.$inferSelect
const definitionOf = (row: Request) => officeDefinition.parse(row.businessPayload.definition)
const departmentsOf = (row: Request) => z.array(z.string().uuid()).parse(row.businessPayload.departmentIds ?? [])
const byteHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const defaultLeaveAllowance: Record<string, number | null> = { '年假': 10, '事假': 5, '病假': 10, '婚假': null, '产假': null, '调休': null }

async function leaveBalances(reader: Pick<OfficeTx, 'select'>, userId: string) {
  const year = new Date(Date.now() + 8 * 3600000).getUTCFullYear()
  const used = new Map<string, number>()
  const rows = await reader.select({ status: requests.status, payload: requests.businessPayload }).from(requests).where(and(eq(requests.applicantUserId, userId), eq(requests.businessType, 'office'), eq(requests.type, '请假'), eq(requests.status, '已通过')))
  for (const row of rows) {
    const parsed = officeDefinition.safeParse(row.payload?.definition)
    if (!parsed.success || parsed.data.details.kind !== '请假' || !parsed.data.details.startAt || Number(parsed.data.details.startAt.slice(0, 4)) !== year) continue
    const days = officeLeaveDays(parsed.data.details.hours)
    const leaveType = officeLeaveType(parsed.data.details.leaveType)
    used.set(leaveType, (used.get(leaveType) ?? 0) + days)
  }
  return Object.entries(defaultLeaveAllowance).map(([type, allowanceDays]) => {
    const usedDays = Math.round((used.get(type) ?? 0) * 100) / 100
    return { type, allowanceDays, usedDays, remainingDays: allowanceDays == null ? null : Math.max(0, Math.round((allowanceDays - usedDays) * 100) / 100) }
  })
}

async function validateLeaveBalance(reader: Pick<OfficeTx, 'select'>, userId: string, definition: OfficeDefinition) {
  const details = definition.details
  if (details.kind !== '请假') return []
  const balance = (await leaveBalances(reader, userId)).find(row => row.type === details.leaveType)
  const requestedDays = officeLeaveDays(details.hours)
  return balance?.remainingDays != null && requestedDays > balance.remainingDays ? [`${balance.type}剩余 ${balance.remainingDays} 天，本次申请 ${requestedDays} 天`] : []
}
const expected = (row: Request, version: number) => { if (row.lockVersion !== version) return fail('OFFICE_VERSION_CONFLICT', '申请已更新，请核对最新版本后重新确认') }
async function lockCommand(tx: OfficeTx, requestId: string, userId: string, commandId: string) {
  const [actor] = await tx.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.id, userId), eq(users.status, '启用')))
  if (!actor) return fail('OFFICE_ACTOR_UNAVAILABLE', '当前账号不可用', 403)
  // The unique insert locks an existing key too, including an uncommitted key.
  // Always lock command before project/request. Recovery uses the same order,
  // including creation where no business request exists to lock yet.
  await tx.insert(commands).values({ actorId: userId, commandId, requestId }).onDuplicateKeyUpdate({ set: { id: sql`${commands.id}` } })
  const [command] = await tx.select().from(commands).where(and(eq(commands.actorId, userId), eq(commands.commandId, commandId))).for('update')
  if (command.requestId !== requestId) return fail('OFFICE_COMMAND_REUSED', '请求标识已用于其他操作')
  return { command, actor }
}
async function beginCommand(tx: OfficeTx, requestId: string, userId: string, commandId: string, hash: string) {
  const { command } = await lockCommand(tx, requestId, userId, commandId)
  if (command.closedAt) return fail('OFFICE_COMMAND_CLOSED', '该操作已核对为未提交并封闭，请核对最新申请后重新确认')
  return replay(tx, commandId, hash)
}
async function replay(tx: OfficeTx, id: string, hash: string) {
  const [old] = await tx.select().from(events).where(eq(events.commandId, id))
  if (!old) return null
  if (old.commandHash !== hash) return fail('OFFICE_COMMAND_REUSED', '请求标识已用于其他操作')
  return { id: old.requestId, version: old.version }
}
async function event(tx: OfficeTx, row: Request, userId: string, commandId: string, commandHash: string, action: string, reason: string) {
  const chain = await tx.select().from(nodes).where(and(eq(nodes.requestId, row.id), eq(nodes.officeRevision, row.officeRevision))).orderBy(asc(nodes.sequence))
  await tx.insert(events).values({ requestId: row.id, commandId, commandHash, version: row.lockVersion, actorId: userId, action, reason, snapshot: { request: row, nodes: chain } })
  const identity = createMySqlIdentityRepositoryContext(tx), actor = await identity.users.findById(userId)
  await identity.audits.append({ userId, userName: actor!.name, module: '通用OA', action, target: `${row.id} / v${row.lockVersion} / ${commandId}` })
  return { id: row.id, version: row.lockVersion }
}
async function update(tx: OfficeTx, row: Request, patch: Partial<typeof requests.$inferInsert>) {
  await tx.update(requests).set({ ...patch, lockVersion: row.lockVersion + 1, updatedAt: new Date() }).where(eq(requests.id, row.id))
  return (await tx.select().from(requests).where(eq(requests.id, row.id)))[0]
}
async function locked<T>(id: string, userId: string, fn: (tx: OfficeTx, row: Request) => Promise<T>, nextProject?: string | null, recover?: (tx: OfficeTx) => Promise<T | null>) {
  return db.transaction(async tx => {
    // Exact actor-bound receipts remain available after transfer, deletion or
    // business-role revocation. No body or content permission is returned.
    if (recover) { const receipt = await recover(tx); if (receipt) return receipt }
    const [initial] = await tx.select({ projectId: requests.projectId }).from(requests).where(eq(requests.id, id))
    for (const projectId of [...new Set([initial?.projectId, nextProject].filter((x): x is string => Boolean(x)))].sort()) await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
    await tx.execute(sql`SELECT ${requests.id} FROM ${requests} WHERE ${requests.id}=${id} FOR UPDATE`)
    const row = await officeReadable(tx, id, userId)
    if (row.projectId !== initial?.projectId) return fail('OFFICE_VERSION_CONFLICT', '关联项目已变化，请重新核对')
    return fn(tx, row)
  }, { isolationLevel: 'read committed' })
}
async function editable(tx: OfficeTx, row: Request, userId: string) {
  if (row.applicantUserId !== userId) return fail('OFFICE_APPLICANT_REQUIRED', '仅申请人可修改或重提', 403)
  if (['草稿', '已退回', '已撤回'].includes(row.status)) return
  if (row.status === '已拒绝' && (await pinnedOfficePolicy(tx, row.officePolicyVersionId)).configuration.rejectResubmission) return
  return fail('OFFICE_NOT_EDITABLE', '当前申请状态不允许修改')
}
async function verifyBytes(file: typeof files.$inferSelect) {
  const bytes = await readProjectFileBuffer(file.storagePath)
  if (bytes.length !== file.byteSize || byteHash(bytes) !== file.sha256) return fail('OFFICE_FILE_INTEGRITY', '申请原始附件缺失或校验失败')
  return bytes
}
async function evidence(tx: OfficeTx, row: Request, userId: string, integrity: boolean, download = false) {
  const selected = await officeSelectedFiles(tx, row.id, definitionOf(row).attachmentIds)
  for (const file of selected) {
    if (!await officeFileGrant(tx, file, userId, download)) return fail('OFFICE_FILE_FORBIDDEN', download ? '转交接收人须具备全部附件查看及下载权限' : '当前人员无权查看全部送审附件', 403)
    if (integrity) await verifyBytes(file)
  }
  return selected
}
async function noticeCurrent(tx: OfficeTx, row: Request, node?: Pick<Node, 'id' | 'approverUserIds' | 'approvedByUserIds'>) {
  await tx.update(notices).set({ status: 'closed', closedAt: new Date() }).where(and(eq(notices.requestId, row.id), isNull(notices.closedAt)))
  if (!node || row.status !== '审批中') return
  for (const recipientId of node.approverUserIds.filter(id => !node.approvedByUserIds.includes(id))) await tx.insert(notices).values({ requestId: row.id, nodeId: node.id, recipientId, dedupeKey: `${row.id}:r${row.officeRevision}:v${row.lockVersion}:${node.id}:${recipientId}` })
}
async function record(tx: OfficeTx, row: Request, node: Node, userId: string, action: string, reason: string) {
  const { actor } = await officeActor(tx, userId)
  await tx.insert(records).values({ requestId: row.id, nodeId: node.id, nodeName: node.name, operatorUserId: userId, operatorName: actor.name, action, comment: reason })
}
export async function saveOfficeRequest(id: string, userId: string, raw: unknown) {
  const input = officeSave.parse(raw), hash = policyHash({ id, userId, action: 'save', input }), d = input.definition
  if (input.expectedVersion === 0) return db.transaction(async tx => {
    const existing = await beginCommand(tx, id, userId, input.clientRequestId, hash)
    if (existing) return existing
    const { actor } = await officeActor(tx, userId)
    if (d.projectId) await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${d.projectId} FOR UPDATE`)
    const project = await officeProject(tx, userId, d.projectId, true)
    if (d.attachmentIds.length) return fail('OFFICE_DRAFT_FIRST', '请先保存草稿，再上传申请附件')
    await tx.insert(requests).values({ id, requestNo: `OA-${randomUUID()}`, projectId: d.projectId, projectName: project?.name ?? '', title: d.title || '未命名办公草稿', type: d.details.kind, businessType: 'office', fromStage: '', targetStage: '', status: '草稿', applicantUserId: userId, applicantName: actor.name, department: actor.department, priority: d.priority, currentNodeName: '未提交', reason: d.reason, businessPayload: { definition: d, departmentIds: [] } }).onDuplicateKeyUpdate({ set: { id: sql`${requests.id}` } })
    const row = await officeReadable(tx, id, userId), prior = await replay(tx, input.clientRequestId, hash)
    if (prior) return prior
    if (row.applicantUserId !== userId || row.lockVersion !== 1 || (await tx.select().from(events).where(eq(events.requestId, id)).limit(1)).length) return fail('OFFICE_ALREADY_EXISTS', '申请已存在，请打开原单')
    return event(tx, row, userId, input.clientRequestId, hash, 'create', '保存草稿，未提交审批')
  }, { isolationLevel: 'read committed' })
  return locked(id, userId, async (tx, row) => {
    await editable(tx, row, userId)
    const prior = await replay(tx, input.clientRequestId, hash); if (prior) return prior
    expected(row, input.expectedVersion)
    const project = await officeProject(tx, userId, d.projectId, true)
    if (row.officeRevision && (d.details.kind !== row.type || d.projectId !== row.projectId)) return fail('OFFICE_IDENTITY_FROZEN', '已提交申请不能更改类型或关联项目，请另建申请')
    await officeSelectedFiles(tx, id, d.attachmentIds)
    const next = await update(tx, row, { title: d.title || '未命名办公草稿', projectId: d.projectId, projectName: project?.name ?? '', type: d.details.kind, reason: d.reason, priority: d.priority, businessPayload: { ...row.businessPayload, definition: d } })
    return event(tx, next, userId, input.clientRequestId, hash, 'save', '保存申请修订，尚未重新提交')
  }, d.projectId, tx => beginCommand(tx, id, userId, input.clientRequestId, hash))
}
export async function previewOfficeRequest(id: string, userId: string) {
  return locked(id, userId, async (tx, row) => {
    await editable(tx, row, userId)
    const definition = definitionOf(row), route = await resolveOfficeRoute(tx, definition, userId)
    return { requestVersion: row.lockVersion, policyVersionId: route.policy.id, policyRevision: route.policy.revision, routeKey: route.routeKey, routeHash: route.routeHash, nodes: route.nodes, issues: [...validateOfficeSubmission(definition, route.policy.configuration), ...await validateLeaveBalance(tx, userId, definition)], sharingRequired: definition.attachmentIds.length > 0 }
  })
}
export async function actOnOfficeRequest(id: string, userId: string, raw: unknown) {
  const input = officeAction.parse(raw), hash = policyHash({ id, userId, input })
  return locked(id, userId, async (tx, row) => {
    const prior = await replay(tx, input.clientRequestId, hash); if (prior) return prior
    expected(row, input.expectedVersion)
    let next: Request
    if (input.action === 'submit') {
      await editable(tx, row, userId)
      await officeProject(tx, userId, row.projectId, true)
      const definition = definitionOf(row), resolved = await resolveOfficeRoute(tx, definition, userId, true)
      if (input.expectedPolicyVersionId !== resolved.policy.id || input.expectedRouteHash !== resolved.routeHash) return fail('OFFICE_POLICY_CHANGED', '规则或审批人员已变化，请重新预览并确认审批路径')
      const issues = [...validateOfficeSubmission(definition, resolved.policy.configuration), ...await validateLeaveBalance(tx, userId, definition)]
      if (issues.length) return fail('OFFICE_VALIDATION_FAILED', issues.join('；'), 400)
      const selected = await evidence(tx, row, userId, true)
      if (selected.length && input.confirmAttachmentSharing !== true) return fail('OFFICE_SHARING_CONFIRMATION', '请明确确认向审批路径人员授予原件查看权')
      const revision = row.officeRevision + 1, { actor } = await officeActor(tx, userId)
      const chain = resolved.nodes.map((n, index) => ({ id: randomUUID(), requestId: id, name: n.rule.name, approverRole: n.rule.name, mode: n.rule.mode, sequence: revision * 100 + index + 1, officeRevision: revision, officeRule: n.rule, status: index === 0 ? '待审批' : '未开始', approverUserIds: n.userIds, approverNames: n.names, approvedByUserIds: [], approvedByNames: [] }))
      await tx.insert(nodes).values(chain)
      for (const file of selected) for (const uid of new Set(chain.flatMap(n => n.approverUserIds))) await tx.insert(grants).values({ attachmentId: file.id, userId: uid, canDownload: false }).onDuplicateKeyUpdate({ set: { userId: uid } })
      next = await update(tx, row, { status: '审批中', officePolicyVersionId: resolved.policy.id, officeRevision: revision, currentNodeId: chain[0].id, currentNodeName: chain[0].name, submittedAt: new Date(), completedAt: null, businessPayload: { definition, departmentIds: resolved.departmentIds, routeKey: resolved.routeKey } })
      await tx.insert(revisions).values({ requestId: id, revision, submittedBy: userId, snapshot: { definition, policyVersionId: resolved.policy.id, policyHash: resolved.policy.sha256, routeKey: resolved.routeKey, departmentIds: resolved.departmentIds, nodes: chain, attachments: selected.map(f => ({ id: f.id, name: f.name, sha256: f.sha256, byteSize: f.byteSize })) } })
      await tx.insert(records).values({ requestId: id, nodeId: chain[0].id, nodeName: '申请人提交', operatorUserId: userId, operatorName: actor.name, action: '提交', comment: input.reason })
      await noticeCurrent(tx, next, chain[0])
    } else if (input.action === 'delete') {
      if (row.status !== '草稿' || row.officeRevision !== 0 || row.applicantUserId !== userId) return fail('OFFICE_DELETE_FORBIDDEN', '只能删除本人从未提交的草稿', 403)
      next = await update(tx, row, { status: '已删除', completedAt: new Date(), currentNodeName: '草稿已删除；原件按保留策略留存' })
    } else {
      if (row.status !== '审批中' || !row.currentNodeId) return fail('OFFICE_NOT_PENDING', '此申请不在处理中')
      const chain = await tx.select().from(nodes).where(and(eq(nodes.requestId, id), eq(nodes.officeRevision, row.officeRevision))).orderBy(asc(nodes.sequence))
      const node = chain.find(n => n.id === row.currentNodeId)
      if (!node) return fail('OFFICE_NODE_MISSING', '当前节点不存在')
      if (input.action === 'withdraw') {
        if (row.applicantUserId !== userId) return fail('OFFICE_APPLICANT_REQUIRED', '仅申请人可以撤回', 403)
      } else {
        if (row.applicantUserId === userId || !node.approverUserIds.includes(userId) || node.approvedByUserIds.includes(userId) || !await officeRoleEligible(tx, userId, node.officeRule as OfficeNodeRule, departmentsOf(row))) return fail('OFFICE_REVIEWER_FORBIDDEN', '当前节点不属于本人或当前岗位已失效', 403)
        await evidence(tx, row, userId, input.action === 'approve')
        await pinnedOfficePolicy(tx, row.officePolicyVersionId)
      }
      if (input.action === 'transfer') {
        const target = input.targetUserId, rule = node.officeRule as OfficeNodeRule
        const past = await tx.select({ id: records.operatorUserId }).from(records).where(and(eq(records.requestId, id), inArray(records.action, ['同意', '退回', '拒绝', '转交'])))
        const excluded = new Set([row.applicantUserId, userId, ...past.map(p => p.id), ...chain.filter(n => n.id !== node.id).flatMap(n => n.approverUserIds), ...node.approverUserIds])
        if (!rule.allowTransfer || !target || excluded.has(target) || !await officeRoleEligible(tx, target, rule, departmentsOf(row))) return fail('OFFICE_TRANSFER_FORBIDDEN', '接收人须为同节点有效岗位，且不属于申请人、本人、已处理人或其他节点', 403)
        await officeProject(tx, target, row.projectId)
        await evidence(tx, row, target, false, true)
        const person = (await officeActor(tx, target)).actor
        const updatedNode = { ...node, approverUserIds: node.approverUserIds.map(uid => uid === userId ? target : uid), approverNames: node.approverNames.map((name, i) => node.approverUserIds[i] === userId ? person.name : name) }
        await tx.update(nodes).set({ approverUserIds: updatedNode.approverUserIds, approverNames: updatedNode.approverNames }).where(eq(nodes.id, node.id))
        next = await update(tx, row, {})
        await noticeCurrent(tx, next, updatedNode)
        await record(tx, row, node, userId, '转交', `${input.reason}；接收人 ${target}`)
      } else if (input.action === 'approve') {
        const transition = approveNodeTransition({ ...node, actorId: userId }), { actor } = await officeActor(tx, userId)
        const updatedNode = { ...node, approvedByUserIds: transition.approvedIds, approvedByNames: [...node.approvedByNames, actor.name], status: transition.completed ? '已通过' : '会签中' }
        await tx.update(nodes).set({ approvedByUserIds: updatedNode.approvedByUserIds, approvedByNames: updatedNode.approvedByNames, status: updatedNode.status, completedAt: transition.completed ? new Date() : null, comment: input.reason }).where(eq(nodes.id, node.id))
        const following = transition.completed ? chain[chain.findIndex(n => n.id === node.id) + 1] : updatedNode
        if (following && transition.completed) await tx.update(nodes).set({ status: '待审批' }).where(eq(nodes.id, following.id))
        next = await update(tx, row, { status: following ? '审批中' : '已通过', currentNodeId: following?.id ?? null, currentNodeName: following?.name ?? '批准完成；实际执行另行登记', completedAt: following ? null : new Date() })
        await noticeCurrent(tx, next, following)
        await record(tx, row, node, userId, '同意', input.reason)
      } else {
        const label = input.action === 'return' ? '退回' : input.action === 'reject' ? '拒绝' : '撤回'
        await tx.update(nodes).set({ status: `已${label}`, completedAt: new Date(), comment: input.reason }).where(eq(nodes.id, node.id))
        next = await update(tx, row, { status: `已${label}`, currentNodeId: null, currentNodeName: `申请已${label}`, completedAt: new Date() })
        await noticeCurrent(tx, next)
        await record(tx, row, node, userId, label, input.reason)
      }
    }
    return event(tx, next, userId, input.clientRequestId, hash, input.action, input.reason)
  }, undefined, tx => beginCommand(tx, id, userId, input.clientRequestId, hash))
}

export async function uploadOfficeAttachment(id: string, fileId: string, userId: string, raw: unknown) {
  const input = officeCommand.extend({ name: z.string().max(255), dataBase64: z.string().max(140_000_000), declaredType: z.string().max(128).optional(), purpose: z.enum(['application', 'signed', 'execution']).default('application') }).strict().parse(raw)
  const validated = await decodeAndValidateProjectFile(input), hash = policyHash({ id, fileId, userId, input: { ...input, dataBase64: validated.sha256 } })
  return locked(id, userId, async (tx, row) => {
    const prior = await replay(tx, input.clientRequestId, hash); if (prior) return prior
    expected(row, input.expectedVersion)
    if (row.type === '报销' && input.purpose === 'application' && !['pdf', 'jpg', 'jpeg', 'png'].includes(validated.extension)) return fail('OFFICE_EXPENSE_FILE_TYPE', '报销证明材料仅支持 PDF、JPG/JPEG 和 PNG', 415)
    if (input.purpose === 'signed') {
      if (row.type !== '合同' || row.status !== '已通过' || row.applicantUserId !== userId) return fail('OFFICE_SIGNED_COPY_FORBIDDEN', '只有申请人可为已批准合同另存签署件', 403)
    } else if (input.purpose === 'execution') { await requireOfficeExecutor(tx, row, userId); await evidence(tx, row, userId, true) }
    else await editable(tx, row, userId)
    if ((await tx.select().from(files).where(eq(files.id, fileId)).limit(1)).length) return fail('OFFICE_FILE_EXISTS', '附件标识已存在，不能覆盖原件')
    // Dedicated namespace under the existing private root; no fabricated project.
    // Unique revisions are retained if DB commit fails; never delete possibly committed bytes.
    const storagePath = await saveProjectFileRevision(`_oa/${id}`, fileId, validated.buffer)
    await tx.insert(files).values({ id: fileId, requestId: id, name: validated.name, mime: validated.contentType, byteSize: validated.byteSize, sha256: validated.sha256, storagePath, uploadedBy: userId, purpose: input.purpose })
    const definition = definitionOf(row)
    const next = await update(tx, row, input.purpose === 'application' ? { businessPayload: { ...row.businessPayload, definition: { ...definition, attachmentIds: [...definition.attachmentIds, fileId] } } } : {})
    return event(tx, next, userId, input.clientRequestId, hash, input.purpose === 'signed' ? 'signed-copy' : 'upload', input.reason)
  }, undefined, tx => beginCommand(tx, id, userId, input.clientRequestId, hash))
}
export async function grantOfficeAttachment(id: string, fileId: string, userId: string, raw: unknown) {
  const input = officeGrantCommand.parse(raw), hash = policyHash({ id, fileId, userId, input })
  return locked(id, userId, async (tx, row) => {
    const prior = await replay(tx, input.clientRequestId, hash); if (prior) return prior
    expected(row, input.expectedVersion)
    const [file] = await tx.select().from(files).where(and(eq(files.id, fileId), eq(files.requestId, id)))
    if (!file) return fail('OFFICE_FILE_FORBIDDEN', '附件不属于此申请', 403)
    if (!await canManageOfficeAttachment(tx, row, file, userId)) {
      if (file.purpose !== 'execution') return fail('OFFICE_APPLICANT_REQUIRED', '仅申请人管理附件授权', 403)
      return fail('OFFICE_ATTACHMENT_GRANT_FORBIDDEN', '执行原件仅限当前有执行资格的上传人管理；申请人身份或查看权不授予再授权能力', 403)
    }
    if (!await officeFileGrant(tx, file, userId)) return fail('OFFICE_FILE_FORBIDDEN', '不能转授当前无权查看的执行原件', 403)
    for (const grant of input.grants) { await officeActor(tx, grant.userId); await officeProject(tx, grant.userId, row.projectId) }
    await tx.delete(grants).where(eq(grants.attachmentId, fileId))
    if (input.grants.length) await tx.insert(grants).values(input.grants.map(g => ({ attachmentId: fileId, ...g })))
    const next = await update(tx, row, {})
    return event(tx, next, userId, input.clientRequestId, hash, 'attachment-grants', input.reason)
  }, undefined, tx => beginCommand(tx, id, userId, input.clientRequestId, hash))
}
export async function getOfficeAttachment(id: string, fileId: string, userId: string, download = false) {
  return db.transaction(async tx => {
    await officeReadable(tx, id, userId)
    const [file] = await tx.select().from(files).where(and(eq(files.id, fileId), eq(files.requestId, id)))
    if (!file || !await officeFileGrant(tx, file, userId, download)) return fail('OFFICE_FILE_FORBIDDEN', '附件不存在或无权操作', 403)
    return { name: file.name, mime: file.mime, sha256: file.sha256, bytes: await verifyBytes(file) }
  })
}
export async function getOfficeRequest(id: string, userId: string, page = 1) {
  return db.transaction(async tx => {
    const row = await officeReadable(tx, id, userId), definition = definitionOf(row)
    const [chain, history, revisionRows, attachments] = await Promise.all([
      tx.select().from(nodes).where(and(eq(nodes.requestId, id), eq(nodes.officeRevision, row.officeRevision))).orderBy(asc(nodes.sequence)),
      tx.select({ id: events.id, actorId: events.actorId, action: events.action, version: events.version, reason: events.reason, createdAt: events.createdAt }).from(events).where(eq(events.requestId, id)).orderBy(desc(events.version)).limit(50).offset((page - 1) * 50),
      tx.select({ id: revisions.id, revision: revisions.revision, submittedAt: revisions.submittedAt }).from(revisions).where(eq(revisions.requestId, id)).orderBy(desc(revisions.revision)),
      tx.select().from(files).where(eq(files.requestId, id)).orderBy(desc(files.createdAt)),
    ])
    const allowed = []
    for (const file of attachments) if (await officeFileGrant(tx, file, userId)) {
      const canManageGrants = await canManageOfficeAttachment(tx, row, file, userId)
      allowed.push({ id: file.id, name: file.name, byteSize: file.byteSize, sha256: file.sha256, version: 1, purpose: file.purpose,
        canDownload: await officeFileGrant(tx, file, userId, true), canManageGrants,
        grants: canManageGrants ? await tx.select({ userId: grants.userId, canDownload: grants.canDownload }).from(grants).where(eq(grants.attachmentId, file.id)) : undefined })
    }
    const current = chain.find(n => n.id === row.currentNodeId), author = row.applicantUserId === userId
    const canReview = row.status === '审批中' && !author && Boolean(current && current.approverUserIds.includes(userId) && !current.approvedByUserIds.includes(userId) && await officeRoleEligible(tx, userId, current.officeRule as OfficeNodeRule, departmentsOf(row)))
    const canEdit = author && (['草稿', '已退回', '已撤回'].includes(row.status) || (row.status === '已拒绝' && (await pinnedOfficePolicy(tx, row.officePolicyVersionId)).configuration.rejectResubmission))
    return { id, requestNo: row.requestNo, title: row.title, kind: row.type, status: row.status, applicantId: row.applicantUserId, applicantName: row.applicantName, projectName: row.projectName, definition, version: row.lockVersion, revision: row.officeRevision, submittedAt: row.submittedAt, currentNodeId: row.currentNodeId, nodes: chain, history, revisions: revisionRows, attachments: allowed, capabilities: { author, review: canReview, withdraw: author && row.status === '审批中', transfer: canReview && Boolean(current?.officeRule.allowTransfer), edit: canEdit, delete: author && row.status === '草稿' && !row.officeRevision } }
  })
}
export async function listOfficeRequests(userId: string, raw: unknown) {
  const query = officeQuery.parse(raw)
  await officeActor(db, userId)
  const { list, total, page, pageSize } = await listApprovalCenter(userId, query, 'office')
  return { list, total, page, pageSize }
}

export async function listReusableOfficeRequests(userId: string, raw: unknown) {
  const kind = z.enum(['出差', '用印', '报销', '请假', '合同']).parse(raw)
  await officeActor(db, userId)
  const rows = await db.select().from(requests).where(and(eq(requests.applicantUserId, userId), eq(requests.businessType, 'office'), eq(requests.type, kind), ne(requests.status, '已删除'))).orderBy(desc(requests.updatedAt)).limit(20)
  return rows.map(row => ({ id: row.id, requestNo: row.requestNo, title: row.title, status: row.status, updatedAt: row.updatedAt, definition: { ...definitionOf(row), attachmentIds: [] } }))
}

export async function officeOptions(userId: string) {
  const { actor } = await officeActor(db, userId)
  const people = []
  for (const person of await db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(eq(users.status, '启用'))) {
    try { await officeActor(db, person.id); people.push(person) } catch (error) { if ((error as { code?: string }).code !== 'OFFICE_BUSINESS_ROLE_REQUIRED') throw error }
  }
  const projectRows = await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.lifecycle, 'active'), projectAccessCondition({ uid: userId, name: actor.name, role: actor.role }))).orderBy(asc(projects.name))
  const enabledKinds = (await db.select({ kind: policies.kind }).from(policies).where(eq(policies.enabled, true))).map(p => p.kind)
  return { people, projects: projectRows, enabledKinds, leaveBalances: await leaveBalances(db, userId) }
}

export async function officeTransferCandidates(id: string, userId: string) {
  return locked(id, userId, async (tx, row) => {
    const chain = await tx.select().from(nodes).where(and(eq(nodes.requestId, id), eq(nodes.officeRevision, row.officeRevision)))
    const node = chain.find(n => n.id === row.currentNodeId)
    if (row.status !== '审批中' || row.applicantUserId === userId || !node?.approverUserIds.includes(userId) || node.approvedByUserIds.includes(userId) || !node.officeRule.allowTransfer || !await officeRoleEligible(tx, userId, node.officeRule as OfficeNodeRule, departmentsOf(row))) return fail('OFFICE_TRANSFER_FORBIDDEN', '当前节点不允许本人转交', 403)
    const past = await tx.select({ id: records.operatorUserId }).from(records).where(and(eq(records.requestId, id), inArray(records.action, ['同意', '退回', '拒绝', '转交'])))
    const excluded = new Set([row.applicantUserId, userId, ...past.map(p => p.id), ...chain.flatMap(n => n.approverUserIds)])
    const result = []
    for (const person of await tx.select({ id: users.id, name: users.name, role: users.role }).from(users).where(eq(users.status, '启用'))) {
      if (excluded.has(person.id) || !await officeRoleEligible(tx, person.id, node.officeRule as OfficeNodeRule, departmentsOf(row))) continue
      try { await officeProject(tx, person.id, row.projectId); await evidence(tx, row, person.id, false, true); result.push(person) }
      catch (error) { if (!['OFFICE_PROJECT_FORBIDDEN', 'OFFICE_FILE_FORBIDDEN'].includes((error as { code: string }).code)) throw error }
    }
    return result
  })
}

export async function getOfficeRevision(id: string, revision: number, userId: string) {
  return db.transaction(async tx => {
    await officeReadable(tx, id, userId)
    const [row] = await tx.select().from(revisions).where(and(eq(revisions.requestId, id), eq(revisions.revision, revision)))
    if (!row) return fail('OFFICE_REVISION_MISSING', '修订不存在', 404)
    const definition = officeDefinition.parse(row.snapshot.definition)
    for (const file of await officeSelectedFiles(tx, id, definition.attachmentIds)) if (!await officeFileGrant(tx, file, userId)) return fail('OFFICE_FILE_FORBIDDEN', '当前无权读取该修订附件', 403)
    return row
  })
}

export async function officeCommandReceipt(id: string, commandId: string, userId: string) {
  const [actor] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.status, '启用')))
  if (!actor) return fail('OFFICE_ACTOR_UNAVAILABLE', '当前账号不可用', 403)
  const [row] = await db.select({ id: events.requestId, version: events.version }).from(events).where(and(eq(events.requestId, id), eq(events.commandId, commandId), eq(events.actorId, userId)))
  // Absence is not proof a delayed write cannot commit; the client must keep
  // the original command key and must not issue a replacement operation.
  return row ? { found: true, receipt: row } : { found: false, retrySameCommandOnly: true }
}

export async function resolveOfficeCommand(id: string, userId: string, raw: unknown) {
  const { clientRequestId } = officeResolveCommand.parse(raw)
  return db.transaction(async tx => {
    const { command, actor } = await lockCommand(tx, id, userId, clientRequestId)
    const [committed] = await tx.select({ id: events.requestId, version: events.version }).from(events)
      .where(and(eq(events.commandId, clientRequestId), eq(events.actorId, userId)))
    if (committed && committed.id !== id) return fail('OFFICE_COMMAND_REUSED', '请求标识已用于其他操作')
    if (committed) return { state: 'committed' as const, receipt: committed }
    if (!command.closedAt) {
      await tx.update(commands).set({ closedAt: new Date() }).where(eq(commands.id, command.id))
      await createMySqlIdentityRepositoryContext(tx).audits.append({ userId, userName: actor.name, module: '通用OA', action: '核对未提交并封闭请求', target: `${id} / ${clientRequestId}` })
    }
    // Own-key fence only: no other actor's command is changed, no fabricated
    // draft, project, business version or event. A lost resolution is repeatable.
    return { state: 'not_applied' as const }
  }, { isolationLevel: 'read committed' })
}

async function officeExecutor(tx: OfficeTx, row: Request, userId: string) {
  const actor = await officeActor(tx, userId)
  if (row.status !== '已通过' || !row.completedAt) return { actor, policy: undefined, allowed: false }
  const policy = (await pinnedOfficePolicy(tx, row.officePolicyVersionId)).configuration.execution
  return { actor, policy, allowed: officeExecutionAuthorized(policy, userId, actor.businessRoleIds, actor.departmentIds, departmentsOf(row)) }
}
async function requireOfficeExecutor(tx: OfficeTx, row: Request, userId: string) {
  const result = await officeExecutor(tx, row, userId)
  if (!result.allowed || !result.policy) return fail('OFFICE_EXECUTION_FORBIDDEN', '尚未批准、执行规则未配置启用，或当前账号/岗位不具备明确执行记录授权', 403)
  await officeProject(tx, userId, row.projectId, true)
  return { ...result, policy: result.policy }
}
async function canManageOfficeAttachment(tx: OfficeTx, row: Request, file: typeof files.$inferSelect, userId: string) {
  let executionEligible = false
  if (file.purpose === 'execution' && file.uploadedBy === userId) {
    const executor = await officeExecutor(tx, row, userId)
    const project = await officeProject(tx, userId, row.projectId)
    executionEligible = executor.allowed && (!project || project.lifecycle === 'active')
  }
  return officeAttachmentGrantAuthority({ purpose: file.purpose, uploadedBy: file.uploadedBy, applicantId: row.applicantUserId, userId, executionEligible })
}
async function executionEvidence(tx: OfficeTx, id: string, userId: string, integrity: boolean) {
  const bindings = await tx.select().from(executionFiles).where(eq(executionFiles.executionId, id))
  if (!bindings.length) return fail('OFFICE_EXECUTION_EVIDENCE_MISSING', '执行记录原件绑定缺失')
  for (const binding of bindings) {
    const [file] = await tx.select().from(files).where(eq(files.id, binding.fileId))
    if (!file || binding.version !== 1 || file.sha256 !== binding.sha256) return fail('OFFICE_EXECUTION_EVIDENCE_CHANGED', '执行原件版本或哈希不一致')
    if (!await officeFileGrant(tx, file, userId)) return fail('OFFICE_FILE_FORBIDDEN', '当前没有执行原件查看权限', 403)
    if (integrity) await verifyBytes(file)
  }
  return bindings.map(({ fileId, sha256, name }) => ({ fileId, version: 1 as const, sha256, name }))
}
export async function recordOfficeExecution(id: string, userId: string, raw: unknown) {
  const input = officeExecutionCommand.parse(raw), hash = policyHash({ id, userId, action: 'execution', input })
  return locked(id, userId, async (tx, row) => {
    expected(row, input.expectedVersion)
    const { policy, actor } = await requireOfficeExecutor(tx, row, userId)
    await evidence(tx, row, userId, true)
    const [previous] = await tx.select().from(executions).where(eq(executions.requestId, id)).orderBy(desc(executions.requestVersion)).limit(1)
    const issues = validateOfficeExecution(input, definitionOf(row).details.kind, policy, previous ?? null, row.completedAt!)
    if (issues.length) return fail('OFFICE_EXECUTION_INVALID', issues.join('；'), 409)
    if (previous) await executionEvidence(tx, previous.id, userId, true)
    const bound = []
    for (const ref of input.files) {
      const [file] = await tx.select().from(files).where(and(eq(files.id, ref.fileId), eq(files.requestId, id)))
      if (!file || !['execution', 'signed'].includes(file.purpose) || file.sha256 !== ref.sha256) return fail('OFFICE_EXECUTION_FILE_INVALID', '必须引用本申请真实执行原件的准确版本，送审材料不等于执行证据')
      if (!await officeFileGrant(tx, file, userId)) return fail('OFFICE_FILE_FORBIDDEN', '当前没有执行原件查看权限', 403)
      await verifyBytes(file)
      bound.push(file)
    }
    const executionId = randomUUID(), next = await update(tx, row, {})
    await tx.insert(executions).values({ id: executionId, requestId: id, requestVersion: next.lockVersion, officeRevision: row.officeRevision,
      policyVersionId: row.officePolicyVersionId!, action: input.action, outcome: input.outcome, supersedesId: previous?.id ?? null,
      actorId: userId, actorName: actor.actor.name, occurredAt: new Date(input.occurredAt), facts: input.facts, reason: input.reason })
    await tx.insert(executionFiles).values(bound.map(file => ({ executionId, fileId: file.id, version: 1, sha256: file.sha256, name: file.name })))
    // Approval remains approved with the same content/revision/completedAt.
    // This event is NOT a calendar, payment, signature or task-completion event.
    // Approval readers may lack execution-file permission. Keep event/audit
    // summaries free of receipt facts and reasons; those live behind file ACL.
    return event(tx, next, userId, input.clientRequestId, hash, `execution-${input.action}`, `人工执行记录 ${executionId}；详情及原件须单独授权核对`)
  }, undefined, tx => beginCommand(tx, id, userId, input.clientRequestId, hash))
}
export async function getOfficeExecutions(id: string, userId: string, page = 1): Promise<OfficeExecutionView> {
  return db.transaction(async tx => {
    const row = await officeReadable(tx, id, userId), authority = await officeExecutor(tx, row, userId)
    const [latest] = await tx.select().from(executions).where(eq(executions.requestId, id)).orderBy(desc(executions.requestVersion)).limit(1)
    const rows = await tx.select().from(executions).where(eq(executions.requestId, id)).orderBy(desc(executions.requestVersion)).limit(51).offset((page - 1) * 50)
    const records: OfficeExecutionView['records'] = []
    let hiddenRecords = 0, latestReadable = !latest
    if (latest) { try { await executionEvidence(tx, latest.id, userId, true); latestReadable = true } catch (error) { if ((error as { status?: number }).status !== 403) throw error } }
    for (const record of rows.slice(0, 50)) {
      try {
        const bound = await executionEvidence(tx, record.id, userId, true)
        records.push({ id: record.id, action: record.action as OfficeExecutionView['records'][number]['action'], outcome: record.outcome as 'succeeded' | 'failed',
          occurredAt: record.occurredAt.toISOString(), recordedAt: record.recordedAt.toISOString(), actorName: record.actorName,
          supersedesId: record.supersedesId, facts: record.facts, reason: record.reason, files: bound })
      } catch (error) { if ((error as { status?: number }).status === 403) hiddenRecords++; else throw error }
    }
    const active = !row.projectId || (await officeProject(tx, userId, row.projectId))?.lifecycle === 'active'
    return { canRecord: authority.allowed && latestReadable && active, blockedReason: !active ? '关联项目已关闭或归档' : !latestReadable ? '最新执行原件无查看权限，不能盲目更正' : authority.allowed ? '' : '执行规则未明确启用或当前账号/岗位未获指定；批准不等于执行完成',
      latestId: latest?.id ?? null, fields: officeExecutionFields[definitionOf(row).details.kind], requiredFields: authority.policy?.requiredFields ?? [], records, hiddenRecords, hasMore: rows.length > 50 }
  }, { isolationLevel: 'read committed' })
}
