import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

// Must reject before importing DB/client/schema. A random table prefix alone is
// not database isolation or write authority. Run only in the guarded harness.
assertIsolatedMysqlAcceptanceDatabase('fdeProjectReplanAcceptance')
assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)

const { db, pool } = await import('../db/client.js')
const { and, eq } = await import('drizzle-orm')
const { users, projects, projectReplanPolicies, projectReplanRequests, projectStageDates, projectTimelineSyncs, todos, oaApprovalRequests } = await import('../db/schema.js')
const { identityRepositories } = await import('../repositories/index.js')
const { createProject } = await import('../services/projectService.js')
const { proposeFdeGovernance, decideFdeGovernance } = await import('../services/fdeGovernanceService.js')
const { previewProjectReplan, submitProjectReplan, actProjectReplan, getProjectReplans } = await import('../services/fdeProjectReplanService.js')
const { resolveProjectAgentCommand } = await import('../services/fdeProjectAgentService.js')
const { previewTimelineTasks, syncTimelineTasks } = await import('../services/fdeTimelineTaskService.js')
const { getFdeWorkflow } = await import('../services/fdeWorkflowService.js')
const { actOnOaApprovalRequest } = await import('../services/oaWorkflowService.js')
const { listApprovalCenter } = await import('../services/fdeApprovalCenterService.js')
const { collectApprovedMilestones, canReadMilestoneSnapshot } = await import('../services/fdeMilestoneSourcesService.js')
const { replanHash } = await import('../utils/fdeProjectReplanHash.js')
const { agentDayOffset } = await import('../contracts/fdeProjectAgentContract.js')
const { shanghaiToday, weekStartFor } = await import('../contracts/fdeWeeklyPlanContract.js')
const marker = randomUUID().slice(0, 8), today = shanghaiToday(), checks: string[] = []
const people = ['投资经理', '投资经理', '总裁', '董事长', '系统管理员', '投资经理'].map((role, i) => ({ id: randomUUID(), role, name: `整体重排-${marker}-${i}`, email: `replan-${marker}-${i}@example.invalid`, department: `重排隔离-${marker}`, passwordHash: 'not-for-login' }))
const [owner, secretary, president, chairman, admin, outsider] = people
const expectCode = async (promise: Promise<unknown>, code: string) => { const error = await promise.then(() => null, e => e); assert.equal(error?.code, code, error?.message ?? 'unexpected success') }
const action = (version: number, kind = 'approve') => ({ clientRequestId: randomUUID(), expectedVersion: version, action: kind, reason: '合成独立审核整体重排的完整影响' })
async function fixture() {
  const project = await createProject({ name: `重排-${marker}-${randomUUID().slice(0, 4)}`, owner: owner.name, ownerUserId: owner.id, collaborators: [] }, owner.id)
  const governance = await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '为隔离验收配置重排职责', assignments: [{ duty: 'secretary', userId: secretary.id }, { duty: 'president', userId: president.id }, { duty: 'chairman', userId: chairman.id }] })
  let version = governance.version
  for (const userId of governance.requiredConfirmers) version = (await decideFdeGovernance({ projectId: project.id, changeId: governance.id, userId, expectedVersion: version, decision: 'confirm', comment: '合成验收确认职责绑定' })).version
  await db.update(projects).set({ targetDate: agentDayOffset(today, 80), cycleDays: 40, stage: '入库', classification: 'normal' }).where(eq(projects.id, project.id))
  const initial = await previewTimelineTasks(project.id, owner.id)
  await syncTimelineTasks(project.id, owner.id, { clientRequestId: randomUUID(), fingerprint: initial.fingerprint })
  const configuration = { schemaVersion: 1 as const, timezone: 'Asia/Shanghai' as const, calendarBasis: 'calendar' as const, strategy: 'shift_remaining' as const, protectedConflict: 'block' as const, requesterDuties: ['owner' as const, 'secretary' as const], approvals: [{ duty: 'chairman' as const, name: '合成董事长整体审核', mode: '会签' as const }, { duty: 'president' as const, name: '合成总裁整体审核', mode: '会签' as const }] }
  await db.insert(projectReplanPolicies).values({ projectId: project.id, version: 1, enabled: false, configuration, configurationHash: replanHash(configuration), approvalEvidence: '隔离合成政策，仅测试使用，不代表正式规则获批', createdBy: owner.id, approvedBy: chairman.id })
  return project.id
}
const propose = async (id: string, days = 90) => {
  const preview = await previewProjectReplan(id, owner.id, { targetDate: agentDayOffset(today, days) })
  assert.equal(preview.canSubmit, true, JSON.stringify(preview.blockers))
  const input = { clientRequestId: randomUUID(), targetDate: preview.targetDate, fingerprint: preview.fingerprint, reason: '隔离测试申请整体重排并保留原行动' }
  return { preview, input, receipt: await submitProjectReplan(id, owner.id, input) }
}
try {
  await db.insert(users).values(people)
  for (const person of people) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
  const id = await fixture()
  const disabled = await previewProjectReplan(id, owner.id, { targetDate: agentDayOffset(today, 90) })
  assert.equal(disabled.canSubmit, false); assert.ok(disabled.blockers.some(b => b.code === 'REPLAN_POLICY_REQUIRED'))
  await expectCode(submitProjectReplan(id, owner.id, { clientRequestId: randomUUID(), targetDate: disabled.targetDate, fingerprint: disabled.fingerprint, reason: '未启用规则不得正式提交' }), 'REPLAN_BLOCKED')
  for (const actor of [admin, outsider]) await expectCode(getProjectReplans(id, actor.id), 'AGENT_FORBIDDEN')
  await db.update(projectReplanPolicies).set({ enabled: true }).where(eq(projectReplanPolicies.projectId, id))
  checks.push('policy-absent-disabled-and-current-project-access-fail-closed')
  const [before] = await db.select().from(projects).where(eq(projects.id, id))
  const sourceTasks = await db.select().from(todos).where(eq(todos.projectId, id))
  const first = await propose(id)
  assert.deepEqual(await submitProjectReplan(id, owner.id, first.input), first.receipt)
  assert.equal((await resolveProjectAgentCommand(id, owner.id, { clientRequestId: first.input.clientRequestId })).receipt?.id, first.receipt.id)
  assert.deepEqual((await db.select().from(projects).where(eq(projects.id, id)))[0], before)
  assert.equal((await db.select().from(projectStageDates).where(eq(projectStageDates.projectId, id))).length, 0)
  assert.ok((await listApprovalCenter(chairman.id, { view: 'pending' })).list.some(r => r.id === first.receipt.id && r.businessType === 'project_replan'))
  await expectCode(actProjectReplan(id, first.receipt.id, owner.id, action(1)), 'REPLAN_FORBIDDEN')
  await expectCode(actOnOaApprovalRequest({ userId: chairman.id, requestId: first.receipt.id, action: 'approve', comment: '不可通过通用入口批准整体重排', expectedVersion: 1 }), 'OA_BUSINESS_ROUTE_REQUIRED')
  await actProjectReplan(id, first.receipt.id, chairman.id, action(1))
  assert.equal((await db.select().from(projects).where(eq(projects.id, id)))[0].targetDate, before.targetDate)
  const last = action(2), competing = action(2)
  const results = await Promise.allSettled([actProjectReplan(id, first.receipt.id, president.id, last), actProjectReplan(id, first.receipt.id, president.id, competing)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.ok(results.some(r => r.status === 'rejected' && r.reason.code === 'VERSION_CONFLICT'))
  const winner = results[0].status === 'fulfilled' ? last : competing
  assert.equal((await actProjectReplan(id, first.receipt.id, president.id, winner)).version, 3)
  const [after] = await db.select().from(projects).where(eq(projects.id, id))
  assert.equal(after.targetDate, first.input.targetDate); assert.equal(after.stage, before.stage); assert.equal(after.version, before.version + 1)
  const dates = await db.select().from(projectStageDates).where(eq(projectStageDates.projectId, id)); assert.equal(dates.length, 8)
  for (const task of sourceTasks) {
    const [current] = await db.select().from(todos).where(eq(todos.id, task.id))
    assert.equal(current.dueDate, agentDayOffset(task.dueDate!, 10)); assert.equal(current.ownerUserId, task.ownerUserId); assert.equal(current.status, task.status)
  }
  assert.equal((await getFdeWorkflow(id, owner.id)).timeline.at(-1)?.date, first.input.targetDate)
  const milestones = await collectApprovedMilestones(db, owner.id, weekStartFor(first.input.targetDate), { projectIds: [id] })
  assert.ok(milestones.some(m => m.sourceKind === 'replan' && m.approvalId === first.receipt.id))
  assert.equal(await canReadMilestoneSnapshot(db, milestones[0], owner.id), true)
  checks.push('submit-and-recovery-no-early-write-independent-final-approval-one-winner-original-task-identities-calendar-source')

  const staleId = await fixture(); await db.update(projectReplanPolicies).set({ enabled: true }).where(eq(projectReplanPolicies.projectId, staleId))
  const stalePreview = await previewProjectReplan(staleId, owner.id, { targetDate: agentDayOffset(today, 90) })
  await db.update(projects).set({ requirements: '预览后真实来源变化' }).where(eq(projects.id, staleId))
  await expectCode(submitProjectReplan(staleId, owner.id, { ...first.input, clientRequestId: randomUUID(), fingerprint: stalePreview.fingerprint }), 'REPLAN_PREVIEW_STALE')
  const stale = await propose(staleId)
  await db.update(projects).set({ requirements: '提交后真实来源再次变化' }).where(eq(projects.id, staleId))
  await expectCode(actProjectReplan(staleId, stale.receipt.id, chairman.id, action(1)), 'REPLAN_SOURCE_CHANGED')
  await actProjectReplan(staleId, stale.receipt.id, owner.id, action(1, 'withdraw'))
  assert.equal((await db.select().from(projectStageDates).where(eq(projectStageDates.projectId, staleId))).length, 0)
  checks.push('stale-preview-and-stale-approval-no-write-withdraw-still-available')

  const rollbackId = await fixture(); await db.update(projectReplanPolicies).set({ enabled: true }).where(eq(projectReplanPolicies.projectId, rollbackId))
  const rollback = await propose(rollbackId)
  await actProjectReplan(rollbackId, rollback.receipt.id, chairman.id, action(1))
  // Scoped late uniqueness failure after effective dates and tasks are written.
  const collisionId = randomUUID()
  await db.insert(projectTimelineSyncs).values({ id: collisionId, projectId: rollbackId, actorId: owner.id, source: 'replan', sourceKey: `replan:${rollback.receipt.id}`, fingerprint: '0'.repeat(64), changes: [], issues: [] })
  await assert.rejects(actProjectReplan(rollbackId, rollback.receipt.id, president.id, action(2)))
  assert.equal((await db.select().from(projectStageDates).where(eq(projectStageDates.projectId, rollbackId))).length, 0)
  assert.equal((await db.select().from(projects).where(eq(projects.id, rollbackId)))[0].targetDate, agentDayOffset(today, 80))
  assert.equal((await db.select().from(oaApprovalRequests).where(eq(oaApprovalRequests.id, rollback.receipt.id)))[0].lockVersion, 2)
  await db.delete(projectTimelineSyncs).where(and(eq(projectTimelineSyncs.id, collisionId), eq(projectTimelineSyncs.projectId, rollbackId)))
  await actProjectReplan(rollbackId, rollback.receipt.id, president.id, action(2))
  const unknown = randomUUID(); await resolveProjectAgentCommand(id, owner.id, { clientRequestId: unknown })
  const next = await previewProjectReplan(id, owner.id, { targetDate: agentDayOffset(today, 100) })
  await expectCode(submitProjectReplan(id, owner.id, { ...first.input, clientRequestId: unknown, targetDate: next.targetDate, fingerprint: next.fingerprint }), 'AGENT_REQUEST_CLOSED')
  assert.equal((await db.select().from(projectReplanRequests).where(eq(projectReplanRequests.projectId, id))).length, 1)
  checks.push('late-failure-rolls-back-all-effects-and-unknown-command-fence-prevents-delayed-write')
  console.log(JSON.stringify({ ok: true, passed: checks.length, checks, scope: 'guarded-overall-replan-engine-not-full-business-UAT' }))
} finally { await pool.end() }
