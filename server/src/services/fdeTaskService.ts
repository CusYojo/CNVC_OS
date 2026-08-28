import { createHash, randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.js'
import { requireProjectFileAccess } from './projectFileAccessService.js'
import { oaApprovalNodes, oaApprovalRecords, oaApprovalRequests, oaApprovalRevisions, projectDirectives, projectFiles, projectFileVersions, projectMembers, projectPlanActions, projectPlans, projects, roles, todoAcceptances, todoFeedbackEvidence, todoFeedbacks, todos, userRoles, users } from '../db/schema.js'
import { fdeDate, fdeDueTime, fdeTaskCreateSchema, fdeTaskDecisionSchema, fdeTaskExtensionSchema, fdeTaskFeedbackSchema, taskDeadlineKey, taskTerminal } from '../contracts/fdeTaskContract.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { projectAccessCondition, requireAccessibleProject } from './projectAccessService.js'
import { readProjectFileBuffer } from './projectFileStorageService.js'
import { canReadReferencedDirectiveTasks, directiveTaskAccessCondition, directiveTaskChanged } from './fdeDirectiveLinksService.js'
import { isFdeTaskManager } from './fdeTaskAccessService.js'
import { captureTaskResponsibility, reconcileTaskResponsibility } from './fdeResponsibilityService.js'
import { projectDutyAssignments, projectTimelineSyncs, projectTimelineTasks } from '../db/schema.js'
export { isFdeTaskManager } from './fdeTaskAccessService.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Project = typeof projects.$inferSelect
const failure = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code })
const fail = (code: string, message: string, status = 409): never => { throw failure(status, code, message) }

async function context(tx: Tx, projectId: string, userId: string, writable = true) {
  await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
  const [actor] = await tx.select().from(users).where(eq(users.id, userId))
  if (!actor || actor.status !== '启用') return fail('USER_DISABLED_OR_MISSING', '当前账号不可用', 403)
  const [project] = await tx.select().from(projects).where(and(eq(projects.id, projectId), projectAccessCondition({ uid: actor.id, name: actor.name, role: actor.role })))
  if (!project) return fail('PROJECT_FORBIDDEN', '无权操作当前项目', 403)
  if (project.workflowModel !== 'fde-v1') return fail('FDE_LEGACY_PROJECT', '历史项目请使用原待办流程')
  if (writable && project.lifecycle !== 'active') return fail('FDE_PROJECT_INACTIVE', '关闭或归档项目不能继续执行任务')
  return { project, actor }
}

async function lockTask(tx: Tx, projectId: string, taskId: string, expectedVersion?: number, userId?: string) {
  await tx.execute(sql`SELECT ${todos.id} FROM ${todos} WHERE ${todos.id}=${taskId} FOR UPDATE`)
  const [task] = await tx.select().from(todos).where(and(eq(todos.id, taskId), eq(todos.projectId, projectId)))
  if (!task) return fail('FDE_TASK_NOT_FOUND', '项目任务不存在', 404)
  if (userId && !await canReadReferencedDirectiveTasks(tx, [taskId], userId)) return fail('FDE_DIRECTIVE_FORBIDDEN', '无权读取或处理批示任务', 403)
  if (task.approvalRequestId || task.type === '流程') return fail('FDE_TASK_APPROVAL_ONLY', '流程待办必须在审批中心处理')
  if (expectedVersion !== undefined && task.version !== expectedVersion) return fail('VERSION_CONFLICT', '任务已变化，请刷新后重试')
  return task
}

async function audit(tx: Tx, userId: string, action: string, target: string) {
  const identity = createMySqlIdentityRepositoryContext(tx)
  const actor = await identity.users.findById(userId)
  await identity.audits.append({ userId, userName: actor?.name ?? '未知用户', module: '项目待办', action, target })
}

async function reconcileTaskTimeline(tx: Tx, project: Project, taskId: string, actorId: string) {
  if (project.projectType !== '投资项目') {
    const [task] = await tx.select({ version: todos.version }).from(todos).where(eq(todos.id, taskId))
    const { reconcileTypeLeaderTimes } = await import('./fdeTimelineTimeService.js')
    await reconcileTypeLeaderTimes(tx, project.id, actorId, `type-task:${taskId}:${task.version}`)
  }
  const [link] = await tx.select({ id: projectTimelineTasks.taskId }).from(projectTimelineTasks).where(eq(projectTimelineTasks.taskId, taskId))
  if (!link) {
    const { projectWeeklyPlanItems } = await import('../db/schema.js')
    const [weekly] = await tx.select({ id: projectWeeklyPlanItems.id }).from(projectWeeklyPlanItems).where(and(eq(projectWeeklyPlanItems.taskId, taskId), eq(projectWeeklyPlanItems.sourceKind, 'manual'), eq(projectWeeklyPlanItems.needLeader, true))).limit(1)
    if (!weekly) return
    const [task] = await tx.select({ version: todos.version }).from(todos).where(eq(todos.id, taskId))
    const { reconcileWeeklyLeaderTimes } = await import('./fdeTimelineTimeService.js')
    await reconcileWeeklyLeaderTimes(tx, project.id, actorId, `weekly-task:${taskId}:${task.version}`)
    return
  }
  const [task] = await tx.select({ version: todos.version }).from(todos).where(eq(todos.id, taskId))
  const { reconcileTimelineEvent } = await import('./fdeTimelineTaskService.js')
  await reconcileTimelineEvent(tx, project.id, actorId, { source: 'task', sourceKey: `task:${taskId}:${task.version}` })
}

async function ownerForTask(tx: Tx, project: Project, ownerUserId: string) {
  const [owner] = await tx.select().from(users).where(and(eq(users.id, ownerUserId), eq(users.status, '启用')))
  const [member] = await tx.select().from(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, ownerUserId))).limit(1)
  if (!owner || (project.ownerUserId !== ownerUserId && !member)) return fail('FDE_TASK_OWNER_INVALID', '任务负责人必须是启用的本项目成员', 403)
  return owner
}

// 会议和旧创建入口也必须经过稳定身份校验，不能从姓名推测或创建已完成任务。
export async function prepareFdeTodo(tx: Tx, input: typeof todos.$inferInsert, userId: string) {
  if (!input.projectId) return input
  const [candidate] = await tx.select().from(projects).where(eq(projects.id, input.projectId))
  if (candidate?.workflowModel !== 'fde-v1') return input
  const { project } = await context(tx, candidate.id, userId)
  if (!input.ownerUserId) return fail('FDE_TASK_OWNER_ID_REQUIRED', 'FDE 项目待办必须选择明确的负责人账号', 400)
  const owner = await ownerForTask(tx, project, input.ownerUserId)
  if (owner.id !== userId && !await isFdeTaskManager(tx, project, userId)) return fail('FDE_TASK_ASSIGN_FORBIDDEN', '只有项目负责人或授权领导可以向其他成员分配任务', 403)
  if ((input.status && input.status !== '未开始') || input.approvalRequestId || input.type === '流程' || input.planActionId || (input.progress ?? 0) !== 0 || input.completedAt || input.closureReason) return fail('FDE_TASK_INITIAL_STATE', '新任务必须从未开始状态创建，审批和计划来源不可伪造', 400)
  const dueDate = fdeDate.parse(input.dueDate)
  const dueTime = fdeDueTime.nullable().parse(input.dueTime ?? null)
  return { ...input, projectName: project.name, owner: owner.name, ownerUserId: owner.id, executionModel: 'fde-v1', status: '未开始', progress: 0, dueDate, dueTime, createdBy: userId }
}

export async function createFdeTask(projectId: string, userId: string, raw: unknown) {
  const { clientRequestId, ...input } = fdeTaskCreateSchema.parse(raw)
  const creationFingerprint = createHash('sha256').update(JSON.stringify({ projectId, userId, ...input })).digest('hex')
  await db.transaction(async (tx) => {
    await context(tx, projectId, userId)
    const [existing] = await tx.select().from(todos).where(eq(todos.id, clientRequestId))
    if (existing) {
      if (existing.creationFingerprint !== creationFingerprint) return fail('FDE_TASK_REQUEST_REUSED', '该请求编号已用于其他内容，请刷新后重新创建')
      return
    }
    const prepared = await prepareFdeTodo(tx, { ...input, projectId, owner: '', type: '待办' }, userId)
    await tx.insert(todos).values({ ...prepared, id: clientRequestId, creationFingerprint })
    await audit(tx, userId, '分配任务', `${projectId} / ${input.title} / ${input.ownerUserId}`)
  })
  return getFdeTasks(projectId, userId)
}

// 已批准计划只负责定义；执行事实在 todos。按 planActionId 唯一生成，重复调用不重置任务。
export async function materializeFdePlanTasks(tx: Tx, projectId: string, planId: string) {
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId))
  const [plan] = await tx.select().from(projectPlans).where(and(eq(projectPlans.id, planId), eq(projectPlans.projectId, projectId), eq(projectPlans.status, 'locked')))
  if (!project || !plan) return fail('FDE_PLAN_NOT_LOCKED', '只有审核通过的计划可以生成执行任务')
  if (project.projectType !== '投资项目' || plan.executionKind !== 'investment') return fail('TYPE_RUNTIME_TASK_ADAPTER_REQUIRED', '非投资计划由独立执行事务生成任务，不能使用投资补齐入口丢失时刻或来源')
  const actions = await tx.select().from(projectPlanActions).where(eq(projectPlanActions.planId, planId)).orderBy(asc(projectPlanActions.sortOrder))
  for (const action of actions) {
    const [existing] = await tx.select({ id: todos.id }).from(todos).where(eq(todos.planActionId, action.id))
    if (existing) continue
    const owner = await ownerForTask(tx, project, action.ownerUserId)
    await tx.insert(todos).values({ projectId, projectName: project.name, title: action.title, owner: owner.name, ownerUserId: owner.id, dueDate: action.dueDate, deliverable: action.deliverable, planActionId: action.id, executionModel: 'fde-v1', type: '待办', status: action.status, progress: action.status === '已完成' ? 100 : 0, closureReason: action.status === '已完成' ? '迁移前已完成记录；无新增成果验收证明' : null, createdBy: plan.createdBy })
  }
}

export async function syncFdePlanTasks(projectId: string, userId: string) {
  await db.transaction(async (tx) => {
    const { project } = await context(tx, projectId, userId)
    if (project.ownerUserId !== userId) return fail('FDE_OWNER_REQUIRED', '仅项目负责人可以补齐已批准计划任务', 403)
    const [plan] = await tx.select().from(projectPlans).where(and(eq(projectPlans.projectId, projectId), eq(projectPlans.status, 'locked'))).orderBy(desc(projectPlans.revision)).limit(1)
    if (!plan) return fail('FDE_PLAN_NOT_LOCKED', '尚无已批准计划')
    await materializeFdePlanTasks(tx, projectId, plan.id)
    await audit(tx, userId, '对账计划任务', `${projectId} / ${plan.id}`)
  })
  return getFdeTasks(projectId, userId)
}

async function checkedEvidence(tx: Tx, projectId: string, refs: Array<{ fileId: string; version: number }>, requireCurrent: boolean, userId: string) {
  const result = []
  for (const ref of refs) {
    const [file] = await tx.select().from(projectFiles).where(and(eq(projectFiles.id, ref.fileId), eq(projectFiles.projectId, projectId)))
    const [version] = await tx.select().from(projectFileVersions).where(and(eq(projectFileVersions.fileId, ref.fileId), eq(projectFileVersions.version, ref.version)))
    if (!file || !version || (requireCurrent && file.version !== ref.version) || !version.sha256 || version.byteSize <= 0) return fail('FDE_TASK_EVIDENCE_INVALID', '证据必须是本项目已保存的真实文件版本')
    await requireProjectFileAccess(tx, ref.fileId, userId, 'view')
    const bytes = await readProjectFileBuffer(version.storagePath).catch(() => null)
    if (!bytes || bytes.length !== version.byteSize || createHash('sha256').update(bytes).digest('hex') !== version.sha256) return fail('FDE_TASK_EVIDENCE_INVALID', '证据文件缺失或内容哈希不一致')
    result.push({ fileId: file.id, fileVersionId: version.id, version: version.version, sha256: version.sha256, byteSize: version.byteSize })
  }
  return result
}

export async function feedbackFdeTask(projectId: string, taskId: string, userId: string, raw: unknown) {
  const input = fdeTaskFeedbackSchema.parse(raw)
  await db.transaction(async (tx) => {
    await context(tx, projectId, userId)
    const task = await lockTask(tx, projectId, taskId, input.expectedVersion, userId)
    if (task.ownerUserId !== userId) return fail('FDE_TASK_OWNER_REQUIRED', '只有任务负责人可以提交执行反馈及成果', 403)
    if (taskTerminal(task.status) || task.status === '待验收') return fail('FDE_TASK_STATE_INVALID', '当前任务已结束或正在验收，请先等待验收结果')
    if (task.status === '待确认') return fail('FDE_DIRECTIVE_CONFIRM_REQUIRED', '请先在领导批示中确认接办，不能把待确认事项当作已执行成果')
    const evidence = await checkedEvidence(tx, projectId, input.evidence, true, userId)
    const feedbackId = randomUUID()
    await tx.insert(todoFeedbacks).values({ id: feedbackId, todoId: taskId, taskVersion: task.version + 1, kind: input.kind, progress: input.progress, result: input.result, blocker: input.blocker, estimatedDate: input.estimatedDate, submittedBy: userId })
    if (evidence.length) await tx.insert(todoFeedbackEvidence).values(evidence.map((item) => ({ ...item, feedbackId })))
    await tx.update(todos).set({ status: input.kind === 'submission' ? '待验收' : '进行中', executionModel: 'fde-v1', progress: input.progress, version: task.version + 1 }).where(eq(todos.id, taskId))
    await captureTaskResponsibility(tx, taskId, userId, 'feedback', feedbackId)
    await directiveTaskChanged(tx, taskId, userId, input.kind, `成果记录 ${feedbackId}`)
    await audit(tx, userId, input.kind === 'submission' ? '提交成果待验收' : '执行反馈', `${projectId} / ${taskId} / ${feedbackId}`)
  })
  return getFdeTasks(projectId, userId)
}

export async function decideFdeTask(projectId: string, taskId: string, userId: string, raw: unknown) {
  const input = fdeTaskDecisionSchema.parse(raw)
  await db.transaction(async (tx) => {
    const { project } = await context(tx, projectId, userId)
    const task = await lockTask(tx, projectId, taskId, input.expectedVersion, userId)
    if (task.status !== '待验收') return fail('FDE_TASK_STATE_INVALID', '只有待验收任务可以验收或退回')
    const [feedback] = await tx.select().from(todoFeedbacks).where(and(eq(todoFeedbacks.todoId, taskId), eq(todoFeedbacks.kind, 'submission'))).orderBy(desc(todoFeedbacks.taskVersion)).limit(1)
    if (!feedback || feedback.id !== input.feedbackId) return fail('FDE_TASK_SUBMISSION_CHANGED', '待验收成果已变化')
    if (feedback.submittedBy === userId || task.ownerUserId === userId) return fail('FDE_TASK_SELF_ACCEPTANCE', '不能验收本人提交或本人负责的任务', 403)
    if (!await isFdeTaskManager(tx, project, userId)) return fail('FDE_TASK_ACCEPTOR_REQUIRED', '仅项目负责人或有权领导可以验收', 403)
    if (input.action === 'accept') {
      const evidence = await tx.select().from(todoFeedbackEvidence).where(eq(todoFeedbackEvidence.feedbackId, feedback.id))
      if (!evidence.length) return fail('FDE_TASK_EVIDENCE_REQUIRED', '没有成果证据不能验收通过')
      const checked = await checkedEvidence(tx, projectId, evidence, false, userId)
      if (checked.some((item, index) => item.sha256 !== evidence[index].sha256 || item.byteSize !== evidence[index].byteSize || item.fileVersionId !== evidence[index].fileVersionId)) return fail('FDE_TASK_EVIDENCE_INVALID', '成果证据与提交快照不一致')
    }
    const acceptanceId = randomUUID()
    await tx.insert(todoAcceptances).values({ id: acceptanceId, todoId: taskId, feedbackId: feedback.id, decision: input.action, reason: input.reason, decidedBy: userId })
    await tx.update(todos).set({ status: input.action === 'accept' ? '已完成' : '已退回', executionModel: 'fde-v1', completedAt: input.action === 'accept' ? new Date() : null, version: task.version + 1 }).where(eq(todos.id, taskId))
    if (input.action === 'accept') await closeTaskExtensions(tx, [taskId], userId, '任务已完成，未决延期关闭，原期限未改写')
    await captureTaskResponsibility(tx, taskId, userId, 'acceptance', acceptanceId)
    await directiveTaskChanged(tx, taskId, userId, input.action, input.reason)
    await reconcileTaskTimeline(tx, project, taskId, userId)
    await audit(tx, userId, input.action === 'accept' ? '成果验收通过' : '成果退回', `${projectId} / ${taskId} / ${feedback.id} / ${input.reason}`)
  })
  return getFdeTasks(projectId, userId)
}

export async function cancelFdeTask(projectId: string, taskId: string, userId: string, expectedVersion: number, reason: string) {
  z.object({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(5).max(2000) }).parse({ expectedVersion, reason })
  await db.transaction(async (tx) => {
    const { project } = await context(tx, projectId, userId)
    const task = await lockTask(tx, projectId, taskId, expectedVersion, userId)
    if (!await isFdeTaskManager(tx, project, userId)) return fail('FDE_TASK_MANAGER_REQUIRED', '仅项目负责人或授权领导可取消任务', 403)
    if (taskTerminal(task.status)) return fail('FDE_TASK_STATE_INVALID', '已结束任务不能再次取消')
    if (task.planActionId) return fail('FDE_PLAN_LOCKED', '已批准计划行动须通过计划变更处理，不能单独删除或取消')
    const [directive] = await tx.select({ id: projectDirectives.id }).from(projectDirectives).where(eq(projectDirectives.taskId, taskId))
    if (directive) return fail('FDE_DIRECTIVE_WITHDRAW_REQUIRED', '请由批示发出者撤回批示，不能从通用任务入口取消')
    await tx.update(todos).set({ status: '已取消', executionModel: 'fde-v1', closureReason: reason, version: task.version + 1 }).where(eq(todos.id, taskId))
    await reconcileTaskResponsibility(tx, taskId, userId, 'cancel', taskId)
    await closeTaskExtensions(tx, [taskId], userId, reason)
    await reconcileTaskTimeline(tx, project, taskId, userId)
    await audit(tx, userId, '取消任务', `${projectId} / ${taskId} / ${reason}`)
  })
  return getFdeTasks(projectId, userId)
}

async function extensionNodeTodo(tx: Tx, request: typeof oaApprovalRequests.$inferSelect, reviewer: { id: string; name: string }) {
  await tx.insert(todos).values({ projectId: request.projectId, projectName: request.projectName, title: `审批：${request.title}`, owner: reviewer.name, ownerUserId: reviewer.id, dueDate: String(request.businessPayload.originalDueDate), dueTime: fdeDueTime.nullable().parse(request.businessPayload.originalDueTime ?? null), type: '流程', approvalRequestId: request.id, createdBy: request.applicantUserId })
}

export async function requestFdeTaskExtension(projectId: string, taskId: string, userId: string, raw: unknown) {
  const input = fdeTaskExtensionSchema.parse(raw)
  await db.transaction(async (tx) => {
    const { project, actor } = await context(tx, projectId, userId)
    const task = await lockTask(tx, projectId, taskId, input.expectedVersion, userId)
    if (task.ownerUserId !== userId) return fail('FDE_TASK_OWNER_REQUIRED', '只有任务负责人可以申请延期', 403)
    if (taskTerminal(task.status) || !task.dueDate) return fail('FDE_TASK_STATE_INVALID', '已结束或没有期限的任务不能申请延期')
    if (task.dueTime && !input.requestedDueTime) return fail('FDE_EXTENSION_TIME_REQUIRED', '此任务精确到时刻，请明确填写新截止时刻', 400)
    if (taskDeadlineKey(input.requestedDueDate, input.requestedDueTime) <= taskDeadlineKey(task.dueDate, task.dueTime)) return fail('FDE_EXTENSION_DATE_INVALID', '新截止时间必须晚于当前有效时间', 400)
    if (project.targetDate && input.requestedDueDate > project.targetDate) return fail('FDE_EXTENSION_EXCEEDS_PROJECT', '延期超过项目最终日期，须先完成项目计划日期变更审批')
    if (userId === input.reviewerUserId || !await isFdeTaskManager(tx, project, input.reviewerUserId)) return fail('FDE_EXTENSION_REVIEWER_INVALID', '延期审核人必须是非本人的有权项目负责人或领导', 403)
    if (!await canReadReferencedDirectiveTasks(tx, [taskId], input.reviewerUserId)) return fail('FDE_EXTENSION_REVIEWER_INVALID', '延期审核人须有批示任务查看权限', 403)
    const [pending] = await tx.select({ id: oaApprovalRequests.id }).from(oaApprovalRequests).where(eq(oaApprovalRequests.activeKey, taskId)).limit(1)
    if (pending) return fail('FDE_EXTENSION_PENDING', '该任务已有审批中的延期申请')
    const [reviewer] = await tx.select().from(users).where(eq(users.id, input.reviewerUserId))
    const id = randomUUID(), submitId = randomUUID(), nodeId = randomUUID()
    const payload = { originalDueDate: task.dueDate, originalDueTime: task.dueTime, requestedDueDate: input.requestedDueDate, requestedDueTime: input.requestedDueTime, ownerUserId: userId, taskVersion: task.version }
    await tx.insert(oaApprovalRequests).values({ id, requestNo: `EXT-${id}`, projectId, projectName: project.name, title: `任务延期 · ${task.title}`.slice(0, 255), type: '任务延期', businessType: 'task_extension', taskId, businessPayload: payload, fromStage: project.stage, targetStage: project.stage, applicantUserId: userId, applicantName: actor.name, department: actor.department, activeKey: taskId, currentNodeId: nodeId, currentNodeName: '上级延期审批', reason: input.reason })
    await tx.insert(oaApprovalNodes).values([
      { id: submitId, requestId: id, name: '发起人提交', approverRole: '任务负责人', mode: '或签', sequence: 0, status: '已通过', approverUserIds: [userId], approverNames: [actor.name], approvedByUserIds: [userId], approvedByNames: [actor.name], completedAt: new Date(), comment: input.reason },
      { id: nodeId, requestId: id, name: '上级延期审批', approverRole: '项目负责人/授权领导', mode: '或签', sequence: 1, status: '待审批', approverUserIds: [reviewer.id], approverNames: [reviewer.name] },
    ])
    await tx.insert(oaApprovalRevisions).values({ requestId: id, revision: 1, submittedBy: userId, snapshot: { taskId, ...payload, reason: input.reason, reviewerUserId: reviewer.id } })
    await tx.insert(oaApprovalRecords).values({ requestId: id, nodeId: submitId, nodeName: '发起人提交', operatorUserId: userId, operatorName: actor.name, action: '提交', comment: input.reason })
    const [request] = await tx.select().from(oaApprovalRequests).where(eq(oaApprovalRequests.id, id))
    await extensionNodeTodo(tx, request, reviewer)
    await tx.update(todos).set({ executionModel: 'fde-v1', version: task.version + 1 }).where(eq(todos.id, task.id))
    await directiveTaskChanged(tx, taskId, userId, 'extension-request', `延期申请 ${id}`)
    await audit(tx, userId, '申请任务延期', `${projectId} / ${taskId} / ${id} / 原期限保持 ${task.dueDate}`)
  })
  return getFdeTasks(projectId, userId)
}

// OA 入口按业务类型分派，延期不执行投资阶段门禁、更不推进项目阶段。
export async function actOnFdeTaskExtension(input: { userId: string; requestId: string; action: 'approve' | 'return' | 'reject' | 'withdraw' | 'resubmit'; comment: string; expectedVersion?: number }) {
  z.string().trim().min(2).max(8000).parse(input.comment)
  const [initial] = await db.select().from(oaApprovalRequests).where(eq(oaApprovalRequests.id, input.requestId))
  if (!initial || initial.businessType !== 'task_extension' || !initial.projectId) return fail('OA_REQUEST_NOT_FOUND', '延期申请不存在', 404)
  const projectId = initial.projectId
  await db.transaction(async (tx) => {
    const { project, actor } = await context(tx, projectId, input.userId)
    await tx.execute(sql`SELECT ${oaApprovalRequests.id} FROM ${oaApprovalRequests} WHERE ${oaApprovalRequests.id}=${input.requestId} FOR UPDATE`)
    const [request] = await tx.select().from(oaApprovalRequests).where(eq(oaApprovalRequests.id, input.requestId))
    if (request.lockVersion !== input.expectedVersion) return fail('OA_VERSION_CONFLICT', '审批版本已变化，请刷新后重试')
    if (!request.taskId) return fail('FDE_EXTENSION_INVALID', '延期缺少正式任务关联')
    const task = await lockTask(tx, project.id, request.taskId, undefined, input.userId)
    const nodes = await tx.select().from(oaApprovalNodes).where(eq(oaApprovalNodes.requestId, request.id)).orderBy(asc(oaApprovalNodes.sequence))
    const reviewNode = nodes[1]
    if (!reviewNode) return fail('OA_NODES_INVALID', '审批节点不完整')
    const currentOwner = task.ownerUserId === request.applicantUserId && task.ownerUserId === request.businessPayload.ownerUserId
    const currentDeadline = task.dueDate === request.businessPayload.originalDueDate && task.dueTime === (request.businessPayload.originalDueTime ?? null)
    if (input.action === 'resubmit') {
      if (actor.id !== request.applicantUserId) return fail('OA_ACTION_FORBIDDEN', '只有申请人可以重新提交', 403)
      if (request.status !== '已退回' || taskTerminal(task.status) || !currentOwner || !currentDeadline) return fail('FDE_EXTENSION_STATE_CHANGED', '任务或期限已变化，请重新申请延期')
      if (!await isFdeTaskManager(tx, project, reviewNode.approverUserIds[0]) || reviewNode.approverUserIds.includes(actor.id)) return fail('FDE_EXTENSION_REVIEWER_INVALID', '原审核人不再符合条件，请重新申请', 403)
      const [pending] = await tx.select({ id: oaApprovalRequests.id }).from(oaApprovalRequests).where(eq(oaApprovalRequests.activeKey, task.id))
      if (pending) return fail('FDE_EXTENSION_PENDING', '任务已有另一份延期正在审批')
      const [last] = await tx.select().from(oaApprovalRevisions).where(eq(oaApprovalRevisions.requestId, request.id)).orderBy(desc(oaApprovalRevisions.revision)).limit(1)
      await tx.insert(oaApprovalRevisions).values({ requestId: request.id, revision: (last?.revision ?? 0) + 1, submittedBy: actor.id, snapshot: { taskId: task.id, ...request.businessPayload, reason: input.comment, reviewerUserId: reviewNode.approverUserIds[0] } })
      await tx.update(oaApprovalNodes).set({ status: '待审批', approvedByUserIds: [], approvedByNames: [], completedAt: null, comment: null }).where(eq(oaApprovalNodes.id, reviewNode.id))
      await tx.update(oaApprovalRequests).set({ status: '审批中', activeKey: task.id, currentNodeId: reviewNode.id, currentNodeName: reviewNode.name, reason: input.comment, submittedAt: new Date(), completedAt: null, lockVersion: request.lockVersion + 1, updatedAt: new Date() }).where(eq(oaApprovalRequests.id, request.id))
      await extensionNodeTodo(tx, request, { id: reviewNode.approverUserIds[0], name: reviewNode.approverNames[0] })
    } else {
      if (request.status !== '审批中') return fail('OA_ACTION_INVALID', '延期已结束，不能重复处理')
      if (input.action === 'withdraw') {
        if (request.applicantUserId !== actor.id) return fail('OA_ACTION_FORBIDDEN', '只有申请人可以撤回延期', 403)
      } else {
        if (request.applicantUserId === actor.id) return fail('OA_SELF_APPROVAL_FORBIDDEN', '申请人不能自批延期', 403)
        if (!reviewNode.approverUserIds.includes(actor.id) || !await isFdeTaskManager(tx, project, actor.id)) return fail('OA_ACTION_FORBIDDEN', '不是当前有权审核人', 403)
      }
      if (input.action === 'approve') {
        const requestedDueDate = fdeDate.parse(request.businessPayload.requestedDueDate)
        const requestedDueTime = fdeDueTime.nullable().parse(request.businessPayload.requestedDueTime ?? null)
        if (taskTerminal(task.status) || !currentOwner || !currentDeadline || !task.dueDate || (task.dueTime && !requestedDueTime) || taskDeadlineKey(requestedDueDate, requestedDueTime) <= taskDeadlineKey(task.dueDate, task.dueTime) || (project.targetDate && requestedDueDate > project.targetDate)) return fail('FDE_EXTENSION_STATE_CHANGED', '任务、负责人或期限已变化，不能批准旧延期')
        await tx.update(todos).set({ dueDate: requestedDueDate, dueTime: requestedDueTime, executionModel: 'fde-v1', version: task.version + 1 }).where(eq(todos.id, task.id))
        await reconcileTaskResponsibility(tx, task.id, actor.id, 'extension', request.id)
        await reconcileTaskTimeline(tx, project, task.id, actor.id)
      }
      const status = input.action === 'approve' ? '已通过' : input.action === 'return' ? '已退回' : input.action === 'reject' ? '已拒绝' : '已撤回'
      await tx.update(oaApprovalNodes).set({ status, completedAt: new Date(), comment: input.comment, ...(input.action === 'approve' ? { approvedByUserIds: [actor.id], approvedByNames: [actor.name] } : {}) }).where(eq(oaApprovalNodes.id, reviewNode.id))
      await tx.update(oaApprovalRequests).set({ status, activeKey: null, currentNodeId: null, currentNodeName: status, completedAt: new Date(), lockVersion: request.lockVersion + 1, updatedAt: new Date() }).where(eq(oaApprovalRequests.id, request.id))
      await tx.update(todos).set({ status: '已关闭', closureReason: `延期${status}`, version: sql`${todos.version} + 1` }).where(and(eq(todos.approvalRequestId, request.id), ne(todos.status, '已关闭')))
    }
    await tx.insert(oaApprovalRecords).values({ requestId: request.id, nodeId: input.action === 'resubmit' ? nodes[0].id : reviewNode.id, nodeName: input.action === 'resubmit' ? '修订重新提交' : reviewNode.name, operatorUserId: actor.id, operatorName: actor.name, action: { approve: '同意', return: '退回', reject: '拒绝', withdraw: '撤回', resubmit: '提交' }[input.action], comment: input.comment })
    await directiveTaskChanged(tx, task.id, actor.id, `extension-${input.action}`, `延期申请 ${request.id}`)
    await audit(tx, actor.id, `延期${input.action}`, `${project.id} / ${task.id} / ${request.id} / ${input.comment}`)
  })
}

export async function closeTaskExtensions(tx: Tx, taskIds: string[], actorId: string, reason: string) {
  if (!taskIds.length) return
  const pending = await tx.select().from(oaApprovalRequests).where(and(eq(oaApprovalRequests.businessType, 'task_extension'), inArray(oaApprovalRequests.taskId, taskIds), eq(oaApprovalRequests.status, '审批中')))
  const actor = await createMySqlIdentityRepositoryContext(tx).users.findById(actorId)
  for (const request of pending) {
    await tx.update(oaApprovalRequests).set({ status: '已撤回', activeKey: null, currentNodeId: null, currentNodeName: '关联任务结束', completedAt: new Date(), lockVersion: request.lockVersion + 1, updatedAt: new Date() }).where(eq(oaApprovalRequests.id, request.id))
    if (request.currentNodeId) {
      await tx.update(oaApprovalNodes).set({ status: '已撤回', completedAt: new Date(), comment: reason }).where(eq(oaApprovalNodes.id, request.currentNodeId))
      await tx.insert(oaApprovalRecords).values({ requestId: request.id, nodeId: request.currentNodeId, nodeName: '关联任务终态关闭', operatorUserId: actorId, operatorName: actor?.name ?? '未知用户', action: '撤回', comment: reason })
    }
    await tx.update(todos).set({ status: '已关闭', closureReason: reason, version: sql`${todos.version} + 1` }).where(eq(todos.approvalRequestId, request.id))
  }
}

export async function getFdeTasks(projectId: string, userId: string) {
  const project = await requireAccessibleProject(userId, projectId)
  if (project.workflowModel !== 'fde-v1') return fail('FDE_LEGACY_PROJECT', '当前不是 FDE 项目')
  const tasks = await db.select().from(todos).where(and(eq(todos.projectId, projectId), directiveTaskAccessCondition(userId))).orderBy(desc(todos.createdAt), asc(todos.id))
  const directives = await db.select({ id: projectDirectives.id, taskId: projectDirectives.taskId }).from(projectDirectives).where(eq(projectDirectives.projectId, projectId))
  const timelineLinks = await db.select().from(projectTimelineTasks).where(eq(projectTimelineTasks.projectId, projectId))
  const [secretary] = await db.select({ id: projectDutyAssignments.id }).from(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, projectId), eq(projectDutyAssignments.duty, 'secretary'), eq(projectDutyAssignments.userId, userId)))
  const taskIds = tasks.map((task) => task.id)
  const feedbacks = taskIds.length ? await db.select().from(todoFeedbacks).where(inArray(todoFeedbacks.todoId, taskIds)).orderBy(desc(todoFeedbacks.taskVersion)) : []
  const acceptances = taskIds.length ? await db.select().from(todoAcceptances).where(inArray(todoAcceptances.todoId, taskIds)) : []
  const evidence = feedbacks.length ? await db.select().from(todoFeedbackEvidence).where(inArray(todoFeedbackEvidence.feedbackId, feedbacks.map((item) => item.id))) : []
  const extensions = await db.select().from(oaApprovalRequests).where(and(eq(oaApprovalRequests.projectId, projectId), eq(oaApprovalRequests.businessType, 'task_extension'))).orderBy(desc(oaApprovalRequests.createdAt))
  const people = await db.selectDistinct({ id: users.id, name: users.name, status: users.status }).from(users).leftJoin(userRoles, eq(userRoles.userId, users.id)).leftJoin(roles, eq(roles.id, userRoles.roleId)).where(and(eq(users.status, '启用'), sql`(${users.id}=${project.ownerUserId} OR (${roles.fdeCategory}='institution_leader' AND ${roles.status}='启用'))`))
  const managers = []
  for (const person of people) if (await isFdeTaskManager(db, project, person.id)) managers.push(person)
  const members = await db.select({ id: users.id, name: users.name }).from(projectMembers).innerJoin(users, eq(users.id, projectMembers.userId)).where(and(eq(projectMembers.projectId, projectId), eq(users.status, '启用')))
  const manager = managers.some((person) => person.id === userId), active = project.lifecycle === 'active'
  const canSyncTimeline = active && project.projectType === '投资项目' && (manager || Boolean(secretary))
  const pendingWhere = and(eq(projectTimelineSyncs.projectId, projectId), eq(projectTimelineSyncs.status, 'pending'))
  const pending = canSyncTimeline ? await db.select({ id: projectTimelineSyncs.id, source: projectTimelineSyncs.source, issues: projectTimelineSyncs.issues }).from(projectTimelineSyncs).where(pendingWhere).orderBy(desc(projectTimelineSyncs.createdAt), desc(projectTimelineSyncs.id)).limit(20) : []
  const pendingCount = canSyncTimeline ? (await db.select({ value: count() }).from(projectTimelineSyncs).where(pendingWhere))[0].value : 0
  return { tasks: tasks.map((task) => {
    const directiveId = directives.find((item) => item.taskId === task.id)?.id ?? null
    return { ...task, directiveId, timelineSource: timelineLinks.find(item => item.taskId === task.id) ?? null, executionModel: task.approvalRequestId || task.type === '流程' ? 'approval' : 'fde-v1',
      feedbacks: feedbacks.filter((item) => item.todoId === task.id).map((item) => ({ ...item, evidence: evidence.filter((ref) => ref.feedbackId === item.id), acceptance: acceptances.find((decision) => decision.feedbackId === item.id) ?? null })),
      extensions: extensions.filter((request) => request.taskId === task.id).map((request) => ({ id: request.id, status: request.status, reason: request.reason, payload: request.businessPayload, lockVersion: request.lockVersion, applicantUserId: request.applicantUserId })),
      capabilities: { canFeedback: active && task.ownerUserId === userId && !taskTerminal(task.status) && !['待验收', '待确认'].includes(task.status) && !task.approvalRequestId, canAccept: active && manager && task.ownerUserId !== userId && task.status === '待验收', canCancel: active && manager && !directiveId && !task.planActionId && !task.approvalRequestId && !taskTerminal(task.status), canExtend: active && task.ownerUserId === userId && !taskTerminal(task.status) && Boolean(task.dueDate) && !task.approvalRequestId } }
  }), members, reviewers: managers.filter((person) => person.id !== userId), canAssign: active && manager, canSyncPlan: active && project.projectType === '投资项目' && project.ownerUserId === userId, canSyncTimeline, timelinePending: { count: pendingCount, items: pending } }
}
