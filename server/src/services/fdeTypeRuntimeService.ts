import { createHash, randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.js'
import { auditLogs, fdeTypeInstances as instances, fdeTypeExecutionReviews as reviews, fdeTypeExecutionCommands as commands, fdeTypeExecutionEvents as events, fdeTypeExecutionFiles as references, fdeWorkflowPolicies, fdeWorkflowPolicyVersions, projectFiles, projectFileVersions, projectMembers, projectPlanActions, projectPlans, projects, todoAcceptances, todoFeedbackEvidence, todoFeedbacks, todos, users, oaApprovalRequests, leaderTimeRequests } from '../db/schema.js'
import { decideTypePlanReview, decideTypeStageReview, eligibleTypeExecutionPerson, prepareTypePlanReview, prepareTypeStageReview, typeStageConsequence, type TypeExecutionPlan, type TypeStageReview } from '../contracts/fdeTypeExecutionContract.js'
import { typeRuntimeCommand, typeRuntimeReceipt, typeRuntimeRecovery, type TypeRuntimeReview, type TypeRuntimeView } from '../contracts/fdeTypeRuntimeContract.js'
import { typePolicyDefinition, typePolicyCode, typePolicyName } from '../contracts/fdeTypePolicyContract.js'
import { typeBoundVersionMayAdvance } from '../contracts/fdeTypeRegistrationContract.js'
import { loadBoundTypeExecution, readTypeExecutionRoster } from './fdeTypeExecutionPreparationService.js'
import { policyHash } from './fdeWorkflowPolicyService.js'
import { projectAccessCondition } from './projectAccessService.js'
import { requireProjectFileAccess } from './projectFileAccessService.js'
import { readProjectFileBuffer } from './projectFileStorageService.js'
import { fdeTypePolicyReviews, fdeTypePolicyEvents } from '../db/schema.js'
import { FDE_TASK_TERMINAL } from '../contracts/fdeTaskContract.js'
import { syncTypeApprovalNotices, typeApprovalAccessCondition, typeApprovalPendingCondition } from './fdeTypeApprovalService.js'
import { readTypeLeaderTimes, reconcileTypeLeaderTimes } from './fdeTimelineTimeService.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Instance = typeof instances.$inferSelect
const fail = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }) }
const pageQuery = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), review: z.string().uuid().optional() }).strict()
async function actorAndProject(tx: Tx, projectId: string, uid: string, lock: boolean, receiptOnly = false) {
  z.string().uuid().parse(projectId); z.string().uuid().parse(uid)
  if (lock) await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update')
  const [actor] = await tx.select().from(users).where(and(eq(users.id, uid), eq(users.status, '启用')))
  if (!actor) return fail('TYPE_RUNTIME_FORBIDDEN', '当前账号不可用', 403)
  if (receiptOnly) return { actor, project: null }
  const [project] = await tx.select().from(projects).where(and(eq(projects.id, projectId), projectAccessCondition({ uid, name: actor.name, role: actor.role })))
  if (!project) return fail('TYPE_RUNTIME_FORBIDDEN', '无权访问当前项目', 403)
  if (project.workflowModel !== 'fde-v1' || project.projectType === '投资项目' || project.classification === 'pool') return fail('TYPE_RUNTIME_MODEL', '只有明确绑定的非投资业务项目可使用独立执行，不能代替线索转换或改写投资项目')
  return { actor, project }
}
async function boundPolicy(tx: Tx, project: typeof projects.$inferSelect) {
  if (!project.workflowPolicyVersionId) return fail('TYPE_RUNTIME_BINDING_REQUIRED', '项目尚未绑定明确的非投资模板版本')
  const [v] = await tx.select().from(fdeWorkflowPolicyVersions).where(eq(fdeWorkflowPolicyVersions.id, project.workflowPolicyVersionId))
  if (!v) return fail('TYPE_RUNTIME_POLICY_INVALID', '绑定模板不存在')
  const [head] = await tx.select().from(fdeWorkflowPolicies).where(eq(fdeWorkflowPolicies.id, v.policyId))
  const configuration = typePolicyDefinition.parse(v.configuration)
  if (!head || v.status !== 'published' || policyHash(configuration) !== v.sha256 || head.code !== typePolicyCode(configuration.type) || project.projectType !== typePolicyName(configuration.type)) return fail('TYPE_RUNTIME_POLICY_INVALID', '项目类型、模板版本及哈希不一致')
  const [review] = await tx.select().from(fdeTypePolicyReviews).where(eq(fdeTypePolicyReviews.versionId, v.id))
  if (!v.publishedBy || !v.publishedAt || !review?.approvedBy || !review.approvedAt || review.approvedHash !== v.sha256 || review.approvedBy === v.createdBy) return fail('TYPE_RUNTIME_POLICY_INVALID', '模板缺少独立审核及发布证据')
  const [authored] = await tx.select({ id: fdeTypePolicyEvents.id }).from(fdeTypePolicyEvents).where(and(eq(fdeTypePolicyEvents.versionId, v.id), eq(fdeTypePolicyEvents.actorId, review.approvedBy), inArray(fdeTypePolicyEvents.action, ['create', 'save']))).limit(1)
  if (authored) return fail('TYPE_RUNTIME_POLICY_INVALID', '模板审核人参与过编制，不能执行')
  const [activated] = configuration.registration ? await tx.select({ id: fdeTypePolicyEvents.id }).from(fdeTypePolicyEvents).where(and(eq(fdeTypePolicyEvents.versionId, v.id), eq(fdeTypePolicyEvents.action, 'activate'))).limit(1) : []
  // An explicitly approved continuation rule only applies to a version that was
  // actually activated. Publication alone never unlocks a historical instance.
  const canAdvance = typeBoundVersionMayAdvance(configuration, head.enabled, Boolean(activated))
  return { head, version: v, configuration, canAdvance }
}
function checkInstance(instance: Instance, project: typeof projects.$inferSelect, hash: string) {
  if (instance.policyVersionId !== project.workflowPolicyVersionId || instance.plan.binding.projectId !== project.id
    || instance.plan.binding.policyVersionId !== instance.policyVersionId || instance.plan.binding.policySha256 !== hash
    || policyHash(instance.plan.configuration) !== hash || policyHash(instance.plan) !== instance.planHash
    || !instance.plan.configuration.stages.some(s => s.key === instance.stageKey && s.name === project.stage)) return fail('TYPE_RUNTIME_INTEGRITY', '执行实例、阶段或绑定版本完整性错误')
}
async function original(tx: Tx, projectId: string, uid: string, fileId: string, version: number, expectedHash?: string) {
  await requireProjectFileAccess(tx, fileId, uid, 'view')
  const [file] = await tx.select().from(projectFiles).where(and(eq(projectFiles.id, fileId), eq(projectFiles.projectId, projectId)))
  const [revision] = await tx.select().from(projectFileVersions).where(and(eq(projectFileVersions.fileId, fileId), eq(projectFileVersions.version, version)))
  if (!file || file.lifecycle !== 'active' || file.version !== version || !revision || expectedHash && revision.sha256 !== expectedHash) return fail('TYPE_RUNTIME_FILE_CHANGED', '成果或材料原件已失效/换版，必须重新提交审核')
  const bytes = await readProjectFileBuffer(revision.storagePath)
  if (bytes.length !== revision.byteSize || createHash('sha256').update(bytes).digest('hex') !== revision.sha256) return fail('TYPE_RUNTIME_FILE_INTEGRITY', '原始文件字节与冻结证据不一致')
  return { evidence: { fileId, version, sha256: revision.sha256 }, fileVersionId: revision.id }
}
async function taskFacts(tx: Tx, instance: Instance, uid: string) {
  if (!instance.planId) return fail('TYPE_RUNTIME_PLAN_REQUIRED', '尚无已批准计划')
  const result: TypeStageReview['tasks'] = []
  for (const action of instance.plan.actions.filter(a => a.stageKey === instance.stageKey)) {
    const [row] = await tx.select({ task: todos }).from(todos).innerJoin(projectPlanActions, eq(todos.planActionId, projectPlanActions.id)).where(and(eq(projectPlanActions.planId, instance.planId), eq(projectPlanActions.actionKey, action.key), eq(todos.projectId, instance.projectId)))
    const task = row?.task
    if (!task || task.status !== '已完成' || !task.ownerUserId) return fail('TYPE_RUNTIME_TASK_INCOMPLETE', `行动“${action.title}”尚未完成正式成果验收`)
    const [feedback] = await tx.select().from(todoFeedbacks).where(and(eq(todoFeedbacks.todoId, task.id), eq(todoFeedbacks.kind, 'submission'))).orderBy(desc(todoFeedbacks.taskVersion)).limit(1)
    const [accepted] = feedback ? await tx.select().from(todoAcceptances).where(and(eq(todoAcceptances.todoId, task.id), eq(todoAcceptances.feedbackId, feedback.id), eq(todoAcceptances.decision, 'accept'))) : []
    if (!feedback || !accepted || accepted.decidedBy === feedback.submittedBy || accepted.decidedBy === task.ownerUserId) return fail('TYPE_RUNTIME_ACCEPTANCE_REQUIRED', '成果缺少可核对的独立验收记录')
    const files = await tx.select().from(todoFeedbackEvidence).where(eq(todoFeedbackEvidence.feedbackId, feedback.id)).orderBy(asc(todoFeedbackEvidence.fileId))
    if (!files.length) return fail('TYPE_RUNTIME_EVIDENCE_REQUIRED', '阶段行动必须提供实际成果原件')
    const evidence = []
    for (const file of files) evidence.push((await original(tx, instance.projectId, uid, file.fileId, file.version, file.sha256)).evidence)
    result.push({ taskId: task.id, version: task.version, actionKey: action.key, ownerUserId: task.ownerUserId, status: '已完成', acceptedByUserId: accepted.decidedBy, acceptedFeedbackId: feedback.id, evidence })
  }
  return result
}
async function recheckStage(tx: Tx, instance: Instance, uid: string, review: TypeStageReview) {
  if (policyHash(await taskFacts(tx, instance, uid)) !== policyHash(review.tasks)) return fail('TYPE_RUNTIME_TASK_CHANGED', '冻结的任务成果/验收版本已变化，请退回后重提')
  for (const m of review.materials) if (m.kind === 'file') await original(tx, instance.projectId, uid, m.evidence.fileId, m.evidence.version, m.evidence.sha256)
  const roster = await readTypeExecutionRoster(tx, (await tx.select().from(projects).where(eq(projects.id, instance.projectId)))[0])
  for (const m of review.materials) if (m.kind === 'waiver' && !roster.people.some(p => p.userId === m.authorizedByUserId && eligibleTypeExecutionPerson(p, 'owner'))) return fail('TYPE_RUNTIME_WAIVER_CHANGED', '材料免传授权已失效，请重新核对')
}
async function materialize(tx: Tx, instance: Instance, project: typeof projects.$inferSelect, requester: string) {
  const [old] = await tx.select({ id: projectPlans.id }).from(projectPlans).where(eq(projectPlans.projectId, project.id)).limit(1)
  if (old) return fail('TYPE_RUNTIME_PLAN_EXISTS', '项目已有计划，不能覆盖或重复生成')
  const id = randomUUID(), now = new Date()
  await tx.insert(projectPlans).values({ id, projectId: project.id, revision: 1, status: 'locked', executionKind: 'noninvestment', cycleDays: instance.plan.cycleDays, targetDate: instance.plan.targetDate, createdBy: requester, lockedAt: now })
  for (const [i, action] of instance.plan.actions.entries()) {
    const [owner] = await tx.select().from(users).where(and(eq(users.id, action.ownerUserId), eq(users.status, '启用')))
    const [member] = await tx.select({ id: projectMembers.userId }).from(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, action.ownerUserId)))
    if (!owner || project.ownerUserId !== owner.id && !member) return fail('TYPE_RUNTIME_OWNER_INVALID', '计划执行人必须是当前有效项目成员')
    const actionId = randomUUID()
    await tx.insert(projectPlanActions).values({ id: actionId, planId: id, actionKey: action.key, title: action.title, ownerUserId: owner.id, dueDate: action.dueDate, deliverable: action.deliverable, sortOrder: i })
    await tx.insert(todos).values({ projectId: project.id, projectName: project.name, title: action.title, owner: owner.name, ownerUserId: owner.id, dueDate: action.dueDate, dueTime: action.dueTime, priority: '中', status: '未开始', type: '待办', executionModel: 'fde-v1', planActionId: actionId, progress: 0, deliverable: action.deliverable, createdBy: requester })
  }
  return id
}

export async function getTypeRuntime(projectId: string, uid: string, raw: unknown = {}): Promise<TypeRuntimeView> {
  const query = pageQuery.parse(raw)
  return db.transaction(async tx => {
    const { actor, project: maybe } = await actorAndProject(tx, projectId, uid, false), project = maybe!
    const policy = await boundPolicy(tx, project), roster = await readTypeExecutionRoster(tx, project)
    const person = roster.people.find(p => p.userId === uid), canPrepare = Boolean(person && (eligibleTypeExecutionPerson(person, 'owner') || eligibleTypeExecutionPerson(person, 'secretary')))
    const [instance] = await tx.select().from(instances).where(eq(instances.projectId, projectId))
    if (instance) checkInstance(instance, project, policy.version.sha256)
    let page = query.page
    const readableReview = and(eq(reviews.projectId, projectId), typeApprovalAccessCondition({ uid, name: actor.name, role: actor.role }))
    if (query.review) {
      const [target] = await tx.select().from(reviews).where(and(readableReview, eq(reviews.id, query.review)))
      if (!target) return fail('TYPE_RUNTIME_REVIEW_NOT_FOUND', '指定审批不存在或不属于当前项目', 404)
      const [position] = await tx.select({ count: sql<number>`COUNT(*)`.mapWith(Number) }).from(reviews).where(and(readableReview, or(gt(reviews.createdAt, target.createdAt), and(eq(reviews.createdAt, target.createdAt), gt(reviews.id, target.id)))))
      page = Math.floor(position.count / 20) + 1
    }
    const history = await tx.select().from(reviews).where(readableReview).orderBy(desc(reviews.createdAt), desc(reviews.id)).limit(21).offset((page - 1) * 20)
    // A project grant is not a grant to every frozen material. Recheck each
    // referenced file before exposing review narratives/evidence to the browser.
    for (const review of history.slice(0, 20)) {
      const refs = await tx.select().from(references).where(eq(references.reviewId, review.id))
      for (const ref of refs) await requireProjectFileAccess(tx, ref.fileId, uid, 'view')
    }
    const people = roster.people.filter(p => p.enabled && p.canReadProject)
    const decidable = await tx.select({ id: reviews.id }).from(reviews).where(and(readableReview, typeApprovalPendingCondition(uid)))
    const names = new Map(people.length ? (await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, people.map(p => p.userId)))).map(p => [p.id, p.name]) : [])
    const tasks = instance?.planId ? await tx.select({ id: todos.id, actionKey: projectPlanActions.actionKey, title: todos.title, status: todos.status, version: todos.version, dueDate: todos.dueDate, dueTime: todos.dueTime }).from(todos).innerJoin(projectPlanActions, eq(projectPlanActions.id, todos.planActionId)).where(eq(projectPlanActions.planId, instance.planId)) : []
    return { projectId, projectVersion: project.version, governanceVersion: project.governanceVersion, policyEnabled: policy.head.enabled, canAdvance: policy.canAdvance,
      instance: instance ? { version: instance.version, status: instance.status, stageKey: instance.stageKey, plan: instance.plan, planId: instance.planId } : null,
      reviews: history.slice(0, 20).map(r => ({ id: r.id, kind: r.kind, version: r.version, status: r.status, snapshot: r.snapshot, createdAt: r.createdAt.toISOString(), canDecide: decidable.some(d => d.id === r.id) })), page, hasMore: history.length > 20,
      canPrepare, canWrite: project.lifecycle === 'active', preparation: canPrepare ? { policyVersionId: policy.version.id, policySha256: policy.version.sha256, configuration: policy.configuration } : null,
      people: people.map(p => ({ id: p.userId, name: names.get(p.userId) ?? '原人员不可用', duties: p.duties })), tasks, leaderTimes: await readTypeLeaderTimes(tx, project) }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function executeTypeRuntime(projectId: string, uid: string, raw: unknown) {
  const input = typeRuntimeCommand.parse(raw), hash = policyHash(input)
  return db.transaction(async tx => {
    await actorAndProject(tx, projectId, uid, true, true)
    const commandWhere = and(eq(commands.projectId, projectId), eq(commands.actorId, uid), eq(commands.commandId, input.commandId))
    const [prior] = await tx.select().from(commands).where(commandWhere)
    if (prior) {
      if (prior.closedAt) return fail('TYPE_RUNTIME_COMMAND_CLOSED', '原请求已封闭，请重新核对并确认')
      if (prior.commandHash !== hash) return fail('TYPE_RUNTIME_COMMAND_REUSED', '同一请求编号不能用于其他内容')
      return typeRuntimeReceipt.parse(prior.receipt)
    }
    const { actor, project: maybe } = await actorAndProject(tx, projectId, uid, false), project = maybe!
    if (project.lifecycle !== 'active') return fail('TYPE_RUNTIME_INACTIVE', '项目已关闭或归档，不能继续执行')
    const policy = await boundPolicy(tx, project), roster = await readTypeExecutionRoster(tx, project)
    let [instance] = await tx.select().from(instances).where(eq(instances.projectId, projectId))
    if ((instance?.version ?? 0) !== input.expectedVersion) return fail('VERSION_CONFLICT', '执行实例已变化，请刷新后核对')
    if (instance) checkInstance(instance, project, policy.version.sha256)
    const person = roster.people.find(p => p.userId === uid), canPrepare = Boolean(person && (eligibleTypeExecutionPerson(person, 'owner') || eligibleTypeExecutionPerson(person, 'secretary')))
    if (input.action !== 'decide' && !canPrepare) return fail('TYPE_RUNTIME_PREPARE_FORBIDDEN', '仅当前负责人或推进秘书可编制/提交', 403)
    let requestId: string | null = null
    const nextVersion = (instance?.version ?? 0) + 1
    if (input.action === 'save_plan') {
      if (instance && instance.status !== 'draft') return fail('TYPE_RUNTIME_PLAN_IMMUTABLE', '已提交或发布计划不可原地改写')
      const prepared = await loadBoundTypeExecution(tx, projectId, uid, input.plan)
      if (!prepared.plan.configuration.planApprovals?.length) return fail('TYPE_EXECUTION_PLAN_POLICY_REQUIRED', '模板未明确计划审核规则，请先独立审核并发布新修订')
      if (!instance) {
        const [existingPlan] = await tx.select({ id: projectPlans.id }).from(projectPlans).where(eq(projectPlans.projectId, projectId)).limit(1)
        if (existingPlan || project.stage !== prepared.plan.configuration.stages[0].name) return fail('TYPE_RUNTIME_MIGRATION_REQUIRED', '已有计划或在途阶段须批准迁移映射，不能初始化重置')
        await tx.insert(instances).values({ projectId, policyVersionId: policy.version.id, plan: prepared.plan, planHash: policyHash(prepared.plan), stageKey: prepared.plan.configuration.stages[0].key, status: 'draft', createdBy: uid })
      } else await tx.update(instances).set({ plan: prepared.plan, planHash: policyHash(prepared.plan), version: nextVersion, updatedAt: new Date() }).where(eq(instances.projectId, projectId))
    } else {
      if (!instance) return fail('TYPE_RUNTIME_INSTANCE_REQUIRED', '请先保存执行计划')
      if (input.action === 'reconcile_times') {
        if (!instance.planId || !['active', 'stage_review'].includes(instance.status)) return fail('TYPE_RUNTIME_PLAN_REQUIRED', '只有已批准的执行计划可以核对领导需求')
        await tx.update(instances).set({ version: nextVersion, updatedAt: new Date() }).where(eq(instances.projectId, projectId))
      } else if (input.action === 'submit_plan') {
        if (instance.status !== 'draft') return fail('TYPE_RUNTIME_PLAN_IMMUTABLE', '只有草稿可以提交计划审核')
        requestId = randomUUID()
        const snapshot = prepareTypePlanReview(instance.plan, roster, uid, requestId)
        await tx.insert(reviews).values({ id: requestId, projectId, kind: 'plan', activeKey: projectId, snapshot, planSnapshot: instance.plan, status: 'reviewing' })
        await tx.update(instances).set({ status: 'plan_review', version: nextVersion, updatedAt: new Date() }).where(eq(instances.projectId, projectId))
      } else if (input.action === 'submit_stage') {
        if (instance.status !== 'active') return fail('TYPE_RUNTIME_STAGE_STATE', '当前实例不能提交阶段审核')
        requestId = randomUUID()
        const materials: TypeStageReview['materials'] = []
        for (const m of input.materials) {
          if (m.kind === 'file') materials.push({ requirementKey: m.requirementKey, kind: 'file', evidence: (await original(tx, projectId, uid, m.fileId, m.version)).evidence })
          else {
            if (!person || !eligibleTypeExecutionPerson(person, 'owner')) return fail('TYPE_RUNTIME_WAIVER_FORBIDDEN', '只有当前负责人可按绑定规则批准免传', 403)
            materials.push({ ...m, authorizedByUserId: uid })
          }
        }
        const snapshot = prepareTypeStageReview(instance.plan, instance.stageKey, roster, { requestId, stageKey: input.stageKey, expectedGovernanceVersion: input.expectedGovernanceVersion, requesterUserId: uid, result: input.result, tasks: await taskFacts(tx, instance, uid), materials })
        await tx.insert(reviews).values({ id: requestId, projectId, kind: 'stage', activeKey: projectId, snapshot, planSnapshot: instance.plan, status: 'reviewing' })
        const files = [...snapshot.tasks.flatMap(t => t.evidence), ...snapshot.materials.flatMap(m => m.kind === 'file' ? [m.evidence] : [])]
        for (const file of new Map(files.map(f => [`${f.fileId}:${f.version}`, f])).values()) {
          const [v] = await tx.select({ id: projectFileVersions.id }).from(projectFileVersions).where(and(eq(projectFileVersions.fileId, file.fileId), eq(projectFileVersions.version, file.version)))
          await tx.insert(references).values({ reviewId: requestId, fileId: file.fileId, fileVersionId: v.id })
        }
        await tx.update(instances).set({ status: 'stage_review', version: nextVersion, updatedAt: new Date() }).where(eq(instances.projectId, projectId))
      } else {
        requestId = input.requestId
        const [review] = await tx.select().from(reviews).where(and(eq(reviews.id, requestId), eq(reviews.projectId, projectId))).for('update')
        if (!review || review.version !== input.expectedReviewVersion) return fail('VERSION_CONFLICT', '审批申请不存在或版本已变化')
        if (review.status !== 'reviewing' || review.activeKey !== projectId || policyHash(review.planSnapshot) !== instance.planHash || review.snapshot.status !== review.status
          || instance.status !== (review.kind === 'plan' ? 'plan_review' : 'stage_review')) return fail('TYPE_RUNTIME_REVIEW_CHANGED', '审批已结束或执行计划/状态不一致')
        const decision = { actorId: uid, action: input.decision, reason: input.reason }
        const snapshot: TypeRuntimeReview = review.kind === 'plan' ? decideTypePlanReview(review.snapshot, roster, decision) : decideTypeStageReview(review.snapshot, roster, decision)
        let status: Instance['status'] = instance.status, planId = instance.planId, stageKey = instance.stageKey
        if (input.decision === 'approve') {
          if (review.kind === 'stage') await recheckStage(tx, instance, uid, review.snapshot as TypeStageReview)
          else if (roster.governanceVersion !== instance.plan.governanceVersion) return fail('TYPE_EXECUTION_GOVERNANCE_CHANGED', '计划职责版本已变化，请退回重新核对')
        }
        if (snapshot.status === 'returned' || snapshot.status === 'withdrawn') status = review.kind === 'plan' ? 'draft' : 'active'
        if (snapshot.status === 'approved') {
          if (!policy.canAdvance) return fail('TYPE_RUNTIME_POLICY_DISABLED', '绑定版本尚未获准执行，不能发布正式任务或推进阶段')
          if (review.kind === 'plan') {
            // Revalidate independent approval evidence and live assignments in
            // the same locked transaction, using the original plan applicant.
            const fresh = await loadBoundTypeExecution(tx, projectId, snapshot.requesterUserId, { expectedProjectVersion: project.version, expectedGovernanceVersion: project.governanceVersion, expectedPolicyVersionId: policy.version.id, expectedPolicySha256: policy.version.sha256, cycleDays: instance.plan.cycleDays, targetDate: instance.plan.targetDate, selections: instance.plan.actions.map(a => ({ actionKey: a.key, userId: a.ownerUserId, dueTime: a.dueTime })) })
            if (policyHash(fresh.plan) !== instance.planHash) return fail('TYPE_RUNTIME_PLAN_CHANGED', '计划输入或职责已变化，请退回后重新编制')
            planId = await materialize(tx, instance, project, snapshot.requesterUserId); status = 'active'
            await tx.update(projects).set({ cycleDays: instance.plan.cycleDays, targetDate: instance.plan.targetDate, version: project.version + 1 }).where(eq(projects.id, projectId))
          } else {
            const consequence = typeStageConsequence(instance.plan, instance.stageKey, snapshot)
            if (consequence.lifecycle === 'closed') {
              const [task] = await tx.select({ id: todos.id }).from(todos).where(and(eq(todos.projectId, projectId), sql`${todos.status} NOT IN (${sql.join(FDE_TASK_TERMINAL.map(s => sql`${s}`), sql`,`)})`)).limit(1)
              const [approval] = await tx.select({ id: oaApprovalRequests.id }).from(oaApprovalRequests).where(and(eq(oaApprovalRequests.projectId, projectId), eq(oaApprovalRequests.status, '审批中'))).limit(1)
              const [time] = await tx.select({ id: leaderTimeRequests.id }).from(leaderTimeRequests).where(and(eq(leaderTimeRequests.projectId, projectId), sql`${leaderTimeRequests.status} NOT IN ('cancelled','rejected','withdrawn')`)).limit(1)
              if (task || approval || time) return fail('TYPE_RUNTIME_CLOSE_REFERENCES', '仍有任务、审批或时间安排，需按关闭规则处理后才能结案')
              status = 'closed'
            } else { stageKey = consequence.nextStageKey!; status = 'active' }
            await tx.update(projects).set({ stage: consequence.nextStageName ?? project.stage, lifecycle: consequence.lifecycle, version: project.version + 1 }).where(eq(projects.id, projectId))
          }
        }
        await tx.update(reviews).set({ snapshot, status: snapshot.status, activeKey: snapshot.status === 'reviewing' ? projectId : null, version: review.version + 1, updatedAt: new Date() }).where(eq(reviews.id, review.id))
        await tx.update(instances).set({ status, planId, stageKey, version: nextVersion, updatedAt: new Date() }).where(eq(instances.projectId, projectId))
      }
    }
    await reconcileTypeLeaderTimes(tx, projectId, uid, `type-command:${input.commandId}`)
    if (requestId) {
      const [currentReview] = await tx.select().from(reviews).where(eq(reviews.id, requestId))
      await syncTypeApprovalNotices(tx, requestId, currentReview.snapshot)
    }
    const receipt = typeRuntimeReceipt.parse({ commandId: input.commandId, projectId, action: input.action, version: nextVersion, requestId })
    await tx.insert(events).values({ projectId, actorId: uid, commandId: input.commandId, action: input.action, version: nextVersion, reason: input.reason, snapshot: { receipt, previousStatus: instance?.status ?? null, previousVersion: instance?.version ?? 0 } })
    await tx.insert(commands).values({ projectId, actorId: uid, commandId: input.commandId, commandHash: hash, receipt })
    await tx.insert(auditLogs).values({ userId: uid, userName: actor.name, module: '非投资项目执行', action: input.action, target: JSON.stringify(receipt) })
    return receipt
  }, { isolationLevel: 'read committed' })
}

export async function recoverTypeRuntime(projectId: string, uid: string, raw: unknown) {
  const { commandId } = typeRuntimeRecovery.parse(raw)
  return db.transaction(async tx => {
    await actorAndProject(tx, projectId, uid, true, true)
    const [prior] = await tx.select().from(commands).where(and(eq(commands.projectId, projectId), eq(commands.actorId, uid), eq(commands.commandId, commandId)))
    if (prior?.receipt) return { state: 'committed' as const, receipt: typeRuntimeReceipt.parse(prior.receipt) }
    if (prior && !prior.closedAt) return fail('TYPE_RUNTIME_COMMAND_INTEGRITY', '原命令回执不完整，不能认定未提交')
    if (!prior) {
      // Only a current project reader can close an unseen request. Revoked
      // actors can retrieve their own existing minimal receipts, nothing else.
      await actorAndProject(tx, projectId, uid, false)
      await tx.insert(commands).values({ projectId, actorId: uid, commandId, closedAt: new Date() })
      await tx.insert(auditLogs).values({ userId: uid, userName: '', module: '非投资项目执行', action: '封闭未提交请求', target: JSON.stringify({ projectId, commandId, receiptOnly: true }) })
    }
    return { state: 'not_committed' as const, receipt: null }
  }, { isolationLevel: 'read committed' })
}
