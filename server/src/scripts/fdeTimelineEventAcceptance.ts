import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { projectTimelineSyncs, projectTimelineTasks, projects, todos, userRoles, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { addFile, createProject, classifyProject, replaceFileContent, setFileStoragePath } from '../services/projectService.js'
import { saveProjectFileRevision } from '../services/projectFileStorageService.js'
import { decideFdeGovernance, proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { bindFdeMaterial, getFdeWorkflow, saveFdePlan } from '../services/fdeWorkflowService.js'
import { createOaApprovalRequest, actOnOaApprovalRequest } from '../services/oaWorkflowService.js'
import { getFdeTasks } from '../services/fdeTaskService.js'
import { previewTimelineTasks, reconcileTimelineEvent, syncTimelineTasks } from '../services/fdeTimelineTaskService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const marker = randomUUID().slice(0, 8), checks: string[] = []
const people = ['投资经理', '投资经理', '财务', '风控与法务', '总裁', '投资经理', '董事长'].map((role, index) => ({ id: randomUUID(), role, name: `事件联动-${marker}-${index}`, email: `timeline-event-${marker}-${index}@example.invalid`, department: `事件联动-${marker}`, passwordHash: 'not-for-login' }))
const [owner, secretary, finance, legal, president, outsider, chairman] = people
try {
  await db.insert(users).values(people)
  for (const person of people) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
  let project = await createProject({ name: `自动联动-${marker}`, targetDate: '2027-01-31', cycleDays: 30 }, owner.id)
  const events = () => db.select().from(projectTimelineSyncs).where(eq(projectTimelineSyncs.projectId, project.id))
  const links = () => db.select().from(projectTimelineTasks).where(eq(projectTimelineTasks.projectId, project.id))
  const readProject = async () => (await db.select().from(projects).where(eq(projects.id, project.id)))[0]
  const readTask = async (id: string) => (await db.select().from(todos).where(eq(todos.id, id)))[0]
  const materialVersion = async (requirementKey: string) => (await getFdeWorkflow(project.id, owner.id)).materials.find(item => item.stage === '立项' && item.requirementKey === requirementKey)?.version
  assert.equal((await links()).length, 0); assert.equal((await events()).length, 0)
  project = await classifyProject({ projectId: project.id, userId: owner.id, toClassification: 'normal', expectedVersion: project.version, reason: '隔离初筛入库，验证待配置联动' })
  assert.equal((await links()).length, 0)
  assert.equal((await getFdeTasks(project.id, owner.id)).timelinePending.count, 1)
  const pending = (await events())[0]; assert.equal(pending.source, 'classification'); assert.equal(pending.status, 'pending')
  await assert.rejects(getFdeTasks(project.id, outsider.id))
  checks.push('pool-registration-no-actions:authorized-intake-persists-visible-pending-without-granting-roles')

  const governance = await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '配置真实职责后自动恢复流程行动', assignments: [{ duty: 'secretary', userId: secretary.id }, { duty: 'finance', userId: finance.id }, { duty: 'legal', userId: legal.id }, { duty: 'president', userId: president.id }, { duty: 'chairman', userId: chairman.id }, { duty: 'concerned_leader', userId: president.id }] })
  let governanceVersion = governance.version
  if (governance.requiredConfirmers.length) assert.equal((await links()).length, 0, '领导规则尚未确认不得提前生成行动')
  for (const userId of governance.requiredConfirmers) governanceVersion = (await decideFdeGovernance({ projectId: project.id, changeId: governance.id, userId, expectedVersion: governanceVersion, decision: 'confirm', comment: '确认隔离测试正式治理变更' })).version
  assert.equal((await links()).length, 4)
  assert.equal((await getFdeTasks(project.id, owner.id)).timelinePending.count, 0)
  const resolved = (await events()).find(item => item.id === pending.id)!
  assert.equal(resolved.status, 'resolved'); assert.ok(resolved.resolvedBy); assert.deepEqual(resolved.issues, pending.issues)
  checks.push('effective-governance-generates-actions-and-resolves-prior-pending-with-auditable-link')

  const material = (await links()).find(item => item.actionKey === 'material:business_plan')!
  for (const requirementKey of ['business_plan', 'initial_meeting']) await bindFdeMaterial({ projectId: project.id, userId: owner.id, stage: '立项', requirementKey, waiverReason: '仅隔离验收使用正式允许的免传' })
  assert.equal((await readTask(material.taskId)).status, '已取消')
  assert.equal((await links()).length, 4)
  assert.equal((await events()).filter(item => item.source === 'material' && item.status === 'completed').length, 2)
  checks.push('material-change-automatically-retires-only-unexecuted-action-keeping-original-id')

  const bytes = Buffer.from(`事件真实原件-${marker}`), hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
  const file = await addFile({ projectId: project.id, name: '联动材料.txt', type: 'TXT', category: '项目资料', uploader: owner.name, byteSize: bytes.length, sha256: hash(bytes) }, owner.id)
  await setFileStoragePath(file.id, await saveProjectFileRevision(project.id, file.id, bytes), owner.id)
  await bindFdeMaterial({ projectId: project.id, userId: owner.id, stage: '立项', requirementKey: 'business_plan', fileId: file.id, expectedVersion: await materialVersion('business_plan') })
  const revised = Buffer.from(`事件修订原件-${marker}`)
  await replaceFileContent(file.id, await saveProjectFileRevision(project.id, file.id, revised), '1KB', revised.length, hash(revised), owner.id, 1)
  assert.equal((await readTask(material.taskId)).status, '未开始')
  assert.equal((await events()).filter(item => item.sourceKey === `file:${file.id}:2`).length, 1)
  await bindFdeMaterial({ projectId: project.id, userId: owner.id, stage: '立项', requirementKey: 'business_plan', fileId: file.id, expectedVersion: await materialVersion('business_plan') })
  assert.equal((await readTask(material.taskId)).status, '已取消')
  await bindFdeMaterial({ projectId: project.id, userId: owner.id, stage: '立项', requirementKey: 'business_plan', waiverReason: '后续审批另用隔离免传，不扩大文件授权', expectedVersion: await materialVersion('business_plan') })
  checks.push('real-file-version-replacement-invalidates-material-and-restores-original-action-until-rebound')

  let request = await createOaApprovalRequest({ projectId: project.id, userId: owner.id, targetStage: '尽调计划制定', reason: '阶段审批联动验证' })
  const beforeApproval = (await events()).length
  const approveAll = async () => {
    while (request.status === '审批中') {
      const node = request.nodes.find(item => item.id === request.currentNodeId)!
      const userId = node.approverUserIds.find(id => id !== owner.id && !node.approvedByUserIds.includes(id))!
      assert.ok(userId)
      const oldCount = (await events()).length
      request = (await actOnOaApprovalRequest({ requestId: request.id, userId, expectedVersion: request.lockVersion, action: 'approve', comment: '隔离验证正式审批联动' })).request
      if (request.status === '审批中') assert.equal((await events()).length, oldCount)
    }
  }
  await approveAll()
  assert.equal((await readProject()).stage, '尽调计划制定'); assert.equal((await events()).length, beforeApproval + 1)
  const stageConclusion = (await links()).find(item => item.stage === '尽调计划制定' && item.actionKey === 'conclusion')!
  assert.ok(stageConclusion)
  const earlier = (await links()).find(item => item.stage === '立项' && item.actionKey === 'conclusion')!
  assert.equal((await readTask(earlier.taskId)).status, '已取消'); assert.equal((await readTask(earlier.taskId)).completedAt, null)
  checks.push('only-final-stage-approval-generates-next-actions-without-fabricating-old-task-completion')

  await saveFdePlan({ projectId: project.id, userId: owner.id, cycleDays: 30, targetDate: '2027-02-10' })
  assert.equal((await events()).filter(item => item.source === 'plan').length, 1)
  assert.equal((await readTask(stageConclusion.taskId)).dueDate, (await previewTimelineTasks(project.id, owner.id)).date)
  request = await createOaApprovalRequest({ projectId: project.id, userId: owner.id, targetStage: '尽调计划审核', reason: '提交计划时对账当前节点' })
  assert.equal((await readTask(stageConclusion.taskId)).status, '已取消')
  const reviewer = request.nodes.find(item => item.id === request.currentNodeId)!.approverUserIds[0]
  request = (await actOnOaApprovalRequest({ requestId: request.id, userId: reviewer, expectedVersion: request.lockVersion, action: 'return', comment: '退回计划补充核验' })).request
  assert.equal((await readTask(stageConclusion.taskId)).status, '未开始')
  request = (await actOnOaApprovalRequest({ requestId: request.id, userId: owner.id, expectedVersion: request.lockVersion, action: 'resubmit', comment: '重新提交原计划验证恢复' })).request
  assert.equal((await readTask(stageConclusion.taskId)).status, '已取消')
  await approveAll(); assert.equal((await readProject()).stage, '尽调')
  assert.ok((await links()).some(item => item.actionKey === 'team_formal'))
  checks.push('plan-save-submit-return-resubmit-final-approval-reconcile-and-reuse-stable-action-ids')

  const savedRoles = await db.select().from(userRoles).where(eq(userRoles.userId, secretary.id))
  await db.delete(userRoles).where(eq(userRoles.userId, secretary.id))
  try {
    await bindFdeMaterial({ projectId: project.id, userId: owner.id, stage: '尽调', requirementKey: 'business_dd', waiverReason: '缺岗时保存材料但不非法分配行动' })
    assert.equal((await getFdeTasks(project.id, owner.id)).timelinePending.count, 1)
    assert.equal((await db.select().from(userRoles).where(eq(userRoles.userId, secretary.id))).length, 0)
  } finally { await db.insert(userRoles).values(savedRoles) }
  const snapshot = await previewTimelineTasks(project.id, owner.id)
  await syncTimelineTasks(project.id, owner.id, { clientRequestId: randomUUID(), fingerprint: snapshot.fingerprint })
  assert.equal((await getFdeTasks(project.id, owner.id)).timelinePending.count, 0)
  checks.push('revoked-role-leaves-source-committed-and-pending:manual-current-state-recovery-never-regrants-role')

  const beforeProject = await readProject(), beforeEvents = await events(), beforeTasks = await db.select().from(todos).where(eq(todos.projectId, project.id))
  await assert.rejects(db.transaction(async tx => {
    await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${project.id} FOR UPDATE`)
    await tx.update(projects).set({ targetDate: '2027-02-11' }).where(eq(projects.id, project.id))
    // Invalid synthetic actor causes a real FK failure after reading the changed source.
    await reconcileTimelineEvent(tx, project.id, randomUUID(), { source: 'plan', sourceKey: `fault:${randomUUID()}` })
  }))
  assert.deepEqual(await readProject(), beforeProject); assert.deepEqual(await events(), beforeEvents)
  assert.deepEqual(await db.select().from(todos).where(eq(todos.projectId, project.id)), beforeTasks)
  checks.push('real-database-failure-rolls-back-source-event-and-all-derived-task-writes')

  const sourceKey = `repeat:${randomUUID()}`
  await Promise.all([1, 2].map(() => db.transaction(async tx => {
    await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${project.id} FOR UPDATE`)
    await reconcileTimelineEvent(tx, project.id, owner.id, { source: 'plan', sourceKey })
  })))
  assert.equal((await events()).filter(item => item.sourceKey === sourceKey).length, 1)
  assert.deepEqual(await db.select().from(todos).where(eq(todos.projectId, project.id)), beforeTasks)
  checks.push('concurrent-same-source-event-one-receipt-and-no-op-preserves-execution-versions')
  console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, passed: checks.length, checks }))
} finally { await pool.end() }
