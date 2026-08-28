import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { leaderTimeRequests, oaApprovalRequests, projectDutyAssignments, projectFiles, projectPlans, projectRecords, projectStageMaterials, projects, roles, todoFeedbackEvidence, todoFeedbacks, todos, userRoles, users } from '../db/schema.js'
import { type AgentEvidence, type ProjectAgentFacts, projectedAgentStageDate } from '../contracts/fdeProjectAgentContract.js'
import { taskDeadlineKey, taskTerminal } from '../contracts/fdeTaskContract.js'
import { shanghaiToday } from '../contracts/fdeWeeklyPlanContract.js'
import { projectFileAccessCondition, projectFileWorkspaceCondition } from './projectFileAccessService.js'
import { canReadReferencedDirectiveTasks, directiveTaskAccessCondition } from './fdeDirectiveLinksService.js'
import { legacyApprovalAccessCondition } from './oaRequestAccessService.js'
import { getProjectWorkflowPolicy } from './fdeWorkflowPolicyService.js'
import { inspectFdeStageGate } from './fdeWorkflowService.js'
import { readAgentTimeline } from './fdeAgentTimelineService.js'
import { agentScheduleWindow } from '../contracts/fdeAgentScheduleContract.js'

export type AgentTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export const agentFail = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }) }
export const agentHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function projectAgentScope(tx: AgentTx, projectId: string, userId: string) {
  const [actor] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.status, '启用')))
  if (!actor) return agentFail('AGENT_ACTOR_UNAVAILABLE', '当前账号不可用', 403)
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.workflowModel !== 'fde-v1' || project.lifecycle === 'deleted') return agentFail('AGENT_PROJECT_NOT_FOUND', '项目不存在或不适用 FDE 研判', 404)
  const [visible] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), projectFileWorkspaceCondition(userId)))
  if (!visible) return agentFail('AGENT_FORBIDDEN', '推进研判只向有业务内容权限的项目人员开放', 403)
  const categories = await tx.select({ category: roles.fdeCategory }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(eq(userRoles.userId, userId), eq(roles.status, '启用')))
  const [secretary] = await tx.select({ id: projectDutyAssignments.id }).from(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, projectId), eq(projectDutyAssignments.userId, userId), eq(projectDutyAssignments.duty, 'secretary')))
  const manager = project.ownerUserId === userId || categories.some(item => item.category === 'institution_leader')
  return { actor, project, canConfigure: manager && project.lifecycle === 'active', canRun: (manager || Boolean(secretary)) && project.lifecycle === 'active' }
}

export async function collectProjectAgentFacts(tx: AgentTx, projectId: string, userId: string, now = new Date()): Promise<ProjectAgentFacts> {
  const { project, actor } = await projectAgentScope(tx, projectId, userId)
  const facts: ProjectAgentFacts = { projectId, projectVersion: project.version, asOfDate: shanghaiToday(now), stage: project.stage, lifecycle: project.lifecycle,
    targetDate: project.targetDate, currentDate: projectedAgentStageDate(project.stage, project.targetDate, project.cycleDays), dateBasis: 'none',
    gateKnown: false, gateMissing: [], incomplete: false, tasks: [], activeApprovalIds: [], pendingExtensionIds: [], evidence: [], observations: [] }
  const timeline = await readAgentTimeline(tx, project), stageDate = timeline.find(item => item.stage === project.stage)
  facts.currentDate = stageDate?.date ?? null
  facts.dateBasis = stageDate?.basis ?? 'none'
  facts.dateWindow = agentScheduleWindow(timeline, project.stage, project.targetDate, facts.asOfDate)
  const add = (id: string, kind: AgentEvidence['kind'], label: string, version: number, value: unknown, observation?: string) => {
    facts.evidence.push({ id, kind, label, version, fingerprint: agentHash(value) })
    if (observation) facts.observations.push({ id, text: observation.slice(0, 1600) })
  }
  // Do not include cached summary/businessModel: historical file provenance may be unresolved.
  const projectSnapshot = { id: project.id, name: project.name, stage: project.stage, version: project.version, governanceVersion: project.governanceVersion,
    lifecycle: project.lifecycle, requirements: project.requirements, targetDate: project.targetDate, cycleDays: project.cycleDays, policyId: project.workflowPolicyVersionId, timeline }
  add(project.id, 'project', `${project.name} · ${project.stage}`, project.version, projectSnapshot, project.requirements ?? undefined)
  let policy: Awaited<ReturnType<typeof getProjectWorkflowPolicy>> | null = null
  try { policy = await getProjectWorkflowPolicy(tx, project) }
  catch (cause) { if (!['FDE_POLICY_NOT_BOUND', 'FDE_POLICY_NOT_PUBLISHED', 'FDE_POLICY_INTEGRITY_FAILED'].includes((cause as { code?: string }).code ?? '')) throw cause }
  if (policy) {
    add(policy.id, 'policy', `流程规则 V${policy.revision}`, policy.revision, policy.configuration)
    const stage = policy.configuration.stages.find(item => item.stage === project.stage)
    facts.gateKnown = Boolean(stage && project.projectType === '投资项目')
    if (facts.gateKnown) {
      const gate = await inspectFdeStageGate(tx, project)
      facts.gateMissing = gate.checklist.filter(item => item.required && !item.passed).map(item => item.label)
      const bindings = await tx.select().from(projectStageMaterials).where(and(eq(projectStageMaterials.projectId, projectId), eq(projectStageMaterials.stage, project.stage))).orderBy(asc(projectStageMaterials.id))
      const visible = await tx.select({ id: projectFiles.id }).from(projectFiles).where(and(eq(projectFiles.projectId, projectId), projectFileAccessCondition(userId)))
      const visibleIds = new Set(visible.map(item => item.id))
      for (const requirement of stage!.materials) {
        const binding = bindings.find(item => item.requirementKey === requirement.key)
        if (binding?.fileId && !visibleIds.has(binding.fileId)) { facts.incomplete = true; continue }
        const id = `${policy.id}:${project.stage}:${requirement.key}`
        add(id, 'material', requirement.label, binding?.version ?? 0, { requirement, binding: binding ?? null })
      }
    }
  }
  const [plan] = await tx.select().from(projectPlans).where(eq(projectPlans.projectId, projectId)).orderBy(desc(projectPlans.revision)).limit(1)
  if (plan) add(plan.id, 'plan', `倒排计划 V${plan.revision} · ${plan.status}`, plan.version, plan)
  const files = await tx.select({ id: projectFiles.id, name: projectFiles.name, category: projectFiles.category, version: projectFiles.version,
    accessVersion: projectFiles.accessVersion, sha256: projectFiles.sha256, byteSize: projectFiles.byteSize }).from(projectFiles)
    .where(and(eq(projectFiles.projectId, projectId), projectFileAccessCondition(userId))).orderBy(asc(projectFiles.id)).limit(501)
  const visibleFileIds = new Set(files.map(file => file.id))
  for (const file of files) add(file.id, 'file', file.name, file.version, file, `${file.name} · ${file.category} · v${file.version}；仅文件元数据，未向模型发送原文`)
  const tasks = await tx.select().from(todos).where(and(eq(todos.projectId, projectId), isNull(todos.approvalRequestId), directiveTaskAccessCondition(userId))).orderBy(asc(todos.id)).limit(501)
  for (const task of tasks) {
    const [feedback] = await tx.select().from(todoFeedbacks).where(eq(todoFeedbacks.todoId, task.id)).orderBy(desc(todoFeedbacks.taskVersion)).limit(1)
    const references = feedback ? await tx.select().from(todoFeedbackEvidence).where(eq(todoFeedbackEvidence.feedbackId, feedback.id)).orderBy(asc(todoFeedbackEvidence.id)) : []
    if (references.some(ref => !visibleFileIds.has(ref.fileId))) { facts.incomplete = true; continue }
    const terminal = taskTerminal(task.status)
    const deadline = task.dueDate ? new Date(`${taskDeadlineKey(task.dueDate, task.dueTime)}+08:00`) : null
    const result = { id: task.id, title: task.title, status: task.status, overdue: !terminal && Boolean(deadline && deadline < now), blocked: !terminal && Boolean(feedback?.blocker.trim()) }
    facts.tasks.push(result)
    add(task.id, 'task', `${task.title} · ${task.status}`, task.version, { task, feedback, references }, feedback ? `成果/反馈：${feedback.result}；阻塞：${feedback.blocker}` : undefined)
  }
  const approvals = await tx.select({ id: oaApprovalRequests.id, businessType: oaApprovalRequests.businessType, fromStage: oaApprovalRequests.fromStage,
    status: oaApprovalRequests.status, version: oaApprovalRequests.lockVersion, taskId: oaApprovalRequests.taskId }).from(oaApprovalRequests)
    .where(and(eq(oaApprovalRequests.projectId, projectId), eq(oaApprovalRequests.status, '审批中'), legacyApprovalAccessCondition({ uid: userId, name: actor.name, role: actor.role }))).orderBy(asc(oaApprovalRequests.id)).limit(501)
  for (const approval of approvals) {
    add(approval.id, 'approval', `${approval.fromStage} · 在途审批`, approval.version, approval)
    if (approval.businessType === 'task_extension') facts.pendingExtensionIds.push(approval.id)
    else facts.activeApprovalIds.push(approval.id)
  }
  const records = await tx.select().from(projectRecords).where(and(eq(projectRecords.projectId, projectId), eq(projectRecords.status, 'published'))).orderBy(asc(projectRecords.id)).limit(501)
  for (const record of records) add(record.id, 'record', `${record.kind} · ${record.title}`, record.version, record, record.content)
  const times = await tx.select().from(leaderTimeRequests).where(and(eq(leaderTimeRequests.projectId, projectId), inArray(leaderTimeRequests.status, ['requested', 'pending', 'confirmed', 'supplement']))).orderBy(asc(leaderTimeRequests.id)).limit(501)
  for (const time of times) {
    if (time.taskId && !await canReadReferencedDirectiveTasks(tx, [time.taskId], userId)) continue
    add(time.id, 'leadership', `${time.title} · ${time.status}`, time.version, time, `领导时间状态：${time.status}；预期结果：${time.outcome ?? '待补充'}`)
  }
  if ([files, tasks, approvals, records, times].some(items => items.length > 500) || facts.evidence.length > 1500) return agentFail('AGENT_SOURCE_LIMIT', '项目来源超出单次研判容量，未截断生成；请先缩小或归档已结束事项')
  facts.evidence.sort((a, b) => a.id.localeCompare(b.id))
  facts.observations.sort((a, b) => a.id.localeCompare(b.id))
  return facts
}
