import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { leads, oaApprovalNodes, oaApprovalRequests, projectAgentScheduleRequests, projectMembers, projectStageDates, projects, todos, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { createProject, deleteProject } from '../services/projectService.js'
import { decideFdeGovernance, proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { decideProjectAgent, getProjectAgent, resolveProjectAgentCommand, runProjectAgent } from '../services/fdeProjectAgentService.js'
import { actAgentSchedule, getAgentSchedules, submitAgentSchedule } from '../services/fdeAgentScheduleService.js'
import { actOnOaApprovalRequest } from '../services/oaWorkflowService.js'
import { listApprovalCenter } from '../services/fdeApprovalCenterService.js'
import { bindFdeMaterial, getFdeWorkflow, saveFdePlan } from '../services/fdeWorkflowService.js'
import { agentDayOffset } from '../contracts/fdeProjectAgentContract.js'
import { shanghaiToday } from '../contracts/fdeWeeklyPlanContract.js'
import { projectTimelineTasks, projectTimelineSyncs } from '../db/schema.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const marker = randomUUID().slice(0, 8), checks: string[] = [], today = shanghaiToday()
const people = ['投资经理', '投资经理', '总裁', '董事长', '投资经理', '系统管理员', '时间协调人'].map((role, i) => ({ id: randomUUID(), role, name: `日期-${marker}-${i}`, email: `date-${marker}-${i}@example.invalid`, department: `日期验收-${marker}`, passwordHash: 'not-for-login' }))
const [owner, secretary, president, chairman, outsider, admin, coordinator] = people
const expectCode = async (promise: Promise<unknown>, expected: string) => { const cause = await promise.then(() => null, error => error); assert.equal(cause?.code, expected, cause?.message ?? 'unexpected success') }
const action = (expectedVersion: number, value = 'approve') => ({ clientRequestId: randomUUID(), expectedVersion, action: value, reason: '已经独立核验本次节点日期' })
async function makeProject(stage = '入库') {
  const project = await createProject({ name: `节点改期-${marker}-${randomUUID().slice(0, 4)}`, owner: owner.name, ownerUserId: owner.id, collaborators: [] }, owner.id)
  const change = await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '配置节点改期测试职责', assignments: [{ duty: 'secretary', userId: secretary.id }, { duty: 'president', userId: president.id }, { duty: 'chairman', userId: chairman.id }, { duty: 'coordinator', userId: coordinator.id }] })
  let version = change.version
  for (const userId of change.requiredConfirmers) {
    const result = await decideFdeGovernance({ projectId: project.id, changeId: change.id, userId, expectedVersion: version, decision: 'confirm', comment: '隔离验收确认正式职责移交' })
    version = result.version
  }
  await db.update(projects).set({ targetDate: agentDayOffset(today, 80), cycleDays: 40, stage, classification: stage === '入库' ? 'pool' : 'normal' }).where(eq(projects.id, project.id))
  if (stage === '投决') for (const key of ['memo_final', 'dd_report', 'qa', 'loi_final']) await bindFdeMaterial({ projectId: project.id, userId: owner.id, stage, requirementKey: key, waiverReason: '仅隔离测试使用的合法免传说明' })
  return project.id
}
async function draft(id: string) {
  await runProjectAgent(id, owner.id, { clientRequestId: randomUUID(), expectedConfigVersion: 0 })
  const rec = (await getProjectAgent(id, owner.id)).runs[0].recommendation!
  assert.ok(rec?.suggestedDate, JSON.stringify(rec))
  await decideProjectAgent(id, rec.id, secretary.id, { clientRequestId: randomUUID(), expectedVersion: 1, decision: 'accepted' })
  return rec
}
const submit = (date: string) => ({ clientRequestId: randomUUID(), expectedVersion: 2, requestedDate: date, reason: '申请根据当前进度调整节点日期' })
try {
  await db.insert(users).values(people)
  for (const person of people) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
  const id = await makeProject(), rec = await draft(id)
  const baseline = (await db.select().from(projects).where(eq(projects.id, id)))[0], leadIds = await db.select({ id: leads.id }).from(leads)
  for (const person of [outsider, admin, coordinator]) await expectCode(getAgentSchedules(id, person.id), 'AGENT_FORBIDDEN')
  await expectCode(submitAgentSchedule(id, rec.id, owner.id, submit(agentDayOffset(today, 90))), 'AGENT_SCHEDULE_DATE_INVALID')
  assert.equal((await db.select().from(projectAgentScheduleRequests).where(eq(projectAgentScheduleRequests.projectId, id))).length, 0)
  checks.push('scope-and-date-window:no-admin-coordinator-outsider-or-out-of-range-write')

  const input = submit(rec.suggestedDate!), receipt = await submitAgentSchedule(id, rec.id, owner.id, input)
  assert.deepEqual(await submitAgentSchedule(id, rec.id, owner.id, input), receipt)
  assert.equal((await resolveProjectAgentCommand(id, owner.id, { clientRequestId: input.clientRequestId })).receipt?.id, receipt.id)
  assert.equal((await db.select().from(projectStageDates).where(eq(projectStageDates.projectId, id))).length, 0)
  assert.deepEqual((await db.select().from(projects).where(eq(projects.id, id)))[0], baseline)
  assert.equal((await listApprovalCenter(president.id, { view: 'pending' })).list.filter(row => row.id === receipt.id).length, 1)
  assert.equal((await listApprovalCenter(admin.id, { view: 'tracking' })).list.filter(row => row.id === receipt.id).length, 0)
  assert.equal((await db.select().from(todos).where(eq(todos.approvalRequestId, receipt.id))).length, 1)
  await expectCode(actAgentSchedule(id, receipt.id, owner.id, action(1)), 'AGENT_SCHEDULE_APPROVAL_FORBIDDEN')
  await expectCode(actAgentSchedule(id, receipt.id, secretary.id, action(1)), 'AGENT_SCHEDULE_APPROVAL_FORBIDDEN')
  await expectCode(actOnOaApprovalRequest({ userId: president.id, requestId: receipt.id, action: 'approve', comment: '不能使用阶段审批入口改期', expectedVersion: 1 }), 'OA_BUSINESS_ROUTE_REQUIRED')
  checks.push('submit-is-idempotent-and-recoverable:pending-center-todo-with-no-date-write-self-approval-or-generic-stage-bypass')

  const decision = action(1), result = await actAgentSchedule(id, receipt.id, president.id, decision)
  assert.deepEqual(await actAgentSchedule(id, receipt.id, president.id, decision), result)
  const [approved] = await db.select().from(projectStageDates).where(eq(projectStageDates.projectId, id))
  assert.equal(approved.plannedDate, input.requestedDate); assert.equal(approved.approvalId, receipt.id)
  const [timelineTask] = await db.select().from(projectTimelineTasks).where(eq(projectTimelineTasks.projectId, id))
  assert.equal(timelineTask.actionKey, 'intake'); assert.equal(timelineTask.dueDate, input.requestedDate)
  assert.equal((await db.select().from(projectTimelineSyncs).where(eq(projectTimelineSyncs.approvalId, receipt.id))).length, 1)
  await expectCode(deleteProject(id, owner.id), 'PROJECT_AGENT_HISTORY_PROTECTED')
  const after = (await db.select().from(projects).where(eq(projects.id, id)))[0]
  assert.equal(after.stage, baseline.stage); assert.equal(after.targetDate, baseline.targetDate); assert.equal(after.version, baseline.version + 1)
  assert.ok((await db.select().from(todos).where(eq(todos.approvalRequestId, receipt.id))).every(todo => todo.status === '已完成'))
  assert.equal((await getFdeWorkflow(id, owner.id)).timeline.find(item => item.stage === '入库')?.date, input.requestedDate)
  await expectCode(saveFdePlan({ projectId: id, userId: owner.id, cycleDays: 40, targetDate: agentDayOffset(today, 90) }), 'FDE_APPROVED_TIMELINE_EXISTS')
  assert.deepEqual(await db.select({ id: leads.id }).from(leads), leadIds)
  checks.push('final-approval-atomic:one-effective-stage-date-and-version-audit-original-final-date-stage-leads-preserved')

  const late = await makeProject('投决'), lateRec = await draft(late), lateInput = submit(agentDayOffset(lateRec.currentDate!, -1))
  const lateReceipt = await submitAgentSchedule(late, lateRec.id, owner.id, lateInput)
  await expectCode(actAgentSchedule(late, lateReceipt.id, president.id, action(1)), 'AGENT_SCHEDULE_APPROVAL_FORBIDDEN')
  await actAgentSchedule(late, lateReceipt.id, chairman.id, action(1))
  assert.equal((await db.select().from(projectStageDates).where(eq(projectStageDates.projectId, late))).length, 0)
  const pending = (await getAgentSchedules(late, president.id)).approvals[0]
  assert.equal(pending.version, 2); assert.equal(pending.canApprove, true); assert.equal(pending.stale, false)
  const race = await Promise.allSettled([actAgentSchedule(late, lateReceipt.id, president.id, action(2)), actAgentSchedule(late, lateReceipt.id, president.id, action(2))])
  assert.equal(race.filter(item => item.status === 'fulfilled').length, 1)
  assert.ok(race.some(item => item.status === 'rejected' && item.reason.code === 'VERSION_CONFLICT'))
  assert.equal((await db.select().from(projectStageDates).where(eq(projectStageDates.projectId, late))).length, 1)
  checks.push('late-stage:chairman-then-president-final-only-write-concurrent-decisions-one-winner')

  const staleId = await makeProject(), staleRec = await draft(staleId), staleReceipt = await submitAgentSchedule(staleId, staleRec.id, owner.id, submit(staleRec.suggestedDate!))
  await db.update(projects).set({ requirements: '提交后的事实发生变化' }).where(eq(projects.id, staleId))
  await expectCode(actAgentSchedule(staleId, staleReceipt.id, president.id, action(1)), 'AGENT_SCHEDULE_STALE')
  assert.equal((await db.select().from(projectStageDates).where(eq(projectStageDates.projectId, staleId))).length, 0)
  await actAgentSchedule(staleId, staleReceipt.id, owner.id, action(1, 'withdraw'))
  assert.equal((await db.select().from(oaApprovalRequests).where(eq(oaApprovalRequests.id, staleReceipt.id)))[0].activeKey, null)
  checks.push('stale-facts:approve-fails-closed-with-no-date-write-withdraw-still-works')

  const disabledId = await makeProject(), disabledRec = await draft(disabledId), disabledReceipt = await submitAgentSchedule(disabledId, disabledRec.id, owner.id, submit(disabledRec.suggestedDate!))
  await db.update(users).set({ status: '禁用' }).where(eq(users.id, president.id))
  await expectCode(actAgentSchedule(disabledId, disabledReceipt.id, president.id, action(1)), 'AGENT_ACTOR_UNAVAILABLE')
  await actAgentSchedule(disabledId, disabledReceipt.id, owner.id, action(1, 'withdraw'))
  await db.update(users).set({ status: '启用' }).where(eq(users.id, president.id))
  checks.push('disabled-reviewer-cannot-act-applicant-can-withdraw')

  const rejectedId = await makeProject(), rejectedRec = await draft(rejectedId), rejectedReceipt = await submitAgentSchedule(rejectedId, rejectedRec.id, owner.id, submit(rejectedRec.suggestedDate!))
  await actAgentSchedule(rejectedId, rejectedReceipt.id, president.id, action(1, 'reject'))
  assert.equal((await db.select().from(projectStageDates).where(eq(projectStageDates.projectId, rejectedId))).length, 0)
  await expectCode(submitAgentSchedule(rejectedId, rejectedRec.id, owner.id, submit(rejectedRec.suggestedDate!)), 'AGENT_SCHEDULE_EXISTS')
  const unknown = randomUUID()
  await resolveProjectAgentCommand(rejectedId, owner.id, { clientRequestId: unknown })
  await expectCode(submitAgentSchedule(rejectedId, rejectedRec.id, owner.id, { ...submit(rejectedRec.suggestedDate!), clientRequestId: unknown }), 'AGENT_REQUEST_CLOSED')
  checks.push('reject-keeps-original-date-and-history:old-recommendation-not-resubmitted-unknown-command-fence-blocks-late-writes')
  console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, passed: checks.length, checks, realModelCalls: 0, scope: 'agent-node-date-approval-not-full-migration' }))
} finally { await pool.end() }
