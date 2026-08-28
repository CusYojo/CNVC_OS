import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { leads, projectAgentCommands, projectAgentDecisions, projectAgentRecommendations, projectAgentRuns, projectDutyAssignments, projectMembers, projectRecords, projects, todos, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { createProject } from '../services/projectService.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { createProjectRecord, actOnProjectRecord } from '../services/fdeProjectRecordService.js'
import { collectProjectAgentFacts } from '../services/fdeProjectAgentFactsService.js'
import { decideProjectAgent, getProjectAgent, resolveProjectAgentCommand, runProjectAgent, saveProjectAgentConfig } from '../services/fdeProjectAgentService.js'
import { agentDayOffset, defaultProjectAgentConfig, evaluateProjectAgentRules } from '../contracts/fdeProjectAgentContract.js'
import { shanghaiToday } from '../contracts/fdeWeeklyPlanContract.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const marker = randomUUID().slice(0, 8), checks: string[] = []
const people = ['投资经理', '投资经理', '投资经理', '董事长', '时间协调人', '系统管理员', '投资经理'].map((role, i) => ({ id: randomUUID(), role, name: `研判-${marker}-${i === 6 ? 2 : i}`, email: `agent-${marker}-${i}@example.invalid`, department: `研判验收-${marker}`, passwordHash: 'not-for-login' }))
const [owner, secretary, member, leader, coordinator, admin, outsider] = people
const code = async (promise: Promise<unknown>, expected: string) => { const error = await promise.then(() => null, cause => cause); assert.equal(error?.code, expected, error?.message ?? 'unexpected success') }
const today = shanghaiToday(), configPayload = (version: number, configuration = { ...defaultProjectAgentConfig }) => ({ clientRequestId: randomUUID(), expectedVersion: version, configuration })
let calls = 0
try {
  await db.insert(users).values(people)
  for (const person of people) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
  const project = await createProject({ name: `研判项目-${marker}`, owner: owner.name, ownerUserId: owner.id, collaborators: [] }, owner.id)
  await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '配置研判验收职责', assignments: [{ duty: 'secretary', userId: secretary.id }, { duty: 'member', userId: member.id }, { duty: 'concerned_leader', userId: leader.id }, { duty: 'coordinator', userId: coordinator.id }] })
  await db.update(projects).set({ targetDate: agentDayOffset(today, 80), cycleDays: 40 }).where(eq(projects.id, project.id))
  const baseline = (await db.select().from(projects).where(eq(projects.id, project.id)))[0]
  const baselineLeads = await db.select({ id: leads.id }).from(leads)
  const baselineTodos = await db.select().from(todos).where(eq(todos.projectId, project.id))
  const initial = await getProjectAgent(project.id, owner.id)
  assert.equal(initial.config.version, 0); assert.equal(initial.config.autoApply, false); assert.equal(initial.total, 0)
  assert.equal((await getProjectAgent(project.id, secretary.id)).capabilities.configure, false)
  assert.equal((await getProjectAgent(project.id, member.id)).capabilities.run, false)
  for (const person of [coordinator, admin, outsider]) await code(getProjectAgent(project.id, person.id), 'AGENT_FORBIDDEN')
  await code(runProjectAgent(project.id, member.id, { clientRequestId: randomUUID(), expectedConfigVersion: 0 }), 'AGENT_RUN_FORBIDDEN')
  await code(saveProjectAgentConfig(project.id, secretary.id, configPayload(0)), 'AGENT_CONFIG_FORBIDDEN')
  checks.push('FDE-AGENT-001/AUTH:stable-identity-business-scope-role-capabilities-no-admin-or-coordinator-content')

  const payload = { clientRequestId: randomUUID(), expectedConfigVersion: 0 }
  const first = await runProjectAgent(project.id, owner.id, payload)
  assert.deepEqual(await runProjectAgent(project.id, owner.id, payload), first)
  let dashboard = await getProjectAgent(project.id, member.id)
  assert.equal(dashboard.total, 1); assert.equal(dashboard.runs[0].recommendation?.action, 'advance')
  assert.equal(dashboard.runs[0].canDecide, false); assert.equal(dashboard.runs[0].dateBasis, 'cycle_projection')
  const rawRun = (await db.select().from(projectAgentRuns).where(eq(projectAgentRuns.id, first.id)))[0]
  assert.ok(rawRun.facts.evidence.every(e => e.id && e.fingerprint.length === 64))
  assert.equal(rawRun.provider, 'rules')
  assert.equal((await resolveProjectAgentCommand(project.id, owner.id, { clientRequestId: payload.clientRequestId })).receipt?.id, first.id)
  await code(runProjectAgent(project.id, owner.id, { ...payload, expectedConfigVersion: 1 }), 'AGENT_REQUEST_REUSED')
  checks.push('FDE-AGENT-001/REC:real-mysql-facts-run-history-same-command-replay-and-response-loss-resolution')

  const recommendation = dashboard.runs[0].recommendation!
  const decision = { clientRequestId: randomUUID(), expectedVersion: 1, decision: 'accepted', note: '' }
  await code(decideProjectAgent(project.id, recommendation.id, member.id, decision), 'AGENT_DECISION_FORBIDDEN')
  const accepted = await decideProjectAgent(project.id, recommendation.id, secretary.id, decision)
  assert.deepEqual(await decideProjectAgent(project.id, recommendation.id, secretary.id, decision), accepted)
  const saved = (await db.select().from(projectAgentDecisions).where(eq(projectAgentDecisions.id, accepted.id)))[0]
  assert.equal(saved.scheduleDraft?.status, 'awaiting_submission')
  assert.equal((await getProjectAgent(project.id, owner.id)).runs[0].canSubmitSchedule, true)
  assert.deepEqual((await db.select().from(projects).where(eq(projects.id, project.id)))[0], baseline)
  assert.deepEqual(await db.select().from(todos).where(eq(todos.projectId, project.id)), baselineTodos)
  assert.deepEqual(await db.select({ id: leads.id }).from(leads), baselineLeads)
  checks.push('FDE-AGENT-004/007:secretary-human-decision-idempotent-date-draft-only-project-task-lead-unchanged')

  await runProjectAgent(project.id, owner.id, { ...payload, clientRequestId: randomUUID() })
  const next = (await getProjectAgent(project.id, owner.id)).runs[0].recommendation!
  const conflict = await Promise.allSettled([
    decideProjectAgent(project.id, next.id, owner.id, { ...decision, clientRequestId: randomUUID() }),
    decideProjectAgent(project.id, next.id, leader.id, { ...decision, clientRequestId: randomUUID(), decision: 'rejected', note: '当前建议需要重新核实' }),
  ])
  assert.equal(conflict.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal((await db.select().from(projectAgentDecisions).where(eq(projectAgentDecisions.recommendationId, next.id))).length, 1)
  assert.ok(conflict.some(result => result.status === 'rejected' && result.reason.code === 'VERSION_CONFLICT'))
  checks.push('FDE-CONC-001/AGENT-004:concurrent-human-decisions-one-effective-result')

  const unknown = randomUUID()
  assert.equal((await resolveProjectAgentCommand(project.id, owner.id, { clientRequestId: unknown })).state, 'closed')
  await code(runProjectAgent(project.id, owner.id, { ...payload, clientRequestId: unknown }), 'AGENT_REQUEST_CLOSED')
  const other = await createProject({ name: `另一研判项目-${marker}`, owner: owner.name, ownerUserId: owner.id, collaborators: [] }, owner.id)
  await code(resolveProjectAgentCommand(other.id, owner.id, { clientRequestId: unknown }), 'AGENT_REQUEST_REUSED')
  assert.equal((await db.select().from(projectAgentCommands).where(and(eq(projectAgentCommands.actorId, owner.id), eq(projectAgentCommands.requestId, unknown)))).length, 1)
  checks.push('FDE-REC-002:unknown-command-fence-blocks-late-delivery-and-cross-project-reuse')

  const enabled = configPayload(0, { ...defaultProjectAgentConfig, modelEnabled: true })
  await saveProjectAgentConfig(project.id, owner.id, enabled)
  assert.equal((await saveProjectAgentConfig(project.id, owner.id, enabled)).version, 1)
  const fallback = await runProjectAgent(project.id, owner.id, { clientRequestId: randomUUID(), expectedConfigVersion: 1 }, { model: async () => { calls++; throw new Error('synthetic provider secret must not persist') } })
  dashboard = await getProjectAgent(project.id, owner.id)
  assert.equal(dashboard.runs[0].id, fallback.id); assert.equal(dashboard.runs[0].fallbackReason, 'MODEL_UNAVAILABLE')
  assert.equal(dashboard.runs[0].provider, 'rules'); assert.ok(!JSON.stringify(dashboard).includes('synthetic provider secret'))
  const forged = await runProjectAgent(project.id, owner.id, { clientRequestId: randomUUID(), expectedConfigVersion: 1 }, { model: async () => {
    calls++; const facts = await db.transaction(tx => collectProjectAgentFacts(tx, project.id, owner.id))
    return { ...evaluateProjectAgentRules(facts), evidenceIds: ['not-a-real-evidence-id'] }
  } })
  assert.equal((await getProjectAgent(project.id, owner.id)).runs.find(run => run.id === forged.id)?.fallbackReason, 'MODEL_EVIDENCE_INVALID')
  checks.push('FDE-AGENT-003/006:model-failure-and-forged-evidence-fall-back-without-secret-errors-or-real-provider-calls')

  const staleRun = await runProjectAgent(project.id, owner.id, { clientRequestId: randomUUID(), expectedConfigVersion: 1 }, { model: async () => {
    calls++; await saveProjectAgentConfig(project.id, owner.id, configPayload(1))
    return evaluateProjectAgentRules(await db.transaction(tx => collectProjectAgentFacts(tx, project.id, owner.id)))
  } })
  const stale = (await getProjectAgent(project.id, owner.id)).runs.find(run => run.id === staleRun.id)!
  assert.equal(stale.status, 'stale'); assert.equal(stale.recommendation, null)
  checks.push('FDE-AGENT-002/CONC:configuration-change-during-model-run-suppresses-stale-result')

  const record = await createProjectRecord(project.id, owner.id, { clientRequestId: randomUUID(), kind: '沟通结论', title: '研判来源撤回验收', content: `撤回后不得从研判缓存泄露-${marker}` })
  const withRecord = await runProjectAgent(project.id, owner.id, { clientRequestId: randomUUID(), expectedConfigVersion: 2 })
  assert.ok((await db.select().from(projectAgentRuns).where(eq(projectAgentRuns.id, withRecord.id)))[0].facts.observations.some(item => item.id === record.id))
  await actOnProjectRecord(project.id, record.id, owner.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'withdraw', reason: '沟通结论需要重新核验' })
  const hidden = (await getProjectAgent(project.id, member.id)).runs.find(run => run.id === withRecord.id)!
  assert.equal(hidden.readable, false); assert.equal(hidden.recommendation, null); assert.deepEqual(hidden.evidence, [])
  assert.ok((await db.select().from(projectRecords).where(eq(projectRecords.id, record.id)))[0].content.includes(marker))
  checks.push('FDE-AGENT-001/AUTH:withdrawn-source-remains-auditable-but-old-derived-summary-and-evidence-are-hidden')

  const interruptedPayload = { clientRequestId: randomUUID(), expectedConfigVersion: 2 }
  const interrupted = await runProjectAgent(project.id, owner.id, interruptedPayload)
  await db.delete(projectAgentRecommendations).where(eq(projectAgentRecommendations.runId, interrupted.id))
  await db.update(projectAgentRuns).set({ status: 'running', completedAt: null, startedAt: new Date(Date.now() - 180000) }).where(eq(projectAgentRuns.id, interrupted.id))
  await resolveProjectAgentCommand(project.id, owner.id, { clientRequestId: interruptedPayload.clientRequestId })
  assert.equal((await db.select().from(projectAgentRuns).where(eq(projectAgentRuns.id, interrupted.id)))[0].fallbackReason, 'RUN_INTERRUPTED')
  assert.deepEqual(await runProjectAgent(project.id, owner.id, interruptedPayload), interrupted)
  assert.equal((await db.select().from(projectAgentRecommendations).where(eq(projectAgentRecommendations.runId, interrupted.id))).length, 0)
  checks.push('FDE-REC-001:interrupted-running-record-recovered-without-reexecuting-model-or-resurrecting-recommendation')

  await db.delete(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, project.id), eq(projectDutyAssignments.userId, member.id)))
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, member.id)))
  await code(getProjectAgent(project.id, member.id), 'AGENT_FORBIDDEN')
  await db.update(users).set({ status: '禁用' }).where(eq(users.id, secretary.id))
  await code(getProjectAgent(project.id, secretary.id), 'AGENT_ACTOR_UNAVAILABLE')
  assert.equal(calls, 3)
  checks.push('FDE-AUTH-003:membership-and-account-revocation-enforced-on-history')
  console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, passed: checks.length, checks, realModelCalls: 0, scope: 'agent-foundation-not-date-approval-or-full-migration' }))
} finally { await pool.end() }
