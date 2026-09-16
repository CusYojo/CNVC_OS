import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { requireProjectFileAccess } from './projectFileAccessService.js'
import { oaApprovalRequests, projectDutyAssignments, projectFiles, projectMembers, projectPlanActions, projectPlans, projectStageDates, projectStageMaterials, projects, roles, todos, userRoles, users } from '../db/schema.js'
import { readAgentTimeline } from './fdeAgentTimelineService.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { requireAccessibleProject } from './projectAccessService.js'
import { inspectProjectFile } from './projectFileStorageService.js'
import { getProjectWorkflowPolicy } from './fdeWorkflowPolicyService.js'
import { materializeFdePlanTasks, participantTaskId } from './fdeTaskService.js'
import { reconcileTimelineEvent } from './fdeTimelineTaskService.js'
import { shanghaiToday } from '../contracts/fdeWeeklyPlanContract.js'
import { isEnabledSystemAdmin, type SystemAdminExecutor } from './systemAdminAccessService.js'

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

export type PlanActionInput = { actionKey: string; title: string; ownerUserId: string; participantUserIds: string[]; dueDate: string; deliverable: string }
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
    actionKey, title, deliverable, ownerUserId, participantUserIds: [ownerUserId],
    dueDate: new Date(end - Math.round(((15 - position) / 15) * cycleDays) * 86_400_000).toISOString().slice(0, 10),
  }))
}

export function validateFdePlan(cycleDays: number, targetDate: string, actions: PlanActionInput[]) {
  if (![15, 30, 40].includes(cycleDays) || !validDateKey(targetDate)) throw error(400, 'FDE_PLAN_INVALID', '周期或最终日期无效')
  const keys = actions.map((item) => item.actionKey)
  if (new Set(keys).size !== keys.length) throw error(400, 'FDE_PLAN_DUPLICATE_ACTION', '计划行动编号不可重复')
  const criticalKeys = new Set(['internal_review', 'ic', 'payment', 'close'])
  const missing = FDE_PLAN_ACTIONS.filter(([key]) => criticalKeys.has(key) && !keys.includes(key)).map(([, title]) => title)
  if (missing.length) throw error(400, 'FDE_PLAN_INCOMPLETE', `计划缺少必要行动：${missing.join('、')}`)
  const start = new Date(new Date(`${targetDate}T00:00:00.000Z`).getTime() - cycleDays * 86_400_000).toISOString().slice(0, 10)
  if (actions.some((item) => !item.ownerUserId || !item.participantUserIds.length || !item.participantUserIds.includes(item.ownerUserId) || new Set(item.participantUserIds).size !== item.participantUserIds.length || !item.title.trim() || !item.deliverable.trim() || !validDateKey(item.dueDate) || item.dueDate < start || item.dueDate > targetDate)) {
    throw error(400, 'FDE_PLAN_ACTION_INVALID', '每个行动必须有主负责人、至少一名参与人、交付物和周期范围内的有效日期；主负责人必须属于参与人')
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

async function requirePlanEditor(tx: Transaction, project: ProjectRow, userId: string) {
  const [actor] = await tx.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!actor || actor.status !== '启用') throw error(403, 'USER_DISABLED_OR_MISSING', '当前用户不可用')
  if (await isEnabledSystemAdmin(tx, userId)) return actor
  if (project.ownerUserId === userId) return actor
  const [membership] = await tx.select({ userId: projectMembers.userId }).from(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, userId))).limit(1)
  if (!membership) throw error(403, 'FDE_PROJECT_TEAM_REQUIRED', '尽调计划仅限投资项目组成员编辑')
  return actor
}

async function canEditDraftPlan(reader: SystemAdminExecutor, project: ProjectRow, userId: string) {
  if (await isEnabledSystemAdmin(reader, userId)) return true
  if (project.ownerUserId === userId) return true
  const [membership] = await reader.select({ userId: projectMembers.userId }).from(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, userId))).limit(1)
  return Boolean(membership)
}

async function canAmendApprovedPlan(reader: Pick<typeof db, 'select'>, project: ProjectRow, userId: string) {
  if (project.ownerUserId === userId) return true
  const [departmentLead] = await reader.select({ id: users.id }).from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(projectMembers.projectId, project.id), eq(users.id, userId), eq(users.status, '启用'), eq(roles.status, '启用'), eq(roles.code, 'FDE_PARTNER'))).limit(1)
  return Boolean(departmentLead)
}

async function requireApprovedPlanEditor(tx: Transaction, project: ProjectRow, userId: string) {
  const [actor] = await tx.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!actor || actor.status !== '启用') throw error(403, 'USER_DISABLED_OR_MISSING', '当前用户不可用')
  if (!await canAmendApprovedPlan(tx, project, userId)) throw error(403, 'FDE_PLAN_AMEND_FORBIDDEN', '仅项目负责人或已加入本项目的合伙人（部门负责人）可修订已通过计划')
  return actor
}

async function inspectPlanReadiness(
  reader: SystemAdminExecutor,
  project: ProjectRow,
  policy: { configuration: { cycleDays: number[] } },
  plan: typeof projectPlans.$inferSelect | undefined,
  actions: Array<typeof projectPlanActions.$inferSelect>,
) {
  if (!plan || plan.status === 'archived') return { validForReview: false, reason: '尚未配置有效倒排计划' }
  try {
    validateFdePlan(plan.cycleDays, plan.targetDate, actions)
    if (!policy.configuration.cycleDays.includes(plan.cycleDays)) return { validForReview: false, reason: '倒排计划尚未完整保存' }
    const members = await reader.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, project.id))
    const allowedOwners = new Set([project.ownerUserId, ...members.map(member => member.userId)])
    const selectedIds = [...new Set(actions.flatMap(action => [action.ownerUserId, ...action.participantUserIds]))]
    const enabled = selectedIds.length
      ? await reader.select({ id: users.id }).from(users).where(and(inArray(users.id, selectedIds), eq(users.status, '启用')))
      : []
    if (selectedIds.some(id => !allowedOwners.has(id)) || enabled.length !== selectedIds.length) {
      return { validForReview: false, reason: '倒排计划尚未完整保存' }
    }
    return { validForReview: true, reason: '计划已配置，可提交审核' }
  } catch {
    return { validForReview: false, reason: '倒排计划尚未完整保存' }
  }
}

const terminalTaskStatuses = ['已完成', '已关闭', '已取消', '已归档']
const sameParticipants = (left: string[], right: string[]) => JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort())

async function amendApprovedFdePlan(tx: Transaction, project: ProjectRow, plan: typeof projectPlans.$inferSelect, actor: typeof users.$inferSelect, actions: PlanActionInput[], cycleDays: number, targetDate: string) {
  if (cycleDays !== plan.cycleDays || targetDate !== plan.targetDate) throw error(409, 'FDE_APPROVED_BASELINE_CHANGE', '已通过计划的周期和最终日期需走整体改期；部门负责人可直接修改任务、日期、主责人和参与人')
  const existing = await tx.select().from(projectPlanActions).where(eq(projectPlanActions.planId, plan.id)).orderBy(asc(projectPlanActions.sortOrder))
  const taskRows = await tx.select().from(todos).where(eq(todos.projectId, project.id))
  const peopleIds = [...new Set(actions.flatMap(action => [action.ownerUserId, ...action.participantUserIds]))]
  const people = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, peopleIds))
  const names = new Map(people.map(person => [person.id, person.name]))
  const nextByKey = new Map(actions.map(action => [action.actionKey, { ...action, participantUserIds: [...new Set([action.ownerUserId, ...action.participantUserIds])] }]))
  const existingByKey = new Map(existing.map(action => [action.actionKey, action]))

  for (const old of existing) {
    const next = nextByKey.get(old.actionKey)
    const participantIds = [...new Set((old.participantUserIds.length ? old.participantUserIds : [old.ownerUserId]).filter(id => id !== old.ownerUserId).map(id => participantTaskId(old.id, id)))]
    const related = taskRows.filter(task => task.planActionId === old.id || participantIds.includes(task.id))
    const changed = !next || old.title !== next.title || old.ownerUserId !== next.ownerUserId || old.dueDate !== next.dueDate || old.deliverable !== next.deliverable || !sameParticipants(old.participantUserIds, next.participantUserIds)
    if (changed && related.some(task => terminalTaskStatuses.includes(task.status))) throw error(409, 'FDE_APPROVED_ACTION_COMPLETED', `任务“${old.title}”已有完成或关闭的执行记录，不能改写或删除`)
    if (!next) {
      await tx.update(todos).set({ planActionId: null, status: '已取消', closureReason: '已通过计划由部门负责人修订，原任务取消', version: sql`${todos.version} + 1` }).where(and(eq(todos.planActionId, old.id), notInArray(todos.status, terminalTaskStatuses)))
      if (participantIds.length) await tx.update(todos).set({ status: '已取消', closureReason: '已通过计划已移除该参与任务', version: sql`${todos.version} + 1` }).where(and(inArray(todos.id, participantIds), notInArray(todos.status, terminalTaskStatuses)))
      await tx.delete(projectPlanActions).where(eq(projectPlanActions.id, old.id))
      continue
    }
    await tx.update(projectPlanActions).set({ title: next.title, ownerUserId: next.ownerUserId, participantUserIds: next.participantUserIds, dueDate: next.dueDate, deliverable: next.deliverable, sortOrder: actions.findIndex(action => action.actionKey === next.actionKey), version: old.version + 1 }).where(eq(projectPlanActions.id, old.id))
    const primary = taskRows.find(task => task.planActionId === old.id)
    if (primary && !terminalTaskStatuses.includes(primary.status)) await tx.update(todos).set({ title: next.title, ownerUserId: next.ownerUserId, owner: names.get(next.ownerUserId)!, dueDate: next.dueDate, deliverable: next.deliverable, version: primary.version + 1 }).where(eq(todos.id, primary.id))
    const removed = old.participantUserIds.filter(id => id !== old.ownerUserId && !next.participantUserIds.includes(id)).map(id => participantTaskId(old.id, id))
    const redundantNewOwner = participantTaskId(old.id, next.ownerUserId)
    if (!removed.includes(redundantNewOwner)) removed.push(redundantNewOwner)
    if (removed.length) await tx.update(todos).set({ status: '已取消', closureReason: '已通过计划的参与人已调整', version: sql`${todos.version} + 1` }).where(and(inArray(todos.id, removed), notInArray(todos.status, terminalTaskStatuses)))
    const retained = next.participantUserIds.filter(id => id !== next.ownerUserId).map(id => participantTaskId(old.id, id))
    if (retained.length) await tx.update(todos).set({ title: `协同：${next.title}`, dueDate: next.dueDate, deliverable: `${next.deliverable}（协同参与，主负责人统筹验收）`, version: sql`${todos.version} + 1` }).where(and(inArray(todos.id, retained), notInArray(todos.status, terminalTaskStatuses)))
  }

  const additions = actions.filter(action => !existingByKey.has(action.actionKey))
  if (additions.length) await tx.insert(projectPlanActions).values(additions.map(action => ({ ...action, participantUserIds: [...new Set([action.ownerUserId, ...action.participantUserIds])], id: randomUUID(), planId: plan.id, sortOrder: actions.findIndex(item => item.actionKey === action.actionKey) })))
  await tx.update(projectPlans).set({ version: plan.version + 1, updatedAt: new Date() }).where(eq(projectPlans.id, plan.id))
  await materializeFdePlanTasks(tx, project.id, plan.id)

  const bosses = await tx.select({ id: users.id, name: users.name }).from(projectDutyAssignments).innerJoin(users, eq(users.id, projectDutyAssignments.userId)).where(and(eq(projectDutyAssignments.projectId, project.id), eq(projectDutyAssignments.duty, 'concerned_leader'), eq(users.status, '启用')))
  const recipients = [...new Map(bosses.filter(person => person.id !== actor.id).map(person => [person.id, person])).values()]
  if (recipients.length) await tx.insert(todos).values(recipients.map(person => ({ id: randomUUID(), projectId: project.id, projectName: project.name, title: `计划变更：${project.name}`, owner: person.name, ownerUserId: person.id, dueDate: shanghaiToday(), priority: '中', status: '未开始', type: '通知', deliverable: `部门负责人${actor.name}已修订通过后的投资周期行动计划，请查看当前任务、日期和参与人。`, createdBy: actor.id })))
  await reconcileTimelineEvent(tx, project.id, actor.id, { source: 'plan', sourceKey: `plan-amend:${plan.id}:${plan.version + 1}` })
  await createMySqlIdentityRepositoryContext(tx).audits.append({ userId: actor.id, userName: actor.name, module: '倒排计划', action: '修订已通过计划', target: `${project.name} / V${plan.revision} / 计划版本 ${plan.version + 1} / 同步老板 ${recipients.map(person => person.name).join('、') || '本人'}` })
}

// 为每个阶段审批职责解析启用人员名单，用于前端阶段详情展示
async function readStageApproverNames(projectId: string): Promise<Map<string, string[]>> {
  const assignments = await db.select({ duty: projectDutyAssignments.duty, userId: projectDutyAssignments.userId }).from(projectDutyAssignments).where(eq(projectDutyAssignments.projectId, projectId))
  const byDuty = new Map<string, string[]>()
  for (const item of assignments) {
    const list = byDuty.get(item.duty) ?? []
    list.push(item.userId)
    byDuty.set(item.duty, list)
  }
  const fallbackRoles = { chairman: 'FDE_CHAIRMAN', president: 'FDE_PRESIDENT' } as const
  const fallbackNames = new Map<string, string[]>()
  for (const [duty, roleCode] of Object.entries(fallbackRoles)) {
    if (byDuty.has(duty)) continue
    const rows = await db.select({ name: users.name }).from(userRoles).innerJoin(users, eq(users.id, userRoles.userId)).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(eq(roles.code, roleCode), eq(roles.status, '启用'), eq(users.status, '启用')))
    if (rows.length) fallbackNames.set(duty, rows.map((row) => row.name))
  }
  const allIds = [...new Set([...byDuty.values()].flat())]
  const people = allIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, allIds)) : []
  const nameById = new Map(people.map((person) => [person.id, person.name]))
  const result = new Map<string, string[]>()
  for (const [duty, ids] of byDuty) result.set(duty, ids.map((id) => nameById.get(id)).filter((name): name is string => Boolean(name)))
  for (const [duty, names] of fallbackNames) result.set(duty, names)
  return result
}

export async function getFdeWorkflow(projectId: string, userId: string) {
  const project = await requireAccessibleProject(userId, projectId)
  const policy = await getProjectWorkflowPolicy(db, project)
  const [materials, plans, memberRows, duties, approverNames] = await Promise.all([
    db.select().from(projectStageMaterials).where(eq(projectStageMaterials.projectId, projectId)),
    db.select().from(projectPlans).where(eq(projectPlans.projectId, projectId)).orderBy(desc(projectPlans.revision)),
    db.select({ id: users.id, name: users.name, role: projectMembers.memberRole }).from(projectMembers).innerJoin(users, eq(projectMembers.userId, users.id)).where(eq(projectMembers.projectId, projectId)),
    db.select({ duty: projectDutyAssignments.duty, userId: projectDutyAssignments.userId }).from(projectDutyAssignments).where(eq(projectDutyAssignments.projectId, projectId)),
    readStageApproverNames(projectId),
  ])
  const currentPlan = plans.find((plan) => plan.status !== 'archived')
  const definitions = currentPlan ? await db.select().from(projectPlanActions).where(eq(projectPlanActions.planId, currentPlan.id)).orderBy(asc(projectPlanActions.sortOrder)) : []
  const taskRows = currentPlan ? await db.select().from(todos).where(eq(todos.projectId, projectId)) : []
  const actions = definitions.map((action) => {
    const task = taskRows.find((item) => item.planActionId === action.id)
    return { ...action, participantUserIds: action.participantUserIds.length ? action.participantUserIds : [action.ownerUserId], status: task?.status ?? action.status, taskId: task?.id ?? null, effectiveDueDate: task?.dueDate ?? action.dueDate }
  })
  const canEditPlan = project.lifecycle === 'active' && (currentPlan?.status === 'locked'
    ? await canAmendApprovedPlan(db, project, userId)
    : await canEditDraftPlan(db, project, userId))
  const planReadiness = await inspectPlanReadiness(db, project, policy, currentPlan, definitions)
  const stages = policy.configuration.stages.map((stage) => ({
    ...stage,
    approvals: stage.approvals.map((approval) => ({ ...approval, approverNames: approverNames.get(approval.duty) ?? [] })),
  }))
  return { stages, timeline: await readAgentTimeline(db, project), policy: { id: policy.id, revision: policy.revision, cycleDays: policy.configuration.cycleDays }, materials, plan: currentPlan ? { ...currentPlan, actions } : null, planHistory: plans, members: memberRows, duties, capabilities: { canEditPlan }, planReadiness }
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
    const bindings = await tx.select().from(projectStageMaterials).where(and(eq(projectStageMaterials.projectId, project.id), eq(projectStageMaterials.stage, input.stage), eq(projectStageMaterials.requirementKey, input.requirementKey)))
    const existing = bindings.find(binding => input.fileId ? binding.fileId === input.fileId : binding.fileId === null)
      ?? (!input.fileId && bindings.length === 1 && bindings[0]!.version === input.expectedVersion ? bindings[0] : undefined)
    if (!input.fileId && bindings.some(binding => binding.fileId) && !existing) throw error(409, 'FDE_MATERIAL_WAIVER_CONFLICT', '当前要求存在多个文件绑定；如确需免传，请先逐份解除文件绑定')
    if (existing && existing.version !== input.expectedVersion) throw error(409, 'VERSION_CONFLICT', '材料绑定已被修改，请刷新后重试')
    const values = { fileId: input.fileId ?? null, fileVersion, waiverReason: input.fileId ? null : input.waiverReason!.trim(), updatedBy: actor.id, updatedAt: new Date() }
    const bindingId = existing?.id ?? randomUUID()
    if (existing) await tx.update(projectStageMaterials).set({ ...values, version: existing.version + 1 }).where(eq(projectStageMaterials.id, existing.id))
    else {
      if (input.fileId) await tx.delete(projectStageMaterials).where(and(eq(projectStageMaterials.projectId, project.id), eq(projectStageMaterials.stage, input.stage), eq(projectStageMaterials.requirementKey, input.requirementKey), sql`${projectStageMaterials.fileId} IS NULL`))
      await tx.insert(projectStageMaterials).values({ ...values, id: bindingId, projectId: project.id, stage: input.stage, requirementKey: input.requirementKey })
    }
    await reconcileTimelineEvent(tx, project.id, actor.id, { source: 'material', sourceKey: `material:${bindingId}:${(existing?.version ?? 0) + 1}` })
    await createMySqlIdentityRepositoryContext(tx).audits.append({ userId: actor.id, userName: actor.name, module: '项目材料', action: input.fileId ? '绑定材料' : '材料免传', target: `${project.name} / ${input.stage} / ${requirement.label} / ${input.fileId ?? input.waiverReason}` })
  })
  return getFdeWorkflow(input.projectId, input.userId)
}

export async function removeFdeMaterialBinding(input: { projectId: string; bindingId: string; userId: string; expectedVersion: number }) {
  await requireAccessibleProject(input.userId, input.projectId)
  await db.transaction(async tx => {
    const project = await lockProject(tx, input.projectId)
    await assertNoActiveApproval(tx, project.id)
    const [binding] = await tx.select().from(projectStageMaterials).where(and(eq(projectStageMaterials.id, input.bindingId), eq(projectStageMaterials.projectId, project.id))).limit(1)
    if (!binding) throw error(404, 'FDE_MATERIAL_BINDING_NOT_FOUND', '材料绑定不存在或已被移除')
    if (binding.version !== input.expectedVersion) throw error(409, 'VERSION_CONFLICT', '材料绑定已变化，请刷新后重试')
    const actor = await createMySqlIdentityRepositoryContext(tx).users.findById(input.userId)
    if (!actor || actor.status !== '启用') throw error(403, 'USER_DISABLED_OR_MISSING', '当前用户不可用')
    if (binding.waiverReason) await requireOwner(tx, project, input.userId)
    if (binding.fileId) await requireProjectFileAccess(tx, binding.fileId, input.userId, 'view')
    await tx.delete(projectStageMaterials).where(eq(projectStageMaterials.id, binding.id))
    await reconcileTimelineEvent(tx, project.id, actor.id, { source: 'material', sourceKey: `material-remove:${binding.id}:${binding.version}` })
    await createMySqlIdentityRepositoryContext(tx).audits.append({ userId: actor.id, userName: actor.name, module: '项目材料', action: '解除材料绑定', target: `${project.name} / ${binding.stage} / ${binding.requirementKey} / ${binding.fileId ?? '免传说明'}` })
  })
  return getFdeWorkflow(input.projectId, input.userId)
}

export async function saveFdePlan(input: { projectId: string; userId: string; cycleDays: number; targetDate: string; actions?: PlanActionInput[]; expectedVersion?: number }) {
  await requireAccessibleProject(input.userId, input.projectId)
  await db.transaction(async (tx) => {
    const project = await lockProject(tx, input.projectId)
    const policy = await getProjectWorkflowPolicy(tx, project)
    if (!policy.configuration.cycleDays.includes(input.cycleDays as 15 | 30 | 40)) throw error(400, 'FDE_PLAN_CYCLE_DISABLED', '当前项目规则不允许该周期')
    await assertNoActiveApproval(tx, project.id)
    const [previous] = await tx.select().from(projectPlans).where(eq(projectPlans.projectId, project.id)).orderBy(desc(projectPlans.revision)).limit(1)
    const actor = previous?.status === 'locked' ? await requireApprovedPlanEditor(tx, project, input.userId) : await requirePlanEditor(tx, project, input.userId)
    const [approvedDate] = await tx.select({ id: projectStageDates.id }).from(projectStageDates).where(eq(projectStageDates.projectId, project.id)).limit(1)
    if (approvedDate && (input.targetDate !== project.targetDate || input.cycleDays !== project.cycleDays)) throw error(409, 'FDE_APPROVED_TIMELINE_EXISTS', '已有批准节点日期，不能通过重新生成计划覆盖日期基准；需正式整体改期流程')
    if (previous && previous.version !== input.expectedVersion) throw error(409, 'VERSION_CONFLICT', '计划已被修改，请刷新后重试')
    const dutyRows = input.actions ? [] : await tx.select({ duty: projectDutyAssignments.duty, userId: projectDutyAssignments.userId }).from(projectDutyAssignments).where(eq(projectDutyAssignments.projectId, project.id))
    const dutyParticipants = (duties: string[]) => dutyRows.filter(row => duties.includes(row.duty)).map(row => row.userId)
    const automaticDuties: Record<string, string[]> = {
      data_room: ['secretary'], management_dd: ['secretary'], founder_meeting_1: ['concerned_leader', 'executive_lead'], founder_meeting_2: ['concerned_leader', 'executive_lead'],
      financial_dd: ['finance'], legal_dd: ['legal'], internal_review: ['finance', 'legal'], ic: ['chairman', 'president', 'concerned_leader'], payment: ['finance'], close: ['finance', 'legal'],
    }
    const actions = input.actions ?? buildFdePlan(input.cycleDays, input.targetDate, project.ownerUserId ?? actor.id).map(action => ({
      ...action, participantUserIds: [...new Set([action.ownerUserId, ...dutyParticipants(automaticDuties[action.actionKey] ?? [])])],
    }))
    validateFdePlan(input.cycleDays, input.targetDate, actions)
    const memberRows = await tx.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, project.id))
    const allowed = new Set([project.ownerUserId, ...memberRows.map((row) => row.userId)])
    for (const action of actions) {
      const selectedIds = [...new Set([action.ownerUserId, ...action.participantUserIds])]
      const enabled = await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, selectedIds), eq(users.status, '启用')))
      if (selectedIds.some((id) => !allowed.has(id)) || enabled.length !== selectedIds.length) throw error(403, 'FDE_PLAN_PARTICIPANT_INVALID', '行动负责人和参与人必须是当前项目启用的成员')
    }
    if (previous?.status === 'locked') {
      if (!input.actions) throw error(409, 'FDE_APPROVED_PLAN_ACTIONS_REQUIRED', '已通过计划不能一键重新生成；请编辑具体任务后保存')
      await amendApprovedFdePlan(tx, project, previous, actor, actions, input.cycleDays, input.targetDate)
      return
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
    const requirementBindings = bindings.filter(row => row.requirementKey === requirement.key)
    const waiver = requirementBindings.find(binding => binding.waiverReason)
    const fileBindings = requirementBindings.filter(binding => binding.fileId)
    let passed = Boolean(stage.allowWaiver && waiver?.waiverReason && waiver.waiverReason.trim().length >= 5)
    if (fileBindings.length) {
      passed = true
      for (const binding of fileBindings) {
        const [file] = await tx.select().from(projectFiles).where(and(eq(projectFiles.id, binding.fileId!), eq(projectFiles.projectId, project.id))).limit(1)
        let current = Boolean(file?.lifecycle === 'active' && file.storagePath && file.byteSize > 0 && file.version === binding.fileVersion)
        if (current && file?.storagePath) {
          const original = await inspectProjectFile(file.storagePath).catch(() => null)
          current = Boolean(original && original.size === file.byteSize)
        }
        if (!current) passed = false
      }
    }
    checklist.push({ label: requirement.label, required: true, passed })
    for (const binding of requirementBindings) snapshot.push({ requirementKey: requirement.key, fileId: binding.fileId, fileVersion: binding.fileVersion, waiverReason: binding.waiverReason })
  }
  let planId: string | undefined
  if (stage.requiresFund) checklist.push({ label: '明确投资基金', required: true, passed: Boolean(project.investmentFund?.trim()) })
  if (['尽调计划制定', '尽调计划审核'].includes(project.stage)) {
    const [plan] = await tx.select().from(projectPlans).where(eq(projectPlans.projectId, project.id)).orderBy(desc(projectPlans.revision)).limit(1)
    const actions = plan ? await tx.select().from(projectPlanActions).where(eq(projectPlanActions.planId, plan.id)) : []
    const planReadiness = await inspectPlanReadiness(tx, project, policy, plan, actions)
    if (planReadiness.validForReview && plan) planId = plan.id
    checklist.push({ label: '完整且有效的倒排计划', required: true, passed: planReadiness.validForReview })
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
