import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { auditLogs, users, userRoles, todos, todoFeedbacks, todoAcceptances, projectFiles, projectFileVersions, responsibilityRecords as records, responsibilityEventsLog as events, responsibilityCommands as commands, responsibilityNotices as notices, responsibilityPolicyVersions as policyVersions, responsibilityPolicyEvents as policyEvents, risks } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { createProject, classifyProject, deleteProject } from '../services/projectService.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { createFdeTask, feedbackFdeTask, decideFdeTask, requestFdeTaskExtension, actOnFdeTaskExtension } from '../services/fdeTaskService.js'
import { listOaApprovalRequests } from '../services/oaWorkflowService.js'
import { createRisk } from '../services/riskService.js'
import { saveProjectFile } from '../services/projectFileStorageService.js'
import { actOnFdeFile, setFdeFilePermissions } from '../services/fdeFileService.js'
import { captureTaskResponsibility, executeResponsibilityCommand as execute, getResponsibilityRecord as detail, listResponsibilityRecords as list, recoverResponsibilityCommand as recover, getResponsibilityOverview, responsibilityEvidenceOptions } from '../services/fdeResponsibilityService.js'
import { responsibilityOverview, responsibilityList, responsibilityDetail, responsibilityEvidenceChoices } from '../contracts/fdeResponsibilityViewContract.js'
import { activeResponsibilityPolicy, executeResponsibilityPolicyCommand as policyCommand, listResponsibilityPolicies } from '../services/fdeResponsibilityPolicyService.js'
import { responsibilityBusinessDate, responsibilityEvents, type ResponsibilityPolicy } from '../contracts/fdeResponsibilityPolicyContract.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/, '只允许随机隔离前缀')
assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
const checks: string[] = [], marker = randomUUID().slice(0, 8)
const date = (days: number) => responsibilityBusinessDate(new Date(Date.now() + days * 86_400_000))
const reason = '隔离合成来源与证据验收，不作为正式业务批准'
const denied = async (promise: Promise<unknown>, code: string) => { const error = await promise.then(() => null, cause => cause); assert.equal(error?.code, code, error?.message ?? 'unexpected success') }
let server: Server | undefined
try {
  process.env.AUTH_COOKIE_SECURE = 'false'; process.env.AUTH_COOKIE_DOMAIN = ''; process.env.AUTH_ALLOW_LEGACY_BEARER = 'false'; process.env.JWT_SECRET = randomUUID() + randomUUID()
  const { hashNewPassword } = await import('../security/passwordPolicy.js')
  const password = `Responsibility-Ledger-${randomUUID()}!`, passwordHash = await hashNewPassword(password)
  const people = ['投资经理', '投资经理', '董事长', '系统管理员', '投资经理'].map((role, i) => ({ id: randomUUID(), name: `责任事实-${marker}-${i}`, email: `resp-facts-${marker}-${i}@example.invalid`, role, department: `责任事实-${marker}`, passwordHash }))
  const [owner, member, leader, admin, outsider] = people
  await db.insert(users).values(people)
  for (const person of people) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
  let project = await createProject({ name: `责任事实链-${marker}`, owner: owner.name, ownerUserId: owner.id, collaborators: [], targetDate: date(90) }, owner.id)
  project = await classifyProject({ projectId: project.id, userId: owner.id, expectedVersion: project.version, toClassification: 'normal', reason })
  await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason, assignments: [{ duty: 'member', userId: member.id }, { duty: 'concerned_leader', userId: leader.id }] })
  assert.deepEqual(await getResponsibilityOverview(owner.id), { management: false, assignmentAccess: true, assignment: 0, mine: 0, review: 0, unread: 0 })
  assert.equal((await list(owner.id, { view: 'assignment' })).total, 0, '空列表不取消项目负责人协调资格')
  for (const person of [member, admin, outsider]) await denied(list(person.id, { view: 'assignment' }), 'RESP_ASSIGNMENT_FORBIDDEN')
  checks.push('assignment-entry-project-owner-without-institution-role-empty-access-no-admin-or-member-bypass')
  const task = async (id: string) => (await db.select().from(todos).where(eq(todos.id, id)))[0]
  const createTask = async (title: string, dueDate = date(5)) => {
    const id = randomUUID()
    await createFdeTask(project.id, owner.id, { clientRequestId: id, title, ownerUserId: member.id, dueDate, deliverable: '真实文件及可核对成果' })
    return id
  }
  const makeFile = async (uploader = member) => {
    const id = randomUUID(), versionId = randomUUID(), bytes = Buffer.from(`真实责任证据-${id}`)
    const sha256 = createHash('sha256').update(bytes).digest('hex'), storagePath = await saveProjectFile(project.id, id, bytes)
    await db.insert(projectFiles).values({ id, projectId: project.id, name: `责任证据-${id}.txt`, type: 'TXT', category: '项目资料', uploadedBy: uploader.id, uploader: uploader.name, storagePath, byteSize: bytes.length, sha256 })
    await db.insert(projectFileVersions).values({ id: versionId, fileId: id, version: 1, storagePath, byteSize: bytes.length, sha256, createdBy: uploader.id })
    return { fileId: id, version: 1, versionId, sha256, byteSize: bytes.length }
  }
  const file = await makeFile(), evidence = [{ fileId: file.fileId, version: 1 }]
  const feedback = async (id: string, kind: 'progress' | 'submission' = 'progress', blocker = '', refs = evidence) => {
    await feedbackFdeTask(project.id, id, member.id, { expectedVersion: (await task(id)).version, kind, progress: kind === 'submission' ? 100 : 40, result: '完成真实材料整理及证据核对', blocker, estimatedDate: date(3), evidence: refs })
    return (await db.select().from(todoFeedbacks).where(eq(todoFeedbacks.todoId, id)).orderBy(desc(todoFeedbacks.taskVersion)))[0]
  }
  const decide = async (id: string, feedbackId: string, action: 'accept' | 'return') => {
    await decideFdeTask(project.id, id, owner.id, { expectedVersion: (await task(id)).version, feedbackId, action, reason })
    return (await db.select().from(todoAcceptances).where(eq(todoAcceptances.feedbackId, feedbackId)))[0]
  }
  const taskRecords = (id: string) => db.select().from(records).where(eq(records.taskId, id))
  const propose = async (id: string, eventCode: string, sourceId: string | null = null, relatedSourceId: string | null = null, refs = evidence, uid = owner.id) => execute(project.id, uid, { action: 'propose', commandId: randomUUID(), taskId: id, expectedTaskVersion: (await task(id)).version, eventCode, sourceId, relatedSourceId, evidence: refs, reason })
  const recordCommand = async (id: string, uid: string, action: string, fields: Record<string, unknown> = {}) => execute(project.id, uid, { commandId: randomUUID(), action, recordId: id, expectedVersion: (await detail(uid, id)).record.version, reason, ...fields })

  const disabledTask = await createTask('停用规则不改变原任务')
  const disabledFeedback = await feedback(disabledTask, 'submission')
  await decide(disabledTask, disabledFeedback.id, 'accept')
  assert.equal((await taskRecords(disabledTask)).length, 0)
  checks.push('disabled-policy-task-feedback-and-acceptance-unmodified-with-no-records')

  const config: ResponsibilityPolicy = { rules: responsibilityEvents.map(rule => ({ code: rule.code, mode: rule.mode, enabled: true, points: rule.positive ? 2 : -4 })), timezone: 'Asia/Shanghai', calendar: { workingWeekdays: [0, 1, 2, 3, 4, 5, 6], holidays: [], extraWorkingDates: [] }, earlyWorkingDays: 1, graceMinutes: 0, appealLimit: 1, appealAggregation: 'exclude_pending', allowAdjustment: true, allowExemption: true, completionAggregation: 'one_per_task', feedbackAggregation: 'one_per_actor_task_business_day', missingReviewer: 'retain_pending_assignment', history: 'append_only_no_automatic_rescore' }
  const existingHead = (await listResponsibilityPolicies(admin.id)).policy
  const created = await policyCommand(admin.id, { action: 'create', commandId: randomUUID(), expectedPolicyVersion: existingHead?.version ?? 0, configuration: config, reason })
  const approved = await policyCommand(leader.id, { action: 'approve', commandId: randomUUID(), versionId: created.versionId, expectedDraftVersion: created.draftVersion, reason })
  const published = await policyCommand(admin.id, { action: 'publish', commandId: randomUUID(), versionId: created.versionId, expectedDraftVersion: approved.draftVersion, expectedPolicyVersion: approved.policyVersion, reason })
  await policyCommand(admin.id, { action: 'toggle', commandId: randomUUID(), expectedPolicyVersion: published.policyVersion, enabled: true, reason })
  const active = (await db.transaction(tx => activeResponsibilityPolicy(tx, new Date(Date.now() + 1000))))!
  assert.ok(active)
  const normal = await createTask('按时完成与日反馈')
  await feedback(normal); await feedback(normal)
  assert.equal((await taskRecords(normal)).filter(row => row.eventCode === 'feedback').length, 1)
  const submitted = await feedback(normal, 'submission')
  assert.equal((await taskRecords(normal)).length, 1, '提交成果不等于验收完成')
  const accepted = await decide(normal, submitted.id, 'accept')
  const completed = (await taskRecords(normal)).find(row => row.eventCode === 'on_time')!
  assert.ok(completed); assert.equal(completed.sourceAcceptanceId, accepted.id); assert.equal(completed.subjectId, member.id)
  assert.equal(completed.policyVersionId, active.id); assert.equal(completed.activationEventId, active.activationEventId)
  await db.transaction(tx => captureTaskResponsibility(tx, normal, owner.id, 'acceptance', accepted.id))
  assert.equal((await taskRecords(normal)).length, 2)
  checks.push('real-task-feedback-daily-dedupe-and-independent-acceptance-bound-to-policy-source-once')

  const early = await createTask('提前关键行动')
  await execute(project.id, owner.id, { action: 'mark_critical', commandId: randomUUID(), taskId: early, expectedTaskVersion: (await task(early)).version, expectedMarkerVersion: 0, critical: true, reason })
  const earlyFeedback = await feedback(early, 'submission'); await decide(early, earlyFeedback.id, 'accept')
  assert.deepEqual((await taskRecords(early)).map(row => row.eventCode), ['early_critical'])
  await assert.rejects(propose(early, 'on_time'), { name: 'ZodError' })
  checks.push('critical-marker-before-submission-working-calendar-and-completion-mutual-exclusion')

  const riskTask = await createTask('风险发现责任确认')
  const risk = await createRisk({ projectId: project.id, projectName: project.name, title: `重大风险-${marker}`, type: '财务', level: '高' }, member.id, member.name)
  const riskReceipt = await propose(riskTask, 'major_risk', risk.id)
  let riskRecord = (await detail(owner.id, riskReceipt.recordId!)).record
  assert.equal(riskRecord.status, 'pending_confirmation'); assert.equal(riskRecord.effectivePoints, 0); assert.equal(riskRecord.reviewerId, owner.id)
  await denied(recordCommand(riskRecord.id, member.id, 'confirm', { decision: 'confirm' }), 'RESP_REVIEW_FORBIDDEN')
  await db.update(risks).set({ createdBy: leader.id }).where(eq(risks.id, risk.id))
  await denied(recordCommand(riskRecord.id, owner.id, 'confirm', { decision: 'confirm' }), 'RESP_SOURCE_CHANGED')
  await db.update(risks).set({ createdBy: member.id }).where(eq(risks.id, risk.id))
  const confirm = { action: 'confirm', commandId: randomUUID(), recordId: riskRecord.id, expectedVersion: riskRecord.version, decision: 'confirm', reason }
  const [first, replay] = await Promise.all([execute(project.id, owner.id, confirm), execute(project.id, owner.id, confirm)])
  assert.deepEqual(first, replay); riskRecord = (await detail(owner.id, riskRecord.id)).record; assert.equal(riskRecord.effectivePoints, 2)
  assert.equal((await db.select().from(events).where(eq(events.recordId, riskRecord.id))).length, 2)
  await denied(recordCommand(riskRecord.id, owner.id, 'read_notice'), 'RESP_NOTICE_FORBIDDEN')
  checks.push('major-risk-manual-confirmation-stable-subject-concurrent-replay-and-no-self-review')

  const unrelatedTask = await createTask('不能借另一任务重用风险来源')
  await denied(propose(unrelatedTask, 'major_risk', risk.id), 'RESP_SOURCE_ALREADY_BOUND')
  assert.equal((await taskRecords(unrelatedTask)).length, 0)
  assert.equal((await detail(owner.id, riskRecord.id)).record.taskId, riskTask)
  assert.equal((await propose(riskTask, 'major_risk', risk.id)).recordId, riskRecord.id)
  checks.push('same-source-cannot-rebind-task-or-subject-original-receipt-and-ledger-stay-consistent')

  const blocked = await createTask('关键阻塞解除')
  await execute(project.id, owner.id, { action: 'mark_critical', commandId: randomUUID(), taskId: blocked, expectedTaskVersion: 1, expectedMarkerVersion: 0, critical: true, reason })
  const before = await feedback(blocked, 'progress', '客户资料阻塞'), after = await feedback(blocked, 'progress', '')
  const unblocked = await propose(blocked, 'unblocked', before.id, after.id)
  await recordCommand(unblocked.recordId!, owner.id, 'confirm', { decision: 'confirm' })
  assert.equal((await detail(member.id, unblocked.recordId!)).record.effectivePoints, 2)
  checks.push('unblocked-requires-formal-before-after-feedback-and-prior-critical-marker')

  const returned = await createTask('退回不自动扣分')
  const returnFeedback = await feedback(returned, 'submission'), returnDecision = await decide(returned, returnFeedback.id, 'return')
  assert.equal((await taskRecords(returned)).length, 0)
  const negative = await propose(returned, 'incorrect_completion', returnDecision.id)
  await recordCommand(negative.recordId!, owner.id, 'confirm', { decision: 'confirm' })
  assert.equal((await detail(member.id, negative.recordId!)).countedPoints, -4)
  const notice = (await db.select().from(notices).where(and(eq(notices.recordId, negative.recordId!), eq(notices.recipientId, member.id)))).at(-1)!
  assert.ok(notice)
  await recordCommand(negative.recordId!, member.id, 'read_notice')
  assert.equal((await detail(member.id, negative.recordId!)).record.status, 'effective')
  const appeal = { action: 'appeal', commandId: randomUUID(), recordId: negative.recordId, expectedVersion: 2, reason, evidence }
  assert.deepEqual(...await Promise.all([execute(project.id, member.id, appeal), execute(project.id, member.id, appeal)]) as [unknown, unknown])
  assert.equal((await detail(member.id, negative.recordId!)).countedPoints, 0)
  await denied(recordCommand(negative.recordId!, member.id, 'appeal', { evidence }), 'RESP_APPEAL_FORBIDDEN')
  await recordCommand(negative.recordId!, owner.id, 'review', { decision: 'adjust', adjustedPoints: -2 })
  const resolved = await detail(member.id, negative.recordId!)
  assert.equal(resolved.record.status, 'adjusted'); assert.equal(resolved.record.originalPoints, -4); assert.equal(resolved.countedPoints, -2); assert.equal(resolved.events.length, 4)
  await denied(recordCommand(completed.id, member.id, 'appeal', { evidence }), 'RESP_APPEAL_FORBIDDEN')
  checks.push('return-not-auto-blame-one-own-negative-appeal-read-not-complete-adjustment-retains-history')

  const overdue = await createTask('旧期限与延期纠正', date(-1))
  await denied(propose(overdue, 'no_feedback'), 'RESP_SOURCE_PREDATES_POLICY')
  // Only synthetic policy timestamps are shifted to exercise a past deadline.
  // Task/feedback/approval/ledger writes still go through real business services.
  const policyEpoch = new Date(Date.now() - 3 * 86_400_000)
  await db.update(policyVersions).set({ publishedAt: policyEpoch }).where(eq(policyVersions.id, active.id))
  await db.update(policyEvents).set({ createdAt: policyEpoch }).where(eq(policyEvents.id, active.activationEventId))
  const noFeedback = await propose(overdue, 'no_feedback'), delay = await propose(overdue, 'unjustified_delay')
  for (const row of [noFeedback, delay]) await recordCommand(row.recordId!, owner.id, 'confirm', { decision: 'confirm' })
  await requestFdeTaskExtension(project.id, overdue, member.id, { expectedVersion: (await task(overdue)).version, requestedDueDate: date(2), reviewerUserId: owner.id, reason })
  assert.equal((await detail(member.id, noFeedback.recordId!)).record.status, 'effective')
  const extension = (await listOaApprovalRequests(owner.id)).find(row => row.taskId === overdue && row.businessType === 'task_extension')!
  await actOnFdeTaskExtension({ userId: owner.id, requestId: extension.id, action: 'approve', expectedVersion: extension.lockVersion, comment: reason })
  for (const row of [noFeedback, delay]) { const corrected = await detail(member.id, row.recordId!); assert.equal(corrected.record.status, 'exempted'); assert.equal(corrected.record.originalPoints, -4); assert.equal(corrected.countedPoints, 0); assert.equal(corrected.events[0].snapshot.sourceId, extension.id) }
  assert.equal((await detail(member.id, negative.recordId!)).record.status, 'adjusted', '无关交付责任不能一并豁免')
  checks.push('preactivation-rejection-synthetic-deadline-fixture-approved-extension-corrects-only-deadline-facts')

  const restrictedFile = await makeFile(leader)
  await setFdeFilePermissions(restrictedFile.fileId, leader.id, { clientRequestId: randomUUID(), expectedVersion: 1, reason, grants: [{ userId: leader.id, canView: true, canDownload: false }] })
  const leaderRisk = await createRisk({ projectId: project.id, projectName: project.name, title: '缺少有证据权限的独立复核人', type: '财务', level: '高' }, leader.id, leader.name)
  const missingReviewer = await propose(riskTask, 'major_risk', leaderRisk.id, null, [{ fileId: restrictedFile.fileId, version: 1 }], leader.id)
  assert.equal((await detail(leader.id, missingReviewer.recordId!)).record.reviewerId, null)
  assert.equal((await detail(leader.id, missingReviewer.recordId!)).assignmentState, 'unassigned')
  assert.equal((await getResponsibilityOverview(leader.id)).assignment, 1)
  assert.deepEqual((await list(leader.id, { view: 'assignment' })).list.map(row => row.id), [missingReviewer.recordId])
  assert.equal((await getResponsibilityOverview(owner.id)).assignment, 0, '无证据权限不能获知缺岗数量')
  const unassignedVersion = (await detail(leader.id, missingReviewer.recordId!)).record.version
  await recordCommand(missingReviewer.recordId!, leader.id, 'reroute')
  assert.equal((await detail(leader.id, missingReviewer.recordId!)).assignmentState, 'unassigned')
  assert.equal((await detail(leader.id, missingReviewer.recordId!)).record.version, unassignedVersion + 1)
  assert.equal((await detail(leader.id, missingReviewer.recordId!)).capabilities.confirm, false, '协调权不允许自批')
  await denied(detail(owner.id, missingReviewer.recordId!), 'RESP_RECORD_FORBIDDEN')
  assert.equal((await list(owner.id, { projectId: project.id, view: 'managed' })).list.some(row => row.id === missingReviewer.recordId), false)
  await setFdeFilePermissions(restrictedFile.fileId, leader.id, { clientRequestId: randomUUID(), expectedVersion: 2, reason, grants: [{ userId: owner.id, canView: true, canDownload: false }, { userId: leader.id, canView: true, canDownload: false }] })
  await recordCommand(missingReviewer.recordId!, owner.id, 'reroute')
  assert.equal((await detail(owner.id, missingReviewer.recordId!)).record.reviewerId, owner.id)
  await db.update(users).set({ status: '禁用' }).where(eq(users.id, owner.id))
  const invalidSnapshot = await db.select().from(records).where(eq(records.id, missingReviewer.recordId!))
  const invalidEvents = await db.select().from(events).where(eq(events.recordId, missingReviewer.recordId!))
  const invalidNotices = await db.select().from(notices).where(eq(notices.recordId, missingReviewer.recordId!))
  assert.equal((await detail(leader.id, missingReviewer.recordId!)).assignmentState, 'invalid')
  assert.equal((await list(leader.id, { view: 'assignment' })).total, 1)
  assert.equal((await getResponsibilityOverview(leader.id)).assignment, 1)
  assert.deepEqual(await db.select().from(records).where(eq(records.id, missingReviewer.recordId!)), invalidSnapshot)
  assert.deepEqual(await db.select().from(events).where(eq(events.recordId, missingReviewer.recordId!)), invalidEvents)
  assert.deepEqual(await db.select().from(notices).where(eq(notices.recordId, missingReviewer.recordId!)), invalidNotices)
  await denied(recordCommand(missingReviewer.recordId!, owner.id, 'confirm', { decision: 'confirm' }), 'RESP_ACTOR_FORBIDDEN')
  await db.update(users).set({ status: '启用' }).where(eq(users.id, owner.id))
  assert.equal((await detail(leader.id, missingReviewer.recordId!)).assignmentState, 'assigned')
  assert.equal((await getResponsibilityOverview(leader.id)).assignment, 0)
  checks.push('null-and-disabled-reviewer-current-sql-scope-read-only-no-self-decision')
  await db.update(projectFileVersions).set({ sha256: '0'.repeat(64) }).where(eq(projectFileVersions.id, restrictedFile.versionId))
  await denied(recordCommand(missingReviewer.recordId!, owner.id, 'confirm', { decision: 'confirm' }), 'RESP_EVIDENCE_INVALID')
  await db.update(projectFileVersions).set({ sha256: restrictedFile.sha256 }).where(eq(projectFileVersions.id, restrictedFile.versionId))
  const { responsibilityEvidenceLinks } = await import('../db/schema.js')
  await db.update(responsibilityEvidenceLinks).set({ sha256: '1'.repeat(64) }).where(eq(responsibilityEvidenceLinks.recordId, missingReviewer.recordId!))
  await denied(recordCommand(missingReviewer.recordId!, owner.id, 'confirm', { decision: 'confirm' }), 'RESP_EVIDENCE_CHANGED')
  await db.update(responsibilityEvidenceLinks).set({ sha256: restrictedFile.sha256 }).where(eq(responsibilityEvidenceLinks.recordId, missingReviewer.recordId!))
  await denied(actOnFdeFile(restrictedFile.fileId, leader.id, { action: 'trash', clientRequestId: randomUUID(), expectedVersion: 3, reason }), 'FILE_REFERENCED')
  await denied(deleteProject(project.id, owner.id), 'PROJECT_RESPONSIBILITY_HISTORY_PROTECTED')
  checks.push('reviewer-needs-every-evidence-file-missing-assignment-frozen-proof-and-soft-trash-history-protection')

  for (const uid of [admin.id, outsider.id]) { assert.equal((await list(uid, { projectId: project.id, view: 'managed' })).total, 0); await denied(detail(uid, completed.id), 'RESP_RECORD_FORBIDDEN') }
  const mine = await list(member.id, { projectId: project.id, pageSize: 1 }); assert.equal(mine.list.length, 1); assert.ok(mine.total > 1); assert.ok(mine.list.every(row => row.subjectId === member.id))
  checks.push('sql-scoped-pagination-counts-no-admin-or-outsider-business-leak')

  const failedTask = await createTask('来源事务失败必须回滚')
  const recordTable = quoteMysqlIdentifier(mysqlTableName('responsibility_records')), autoConstraint = quoteMysqlIdentifier(`resp_auto_${marker}`)
  const taskBefore = await task(failedTask)
  await db.execute(sql.raw(`ALTER TABLE ${recordTable} ADD CONSTRAINT ${autoConstraint} CHECK (task_id <> '${failedTask}')`))
  try { await assert.rejects(feedback(failedTask)) } finally { await db.execute(sql.raw(`ALTER TABLE ${recordTable} DROP CHECK ${autoConstraint}`)) }
  assert.deepEqual(await task(failedTask), taskBefore)
  assert.equal((await db.select().from(todoFeedbacks).where(eq(todoFeedbacks.todoId, failedTask))).length, 0)
  assert.equal((await taskRecords(failedTask)).length, 0)
  const faultCommand = randomUUID(), commandTable = quoteMysqlIdentifier(mysqlTableName('responsibility_commands')), commandConstraint = quoteMysqlIdentifier(`resp_command_${marker}`)
  const beforeRecord = await detail(owner.id, missingReviewer.recordId!), beforeEvents = await db.select().from(events), beforeNotices = await db.select().from(notices), beforeAudits = await db.select().from(auditLogs).where(eq(auditLogs.module, '管理参考'))
  await db.execute(sql.raw(`ALTER TABLE ${commandTable} ADD CONSTRAINT ${commandConstraint} CHECK (command_id <> '${faultCommand}')`))
  try { await assert.rejects(execute(project.id, owner.id, { action: 'confirm', commandId: faultCommand, recordId: missingReviewer.recordId, expectedVersion: beforeRecord.record.version, decision: 'confirm', reason })) } finally { await db.execute(sql.raw(`ALTER TABLE ${commandTable} DROP CHECK ${commandConstraint}`)) }
  assert.deepEqual(await detail(owner.id, missingReviewer.recordId!), beforeRecord); assert.deepEqual(await db.select().from(events), beforeEvents); assert.deepEqual(await db.select().from(notices), beforeNotices); assert.deepEqual(await db.select().from(auditLogs).where(eq(auditLogs.module, '管理参考')), beforeAudits)
  assert.equal((await db.select().from(commands).where(eq(commands.commandId, faultCommand))).length, 0)
  checks.push('real-mysql-late-failures-roll-back-task-feedback-record-proof-event-notice-command-audit')

  const { authRouter } = await import('../routes/auth.js'), { responsibilityRouter } = await import('../routes/responsibility.js'), { requireAuth } = await import('../middleware/requireAuth.js'), { errorHandler } = await import('../middleware/errorHandler.js')
  const lost = new Set<string>()
  const app = express(); app.use(express.json()); app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next)); app.use('/api/auth', authRouter)
  app.use('/api/responsibility', (req, res, next) => { if (lost.delete(req.body?.commandId)) res.json = function () { this.destroy(); return this }; next() })
  app.use('/api/responsibility', responsibilityRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.AUTH_ALLOWED_ORIGINS = base
  const sessions = new Map<string, { cookie: string; csrf: string }>()
  for (const person of [owner, member, leader, admin, outsider]) {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: person.email, password }) }); assert.equal(response.status, 200)
    const cookies = response.headers.getSetCookie(); sessions.set(person.id, { cookie: cookies.map(value => value.split(';')[0]).join('; '), csrf: decodeURIComponent(cookies.find(value => value.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length)) })
  }
  const request = (uid: string, path: string, body?: unknown, extra: Record<string, string> = {}) => { const session = sessions.get(uid)!; return fetch(`${base}/api/responsibility${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) }) }
  const path = `/projects/${project.id}/commands`
  assert.equal((await fetch(`${base}/api/responsibility`)).status, 401)
  assert.equal((await request(outsider.id, '/' + completed.id)).status, 403)
  const listing = await request(member.id, '?projectId=' + project.id); assert.equal(listing.status, 200); assert.equal(listing.headers.get('cache-control'), 'private, no-store')
  assert.equal((await request(owner.id, path, confirm, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await request(owner.id, path, confirm, { Origin: 'https://forbidden.invalid' })).status, 403)
  assert.equal((await request(owner.id, path, { ...confirm, actorId: member.id })).status, 400)
  const lostConfirm = { action: 'confirm', commandId: randomUUID(), recordId: missingReviewer.recordId, expectedVersion: beforeRecord.record.version, decision: 'confirm', reason }
  lost.add(lostConfirm.commandId); await assert.rejects(request(owner.id, path, lostConfirm))
  const recovered = await request(owner.id, path + '/recover', { commandId: lostConfirm.commandId }); assert.equal(recovered.status, 200)
  const recovery = await recovered.json() as { state: string; receipt: unknown }; assert.equal(recovery.state, 'committed')
  const retry = await request(owner.id, path, lostConfirm); assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), recovery.receipt)
  const late = { ...lostConfirm, commandId: randomUUID(), expectedVersion: (await detail(owner.id, missingReviewer.recordId!)).record.version }
  assert.equal((await recover(project.id, owner.id, { commandId: late.commandId })).state, 'not_committed')
  await denied(execute(project.id, owner.id, late), 'RESP_COMMAND_CLOSED')
  await denied(recover(randomUUID(), owner.id, { commandId: lostConfirm.commandId }), 'RESP_COMMAND_REUSED')
  await db.update(users).set({ status: '禁用' }).where(eq(users.id, owner.id))
  await denied(recover(project.id, owner.id, { commandId: lostConfirm.commandId }), 'RESP_ACTOR_FORBIDDEN')
  await db.update(users).set({ status: '启用' }).where(eq(users.id, owner.id))
  checks.push('real-session-csrf-origin-response-loss-replay-sealed-late-command-and-disabled-actor')

  const serialize = <T>(value: T) => JSON.parse(JSON.stringify(value))
  for (const person of [owner, member, leader, admin, outsider]) {
    const overview = responsibilityOverview.parse(await getResponsibilityOverview(person.id))
    assert.equal(overview.management, person.id === leader.id)
    assert.equal(overview.mine, (await list(person.id)).total)
    assert.equal(overview.review, (await list(person.id, { view: 'review' })).total)
    assert.equal(overview.assignmentAccess, [owner.id, leader.id].includes(person.id))
    if (overview.assignmentAccess) assert.equal(overview.assignment, (await list(person.id, { view: 'assignment' })).total)
    if ([admin.id, outsider.id].includes(person.id)) assert.deepEqual(overview, { management: false, assignmentAccess: false, assignment: 0, mine: 0, review: 0, unread: 0 })
  }
  assert.equal(responsibilityList.parse(serialize(await list(member.id))).list.every(row => row.subjectName === member.name), true)
  const httpTask = await createTask('申诉复核响应丢失页面合同'), httpFeedback = await feedback(httpTask, 'submission'), httpReturn = await decide(httpTask, httpFeedback.id, 'return')
  const httpCandidate = await propose(httpTask, 'incorrect_completion', httpReturn.id)
  await recordCommand(httpCandidate.recordId!, owner.id, 'confirm', { decision: 'confirm' })
  const mineDetail = responsibilityDetail.parse(serialize(await detail(member.id, httpCandidate.recordId!)))
  assert.equal(mineDetail.capabilities.appeal, true); assert.equal(mineDetail.capabilities.review, false)
  assert.equal(mineDetail.subjectName, member.name); assert.equal(mineDetail.reviewerName, owner.name)
  const options = responsibilityEvidenceChoices.parse(await responsibilityEvidenceOptions(member.id, httpCandidate.recordId!, {}))
  assert.ok(options.list.some(item => item.fileId === file.fileId && item.version === 1))
  await denied(responsibilityEvidenceOptions(outsider.id, httpCandidate.recordId!, {}), 'RESP_RECORD_FORBIDDEN')
  assert.equal((await request(member.id, '/overview')).status, 200)
  assert.equal((await request(member.id, `/${httpCandidate.recordId}/evidence-options`)).status, 200)
  const appealCommand = { commandId: randomUUID(), action: 'appeal', recordId: httpCandidate.recordId, expectedVersion: mineDetail.record.version, evidence, reason }
  lost.add(appealCommand.commandId); await assert.rejects(request(member.id, path, appealCommand))
  const appealRecovery = await (await request(member.id, path + '/recover', { commandId: appealCommand.commandId })).json() as { state: string }
  assert.equal(appealRecovery.state, 'committed')
  const reviewerDetail = responsibilityDetail.parse(serialize(await detail(owner.id, httpCandidate.recordId!)))
  assert.equal(reviewerDetail.capabilities.review, true); assert.equal(reviewerDetail.appeal?.reason, reason); assert.equal(reviewerDetail.appeal?.evidence.length, 1)
  const reviewCommand = { commandId: randomUUID(), action: 'review', recordId: httpCandidate.recordId, expectedVersion: reviewerDetail.record.version, decision: 'revoke', adjustedPoints: null, reason }
  lost.add(reviewCommand.commandId); await assert.rejects(request(owner.id, path, reviewCommand))
  assert.equal((await recover(project.id, owner.id, { commandId: reviewCommand.commandId })).state, 'committed')
  assert.equal((await request(owner.id, path, reviewCommand)).status, 200)
  const history = await db.select().from(events).where(eq(events.recordId, httpCandidate.recordId!))
  assert.equal(history.filter(event => event.action === 'appeal').length, 1); assert.equal(history.filter(event => event.action === 'review').length, 1)
  assert.equal((await detail(member.id, httpCandidate.recordId!)).capabilities.appeal, false)
  checks.push('view-capabilities-stable-names-current-file-options-and-appeal-review-authenticated-response-loss')

  const ownRiskRecords: string[] = []
  const assignmentFile = await makeFile(owner)
  await setFdeFilePermissions(assignmentFile.fileId, owner.id, { clientRequestId: randomUUID(), expectedVersion: 1, reason, grants: [{ userId: owner.id, canView: true, canDownload: true }, { userId: leader.id, canView: true, canDownload: false }] })
  for (let i = 0; i < 2; i++) {
    const source = await createRisk({ projectId: project.id, projectName: project.name, title: `项目负责人本人风险-${i}`, type: '财务', level: '高' }, owner.id, owner.name)
    const proposed = await propose(riskTask, 'major_risk', source.id, null, [{ fileId: assignmentFile.fileId, version: 1 }])
    ownRiskRecords.push(proposed.recordId!)
    assert.equal((await detail(owner.id, proposed.recordId!)).record.reviewerId, leader.id)
  }
  const leaderRoles = await db.select().from(userRoles).where(eq(userRoles.userId, leader.id))
  await db.delete(userRoles).where(eq(userRoles.userId, leader.id))
  assert.equal((await detail(owner.id, ownRiskRecords[0])).assignmentState, 'invalid')
  const page1 = await list(owner.id, { view: 'assignment', pageSize: 1 }), page2 = await list(owner.id, { view: 'assignment', pageSize: 1, page: 2 })
  assert.equal(page1.total, 2); assert.equal(page2.total, 2)
  assert.deepEqual(new Set([...page1.list, ...page2.list].map(row => row.id)), new Set(ownRiskRecords))
  assert.equal((await list(owner.id, { view: 'assignment', pageSize: 1, page: 3 })).list.length, 0)
  assert.equal((await list(owner.id, { view: 'assignment', status: 'effective' })).total, 0)
  assert.equal((await getResponsibilityOverview(owner.id)).assignment, 2)
  assert.equal((await list(leader.id, { view: 'review' })).total, 0)
  assert.equal((await getResponsibilityOverview(leader.id)).review, 0)
  const oldVersion = (await detail(owner.id, ownRiskRecords[0])).record.version
  const reroute = { commandId: randomUUID(), action: 'reroute', recordId: ownRiskRecords[0], expectedVersion: oldVersion, reason }
  lost.add(reroute.commandId); await assert.rejects(request(owner.id, path, reroute))
  const rerouteRecovered = await (await request(owner.id, path + '/recover', { commandId: reroute.commandId })).json() as { state: string }
  assert.equal(rerouteRecovered.state, 'committed')
  assert.equal((await request(owner.id, path, reroute)).status, 200)
  const stillMissing = await detail(owner.id, ownRiskRecords[0])
  assert.equal(stillMissing.assignmentState, 'unassigned'); assert.equal(stillMissing.record.version, oldVersion + 1)
  assert.equal(stillMissing.capabilities.confirm, false)
  assert.equal((await request(owner.id, path, { ...reroute, commandId: randomUUID() })).status, 409)
  assert.equal((await request(owner.id, path, { ...reroute, reviewerId: owner.id })).status, 400)
  for (const person of [admin, outsider, member, leader]) assert.equal((await request(person.id, '?view=assignment')).status, 403)
  await db.insert(userRoles).values(leaderRoles)
  await recordCommand(ownRiskRecords[0], owner.id, 'reroute')
  assert.equal((await detail(owner.id, ownRiskRecords[0])).assignmentState, 'assigned')
  assert.equal((await getResponsibilityOverview(owner.id)).assignment, 0)
  await denied(recordCommand(ownRiskRecords[0], owner.id, 'confirm', { decision: 'confirm' }), 'RESP_REVIEW_FORBIDDEN')
  const noticeRows = await db.select().from(notices).where(eq(notices.recordId, ownRiskRecords[0]))
  assert.equal(noticeRows.filter(row => !row.closedAt).length, 1)
  assert.equal(noticeRows.find(row => !row.closedAt)?.recipientId, leader.id)
  checks.push('revoked-role-pagination-current-review-counts-authenticated-reroute-loss-recovery-no-client-assignee')

  const ownerProof = await makeFile(owner)
  await setFdeFilePermissions(ownerProof.fileId, owner.id, { clientRequestId: randomUUID(), expectedVersion: 1, reason, grants: [{ userId: owner.id, canView: true, canDownload: true }, { userId: leader.id, canView: true, canDownload: false }] })
  const proofRisk = await createRisk({ projectId: project.id, projectName: project.name, title: '处理人证据权限被撤销', type: '财务', level: '高' }, owner.id, owner.name)
  const proofRecord = await propose(riskTask, 'major_risk', proofRisk.id, null, [{ fileId: ownerProof.fileId, version: 1 }])
  assert.equal((await detail(owner.id, proofRecord.recordId!)).assignmentState, 'assigned')
  await setFdeFilePermissions(ownerProof.fileId, owner.id, { clientRequestId: randomUUID(), expectedVersion: 2, reason, grants: [{ userId: owner.id, canView: true, canDownload: true }] })
  assert.equal((await detail(owner.id, proofRecord.recordId!)).assignmentState, 'invalid')
  assert.equal((await getResponsibilityOverview(owner.id)).assignment, 1)
  await denied(detail(leader.id, proofRecord.recordId!), 'RESP_RECORD_FORBIDDEN')
  const assignmentFault = randomUUID(), assignmentBefore = await detail(owner.id, proofRecord.recordId!)
  const assignmentEvents = await db.select().from(events), assignmentNotices = await db.select().from(notices), assignmentAudits = await db.select().from(auditLogs).where(eq(auditLogs.module, '管理参考'))
  await db.execute(sql.raw(`ALTER TABLE ${commandTable} ADD CONSTRAINT ${commandConstraint} CHECK (command_id <> '${assignmentFault}')`))
  try { await assert.rejects(execute(project.id, owner.id, { action: 'reroute', commandId: assignmentFault, recordId: proofRecord.recordId, expectedVersion: assignmentBefore.record.version, reason })) }
  finally { await db.execute(sql.raw(`ALTER TABLE ${commandTable} DROP CHECK ${commandConstraint}`)) }
  assert.deepEqual(await detail(owner.id, proofRecord.recordId!), assignmentBefore)
  assert.deepEqual(await db.select().from(events), assignmentEvents); assert.deepEqual(await db.select().from(notices), assignmentNotices); assert.deepEqual(await db.select().from(auditLogs).where(eq(auditLogs.module, '管理参考')), assignmentAudits)
  assert.equal((await db.select().from(commands).where(eq(commands.commandId, assignmentFault))).length, 0)
  checks.push('evidence-revocation-invalidates-assignee-without-granting-access-reroute-late-failure-atomic-rollback')

  const finalHead = (await listResponsibilityPolicies(admin.id)).policy!
  await policyCommand(admin.id, { action: 'toggle', commandId: randomUUID(), expectedPolicyVersion: finalHead.version, enabled: false, reason })
  const afterDisabled = await createTask('停用后不追加责任'), afterDisabledFeedback = await feedback(afterDisabled, 'submission'); await decide(afterDisabled, afterDisabledFeedback.id, 'accept')
  assert.equal((await taskRecords(afterDisabled)).length, 0)
  assert.deepEqual(new Set((await db.select().from(records).where(eq(records.projectId, project.id))).map(row => row.eventCode)), new Set(responsibilityEvents.map(event => event.code)))
  checks.push('all-eight-event-types-exercised-policy-disabled-after-fixture-no-production-policy')
  console.log(JSON.stringify({ ok: true, scope: 'fde-responsibility-source-ledger-not-full-management', checks, count: checks.length, browserVerified: false, automaticScannerCoveredByThisScript: false, productionPolicyApproved: false }))
} finally {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
  await pool.end()
}
