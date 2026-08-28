import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.js'
import { projects, todos, users, roles, userRoles, projectDutyAssignments, projectFiles, projectFileVersions, todoFeedbacks, todoFeedbackEvidence, todoAcceptances, risks, responsibilityRecords as records, responsibilityEvidenceLinks as evidenceLinks, responsibilityEventsLog as events, responsibilityCommands as commands, responsibilityNotices as notices, responsibilityTaskMarkers as markers, responsibilityPolicyVersions as policies } from '../db/schema.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { responsibilityCommand, responsibilityQuery, responsibilityReceipt, responsibilityDeadline, responsibilityReviewPoints, responsibilityCountedPoints, type ResponsibilityReceipt } from '../contracts/fdeResponsibilityContract.js'
import { responsibilityBusinessDate, responsibilityWorkingDaysBetween, responsibilityPolicySchema, type ResponsibilityEventCode } from '../contracts/fdeResponsibilityPolicyContract.js'
import { taskDeadlineKey, taskTerminal } from '../contracts/fdeTaskContract.js'
import { activeResponsibilityPolicy } from './fdeResponsibilityPolicyService.js'
import { policyHash } from './fdeWorkflowPolicyService.js'
import { projectAccessCondition } from './projectAccessService.js'
import { requireProjectFileAccess, projectFileAccessCondition } from './projectFileAccessService.js'
import { readProjectFileBuffer } from './projectFileStorageService.js'
import { canReadReferencedDirectiveTasks, directiveTaskAccessCondition } from './fdeDirectiveLinksService.js'
import { isFdeTaskManager } from './fdeTaskAccessService.js'
import type { ResponsibilityAssignmentState } from '../contracts/fdeResponsibilityViewContract.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type RecordRow = typeof records.$inferSelect
type Task = typeof todos.$inferSelect
type Project = typeof projects.$inferSelect
type Evidence = { fileId: string; fileVersionId: string; version: number; sha256: string; byteSize: number }
type ActivePolicy = NonNullable<Awaited<ReturnType<typeof activeResponsibilityPolicy>>>
const fail = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }) }
const managerCondition = (uid: string | SQL) => sql<boolean>`(${projects.ownerUserId}=${uid} OR EXISTS(SELECT 1 FROM ${userRoles} ru JOIN ${roles} rr ON rr.id=ru.role_id WHERE ru.user_id=${uid} AND rr.status='启用' AND rr.fde_category='institution_leader'))`

// Reuse the current project/task/file ACL for the assigned identity, not its
// historical name or mere presence. Correlation stays in SQL before count/page.
function reviewerEligibleCondition() {
  const uid = sql`${records.reviewerId}`
  return sql<boolean>`COALESCE((${records.reviewerId} IS NOT NULL AND ${records.reviewerId}<>${records.subjectId}
    AND ${projectAccessCondition({ uid, name: '', role: '' })} AND ${managerCondition(uid)} AND ${directiveTaskAccessCondition(uid)}
    AND NOT EXISTS (SELECT 1 FROM ${evidenceLinks} re JOIN ${projectFiles} ON ${projectFiles.id}=re.file_id
      WHERE re.record_id=${records.id} AND NOT (${projectFileAccessCondition(uid)}))), FALSE)`
}
function needsAssignmentCondition() {
  return sql<boolean>`(${records.status} IN ('pending_confirmation','appealing') AND NOT (${reviewerEligibleCondition()}))`
}
function assignmentStateCondition() {
  return sql<ResponsibilityAssignmentState>`CASE WHEN ${records.status} NOT IN ('pending_confirmation','appealing') THEN 'not_required'
    WHEN ${records.reviewerId} IS NULL THEN 'unassigned' WHEN ${reviewerEligibleCondition()} THEN 'assigned' ELSE 'invalid' END`
}
async function assignmentAccess(tx: Tx, uid: string) {
  const [project] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.workflowModel, 'fde-v1'), projectAccessCondition({ uid, name: '', role: '' }), managerCondition(uid))).limit(1)
  return Boolean(project)
}

async function actor(tx: Tx, uid: string, lock = false) {
  const identity = createMySqlIdentityRepositoryContext(tx)
  const value = lock ? await identity.users.lockById(uid) : await identity.users.findById(uid)
  if (!value || value.status !== '启用') return fail('RESP_ACTOR_FORBIDDEN', '当前账号不可用', 403)
  return value
}
async function context(tx: Tx, projectId: string, uid: string) {
  const user = await actor(tx, uid)
  const [project] = await tx.select().from(projects).where(and(eq(projects.id, projectId), projectAccessCondition({ uid, name: user.name, role: user.role })))
  if (!project || project.workflowModel !== 'fde-v1') return fail('RESP_PROJECT_FORBIDDEN', '无权处理此项目的责任记录', 403)
  return project
}
function accessCondition(uid: string) {
  return and(projectAccessCondition({ uid, name: '', role: '' }), directiveTaskAccessCondition(uid), or(eq(records.subjectId, uid), managerCondition(uid)),
    sql`NOT EXISTS (SELECT 1 FROM ${evidenceLinks} re JOIN ${projectFiles} ON ${projectFiles.id}=re.file_id WHERE re.record_id=${records.id} AND NOT (${projectFileAccessCondition(uid)}))`)
}
async function accessibleRecord(tx: Tx, id: string, uid: string) {
  const [row] = await tx.select({ record: records }).from(records).innerJoin(projects, eq(projects.id, records.projectId)).innerJoin(todos, eq(todos.id, records.taskId)).where(and(eq(records.id, id), accessCondition(uid))).limit(1)
  if (!row) return fail('RESP_RECORD_FORBIDDEN', '记录不存在或当前无权查看', 403)
  return row.record
}
async function recordPolicy(tx: Tx, record: RecordRow) {
  const [policy] = await tx.select().from(policies).where(eq(policies.id, record.policyVersionId))
  if (!policy || policy.status !== 'published' || policy.sha256 !== record.policySha256 || policyHash(policy.configuration) !== policy.sha256) return fail('RESP_POLICY_INTEGRITY', '责任记录所用规则版本校验失败')
  return responsibilityPolicySchema.parse(policy.configuration)
}
async function audit(tx: Tx, uid: string | null, action: string, target: Record<string, unknown>) {
  const identity = createMySqlIdentityRepositoryContext(tx), user = uid ? await identity.users.findById(uid) : null
  await identity.audits.append({ userId: uid, userName: uid === null ? '系统期限扫描' : user?.name ?? '未知用户', module: '管理参考', action, target: JSON.stringify(target) })
}
async function taskFor(tx: Tx, project: Project, taskId: string, uid: string) {
  const [task] = await tx.select().from(todos).where(and(eq(todos.id, taskId), eq(todos.projectId, project.id))).limit(1).for('update')
  if (!task || task.executionModel !== 'fde-v1' || task.approvalRequestId || task.type === '流程' || !task.ownerUserId || !task.dueDate) return fail('RESP_TASK_INVALID', '必须关联正式 FDE 执行任务')
  if (!await canReadReferencedDirectiveTasks(tx, [taskId], uid)) return fail('RESP_RECORD_FORBIDDEN', '当前无权处理此批示任务', 403)
  return task
}
async function checkedEvidence(tx: Tx, projectId: string, refs: Array<{ fileId: string; version: number }>, uid: string) {
  if (new Set(refs.map(ref => `${ref.fileId}:${ref.version}`)).size !== refs.length) return fail('RESP_EVIDENCE_DUPLICATE', '同一证据版本不能重复提交', 400)
  const result: Evidence[] = []
  for (const ref of refs) {
    const file = await requireProjectFileAccess(tx, ref.fileId, uid, 'view')
    const [version] = await tx.select().from(projectFileVersions).where(and(eq(projectFileVersions.fileId, file.id), eq(projectFileVersions.version, ref.version)))
    if (file.projectId !== projectId || !version?.sha256 || version.byteSize <= 0) return fail('RESP_EVIDENCE_INVALID', '证据必须是本项目已保存的文件版本')
    const bytes = await readProjectFileBuffer(version.storagePath).catch(() => null)
    if (!bytes || bytes.length !== version.byteSize || createHash('sha256').update(bytes).digest('hex') !== version.sha256) return fail('RESP_EVIDENCE_INVALID', '证据原件缺失或哈希不符')
    result.push({ fileId: file.id, fileVersionId: version.id, version: version.version, sha256: version.sha256, byteSize: version.byteSize })
  }
  return result
}
async function checkedFrozenEvidence(tx: Tx, projectId: string, refs: Evidence[], uid: string) {
  const checked = await checkedEvidence(tx, projectId, refs, uid)
  if (checked.some((item, index) => item.fileVersionId !== refs[index].fileVersionId || item.sha256 !== refs[index].sha256 || item.byteSize !== refs[index].byteSize)) return fail('RESP_EVIDENCE_CHANGED', '证据与责任记录冻结的原件快照不一致')
  return checked
}
async function addEvidence(tx: Tx, recordId: string, items: Evidence[]) {
  for (const item of items) await tx.insert(evidenceLinks).values({ recordId, ...item }).onDuplicateKeyUpdate({ set: { recordId } })
}
async function reviewerFor(tx: Tx, project: Project, taskId: string, subjectId: string, proof: Array<{ fileId: string }>) {
  const duties = await tx.select({ id: projectDutyAssignments.userId }).from(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, project.id), inArray(projectDutyAssignments.duty, ['president', 'chairman', 'concerned_leader']))).orderBy(asc(projectDutyAssignments.userId))
  const leaders = await tx.select({ id: userRoles.userId }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(eq(roles.fdeCategory, 'institution_leader'), eq(roles.status, '启用'))).orderBy(asc(userRoles.userId))
  for (const id of new Set([project.ownerUserId, ...duties.map(d => d.id), ...leaders.map(l => l.id)].filter((id): id is string => Boolean(id)))) {
    if (id === subjectId || !await isFdeTaskManager(tx, project, id) || !await canReadReferencedDirectiveTasks(tx, [taskId], id)) continue
    const fileIds = [...new Set(proof.map(item => item.fileId))]
    const visible = fileIds.length ? await tx.select({ id: projectFiles.id }).from(projectFiles).where(and(inArray(projectFiles.id, fileIds), projectFileAccessCondition(id))) : []
    if (visible.length === fileIds.length) return id
  }
  return null
}
async function recordEvent(tx: Tx, id: string, uid: string | null, action: string, reason: string, extra: Record<string, unknown> = {}) {
  const [record] = await tx.select().from(records).where(eq(records.id, id))
  await tx.insert(events).values({ recordId: id, actorId: uid, action, reason, version: record.version, snapshot: { record, ...extra } })
  await tx.update(notices).set({ closedAt: new Date() }).where(and(eq(notices.recordId, id), isNull(notices.closedAt)))
  const recipient = ['pending_confirmation', 'appealing'].includes(record.status) ? record.reviewerId : record.originalPoints < 0 ? record.subjectId : null
  if (recipient) await tx.insert(notices).values({ recordId: id, recipientId: recipient, kind: record.status, version: record.version })
  await audit(tx, uid, action, { recordId: id, projectId: record.projectId, version: record.version, eventCode: record.eventCode })
  return record
}

type Facts = Pick<RecordRow, 'subjectId' | 'sourceFeedbackId' | 'relatedFeedbackId' | 'sourceAcceptanceId' | 'sourceRiskId' | 'deadlineKey' | 'occurredAt' | 'factSnapshot'> & { key: string }
const emptySources = { sourceFeedbackId: null, relatedFeedbackId: null, sourceAcceptanceId: null, sourceRiskId: null }
async function createRecord(tx: Tx, project: Project, task: Task, uid: string | null, eventCode: ResponsibilityEventCode, facts: Facts, proof: Evidence[], policy: ActivePolicy, reason: string, scanCycleId: string | null = null) {
  if ((uid === null) !== (scanCycleId !== null) || uid === null && !['no_feedback', 'unjustified_delay'].includes(eventCode)) return fail('RESP_SYSTEM_SOURCE_INVALID', '系统来源必须绑定有效期限扫描批次')
  const rule = policy.configuration.rules.find(rule => rule.code === eventCode)
  if (!rule?.enabled || rule.points === null) return null
  const sourceKey = policyHash(facts.key)
  const [existing] = await tx.select().from(records).where(eq(records.sourceKey, sourceKey))
  if (existing) {
    // A risk can only bind to its original task. Returning an old record with
    // the new task's receipt would silently contradict the frozen source.
    if (existing.projectId !== project.id || existing.taskId !== task.id || existing.subjectId !== facts.subjectId) return fail('RESP_SOURCE_ALREADY_BOUND', '此来源已绑定原任务或责任主体，不能重新归属')
    return existing // Retain dedupe even after revocation or policy change.
  }
  const { key: _, ...snapshot } = facts
  const automatic = rule.mode === 'automatic'
  const [inserted] = await tx.insert(records).values({ projectId: project.id, taskId: task.id, ...snapshot, sourceKey, eventCode, policyVersionId: policy.id, activationEventId: policy.activationEventId, policySha256: policy.sha256, originalPoints: rule.points, effectivePoints: automatic ? rule.points : 0, status: automatic ? 'effective' : 'pending_confirmation', reviewerId: automatic ? null : await reviewerFor(tx, project, task.id, facts.subjectId, proof), createdBy: uid, creationOrigin: uid === null ? 'scanner' : 'user', scanCycleId, reason }).$returningId()
  await addEvidence(tx, inserted.id, proof)
  return recordEvent(tx, inserted.id, uid, uid === null ? 'scan_candidate' : automatic ? 'automatic_fact' : 'propose', reason, scanCycleId ? { scanCycleId, automaticDecision: false } : {})
}

// Called from the existing task transaction after the authoritative source row
// is inserted. No client-submitted score, fake task completion or async UI write.
export async function captureTaskResponsibility(tx: Tx, taskId: string, uid: string, kind: 'feedback' | 'acceptance', sourceId: string) {
  const [task] = await tx.select().from(todos).where(eq(todos.id, taskId))
  if (!task?.projectId || !task.ownerUserId || !task.dueDate || task.executionModel !== 'fde-v1') return
  const [project] = await tx.select().from(projects).where(eq(projects.id, task.projectId))
  const [acceptance] = kind === 'acceptance' ? await tx.select().from(todoAcceptances).where(and(eq(todoAcceptances.id, sourceId), eq(todoAcceptances.todoId, taskId))) : []
  if (kind === 'acceptance' && acceptance?.decision !== 'accept') return
  const [feedback] = await tx.select().from(todoFeedbacks).where(and(eq(todoFeedbacks.id, kind === 'acceptance' ? acceptance!.feedbackId : sourceId), eq(todoFeedbacks.todoId, taskId)))
  if (!feedback || feedback.submittedAt > responsibilityDeadline(task.dueDate, task.dueTime)) return
  if (kind === 'feedback' && (feedback.kind !== 'progress' || !feedback.result.trim() || !feedback.estimatedDate)) return
  const occurredAt = acceptance?.decidedAt ?? feedback.submittedAt
  const policy = await activeResponsibilityPolicy(tx, occurredAt)
  if (!policy) return
  const refs = await tx.select().from(todoFeedbackEvidence).where(eq(todoFeedbackEvidence.feedbackId, feedback.id))
  if (!refs.length) return
  const proof = await checkedFrozenEvidence(tx, project.id, refs, uid)
  let eventCode: ResponsibilityEventCode = kind === 'feedback' ? 'feedback' : 'on_time'
  if (kind === 'acceptance' && policy.configuration.rules.find(rule => rule.code === 'early_critical')?.enabled && policy.configuration.earlyWorkingDays !== null) {
    const [marker] = await tx.select().from(markers).where(and(eq(markers.taskId, taskId), lte(markers.createdAt, feedback.submittedAt))).orderBy(desc(markers.version)).limit(1)
    if (marker?.critical && responsibilityWorkingDaysBetween(responsibilityBusinessDate(feedback.submittedAt), task.dueDate, policy.configuration.calendar) >= policy.configuration.earlyWorkingDays) eventCode = 'early_critical'
  }
  await createRecord(tx, project, task, uid, eventCode, { ...emptySources, subjectId: feedback.submittedBy, sourceFeedbackId: feedback.id, sourceAcceptanceId: acceptance?.id ?? null, deadlineKey: taskDeadlineKey(task.dueDate, task.dueTime), occurredAt, key: kind === 'acceptance' ? `completion:${taskId}` : `feedback:${taskId}:${feedback.submittedBy}:${responsibilityBusinessDate(feedback.submittedAt)}`, factSnapshot: { taskVersion: task.version, feedbackId: feedback.id, submittedAt: feedback.submittedAt.toISOString(), acceptanceId: acceptance?.id ?? null, acceptedAt: acceptance?.decidedAt.toISOString() ?? null, dueDate: task.dueDate, dueTime: task.dueTime } }, proof, policy, kind === 'acceptance' ? '正式成果经独立验收通过' : '正式完整反馈及证据已保存')
}

async function manualFacts(tx: Tx, task: Task, eventCode: ResponsibilityEventCode, sourceId: string | null, relatedId: string | null, policy: Pick<ActivePolicy, 'configuration'>, now: Date): Promise<Facts> {
  const base = { ...emptySources, subjectId: task.ownerUserId!, deadlineKey: taskDeadlineKey(task.dueDate!, task.dueTime), occurredAt: now, factSnapshot: { taskVersion: task.version, dueDate: task.dueDate, dueTime: task.dueTime } as Record<string, unknown> }
  if (eventCode === 'major_risk') {
    const [risk] = sourceId ? await tx.select().from(risks).where(and(eq(risks.id, sourceId), eq(risks.projectId, task.projectId!))).limit(1).for('update') : []
    if (!risk?.createdBy || risk.level !== '高' || risk.status === '已忽略' || relatedId) return fail('RESP_SOURCE_INVALID', '重大风险须关联本项目未忽略的高风险正式记录')
    return { ...base, subjectId: risk.createdBy, sourceRiskId: risk.id, occurredAt: risk.detectedAt, key: `risk:${risk.id}`, factSnapshot: { ...base.factSnapshot, riskId: risk.id, riskVersion: risk.version, level: risk.level } }
  }
  if (eventCode === 'unblocked') {
    const [blocked] = sourceId ? await tx.select().from(todoFeedbacks).where(and(eq(todoFeedbacks.id, sourceId), eq(todoFeedbacks.todoId, task.id))) : []
    const [resolved] = relatedId ? await tx.select().from(todoFeedbacks).where(and(eq(todoFeedbacks.id, relatedId), eq(todoFeedbacks.todoId, task.id))) : []
    const [marker] = resolved ? await tx.select().from(markers).where(and(eq(markers.taskId, task.id), lte(markers.createdAt, resolved.submittedAt))).orderBy(desc(markers.version)).limit(1) : []
    if (!blocked?.blocker.trim() || !resolved || resolved.blocker.trim() || resolved.submittedAt <= blocked.submittedAt || !marker?.critical) return fail('RESP_SOURCE_INVALID', '解除阻塞须关联关键行动的前后正式反馈及明确解除证据')
    return { ...base, subjectId: resolved.submittedBy, sourceFeedbackId: resolved.id, relatedFeedbackId: blocked.id, occurredAt: resolved.submittedAt, key: `unblocked:${task.id}:${blocked.id}`, factSnapshot: { ...base.factSnapshot, blockedFeedbackId: blocked.id, resolvedFeedbackId: resolved.id, markerId: marker.id } }
  }
  if (eventCode === 'incorrect_completion') {
    const [decision] = sourceId ? await tx.select().from(todoAcceptances).where(and(eq(todoAcceptances.id, sourceId), eq(todoAcceptances.todoId, task.id))) : []
    const [feedback] = decision ? await tx.select().from(todoFeedbacks).where(eq(todoFeedbacks.id, decision.feedbackId)) : []
    if (!decision || decision.decision !== 'return' || feedback?.kind !== 'submission' || relatedId) return fail('RESP_SOURCE_INVALID', '须关联正式成果及验收退回记录；仍需人工确认责任，退回不自动扣分')
    return { ...base, subjectId: feedback.submittedBy, sourceAcceptanceId: decision.id, sourceFeedbackId: feedback.id, occurredAt: decision.decidedAt, key: `incorrect:${decision.id}`, factSnapshot: { ...base.factSnapshot, acceptanceId: decision.id, feedbackId: feedback.id } }
  }
  if (!['no_feedback', 'unjustified_delay'].includes(eventCode) || sourceId || relatedId || policy.configuration.graceMinutes === null) return fail('RESP_SOURCE_INVALID', '期限责任事件来源或规则不完整')
  const deadline = responsibilityDeadline(task.dueDate!, task.dueTime), threshold = new Date(deadline.getTime() + policy.configuration.graceMinutes * 60_000)
  if (now <= threshold || ['已取消', '已关闭', '已归档'].includes(task.status)) return fail('RESP_SOURCE_INVALID', '尚未超过有效期限及宽限，或任务已取消/关闭')
  const feedbacks = await tx.select().from(todoFeedbacks).where(eq(todoFeedbacks.todoId, task.id)).orderBy(desc(todoFeedbacks.taskVersion))
  const proofs = feedbacks.length ? await tx.select().from(todoFeedbackEvidence).where(inArray(todoFeedbackEvidence.feedbackId, feedbacks.map(f => f.id))) : []
  if (eventCode === 'no_feedback' && feedbacks.some(f => f.submittedAt <= threshold && f.result.trim() && (f.kind === 'submission' || f.estimatedDate) && proofs.some(p => p.feedbackId === f.id))) return fail('RESP_SOURCE_INVALID', '有效期限或宽限内已有完整反馈，不能记为未反馈')
  if (eventCode === 'unjustified_delay' && (feedbacks[0]?.blocker.trim() || feedbacks.some(f => f.kind === 'submission' && f.submittedAt <= deadline))) return fail('RESP_SOURCE_INVALID', '存在明确阻塞或按时交付事实，不能直接认定无理由超时')
  return { ...base, occurredAt: threshold, key: `${eventCode}:${task.id}:${base.deadlineKey}`, factSnapshot: { ...base.factSnapshot, threshold: threshold.toISOString(), graceMinutes: policy.configuration.graceMinutes } }
}

// Internal only: the caller holds scan-state, project and task locks, in that
// order, and commits these candidates together with the durable cursor.
// No HTTP endpoint accepts a system actor, scan clock, or caller-supplied score.
export async function captureScannedDeadlineResponsibility(tx: Tx, project: Project, task: Task, scanCycleId: string, asOf: Date) {
  if (project.workflowModel !== 'fde-v1' || project.lifecycle !== 'active' || task.projectId !== project.id || task.executionModel !== 'fde-v1' || task.approvalRequestId || task.type === '流程' || !task.ownerUserId || !task.dueDate || task.createdAt > asOf || ['已取消', '已关闭', '已归档'].includes(task.status)) return { candidates: 0, outcome: 'ineligible' }
  const [subject] = await tx.select().from(users).where(and(eq(users.id, task.ownerUserId), eq(users.status, '启用')))
  if (!subject) return { candidates: 0, outcome: 'invalid_subject' }
  // Current identity must be valid, but historical records are never reassigned.
  const [visible] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, project.id), projectAccessCondition({ uid: subject.id, name: subject.name, role: subject.role })))
  if (!visible || !await canReadReferencedDirectiveTasks(tx, [task.id], subject.id)) return { candidates: 0, outcome: 'subject_out_of_scope' }
  if (task.status === '已完成') {
    const [acceptance] = await tx.select({ id: todoAcceptances.id }).from(todoAcceptances).where(and(eq(todoAcceptances.todoId, task.id), eq(todoAcceptances.decision, 'accept'))).limit(1)
    if (!acceptance) return { candidates: 0, outcome: 'historical_completion_without_source' }
  }
  const policy = await activeResponsibilityPolicy(tx, asOf)
  if (!policy) return { candidates: 0, outcome: 'policy_disabled' }
  let candidates = 0
  for (const eventCode of ['no_feedback', 'unjustified_delay'] as const) {
    if (!policy.configuration.rules.some(rule => rule.code === eventCode && rule.enabled)) continue
    let facts: Facts
    try { facts = await manualFacts(tx, task, eventCode, null, null, policy, asOf) }
    catch (error) { if ((error as { code?: string }).code === 'RESP_SOURCE_INVALID') continue; throw error }
    if (facts.occurredAt < policy.effectiveFrom || facts.occurredAt < task.createdAt) continue
    const [existing] = await tx.select({ id: records.id }).from(records).where(eq(records.sourceKey, policyHash(facts.key)))
    if (existing) continue // Includes revoked records and changed owners/policies.
    facts.factSnapshot = { ...facts.factSnapshot, scanCycleId, scannedAsOf: asOf.toISOString(), source: 'server_deadline_scan', requiresIndependentConfirmation: true, reviewChecklist: ['有效期限及延期历史', '完整反馈与成果', '上游依赖及外部原因'] }
    const created = await createRecord(tx, project, task, null, eventCode, facts, [], policy, '系统期限扫描形成待确认候选；须核对反馈、延期、上游及外部证据，不自动归责或扣分', scanCycleId)
    if (created) candidates++
  }
  return { candidates, outcome: candidates ? 'candidate_created' : 'no_new_candidate' }
}

export async function executeResponsibilityCommand(projectId: string, uid: string, raw: unknown) {
  z.string().uuid().parse(projectId); const input = responsibilityCommand.parse(raw), hash = policyHash({ projectId, input })
  return db.transaction(async tx => {
    // Project first matches the task hooks. Recovery only holds the actor lock
    // and never waits for a project, avoiding the project/actor lock inversion.
    await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
    await actor(tx, uid, true)
    const [prior] = await tx.select().from(commands).where(and(eq(commands.actorId, uid), eq(commands.commandId, input.commandId)))
    if (prior) {
      if (prior.projectId !== projectId || prior.commandHash && prior.commandHash !== hash) return fail('RESP_COMMAND_REUSED', '请求编号已用于其他内容或项目')
      if (prior.closedAt) return fail('RESP_COMMAND_CLOSED', '原请求已封闭，请核对最新状态后重新确认')
      return responsibilityReceipt.parse(prior.receipt)
    }
    const project = await context(tx, projectId, uid)
    const manager = await isFdeTaskManager(tx, project, uid)
    let row: RecordRow | null = null
    if ('recordId' in input) {
      row = await accessibleRecord(tx, input.recordId, uid)
      if (row.projectId !== projectId) return fail('RESP_RECORD_FORBIDDEN', '责任记录不属于当前项目', 403)
      if (row.version !== input.expectedVersion) return fail('VERSION_CONFLICT', '责任记录已变化，请重新查看')
    }
    const task = await taskFor(tx, project, 'taskId' in input ? input.taskId : row!.taskId, uid)
    let receipt: ResponsibilityReceipt
    if (input.action === 'mark_critical') {
      if (!manager || project.lifecycle !== 'active' || taskTerminal(task.status) || task.status === '待验收') return fail('RESP_MARKER_FORBIDDEN', '只有负责人或授权领导可标记尚在执行的关键行动', 403)
      const [marker] = await tx.select().from(markers).where(eq(markers.taskId, task.id)).orderBy(desc(markers.version)).limit(1)
      if (task.version !== input.expectedTaskVersion || (marker?.version ?? 0) !== input.expectedMarkerVersion) return fail('VERSION_CONFLICT', '任务或关键标识已变化')
      const version = (marker?.version ?? 0) + 1
      await tx.insert(markers).values({ taskId: task.id, critical: input.critical, actorId: uid, reason: input.reason, version })
      await audit(tx, uid, 'mark_critical', { projectId, taskId: task.id, version, critical: input.critical, reason: input.reason })
      receipt = { commandId: input.commandId, projectId, taskId: task.id, recordId: null, version, status: input.critical ? 'critical' : 'ordinary' }
    } else if (input.action === 'propose') {
      if (!manager || project.lifecycle !== 'active') return fail('RESP_PROPOSE_FORBIDDEN', '仅负责人或授权领导可发起人工责任确认', 403)
      if (task.version !== input.expectedTaskVersion) return fail('VERSION_CONFLICT', '任务事实已变化')
      const policy = await activeResponsibilityPolicy(tx, new Date())
      if (!policy) return fail('RESP_POLICY_DISABLED', '当前没有已批准且启用的责任规则')
      const facts = await manualFacts(tx, task, input.eventCode, input.sourceId, input.relatedSourceId, policy, new Date())
      if (facts.occurredAt < policy.effectiveFrom) return fail('RESP_SOURCE_PREDATES_POLICY', '此事件发生于当前规则启用前，不能自动追溯归责')
      const proof = await checkedEvidence(tx, projectId, input.evidence, uid)
      row = await createRecord(tx, project, task, uid, input.eventCode, facts, proof, policy, input.reason)
      if (!row) return fail('RESP_RULE_DISABLED', '此类责任规则未启用')
      receipt = { commandId: input.commandId, projectId, taskId: task.id, recordId: row.id, version: row.version, status: row.status }
    } else {
      const policy = await recordPolicy(tx, row!)
      let change: Partial<typeof records.$inferInsert> = {}, extra: Record<string, unknown> = {}
      if (input.action === 'read_notice') {
        const result = await tx.select().from(notices).where(and(eq(notices.recordId, row!.id), eq(notices.recipientId, uid), eq(notices.version, row!.version)))
        if (!result.length) return fail('RESP_NOTICE_FORBIDDEN', '没有属于本人的通知', 403)
        await tx.update(notices).set({ readAt: new Date() }).where(and(eq(notices.recordId, row!.id), eq(notices.recipientId, uid), eq(notices.version, row!.version), isNull(notices.readAt)))
        await audit(tx, uid, 'read_notice', { recordId: row!.id, version: row!.version })
      } else if (input.action === 'appeal') {
        if (row!.subjectId !== uid || row!.originalPoints >= 0 || row!.status !== 'effective' || row!.appealedAt) return fail('RESP_APPEAL_FORBIDDEN', '仅本人可对未申诉的生效负向记录提交一次申诉', 403)
        const proof = await checkedEvidence(tx, projectId, input.evidence, uid)
        await addEvidence(tx, row!.id, proof)
        const allProof = await tx.select().from(evidenceLinks).where(eq(evidenceLinks.recordId, row!.id))
        change = { status: 'appealing', appealedAt: new Date(), reviewerId: await reviewerFor(tx, project, task.id, row!.subjectId, allProof) }
        extra = { appealEvidence: proof }
      } else if (input.action === 'reroute') {
        if (!manager || !['pending_confirmation', 'appealing'].includes(row!.status)) return fail('RESP_REVIEW_FORBIDDEN', '仅授权管理人员可重新核对待处理记录的复核人', 403)
        const allProof = await tx.select().from(evidenceLinks).where(eq(evidenceLinks.recordId, row!.id))
        change = { reviewerId: await reviewerFor(tx, project, task.id, row!.subjectId, allProof) }
      } else {
        if (!manager || uid === row!.subjectId || uid !== row!.reviewerId) return fail('RESP_REVIEW_FORBIDDEN', '仅系统路由的非本人授权人员可以决定', 403)
        const proof = await tx.select().from(evidenceLinks).where(eq(evidenceLinks.recordId, row!.id))
        await checkedFrozenEvidence(tx, projectId, proof, uid)
        if (input.action === 'confirm') {
          if (row!.status !== 'pending_confirmation') return fail('RESP_STATE_CHANGED', '此记录不再等待责任确认')
          if (input.decision === 'confirm') {
            if (['no_feedback', 'unjustified_delay'].includes(row!.eventCode) && row!.deadlineKey !== taskDeadlineKey(task.dueDate!, task.dueTime)) return fail('RESP_SOURCE_CHANGED', '有效期限已变化，不能确认原期限责任')
            const facts = await manualFacts(tx, task, row!.eventCode as ResponsibilityEventCode, row!.sourceRiskId ?? row!.sourceAcceptanceId ?? row!.relatedFeedbackId, row!.eventCode === 'unblocked' ? row!.sourceFeedbackId : null, { configuration: policy }, new Date())
            if (facts.subjectId !== row!.subjectId || policyHash(facts.key) !== row!.sourceKey) return fail('RESP_SOURCE_CHANGED', '来源主体或事件已变化，不能覆盖原责任事实')
            extra.confirmationFacts = facts
          }
          change = { status: input.decision === 'confirm' ? 'effective' : 'revoked', effectivePoints: input.decision === 'confirm' ? row!.originalPoints : 0 }
        } else {
          if (row!.status !== 'appealing') return fail('RESP_STATE_CHANGED', '此记录不再等待申诉复核')
          let points: number
          try { points = responsibilityReviewPoints(row!.originalPoints, row!.effectivePoints, input.decision, input.adjustedPoints, policy) } catch (error) { return fail('RESP_REVIEW_INVALID', (error as Error).message, 400) }
          change = { status: { uphold: 'upheld', revoke: 'revoked', adjust: 'adjusted', exempt: 'exempted' }[input.decision], effectivePoints: points }
        }
      }
      if (input.action !== 'read_notice') {
        await tx.update(records).set({ ...change, reason: input.reason, version: row!.version + 1 }).where(eq(records.id, row!.id))
        row = await recordEvent(tx, row!.id, uid, input.action, input.reason, extra)
      }
      receipt = { commandId: input.commandId, projectId, taskId: task.id, recordId: row!.id, version: row!.version, status: row!.status }
    }
    await tx.insert(commands).values({ actorId: uid, commandId: input.commandId, projectId, commandHash: hash, receipt })
    return responsibilityReceipt.parse(receipt)
  }, { isolationLevel: 'read committed' })
}

export async function reconcileTaskResponsibility(tx: Tx, taskId: string, uid: string, action: 'extension' | 'timeline' | 'cancel', sourceId: string) {
  const [task] = await tx.select().from(todos).where(eq(todos.id, taskId))
  if (!task?.dueDate) return
  const deadlineChanged = action !== 'cancel'
  const rows = await tx.select().from(records).where(and(eq(records.taskId, taskId), inArray(records.eventCode, deadlineChanged ? ['no_feedback', 'unjustified_delay'] : ['on_time', 'early_critical'])))
  for (const row of rows) {
    if (['revoked', 'exempted'].includes(row.status) || deadlineChanged && row.deadlineKey === taskDeadlineKey(task.dueDate, task.dueTime)) continue
    const reason = action === 'timeline' ? `流程行动对账 ${sourceId} 已更新有效期限，原期限责任须纠正` : action === 'extension' ? `正式延期 ${sourceId} 已批准，原期限责任不再成立` : `正式任务取消 ${sourceId}，撤销完成奖励但保留原始记录`
    await tx.update(records).set({ status: deadlineChanged ? 'exempted' : 'revoked', effectivePoints: 0, reason, version: row.version + 1 }).where(eq(records.id, row.id))
    await recordEvent(tx, row.id, uid, deadlineChanged ? 'deadline_correction' : 'completion_reversal', reason, { sourceId, newDeadlineKey: taskDeadlineKey(task.dueDate, task.dueTime), originalRecordVersion: row.version })
  }
}

export async function recoverResponsibilityCommand(projectId: string, uid: string, raw: unknown) {
  z.string().uuid().parse(projectId); const { commandId } = z.object({ commandId: z.string().uuid() }).strict().parse(raw)
  return db.transaction(async tx => {
    await actor(tx, uid, true)
    const [prior] = await tx.select().from(commands).where(and(eq(commands.actorId, uid), eq(commands.commandId, commandId)))
    if (prior?.projectId && prior.projectId !== projectId) return fail('RESP_COMMAND_REUSED', '请求编号属于其他项目')
    if (prior?.receipt) return { state: 'committed' as const, receipt: responsibilityReceipt.parse(prior.receipt) }
    if (prior && !prior.closedAt) return fail('RESP_COMMAND_INTEGRITY', '回执异常，不能确认请求未提交')
    if (!prior) {
      await tx.insert(commands).values({ actorId: uid, commandId, projectId, closedAt: new Date() })
      await audit(tx, uid, 'seal_command', { projectId, commandId, minimalReceiptOnly: true })
    }
    return { state: 'not_committed' as const, receipt: null }
  }, { isolationLevel: 'read committed' })
}

export async function listResponsibilityRecords(uid: string, raw: unknown = {}) {
  const query = responsibilityQuery.parse(raw)
  return db.transaction(async tx => {
    await actor(tx, uid)
    if (query.view === 'assignment' && !await assignmentAccess(tx, uid)) return fail('RESP_ASSIGNMENT_FORBIDDEN', '当前职责无权协调责任记录分配', 403)
    const where = and(accessCondition(uid), query.projectId ? eq(records.projectId, query.projectId) : undefined, query.status ? eq(records.status, query.status) : undefined, query.eventCode ? eq(records.eventCode, query.eventCode) : undefined,
      query.view === 'mine' ? eq(records.subjectId, uid) : query.view === 'review' ? and(eq(records.reviewerId, uid), inArray(records.status, ['pending_confirmation', 'appealing']), reviewerEligibleCondition()) : query.view === 'assignment' ? and(managerCondition(uid), needsAssignmentCondition()) : managerCondition(uid))
    const [count] = await tx.select({ total: sql<number>`COUNT(*)`.mapWith(Number) }).from(records).innerJoin(projects, eq(projects.id, records.projectId)).innerJoin(todos, eq(todos.id, records.taskId)).where(where)
    const rows = await tx.select({ record: records, projectName: projects.name, taskTitle: todos.title, assignmentState: assignmentStateCondition() }).from(records).innerJoin(projects, eq(projects.id, records.projectId)).innerJoin(todos, eq(todos.id, records.taskId)).where(where).orderBy(desc(records.createdAt), desc(records.id)).limit(query.pageSize).offset((query.page - 1) * query.pageSize)
    const list = []
    for (const { record, ...labels } of rows) {
      const policy = await recordPolicy(tx, record)
      const [notice] = await tx.select().from(notices).where(and(eq(notices.recordId, record.id), eq(notices.recipientId, uid), eq(notices.version, record.version))).limit(1)
      const [subject] = await tx.select({ name: users.name }).from(users).where(eq(users.id, record.subjectId))
      list.push({ ...record, ...labels, subjectName: subject?.name ?? '历史人员', countedPoints: responsibilityCountedPoints(record.status, record.effectivePoints, policy), notice: notice ? { id: notice.id, readAt: notice.readAt, closedAt: notice.closedAt } : null })
    }
    return { list, total: count.total, page: query.page, pageSize: query.pageSize, authority: 'mysql', publicRanking: false }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function getResponsibilityRecord(uid: string, id: string, page = 1) {
  z.string().uuid().parse(id); z.number().int().min(1).max(100000).parse(page)
  return db.transaction(async tx => {
    await actor(tx, uid); const record = await accessibleRecord(tx, id, uid), policy = await recordPolicy(tx, record)
    const history = await tx.select().from(events).where(eq(events.recordId, id)).orderBy(desc(events.version)).limit(21).offset((page - 1) * 20)
    const proof = await tx.select({ link: evidenceLinks, fileName: projectFiles.name, canDownload: sql<number>`CASE WHEN ${projectFileAccessCondition(uid, 'download')} THEN 1 ELSE 0 END`.mapWith(Number) }).from(evidenceLinks).innerJoin(projectFiles, eq(projectFiles.id, evidenceLinks.fileId)).where(eq(evidenceLinks.recordId, id))
    const project = await context(tx, record.projectId, uid)
    const [task] = await tx.select({ title: todos.title, assignmentState: assignmentStateCondition() }).from(records).innerJoin(todos, eq(todos.id, records.taskId)).innerJoin(projects, eq(projects.id, records.projectId)).where(eq(records.id, id))
    const [subject] = await tx.select({ name: users.name }).from(users).where(eq(users.id, record.subjectId))
    const [reviewer] = record.reviewerId ? await tx.select({ name: users.name }).from(users).where(eq(users.id, record.reviewerId)) : []
    const [notice] = await tx.select().from(notices).where(and(eq(notices.recordId, id), eq(notices.recipientId, uid), eq(notices.version, record.version))).limit(1)
    const manager = await isFdeTaskManager(tx, project, uid), assigned = manager && record.reviewerId === uid && task.assignmentState === 'assigned'
    const [appeal] = await tx.select().from(events).where(and(eq(events.recordId, id), eq(events.action, 'appeal'))).orderBy(desc(events.version)).limit(1)
    const actorIds = [...new Set(history.map(event => event.actorId).filter((id): id is string => id !== null))]
    const names = actorIds.length ? await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, actorIds)) : []
    return { record, projectName: project.name, taskTitle: task?.title ?? '历史任务', assignmentState: task.assignmentState, subjectName: subject?.name ?? '历史人员', reviewerName: reviewer?.name ?? null,
      policy, countedPoints: responsibilityCountedPoints(record.status, record.effectivePoints, policy),
      evidence: proof.map(({ link, fileName, canDownload }) => ({ ...link, fileName, canDownload: Boolean(canDownload) })),
      events: history.slice(0, 20).map(event => ({ ...event, actorName: event.actorId === null && event.action === 'scan_candidate' ? '系统期限扫描' : names.find(person => person.id === event.actorId)?.name ?? '历史人员' })),
      appeal: appeal ? { reason: appeal.reason, createdAt: appeal.createdAt, version: appeal.version, evidence: (appeal.snapshot as { appealEvidence?: unknown }).appealEvidence ?? [] } : null,
      capabilities: { appeal: record.subjectId === uid && record.originalPoints < 0 && record.status === 'effective' && !record.appealedAt,
        confirm: assigned && record.status === 'pending_confirmation', review: assigned && record.status === 'appealing',
        reroute: manager && ['pending_confirmation', 'appealing'].includes(record.status), readNotice: Boolean(notice && !notice.readAt && !notice.closedAt) },
      hasMoreEvents: history.length > 20, page }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

// Entry eligibility is separate from record scope. No scores or ranking are
// projected onto the workbench, and counts use the same current ACL as details.
export async function getResponsibilityOverview(uid: string) {
  return db.transaction(async tx => {
    await actor(tx, uid)
    const [leader] = await tx.select({ id: roles.id }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(eq(userRoles.userId, uid), eq(roles.status, '启用'), eq(roles.fdeCategory, 'institution_leader'))).limit(1)
    const [counts] = await tx.select({
      mine: sql<number>`COALESCE(SUM(CASE WHEN ${records.subjectId}=${uid} THEN 1 ELSE 0 END),0)`.mapWith(Number),
      review: sql<number>`COALESCE(SUM(CASE WHEN ${records.reviewerId}=${uid} AND ${reviewerEligibleCondition()} AND ${records.status} IN ('pending_confirmation','appealing') THEN 1 ELSE 0 END),0)`.mapWith(Number),
      assignment: sql<number>`COALESCE(SUM(CASE WHEN ${managerCondition(uid)} AND ${needsAssignmentCondition()} THEN 1 ELSE 0 END),0)`.mapWith(Number),
      unread: sql<number>`COALESCE(SUM(CASE WHEN ${notices.id} IS NOT NULL AND ${notices.readAt} IS NULL AND ${notices.closedAt} IS NULL THEN 1 ELSE 0 END),0)`.mapWith(Number),
    }).from(records).innerJoin(projects, eq(projects.id, records.projectId)).innerJoin(todos, eq(todos.id, records.taskId))
      .leftJoin(notices, and(eq(notices.recordId, records.id), eq(notices.recipientId, uid), eq(notices.version, records.version))).where(accessCondition(uid))
    return { management: Boolean(leader), assignmentAccess: await assignmentAccess(tx, uid), assignment: counts.assignment, mine: counts.mine, review: counts.review, unread: counts.unread }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function responsibilityEvidenceOptions(uid: string, id: string, raw: unknown) {
  z.string().uuid().parse(id)
  const query = z.object({ keyword: z.string().trim().max(100).default(''), page: z.coerce.number().int().min(1).max(100000).default(1) }).strict().parse(raw)
  return db.transaction(async tx => {
    await actor(tx, uid)
    const record = await accessibleRecord(tx, id, uid)
    if (record.subjectId !== uid || record.status !== 'effective' || record.originalPoints >= 0 || record.appealedAt) return fail('RESP_APPEAL_FORBIDDEN', '当前记录不可补充申诉证据', 403)
    const where = and(eq(projectFiles.projectId, record.projectId), projectFileAccessCondition(uid), query.keyword ? sql`LOCATE(${query.keyword},${projectFiles.name})>0` : undefined)
    const rows = await tx.select({ fileId: projectFiles.id, fileName: projectFiles.name, version: projectFileVersions.version }).from(projectFiles)
      .innerJoin(projectFileVersions, and(eq(projectFileVersions.fileId, projectFiles.id), eq(projectFileVersions.version, projectFiles.version)))
      .where(where).orderBy(asc(projectFiles.name), asc(projectFiles.id)).limit(21).offset((query.page - 1) * 20)
    return { list: rows.slice(0, 20), hasMore: rows.length > 20, page: query.page }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
