import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, fdeWorkflowPolicies, fdeWorkflowPolicyVersions, fdeTypePolicyReviews, fdeTypePolicyEvents, leads, projectDutyAssignments, projectMembers, projects, todos, userRoles, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { executeTypePolicy, getTypePolicy, listTypePolicies } from '../services/fdeTypePolicyService.js'
import { previewBoundTypeExecution } from '../services/fdeTypeExecutionPreparationService.js'
import { typePolicyFixture } from './fdeTypePolicyFixture.js'
import { typePolicyName } from '../contracts/fdeTypePolicyContract.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT, 'must run in the isolated acceptance harness')
const mark = randomUUID().slice(0, 8), checks: string[] = []
const actors = ['系统管理员', '投资经理', '投资经理', '董事长', '投资经理'].map((role, i) => ({ id: randomUUID(), email: `execution-${mark}-${i}@accept.invalid`, name: `隔离执行-${i === 4 ? 1 : i}-${mark}`, role, department: '隔离验收', passwordHash: 'isolated-no-login-account' }))
const [admin, owner, secretary, leader, outsider] = actors
const reject = (operation: Promise<unknown>, code: string) => assert.rejects(operation, e => (e as { code?: string }).code === code)
const businessSnapshot = () => Promise.all([db.select().from(projects).orderBy(asc(projects.id)), db.select().from(todos).orderBy(asc(todos.id)), db.select().from(leads).orderBy(asc(leads.id))]).then(JSON.stringify)
const allSnapshot = () => Promise.all([businessSnapshot(), db.select().from(fdeWorkflowPolicies).orderBy(asc(fdeWorkflowPolicies.id)), db.select().from(fdeWorkflowPolicyVersions).orderBy(asc(fdeWorkflowPolicyVersions.id)), db.select().from(fdeTypePolicyReviews).orderBy(asc(fdeTypePolicyReviews.versionId)), db.select().from(auditLogs).orderBy(asc(auditLogs.id))]).then(JSON.stringify)
try {
  const oldProjects = await db.select().from(projects).orderBy(asc(projects.id)), oldTasks = await db.select().from(todos).orderBy(asc(todos.id)), oldLeads = await db.select().from(leads).orderBy(asc(leads.id))
  await db.insert(users).values(actors)
  for (const actor of actors) await identityRepositories.users.synchronizeAdministrationBindings(actor.id, actor.role, actor.department)
  async function publishedDefinition() {
    const head = (await listTypePolicies(admin.id)).policies.find(p => p.code === 'noninvestment:fundraising')
    const created = await executeTypePolicy(admin.id, { commandId: randomUUID(), action: 'create', expectedPolicyVersion: head?.version ?? 0, configuration: typePolicyFixture(), reason: '隔离执行准备模板，不是正式规则' })
    const approved = await executeTypePolicy(leader.id, { commandId: randomUUID(), action: 'approve', policyId: created.policyId, versionId: created.versionId, expectedVersion: created.version, reason: '独立审核隔离准备模板' })
    const published = await executeTypePolicy(admin.id, { commandId: randomUUID(), action: 'publish', policyId: created.policyId, versionId: created.versionId, expectedVersion: approved.version, expectedPolicyVersion: approved.policyVersion, reason: '仅发布隔离准备版本，不启用执行' })
    const view = await getTypePolicy(admin.id, published.policyId)
    return { published, version: view.versions.find(v => v.id === published.versionId)! }
  }
  const first = await publishedDefinition(), projectId = randomUUID()
  // Synthetic already-bound non-investment fixture only. This INSERT is not an
  // application creation/migration path and must not be copied into production.
  await db.insert(projects).values({ id: projectId, name: `隔离非投资执行准备-${mark}`, owner: owner.name, ownerUserId: owner.id,
    createdBy: owner.id, workflowModel: 'fde-v1', projectType: typePolicyName('fundraising'), workflowPolicyVersionId: first.version.id,
    stage: '合成目标确认', classification: 'normal', lifecycle: 'active', cycleDays: 50, targetDate: '2026-10-30' })
  await db.insert(projectMembers).values([owner, secretary, leader].map((actor, i) => ({ projectId, userId: actor.id, memberRole: i ? 'member' : 'owner', sourceName: actor.name })))
  await db.insert(projectDutyAssignments).values([{ projectId, userId: secretary.id, duty: 'secretary', assignedBy: owner.id }, { projectId, userId: leader.id, duty: 'concerned_leader', assignedBy: owner.id }])
  const request = { expectedProjectVersion: 1, expectedGovernanceVersion: 1, expectedPolicyVersionId: first.version.id, expectedPolicySha256: first.version.sha256, cycleDays: 50, targetDate: '2026-10-30', selections: [{ actionKey: 'accept_delivery', userId: owner.id, dueTime: '18:07' }] }
  const before = await allSnapshot()
  for (const actor of [owner, secretary]) {
    const result = await previewBoundTypeExecution(projectId, actor.id, request)
    assert.equal(result.plan.binding.policyVersionId, first.version.id); assert.equal(result.plan.startDate, '2026-09-10')
    assert.deepEqual(result.plan.actions.map(a => a.ownerUserId), [secretary.id, owner.id]); assert.equal(result.plan.actions[1].dueTime, '18:07')
    assert.equal(result.executionAvailable, false); assert.equal(result.persisted, false); assert.equal(result.policyEnabled, false)
  }
  assert.equal(await allSnapshot(), before)
  checks.push('real-MySQL-exact-published-binding-and-current-roster:owner-secretary-read-only-no-project-task-policy-audit-writes')

  await reject(previewBoundTypeExecution(projectId, outsider.id, request), 'TYPE_EXECUTION_FORBIDDEN')
  await reject(previewBoundTypeExecution(projectId, admin.id, request), 'TYPE_EXECUTION_FORBIDDEN')
  await reject(previewBoundTypeExecution(projectId, leader.id, request), 'TYPE_EXECUTION_PREPARE_FORBIDDEN')
  await assert.rejects(previewBoundTypeExecution(projectId, owner.id, { ...request, actorId: admin.id }))
  assert.equal(await allSnapshot(), before)
  checks.push('same-display-name-is-not-identity:pure-admin-no-business-bypass:leader-not-owner-or-secretary:strict-request')

  await reject(previewBoundTypeExecution(projectId, owner.id, { ...request, expectedProjectVersion: 2 }), 'TYPE_EXECUTION_VERSION_CONFLICT')
  await reject(previewBoundTypeExecution(projectId, owner.id, { ...request, expectedGovernanceVersion: 2 }), 'TYPE_EXECUTION_VERSION_CONFLICT')
  await reject(previewBoundTypeExecution(projectId, owner.id, { ...request, expectedPolicyVersionId: randomUUID() }), 'TYPE_EXECUTION_BINDING_CHANGED')
  await reject(previewBoundTypeExecution(projectId, owner.id, { ...request, expectedPolicySha256: 'f'.repeat(64) }), 'TYPE_EXECUTION_POLICY_INTEGRITY')
  assert.equal(await allSnapshot(), before)
  checks.push('stale-project-governance-policy-and-content-hash-fail-without-side-effects')

  const second = await publishedDefinition()
  const afterNew = await allSnapshot(), old = await previewBoundTypeExecution(projectId, owner.id, request)
  assert.equal(old.plan.binding.policyVersionId, first.version.id); assert.notEqual(second.version.id, first.version.id)
  assert.equal((await getTypePolicy(admin.id, first.published.policyId)).policy.activeVersionId, second.version.id)
  assert.equal(await allSnapshot(), afterNew)
  checks.push('new-published-version-does-not-rebind-existing-project:disabled-policy-remains-disabled')

  const bindingRows = await db.select().from(userRoles).where(eq(userRoles.userId, secretary.id))
  await db.delete(userRoles).where(eq(userRoles.userId, secretary.id))
  try { const snapshot = await allSnapshot(); await reject(previewBoundTypeExecution(projectId, owner.id, request), 'TYPE_EXECUTION_DUTY_MISSING'); await reject(previewBoundTypeExecution(projectId, secretary.id, request), 'TYPE_EXECUTION_PREPARE_FORBIDDEN'); assert.equal(await allSnapshot(), snapshot) }
  finally { await db.insert(userRoles).values(bindingRows) }
  await db.update(users).set({ status: '禁用' }).where(eq(users.id, owner.id))
  try { await reject(previewBoundTypeExecution(projectId, owner.id, request), 'TYPE_EXECUTION_FORBIDDEN') }
  finally { await db.update(users).set({ status: '启用' }).where(eq(users.id, owner.id)) }
  checks.push('current-role-revocation-and-disabled-actor-rechecked-from-MySQL-not-cached-roster')

  await db.update(fdeWorkflowPolicyVersions).set({ status: 'draft' }).where(eq(fdeWorkflowPolicyVersions.id, first.version.id))
  try { await reject(previewBoundTypeExecution(projectId, owner.id, request), 'TYPE_EXECUTION_POLICY_NOT_APPROVED') }
  finally { await db.update(fdeWorkflowPolicyVersions).set({ status: 'published' }).where(eq(fdeWorkflowPolicyVersions.id, first.version.id)) }
  const modified = structuredClone(first.version.configuration); modified.actions[0].title = '隔离篡改内容'
  await db.update(fdeWorkflowPolicyVersions).set({ configuration: modified }).where(eq(fdeWorkflowPolicyVersions.id, first.version.id))
  try { await reject(previewBoundTypeExecution(projectId, owner.id, request), 'TYPE_EXECUTION_POLICY_INTEGRITY') }
  finally { await db.update(fdeWorkflowPolicyVersions).set({ configuration: first.version.configuration }).where(eq(fdeWorkflowPolicyVersions.id, first.version.id)) }
  checks.push('draft-and-tampered-bound-content-rejected:no-fallback-to-current-investment-template')

  const corruptEventId = randomUUID()
  await db.insert(fdeTypePolicyEvents).values({ id: corruptEventId, policyId: first.published.policyId, versionId: first.version.id, actorId: leader.id, commandId: randomUUID(), action: 'save', reason: '仅隔离负对照：审核人参与过编制', snapshot: { isolatedCorruptionCase: true } })
  try { await reject(previewBoundTypeExecution(projectId, owner.id, request), 'TYPE_EXECUTION_POLICY_NOT_APPROVED') }
  finally { await db.delete(fdeTypePolicyEvents).where(eq(fdeTypePolicyEvents.id, corruptEventId)) }
  checks.push('all-contributor-history-rechecked:invalid-independent-review-cannot-prepare-execution')

  for (const [patch, code] of [[{ workflowModel: 'legacy' }, 'TYPE_EXECUTION_PROJECT_MODEL'], [{ projectType: '投资项目' }, 'TYPE_EXECUTION_PROJECT_MODEL'], [{ classification: 'pool' }, 'TYPE_EXECUTION_PROJECT_INACTIVE'], [{ lifecycle: 'closed' }, 'TYPE_EXECUTION_PROJECT_INACTIVE']] as const) {
    await db.update(projects).set(patch).where(eq(projects.id, projectId))
    try { await reject(previewBoundTypeExecution(projectId, owner.id, request), code) }
    finally { await db.update(projects).set({ workflowModel: 'fde-v1', projectType: typePolicyName('fundraising'), classification: 'normal', lifecycle: 'active' }).where(eq(projects.id, projectId)) }
  }
  assert.equal(await allSnapshot(), afterNew)
  checks.push('investment-legacy-pool-and-inactive-projects-cannot-use-type-execution-preparation')

  const currentProjects = await db.select().from(projects).orderBy(asc(projects.id))
  assert.deepEqual(currentProjects.filter(p => p.id !== projectId), oldProjects)
  assert.deepEqual(await db.select().from(todos).orderBy(asc(todos.id)), oldTasks)
  assert.deepEqual(await db.select().from(leads).orderBy(asc(leads.id)), oldLeads)
  assert.equal((await db.select().from(fdeWorkflowPolicies).where(and(eq(fdeWorkflowPolicies.id, first.published.policyId), eq(fdeWorkflowPolicies.enabled, true)))).length, 0)
  checks.push('all-preexisting-projects-tasks-leads-preserved:no-execution-activation-or-business-prefix-migration')
  console.log(JSON.stringify({ ok: true, passed: checks.length, checks, scope: 'type-execution-preparation-read-only-not-runtime-instance-or-UAT', realModelCalls: 0 }))
} finally { await pool.end() }
