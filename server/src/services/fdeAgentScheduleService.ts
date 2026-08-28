import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { oaApprovalNodes as nodes, oaApprovalRecords as records, oaApprovalRequests as requests, projectAgentConfigs, projectAgentDecisions, projectAgentRecommendations, projectAgentRuns, projectAgentScheduleRequests as schedules, projectDutyAssignments, projectStageDates, projects, roles, todos, userRoles, users } from '../db/schema.js'
import { agentScheduleAction, agentScheduleSubmit, agentScheduleWindow, type AgentScheduleDashboard } from '../contracts/fdeAgentScheduleContract.js'
import { approveNodeTransition } from '../contracts/approvalNodeTransition.js'
import { shanghaiToday } from '../contracts/fdeWeeklyPlanContract.js'
import { agentHash, agentFail, collectProjectAgentFacts, projectAgentScope, type AgentTx } from './fdeProjectAgentFactsService.js'
import { agentTransaction, recordAgentCommand, replayAgentCommand } from './fdeProjectAgentService.js'
import { readAgentTimeline } from './fdeAgentTimelineService.js'
import { syncApprovedTimelineTasks } from './fdeTimelineTaskService.js'

// Reference reviewers are president, or chairman -> president at investment/payment.
// Resolve real roles and project duties; never resolve reference demo names.
async function reviewers(tx: AgentTx, projectId: string, stage: string, applicant: string) {
  const assigned = await tx.select().from(projectDutyAssignments).where(eq(projectDutyAssignments.projectId, projectId))
  const people = await tx.select({ id: users.id, name: users.name, role: roles.code }).from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id)).innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(users.status, '启用'), eq(roles.status, '启用'), inArray(roles.code, ['FDE_CHAIRMAN', 'FDE_PRESIDENT']))).orderBy(asc(users.id))
  const result: Array<{ name: string; role: string; ids: string[]; names: string[] }> = []
  const add = (duty: 'chairman' | 'president') => {
    const role = duty === 'chairman' ? 'FDE_CHAIRMAN' : 'FDE_PRESIDENT', bindings = assigned.filter(item => item.duty === duty)
    const candidates = bindings.length ? bindings.map(item => item.userId).sort() : people.filter(item => item.role === role).map(item => item.id)
    if (!candidates.length || candidates.some(id => !people.some(person => person.id === id && person.role === role))) return agentFail('AGENT_SCHEDULE_REVIEWER_MISSING', '请先配置启用且符合岗位的节点改期审批人')
    const selected = [...new Set(candidates)].filter(id => id !== applicant)
    if (selected.length) result.push({ name: duty === 'chairman' ? '董事长改期审批' : '总裁改期审批', role, ids: selected, names: selected.map(id => people.find(person => person.id === id)!.name) })
  }
  if (['投决', '打款'].includes(stage)) add('chairman')
  add('president')
  if (!result.length) add('chairman')
  if (!result.length) return agentFail('AGENT_SCHEDULE_SELF_APPROVAL', '没有独立审批人，不能自动批准或由申请人自批')
  for (const group of result) for (const id of group.ids) await projectAgentScope(tx, projectId, id)
  return result
}
const reviewerSignature = (items: Array<{ name: string; role: string; ids: string[] }>) => agentHash(items.map(item => ({ name: item.name, role: item.role, ids: item.ids })))
async function sourceCurrent(tx: AgentTx, projectId: string, userId: string, recommendationId: string, ownRequest?: string) {
  const [rec] = await tx.select().from(projectAgentRecommendations).where(and(eq(projectAgentRecommendations.id, recommendationId), eq(projectAgentRecommendations.projectId, projectId)))
  if (!rec) return agentFail('AGENT_RECOMMENDATION_NOT_FOUND', '建议不存在', 404)
  const [run] = await tx.select().from(projectAgentRuns).where(eq(projectAgentRuns.id, rec.runId))
  const current = await collectProjectAgentFacts(tx, projectId, userId)
  if (ownRequest) {
    current.activeApprovalIds = current.activeApprovalIds.filter(id => id !== ownRequest)
    current.evidence = current.evidence.filter(item => item.id !== ownRequest)
  }
  const [config] = await tx.select().from(projectAgentConfigs).where(eq(projectAgentConfigs.projectId, projectId))
  if (run.status !== 'succeeded' || agentHash(current) !== run.inputHash || (config?.version ?? 0) !== run.configVersion) return agentFail('AGENT_SCHEDULE_STALE', '来源、权限或研判基准已变化，请撤回后重新研判')
  return { rec, current }
}
async function notifyNode(tx: AgentTx, request: typeof requests.$inferSelect, node: typeof nodes.$inferSelect) {
  await tx.insert(todos).values(node.approverUserIds.map((id, index) => ({ projectId: request.projectId!, projectName: request.projectName,
    title: `审批：${request.title} · ${node.name}`, owner: node.approverNames[index], ownerUserId: id, dueDate: shanghaiToday(),
    priority: '中', status: '未开始', type: '流程', approvalRequestId: request.id, createdBy: request.applicantUserId })))
}
async function closeNotices(tx: AgentTx, requestId: string, actorId?: string) {
  await tx.update(todos).set({ status: '已完成' }).where(and(eq(todos.approvalRequestId, requestId), ne(todos.status, '已完成'), actorId ? eq(todos.ownerUserId, actorId) : undefined))
}

export async function submitAgentSchedule(projectId: string, recommendationId: string, userId: string, raw: unknown) {
  const input = agentScheduleSubmit.parse(raw), hash = agentHash({ action: 'schedule-submit', projectId, recommendationId, userId, input })
  return agentTransaction(projectId, userId, async (tx, scope) => {
    if (!scope.canRun) return agentFail('AGENT_SCHEDULE_FORBIDDEN', '只有项目负责人、推进秘书或有权领导可提交改期', 403)
    const prior = await replayAgentCommand(tx, projectId, userId, input.clientRequestId, hash); if (prior) return prior
    const { rec, current } = await sourceCurrent(tx, projectId, userId, recommendationId)
    const [decision] = await tx.select().from(projectAgentDecisions).where(eq(projectAgentDecisions.recommendationId, rec.id))
    if (rec.version !== input.expectedVersion || !decision?.scheduleDraft || !['accepted', 'accepted_with_changes'].includes(rec.status)) return agentFail('AGENT_SCHEDULE_DRAFT_REQUIRED', '需先采纳当前有效的节点改期草案')
    const [exists] = await tx.select().from(schedules).where(eq(schedules.recommendationId, rec.id))
    if (exists) return agentFail('AGENT_SCHEDULE_EXISTS', '该建议已有审批；拒绝或撤回后须重新研判')
    const [active] = await tx.select({ id: requests.id }).from(requests).where(and(eq(requests.projectId, projectId), eq(requests.status, '审批中'), ne(requests.businessType, 'office')))
    if (active) return agentFail('AGENT_SCHEDULE_APPROVAL_ACTIVE', '已有在途项目审批或延期，请先完成原流程')
    const timeline = await readAgentTimeline(tx, scope.project), window = agentScheduleWindow(timeline, current.stage, current.targetDate, current.asOfDate)
    if (!window?.available || input.requestedDate < window.minimum || input.requestedDate > window.maximum || input.requestedDate === window.currentDate) return agentFail('AGENT_SCHEDULE_DATE_INVALID', '申请日期必须不同于当前日期，且位于前后节点与项目目标日允许的区间')
    const approvers = await reviewers(tx, projectId, current.stage, userId), id = randomUUID(), nodeIds = approvers.map(() => randomUUID())
    await tx.insert(requests).values({ id, requestNo: `AS-${id}`, projectId, projectName: scope.project.name, title: `${scope.project.name} · ${current.stage}节点改期`, type: '项目改期', businessType: 'agent_schedule',
      fromStage: current.stage, targetStage: current.stage, applicantUserId: userId, applicantName: scope.actor.name, department: scope.actor.department,
      currentNodeId: nodeIds[0], currentNodeName: approvers[0].name, activeKey: projectId, reason: input.reason,
      businessPayload: { recommendationId, previousDate: window.currentDate, requestedDate: input.requestedDate, reviewerSignature: reviewerSignature(approvers) } })
    await tx.insert(nodes).values(approvers.map((node, index) => ({ id: nodeIds[index], requestId: id, name: node.name, approverRole: node.role, mode: '会签', sequence: index + 1,
      status: index === 0 ? '待审批' : '未开始', approverUserIds: node.ids, approverNames: node.names })))
    await tx.insert(schedules).values({ requestId: id, recommendationId: rec.id, projectId, stage: current.stage, previousDate: window.currentDate, requestedDate: input.requestedDate, timelineHash: agentHash(timeline) })
    await tx.insert(records).values({ requestId: id, nodeId: nodeIds[0], nodeName: '提交改期', operatorUserId: userId, operatorName: scope.actor.name, action: '提交', comment: input.reason })
    const [request] = await tx.select().from(requests).where(eq(requests.id, id)), [node] = await tx.select().from(nodes).where(eq(nodes.id, nodeIds[0]))
    await notifyNode(tx, request, node)
    return recordAgentCommand(tx, scope, input.clientRequestId, hash, { kind: 'schedule', id, version: 1 })
  })
}

export async function actAgentSchedule(projectId: string, requestId: string, userId: string, raw: unknown) {
  const input = agentScheduleAction.parse(raw), hash = agentHash({ action: 'schedule-action', projectId, requestId, userId, input })
  return agentTransaction(projectId, userId, async (tx, scope) => {
    const prior = await replayAgentCommand(tx, projectId, userId, input.clientRequestId, hash); if (prior) return prior
    const [request] = await tx.select().from(requests).where(and(eq(requests.id, requestId), eq(requests.projectId, projectId), eq(requests.businessType, 'agent_schedule'))).for('update')
    const [schedule] = await tx.select().from(schedules).where(eq(schedules.requestId, requestId))
    if (!request || !schedule) return agentFail('AGENT_SCHEDULE_NOT_FOUND', '改期审批不存在', 404)
    if (request.status !== '审批中' || request.lockVersion !== input.expectedVersion) return agentFail('VERSION_CONFLICT', '审批状态或版本已变化')
    const allNodes = await tx.select().from(nodes).where(eq(nodes.requestId, requestId)).orderBy(asc(nodes.sequence)), node = allNodes.find(item => item.id === request.currentNodeId)
    if (!node) return agentFail('AGENT_SCHEDULE_NODE_INVALID', '审批节点缺失')
    if (input.action === 'withdraw') {
      if (request.applicantUserId !== userId) return agentFail('AGENT_SCHEDULE_WITHDRAW_FORBIDDEN', '只有申请人可撤回', 403)
    } else {
      if (request.applicantUserId === userId || !node.approverUserIds.includes(userId) || node.approvedByUserIds.includes(userId)) return agentFail('AGENT_SCHEDULE_APPROVAL_FORBIDDEN', '仅当前未处理的独立审批人可操作', 403)
      const currentReviewers = await reviewers(tx, projectId, schedule.stage, request.applicantUserId)
      if (reviewerSignature(currentReviewers) !== request.businessPayload.reviewerSignature) return agentFail('AGENT_SCHEDULE_REVIEWER_CHANGED', '审批职责已变化，请撤回重提')
    }
    let status = input.action === 'reject' ? '已拒绝' : input.action === 'withdraw' ? '已撤回' : '审批中', nextNode: typeof node | undefined
    if (input.action === 'approve') {
      await sourceCurrent(tx, projectId, userId, schedule.recommendationId, requestId)
      const timeline = await readAgentTimeline(tx, scope.project), window = agentScheduleWindow(timeline, scope.project.stage, scope.project.targetDate, shanghaiToday())
      if (scope.project.lifecycle !== 'active' || scope.project.stage !== schedule.stage || agentHash(timeline) !== schedule.timelineHash || !window?.available || window.currentDate !== schedule.previousDate || schedule.requestedDate < window.minimum || schedule.requestedDate > window.maximum) return agentFail('AGENT_SCHEDULE_STALE', '项目阶段或时间线已变化，本次审批未执行')
      const transition = approveNodeTransition({ ...node, actorId: userId, override: false })
      await tx.update(nodes).set({ approvedByUserIds: transition.approvedIds, approvedByNames: [...node.approvedByNames, scope.actor.name], status: transition.completed ? '已通过' : '会签中', completedAt: transition.completed ? new Date() : null }).where(eq(nodes.id, node.id))
      nextNode = transition.completed ? allNodes.find(item => item.sequence === node.sequence + 1) : undefined
      if (transition.completed && !nextNode) {
        status = '已通过'
        const [date] = await tx.select().from(projectStageDates).where(and(eq(projectStageDates.projectId, projectId), eq(projectStageDates.stage, schedule.stage)))
        if (date) await tx.update(projectStageDates).set({ plannedDate: schedule.requestedDate, approvalId: requestId, version: date.version + 1, updatedAt: new Date() }).where(eq(projectStageDates.id, date.id))
        else await tx.insert(projectStageDates).values({ projectId, stage: schedule.stage, plannedDate: schedule.requestedDate, approvalId: requestId })
        await tx.update(projects).set({ version: sql`${projects.version}+1`, updatedAt: new Date() }).where(eq(projects.id, projectId))
      }
    }
    await closeNotices(tx, requestId, status === '审批中' ? userId : undefined)
    if (nextNode) {
      await tx.update(nodes).set({ status: '待审批' }).where(eq(nodes.id, nextNode.id))
      await notifyNode(tx, request, nextNode)
    }
    if (status !== '审批中' && status !== '已通过') await tx.update(nodes).set({ status, completedAt: new Date() }).where(and(eq(nodes.requestId, requestId), inArray(nodes.status, ['待审批', '会签中', '未开始'])))
    await tx.update(requests).set({ status, lockVersion: request.lockVersion + 1, activeKey: status === '审批中' ? projectId : null,
      currentNodeId: status === '审批中' ? nextNode?.id ?? node.id : null, currentNodeName: status === '审批中' ? nextNode?.name ?? node.name : status,
      completedAt: status === '审批中' ? null : new Date(), updatedAt: new Date() }).where(eq(requests.id, requestId))
    await tx.insert(records).values({ requestId, nodeId: node.id, nodeName: node.name, operatorUserId: userId, operatorName: scope.actor.name, action: input.action === 'approve' ? '同意' : input.action === 'reject' ? '拒绝' : '撤回', comment: input.reason })
    if (status === '已通过') await syncApprovedTimelineTasks(tx, projectId, userId, requestId)
    return recordAgentCommand(tx, scope, input.clientRequestId, hash, { kind: 'schedule', id: requestId, version: request.lockVersion + 1 })
  })
}

export async function getAgentSchedules(projectId: string, userId: string): Promise<AgentScheduleDashboard> {
  return db.transaction(async tx => {
    const scope = await projectAgentScope(tx, projectId, userId), timeline = await readAgentTimeline(tx, scope.project)
    const list = await tx.select({ schedule: schedules, request: requests }).from(schedules).innerJoin(requests, eq(schedules.requestId, requests.id)).where(eq(schedules.projectId, projectId)).orderBy(desc(schedules.createdAt)).limit(101)
    if (list.length > 100) return agentFail('AGENT_SCHEDULE_HISTORY_LIMIT', '改期历史超过当前页面容量，需分页后查看，未静默截断')
    const approvals: AgentScheduleDashboard['approvals'] = []
    for (const { schedule, request } of list) {
      const allNodes = await tx.select().from(nodes).where(eq(nodes.requestId, request.id)).orderBy(asc(nodes.sequence)), node = allNodes.find(item => item.id === request.currentNodeId)
      const history = await tx.select().from(records).where(eq(records.requestId, request.id)).orderBy(asc(records.createdAt), asc(records.id))
      let stale = false, reviewersValid = false
      if (request.status === '审批中') {
        try { await sourceCurrent(tx, projectId, userId, schedule.recommendationId, request.id); stale = agentHash(timeline) !== schedule.timelineHash }
        catch (cause) { if (!(cause as { code?: string }).code?.startsWith('AGENT_')) throw cause; stale = true }
        try { reviewersValid = reviewerSignature(await reviewers(tx, projectId, schedule.stage, request.applicantUserId)) === request.businessPayload.reviewerSignature }
        catch (cause) { if (!(cause as { code?: string }).code?.startsWith('AGENT_')) throw cause }
      }
      approvals.push({ id: request.id, recommendationId: schedule.recommendationId, stage: schedule.stage, previousDate: schedule.previousDate, requestedDate: schedule.requestedDate,
        status: request.status, version: request.lockVersion, reason: request.reason, currentNodeName: request.currentNodeName, stale,
        canApprove: request.status === '审批中' && reviewersValid && request.applicantUserId !== userId && Boolean(node?.approverUserIds.includes(userId) && !node.approvedByUserIds.includes(userId)),
        canWithdraw: request.status === '审批中' && request.applicantUserId === userId,
        nodes: allNodes.map(item => ({ name: item.name, status: item.status, approverNames: item.approverNames })),
        history: history.map(item => ({ action: item.action, actor: item.operatorName, reason: item.comment, at: item.createdAt.toISOString() })) })
    }
    const decisions = await tx.select({ rec: projectAgentRecommendations, decision: projectAgentDecisions }).from(projectAgentRecommendations).innerJoin(projectAgentDecisions, eq(projectAgentDecisions.recommendationId, projectAgentRecommendations.id))
      .where(eq(projectAgentRecommendations.projectId, projectId)).orderBy(desc(projectAgentDecisions.createdAt)).limit(30)
    const submissions: AgentScheduleDashboard['submissions'] = []
    if (scope.canRun) for (const { rec, decision } of decisions) {
      if (!decision.scheduleDraft || list.some(item => item.schedule.recommendationId === rec.id)) continue
      try { await sourceCurrent(tx, projectId, userId, rec.id); submissions.push({ recommendationId: rec.id, version: rec.version, date: decision.scheduleDraft.suggestedDate }) }
      catch (cause) { if (!(cause as { code?: string }).code?.startsWith('AGENT_')) throw cause }
    }
    return { timeline, window: agentScheduleWindow(timeline, scope.project.stage, scope.project.targetDate, shanghaiToday()), approvals, submissions }
  }, { isolationLevel: 'repeatable read' })
}
