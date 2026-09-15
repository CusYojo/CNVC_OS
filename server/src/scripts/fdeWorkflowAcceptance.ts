import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { projects, users, projectStageMaterials, projectFiles, projectRecords, todos } from '../db/schema.js'
import { createProject, classifyProject, moveProjectStage } from '../services/projectService.js'
import { saveProjectFile } from '../services/projectFileStorageService.js'
import { identityRepositories } from '../repositories/index.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { actOnOaApprovalRequest, createOaApprovalRequest } from '../services/oaWorkflowService.js'
import { bindFdeMaterial, buildFdePlan, FDE_STAGE_REQUIREMENTS, getFdeWorkflow, saveFdePlan, validateFdePlan } from '../services/fdeWorkflowService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/, '本验收仅允许在 FDE 隔离前缀运行')
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const checks: string[] = []
const ownerId = randomUUID()
const marker = randomUUID().slice(0, 8)
const roleNames = ['投资经理', '投资总监', '投委会秘书', '财务', '风控与法务', '董事长', '投委会委员', '总裁']
const accounts = roleNames.map((role, index) => ({ id: index === 0 ? ownerId : randomUUID(), name: `FDE-${role}-${marker}`, email: `fde-flow-${index}-${marker}@example.invalid`, role, department: 'FDE隔离验收', passwordHash: 'not-for-login' }))
const expectCode = async (promise: Promise<unknown>, code: string) => {
  const failure = await promise.then(() => null, (cause) => cause as { code: string })
  assert.equal(failure?.code, code)
}

try {
  for (const days of [15, 30, 40]) {
    const actions = buildFdePlan(days, '2027-01-31', ownerId)
    validateFdePlan(days, '2027-01-31', actions)
    assert.equal(actions.length, 14)
    assert.equal(actions.at(-1)?.dueDate, '2027-01-31')
  }
  assert.throws(() => buildFdePlan(20, '2027-01-31', ownerId))
  assert.throws(() => buildFdePlan(15, '2027-02-30', ownerId))
  checks.push('15-30-40-day-deterministic-plan-and-date-validation')
  await db.insert(users).values(accounts)
  for (const account of accounts) await identityRepositories.users.synchronizeAdministrationBindings(account.id, account.role, account.department)
  let project = await createProject({ name: `FDE主链-${marker}`, owner: accounts[0].name, ownerUserId: ownerId, collaborators: [], investmentFund: '隔离验收基金' }, ownerId)
  await expectCode(createOaApprovalRequest({ userId: ownerId, projectId: project.id, targetStage: '立项', reason: '项目池不得跳过入库' }), 'OA_POOL_INTAKE_REQUIRED')
  project = await classifyProject({ projectId: project.id, userId: ownerId, toClassification: 'normal', expectedVersion: project.version, reason: '隔离验收入库初筛完成' })
  await proposeFdeGovernance({ projectId: project.id, userId: ownerId, ownerUserId: ownerId, expectedVersion: project.governanceVersion, reason: '隔离验收配置真实职责', assignments: [
    { duty: 'concerned_leader', userId: accounts[5].id }, { duty: 'finance', userId: accounts[3].id }, { duty: 'legal', userId: accounts[4].id },
  ] })
  await expectCode(moveProjectStage(project.id, '已 Close', ownerId, project.version), 'FDE_APPROVAL_REQUIRED')
  await expectCode(createOaApprovalRequest({ userId: ownerId, projectId: project.id, targetStage: '尽调计划制定', reason: '材料缺失应拒绝提交' }), 'FDE_STAGE_GATE_FAILED')
  checks.push('pool-cannot-submit-and-missing-materials-block-submission')
  // 同名文件存在也不会自动满足材料要求。
  const fakeFileId = randomUUID()
  await db.insert(projectFiles).values({ id: fakeFileId, projectId: project.id, name: '商业计划书.pdf', type: 'PDF', category: '项目资料', uploader: accounts[0].name, uploadedBy: ownerId, storagePath: null })
  await expectCode(createOaApprovalRequest({ userId: ownerId, projectId: project.id, targetStage: '尽调计划制定', reason: '同名文件不能冒充绑定' }), 'FDE_STAGE_GATE_FAILED')
  await expectCode(bindFdeMaterial({ userId: ownerId, projectId: project.id, stage: '立项', requirementKey: 'business_plan', fileId: fakeFileId }), 'FDE_MATERIAL_FILE_INVALID')
  checks.push('same-name-and-missing-original-file-do-not-pass-gate')
  const fileBytes = Buffer.from('FDE isolated acceptance material')
  const storagePath = await saveProjectFile(project.id, fakeFileId, fileBytes)
  await db.update(projectFiles).set({ storagePath, byteSize: fileBytes.length }).where(eq(projectFiles.id, fakeFileId))
  await bindFdeMaterial({ userId: ownerId, projectId: project.id, stage: '立项', requirementKey: 'business_plan', fileId: fakeFileId })
  await assert.rejects(db.insert(projectStageMaterials).values({ projectId: project.id, stage: '立项', requirementKey: 'invalid-null-evidence', updatedBy: ownerId }), '数据库不得接受既无文件又无免传说明的绑定')
  const targets = ['尽调计划制定', '尽调计划审核', '内核', '投决', '打款', '投后'] as const
  const unfinishedTodoId = randomUUID()
  await db.insert(todos).values({ id: unfinishedTodoId, projectId: project.id, projectName: project.name, title: '关闭项目时不得伪造完成的任务', owner: accounts[0].name, ownerUserId: ownerId, dueDate: '2027-01-31', createdBy: ownerId })
  for (const targetStage of targets) {
    const current = FDE_STAGE_REQUIREMENTS.find((stage) => stage.stage === project.stage)!
    for (const material of current.materials) {
      const existing = (await getFdeWorkflow(project.id, ownerId)).materials.find((binding) => binding.stage === current.stage && binding.requirementKey === material.key)
      if (!existing) await bindFdeMaterial({ projectId: project.id, userId: ownerId, stage: current.stage, requirementKey: material.key, waiverReason: `隔离验收替代证据说明：${material.label}` })
    }
    if (project.stage === '尽调计划制定') await saveFdePlan({ projectId: project.id, userId: ownerId, cycleDays: 30, targetDate: '2027-01-31' })
    let request = await createOaApprovalRequest({ userId: ownerId, projectId: project.id, targetStage, reason: `隔离验收从${project.stage}推进到${targetStage}` })
    if (targetStage === '尽调计划制定') {
      const approverId = request.nodes[1].approverUserIds.find((id) => id !== ownerId)!
      await db.update(projectFiles).set({ version: 2 }).where(eq(projectFiles.id, fakeFileId))
      await expectCode(actOnOaApprovalRequest({ userId: approverId, requestId: request.id, action: 'approve', comment: '文件版本已变化不能通过', expectedVersion: request.lockVersion }), 'FDE_STAGE_GATE_FAILED')
      request = (await actOnOaApprovalRequest({ userId: approverId, requestId: request.id, action: 'return', comment: '请重新绑定最新文件版本', expectedVersion: request.lockVersion })).request
      const binding = (await getFdeWorkflow(project.id, ownerId)).materials.find((item) => item.requirementKey === 'business_plan')!
      await bindFdeMaterial({ userId: ownerId, projectId: project.id, stage: '立项', requirementKey: 'business_plan', fileId: fakeFileId, expectedVersion: binding.version })
      request = (await actOnOaApprovalRequest({ userId: ownerId, requestId: request.id, action: 'resubmit', comment: '已绑定最新文件版本重新提交', expectedVersion: request.lockVersion })).request
      assert.equal(request.revisions.length, 2)
      assert.notDeepEqual(request.revisions[0].snapshot.materialSnapshot, request.revisions[1].snapshot.materialSnapshot)
      checks.push('decision-rechecks-real-file-version-and-return-resubmission')
    }
    if (targetStage === '尽调计划审核') {
      const [submittedProject] = await db.select().from(projects).where(eq(projects.id, project.id)).limit(1)
      assert.equal(submittedProject.stage, '尽调计划审核')
      assert.equal(request.targetStage, '尽调')
      const reviewer = request.nodes[1].approverUserIds[0]
      request = (await actOnOaApprovalRequest({ userId: reviewer, requestId: request.id, action: 'return', comment: '请修订行动计划最终日期', expectedVersion: request.lockVersion })).request
      const [returnedProject] = await db.select().from(projects).where(eq(projects.id, project.id)).limit(1)
      assert.equal(returnedProject.stage, '尽调计划制定')
      const returnedRecords = await db.select().from(projectRecords).where(eq(projectRecords.sourceApprovalId, request.id))
      assert.equal(returnedRecords.length, 1); assert.equal(returnedRecords[0].kind, '补充要求')
      assert.ok(returnedRecords[0].content.includes('请修订行动计划最终日期'))
      const returnedPlan = (await getFdeWorkflow(project.id, ownerId)).plan!
      await saveFdePlan({ projectId: project.id, userId: ownerId, cycleDays: 30, targetDate: '2027-02-01', expectedVersion: returnedPlan.version })
      request = (await actOnOaApprovalRequest({ userId: ownerId, requestId: request.id, action: 'resubmit', comment: '行动计划已形成新版本', expectedVersion: request.lockVersion })).request
      assert.equal(request.revisions.length, 2)
      assert.notEqual(request.revisions[0].snapshot.planId, request.revisions[1].snapshot.planId)
      checks.push('plan-submission-review-return-revision-resubmission')
    }
    await expectCode(actOnOaApprovalRequest({ userId: ownerId, requestId: request.id, action: 'approve', comment: '申请人不可自批', expectedVersion: request.lockVersion }), 'OA_SELF_APPROVAL_FORBIDDEN')
    if (current.materials.length) {
      await expectCode(bindFdeMaterial({ projectId: project.id, userId: ownerId, stage: current.stage, requirementKey: current.materials[0].key, waiverReason: '活动审批材料不得修改' }), 'FDE_APPROVAL_ACTIVE')
    }
    while (request.status === '审批中') {
      const node = request.nodes.find((item) => item.id === request.currentNodeId)!
      const approverId = node.approverUserIds.find((id) => id !== ownerId && !node.approvedByUserIds.includes(id))
      assert.ok(approverId, `节点${node.name}必须存在非申请人的可用审批人`)
      const result = await actOnOaApprovalRequest({ userId: approverId, requestId: request.id, action: 'approve', comment: '隔离验收独立审批同意', expectedVersion: request.lockVersion })
      await expectCode(actOnOaApprovalRequest({ userId: approverId, requestId: request.id, action: 'approve', comment: '过期版本不能重复决定', expectedVersion: request.lockVersion }), 'OA_VERSION_CONFLICT')
      request = result.request
    }
    const [nextProject] = await db.select().from(projects).where(eq(projects.id, project.id)).limit(1)
    project = nextProject
    assert.equal(project.stage, targetStage === '尽调计划审核' ? '尽调' : targetStage)
    if (targetStage === '尽调计划审核') {
      const workflow = await getFdeWorkflow(project.id, ownerId)
      assert.equal(workflow.plan?.status, 'locked')
      const reviewRecords = await db.select().from(projectRecords).where(eq(projectRecords.sourceApprovalId, request.id))
      assert.ok(reviewRecords.some(row => row.kind === '审批结论' && row.content.includes('申请状态：已通过')))
      assert.equal(new Set(reviewRecords.map(row => row.sourceKey)).size, reviewRecords.length)
      checks.push('FDE-COLLAB-010:plan-review-return-and-approval-records-retain-source-version-without-duplicate-decisions')
      const amendedActions = workflow.plan!.actions.map((action, index) => ({ actionKey: action.actionKey, title: index === 0 ? `${action.title}（修订）` : action.title, ownerUserId: action.ownerUserId, participantUserIds: index === 0 ? [...new Set([...action.participantUserIds, accounts[4].id])] : action.participantUserIds, dueDate: action.dueDate, deliverable: action.deliverable }))
      const amended = await saveFdePlan({ projectId: project.id, userId: ownerId, cycleDays: workflow.plan!.cycleDays, targetDate: workflow.plan!.targetDate, actions: amendedActions, expectedVersion: workflow.plan!.version })
      assert.equal(amended.plan?.status, 'locked')
      assert.equal(amended.plan?.actions[0].title.endsWith('（修订）'), true)
      assert.equal(amended.plan?.actions[0].participantUserIds.includes(accounts[4].id), true)
      await expectCode(saveFdePlan({ projectId: project.id, userId: ownerId, cycleDays: 40, targetDate: '2027-02-28', expectedVersion: amended.plan?.version }), 'FDE_APPROVED_PLAN_ACTIONS_REQUIRED')
      checks.push('approved-plan-actions-remain-amendable-and-participants-resynchronize')
    }
  }
  assert.equal(project.lifecycle, 'closed')
  assert.equal(project.progress, 100)
  const [closedTodo] = await db.select().from(todos).where(eq(todos.id, unfinishedTodoId)).limit(1)
  assert.equal(closedTodo.status, '已关闭')
  const bindings = await db.select().from(projectStageMaterials).where(eq(projectStageMaterials.projectId, project.id))
  assert.ok(bindings.every((binding) => Boolean(binding.waiverReason) || Boolean(binding.fileId)))
  checks.push('eight-stage-success-chain', 'applicant-self-approval-denied', 'active-material-snapshot-frozen', 'approved-plan-baseline-locked', 'payment-closes-project-at-100-percent', 'stale-decision-version-rejected', 'direct-stage-bypass-rejected', 'mysql-null-evidence-constraint')
  console.log(JSON.stringify({ ok: true, checks }))
} finally { await pool.end() }
