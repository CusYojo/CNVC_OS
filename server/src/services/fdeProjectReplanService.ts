import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { leaderTimeRequests, oaApprovalNodes as nodes, oaApprovalRecords as records, oaApprovalRequests as requests, projectAgentScheduleRequests, projectDutyAssignments, projectPlans, projectReplanPolicies, projectReplanRequests, projectStageDates, projectTimelineSyncs, projectTimelineTasks, projects, roles, todos, userRoles, users } from '../db/schema.js'
import { calculateProjectReplan, projectReplanAction, projectReplanPolicy, projectReplanPreviewInput, projectReplanSubmit, type ProjectReplanPolicy, type ReplanDashboard, type ReplanPreview, type ReplanTask } from '../contracts/fdeProjectReplanContract.js'
import { approveNodeTransition } from '../contracts/approvalNodeTransition.js'
import { replanApprovalTodoClosure } from '../contracts/fdeProjectReplanApprovalContract.js'
import { replanHash } from '../utils/fdeProjectReplanHash.js'
import { shanghaiToday } from '../contracts/fdeWeeklyPlanContract.js'
import { timelineLeaderSlots } from '../contracts/fdeTimelineTimeContract.js'
import { timeEnd, timeInstant, intervalsOverlap } from '../contracts/fdeTimeContract.js'
import { agentFail, projectAgentScope, type AgentTx } from './fdeProjectAgentFactsService.js'
import { recordAgentCommand, replayAgentCommand } from './fdeProjectAgentService.js'
import { readAgentTimeline } from './fdeAgentTimelineService.js'
import { inspectReplanLeaderSources, syncTimelineLeaderTimes } from './fdeTimelineTimeService.js'
import { canReadReferencedDirectiveTasks } from './fdeDirectiveLinksService.js'
import { lockSchedulePeople, scheduleConflicts } from './fdeScheduleService.js'
import { scheduleTransaction } from './fdeScheduleTransactionService.js'
import { reconcileTaskResponsibility } from './fdeResponsibilityService.js'

type Scope = Awaited<ReturnType<typeof projectAgentScope>>
async function transaction<T>(projectId: string, userId: string, operation: (tx: AgentTx, scope: Scope) => Promise<T>) {
  return scheduleTransaction(async tx => {
    await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
    const [project] = await tx.select({ ownerId: projects.ownerUserId }).from(projects).where(eq(projects.id, projectId))
    const duties = await tx.select({ id: projectDutyAssignments.userId }).from(projectDutyAssignments).where(eq(projectDutyAssignments.projectId, projectId))
    const leaders = await tx.select({ id: leaderTimeRequests.leaderId }).from(leaderTimeRequests).where(eq(leaderTimeRequests.projectId, projectId))
    await lockSchedulePeople(tx, [userId, ...(project?.ownerId ? [project.ownerId] : []), ...duties.map(p => p.id), ...leaders.map(p => p.id)])
    return operation(tx, await projectAgentScope(tx, projectId, userId))
  }, { isolationLevel: 'read committed' })
}
async function configuredPolicy(tx: AgentTx, projectId: string) {
  const [row] = await tx.select().from(projectReplanPolicies).where(eq(projectReplanPolicies.projectId, projectId))
  const parsed = projectReplanPolicy.safeParse(row?.configuration)
  if (!row?.enabled || !row.approvedBy || row.approvedBy === row.createdBy || !row.approvalEvidence.trim() || !parsed.success || row.configurationHash !== replanHash(row.configuration)) return null
  return { row, configuration: parsed.data }
}
async function requesterAllowed(tx: AgentTx, scope: Scope, policy: ProjectReplanPolicy) {
  const assigned = await tx.select().from(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, scope.project.id), eq(projectDutyAssignments.userId, scope.actor.id), eq(projectDutyAssignments.duty, 'secretary')))
  const categories = await tx.select({ category: roles.fdeCategory }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(eq(userRoles.userId, scope.actor.id), eq(roles.status, '启用')))
  return scope.canRun && ((policy.requesterDuties.includes('owner') && scope.project.ownerUserId === scope.actor.id && categories.some(r => ['institution_leader', 'project_lead', 'member'].includes(r.category ?? '')))
    || policy.requesterDuties.includes('secretary') && assigned.length > 0 && categories.some(r => ['secretary', 'project_lead', 'member'].includes(r.category ?? '')))
}
async function reviewers(tx: AgentTx, projectId: string, applicantId: string, policy: ProjectReplanPolicy) {  const assignments = await tx.select().from(projectDutyAssignments).where(eq(projectDutyAssignments.projectId, projectId)).orderBy(asc(projectDutyAssignments.userId))
  const roster = await tx.select({ id: users.id, name: users.name, code: roles.code }).from(users).innerJoin(userRoles, eq(userRoles.userId, users.id)).innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(users.status, '启用'), eq(roles.status, '启用'), eq(roles.fdeCategory, 'institution_leader'))).orderBy(asc(users.id), asc(roles.code))
  const result = []
  for (const definition of policy.approvals) {
    const ids = [...new Set(assignments.filter(a => a.duty === definition.duty).map(a => a.userId))].filter(id => id !== applicantId).sort()
    const code = definition.duty === 'chairman' ? 'FDE_CHAIRMAN' : definition.duty === 'president' ? 'FDE_PRESIDENT' : null
    if (!ids.length || ids.some(id => !roster.some(p => p.id === id && (!code || p.code === code)))) return agentFail('REPLAN_REVIEWER_REQUIRED', '整体重排缺少独立且当前职责有效的指定审批人')
    for (const id of ids) await projectAgentScope(tx, projectId, id)
    result.push({ ...definition, ids, names: ids.map(id => roster.find(p => p.id === id)!.name) })
  }
  return result
}
async function impact(tx: AgentTx, scope: Scope, targetDate: string, ownRequest?: string) {
  const project = scope.project, policy = await configuredPolicy(tx, project.id)
  const timeline = await readAgentTimeline(tx, project)
  const dates = await tx.select({ date: projectStageDates, request: requests }).from(projectStageDates).innerJoin(requests, eq(requests.id, projectStageDates.approvalId)).where(eq(projectStageDates.projectId, project.id)).orderBy(asc(projectStageDates.stage))
  for (const { date, request } of dates) {
    if (request.status !== '已通过' || !request.completedAt || request.projectId !== project.id) return agentFail('REPLAN_SOURCE_INVALID', '节点日期没有同项目最终批准来源')
    if (request.businessType === 'project_replan') {
      const [source] = await tx.select().from(projectReplanRequests).where(eq(projectReplanRequests.requestId, request.id))
      if (!source || source.projectId !== project.id || request.businessPayload.impactHash !== replanHash(source.impact) || !source.impact.stages.some(s => s.id === date.stage && s.after === date.plannedDate)) return agentFail('REPLAN_SOURCE_INVALID', '已有整体重排日期与原批准方案不一致')
    } else if (request.businessType === 'agent_schedule') {
      const [source] = await tx.select().from(projectAgentScheduleRequests).where(eq(projectAgentScheduleRequests.requestId, request.id))
      if (!source || source.projectId !== project.id || source.stage !== date.stage || source.requestedDate !== date.plannedDate) return agentFail('REPLAN_SOURCE_INVALID', '已有独立节点日期与原批准方案不一致')
    } else return agentFail('REPLAN_SOURCE_INVALID', '不支持的节点日期批准来源，不能据此重排')
  }
  const tasks = await tx.select().from(todos).where(and(eq(todos.projectId, project.id), isNull(todos.approvalRequestId))).orderBy(asc(todos.id)).limit(501)
  if (!await canReadReferencedDirectiveTasks(tx, tasks.map(t => t.id), scope.actor.id)) return agentFail('REPLAN_SOURCE_FORBIDDEN', '无法核对完整行动来源，不能展示局部重排方案', 403)
  const links = await tx.select().from(projectTimelineTasks).where(eq(projectTimelineTasks.projectId, project.id)).orderBy(asc(projectTimelineTasks.taskId)).limit(501)
  const approvals = await tx.select().from(requests).where(and(eq(requests.projectId, project.id), eq(requests.status, '审批中'), ne(requests.businessType, 'office'), ownRequest ? ne(requests.id, ownRequest) : undefined)).orderBy(asc(requests.id)).limit(501)
  const times = await tx.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.projectId, project.id)).orderBy(asc(leaderTimeRequests.id)).limit(501)
  const plans = await tx.select().from(projectPlans).where(and(eq(projectPlans.projectId, project.id), ne(projectPlans.status, 'archived'))).orderBy(asc(projectPlans.id)).limit(501)
  if ([tasks, links, approvals, times, plans].some(rows => rows.length > 500)) return agentFail('REPLAN_SOURCE_LIMIT', '整体重排来源超出容量，不能截断后批准')
  if (links.some(link => !tasks.some(task => task.id === link.taskId))) return agentFail('REPLAN_SOURCE_INVALID', '时间线来源与同项目正式任务不完整对应')
  const taskInputs: ReplanTask[] = tasks.map(task => {
    const link = links.find(l => l.taskId === task.id)
    return { ...task, stage: link?.stage ?? null, baseline: link ?? null, retired: link?.retired ?? false, pendingExtension: approvals.some(a => a.businessType === 'task_extension' && a.taskId === task.id) }
  })
  const calculated = calculateProjectReplan({ targetDate, previousTargetDate: project.targetDate, today: shanghaiToday(), currentStage: project.stage,
    policy: policy?.configuration ?? null,
    stages: timeline.map(s => ({ ...s, independent: dates.some(d => d.date.stage === s.stage && d.request.businessType !== 'project_replan') })), tasks: taskInputs,
    leaders: times.map(t => ({ ...t, automatic: Boolean(t.sourceTimelineTaskId || t.sourceWeeklyItemId) && !t.sourceTypeActionId && !t.sourceDirectiveId })) })
  if (project.projectType !== '投资项目' || project.lifecycle !== 'active' || project.classification === 'pool') calculated.blockers.push({ code: 'REPLAN_PROJECT_UNSUPPORTED', message: '仅支持已入库且有效的投资项目；不改变项目分类或非投资执行实例' })
  if (approvals.length) calculated.blockers.push({ code: 'REPLAN_APPROVAL_ACTIVE', message: '存在在途项目审批或任务延期，请先完成原流程' })
  if (plans.length) calculated.blockers.push({ code: 'REPLAN_PLAN_VERSION_REQUIRED', message: '已有独立倒排计划；其版本、行动映射与历史任务保护规则尚未裁决，本批不会只改目标日造成计划不一致' })
  const leadership = await inspectReplanLeaderSources(tx, project, calculated.tasks.filter(t => t.action === 'move').map(t => t.id))
  for (const message of leadership.issues) calculated.blockers.push({ code: 'REPLAN_LEADER_SOURCE_BLOCKED', message })
  let approvers: Awaited<ReturnType<typeof reviewers>> = [], allowed = false
  if (policy) {
    allowed = await requesterAllowed(tx, scope, policy.configuration)
    try { approvers = await reviewers(tx, project.id, scope.actor.id, policy.configuration) }
    catch (error) {
      if ((error as { code?: string }).code !== 'REPLAN_REVIEWER_REQUIRED') throw error
      calculated.blockers.push({ code: 'REPLAN_REVIEWER_REQUIRED', message: (error as Error).message })
    }
  }
  const slots: Array<{ id: string; leaderId: string; starts: Date; ends: Date }> = []
  for (const changed of calculated.leaders.filter(c => c.action === 'move')) {
    const row = times.find(t => t.id === changed.id)!, task = tasks.find(t => t.id === row.taskId)!
    const slot = timelineLeaderSlots(project.id, task.id, row.leaderId, changed.after!, task.dueTime!)
    const starts = timeInstant(slot.preferredStart), ends = timeEnd(starts, slot.durationMinutes)
    if (ends > timeInstant(slot.latestFinish)) calculated.blockers.push({ code: 'REPLAN_LEADER_DEADLINE', message: '来源领导需求的建议时段晚于任务截止时间，须先明确时间规则' })
    slots.push({ id: row.id, leaderId: row.leaderId, starts, ends })
  }
  for (const slot of slots) {
    if ((await scheduleConflicts(tx, slot.leaderId, slot.starts, slot.ends, { excludeTimeIds: slots.map(s => s.id) })).length
      || slots.some(other => other.id !== slot.id && other.leaderId === slot.leaderId && intervalsOverlap(slot.starts, slot.ends, other.starts, other.ends))) calculated.blockers.push({ code: 'REPLAN_TIME_CONFLICT', message: '重排后的领导需求存在时间占用冲突；不自动选择备选或覆盖原安排' })
  }
  const fingerprint = replanHash({ project, policy: policy?.row ?? null, dates, tasks, links, approvals, times, plans, approvers, leadership, today: shanghaiToday(), calculated })
  return { preview: { ...calculated, fingerprint, projectVersion: project.version, policyVersion: policy?.row.version ?? null, canSubmit: allowed && !calculated.blockers.length } satisfies ReplanPreview, approvers, tasks, links, times, policy }
}

export async function previewProjectReplan(projectId: string, userId: string, raw: unknown) {
  const input = projectReplanPreviewInput.parse(raw)
  return db.transaction(async tx => (await impact(tx, await projectAgentScope(tx, projectId, userId), input.targetDate)).preview, { isolationLevel: 'repeatable read' })
}
async function notify(tx: AgentTx, request: typeof requests.$inferSelect, node: typeof nodes.$inferSelect) {
  await tx.insert(todos).values(node.approverUserIds.map((id, i) => ({ projectId: request.projectId!, projectName: request.projectName, title: `审批：${request.title} · ${node.name}`, owner: node.approverNames[i], ownerUserId: id,
    dueDate: shanghaiToday(), priority: '中', status: '未开始', type: '流程', approvalRequestId: request.id, createdBy: request.applicantUserId })))
}
export async function submitProjectReplan(projectId: string, userId: string, raw: unknown) {
  const input = projectReplanSubmit.parse(raw), hash = replanHash({ action: 'replan-submit', projectId, userId, input })
  return transaction(projectId, userId, async (tx, scope) => {
    const replay = await replayAgentCommand(tx, projectId, userId, input.clientRequestId, hash); if (replay) return replay
    const current = await impact(tx, scope, input.targetDate)
    if (current.preview.fingerprint !== input.fingerprint) return agentFail('REPLAN_PREVIEW_STALE', '预览来源已变化，请重新预览后提交')
    if (!current.preview.canSubmit) return agentFail('REPLAN_BLOCKED', current.preview.blockers.map(b => b.message).join('；') || '当前账号不在整体重排发起职责中')
    const [last] = await tx.select().from(projectReplanRequests).where(eq(projectReplanRequests.projectId, projectId)).orderBy(desc(projectReplanRequests.revision)).limit(1)
    const id = randomUUID(), nodeIds = current.approvers.map(() => randomUUID())
    const { fingerprint, projectVersion: _version, policyVersion, canSubmit: _allowed, ...plan } = current.preview
    await tx.insert(requests).values({ id, requestNo: `RP-${id}`, projectId, projectName: scope.project.name, title: `${scope.project.name} · 整体重排 V${(last?.revision ?? 0) + 1}`, type: '项目整体重排', businessType: 'project_replan',
      fromStage: scope.project.stage, targetStage: scope.project.stage, applicantUserId: userId, applicantName: scope.actor.name, department: scope.actor.department,
      currentNodeId: nodeIds[0], currentNodeName: current.approvers[0].name, activeKey: projectId, reason: input.reason, businessPayload: { reviewerSignature: replanHash(current.approvers), impactHash: replanHash(plan) } })
    await tx.insert(nodes).values(current.approvers.map((node, i) => ({ id: nodeIds[i], requestId: id, name: node.name, approverRole: node.duty, mode: node.mode, sequence: i + 1, status: i === 0 ? '待审批' : '未开始', approverUserIds: node.ids, approverNames: node.names })))
    await tx.insert(projectReplanRequests).values({ requestId: id, projectId, revision: (last?.revision ?? 0) + 1, policyVersion: policyVersion!, fingerprint, impact: plan })
    await tx.insert(records).values({ requestId: id, nodeId: nodeIds[0], nodeName: '提交整体重排', operatorUserId: userId, operatorName: scope.actor.name, action: '提交', comment: input.reason })
    const [request] = await tx.select().from(requests).where(eq(requests.id, id)), [node] = await tx.select().from(nodes).where(eq(nodes.id, nodeIds[0]))
    await notify(tx, request, node)
    return recordAgentCommand(tx, scope, input.clientRequestId, hash, { kind: 'replan', id, version: 1 })
  })
}

export async function actProjectReplan(projectId: string, requestId: string, userId: string, raw: unknown) {
  const input = projectReplanAction.parse(raw), hash = replanHash({ action: 'replan-action', projectId, requestId, userId, input })
  return transaction(projectId, userId, async (tx, scope) => {
    const replay = await replayAgentCommand(tx, projectId, userId, input.clientRequestId, hash); if (replay) return replay
    const [request] = await tx.select().from(requests).where(and(eq(requests.id, requestId), eq(requests.projectId, projectId), eq(requests.businessType, 'project_replan'))).for('update')
    const [plan] = await tx.select().from(projectReplanRequests).where(and(eq(projectReplanRequests.requestId, requestId), eq(projectReplanRequests.projectId, projectId)))
    if (!request || !plan) return agentFail('REPLAN_NOT_FOUND', '整体重排申请不存在', 404)
    if (request.status !== '审批中' || request.lockVersion !== input.expectedVersion) return agentFail('VERSION_CONFLICT', '申请版本或状态已变化')
    const all = await tx.select().from(nodes).where(eq(nodes.requestId, requestId)).orderBy(asc(nodes.sequence)), node = all.find(n => n.id === request.currentNodeId)
    if (!node) return agentFail('REPLAN_NODE_INVALID', '审批节点不存在')
    if (input.action === 'withdraw') {
      if (request.applicantUserId !== userId) return agentFail('REPLAN_FORBIDDEN', '只有申请人可撤回', 403)
    } else {
      if (userId === request.applicantUserId || !node.approverUserIds.includes(userId) || node.approvedByUserIds.includes(userId)) return agentFail('REPLAN_FORBIDDEN', '仅当前独立审批人可办理', 403)
      const policy = await configuredPolicy(tx, projectId)
      if (!policy || policy.row.version !== plan.policyVersion || replanHash(await reviewers(tx, projectId, request.applicantUserId, policy.configuration)) !== request.businessPayload.reviewerSignature) return agentFail('REPLAN_POLICY_CHANGED', '当前政策或审批职责已变化，请撤回重提')
    }
    let status = input.action === 'reject' ? '已拒绝' : input.action === 'withdraw' ? '已撤回' : '审批中', next: typeof node | undefined
    let nodeCompleted = false
    if (input.action === 'approve') {
      // Lock the same stable people as all calendar writers before refreshing
      // occupancy. The project lock prevents source tasks changing meanwhile.
      const people = await tx.select({ id: leaderTimeRequests.leaderId }).from(leaderTimeRequests).where(eq(leaderTimeRequests.projectId, projectId))
      await lockSchedulePeople(tx, people.map(p => p.id))
      const applicant = await projectAgentScope(tx, projectId, request.applicantUserId), current = await impact(tx, applicant, plan.impact.targetDate, requestId)
      const { fingerprint, projectVersion: _version, policyVersion: _policy, canSubmit, ...freshImpact } = current.preview
      if (!canSubmit || fingerprint !== plan.fingerprint || replanHash(freshImpact) !== replanHash(plan.impact) || request.businessPayload.impactHash !== replanHash(plan.impact)) return agentFail('REPLAN_SOURCE_CHANGED', '计划、任务、权限、规则或时间占用已变化，请撤回后重新预览')
      // The approver must also retain access to every referenced task, not just
      // access to the project or the historical approval assignment.
      if (!await canReadReferencedDirectiveTasks(tx, current.tasks.map(t => t.id), userId)) return agentFail('REPLAN_SOURCE_FORBIDDEN', '当前审批人不能核对完整来源', 403)
      const transition = approveNodeTransition({ ...node, actorId: userId, override: false })
      nodeCompleted = transition.completed
      await tx.update(nodes).set({ approvedByUserIds: transition.approvedIds, approvedByNames: [...node.approvedByNames, scope.actor.name], status: transition.completed ? '已通过' : '会签中', completedAt: transition.completed ? new Date() : null }).where(eq(nodes.id, node.id))
      next = transition.completed ? all.find(n => n.sequence === node.sequence + 1) : undefined
      if (transition.completed && !next) {
        status = '已通过'
        // Freeze previously projected historical dates too: otherwise changing
        // targetDate would retroactively recompute a completed node's plan date.
        for (const change of plan.impact.stages) {
          const [date] = await tx.select().from(projectStageDates).where(and(eq(projectStageDates.projectId, projectId), eq(projectStageDates.stage, change.id)))
          if (date && change.action === 'move') await tx.update(projectStageDates).set({ plannedDate: change.after!, approvalId: requestId, version: date.version + 1, updatedAt: new Date() }).where(eq(projectStageDates.id, date.id))
          else if (!date) await tx.insert(projectStageDates).values({ projectId, stage: change.id, plannedDate: change.after!, approvalId: requestId })
        }
        const syncId = randomUUID(), moved = plan.impact.tasks.filter(c => c.action === 'move')
        for (const change of moved) {
          const task = current.tasks.find(t => t.id === change.id)!, link = current.links.find(l => l.taskId === task.id)!
          await tx.update(todos).set({ dueDate: change.after!, version: task.version + 1 }).where(eq(todos.id, task.id))
          await tx.update(projectTimelineTasks).set({ dueDate: change.after!, version: link.version + 1 }).where(eq(projectTimelineTasks.taskId, task.id))
          await reconcileTaskResponsibility(tx, task.id, userId, 'timeline', syncId)
        }
        await tx.update(projects).set({ targetDate: plan.impact.targetDate, version: scope.project.version + 1, updatedAt: new Date() }).where(eq(projects.id, projectId))
        const updatedProject = { ...scope.project, targetDate: plan.impact.targetDate, version: scope.project.version + 1 }
        const issues = [...await syncTimelineLeaderTimes(tx, updatedProject, userId, 'timeline', moved.map(c => c.id)), ...await syncTimelineLeaderTimes(tx, updatedProject, userId, 'weekly', moved.map(c => c.id))]
        if (issues.length) return agentFail('REPLAN_LEADER_SOURCE_BLOCKED', issues.join('；'))
        await tx.insert(projectTimelineSyncs).values({ id: syncId, projectId, actorId: userId, approvalId: requestId, fingerprint: plan.fingerprint, source: 'replan', sourceKey: `replan:${requestId}`, status: 'completed',
          changes: moved.map(change => { const task = current.tasks.find(t => t.id === change.id)!, link = current.links.find(l => l.taskId === task.id)!; return { taskId: task.id, stage: link.stage, key: link.actionKey, title: task.title, action: 'update' as const, reason: change.reason, ownerUserId: task.ownerUserId, ownerName: task.owner, dueDate: change.after, dueTime: task.dueTime, previousDate: change.before, previousTime: task.dueTime, proposal: null } }), issues: [] })
      }
    }
    const closure = replanApprovalTodoClosure({ requestStatus: status, nodeCompleted, actorId: userId, approverUserIds: node.approverUserIds })
    await tx.update(todos).set({ status: '已完成' }).where(and(eq(todos.approvalRequestId, requestId), ne(todos.status, '已完成'), closure.scope === 'owners' ? inArray(todos.ownerUserId, closure.ownerIds) : undefined))
    // Close the old node first: the same person may also belong to the next one.
    if (next) { await tx.update(nodes).set({ status: '待审批' }).where(eq(nodes.id, next.id)); await notify(tx, request, next) }
    if (status !== '审批中' && status !== '已通过') await tx.update(nodes).set({ status, completedAt: new Date() }).where(and(eq(nodes.requestId, requestId), inArray(nodes.status, ['待审批', '会签中', '未开始'])))
    await tx.update(requests).set({ status, lockVersion: request.lockVersion + 1, activeKey: status === '审批中' ? projectId : null, currentNodeId: status === '审批中' ? next?.id ?? node.id : null,
      currentNodeName: status === '审批中' ? next?.name ?? node.name : status, completedAt: status === '审批中' ? null : new Date(), updatedAt: new Date() }).where(eq(requests.id, requestId))
    await tx.insert(records).values({ requestId, nodeId: node.id, nodeName: node.name, operatorUserId: userId, operatorName: scope.actor.name, action: input.action === 'approve' ? '同意' : input.action === 'reject' ? '拒绝' : '撤回', comment: input.reason })
    return recordAgentCommand(tx, scope, input.clientRequestId, hash, { kind: 'replan', id: requestId, version: request.lockVersion + 1 })
  })
}

export async function getProjectReplans(projectId: string, userId: string): Promise<ReplanDashboard> {
  return db.transaction(async tx => {
    const scope = await projectAgentScope(tx, projectId, userId), policy = await configuredPolicy(tx, projectId)
    const rows = await tx.select({ plan: projectReplanRequests, request: requests }).from(projectReplanRequests).innerJoin(requests, eq(requests.id, projectReplanRequests.requestId)).where(eq(projectReplanRequests.projectId, projectId)).orderBy(desc(projectReplanRequests.revision)).limit(101)
    if (rows.length > 100) return agentFail('REPLAN_HISTORY_LIMIT', '整体重排历史超过容量，未截断展示')
    const result: ReplanDashboard['requests'] = []
    for (const { plan, request } of rows) {
      if (request.businessPayload.impactHash !== replanHash(plan.impact)) return agentFail('REPLAN_SOURCE_INVALID', '整体重排历史方案校验失败，未展示不可靠影响清单')
      if (!await canReadReferencedDirectiveTasks(tx, plan.impact.tasks.map(t => t.id), userId)) return agentFail('REPLAN_SOURCE_FORBIDDEN', '当前账号不能读取完整重排历史来源', 403)
      const [node] = request.currentNodeId ? await tx.select().from(nodes).where(eq(nodes.id, request.currentNodeId)) : []
      const history = await tx.select().from(records).where(eq(records.requestId, request.id)).orderBy(asc(records.createdAt), asc(records.id))
      let currentReviewers = false
      if (request.status === '审批中' && policy?.row.version === plan.policyVersion) {
        try { currentReviewers = replanHash(await reviewers(tx, projectId, request.applicantUserId, policy.configuration)) === request.businessPayload.reviewerSignature }
        catch (error) { if (!['REPLAN_REVIEWER_REQUIRED', 'AGENT_FORBIDDEN', 'AGENT_ACTOR_UNAVAILABLE'].includes((error as { code?: string }).code ?? '')) throw error }
      }
      result.push({ id: request.id, revision: plan.revision, version: request.lockVersion, status: request.status, reason: request.reason, currentNodeName: request.currentNodeName, impact: plan.impact,
        canAct: request.status === '审批中' && currentReviewers && request.applicantUserId !== userId && Boolean(node?.approverUserIds.includes(userId) && !node.approvedByUserIds.includes(userId)), canWithdraw: request.status === '审批中' && request.applicantUserId === userId,
        history: history.map(r => ({ action: r.action, actor: r.operatorName, reason: r.comment, at: r.createdAt.toISOString() })) })
    }
    return { targetDate: scope.project.targetDate, canPreview: Boolean(policy && await requesterAllowed(tx, scope, policy.configuration)), policyConfigured: Boolean(policy), policyIssue: policy ? null : '整体重排正式规则尚未配置或启用；可以查看阻塞，不可提交正式申请', requests: result }
  }, { isolationLevel: 'repeatable read' })
}
