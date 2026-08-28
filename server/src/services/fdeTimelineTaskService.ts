import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, ne, notInArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { oaApprovalRequests, projectDutyAssignments, projectMembers, projectTimelineSyncs, projectTimelineTasks, projects, roles, todoFeedbacks, todos, userRoles, users } from '../db/schema.js'
import { timelineSyncInput, timelineTaskProposals, timelineTaskProtection, type TimelineChange, type TimelinePreview, type TimelineSyncSource } from '../contracts/fdeTimelineTaskContract.js'
import { agentFail, agentHash, projectAgentScope, type AgentTx } from './fdeProjectAgentFactsService.js'
import { agentTransaction, recordAgentCommand, replayAgentCommand } from './fdeProjectAgentService.js'
import { readAgentTimeline } from './fdeAgentTimelineService.js'
import { inspectFdeStageGate } from './fdeWorkflowService.js'
import { getProjectWorkflowPolicy } from './fdeWorkflowPolicyService.js'
import { reconcileTaskResponsibility } from './fdeResponsibilityService.js'
import { FDE_PROJECT_DUTIES } from '../contracts/fdeGovernanceContract.js'
import { reconcileTypeLeaderTimes, reconcileWeeklyLeaderTimes, syncTimelineLeaderTimes } from './fdeTimelineTimeService.js'

type Project = typeof projects.$inferSelect
async function preview(tx: AgentTx, project: Project): Promise<Omit<TimelinePreview, 'canSync'>> {
  if (project.projectType !== '投资项目') return agentFail('TIMELINE_TYPE_UNSUPPORTED', '非投资类型需使用独立批准模板，不能套用投资行动')
  const timeline = await readAgentTimeline(tx, project), current = timeline.find(item => item.stage === project.stage)
  if (!current) return agentFail('TIMELINE_DATE_REQUIRED', '请先明确当前阶段及项目目标日期')
  const policy = await getProjectWorkflowPolicy(tx, project), stage = policy.configuration.stages.find(item => item.stage === project.stage)!
  const gate = await inspectFdeStageGate(tx, project)
  const missing = stage.materials.filter(item => gate.checklist.some(check => check.label === item.label && !check.passed))
  const proposals = timelineTaskProposals(project.stage, current.date, missing, stage.approvals.some(item => ['chairman', 'president', 'concerned_leader', 'executive_lead'].includes(item.duty)))
  const bindings = await tx.select().from(projectDutyAssignments).where(eq(projectDutyAssignments.projectId, project.id)).orderBy(asc(projectDutyAssignments.id))
  const members = await tx.select({ id: users.id, name: users.name }).from(users).innerJoin(projectMembers, eq(projectMembers.userId, users.id)).where(and(eq(projectMembers.projectId, project.id), eq(users.status, '启用'))).orderBy(asc(users.id))
  const [owner] = project.ownerUserId ? await tx.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.id, project.ownerUserId), eq(users.status, '启用'))) : []
  const roster = new Map([...members, ...(owner ? [owner] : [])].map(item => [item.id, item]))
  const currentRoles = roster.size ? await tx.select({ userId: userRoles.userId, category: roles.fdeCategory }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(inArray(userRoles.userId, [...roster.keys()]), eq(roles.status, '启用'))).orderBy(asc(userRoles.userId), asc(roles.id)) : []
  const links = await tx.select({ link: projectTimelineTasks, task: todos }).from(projectTimelineTasks).innerJoin(todos, eq(todos.id, projectTimelineTasks.taskId)).where(eq(projectTimelineTasks.projectId, project.id)).orderBy(asc(projectTimelineTasks.taskId)).limit(501)
  if (links.length > 500) return agentFail('TIMELINE_TASK_LIMIT', '流程行动超过单次对账容量，不能截断处理')
  const taskIds = links.map(item => item.task.id)
  const extensions = taskIds.length ? await tx.select({ id: oaApprovalRequests.id, taskId: oaApprovalRequests.taskId, version: oaApprovalRequests.lockVersion }).from(oaApprovalRequests).where(and(inArray(oaApprovalRequests.taskId, taskIds), eq(oaApprovalRequests.businessType, 'task_extension'), eq(oaApprovalRequests.status, '审批中'))).orderBy(asc(oaApprovalRequests.id)) : []
  const feedbacks = taskIds.length ? await tx.select({ id: todoFeedbacks.id, taskId: todoFeedbacks.todoId }).from(todoFeedbacks).where(inArray(todoFeedbacks.todoId, taskIds)).orderBy(asc(todoFeedbacks.id)) : []
  const changes: TimelineChange[] = [], issues: string[] = []
  for (const proposal of proposals) {
    const assigned = proposal.duty === 'owner' ? [project.ownerUserId].filter(Boolean) : [...new Set(bindings.filter(item => item.duty === proposal.duty).map(item => item.userId))]
    const eligible: readonly string[] = proposal.duty === 'owner' ? ['institution_leader', 'project_lead', 'member'] : FDE_PROJECT_DUTIES.find(item => item.code === proposal.duty)!.eligible
    const candidate = assigned.length === 1 ? roster.get(assigned[0]!) : undefined
    const person = candidate && currentRoles.some(item => item.userId === candidate.id && item.category && eligible.includes(item.category)) ? candidate : undefined
    if (!person) issues.push(`${proposal.title}：${({ owner: '项目负责人', secretary: '推进秘书', finance: '财务', legal: '法务' })[proposal.duty]}须绑定唯一启用且岗位资格有效的项目成员`)
    const existing = links.find(item => item.link.stage === project.stage && item.link.actionKey === proposal.key)
    const change: TimelineChange = { taskId: existing?.task.id ?? null, stage: project.stage, key: proposal.key, title: proposal.title, action: 'add', reason: '由当前节点生成', ownerUserId: person?.id ?? null, ownerName: person?.name ?? '待配置', dueDate: proposal.dueDate, dueTime: proposal.dueTime, previousDate: existing?.task.dueDate ?? null, previousTime: existing?.task.dueTime ?? null, proposal }
    if (existing) {
      const { link, task } = existing
      const protection = timelineTaskProtection(task, link, extensions.some(item => item.taskId === task.id), link.retired)
      const changed = task.dueDate !== proposal.dueDate || task.dueTime !== proposal.dueTime || task.title !== proposal.title || task.deliverable !== proposal.deliverable || task.ownerUserId !== person?.id || link.needLeader !== proposal.needLeader || link.critical !== proposal.critical
      if (protection || (task.ownerUserId !== person?.id && (task.progress > 0 || feedbacks.some(item => item.taskId === task.id)))) { change.action = 'keep'; change.reason = protection ?? '执行后职责变化须人工移交，不自动改负责人' }
      else { change.action = link.retired ? 'restore' : changed ? 'update' : 'keep'; change.reason = link.retired ? '阶段条件恢复，复用原行动 ID' : changed ? '跟随当前节点日期及职责更新' : '来源与执行一致，无需变更' }
    }
    changes.push(change)
  }
  for (const { link, task } of links) {
    if (proposals.some(item => item.stage === link.stage && item.key === link.actionKey)) continue
    const protection = timelineTaskProtection(task, link, extensions.some(item => item.taskId === task.id), false)
    const untouched = task.status === '未开始' && task.progress === 0 && !feedbacks.some(item => item.taskId === task.id)
    changes.push({ taskId: task.id, stage: link.stage, key: link.actionKey, title: task.title, action: !protection && untouched ? 'retire' : 'keep', reason: protection ?? (untouched ? '材料或阶段条件已变化，受控收起未执行行动' : '已有执行记录，保留待人工处理'), ownerUserId: task.ownerUserId, ownerName: task.owner, dueDate: task.dueDate, dueTime: task.dueTime, previousDate: task.dueDate, previousTime: task.dueTime, proposal: null })
  }
  return { stage: project.stage, date: current.date, changes, issues, fingerprint: agentHash({ projectVersion: project.version, governanceVersion: project.governanceVersion, timeline, policy, gate, bindings, roster: [...roster.values()], currentRoles, links, extensions, feedbacks, proposals }) }
}

export async function previewTimelineTasks(projectId: string, userId: string): Promise<TimelinePreview> {
  return db.transaction(async tx => {
    const scope = await projectAgentScope(tx, projectId, userId)
    return { ...await preview(tx, scope.project), canSync: scope.canRun }
  }, { isolationLevel: 'repeatable read' })
}

async function apply(tx: AgentTx, project: Project, userId: string, plan: Omit<TimelinePreview, 'canSync'>, approvalId: string | null, event?: { source: TimelineSyncSource; sourceKey: string }) {
  if (plan.issues.length) return agentFail('TIMELINE_ASSIGNEE_REQUIRED', plan.issues.join('；'))
  const syncId = randomUUID(), recorded: TimelineChange[] = []
  for (const change of plan.changes) {
    if (change.action === 'keep') { recorded.push(change); continue }
    const taskId = change.taskId ?? randomUUID(), proposal = change.proposal
    if (change.action === 'add') {
      await tx.insert(todos).values({ id: taskId, projectId: project.id, projectName: project.name, title: change.title, owner: change.ownerName, ownerUserId: change.ownerUserId!, dueDate: change.dueDate!, dueTime: change.dueTime!, priority: proposal!.critical ? '高' : '中', deliverable: proposal!.deliverable, executionModel: 'fde-v1', createdBy: userId })
      await tx.insert(projectTimelineTasks).values({ taskId, projectId: project.id, stage: change.stage, actionKey: change.key, dueDate: change.dueDate!, dueTime: change.dueTime!, ownerUserId: change.ownerUserId!, needLeader: proposal!.needLeader, critical: proposal!.critical })
    } else {
      const [task] = await tx.select().from(todos).where(eq(todos.id, taskId)), [link] = await tx.select().from(projectTimelineTasks).where(eq(projectTimelineTasks.taskId, taskId))
      await tx.update(todos).set(change.action === 'retire' ? { status: '已取消', closureReason: change.reason, version: task.version + 1 } : { title: change.title, owner: change.ownerName, ownerUserId: change.ownerUserId!, dueDate: change.dueDate!, dueTime: change.dueTime!, deliverable: proposal!.deliverable, priority: proposal!.critical ? '高' : '中', version: task.version + 1, ...(change.action === 'restore' ? { status: '未开始', closureReason: null } : {}) }).where(eq(todos.id, taskId))
      await tx.update(projectTimelineTasks).set({ retired: change.action === 'retire', version: link.version + 1, ...(proposal ? { dueDate: proposal.dueDate, dueTime: proposal.dueTime, ownerUserId: change.ownerUserId!, needLeader: proposal.needLeader, critical: proposal.critical } : {}) }).where(eq(projectTimelineTasks.taskId, taskId))
      await reconcileTaskResponsibility(tx, taskId, userId, change.action === 'retire' ? 'cancel' : 'timeline', syncId)
    }
    recorded.push({ ...change, taskId })
  }
  const timeIssues = await syncTimelineLeaderTimes(tx, project, userId)
  await tx.insert(projectTimelineSyncs).values({ id: syncId, projectId: project.id, actorId: userId, approvalId, fingerprint: plan.fingerprint, changes: recorded, issues: timeIssues, status: timeIssues.length ? 'pending' : 'completed', ...event })
  // Older pending snapshots are not replayed. This current-state reconciliation resolves them.
  if (!timeIssues.length) await tx.update(projectTimelineSyncs).set({ status: 'resolved', resolvedBy: syncId }).where(and(eq(projectTimelineSyncs.projectId, project.id), eq(projectTimelineSyncs.status, 'pending'), notInArray(projectTimelineSyncs.source, ['weekly', 'type_execution'])))
  return { kind: 'timeline' as const, id: syncId, version: 1 }
}

export async function syncTimelineTasks(projectId: string, userId: string, raw: unknown) {
  const input = timelineSyncInput.parse(raw), hash = agentHash({ kind: 'timeline', projectId, userId, input })
  return agentTransaction(projectId, userId, async (tx, scope) => {
    if (!scope.canRun) return agentFail('TIMELINE_SYNC_FORBIDDEN', '仅项目负责人、推进秘书或有权领导可确认流程行动', 403)
    const replay = await replayAgentCommand(tx, projectId, userId, input.clientRequestId, hash); if (replay) return replay
    const plan = await preview(tx, scope.project)
    if (plan.fingerprint !== input.fingerprint) return agentFail('TIMELINE_SOURCE_CHANGED', '时间线、职责或任务已变化，请重新预览差异')
    return recordAgentCommand(tx, scope, input.clientRequestId, hash, await apply(tx, scope.project, userId, plan, null))
  })
}

// Called only inside the final date-approval transaction, after the effective date is written.
export async function syncApprovedTimelineTasks(tx: AgentTx, projectId: string, userId: string, approvalId: string) {
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId))
  return apply(tx, project, userId, await preview(tx, project), approvalId)
}

// Internal source-command hook only. Call after the authorized write while holding the project lock.
// Expected missing configuration is durable and visible; SQL/unexpected errors roll back the source command.
export async function reconcileTimelineEvent(tx: AgentTx, projectId: string, userId: string, event: { source: Exclude<TimelineSyncSource, 'manual'>; sourceKey: string; approvalId?: string }) {
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.workflowModel !== 'fde-v1') return
  await reconcileWeeklyLeaderTimes(tx, projectId, userId, `weekly:${event.sourceKey}`)
  await reconcileTypeLeaderTimes(tx, projectId, userId, `type:${event.sourceKey}`)
  if (project.projectType !== '投资项目') return
  if (project.lifecycle !== 'active') {
    await tx.update(projectTimelineSyncs).set({ status: 'closed' }).where(and(eq(projectTimelineSyncs.projectId, projectId), eq(projectTimelineSyncs.status, 'pending')))
    return
  }
  // Lead conversion and mere project-pool registration never generate downstream work.
  if (project.classification === 'pool') return
  const [existing] = await tx.select({ id: projectTimelineSyncs.id }).from(projectTimelineSyncs).where(and(eq(projectTimelineSyncs.projectId, projectId), eq(projectTimelineSyncs.sourceKey, event.sourceKey)))
  if (existing) return existing
  let plan: Omit<TimelinePreview, 'canSync'>
  try { plan = await preview(tx, project) }
  catch (cause) {
    if ((cause as { code?: string }).code !== 'TIMELINE_DATE_REQUIRED') throw cause
    plan = { fingerprint: agentHash({ projectId, version: project.version, event }), changes: [], issues: ['尚未配置有效的阶段及目标日期，请完善后同步流程行动'], stage: project.stage, date: '' }
  }
  const { source, sourceKey } = event
  if (!plan.issues.length) return apply(tx, project, userId, plan, event.approvalId ?? null, { source, sourceKey })
  const id = randomUUID()
  await tx.insert(projectTimelineSyncs).values({ id, projectId, actorId: userId, approvalId: event.approvalId ?? null, source, sourceKey, status: 'pending', fingerprint: plan.fingerprint, changes: [], issues: plan.issues })
  return { id }
}
