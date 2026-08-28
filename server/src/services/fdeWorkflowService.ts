import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { requireProjectFileAccess } from './projectFileAccessService.js'
import { oaApprovalRequests, projectFiles, projectMembers, projectPlanActions, projectPlans, projectStageDates, projectStageMaterials, projects, todos, users } from '../db/schema.js'
import { readAgentTimeline } from './fdeAgentTimelineService.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { requireAccessibleProject } from './projectAccessService.js'
import { inspectProjectFile } from './projectFileStorageService.js'
import { getProjectWorkflowPolicy } from './fdeWorkflowPolicyService.js'
import { materializeFdePlanTasks } from './fdeTaskService.js'
import { reconcileTimelineEvent } from './fdeTimelineTaskService.js'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type ProjectRow = typeof projects.$inferSelect
export { FDE_STAGE_REQUIREMENTS } from '../contracts/fdeWorkflowPolicyContract.js'

export const FDE_PLAN_ACTIONS = [
  ['nda', '保密协议', '签署版保密协议', 1],
  ['data_room', '尽调资料包', '资料清单与数据室', 2],
  ['management_dd', '高管尽调', '高管访谈纪要', 4],
  ['customer_interview', '客户访谈', '客户访谈纪要', 5],
  ['business_dd', '业务尽调', '业务尽调报告', 7],
  ['financial_dd', '财务尽调', '财务尽调报告', 8],
  ['legal_dd', '法律尽调', '法律尽调报告', 9],
  ['founder_meeting_1', '第一次创始团队与关注领导交流', '第一次交流纪要', 4],
  ['founder_meeting_2', '第二次创始团队与关注领导交流', '第二次交流纪要', 10],
  ['terms', '投资条款沟通', '投资条款清单', 10],
  ['internal_review', '内核', '内核意见与修订稿', 11],
  ['ic', '投决', '投委会决议', 12],
  ['payment', '打款', '打款单与回单', 14],
  ['close', 'Close', '交割归档清单', 15],
] as const

export type PlanActionInput = { actionKey: string; title: string; ownerUserId: string; dueDate: string; deliverable: string }
const error = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code })

export function validDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function buildFdePlan(cycleDays: number, targetDate: string, ownerUserId: string): PlanActionInput[] {
  if (![15, 30, 40].includes(cycleDays) || !validDateKey(targetDate)) throw error(400, 'FDE_PLAN_INVALID', '周期必须为 15/30/40 天，最终日期必须有效')
  const end = new Date(`${targetDate}T00:00:00.000Z`).getTime()
  return FDE_PLAN_ACTIONS.map(([actionKey, title, deliverable, position]) => ({
    actionKey, title, deliverable, ownerUserId,
    dueDate: new Date(end - Math.round(((15 - position) / 15) * cycleDays) * 86_400_000).toISOString().slice(0, 10),
  }))
}

export function validateFdePlan(cycleDays: number, targetDate: string, actions: PlanActionInput[]) {
  if (![15, 30, 40].includes(cycleDays) || !validDateKey(targetDate)) throw error(400, 'FDE_PLAN_INVALID', '周期或最终日期无效')
  const keys = actions.map((item) => item.actionKey)
  if (new Set(keys).size !== keys.length) throw error(400, 'FDE_PLAN_DUPLICATE_ACTION', '计划行动编号不可重复')
  const missing = FDE_PLAN_ACTIONS.filter(([key]) => !keys.includes(key)).map(([, title]) => title)
  if (missing.length) throw error(400, 'FDE_PLAN_INCOMPLETE', `计划缺少必要行动：${missing.join('、')}`)
  const start = new Date(new Date(`${targetDate}T00:00:00.000Z`).getTime() - cycleDays * 86_400_000).toISOString().slice(0, 10)
  if (actions.some((item) => !item.ownerUserId || !item.title.trim() || !item.deliverable.trim() || !validDateKey(item.dueDate) || item.dueDate < start || item.dueDate > targetDate)) {
    throw error(400, 'FDE_PLAN_ACTION_INVALID', '每个行动必须有负责人、交付物和周期范围内的有效日期')
  }
  const byKey = new Map(actions.map((item) => [item.actionKey, item]))
  const order = ['internal_review', 'ic', 'payment', 'close']
  for (let index = 1; index < order.length; index += 1) {
    if (byKey.get(order[index])!.dueDate < byKey.get(order[index - 1])!.dueDate) throw error(400, 'FDE_PLAN_ORDER_INVALID', '内核、投决、打款和 Close 日期必须依次不早于上一阶段')
  }
  if (byKey.get('close')!.dueDate !== targetDate) throw error(400, 'FDE_PLAN_CLOSE_DATE_INVALID', 'Close 日期必须等于最终日期')
}

async function lockProject(tx: Transaction, projectId: string) {
  await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) throw error(404, 'PROJECT_NOT_FOUND', '项目不存在')
  if (project.workflowModel !== 'fde-v1') throw error(409, 'FDE_LEGACY_PROJECT', '历史流程项目暂不允许改写为 FDE 流程')
  if (project.lifecycle !== 'active') throw error(409, 'FDE_PROJECT_INACTIVE', '项目已关闭或归档')
  return project
}

async function assertNoActiveApproval(tx: Transaction, projectId: string) {
  const [active] = await tx.select({ id: oaApprovalRequests.id }).from(oaApprovalRequests).where(and(eq(oaApprovalRequests.projectId, projectId), eq(oaApprovalRequests.businessType, 'project_stage'), eq(oaApprovalRequests.status, '审批中'))).limit(1)
  if (active) throw error(409, 'FDE_APPROVAL_ACTIVE', '活动审批期间材料与计划已冻结，请先撤回或退回后修订')
}

async function requireOwner(tx: Transaction, project: ProjectRow, userId: string) {
  if (project.ownerUserId !== userId) throw error(403, 'FDE_OWNER_REQUIRED', '该操作只允许项目负责人执行')
  const [actor] = await tx.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!actor || actor.status !== '启用') throw error(403, 'USER_DISABLED_OR_MISSING', '当前用户不可用')
  return actor
}

export async function getFdeWorkflow(projectId: string, userId: string) {
  const project = await requireAccessibleProject(userId, projectId)
  const policy = await getProjectWorkflowPolicy(db, project)
  const [materials, plans, memberRows] = await Promise.all([
    db.select().from(projectStageMaterials).where(eq(projectStageMaterials.projectId, projectId)),
    db.select().from(projectPlans).where(eq(projectPlans.projectId, projectId)).orderBy(desc(projectPlans.revision)),
    db.select({ id: users.id, name: users.name, role: projectMembers.memberRole }).from(projectMembers).innerJoin(users, eq(projectMembers.userId, users.id)).where(eq(projectMembers.projectId, projectId)),
  ])
  const currentPlan = plans.find((plan) => plan.status !== 'archived')
  const definitions = currentPlan ? await db.select().from(projectPlanActions).where(eq(projectPlanActions.planId, currentPlan.id)).orderBy(asc(projectPlanActions.sortOrder)) : []
  const taskRows = currentPlan ? await db.select().from(todos).where(eq(todos.projectId, projectId)) : []
  const actions = definitions.map((action) => {
    const task = taskRows.find((item) => item.planActionId === action.id)
    return { ...action, status: task?.status ?? action.status, taskId: task?.id ?? null, effectiveDueDate: task?.dueDate ?? action.dueDate }
  })
  return { stages: policy.configuration.stages, timeline: await readAgentTimeline(db, project), policy: { id: policy.id, revision: policy.revision, cycleDays: policy.configuration.cycleDays }, materials, plan: currentPlan ? { ...currentPlan, actions } : null, planHistory: plans, members: memberRows }
}

export async function bindFdeMaterial(input: { projectId: string; userId: string; stage: string; requirementKey: string; fileId?: string; waiverReason?: string; expectedVersion?: number }) {
  await requireAccessibleProject(input.userId, input.projectId)
  await db.transaction(async (tx) => {
    const project = await lockProject(tx, input.projectId)
    const policy = await getProjectWorkflowPolicy(tx, project)
    const stage = policy.configuration.stages.find((item) => item.stage === input.stage)
    const requirement = stage?.materials.find((item) => item.key === input.requirementKey)
    if (!requirement) throw error(400, 'FDE_MATERIAL_REQUIREMENT_INVALID', '当前项目绑定版本中不存在该材料要求')
    await assertNoActiveApproval(tx, project.id)
    const actor = await createMySqlIdentityRepositoryContext(tx).users.findById(input.userId)
    if (!actor || actor.status !== '启用') throw error(403, 'USER_DISABLED_OR_MISSING', '当前用户不可用')
    let fileVersion: number | null = null
    if (input.fileId) {
      await requireProjectFileAccess(tx, input.fileId, input.userId, 'view')
      const [file] = await tx.select().from(projectFiles).where(and(eq(projectFiles.id, input.fileId), eq(projectFiles.projectId, project.id))).limit(1)
      if (!file || !file.storagePath || file.byteSize <= 0) throw error(409, 'FDE_MATERIAL_FILE_INVALID', '必须绑定当前项目已保存原始文件的真实材料')
      const original = await inspectProjectFile(file.storagePath).catch(() => null)
      if (!original || original.size !== file.byteSize) throw error(409, 'FDE_MATERIAL_FILE_INVALID', '材料原始文件缺失或与元数据大小不一致')
      fileVersion = file.version
    } else {
      await requireOwner(tx, project, input.userId)
      if (!stage?.allowWaiver) throw error(409, 'FDE_MATERIAL_WAIVER_DISABLED', '当前项目绑定规则不允许该阶段材料免传')
      if ((input.waiverReason?.trim().length ?? 0) < 5) throw error(400, 'FDE_MATERIAL_WAIVER_REASON', '免传必须由负责人填写至少 5 字说明')
    }
    const [existing] = await tx.select().from(projectStageMaterials).where(and(eq(projectStageMaterials.projectId, project.id), eq(projectStageMaterials.stage, input.stage), eq(projectStageMaterials.requirementKey, input.requirementKey))).limit(1)
    if (existing && existing.version !== input.expectedVersion) throw error(409, 'VERSION_CONFLICT', '材料绑定已被修改，请刷新后重试')
    const values = { fileId: input.fileId ?? null, fileVersion, waiverReason: input.fileId ? null : input.waiverReason!.trim(), updatedBy: actor.id, updatedAt: new Date() }
    const bindingId = existing?.id ?? randomUUID()
    if (existing) await tx.update(projectStageMaterials).set({ ...values, version: existing.version + 1 }).where(eq(projectStageMaterials.id, existing.id))
    else await tx.insert(projectStageMaterials).values({ ...values, id: bindingId, projectId: project.id, stage: input.stage, requirementKey: input.requirementKey })
    await reconcileTimelineEvent(tx, project.id, actor.id, { source: 'material', sourceKey: `material:${bindingId}:${(existing?.version ?? 0) + 1}` })
    await createMySqlIdentityRepositoryContext(tx).audits.append({ userId: actor.id, userName: actor.name, module: '项目材料', action: input.fileId ? '绑定材料' : '材料免传', target: `${project.name} / ${input.stage} / ${requirement.label} / ${input.fileId ?? input.waiverReason}` })
  })
  return getFdeWorkflow(input.projectId, input.userId)
}

export async function saveFdePlan(input: { projectId: string; userId: string; cycleDays: number; targetDate: string; actions?: PlanActionInput[]; expectedVersion?: number }) {
  await requireAccessibleProject(input.userId, input.projectId)
  await db.transaction(async (tx) => {
    const project = await lockProject(tx, input.projectId)
    const actor = await requireOwner(tx, project, input.userId)
    const policy = await getProjectWorkflowPolicy(tx, project)
    if (!policy.configuration.cycleDays.includes(input.cycleDays as 15 | 30 | 40)) throw error(400, 'FDE_PLAN_CYCLE_DISABLED', '当前项目规则不允许该周期')
    await assertNoActiveApproval(tx, project.id)
    const [previous] = await tx.select().from(projectPlans).where(eq(projectPlans.projectId, project.id)).orderBy(desc(projectPlans.revision)).limit(1)
    const [approvedDate] = await tx.select({ id: projectStageDates.id }).from(projectStageDates).where(eq(projectStageDates.projectId, project.id)).limit(1)
    if (approvedDate && (input.targetDate !== project.targetDate || input.cycleDays !== project.cycleDays)) throw error(409, 'FDE_APPROVED_TIMELINE_EXISTS', '已有批准节点日期，不能通过重新生成计划覆盖日期基准；需正式整体改期流程')
    if (previous?.status === 'locked') throw error(409, 'FDE_PLAN_LOCKED', '计划已审核锁定，结构或关键日期变更必须走新版本审批')
    if (previous && previous.version !== input.expectedVersion) throw error(409, 'VERSION_CONFLICT', '计划已被修改，请刷新后重试')
    const actions = input.actions ?? buildFdePlan(input.cycleDays, input.targetDate, project.ownerUserId ?? actor.id)
    validateFdePlan(input.cycleDays, input.targetDate, actions)
    const memberRows = await tx.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, project.id))
    const allowed = new Set([project.ownerUserId, ...memberRows.map((row) => row.userId)])
    for (const action of actions) {
      const [owner] = await tx.select({ status: users.status }).from(users).where(eq(users.id, action.ownerUserId)).limit(1)
      if (!allowed.has(action.ownerUserId) || owner?.status !== '启用') throw error(403, 'FDE_PLAN_OWNER_INVALID', '行动负责人必须是当前项目启用的成员')
    }
    if (previous) await tx.update(projectPlans).set({ status: 'archived', updatedAt: new Date(), version: previous.version + 1 }).where(eq(projectPlans.id, previous.id))
    const planId = randomUUID()
    await tx.insert(projectPlans).values({ id: planId, projectId: project.id, revision: (previous?.revision ?? 0) + 1, cycleDays: input.cycleDays, targetDate: input.targetDate, createdBy: actor.id })
    await tx.insert(projectPlanActions).values(actions.map((action, index) => ({ ...action, planId, sortOrder: index })))
    await tx.update(projects).set({ targetDate: input.targetDate, cycleDays: input.cycleDays, version: project.version + 1, updatedAt: new Date() }).where(eq(projects.id, project.id))
    await reconcileTimelineEvent(tx, project.id, actor.id, { source: 'plan', sourceKey: `plan:${planId}` })
    await createMySqlIdentityRepositoryContext(tx).audits.append({ userId: actor.id, userName: actor.name, module: '倒排计划', action: '保存计划版本', target: `${project.name} / V${(previous?.revision ?? 0) + 1} / ${input.cycleDays}天 / ${input.targetDate}` })
  })
  return getFdeWorkflow(input.projectId, input.userId)
}

export async function inspectFdeStageGate(tx: Transaction, project: ProjectRow) {
  const policy = await getProjectWorkflowPolicy(tx, project)
  const stage = policy.configuration.stages.find((item) => item.stage === project.stage)
  if (!stage) throw error(409, 'FDE_STAGE_INVALID', '当前项目阶段不支持提交')
  const bindings = await tx.select().from(projectStageMaterials).where(and(eq(projectStageMaterials.projectId, project.id), eq(projectStageMaterials.stage, project.stage)))
  const checklist: Array<{ label: string; passed: boolean; required: boolean }> = []
  const snapshot: Array<{ requirementKey: string; fileId: string | null; fileVersion: number | null; waiverReason: string | null }> = []
  for (const requirement of stage.materials) {
    const binding = bindings.find((row) => row.requirementKey === requirement.key)
    let passed = Boolean(stage.allowWaiver && binding?.waiverReason && binding.waiverReason.trim().length >= 5)
    if (binding?.fileId) {
      const [file] = await tx.select().from(projectFiles).where(and(eq(projectFiles.id, binding.fileId), eq(projectFiles.projectId, project.id))).limit(1)
      passed = Boolean(file?.lifecycle === 'active' && file.storagePath && file.byteSize > 0 && file.version === binding.fileVersion)
      if (passed && file?.storagePath) {
        const original = await inspectProjectFile(file.storagePath).catch(() => null)
        passed = Boolean(original && original.size === file.byteSize)
      }
    }
    checklist.push({ label: requirement.label, required: true, passed })
    if (binding) snapshot.push({ requirementKey: requirement.key, fileId: binding.fileId, fileVersion: binding.fileVersion, waiverReason: binding.waiverReason })
  }
  let planId: string | undefined
  if (stage.requiresFund) checklist.push({ label: '明确投资基金', required: true, passed: Boolean(project.investmentFund?.trim()) })
  if (['尽调计划制定', '尽调计划审核'].includes(project.stage)) {
    const [plan] = await tx.select().from(projectPlans).where(eq(projectPlans.projectId, project.id)).orderBy(desc(projectPlans.revision)).limit(1)
    let passed = false
    if (plan && plan.status !== 'archived') {
      const actions = await tx.select().from(projectPlanActions).where(eq(projectPlanActions.planId, plan.id))
      try {
        validateFdePlan(plan.cycleDays, plan.targetDate, actions)
        if (!policy.configuration.cycleDays.includes(plan.cycleDays as 15 | 30 | 40)) throw error(409, 'FDE_PLAN_CYCLE_DISABLED', '计划周期不在项目绑定规则中')
        const members = await tx.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, project.id))
        const allowedOwners = new Set([project.ownerUserId, ...members.map((member) => member.userId)])
        passed = true
        for (const action of actions) {
          const [owner] = await tx.select({ status: users.status }).from(users).where(eq(users.id, action.ownerUserId)).limit(1)
          if (!allowedOwners.has(action.ownerUserId) || owner?.status !== '启用') passed = false
        }
        if (passed) planId = plan.id
      } catch { /* gate reports missing/invalid plan */ }
    }
    checklist.push({ label: '完整且有效的倒排计划', required: true, passed })
  }
  return { checklist, snapshot, planId }
}

export async function evaluateFdeStageGate(tx: Transaction, project: ProjectRow) {
  const result = await inspectFdeStageGate(tx, project)
  const missing = result.checklist.filter((item) => item.required && !item.passed)
  if (missing.length) throw error(409, 'FDE_STAGE_GATE_FAILED', `当前阶段门禁未通过：${missing.map((item) => item.label).join('、')}`)
  return result
}

export async function lockApprovedFdePlan(tx: Transaction, projectId: string) {
  const [plan] = await tx.select().from(projectPlans).where(eq(projectPlans.projectId, projectId)).orderBy(desc(projectPlans.revision)).limit(1)
  if (!plan) throw error(409, 'FDE_PLAN_MISSING', '尽调计划不存在')
  await tx.update(projectPlans).set({ status: 'locked', lockedAt: new Date(), updatedAt: new Date(), version: plan.version + 1 }).where(eq(projectPlans.id, plan.id))
  await materializeFdePlanTasks(tx, projectId, plan.id)
}

export async function updateFdePlanAction(input: { projectId: string; actionId: string; userId: string; status: '未开始' | '进行中' | '已完成'; expectedVersion: number }) {
  await requireAccessibleProject(input.userId, input.projectId)
  await db.transaction(async (tx) => {
    const project = await lockProject(tx, input.projectId)
    const [action] = await tx.select().from(projectPlanActions).where(eq(projectPlanActions.id, input.actionId)).limit(1)
    if (!action) throw error(404, 'FDE_PLAN_ACTION_NOT_FOUND', '计划行动不存在')
    const [plan] = await tx.select().from(projectPlans).where(eq(projectPlans.id, action.planId)).limit(1)
    if (!plan || plan.projectId !== project.id || plan.status === 'archived') throw error(403, 'FDE_PLAN_ACTION_FORBIDDEN', '行动不属于当前有效项目计划')
    if (action.ownerUserId !== input.userId && project.ownerUserId !== input.userId) throw error(403, 'FDE_PLAN_ACTION_FORBIDDEN', '只有行动负责人或项目负责人可以更新执行状态')
    if (action.version !== input.expectedVersion) throw error(409, 'VERSION_CONFLICT', '行动已被修改，请刷新后重试')
    throw error(409, 'FDE_TASK_EXECUTION_REQUIRED', '请进入项目待办提交反馈或成果，由异人验收；计划状态不能直接修改')
  })
  return getFdeWorkflow(input.projectId, input.userId)
}
