import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { and, asc, eq, isNotNull } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { fdeTypeExecutionEvents, fdeTypeInstances, fdeWorkflowPolicies, leaderTimeEvents, leaderTimeNotices, leaderTimeRequests, oaApprovalRequests, projectDutyAssignments, projectFiles, projectFileVersions, projectMembers, projectPlanActions, projectPlans, projectTimelineSyncs, projectTimelineTasks, projectWeeklyPlanItems, projects, todoFeedbacks, todos, userRoles, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { executeTypePolicy, getTypePolicy, listTypePolicies } from '../services/fdeTypePolicyService.js'
import { executeTypeRuntime, getTypeRuntime, recoverTypeRuntime } from '../services/fdeTypeRuntimeService.js'
import { actOnLeaderTime, listLeaderTimes } from '../services/fdeLeaderTimeService.js'
import { readTimelineTimeSource } from '../services/fdeTimelineTimeService.js'
import { actOnFdeTaskExtension, cancelFdeTask, decideFdeTask, feedbackFdeTask, requestFdeTaskExtension } from '../services/fdeTaskService.js'
import { saveProjectFile } from '../services/projectFileStorageService.js'
import { proposeFdeGovernance, decideFdeGovernance } from '../services/fdeGovernanceService.js'
import { listCalendar, writeCalendarEvent, cancelCalendarEvent } from '../services/fdeCalendarService.js'
import { collectReportCalendar } from '../services/fdeWeeklyReportSourcesService.js'
import { previewAutoSchedule } from '../services/fdeAutoScheduleService.js'
import { timeLocal } from '../contracts/fdeTimeContract.js'
import { weekStartFor } from '../contracts/fdeWeeklyPlanContract.js'
import { typePolicyFixture } from './fdeTypePolicyFixture.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const mark = randomUUID().slice(0, 8), checks: string[] = []
const actors = ['系统管理员', '投资经理', '投资经理', '董事长', '董事长', '投资经理', '时间协调人'].map((role, i) => ({ id: randomUUID(), role, name: `非投时间-${mark}-${i}`, email: `type-time-${mark}-${i}@accept.invalid`, department: `隔离-${mark}`, passwordHash: 'isolated-no-login' }))
const [admin, owner, secretary, leader, replacement, outsider, coordinator] = actors
const rejected = (promise: Promise<unknown>, code: string) => assert.rejects(promise, e => (e as { code?: string }).code === code)
try {
  const oldProjects = await db.select().from(projects).orderBy(asc(projects.id))
  await db.insert(users).values(actors)
  for (const person of actors) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
  const configuration = typePolicyFixture()
  configuration.planApprovals = [{ duty: 'concerned_leader', name: '独立审核计划', mode: '会签' }]
  configuration.actions[0].duty = 'owner'; configuration.actions[0].needLeader = true; configuration.actions[1].needLeader = false
  const head = (await listTypePolicies(admin.id)).policies.find(p => p.code === 'noninvestment:fundraising')
  const created = await executeTypePolicy(admin.id, { action: 'create', commandId: randomUUID(), expectedPolicyVersion: head?.version ?? 0, configuration, reason: '隔离合成领导来源规则' })
  const approved = await executeTypePolicy(leader.id, { action: 'approve', commandId: randomUUID(), policyId: created.policyId, versionId: created.versionId, expectedVersion: created.version, reason: '独立复核隔离合成规则' })
  await executeTypePolicy(admin.id, { action: 'publish', commandId: randomUUID(), policyId: created.policyId, versionId: created.versionId, expectedVersion: approved.version, expectedPolicyVersion: approved.policyVersion, reason: '仅发布隔离合成版本' })
  const policy = (await getTypePolicy(admin.id, created.policyId)).versions.find(v => v.id === created.versionId)!
  // Only this random-prefix fixture may enable its synthetic policy and seed a bound project.
  await db.update(fdeWorkflowPolicies).set({ enabled: true }).where(eq(fdeWorkflowPolicies.id, policy.policyId))
  const projectId = randomUUID()
  await db.insert(projects).values({ id: projectId, name: `非投资领导闭环-${mark}`, owner: owner.name, ownerUserId: owner.id, createdBy: owner.id, workflowModel: 'fde-v1', projectType: '基金募资项目', workflowPolicyVersionId: policy.id, stage: configuration.stages[0].name, classification: 'normal', lifecycle: 'active', targetDate: '2027-04-30', cycleDays: 50 })
  await db.insert(projectMembers).values([owner, secretary, leader, replacement].map(p => ({ projectId, userId: p.id, memberRole: p.id === owner.id ? 'owner' : 'member', sourceName: p.name })))
  await db.insert(projectDutyAssignments).values([{ projectId, userId: secretary.id, duty: 'secretary', assignedBy: owner.id }, { projectId, userId: leader.id, duty: 'concerned_leader', assignedBy: owner.id }])
  const get = () => getTypeRuntime(projectId, secretary.id)
  const rows = () => db.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.projectId, projectId)).orderBy(asc(leaderTimeRequests.id))
  const row = async (id: string) => (await rows()).find(r => r.id === id)!
  const command = async (action: string, extra: object = {}) => ({ action, commandId: randomUUID(), expectedVersion: (await get()).instance?.version ?? 0, reason: '隔离核对原计划行动与领导需求', ...extra })
  const reconcile = async () => executeTypeRuntime(projectId, secretary.id, await command('reconcile_times'))
  const plan = { expectedProjectVersion: 1, expectedGovernanceVersion: 1, expectedPolicyVersionId: policy.id, expectedPolicySha256: policy.sha256, cycleDays: 50, targetDate: '2027-04-30', selections: configuration.actions.map(a => ({ actionKey: a.key, userId: owner.id, dueTime: '18:07' })) }
  await executeTypeRuntime(projectId, secretary.id, await command('save_plan', { plan }))
  await executeTypeRuntime(projectId, secretary.id, await command('submit_plan'))
  const review = (await get()).reviews[0], publish = await command('decide', { requestId: review.id, expectedReviewVersion: review.version, decision: 'approve' })
  assert.equal((await rows()).length, 0)
  // This failure occurs after plan/task/source reconciliation; the whole command must roll back.
  const faultId = randomUUID()
  await db.insert(fdeTypeExecutionEvents).values({ id: faultId, projectId, actorId: secretary.id, commandId: randomUUID(), action: 'save_plan', version: publish.expectedVersion + 1, reason: '隔离后段事务故障', snapshot: {} })
  await assert.rejects(executeTypeRuntime(projectId, leader.id, publish))
  assert.equal((await db.select().from(todos).where(eq(todos.projectId, projectId))).length, 0)
  assert.equal((await db.select().from(projectPlans).where(eq(projectPlans.projectId, projectId))).length, 0)
  assert.equal((await db.select().from(projectTimelineSyncs).where(eq(projectTimelineSyncs.projectId, projectId))).length, 0)
  await db.delete(fdeTypeExecutionEvents).where(eq(fdeTypeExecutionEvents.id, faultId))
  const receipt = await executeTypeRuntime(projectId, leader.id, publish)
  assert.deepEqual(await executeTypeRuntime(projectId, leader.id, publish), receipt)
  assert.equal((await rows()).length, 0)
  assert.ok((await get()).leaderTimes.issues.some(s => s.includes('牵头领导')))
  assert.equal((await db.select().from(projectTimelineSyncs).where(and(eq(projectTimelineSyncs.projectId, projectId), eq(projectTimelineSyncs.status, 'pending')))).length, 1)
  checks.push('approved-plan-atomic:late-failure-no-tasks-or-pending:missing-leader-durable-no-demo-fallback:command-replay')

  const baseAssignments = [{ duty: 'secretary' as const, userId: secretary.id }, { duty: 'concerned_leader' as const, userId: leader.id }, { duty: 'member' as const, userId: replacement.id }]
  const govern = async (assignments: Parameters<typeof proposeFdeGovernance>[0]['assignments']) => {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
    return proposeFdeGovernance({ projectId, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '隔离验证有效牵头领导配置', assignments })
  }
  await rejected(govern([{ duty: 'secretary', userId: secretary.id }, { duty: 'executive_lead', userId: leader.id }]), 'FDE_EXECUTIVE_LEAD_INVALID')
  await rejected(govern([...baseAssignments, { duty: 'concerned_leader', userId: replacement.id }, { duty: 'executive_lead', userId: leader.id }, { duty: 'executive_lead', userId: replacement.id }]), 'FDE_EXECUTIVE_LEAD_INVALID')
  assert.equal((await govern([...baseAssignments, { duty: 'executive_lead', userId: leader.id }])).status, 'applied')
  let first = (await rows())[0]
  assert.equal((await rows()).length, 1); assert.ok(first.sourceTypeActionId)
  assert.equal(first.sourceTimelineTaskId, null); assert.equal(first.sourceWeeklyItemId, null); assert.equal(first.sourceDirectiveId, null)
  assert.equal(first.submittedBy, secretary.id); assert.equal(first.leaderId, leader.id); assert.equal(first.status, 'requested')
  const [action] = await db.select().from(projectPlanActions).where(eq(projectPlanActions.id, first.sourceTypeActionId!))
  const [task] = await db.select().from(todos).where(eq(todos.id, first.taskId!))
  assert.equal(task.planActionId, action.id); assert.equal(task.ownerUserId, owner.id); assert.equal(action.actionKey, configuration.actions[0].key)
  assert.equal(timeLocal(first.latestFinish!), `${task.dueDate}T18:07`)
  assert.equal((await db.select().from(projectTimelineTasks).where(eq(projectTimelineTasks.projectId, projectId))).length, 0)
  assert.equal((await db.select().from(projectWeeklyPlanItems).where(eq(projectWeeklyPlanItems.taskId, task.id))).length, 0)
  assert.equal((await db.select().from(projectTimelineSyncs).where(and(eq(projectTimelineSyncs.projectId, projectId), eq(projectTimelineSyncs.status, 'pending')))).length, 0)
  await assert.rejects(db.update(leaderTimeRequests).set({ sourceTypeActionId: randomUUID() }).where(eq(leaderTimeRequests.id, first.id)))
  await assert.rejects(db.update(leaderTimeRequests).set({ taskId: null }).where(eq(leaderTimeRequests.id, first.id)))
  const copy = { ...first, id: randomUUID() }; await assert.rejects(db.insert(leaderTimeRequests).values(copy))
  checks.push('real-governance-hook:single-concerned-executive:stable-plan-action-FK:original-applicant:not-weekly-or-investment:pending-resolved')

  const sync = await command('reconcile_times')
  await rejected(executeTypeRuntime(projectId, outsider.id, sync), 'TYPE_RUNTIME_FORBIDDEN')
  const before = await rows(), result = await executeTypeRuntime(projectId, secretary.id, sync)
  assert.deepEqual(await executeTypeRuntime(projectId, secretary.id, sync), result)
  assert.deepEqual((await recoverTypeRuntime(projectId, secretary.id, { commandId: sync.commandId })).receipt, result)
  assert.deepEqual(await rows(), before)
  const week = weekStartFor(task.dueDate!)
  const listed = (await listLeaderTimes(leader.id, week)).list.find(r => r.id === first.id)!
  assert.equal(listed.timelineSource?.kind, 'type_execution'); assert.equal(listed.capabilities.confirm, true)
  assert.equal((await listLeaderTimes(outsider.id, week)).list.some(r => r.id === first.id), false)
  assert.ok((await get()).leaderTimes.requests[0].target.includes(`request=${first.id}`))
  assert.deepEqual(await rows(), before)
  checks.push('reconcile-command-idempotency-recovery:outsider-denied:exact-source-view-and-link:no-GET-writes')

  const act = async (id: string, action: string, userId = leader.id, extra = {}) => actOnLeaderTime(id, userId, { clientRequestId: randomUUID(), expectedVersion: (await row(id)).version, action, reason: '隔离核对真实来源排期', ...extra })
  await rejected(act(first.id, 'confirm', coordinator.id), 'TIME_ACTION_FORBIDDEN')
  const calendar = await writeCalendarEvent(leader.id, { clientRequestId: randomUUID(), definition: { title: '隔离既有私人占用', detail: '', startsAt: timeLocal(first.scheduledStart!), endsAt: timeLocal(new Date(first.scheduledStart!.getTime() + 45 * 60000)), visibility: 'private' } })
  await rejected(act(first.id, 'confirm'), 'TIME_CONFLICT')
  await cancelCalendarEvent(calendar.id, leader.id, { clientRequestId: randomUUID(), expectedVersion: 1, reason: '隔离撤销冲突后确认' })
  await act(first.id, 'confirm'); first = await row(first.id)
  assert.equal(first.status, 'confirmed')
  assert.ok((await listCalendar(secretary.id, week, 'personal')).items.some(r => r.id === first.id && r.source === 'leader' && r.target?.includes(first.id)))
  const report = await collectReportCalendar(db, secretary.id, [projectId], week, { calendar: true, privateCalendar: false, independentWork: false, office: false, projectTimeline: false })
  assert.ok(report?.some(r => r.id === first.id && r.taskId === task.id && r.source === 'leader'))
  checks.push('designated-leader-only:private-conflict-protected:confirmation-enters-calendar-and-original-applicant-report')

  const rolesBefore = await db.select().from(userRoles).where(eq(userRoles.userId, leader.id))
  await db.delete(userRoles).where(eq(userRoles.userId, leader.id))
  assert.equal((await readTimelineTimeSource(db, await row(first.id)))?.view.needed, false)
  assert.ok((await get()).leaderTimes.issues.length)
  const skipped = await previewAutoSchedule(coordinator.id, { weekStart: week, requests: [{ id: first.id, expectedVersion: first.version }] })
  assert.equal(skipped.items[0].result, 'skipped')
  await db.insert(userRoles).values(rolesBefore)
  assert.equal((await readTimelineTimeSource(db, await row(first.id)))?.view.changed, false)
  checks.push('live-role-revocation-blocks-stale-source:read-only-warning:auto-schedule-cannot-bypass')

  const newDate = new Date(`${task.dueDate}T00:00:00Z`); newDate.setUTCDate(newDate.getUTCDate() + 2)
  const due = newDate.toISOString().slice(0, 10)
  await requestFdeTaskExtension(projectId, task.id, owner.id, { expectedVersion: task.version, requestedDueDate: due, requestedDueTime: '19:13', reviewerUserId: leader.id, reason: '隔离真实延期需独立批准' })
  assert.deepEqual(await row(first.id), first)
  const [extension] = await db.select().from(oaApprovalRequests).where(and(eq(oaApprovalRequests.taskId, task.id), eq(oaApprovalRequests.businessType, 'task_extension')))
  await actOnFdeTaskExtension({ requestId: extension.id, userId: leader.id, action: 'approve', expectedVersion: extension.lockVersion, comment: '独立批准有效任务期限' })
  assert.deepEqual(await row(first.id), first)
  assert.equal((await readTimelineTimeSource(db, first))?.view.changed, true)
  await rejected(act(first.id, 'coordinate', leader.id, { scheduledStart: `${due}T09:00`, durationMinutes: 45 }), 'TIME_SOURCE_CHANGED')
  await act(first.id, 'refresh-source', owner.id)
  let refreshed = await row(first.id)
  assert.equal(refreshed.status, 'requested'); assert.equal(refreshed.confirmedAt, null); assert.equal(timeLocal(refreshed.latestFinish!), `${due}T19:13`)
  assert.equal(refreshed.scheduledStart!.getTime(), first.scheduledStart!.getTime())
  await act(first.id, 'confirm'); first = await row(first.id)
  checks.push('real-extension-approval:no-request-mutation-before-approval:confirmed-slot-protected:explicit-refresh-reconfirmation')

  const change = await govern([{ duty: 'secretary', userId: secretary.id }, { duty: 'concerned_leader', userId: leader.id }, { duty: 'concerned_leader', userId: replacement.id }, { duty: 'executive_lead', userId: replacement.id }])
  assert.equal(change.status, 'awaiting_confirmation'); assert.ok(change.requiredConfirmers.includes(leader.id)); assert.equal((await rows()).length, 1)
  let changeVersion = change.version
  for (const userId of change.requiredConfirmers) changeVersion = (await decideFdeGovernance({ projectId, changeId: change.id, userId, decision: 'confirm', comment: '相关原领导确认职责交接', expectedVersion: changeVersion })).version
  assert.deepEqual(await row(first.id), first)
  assert.equal((await readTimelineTimeSource(db, first))?.view.needed, false)
  const next = (await rows()).find(r => r.leaderId === replacement.id)!
  assert.ok(next); assert.equal(next.sourceTypeActionId, first.sourceTypeActionId); assert.equal(next.submittedBy, secretary.id); assert.equal(next.status, 'requested')
  await act(first.id, 'cancel', owner.id)
  const [currentTask] = await db.select().from(todos).where(eq(todos.id, task.id))
  await rejected(cancelFdeTask(projectId, task.id, owner.id, currentTask.version, '已批准行动不得通过单独取消结束'), 'FDE_PLAN_LOCKED')
  const fileId = randomUUID(), bytes = Buffer.from(`隔离非投资行动实际成果-${mark}`), sha256 = createHash('sha256').update(bytes).digest('hex')
  const storagePath = await saveProjectFile(projectId, fileId, bytes)
  await db.insert(projectFiles).values({ id: fileId, projectId, name: '领导参与行动成果.txt', type: 'TXT', category: '项目资料', uploader: owner.name, uploadedBy: owner.id, storagePath, byteSize: bytes.length, sha256 })
  await db.insert(projectFileVersions).values({ fileId, version: 1, storagePath, byteSize: bytes.length, sha256, createdBy: owner.id })
  await feedbackFdeTask(projectId, task.id, owner.id, { expectedVersion: currentTask.version, kind: 'submission', progress: 100, result: '提交真实成果供独立验收', evidence: [{ fileId, version: 1 }] })
  const [submittedTask] = await db.select().from(todos).where(eq(todos.id, task.id))
  const [feedback] = await db.select().from(todoFeedbacks).where(eq(todoFeedbacks.todoId, task.id))
  await decideFdeTask(projectId, task.id, replacement.id, { expectedVersion: submittedTask.version, feedbackId: feedback.id, action: 'accept', reason: '独立核对成果原件并验收完成' })
  assert.equal((await row(next.id)).status, 'withdrawn'); assert.equal((await row(next.id)).sourceRetired, true)
  await reconcile(); assert.equal((await rows()).length, 2); assert.equal((await row(first.id)).status, 'cancelled')
  checks.push('executive-change-needs-original-confirmation:confirmed-request-never-silently-cancelled:new-leader-original-applicant:terminal-task-retires-only-untouched-request')

  const [instance] = await db.select().from(fdeTypeInstances).where(eq(fdeTypeInstances.projectId, projectId))
  await db.update(fdeTypeInstances).set({ planHash: '0'.repeat(64) }).where(eq(fdeTypeInstances.projectId, projectId))
  await rejected(readTimelineTimeSource(db, await row(next.id)), 'TIME_TYPE_SOURCE_INTEGRITY')
  await db.update(fdeTypeInstances).set({ planHash: instance.planHash }).where(eq(fdeTypeInstances.projectId, projectId))
  assert.ok((await db.select().from(leaderTimeEvents).where(eq(leaderTimeEvents.timeRequestId, first.id))).some(e => e.action === 'type_execution-create'))
  assert.ok((await db.select().from(leaderTimeNotices).where(eq(leaderTimeNotices.timeRequestId, next.id))).length)
  checks.push('bound-plan-integrity-fails-closed:events-notices-preserved:unrelated-projects-unchanged')

  // Also fail after a *real generated request*, not only after the missing-duty journal above.
  const completeProjectId = randomUUID()
  await db.insert(projects).values({ id: completeProjectId, name: `非投资来源原子性-${mark}`, owner: owner.name, ownerUserId: owner.id, createdBy: owner.id, workflowModel: 'fde-v1', projectType: '基金募资项目', workflowPolicyVersionId: policy.id, stage: configuration.stages[0].name, classification: 'normal', lifecycle: 'active', targetDate: '2027-04-30', cycleDays: 50 })
  await db.insert(projectMembers).values([owner, secretary, leader].map(p => ({ projectId: completeProjectId, userId: p.id, memberRole: p.id === owner.id ? 'owner' : 'member', sourceName: p.name })))
  await db.insert(projectDutyAssignments).values([{ projectId: completeProjectId, userId: secretary.id, duty: 'secretary', assignedBy: owner.id }, { projectId: completeProjectId, userId: leader.id, duty: 'concerned_leader', assignedBy: owner.id }, { projectId: completeProjectId, userId: leader.id, duty: 'executive_lead', assignedBy: owner.id }])
  const base = { reason: '验证有领导来源时的整笔事务与并发' }
  await executeTypeRuntime(completeProjectId, secretary.id, { ...base, action: 'save_plan', commandId: randomUUID(), expectedVersion: 0, plan })
  await executeTypeRuntime(completeProjectId, secretary.id, { ...base, action: 'submit_plan', commandId: randomUUID(), expectedVersion: 1 })
  const completeReview = (await getTypeRuntime(completeProjectId, leader.id)).reviews[0]
  const finalCommand = { ...base, action: 'decide', commandId: randomUUID(), expectedVersion: 2, requestId: completeReview.id, expectedReviewVersion: completeReview.version, decision: 'approve' }
  const failureId = randomUUID()
  await db.insert(fdeTypeExecutionEvents).values({ id: failureId, projectId: completeProjectId, actorId: secretary.id, commandId: randomUUID(), action: 'save_plan', version: 3, reason: '隔离领导需求生成后的后段故障', snapshot: {} })
  await assert.rejects(executeTypeRuntime(completeProjectId, leader.id, finalCommand))
  assert.equal((await db.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.projectId, completeProjectId))).length, 0)
  assert.equal((await db.select().from(todos).where(eq(todos.projectId, completeProjectId))).length, 0)
  assert.equal((await getTypeRuntime(completeProjectId, leader.id)).instance!.version, 2)
  await db.delete(fdeTypeExecutionEvents).where(eq(fdeTypeExecutionEvents.id, failureId))
  const concurrent = await Promise.allSettled([executeTypeRuntime(completeProjectId, leader.id, finalCommand), executeTypeRuntime(completeProjectId, leader.id, { ...finalCommand, commandId: randomUUID() })])
  assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1)
  const committed = (await db.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.projectId, completeProjectId)))[0]
  assert.ok(committed.sourceTypeActionId); assert.equal(committed.status, 'requested'); assert.equal(committed.submittedBy, secretary.id)
  assert.equal((await db.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.projectId, completeProjectId))).length, 1)
  assert.equal((await db.select().from(leaderTimeEvents).where(eq(leaderTimeEvents.timeRequestId, committed.id))).length, 1)
  assert.deepEqual((await db.select().from(projects).orderBy(asc(projects.id))).filter(p => p.id !== projectId && p.id !== completeProjectId), oldProjects)
  checks.push('complete-leader-plan-late-failure-rolls-back-real-request-and-tasks:concurrent-final-approval-one-source-event')
  console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, projectId, checks }))
} finally { await pool.end() }
