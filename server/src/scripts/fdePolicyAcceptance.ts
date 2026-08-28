import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { fdeWorkflowPolicyVersions, projects, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { createProject, classifyProject } from '../services/projectService.js'
import { bindFdeMaterial, evaluateFdeStageGate, getFdeWorkflow, saveFdePlan } from '../services/fdeWorkflowService.js'
import { createFdePolicyDraft, getProjectWorkflowPolicy, listFdeWorkflowPolicies, policyHash, publishFdePolicyVersion, saveFdePolicyDraft, setFdePolicyEnabled } from '../services/fdeWorkflowPolicyService.js'
import { fdeWorkflowPolicySchema } from '../contracts/fdeWorkflowPolicyContract.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const marker = randomUUID().slice(0, 8)
const adminId = randomUUID(), ownerId = randomUUID()
const admin = { userId: adminId, userName: `规则管理员-${marker}` }
const owner = { userId: ownerId, userName: `规则负责人-${marker}` }
const checks: string[] = []
const expectCode = async (promise: Promise<unknown>, code: string) => { const failure = await promise.then(() => null, (cause) => cause as { code: string }); assert.equal(failure?.code, code) }
try {
  await db.insert(users).values([
    { id: adminId, email: `policy-admin-${marker}@example.invalid`, name: admin.userName, role: '系统管理员', passwordHash: 'not-for-login' },
    { id: ownerId, email: `policy-owner-${marker}@example.invalid`, name: owner.userName, role: '投资经理', passwordHash: 'not-for-login' },
  ])
  await identityRepositories.users.synchronizeAdministrationBindings(adminId, '系统管理员', '投资部')
  await identityRepositories.users.synchronizeAdministrationBindings(ownerId, '投资经理', '投资部')
  let policy = (await listFdeWorkflowPolicies())[0]
  const baseline = policy.versions.find((version) => version.id === policy.activeVersionId)!
  assert.equal(policyHash(baseline.configuration), baseline.sha256)
  const oldProject = await createProject({ name: `规则旧项目-${marker}` }, ownerId)
  assert.equal(oldProject.workflowPolicyVersionId, baseline.id)
  checks.push('mysql-json-roundtrip-preserves-canonical-policy-hash', 'new-project-pins-published-policy-version')
  await expectCode(createFdePolicyDraft(policy.id, { sourceVersionId: baseline.id, expectedVersion: policy.version, reason: '普通用户不能创建系统规则' }, owner), 'ROLE_FORBIDDEN')
  const created = await createFdePolicyDraft(policy.id, { sourceVersionId: baseline.id, expectedVersion: policy.version, reason: '新增项目材料与周期配置' }, admin)
  await expectCode(createFdePolicyDraft(policy.id, { sourceVersionId: baseline.id, expectedVersion: policy.version, reason: '过期版本不得追加草稿' }, admin), 'VERSION_CONFLICT')
  policy = (await listFdeWorkflowPolicies())[0]
  let draft = policy.versions.find((version) => version.id === created.id)!
  const configuration = structuredClone(draft.configuration)
  configuration.cycleDays = [30]
  configuration.stages[1].materials.push({ key: 'investment_evidence', label: '新增核验材料' })
  configuration.stages[1].allowWaiver = false
  configuration.stages[1].approvals[0].name = '版本化关注领导审批'
  assert.equal(fdeWorkflowPolicySchema.safeParse({ ...configuration, stages: configuration.stages.slice(1) }).success, false)
  const missingBaseline = structuredClone(configuration)
  missingBaseline.stages[1].materials = []
  assert.equal(fdeWorkflowPolicySchema.safeParse(missingBaseline).success, false)
  const saved = await saveFdePolicyDraft(draft.id, { configuration, reason: '新增材料要求且禁用本阶段免传', expectedVersion: draft.version }, admin)
  await expectCode(saveFdePolicyDraft(draft.id, { configuration, reason: '旧版本不能覆盖新草稿', expectedVersion: draft.version }, admin), 'VERSION_CONFLICT')
  assert.equal((await getFdeWorkflow(oldProject.id, ownerId)).stages[1].materials.length, 2)
  checks.push('draft-authority-version-lock-and-baseline-constraints', 'unpublished-draft-does-not-change-project-rules')
  await publishFdePolicyVersion(policy.id, { versionId: draft.id, expectedPolicyVersion: policy.version, expectedDraftVersion: saved.version, reason: '仅用于之后新建项目的批准规则' }, admin)
  policy = (await listFdeWorkflowPolicies())[0]
  draft = policy.versions.find((version) => version.id === created.id)!
  await expectCode(saveFdePolicyDraft(draft.id, { configuration, reason: '不能修改已发布规则内容', expectedVersion: draft.version }, admin), 'FDE_POLICY_IMMUTABLE')
  let newProject = await createProject({ name: `规则新项目-${marker}` }, ownerId)
  assert.equal(newProject.workflowPolicyVersionId, created.id)
  assert.equal((await getFdeWorkflow(oldProject.id, ownerId)).policy.id, baseline.id)
  const workflow = await getFdeWorkflow(newProject.id, ownerId)
  assert.equal(workflow.stages[1].materials.length, 3)
  assert.equal(workflow.stages[1].approvals[0].name, '版本化关注领导审批')
  assert.deepEqual(workflow.policy.cycleDays, [30])
  checks.push('publish-only-affects-subsequent-projects', 'published-policy-is-immutable-and-reference-protected')
  await expectCode(bindFdeMaterial({ projectId: newProject.id, userId: ownerId, stage: '立项', requirementKey: 'business_plan', waiverReason: '配置已经禁止免传' }), 'FDE_MATERIAL_WAIVER_DISABLED')
  await expectCode(saveFdePlan({ projectId: newProject.id, userId: ownerId, cycleDays: 15, targetDate: '2027-03-01' }), 'FDE_PLAN_CYCLE_DISABLED')
  newProject = await classifyProject({ projectId: newProject.id, userId: ownerId, toClassification: 'normal', expectedVersion: newProject.version, reason: '规则验收项目完成入库' })
  await expectCode(db.transaction((tx) => evaluateFdeStageGate(tx, newProject)), 'FDE_STAGE_GATE_FAILED')
  checks.push('material-gate-waiver-and-cycle-use-project-policy')
  const [{ total: before }] = await db.select({ total: sql<number>`COUNT(*)` }).from(projects)
  await setFdePolicyEnabled(policy.id, { enabled: false, expectedVersion: policy.version, reason: '临时停用新项目模板' }, admin)
  await expectCode(createProject({ name: '停用时不得落半条项目' }, ownerId), 'FDE_POLICY_DISABLED')
  const [{ total: after }] = await db.select({ total: sql<number>`COUNT(*)` }).from(projects)
  assert.equal(before, after)
  assert.equal((await getFdeWorkflow(oldProject.id, ownerId)).policy.id, baseline.id)
  policy = (await listFdeWorkflowPolicies())[0]
  await setFdePolicyEnabled(policy.id, { enabled: true, expectedVersion: policy.version, reason: '恢复新项目模板使用' }, admin)
  checks.push('disabled-policy-blocks-new-projects-without-changing-existing-projects')
  await db.update(fdeWorkflowPolicyVersions).set({ sha256: '0'.repeat(64) }).where(eq(fdeWorkflowPolicyVersions.id, draft.id))
  await expectCode(getProjectWorkflowPolicy(db, newProject), 'FDE_POLICY_INTEGRITY_FAILED')
  await db.update(fdeWorkflowPolicyVersions).set({ sha256: draft.sha256 }).where(eq(fdeWorkflowPolicyVersions.id, draft.id))
  await assert.rejects(db.delete(fdeWorkflowPolicyVersions).where(eq(fdeWorkflowPolicyVersions.id, draft.id)))
  checks.push('corrupt-policy-fails-closed-and-bound-version-cannot-be-deleted')
  // The aggregate suite shares this isolated prefix. Restore configuration through
  // a new real publication; never overwrite either published history or bound projects.
  policy = (await listFdeWorkflowPolicies())[0]
  const restored = await createFdePolicyDraft(policy.id, { sourceVersionId: baseline.id, expectedVersion: policy.version, reason: '隔离规则专项结束，以新版本恢复后续测试基线' }, admin)
  policy = (await listFdeWorkflowPolicies())[0]
  const restoredDraft = policy.versions.find(version => version.id === restored.id)!
  await publishFdePolicyVersion(policy.id, { versionId: restored.id, expectedPolicyVersion: policy.version, expectedDraftVersion: restoredDraft.version, reason: '仅隔离测试，恢复初始配置而保留规则历史' }, admin)
  assert.deepEqual((await getProjectWorkflowPolicy(db, { workflowPolicyVersionId: restored.id })).configuration, baseline.configuration)
  assert.equal((await getProjectWorkflowPolicy(db, newProject)).id, draft.id)
  checks.push('isolated-policy-baseline-restored-by-new-publication-with-prior-project-version-retained')
  console.log(JSON.stringify({ ok: true, checks }))
} finally { await pool.end() }
