import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { leaderTimeEvents, leaderTimeRequests, oaApprovalRequests, projects, projectTimelineTasks, todos, userRoles, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { createProject, classifyProject } from '../services/projectService.js'
import { decideFdeGovernance, proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { bindFdeMaterial, getFdeWorkflow, saveFdePlan } from '../services/fdeWorkflowService.js'
import { previewTimelineTasks, syncTimelineTasks } from '../services/fdeTimelineTaskService.js'
import { readTimelineTimeSource, syncTimelineLeaderTimes } from '../services/fdeTimelineTimeService.js'
import { actOnLeaderTime, createLeaderTime, listLeaderTimes } from '../services/fdeLeaderTimeService.js'
import { previewAutoSchedule } from '../services/fdeAutoScheduleService.js'
import { actOnOaApprovalRequest, createOaApprovalRequest } from '../services/oaWorkflowService.js'
import { actOnFdeTaskExtension, cancelFdeTask, getFdeTasks, requestFdeTaskExtension } from '../services/fdeTaskService.js'
import { shiftDate, weekStartFor } from '../contracts/fdeWeeklyPlanContract.js'
import { timeLocal } from '../contracts/fdeTimeContract.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const marker = randomUUID().slice(0, 8), checks: string[] = []
const people = ['投资经理', '投资经理', '董事长', '总裁', '时间协调人', '投资经理', '财务', '风控与法务'].map((role, index) => ({ id: randomUUID(), role, name: `领导联动-${marker}-${index}`, email: `timeline-time-${marker}-${index}@example.invalid`, department: `领导联动-${marker}`, passwordHash: 'not-for-login' }))
const [owner, secretary, chairman, president, coordinator, outsider, finance, legal] = people
const code = async (promise: Promise<unknown>, expected: string) => { const error = await promise.then(() => null, cause => cause); assert.equal(error?.code, expected, error?.message ?? 'unexpected success') }
try {
  await db.insert(users).values(people)
  for (const person of people) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
  let project = await createProject({ name: `领导自动联动-${marker}`, targetDate: '2027-03-31', cycleDays: 30 }, owner.id)
  const projectNow = async () => (await db.select().from(projects).where(eq(projects.id, project.id)))[0]
  const rows = () => db.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.projectId, project.id))
  const row = async (id: string) => (await rows()).find(item => item.id === id)!
  const events = () => db.select().from(leaderTimeEvents).where(sql`${leaderTimeEvents.timeRequestId} IN (SELECT ${leaderTimeRequests.id} FROM ${leaderTimeRequests} WHERE ${leaderTimeRequests.projectId}=${project.id})`)
  const task = async (id: string) => (await db.select().from(todos).where(eq(todos.id, id)))[0]
  const sync = async () => { const preview = await previewTimelineTasks(project.id, owner.id); return syncTimelineTasks(project.id, owner.id, { clientRequestId: randomUUID(), fingerprint: preview.fingerprint }) }
  const act = async (id: string, userId: string, action: string) => actOnLeaderTime(id, userId, { clientRequestId: randomUUID(), expectedVersion: (await row(id)).version, action, reason: '隔离验收核对当前真实来源与排期' })
  const govern = async (leaderId: string) => {
    const change = await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: (await projectNow()).governanceVersion, reason: '隔离验收正式领导参与规则变更', assignments: [{ duty: 'secretary', userId: secretary.id }, { duty: 'concerned_leader', userId: leaderId }, { duty: 'chairman', userId: chairman.id }, { duty: 'president', userId: president.id }, { duty: 'finance', userId: finance.id }, { duty: 'legal', userId: legal.id }, { duty: 'coordinator', userId: coordinator.id }] })
    let version = change.version
    for (const userId of change.requiredConfirmers) version = (await decideFdeGovernance({ projectId: project.id, changeId: change.id, userId, expectedVersion: version, decision: 'confirm', comment: '正式确认隔离领导参与规则' })).version
  }
  const plan = async (targetDate: string) => { const current = await getFdeWorkflow(project.id, owner.id); await saveFdePlan({ projectId: project.id, userId: owner.id, cycleDays: 30, targetDate, expectedVersion: current.plan?.version }) }
  assert.equal((await rows()).length, 0)
  project = await classifyProject({ projectId: project.id, userId: owner.id, expectedVersion: project.version, toClassification: 'normal', reason: '初筛后配置领导时间联动' })
  await govern(chairman.id)
  assert.equal((await rows()).length, 1)
  const first = (await rows())[0]
  assert.equal(first.status, 'requested'); assert.equal(first.confirmedAt, null); assert.equal(first.durationMinutes, 45)
  assert.equal(first.taskId, first.sourceTimelineTaskId); assert.equal(first.submittedBy, secretary.id)
  assert.equal(timeLocal(first.latestFinish!), `${(await task(first.taskId!)).dueDate}T16:00`)
  checks.push('pool-no-time:effective-governance-generates-real-request-with-stable-task-leader-source-no-confirmation')

  const original = await rows(), originalEvents = await events(), preview = await previewTimelineTasks(project.id, owner.id), command = { clientRequestId: randomUUID(), fingerprint: preview.fingerprint }
  await Promise.all([1, 2].map(() => syncTimelineTasks(project.id, owner.id, command)))
  assert.deepEqual(await rows(), original); assert.deepEqual(await events(), originalEvents)
  const week = weekStartFor(timeLocal(first.preferredStart).slice(0, 10))
  assert.equal((await listLeaderTimes(outsider.id, week)).list.some(item => item.projectId === project.id), false)
  assert.ok((await listLeaderTimes(coordinator.id, week)).list.some(item => item.id === first.id))
  checks.push('concurrent-sync-and-replay-no-duplicate-requests-events-or-notices:outsider-denied')

  await plan('2027-04-02')
  const moved = await row(first.id)
  assert.equal(moved.id, first.id); assert.equal(moved.version, first.version + 1)
  assert.equal(timeLocal(moved.preferredStart).slice(0, 10), (await task(first.taskId!)).dueDate)
  assert.notEqual(moved.sourceFingerprint, first.sourceFingerprint)
  checks.push('unprocessed-request-follows-authoritative-source-date-with-same-id-and-audited-version')

  await act(first.id, chairman.id, 'confirm')
  const confirmed = await row(first.id)
  await plan('2027-04-04')
  assert.deepEqual(await row(first.id), confirmed, 'confirmed arrangement must not be overwritten')
  assert.equal((await readTimelineTimeSource(db, confirmed))?.view.changed, true)
  await code(act(first.id, chairman.id, 'confirm'), 'TIME_SOURCE_CHANGED')
  await code(act(first.id, coordinator.id, 'refresh-source'), 'TIME_ACTION_FORBIDDEN')
  await act(first.id, owner.id, 'refresh-source')
  assert.equal((await row(first.id)).status, 'requested'); assert.equal((await row(first.id)).confirmedAt, null)
  assert.deepEqual((await row(first.id)).scheduledStart, confirmed.scheduledStart)
  await act(first.id, chairman.id, 'confirm')
  checks.push('confirmed-time-protected:explicit-authorized-source-acknowledgement-requires-new-leader-confirmation')

  await govern(president.id)
  assert.equal((await row(first.id)).status, 'confirmed')
  assert.equal((await readTimelineTimeSource(db, await row(first.id)))?.view.needed, false)
  await code(act(first.id, owner.id, 'refresh-source'), 'TIME_SOURCE_OBSOLETE')
  await act(first.id, owner.id, 'cancel')
  const replacement = (await rows()).find(item => item.leaderId === president.id)!
  assert.equal(replacement.status, 'requested')
  await govern(chairman.id)
  assert.equal((await row(replacement.id)).status, 'withdrawn'); assert.equal((await row(replacement.id)).sourceRetired, true)
  assert.equal((await row(first.id)).status, 'cancelled', 'human cancellation is never resurrected')
  await govern(president.id)
  assert.equal((await row(replacement.id)).status, 'requested'); assert.equal((await rows()).length, 2)
  checks.push('governance-removal-preserves-confirmed-time:automatic-retirement-restores-id-but-human-cancellation-stays-terminal')

  const bindings = await db.select().from(userRoles).where(eq(userRoles.userId, president.id))
  await db.delete(userRoles).where(eq(userRoles.userId, president.id))
  try {
    await bindFdeMaterial({ projectId: project.id, userId: owner.id, stage: '立项', requirementKey: 'business_plan', waiverReason: '隔离验收缺岗待处理不补授权限' })
    assert.equal((await getFdeTasks(project.id, owner.id)).timelinePending.count, 1)
    assert.equal((await row(replacement.id)).status, 'withdrawn')
    assert.equal((await db.select().from(userRoles).where(eq(userRoles.userId, president.id))).length, 0)
  } finally { await db.insert(userRoles).values(bindings) }
  await sync(); assert.equal((await row(replacement.id)).status, 'requested')
  assert.equal((await getFdeTasks(project.id, owner.id)).timelinePending.count, 0)
  checks.push('missing-leader-role-persists-pending-without-granting-access:current-state-recovery-resolves-it')

  await actOnLeaderTime(replacement.id, coordinator.id, { clientRequestId: randomUUID(), expectedVersion: (await row(replacement.id)).version, action: 'coordinate', scheduledStart: '2027-03-20T10:00', durationMinutes: 60, reason: '协调人实际调整排期' })
  await plan('2027-04-06')
  const stale = await row(replacement.id), selection = { weekStart: '2027-03-15', requests: [{ id: stale.id, expectedVersion: stale.version }] }
  const proposal = await previewAutoSchedule(coordinator.id, selection)
  assert.equal(proposal.items[0].result, 'skipped'); assert.match(proposal.items[0].reason, /来源/)
  await code(act(stale.id, president.id, 'confirm'), 'TIME_SOURCE_CHANGED')
  await act(stale.id, owner.id, 'refresh-source')
  checks.push('manually-coordinated-request-is-not-auto-overwritten:stale-source-excluded-from-auto-scheduler')

  for (const requirementKey of ['business_plan', 'initial_meeting']) {
    const current = await getFdeWorkflow(project.id, owner.id), binding = current.materials.find(item => item.stage === '立项' && item.requirementKey === requirementKey)
    await bindFdeMaterial({ projectId: project.id, userId: owner.id, stage: '立项', requirementKey, waiverReason: '仅隔离验收使用真实允许的免传', expectedVersion: binding?.version })
  }
  for (const targetStage of ['尽调计划制定', '尽调计划审核'] as const) {
    let request = await createOaApprovalRequest({ projectId: project.id, userId: owner.id, targetStage, reason: '正式阶段审批验证领导时间联动' })
    while (request.status === '审批中') {
      const node = request.nodes.find(item => item.id === request.currentNodeId)!, userId = node.approverUserIds.find(id => id !== owner.id && !node.approvedByUserIds.includes(id))!
      request = (await actOnOaApprovalRequest({ requestId: request.id, userId, expectedVersion: request.lockVersion, action: 'approve', comment: '正式核验并通过阶段申请' })).request
    }
  }
  assert.equal((await projectNow()).stage, '启动尽调')
  const lateTasks = await db.select().from(projectTimelineTasks).where(and(eq(projectTimelineTasks.projectId, project.id), eq(projectTimelineTasks.stage, '启动尽调'), eq(projectTimelineTasks.needLeader, true)))
  assert.equal(lateTasks.length, 2)
  for (const link of lateTasks) assert.deepEqual((await rows()).filter(item => item.sourceTimelineTaskId === link.taskId).map(item => item.leaderId).sort(), [chairman.id, president.id].sort())
  checks.push('real-stage-approval-chain:formal-and-informal-DD-actions-each-derive-both-effective-executives')

  const target = await task(lateTasks[0].taskId), beforeExtension = (await rows()).filter(item => item.taskId === target.id)
  await requestFdeTaskExtension(project.id, target.id, secretary.id, { expectedVersion: target.version, requestedDueDate: shiftDate(target.dueDate!, 1), requestedDueTime: target.dueTime, reviewerUserId: owner.id, reason: '隔离验收延期批准后联动来源期限' })
  const [extension] = await db.select().from(oaApprovalRequests).where(eq(oaApprovalRequests.activeKey, target.id))
  assert.deepEqual((await rows()).filter(item => item.taskId === target.id), beforeExtension)
  await actOnFdeTaskExtension({ requestId: extension.id, userId: owner.id, action: 'approve', expectedVersion: 1, comment: '独立审批通过任务延期' })
  for (const item of (await rows()).filter(item => item.taskId === target.id)) assert.equal(timeLocal(item.latestFinish!).slice(0, 10), shiftDate(target.dueDate!, 1))
  checks.push('task-extension-pending-does-not-change-time:approved-extension-follows-effective-deadline')

  const independent = await createLeaderTime(owner.id, { clientRequestId: randomUUID(), projectId: project.id, leaderId: chairman.id, title: '人工独立时间需求', reason: '不由流程行动派生的独立讨论', outcome: '形成独立讨论结论', impact: '协调独立讨论', priority: 'P2', latestFinish: '2027-04-20T18:00', preferredStart: '2027-04-20T09:00', alternativeStart: '2027-04-20T14:00', durationMinutes: 60, location: '隔离会议室' })
  const independentBefore = await row(independent.id)
  await cancelFdeTask(project.id, target.id, owner.id, (await task(target.id)).version, '正式取消来源行动并核对派生时间')
  assert.ok((await rows()).filter(item => item.taskId === target.id).every(item => item.status === 'withdrawn'))
  assert.deepEqual(await row(independent.id), independentBefore)
  checks.push('task-cancellation-withdraws-only-unprocessed-linked-requests:independent-manual-time-unchanged')

  const otherTask = await task(lateTasks[1].taskId), beforeFault = await rows(), beforeEvents = await events()
  await assert.rejects(db.transaction(async tx => {
    await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${project.id} FOR UPDATE`)
    await tx.update(todos).set({ dueDate: shiftDate(otherTask.dueDate!, 1) }).where(eq(todos.id, otherTask.id))
    await syncTimelineLeaderTimes(tx, await projectNow(), randomUUID())
  }))
  assert.deepEqual(await task(otherTask.id), otherTask); assert.deepEqual(await rows(), beforeFault); assert.deepEqual(await events(), beforeEvents)
  checks.push('real-foreign-key-failure-rolls-back-source-task-time-and-event-together')
  console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, passed: checks.length, checks, realModelCalls: 0 }))
} finally { await pool.end() }
