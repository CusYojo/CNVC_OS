import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { and, eq, like, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, meetings, oaApprovalRequests, projectFiles, projectFileVersions, projectPlanActions, projects, todoAcceptances, todoFeedbacks, todos, users } from '../db/schema.js'
import { createProject, classifyProject, deleteFile } from '../services/projectService.js'
import { identityRepositories } from '../repositories/index.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { bindFdeMaterial, getFdeWorkflow, lockApprovedFdePlan, saveFdePlan, updateFdePlanAction } from '../services/fdeWorkflowService.js'
import { createFdeTask, feedbackFdeTask, decideFdeTask, getFdeTasks, requestFdeTaskExtension, syncFdePlanTasks, cancelFdeTask } from '../services/fdeTaskService.js'
import { actOnOaApprovalRequest, createOaApprovalRequest, listOaApprovalRequests } from '../services/oaWorkflowService.js'
import { createMeeting, createTodo, deleteTodo, updateTodo } from '../services/meetingService.js'
import { syncTodoOwnerIdentity } from '../services/identityResolutionService.js'
import { saveProjectFile } from '../services/projectFileStorageService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/, '仅允许随机隔离前缀验收')
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const checks: string[] = []
const marker = randomUUID().slice(0, 8)
const accounts = ['投资经理', '投资经理', '董事长', '系统管理员', '投资经理'].map((role, index) => ({ id: randomUUID(), name: `任务验收-${marker}-${index}`, role, email: `fde-task-${marker}-${index}@example.invalid`, department: 'FDE任务验收', passwordHash: 'not-for-login' }))
const [owner, member, leader, admin, stranger] = accounts
const date = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
const expectCode = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(() => null, (cause) => cause as { code?: string; message: string })
  assert.equal(error?.code, code, `${code}: ${error?.message ?? 'unexpected success'}`)
}

try {
  await db.insert(users).values(accounts)
  for (const account of accounts) await identityRepositories.users.synchronizeAdministrationBindings(account.id, account.role, account.department)
  let project = await createProject({ name: `任务闭环-${marker}`, owner: owner.name, ownerUserId: owner.id, collaborators: [], targetDate: date(90) }, owner.id)
  project = await classifyProject({ projectId: project.id, userId: owner.id, expectedVersion: project.version, toClassification: 'normal', reason: '任务隔离验收入库初筛' })
  await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '配置任务负责人、验收领导和项目董事长', assignments: [{ duty: 'member', userId: member.id }, { duty: 'concerned_leader', userId: leader.id }, { duty: 'chairman', userId: leader.id }] })
  const getTask = async (id: string) => (await getFdeTasks(project.id, owner.id)).tasks.find((task) => task.id === id)!
  const getRequest = async (id: string) => (await listOaApprovalRequests(owner.id)).find((request) => request.id === id)!
  const createTask = async (title: string) => {
    const input = { clientRequestId: randomUUID(), title, ownerUserId: member.id, dueDate: date(2), deliverable: '提交真实结果文件' }
    await createFdeTask(project.id, owner.id, input)
    const data = await createFdeTask(project.id, owner.id, input)
    assert.equal(data.tasks.filter((task) => task.id === input.clientRequestId).length, 1)
    await expectCode(createFdeTask(project.id, owner.id, { ...input, title: '不能复用同一编号创建其他任务' }), 'FDE_TASK_REQUEST_REUSED')
    return data.tasks.find((task) => task.title === title)!
  }
  let task = await createTask('成果独立验收')
  assert.equal(task.ownerUserId, member.id)
  const creationAudits = await db.select().from(auditLogs).where(and(eq(auditLogs.userId, owner.id), eq(auditLogs.action, '分配任务'), like(auditLogs.target, '%成果独立验收%')))
  assert.equal(creationAudits.length, 1)
  checks.push('task-create-replay-is-idempotent-with-one-audit-and-no-payload-reuse')
  await expectCode(getFdeTasks(project.id, stranger.id), 'PROJECT_FORBIDDEN')
  await expectCode(getFdeTasks(project.id, admin.id), 'PROJECT_FORBIDDEN')
  await expectCode(createFdeTask(project.id, member.id, { clientRequestId: randomUUID(), title: '成员不能分配给别人', ownerUserId: owner.id, dueDate: date(2), deliverable: '结果文件' }), 'FDE_TASK_ASSIGN_FORBIDDEN')
  await expectCode(createTodo({ projectId: project.id, title: '不能从姓名猜测负责人', owner: member.name }, owner.id), 'FDE_TASK_OWNER_ID_REQUIRED')
  await expectCode(createTodo({ projectId: project.id, title: '不能伪造新建完成', owner: member.name, ownerUserId: member.id, dueDate: date(2), status: '已完成' }, owner.id), 'FDE_TASK_INITIAL_STATE')
  checks.push('stable-owner-and-admin-outsider-assignment-isolation')
  await expectCode(updateTodo(task.id, { status: '已完成' }, task.version), 'FDE_TASK_EXECUTION_REQUIRED')
  await expectCode(updateTodo(task.id, { projectId: null, dueDate: date(20) }, task.version), 'FDE_TASK_EXECUTION_REQUIRED')
  await expectCode(deleteTodo(task.id), 'FDE_TASK_EXECUTION_REQUIRED')
  await syncTodoOwnerIdentity(task.id, owner.name)
  assert.equal((await getTask(task.id)).ownerUserId, member.id)
  checks.push('legacy-patch-delete-and-name-rebinding-cannot-bypass')

  const progress = { kind: 'progress', progress: 35, result: '完成第一轮访谈', blocker: '等待材料反馈', estimatedDate: date(3) }
  await expectCode(feedbackFdeTask(project.id, task.id, owner.id, { ...progress, expectedVersion: task.version }), 'FDE_TASK_OWNER_REQUIRED')
  await feedbackFdeTask(project.id, task.id, member.id, { ...progress, expectedVersion: task.version })
  task = await getTask(task.id)
  assert.equal(task.status, '进行中'); assert.equal(task.dueDate, date(2))
  await assert.rejects(feedbackFdeTask(project.id, task.id, member.id, { ...progress, progress: 100, expectedVersion: task.version }))
  await assert.rejects(feedbackFdeTask(project.id, task.id, member.id, { kind: 'submission', progress: 100, result: '无证据不能完成', expectedVersion: task.version }))
  checks.push('feedback-estimate-does-not-change-deadline-and-100-requires-evidence')

  const fileId = randomUUID(), versionId = randomUUID(), bytes = Buffer.from(`任务证据-${marker}`)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const storagePath = await saveProjectFile(project.id, fileId, bytes)
  await db.insert(projectFiles).values({ id: fileId, projectId: project.id, name: '成果证据.txt', type: 'TXT', category: '项目资料', uploader: member.name, uploadedBy: member.id, storagePath, byteSize: bytes.length, sha256 })
  await db.insert(projectFileVersions).values({ id: versionId, fileId, version: 1, storagePath, byteSize: bytes.length, sha256, createdBy: member.id })
  const submission = { kind: 'submission', progress: 100, result: '真实访谈结果与附件', evidence: [{ fileId, version: 1 }] }
  await expectCode(feedbackFdeTask(project.id, task.id, member.id, { ...submission, evidence: [{ fileId: randomUUID(), version: 1 }], expectedVersion: task.version }), 'FDE_TASK_EVIDENCE_INVALID')
  await feedbackFdeTask(project.id, task.id, member.id, { ...submission, expectedVersion: task.version })
  task = await getTask(task.id)
  assert.equal(task.status, '待验收'); assert.equal(task.feedbacks.length, 2)
  let feedbackId = task.feedbacks[0].id
  await expectCode(decideFdeTask(project.id, task.id, member.id, { expectedVersion: task.version, feedbackId, action: 'accept', reason: '本人不能验收' }), 'FDE_TASK_SELF_ACCEPTANCE')
  await expectCode(feedbackFdeTask(project.id, task.id, member.id, { ...submission, expectedVersion: task.version - 1 }), 'VERSION_CONFLICT')
  await decideFdeTask(project.id, task.id, owner.id, { expectedVersion: task.version, feedbackId, action: 'return', reason: '请补充交叉验证结论' })
  task = await getTask(task.id)
  assert.equal(task.status, '已退回'); assert.equal(task.feedbacks[0].acceptance?.decision, 'return')
  await feedbackFdeTask(project.id, task.id, member.id, { ...submission, result: '补充交叉验证完成', expectedVersion: task.version })
  task = await getTask(task.id); feedbackId = task.feedbacks[0].id
  await db.update(projectFileVersions).set({ sha256: '0'.repeat(64) }).where(eq(projectFileVersions.id, versionId))
  await expectCode(decideFdeTask(project.id, task.id, owner.id, { expectedVersion: task.version, feedbackId, action: 'accept', reason: '损坏证据不能验收' }), 'FDE_TASK_EVIDENCE_INVALID')
  assert.equal((await getTask(task.id)).status, '待验收')
  await db.update(projectFileVersions).set({ sha256 }).where(eq(projectFileVersions.id, versionId))
  checks.push('immutable-feedback-return-resubmit-and-decision-hash-revalidation')
  const decisions = await Promise.allSettled([owner.id, leader.id].map((userId) => decideFdeTask(project.id, task.id, userId, { expectedVersion: task.version, feedbackId, action: 'accept', reason: '独立核验成果通过' })))
  assert.equal(decisions.filter((result) => result.status === 'fulfilled').length, 1)
  task = await getTask(task.id)
  assert.equal(task.status, '已完成'); assert.ok(task.completedAt)
  const acceptanceRows = await db.select().from(todoAcceptances).where(eq(todoAcceptances.feedbackId, feedbackId))
  assert.equal(acceptanceRows.length, 1)
  await expectCode(deleteFile(fileId, owner.id), 'FILE_TASK_EVIDENCE_REFERENCED')
  checks.push('concurrent-independent-acceptance-once-and-file-evidence-retained')

  let extended = await createTask('延期独立审批')
  const oldDue = extended.dueDate, newDue = date(5)
  await expectCode(requestFdeTaskExtension(project.id, extended.id, member.id, { expectedVersion: extended.version, requestedDueDate: newDue, reason: '等待客户提供真实材料', reviewerUserId: member.id }), 'FDE_EXTENSION_REVIEWER_INVALID')
  await requestFdeTaskExtension(project.id, extended.id, member.id, { expectedVersion: extended.version, requestedDueDate: newDue, reason: '等待客户提供真实材料', reviewerUserId: owner.id })
  extended = await getTask(extended.id)
  assert.equal(extended.dueDate, oldDue)
  let extension = await getRequest(extended.extensions[0].id)
  assert.equal(extension.businessType, 'task_extension')
  await expectCode(requestFdeTaskExtension(project.id, extended.id, member.id, { expectedVersion: extended.version, requestedDueDate: newDue, reason: '同一任务不能重复申请', reviewerUserId: owner.id }), 'FDE_EXTENSION_PENDING')
  await expectCode(actOnOaApprovalRequest({ userId: member.id, requestId: extension.id, action: 'approve', comment: '不能自批延期', expectedVersion: extension.lockVersion }), 'OA_SELF_APPROVAL_FORBIDDEN')
  extension = (await actOnOaApprovalRequest({ userId: owner.id, requestId: extension.id, action: 'return', comment: '补充延期影响说明', expectedVersion: extension.lockVersion })).request
  assert.equal((await getTask(extended.id)).dueDate, oldDue)
  extension = (await actOnOaApprovalRequest({ userId: member.id, requestId: extension.id, action: 'resubmit', comment: '补充客户延期说明及补救措施', expectedVersion: extension.lockVersion })).request
  assert.equal(extension.revisions.length, 2)
  checks.push('extension-current-deadline-until-approval-and-versioned-return-resubmit')

  const workflow = await getFdeWorkflow(project.id, owner.id)
  for (const material of workflow.stages.find((stage) => stage.stage === '立项')!.materials) await bindFdeMaterial({ projectId: project.id, userId: owner.id, stage: '立项', requirementKey: material.key, fileId })
  let stageApproval = await createOaApprovalRequest({ userId: owner.id, projectId: project.id, targetStage: '尽调计划制定', reason: '验证延期不锁死正常阶段审批' })
  while (stageApproval.status === '审批中') {
    const node = stageApproval.nodes.find((item) => item.id === stageApproval.currentNodeId)!
    const reviewer = node.approverUserIds.find((id) => !node.approvedByUserIds.includes(id))!
    stageApproval = (await actOnOaApprovalRequest({ userId: reviewer, requestId: stageApproval.id, action: 'approve', comment: '阶段门禁验收通过', expectedVersion: stageApproval.lockVersion })).request
  }
  const beforeProject = (await db.select().from(projects).where(eq(projects.id, project.id)))[0]
  extension = (await actOnOaApprovalRequest({ userId: owner.id, requestId: extension.id, action: 'approve', comment: '延期合理批准新日期', expectedVersion: extension.lockVersion })).request
  const afterProject = (await db.select().from(projects).where(eq(projects.id, project.id)))[0]
  assert.deepEqual(afterProject, beforeProject)
  assert.equal((await getTask(extended.id)).dueDate, newDue)
  assert.equal(extension.status, '已通过')
  await expectCode(actOnOaApprovalRequest({ userId: owner.id, requestId: extension.id, action: 'approve', comment: '不能重复审批', expectedVersion: extension.lockVersion - 1 }), 'OA_VERSION_CONFLICT')
  checks.push('extension-and-stage-approvals-coexist-without-stage-or-timeline-mutation')

  const plan = (await saveFdePlan({ projectId: project.id, userId: owner.id, cycleDays: workflow.policy.cycleDays[0], targetDate: date(90) })).plan!
  await db.transaction(async (tx) => { await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${project.id} FOR UPDATE`); await lockApprovedFdePlan(tx, project.id) })
  const firstPlanTasks = (await getFdeTasks(project.id, owner.id)).tasks.filter((item) => item.planActionId)
  assert.equal(firstPlanTasks.length, 14)
  await syncFdePlanTasks(project.id, owner.id)
  const secondPlanTasks = (await getFdeTasks(project.id, owner.id)).tasks.filter((item) => item.planActionId)
  assert.deepEqual(secondPlanTasks.map((item) => item.id).sort(), firstPlanTasks.map((item) => item.id).sort())
  const action = plan.actions[0]
  await expectCode(updateFdePlanAction({ projectId: project.id, actionId: action.id, userId: owner.id, status: '已完成', expectedVersion: action.version }), 'FDE_TASK_EXECUTION_REQUIRED')
  const planTask = secondPlanTasks.find((item) => item.planActionId === action.id)!
  const extendedDate = new Date(new Date(`${planTask.dueDate}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10)
  await requestFdeTaskExtension(project.id, planTask.id, owner.id, { expectedVersion: planTask.version, requestedDueDate: extendedDate, reason: '计划行动延期独立核验', reviewerUserId: leader.id })
  const planExtension = await getRequest((await getTask(planTask.id)).extensions[0].id)
  await actOnOaApprovalRequest({ userId: leader.id, requestId: planExtension.id, action: 'approve', expectedVersion: planExtension.lockVersion, comment: '批准行动延期一天' })
  const planProjection = (await getFdeWorkflow(project.id, owner.id)).plan!.actions.find((item) => item.id === action.id)!
  assert.equal(planProjection.effectiveDueDate, extendedDate); assert.equal(planProjection.dueDate, action.dueDate)
  assert.equal((await db.select().from(projectPlanActions).where(eq(projectPlanActions.id, action.id)))[0].dueDate, action.dueDate)
  checks.push('approved-plan-materialization-idempotent-and-task-is-execution-source')

  let cancelled = await createTask('取消关闭未决延期')
  await feedbackFdeTask(project.id, cancelled.id, member.id, { ...progress, expectedVersion: cancelled.version })
  cancelled = await getTask(cancelled.id)
  await requestFdeTaskExtension(project.id, cancelled.id, member.id, { expectedVersion: cancelled.version, requestedDueDate: date(6), reason: '取消前保留延期申请', reviewerUserId: owner.id })
  cancelled = await getTask(cancelled.id)
  await cancelFdeTask(project.id, cancelled.id, owner.id, cancelled.version, '项目工作安排变更取消此任务')
  cancelled = await getTask(cancelled.id)
  assert.equal(cancelled.status, '已取消'); assert.equal(cancelled.feedbacks.length, 1); assert.equal(cancelled.extensions[0].status, '已撤回'); assert.equal(cancelled.dueDate, date(2))
  checks.push('cancellation-retains-feedback-and-closes-pending-extension')

  let rejectedTask = await createTask('延期拒绝撤回及禁用账户')
  const extensionInput = { requestedDueDate: date(6), reason: '验证拒绝与撤回不能改期限', reviewerUserId: owner.id }
  await requestFdeTaskExtension(project.id, rejectedTask.id, member.id, { ...extensionInput, expectedVersion: rejectedTask.version })
  rejectedTask = await getTask(rejectedTask.id)
  let rejectedRequest = await getRequest(rejectedTask.extensions[0].id)
  await expectCode(actOnOaApprovalRequest({ userId: leader.id, requestId: rejectedRequest.id, action: 'approve', comment: '领导不是当前节点审核人', expectedVersion: rejectedRequest.lockVersion }), 'OA_ACTION_FORBIDDEN')
  await db.update(users).set({ status: '禁用' }).where(eq(users.id, owner.id))
  try {
    await expectCode(actOnOaApprovalRequest({ userId: owner.id, requestId: rejectedRequest.id, action: 'approve', comment: '停用账号不能决定', expectedVersion: rejectedRequest.lockVersion }), 'AUTH_INVALID')
  } finally { await db.update(users).set({ status: '启用' }).where(eq(users.id, owner.id)) }
  rejectedRequest = (await actOnOaApprovalRequest({ userId: owner.id, requestId: rejectedRequest.id, action: 'reject', comment: '延期理由不足拒绝', expectedVersion: rejectedRequest.lockVersion })).request
  assert.equal(rejectedRequest.status, '已拒绝'); assert.equal((await getTask(rejectedTask.id)).dueDate, date(2))
  rejectedTask = await getTask(rejectedTask.id)
  await requestFdeTaskExtension(project.id, rejectedTask.id, member.id, { ...extensionInput, expectedVersion: rejectedTask.version })
  rejectedTask = await getTask(rejectedTask.id)
  let withdrawRequest = await getRequest(rejectedTask.extensions.find((request) => request.status === '审批中')!.id)
  await expectCode(actOnOaApprovalRequest({ userId: owner.id, requestId: withdrawRequest.id, action: 'withdraw', comment: '审核人不能代替申请人撤回', expectedVersion: withdrawRequest.lockVersion }), 'OA_ACTION_FORBIDDEN')
  withdrawRequest = (await actOnOaApprovalRequest({ userId: member.id, requestId: withdrawRequest.id, action: 'withdraw', comment: '申请人主动撤回', expectedVersion: withdrawRequest.lockVersion })).request
  assert.equal(withdrawRequest.status, '已撤回'); assert.equal((await getTask(rejectedTask.id)).dueDate, date(2))
  await db.update(projects).set({ lifecycle: 'closed' }).where(eq(projects.id, project.id))
  try {
    await expectCode(feedbackFdeTask(project.id, rejectedTask.id, member.id, { ...progress, expectedVersion: rejectedTask.version }), 'FDE_PROJECT_INACTIVE')
  } finally { await db.update(projects).set({ lifecycle: 'active' }).where(eq(projects.id, project.id)) }
  checks.push('extension-reject-withdraw-disabled-account-and-closed-project-fail-closed')

  await expectCode(createMeeting({ projectId: project.id, projectName: project.name, title: '无稳定负责人必须整笔回滚', host: owner.name, attendees: [owner.name] }, [{ title: '无身份任务', owner: member.name, dueDate: date(2) }], owner.id, owner.name), 'FDE_TASK_OWNER_ID_REQUIRED')
  assert.equal((await db.select().from(meetings).where(and(eq(meetings.projectId, project.id), eq(meetings.title, '无稳定负责人必须整笔回滚')))).length, 0)
  const meeting = await createMeeting({ projectId: project.id, projectName: project.name, title: '会议任务稳定身份', host: owner.name, attendees: [owner.name] }, [{ title: '会议提取任务', owner: '不应按这个姓名解析', ownerUserId: member.id, dueDate: date(2) }], owner.id, owner.name)
  const [meetingTask] = await db.select().from(todos).where(eq(todos.meetingId, meeting.id))
  assert.equal(meetingTask.ownerUserId, member.id); assert.equal(meetingTask.owner, member.name); assert.equal(meetingTask.executionModel, 'fde-v1')
  await expectCode(updateTodo(meetingTask.id, { status: '已完成' }, meetingTask.version), 'FDE_TASK_EXECUTION_REQUIRED')
  checks.push('meeting-action-creation-validates-stable-owner-in-transaction')

  const personal = await createTodo({ title: '原个人待办兼容', owner: member.name }, member.id)
  assert.equal((await updateTodo(personal.id, { status: '已完成' }, personal.version)).status, '已完成')
  await deleteTodo(personal.id)
  const allFeedback = await db.select().from(todoFeedbacks).where(eq(todoFeedbacks.todoId, task.id))
  assert.equal(allFeedback.length, 3)
  const pendingExtensions = await db.select().from(oaApprovalRequests).where(and(eq(oaApprovalRequests.projectId, project.id), eq(oaApprovalRequests.businessType, 'task_extension'), eq(oaApprovalRequests.status, '审批中')))
  assert.equal(pendingExtensions.length, 0)
  checks.push('legacy-personal-todo-compatible-and-audit-history-not-rewritten')
  console.log(JSON.stringify({ ok: true, scope: 'fde-task-execution', checks, count: checks.length }))
} finally { await pool.end() }
