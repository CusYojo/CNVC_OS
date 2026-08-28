import { createHash, randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, ne, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.js'
import { committeeAgendas as agendas, committeeCommands as commands, committeeFiles as files, committeeMeetings as heads, committeeYears as years, meetingParticipants, meetings, meetingWorkflowEvents as events, meetingWorkflowNotices as notices, oaApprovalRequests as approvals, projectFiles, projectFileVersions, projects, users } from '../db/schema.js'
import { committeeCanAppendDecision, committeeCommand, committeeDefinition, committeeEditorAccessQuery, committeeHistoryQuery, committeeOptionsQuery, committeePageWindow, committeeQuery, committeeReceipt, committeeRecovery, committeeSearchPattern, type CommitteeDefinition, type CommitteeReceipt } from '../contracts/fdeCommitteeContract.js'
import { committeeAgendaAccess, committeeMeetingAccess, committeeProjectScope } from './fdeCommitteeAccessService.js'
import { projectFileAccessCondition, requireProjectFileAccess } from './projectFileAccessService.js'
import { readProjectFileBuffer } from './projectFileStorageService.js'
import { lockSchedulePeople, requireMeetingSlot } from './fdeScheduleService.js'
import { scheduleTransaction } from './fdeScheduleTransactionService.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { legacyApprovalAccessCondition } from './oaRequestAccessService.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'select'>
type Agenda = typeof agendas.$inferSelect
type FileKind = typeof files.$inferSelect.kind
const fail = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }) }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const instant = (value: string) => new Date(`${value}:00+08:00`)
const clock = (value: Date) => new Date(value.getTime() + 8 * 3600000).toISOString().slice(0, 16)
const unique = (ids: string[]) => [...new Set(ids)].sort()

async function actor(reader: Reader, uid: string) {
  const [row] = await reader.select().from(users).where(and(eq(users.id, uid), eq(users.status, '启用')))
  if (!row) return fail('COMMITTEE_ACTOR_FORBIDDEN', '当前账号不可用', 403)
  return row
}
async function project(reader: Reader, id: string, uid: string, manage: boolean, active = true) {
  const [row] = await reader.select().from(projects).where(and(eq(projects.id, id), committeeProjectScope(uid, manage)))
  if (!row) return fail('COMMITTEE_PROJECT_FORBIDDEN', '当前账号无权办理该投资项目议题', 403)
  if (active && row.lifecycle !== 'active') return fail('COMMITTEE_PROJECT_INACTIVE', '关闭或归档项目不能继续排期或覆盖纪要')
  return row
}
async function materialProof(tx: Tx, projectId: string, uid: string, ref: { fileId: string; version: number }) {
  const file = await requireProjectFileAccess(tx, ref.fileId, uid)
  if (file.projectId !== projectId) return fail('COMMITTEE_FILE_PROJECT', '原件必须属于当前议题项目')
  const [revision] = await tx.select().from(projectFileVersions).where(and(eq(projectFileVersions.fileId, file.id), eq(projectFileVersions.version, ref.version)))
  if (!revision?.sha256) return fail('COMMITTEE_FILE_VERSION', '原件版本或哈希缺失，请在项目文件中补齐')
  const bytes = await readProjectFileBuffer(revision.storagePath).catch(() => null)
  if (!bytes || bytes.byteLength !== revision.byteSize || createHash('sha256').update(bytes).digest('hex') !== revision.sha256) return fail('COMMITTEE_FILE_INTEGRITY', '原件内容与版本记录不一致，不能作为会议证据')
  return { fileId: file.id, fileVersionId: revision.id, version: revision.version, sha256: revision.sha256 }
}
async function pin(tx: Tx, agendaId: string, kind: FileKind, proof: Awaited<ReturnType<typeof materialProof>>) {
  await tx.insert(files).values({ agendaId, kind, ...proof }).onDuplicateKeyUpdate({ set: { active: true } })
}
async function activeAgendas(reader: Reader, meetingId: string) {
  return reader.select().from(agendas).where(and(eq(agendas.meetingId, meetingId), eq(agendas.active, true))).orderBy(asc(agendas.position), asc(agendas.id))
}
async function definitionFrom(reader: Reader, meeting: typeof meetings.$inferSelect, head: typeof heads.$inferSelect): Promise<CommitteeDefinition> {
  const rows = await activeAgendas(reader, meeting.id)
  const refs = rows.length ? await reader.select().from(files).where(and(inArray(files.agendaId, rows.map(r => r.id)), eq(files.active, true), eq(files.kind, 'material'))).orderBy(asc(files.agendaId), asc(files.fileId), asc(files.version)) : []
  return committeeDefinition.parse({ title: meeting.title, hostUserId: meeting.hostUserId, startsAt: clock(meeting.startedAt), endsAt: meeting.endsAt && clock(meeting.endsAt), ruleNote: head.ruleNote,
    materialCheckAt: head.materialCheckAt && clock(head.materialCheckAt), agendas: rows.map(r => ({ id: r.id, projectId: r.projectId, title: r.title, participantIds: r.participantIds,
      materials: refs.filter(f => f.agendaId === r.id).map(f => ({ fileId: f.fileId, version: f.version })) })) })
}
async function validateDefinition(tx: Tx, uid: string, definition: CommitteeDefinition, requireMaterials = false) {
  const proofs = new Map<string, Awaited<ReturnType<typeof materialProof>>[]>()
  for (const agenda of definition.agendas) {
    await project(tx, agenda.projectId, uid, true)
    if (requireMaterials && !agenda.materials.length) return fail('COMMITTEE_MATERIALS_REQUIRED', '每个议题需至少一份明确版本的会前材料')
    for (const participantId of agenda.participantIds) await project(tx, agenda.projectId, participantId, false)
    const pinned = []
    for (const ref of agenda.materials) {
      pinned.push(await materialProof(tx, agenda.projectId, uid, ref))
      for (const participantId of agenda.participantIds) await requireProjectFileAccess(tx, ref.fileId, participantId)
    }
    proofs.set(agenda.id, pinned)
  }
  return proofs
}
async function saveDefinition(tx: Tx, meetingId: string, uid: string, definition: CommitteeDefinition, create: boolean) {
  const proofs = await validateDefinition(tx, uid, definition)
  const peopleIds = unique(definition.agendas.flatMap(r => r.participantIds))
  const people = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, peopleIds))
  const names = new Map(people.map(r => [r.id, r.name]))
  const common = { title: definition.title, host: names.get(definition.hostUserId)!, hostUserId: definition.hostUserId,
    attendees: peopleIds.map(id => names.get(id)!), startedAt: instant(definition.startsAt), endsAt: instant(definition.endsAt) }
  if (create) {
    await tx.insert(meetings).values({ id: meetingId, ...common, projectId: null, projectName: '投决会', type: '投决会', workflowKind: 'committee', workflowStatus: 'draft', createdBy: uid })
    await tx.insert(heads).values({ meetingId, ruleNote: definition.ruleNote, materialCheckAt: definition.materialCheckAt ? instant(definition.materialCheckAt) : null })
  } else {
    await tx.update(meetings).set(common).where(eq(meetings.id, meetingId))
    await tx.update(heads).set({ ruleNote: definition.ruleNote, materialCheckAt: definition.materialCheckAt ? instant(definition.materialCheckAt) : null, checkedAt: null, checkedBy: null, checkHash: null }).where(eq(heads.meetingId, meetingId))
    await tx.update(agendas).set({ active: false }).where(eq(agendas.meetingId, meetingId))
  }
  for (const [position, agenda] of definition.agendas.entries()) {
    const [prior] = await tx.select().from(agendas).where(eq(agendas.id, agenda.id))
    if (prior && (prior.meetingId !== meetingId || prior.projectId !== agenda.projectId)) return fail('COMMITTEE_AGENDA_REBOUND', '议题编号不能重绑其他会议或项目')
    if (prior) await tx.update(agendas).set({ position, title: agenda.title, participantIds: agenda.participantIds, active: true }).where(eq(agendas.id, agenda.id))
    else await tx.insert(agendas).values({ id: agenda.id, meetingId, projectId: agenda.projectId, position, title: agenda.title, participantIds: agenda.participantIds })
    await tx.update(files).set({ active: false }).where(and(eq(files.agendaId, agenda.id), eq(files.kind, 'material')))
    for (const proof of proofs.get(agenda.id)!) await pin(tx, agenda.id, 'material', proof)
  }
  await tx.delete(meetingParticipants).where(eq(meetingParticipants.meetingId, meetingId))
  await tx.insert(meetingParticipants).values(peopleIds.map(userId => ({ meetingId, userId, sourceName: names.get(userId)! })))
}
async function allocateNumber(tx: Tx, meetingId: string, startsAt: Date) {
  const year = Number(clock(startsAt).slice(0, 4))
  const [head] = await tx.select().from(heads).where(eq(heads.meetingId, meetingId))
  if (head.sequenceYear === year && head.sequenceNumber) return
  await tx.insert(years).values({ year }).onDuplicateKeyUpdate({ set: { year } })
  const [counter] = await tx.select().from(years).where(eq(years.year, year)).for('update')
  await tx.update(years).set({ nextSequence: counter.nextSequence + 1 }).where(eq(years.year, year))
  await tx.update(heads).set({ sequenceYear: year, sequenceNumber: counter.nextSequence }).where(eq(heads.meetingId, meetingId))
}
function formalDecisionCondition(projectId: string) {
  // Entering the IC stage is not the decision which permits payment.
  return and(eq(approvals.projectId, projectId), eq(approvals.businessType, 'project_stage'), eq(approvals.fromStage, '投决'), eq(approvals.targetStage, '打款'), eq(approvals.status, '已通过'), isNotNull(approvals.completedAt))!
}
async function formalDecision(tx: Tx, uid: string, projectId: string, approvalId: string) {
  const user = await actor(tx, uid)
  const [row] = await tx.select().from(approvals).where(and(eq(approvals.id, approvalId), formalDecisionCondition(projectId), legacyApprovalAccessCondition({ uid, name: user.name, role: user.role })))
  if (!row) return fail('COMMITTEE_APPROVAL_REQUIRED', '只能关联同项目已通过的“投决 → 打款”正式审批，不能以进入投决阶段代替投决通过')
  return row
}
async function recordAgenda(tx: Tx, uid: string, input: Extract<z.infer<typeof committeeCommand>, { action: 'record' }>, rows: Agenda[]) {
  const agenda = rows.find(r => r.id === input.agendaId)
  if (!agenda) return fail('COMMITTEE_AGENDA_NOT_FOUND', '当前议题不存在', 404)
  await project(tx, agenda.projectId, uid, true)
  const [readable] = await tx.select({ id: agendas.id }).from(agendas).where(and(eq(agendas.id, agenda.id), committeeAgendaAccess(uid)))
  if (!readable) return fail('COMMITTEE_AGENDA_FORBIDDEN', '当前议题来源权限已变化，不能覆盖纪要', 403)
  const minutes = await materialProof(tx, agenda.projectId, uid, input.minutesFile)
  const decision = input.resolutionFile ? await materialProof(tx, agenda.projectId, uid, input.resolutionFile) : null
  const request = input.approvalId ? await formalDecision(tx, uid, agenda.projectId, input.approvalId) : null
  const approvalProofs = []
  for (const ref of request?.materialSnapshot ?? []) {
    if (ref.fileId && ref.fileVersion) approvalProofs.push(await materialProof(tx, agenda.projectId, uid, { fileId: ref.fileId, version: ref.fileVersion }))
    else if (ref.fileId) return fail('COMMITTEE_APPROVAL_SOURCE', '正式审批材料缺少精确版本')
  }
  await tx.update(files).set({ active: false }).where(and(eq(files.agendaId, agenda.id), ne(files.kind, 'material')))
  await pin(tx, agenda.id, 'minutes', minutes)
  if (decision) await pin(tx, agenda.id, 'resolution', decision)
  for (const proof of approvalProofs) await pin(tx, agenda.id, 'approval', proof)
  await tx.update(agendas).set({ minutes: input.minutes, resolutionNote: input.resolutionNote, approvalId: input.approvalId, recordedBy: uid, recordedAt: new Date() }).where(eq(agendas.id, agenda.id))
}
async function checkRecorded(tx: Tx, uid: string, rows: Agenda[]) {
  for (const agenda of rows) {
    const refs = await tx.select().from(files).where(and(eq(files.agendaId, agenda.id), eq(files.active, true)))
    if (!agenda.recordedAt || !agenda.minutes?.trim() || !refs.some(r => r.kind === 'minutes')) return fail('COMMITTEE_MINUTES_REQUIRED', '请逐议题记录纪要并关联纪要原件')
    if (Boolean(agenda.approvalId) !== refs.some(r => r.kind === 'resolution')) return fail('COMMITTEE_DECISION_INTEGRITY', '正式决议与审批关联不完整')
    if (agenda.approvalId) await formalDecision(tx, uid, agenda.projectId, agenda.approvalId)
    for (const ref of refs) {
      const proof = await materialProof(tx, agenda.projectId, uid, ref)
      if (proof.fileVersionId !== ref.fileVersionId || proof.sha256 !== ref.sha256) return fail('COMMITTEE_FILE_INTEGRITY', '会议证据与冻结版本不一致')
    }
  }
}
async function appendDecision(tx: Tx, uid: string, input: Extract<z.infer<typeof committeeCommand>, { action: 'link_decision' }>, meeting: typeof meetings.$inferSelect, rows: Agenda[]) {
  const agenda = rows.find(row => row.id === input.agendaId)
  if (!agenda) return fail('COMMITTEE_AGENDA_NOT_FOUND', '当前议题不存在', 404)
  await project(tx, agenda.projectId, uid, true)
  const [readable] = await tx.select({ id: agendas.id }).from(agendas).where(and(eq(agendas.id, agenda.id), committeeAgendaAccess(uid)))
  if (!readable) return fail('COMMITTEE_AGENDA_FORBIDDEN', '当前议题来源权限已变化，不能追加关联', 403)
  if (!committeeCanAppendDecision({ status: meeting.workflowStatus, archived: false, recorded: Boolean(agenda.recordedAt), hasMinutes: Boolean(agenda.minutes?.trim()), linked: Boolean(agenda.approvalId) })) {
    return fail('COMMITTEE_DECISION_LINK_STATE', '仅已确认纪要且尚未关联正式审批的议题可追加；不能更换既有决议')
  }
  await checkRecorded(tx, uid, [agenda])
  const priorDecision = await tx.select({ id: files.id }).from(files).where(and(eq(files.agendaId, agenda.id), eq(files.active, true), inArray(files.kind, ['resolution', 'approval']))).limit(1)
  if (priorDecision.length) return fail('COMMITTEE_DECISION_LINK_STATE', '已有正式决议来源不能通过追加命令替换')
  const request = await formalDecision(tx, uid, agenda.projectId, input.approvalId)
  const proof = await materialProof(tx, agenda.projectId, uid, input.resolutionFile)
  const frozen = []
  for (const ref of request.materialSnapshot ?? []) {
    if (ref.fileId && ref.fileVersion) frozen.push(await materialProof(tx, agenda.projectId, uid, { fileId: ref.fileId, version: ref.fileVersion }))
    else if (ref.fileId) return fail('COMMITTEE_APPROVAL_SOURCE', '正式审批材料缺少精确版本')
  }
  // No update/deactivation of minutes, original references, recorder, confirmation,
  // project stage or approval facts. The enclosing event retains before/after.
  await pin(tx, agenda.id, 'resolution', proof)
  for (const source of frozen) await pin(tx, agenda.id, 'approval', source)
  await tx.update(agendas).set({ approvalId: request.id }).where(eq(agendas.id, agenda.id))
}
async function fence(tx: Tx, uid: string, commandId: string) {
  // Exact actor+command fencing also serializes recovery against a delayed POST.
  await tx.insert(commands).values({ actorId: uid, commandId }).onDuplicateKeyUpdate({ set: { commandId } })
  const [row] = await tx.select().from(commands).where(and(eq(commands.actorId, uid), eq(commands.commandId, commandId))).for('update')
  return row
}
async function audit(tx: Tx, uid: string, action: string, target: string) {
  const user = await actor(tx, uid)
  await createMySqlIdentityRepositoryContext(tx).audits.append({ userId: uid, userName: user.name, module: '投决会', action, target })
}

export async function executeCommittee(uid: string, raw: unknown) {
  const input = committeeCommand.parse(raw), hash = digest(input)
  return scheduleTransaction(async tx => {
    await actor(tx, uid)
    const meetingId = input.action === 'create' ? randomUUID() : input.meetingId
    const observed = input.action === 'create' ? [] : await activeAgendas(tx, meetingId)
    const projectIds = unique([...observed.map(r => r.projectId), ...('definition' in input ? input.definition.agendas.map(r => r.projectId) : [])])
    for (const id of projectIds) await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${id} FOR UPDATE`)
    const prior = await fence(tx, uid, input.commandId)
    if (prior.closedAt) return fail('COMMITTEE_COMMAND_CLOSED', '原请求已封闭，请读取最新状态后重新确认')
    if (prior.receipt) {
      if (prior.commandHash !== hash) return fail('COMMITTEE_COMMAND_REUSED', '请求编号已用于其他内容')
      return committeeReceipt.parse(prior.receipt)
    }
    const [meeting] = input.action === 'create' ? [] : await tx.select().from(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.workflowKind, 'committee'))).for('update')
    const [head] = meeting ? await tx.select().from(heads).where(eq(heads.meetingId, meetingId)) : []
    const rows = meeting ? await activeAgendas(tx, meetingId) : []
    if (input.action !== 'create') {
      if (!meeting || !head) return fail('COMMITTEE_NOT_FOUND', '投决会不存在或不可办理', 404)
      if (meeting.version !== input.expectedVersion || digest(rows.map(r => r.projectId)) !== digest(observed.map(r => r.projectId))) return fail('VERSION_CONFLICT', '投决会已变化，请刷新后重新核对')
      if (head.archivedAt) return fail('COMMITTEE_ARCHIVED', '归档会议不可改写')
    }
    const people = unique([uid, ...rows.flatMap(r => r.participantIds), ...('definition' in input ? input.definition.agendas.flatMap(r => r.participantIds) : [])])
    await lockSchedulePeople(tx, people)
    await actor(tx, uid)
    // Record authority is agenda-specific. All other commands affect the whole
    // meeting and require current management of every affected project.
    if (!['record', 'link_decision'].includes(input.action)) for (const id of projectIds) await project(tx, id, uid, true, !['cancel', 'archive'].includes(input.action))
    if (input.action === 'create' || input.action === 'save') {
      if (meeting && (!['draft', 'scheduled'].includes(meeting.workflowStatus) || rows.some(r => r.recordedAt))) return fail('COMMITTEE_IMMUTABLE', '已记录纪要、完成或取消的会议不能改排期及议题')
      await saveDefinition(tx, meetingId, uid, input.definition, input.action === 'create')
      if (meeting?.workflowStatus === 'scheduled') {
        await requireMeetingSlot(tx, meetingId, unique(input.definition.agendas.flatMap(r => r.participantIds)), instant(input.definition.startsAt), instant(input.definition.endsAt))
        await allocateNumber(tx, meetingId, instant(input.definition.startsAt))
      }
    } else if (input.action === 'record') {
      if (meeting!.workflowStatus !== 'scheduled' || !meeting!.endsAt || meeting!.endsAt.getTime() > Date.now()) return fail('COMMITTEE_NOT_ENDED', '仅已到结束时间的待召开会议可登记纪要；完成后不可覆盖')
      await recordAgenda(tx, uid, input, rows)
    } else if (input.action === 'link_decision') {
      await appendDecision(tx, uid, input, meeting!, rows)
    } else if (input.action === 'archive') {
      if (!['completed', 'cancelled'].includes(meeting!.workflowStatus)) return fail('COMMITTEE_ARCHIVE_STATE', '仅已确认纪要或已取消的会议可归档')
      await tx.update(heads).set({ archivedAt: new Date() }).where(eq(heads.meetingId, meetingId))
    } else if (input.action === 'cancel') {
      if (!['draft', 'scheduled'].includes(meeting!.workflowStatus)) return fail('COMMITTEE_CANCEL_STATE', '当前会议不能取消')
      await tx.update(meetings).set({ workflowStatus: 'cancelled' }).where(eq(meetings.id, meetingId))
    } else {
      const expected = input.action === 'schedule' ? ['draft'] : input.action === 'check_materials' ? ['draft', 'scheduled'] : ['scheduled']
      if (!expected.includes(meeting!.workflowStatus)) return fail('COMMITTEE_STATE', '当前会议状态不允许此操作')
      const definition = await definitionFrom(tx, meeting!, head!)
      const proofs = await validateDefinition(tx, uid, definition, input.action !== 'schedule')
      const checkHash = digest({ definition, proofs: [...proofs.entries()] })
      if (input.action === 'check_materials') await tx.update(heads).set({ checkedAt: new Date(), checkedBy: uid, checkHash }).where(eq(heads.meetingId, meetingId))
      else if (input.action === 'schedule') {
        await requireMeetingSlot(tx, meetingId, unique(rows.flatMap(r => r.participantIds)), meeting!.startedAt, meeting!.endsAt)
        await allocateNumber(tx, meetingId, meeting!.startedAt)
        await tx.update(meetings).set({ workflowStatus: 'scheduled' }).where(eq(meetings.id, meetingId))
      } else {
        if (!meeting!.endsAt || meeting!.endsAt.getTime() > Date.now()) return fail('COMMITTEE_NOT_ENDED', '尚未结束的会议不能确认完成')
        if (!head!.checkedAt || head!.checkHash !== checkHash) return fail('COMMITTEE_CHECK_REQUIRED', '会前材料或安排已变化，请重新核对材料')
        await checkRecorded(tx, uid, rows)
        await tx.update(meetings).set({ workflowStatus: 'completed', confirmedBy: uid, confirmedAt: new Date() }).where(eq(meetings.id, meetingId))
      }
    }
    const version = (meeting?.version ?? 0) + 1
    if (meeting) await tx.update(meetings).set({ version }).where(eq(meetings.id, meetingId))
    const [after] = await tx.select().from(meetings).where(eq(meetings.id, meetingId))
    const [afterHead] = await tx.select().from(heads).where(eq(heads.meetingId, meetingId))
    const afterAgendas = await activeAgendas(tx, meetingId)
    if (['save', 'schedule', 'complete', 'cancel', 'archive'].includes(input.action)) {
      await tx.update(notices).set({ closedAt: new Date() }).where(and(eq(notices.meetingId, meetingId), isNull(notices.closedAt)))
      if (['scheduled', 'completed'].includes(after.workflowStatus) && !afterHead.archivedAt) {
        const recipients = unique(afterAgendas.flatMap(r => r.participantIds))
        if (recipients.length) await tx.insert(notices).values(recipients.map(recipientId => ({ meetingId, recipientId, kind: input.action, version })))
      }
    }
    const receipt = committeeReceipt.parse({ commandId: input.commandId, meetingId, version, action: input.action })
    await tx.insert(events).values({ meetingId, requestId: randomUUID(), requestHash: hash, actorId: uid, action: input.action, version, reason: input.reason,
      snapshot: { commandId: input.commandId, before: meeting ?? null, beforeHead: head ?? null, beforeAgendas: rows, after, head: afterHead, agendas: afterAgendas }, result: { meetingId } })
    await tx.update(commands).set({ commandHash: hash, receipt }).where(eq(commands.id, prior.id))
    await audit(tx, uid, input.action, JSON.stringify(receipt))
    return receipt
  }, { isolationLevel: 'read committed' })
}

export async function recoverCommittee(uid: string, raw: unknown) {
  const { commandId } = committeeRecovery.parse(raw)
  return scheduleTransaction(async tx => {
    await actor(tx, uid)
    const prior = await fence(tx, uid, commandId)
    if (prior.receipt) return { state: 'committed' as const, receipt: committeeReceipt.parse(prior.receipt) }
    if (!prior.closedAt) {
      await tx.update(commands).set({ commandHash: null, receipt: null, closedAt: new Date() }).where(eq(commands.id, prior.id))
      await audit(tx, uid, '封闭未提交请求', JSON.stringify({ commandId, receiptOnly: true }))
    }
    return { state: 'not_committed' as const, receipt: null }
  }, { isolationLevel: 'read committed' })
}

export async function listCommittee(uid: string, raw: unknown = {}) {
  const query = committeeQuery.parse(raw)
  return db.transaction(async tx => {
    await actor(tx, uid)
    const where = and(committeeMeetingAccess(uid), query.view === 'active' ? isNull(heads.archivedAt) : query.view === 'archived' ? isNotNull(heads.archivedAt) : undefined,
      query.q ? like(meetings.title, `%${query.q.replace(/[\\%_]/g, '\\$&')}%`) : undefined,
      query.date ? sql`DATE(DATE_ADD(${meetings.startedAt}, INTERVAL 8 HOUR))=${query.date}` : undefined)
    const [count] = await tx.select({ n: sql<number>`COUNT(*)` }).from(meetings).innerJoin(heads, eq(heads.meetingId, meetings.id)).where(where)
    const rows = await tx.select({ id: meetings.id, title: meetings.title, status: meetings.workflowStatus, startsAt: meetings.startedAt, endsAt: meetings.endsAt, version: meetings.version,
      sequenceYear: heads.sequenceYear, sequenceNumber: heads.sequenceNumber, archivedAt: heads.archivedAt, checkedAt: heads.checkedAt }).from(meetings).innerJoin(heads, eq(heads.meetingId, meetings.id)).where(where).orderBy(desc(meetings.startedAt), desc(meetings.id)).limit(query.pageSize).offset((query.page - 1) * query.pageSize)
    const [managed] = await tx.select({ id: projects.id }).from(projects).where(and(committeeProjectScope(uid, true), eq(projects.lifecycle, 'active'))).limit(1)
    return { ...query, total: Number(count.n), rows, canCreate: Boolean(managed) }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function getCommittee(uid: string, meetingId: string) {
  z.string().uuid().parse(meetingId)
  return db.transaction(async tx => {
    await actor(tx, uid)
    const [meeting] = await tx.select().from(meetings).where(and(eq(meetings.id, meetingId), committeeMeetingAccess(uid)))
    if (!meeting) return fail('COMMITTEE_NOT_FOUND', '投决会不存在或当前账号无可见议题', 404)
    const [head] = await tx.select().from(heads).where(eq(heads.meetingId, meetingId))
    const all = await activeAgendas(tx, meetingId)
    const visible = await tx.select().from(agendas).where(and(eq(agendas.meetingId, meetingId), committeeAgendaAccess(uid))).orderBy(asc(agendas.position), asc(agendas.id))
    const managed = new Set((await tx.select({ id: projects.id }).from(projects).where(committeeProjectScope(uid, true))).map(r => r.id))
    const active = new Set((await tx.select({ id: projects.id }).from(projects).where(and(committeeProjectScope(uid, true), eq(projects.lifecycle, 'active')))).map(r => r.id))
    const manageAll = all.every(r => managed.has(r.projectId)), activeAll = all.every(r => active.has(r.projectId)), completeView = visible.length === all.length
    const peopleIds = unique(visible.flatMap(r => r.participantIds))
    const people = peopleIds.length ? await tx.select({ id: users.id, name: users.name, status: users.status }).from(users).where(inArray(users.id, peopleIds)) : []
    const sources = visible.length ? await tx.select({ id: files.id, agendaId: files.agendaId, fileId: files.fileId, version: files.version, sha256: files.sha256, kind: files.kind, name: projectFiles.name })
      .from(files).innerJoin(projectFiles, eq(files.fileId, projectFiles.id)).where(and(inArray(files.agendaId, visible.map(r => r.id)), eq(files.active, true), projectFileAccessCondition(uid))) : []
    const canReadHistory = await readableHistory(tx, uid, meetingId)
    const history = canReadHistory ? await historyPage(tx, meetingId, committeeHistoryQuery.parse({})) : null
    const notifications = await tx.select({ id: notices.id, kind: notices.kind, readAt: notices.readAt, version: notices.version }).from(notices).where(and(eq(notices.meetingId, meetingId), eq(notices.recipientId, uid), isNull(notices.closedAt)))
    const mutable = !head.archivedAt && ['draft', 'scheduled'].includes(meeting.workflowStatus)
    return { id: meeting.id, title: meeting.title, version: meeting.version, status: meeting.workflowStatus, hostUserId: meeting.hostUserId, hostName: meeting.host,
      startsAt: meeting.startedAt, endsAt: meeting.endsAt, ...head, people, agendas: visible.map(row => ({ ...row, canRecord: mutable && meeting.workflowStatus === 'scheduled' && active.has(row.projectId),
        canLinkDecision: active.has(row.projectId) && committeeCanAppendDecision({ status: meeting.workflowStatus, archived: Boolean(head.archivedAt), recorded: Boolean(row.recordedAt), hasMinutes: Boolean(row.minutes?.trim()), linked: Boolean(row.approvalId) }), files: sources.filter(f => f.agendaId === row.id) })),
      partial: !completeView, canReadHistory, history: history?.rows ?? [], historyHasMore: history?.hasMore ?? false, notices: notifications,
      capabilities: { save: mutable && manageAll && activeAll && completeView && !all.some(r => r.recordedAt), schedule: mutable && meeting.workflowStatus === 'draft' && manageAll && activeAll && completeView,
        check: mutable && manageAll && activeAll && completeView, complete: mutable && meeting.workflowStatus === 'scheduled' && manageAll && activeAll && completeView,
        cancel: mutable && manageAll, archive: !head.archivedAt && ['completed', 'cancelled'].includes(meeting.workflowStatus) && manageAll } }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

async function readableHistory(reader: Reader, uid: string, meetingId: string) {
  const managed = reader.select({ id: projects.id }).from(projects).where(committeeProjectScope(uid, true))
  const all = await reader.select({ id: agendas.id }).from(agendas).where(eq(agendas.meetingId, meetingId))
  const readable = await reader.select({ id: agendas.id }).from(agendas).where(and(eq(agendas.meetingId, meetingId), committeeAgendaAccess(uid, true), inArray(agendas.projectId, managed)))
  return all.length > 0 && all.length === readable.length
}
const containsLiteral = committeeSearchPattern
async function historyPage(tx: Tx, meetingId: string, query: z.infer<typeof committeeHistoryQuery>) {
  const where = and(eq(events.meetingId, meetingId), query.q ? like(events.reason, containsLiteral(query.q)) : undefined)
  const [count] = await tx.select({ n: sql<number>`COUNT(*)` }).from(events).where(where)
  const { offset, ...page } = committeePageWindow(Number(count.n), query.page, query.pageSize)
  const rows = await tx.select({ id: events.id, action: events.action, version: events.version, reason: events.reason, createdAt: events.createdAt })
    .from(events).where(where).orderBy(desc(events.version), desc(events.id)).limit(page.pageSize).offset(offset)
  return { ...page, rows }
}
export async function committeeHistory(uid: string, meetingId: string, raw: unknown = {}) {
  z.string().uuid().parse(meetingId)
  const query = committeeHistoryQuery.parse(raw)
  return db.transaction(async tx => {
    await actor(tx, uid)
    const [visible] = await tx.select({ id: meetings.id }).from(meetings).where(and(eq(meetings.id, meetingId), committeeMeetingAccess(uid)))
    if (!visible || !await readableHistory(tx, uid, meetingId)) return fail('COMMITTEE_HISTORY_FORBIDDEN', '当前账号无完整历史来源权限', 403)
    // Authorization is completed before either count or page query; never
    // paginate globally and redact after counting.
    return historyPage(tx, meetingId, query)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function committeeOptions(uid: string, raw: unknown = {}) {
  const query = committeeOptionsQuery.parse(raw)
  return db.transaction(async tx => {
    const user = await actor(tx, uid)
    if (!query.projectId) {
      const where = and(committeeProjectScope(uid, true), eq(projects.lifecycle, 'active'), query.q ? like(projects.name, containsLiteral(query.q)) : undefined)
      const [count] = await tx.select({ n: sql<number>`COUNT(*)` }).from(projects).where(where)
      const { offset, ...page } = committeePageWindow(Number(count.n), query.page, query.pageSize)
      const rows = await tx.select({ id: projects.id, name: projects.name }).from(projects).where(where).orderBy(asc(projects.name), asc(projects.id)).limit(page.pageSize).offset(offset)
      return { projects: rows, ...page }
    }
    await project(tx, query.projectId, uid, true)
    const result = { projectId: query.projectId, people: [] as Array<{ id: string; name: string }>, files: [] as Array<{ fileId: string; name: string; version: number; sha256: string | null }>, approvals: [] as Array<{ id: string; title: string; requestNo: string }>,
      pagination: {} as Partial<Record<'people' | 'files' | 'approvals', Omit<ReturnType<typeof committeePageWindow>, 'offset'>>> }
    if (query.kind === 'all' || query.kind === 'people') {
      const where = and(eq(users.status, '启用'), query.q ? like(users.name, containsLiteral(query.q)) : undefined,
        sql`EXISTS (${tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, query.projectId), committeeProjectScope(users.id.getSQL())))})`)
      const [count] = await tx.select({ n: sql<number>`COUNT(*)` }).from(users).where(where)
      const { offset, ...page } = committeePageWindow(Number(count.n), query.page, query.pageSize)
      result.people = await tx.select({ id: users.id, name: users.name }).from(users).where(where).orderBy(asc(users.name), asc(users.id)).limit(page.pageSize).offset(offset)
      result.pagination.people = page
    }
    if (query.kind === 'all' || query.kind === 'files') {
      const where = and(eq(projectFiles.projectId, query.projectId), projectFileAccessCondition(uid), isNotNull(projectFileVersions.sha256), query.q ? like(projectFiles.name, containsLiteral(query.q)) : undefined)
      const [count] = await tx.select({ n: sql<number>`COUNT(*)` }).from(projectFiles).innerJoin(projectFileVersions, eq(projectFileVersions.fileId, projectFiles.id)).where(where)
      const { offset, ...page } = committeePageWindow(Number(count.n), query.page, query.pageSize)
      result.files = await tx.select({ fileId: projectFiles.id, name: projectFiles.name, version: projectFileVersions.version, sha256: projectFileVersions.sha256 }).from(projectFiles)
        .innerJoin(projectFileVersions, eq(projectFileVersions.fileId, projectFiles.id)).where(where).orderBy(asc(projectFiles.name), asc(projectFiles.id), desc(projectFileVersions.version)).limit(page.pageSize).offset(offset)
      result.pagination.files = page
    }
    if (query.kind === 'all' || query.kind === 'approvals') {
      const where = and(formalDecisionCondition(query.projectId), legacyApprovalAccessCondition({ uid, name: user.name, role: user.role }),
        query.q ? or(like(approvals.title, containsLiteral(query.q)), like(approvals.requestNo, containsLiteral(query.q))) : undefined)
      const [count] = await tx.select({ n: sql<number>`COUNT(*)` }).from(approvals).where(where)
      const { offset, ...page } = committeePageWindow(Number(count.n), query.page, query.pageSize)
      result.approvals = await tx.select({ id: approvals.id, title: approvals.title, requestNo: approvals.requestNo }).from(approvals).where(where).orderBy(desc(approvals.completedAt), desc(approvals.id)).limit(page.pageSize).offset(offset)
      result.pagination.approvals = page
    }
    return result
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function checkCommitteeEditorAccess(uid: string, raw: unknown) {
  const input = committeeEditorAccessQuery.parse(raw)
  return db.transaction(async tx => {
    await actor(tx, uid)
    let version: number | null = null, writable = true
    const projectIds = new Set(input.projectIds)
    if (input.meetingId) {
      const [meeting] = await tx.select().from(meetings).where(and(eq(meetings.id, input.meetingId), committeeMeetingAccess(uid)))
      if (!meeting) return fail('COMMITTEE_EDITOR_FORBIDDEN', '会议权限已变化，请关闭旧表单', 403)
      version = meeting.version
      const selected = await activeAgendas(tx, meeting.id)
      const scoped = input.agendaId ? selected.filter(row => row.id === input.agendaId) : selected
      if (!scoped.length) return fail('COMMITTEE_EDITOR_FORBIDDEN', '原议题已不可读，请关闭旧表单', 403)
      for (const row of scoped) {
        const [readable] = await tx.select({ id: agendas.id }).from(agendas).where(and(eq(agendas.id, row.id), committeeAgendaAccess(uid)))
        if (!readable) return fail('COMMITTEE_EDITOR_FORBIDDEN', '原议题来源权限已变化', 403)
        projectIds.add(row.projectId)
      }
      const [head] = await tx.select().from(heads).where(eq(heads.meetingId, meeting.id))
      const states: Record<string, string[]> = { save: ['draft', 'scheduled'], record: ['scheduled'], link_decision: ['completed'], schedule: ['draft'], check_materials: ['draft', 'scheduled'], complete: ['scheduled'], cancel: ['draft', 'scheduled'], archive: ['completed', 'cancelled'] }
      writable = !head.archivedAt && Boolean(states[input.action]?.includes(meeting.workflowStatus))
      if (input.action === 'save' && selected.some(row => row.recordedAt)) writable = false
      if (input.action === 'link_decision' && !committeeCanAppendDecision({ status: meeting.workflowStatus, archived: Boolean(head.archivedAt), recorded: Boolean(scoped[0].recordedAt), hasMinutes: Boolean(scoped[0].minutes?.trim()), linked: Boolean(scoped[0].approvalId) })) writable = false
    } else {
      const [available] = await tx.select({ id: projects.id }).from(projects).where(and(committeeProjectScope(uid, true), eq(projects.lifecycle, 'active'))).limit(1)
      if (!available) return fail('COMMITTEE_EDITOR_FORBIDDEN', '当前账号已无会议编制权限', 403)
    }
    for (const id of projectIds) {
      const row = await project(tx, id, uid, true, false)
      if (row.lifecycle !== 'active') writable = false
    }
    for (const ref of input.files) {
      if (!projectIds.has(ref.projectId)) return fail('COMMITTEE_EDITOR_SCOPE', '原件不属于编辑中的项目', 403)
      const file = await requireProjectFileAccess(tx, ref.fileId, uid)
      const [revision] = await tx.select({ id: projectFileVersions.id }).from(projectFileVersions).where(and(eq(projectFileVersions.fileId, ref.fileId), eq(projectFileVersions.version, ref.version)))
      if (file.projectId !== ref.projectId || !revision) return fail('COMMITTEE_EDITOR_FORBIDDEN', '选中原件的当前权限或版本已失效', 403)
    }
    for (const ref of input.participants) {
      if (!projectIds.has(ref.projectId)) return fail('COMMITTEE_EDITOR_SCOPE', '参会账号不属于编辑中的项目', 403)
      await actor(tx, ref.userId)
      await project(tx, ref.projectId, ref.userId, false, false)
    }
    // This endpoint performs SELECTs only: no read receipt, audit, command fence,
    // implicit grants, file bytes or state advancement on focus.
    return { allowed: true as const, version, writable }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function readCommitteeNotice(uid: string, meetingId: string, noticeId: string) {
  z.string().uuid().parse(meetingId); z.string().uuid().parse(noticeId)
  return db.transaction(async tx => {
    await actor(tx, uid)
    const [row] = await tx.select({ id: notices.id }).from(notices).innerJoin(meetings, eq(meetings.id, notices.meetingId)).where(and(eq(notices.id, noticeId), eq(notices.meetingId, meetingId), eq(notices.recipientId, uid), isNull(notices.closedAt), committeeMeetingAccess(uid)))
    if (!row) return fail('COMMITTEE_NOTICE_NOT_FOUND', '通知不存在或当前权限不可读', 404)
    await tx.update(notices).set({ readAt: new Date() }).where(and(eq(notices.id, row.id), isNull(notices.readAt)))
    return { ok: true }
  })
}

export async function previewCommitteeFile(uid: string, raw: unknown) {
  const input = z.object({ meetingId: z.string().uuid(), agendaId: z.string().uuid(), fileId: z.string().uuid(), version: z.coerce.number().int().positive() }).strict().parse(raw)
  return db.transaction(async tx => {
    await actor(tx, uid)
    const [agenda] = await tx.select().from(agendas).where(and(eq(agendas.id, input.agendaId), eq(agendas.meetingId, input.meetingId), committeeAgendaAccess(uid)))
    if (!agenda) return fail('COMMITTEE_FILE_FORBIDDEN', '当前议题或原件不可读', 404)
    const [ref] = await tx.select().from(files).where(and(eq(files.agendaId, agenda.id), eq(files.fileId, input.fileId), eq(files.version, input.version), eq(files.active, true))).limit(1)
    if (!ref) return fail('COMMITTEE_FILE_FORBIDDEN', '原件版本不属于当前议题', 404)
    const file = await requireProjectFileAccess(tx, input.fileId, uid)
    const [revision] = await tx.select().from(projectFileVersions).where(and(eq(projectFileVersions.id, ref.fileVersionId), eq(projectFileVersions.fileId, file.id), eq(projectFileVersions.version, input.version)))
    if (!revision || file.projectId !== agenda.projectId || revision.sha256 !== ref.sha256) return fail('COMMITTEE_FILE_INTEGRITY', '原件版本与会议记录不一致')
    const bytes = await readProjectFileBuffer(revision.storagePath).catch(() => null)
    if (!bytes || bytes.length !== revision.byteSize || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) return fail('COMMITTEE_FILE_INTEGRITY', '原件字节校验未通过')
    await audit(tx, uid, '预览议题原件', JSON.stringify({ ...input, sha256: ref.sha256, bytes: bytes.length }))
    return { name: file.name, bytes, sha256: ref.sha256, version: ref.version }
  })
}
