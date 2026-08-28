import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { fdeTypeInstances, leaderTimeRequests, projectDutyAssignments, projectPlanActions, projectPlans, projectTimelineSyncs, projectTimelineTasks, projectWeeklyPlanItems, projectWeeklyPlans, projects, roles, todos, userRoles, users } from '../db/schema.js'
import { taskTerminal } from '../contracts/fdeTaskContract.js'
import { timelineLeaderDuties, timelineLeaderSlots, type TimelineTimeSourceView } from '../contracts/fdeTimelineTimeContract.js'
import { timeInstant, timeLocal, timeTerminal } from '../contracts/fdeTimeContract.js'
import { weekStartFor } from '../contracts/fdeWeeklyPlanContract.js'
import { projectAccessCondition } from './projectAccessService.js'
import { recordTimeEvent, timeHash } from './fdeTimeEventsService.js'
import type { TimeReader, TimeTx } from './fdeTimeAccessService.js'
import { timeFail } from './fdeTimeAccessService.js'
import { policyHash } from './fdeWorkflowPolicyService.js'

type Project = typeof projects.$inferSelect
type Task = typeof todos.$inferSelect
type Request = typeof leaderTimeRequests.$inferSelect
type SourceKind = 'timeline' | 'weekly' | 'type_execution'
type Source = { task: Task; id: string; stage: string; needLeader: boolean; retired: boolean; requestorId?: string }
const sourceId = (row: Request) => row.sourceTypeActionId ?? row.sourceWeeklyItemId ?? row.sourceTimelineTaskId
const sourceColumn = (kind: SourceKind) => kind === 'type_execution' ? leaderTimeRequests.sourceTypeActionId : kind === 'weekly' ? leaderTimeRequests.sourceWeeklyItemId : leaderTimeRequests.sourceTimelineTaskId

async function leadersFor(reader: TimeReader, projectId: string, stage: string, weeklyProject?: Project) {
  const duties: Array<'concerned_leader' | 'chairman' | 'president' | 'executive_lead'> = weeklyProject?.projectType !== undefined && weeklyProject.projectType !== '投资项目' ? ['executive_lead'] : timelineLeaderDuties(stage)
  const leaders = new Set<string>(), issues: string[] = []
  if (weeklyProject && !duties.length) issues.push(`${stage || '未确定阶段'}没有有效的领导参与规则，请先核对来源阶段及职责`)
  if (!duties.length) return { leaders: [], issues }
  const bindings = await reader.select().from(projectDutyAssignments).where(eq(projectDutyAssignments.projectId, projectId))
  const people = await reader.select({ id: users.id, name: users.name, role: users.role, code: roles.code }).from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id)).innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(users.status, '启用'), eq(roles.status, '启用'), eq(roles.fdeCategory, 'institution_leader'))).orderBy(asc(users.id))
  for (const duty of duties) {
    const code = duty === 'chairman' ? 'FDE_CHAIRMAN' : duty === 'president' ? 'FDE_PRESIDENT' : null
    const assigned = bindings.filter(item => item.duty === duty)
    if (duty === 'executive_lead' && (assigned.length !== 1 || !bindings.some(item => item.duty === 'concerned_leader' && item.userId === assigned[0].userId))) {
      issues.push(`${stage}领导时间：请配置唯一且同时属于关注领导的有效牵头领导`)
      continue
    }
    const ids = [...new Set(assigned.length ? assigned.map(item => item.userId) : code ? people.filter(item => item.code === code).map(item => item.id) : [])]
    let invalid = !ids.length
    for (const id of ids) {
      const person = people.find(item => item.id === id && (!code || item.code === code))
      if (!person) { invalid = true; continue }
      const [visible] = await reader.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), projectAccessCondition({ uid: id, name: person.name, role: person.role })))
      if (!visible) { invalid = true; continue }
      leaders.add(id)
    }
    if (invalid) issues.push(`${stage}领导时间：请配置启用、岗位资格及项目权限有效的${{ concerned_leader: '关注领导', chairman: '董事长', president: '总裁', executive_lead: '牵头领导' }[duty]}`)
  }
  return { leaders: [...leaders].sort(), issues }
}

async function sources(reader: TimeReader, projectId: string, kind: SourceKind): Promise<Source[]> {
  if (kind === 'type_execution') {
    const [instance] = await reader.select().from(fdeTypeInstances).where(eq(fdeTypeInstances.projectId, projectId))
    if (!instance?.planId) return []
    const [plan] = await reader.select().from(projectPlans).where(and(eq(projectPlans.id, instance.planId), eq(projectPlans.projectId, projectId)))
    const [project] = await reader.select().from(projects).where(eq(projects.id, projectId))
    if (!plan || plan.executionKind !== 'noninvestment' || !project || project.projectType === '投资项目' || project.workflowPolicyVersionId !== instance.policyVersionId
      || instance.plan.binding.projectId !== projectId || instance.plan.binding.policyVersionId !== instance.policyVersionId || policyHash(instance.plan) !== instance.planHash) return timeFail('TIME_TYPE_SOURCE_INTEGRITY', '非投资计划来源或绑定版本不一致，请先核对执行实例')
    const rows = await reader.select({ task: todos, action: projectPlanActions }).from(projectPlanActions).innerJoin(todos, eq(todos.planActionId, projectPlanActions.id))
      .where(and(eq(projectPlanActions.planId, plan.id), eq(todos.projectId, projectId))).orderBy(asc(projectPlanActions.id))
    if (rows.length !== instance.plan.actions.length) return timeFail('TIME_TYPE_SOURCE_INTEGRITY', '已批准计划行动与正式任务数量不一致，不能遗漏领导需求')
    return rows.map(({ task, action }) => {
      const definition = instance.plan.actions.find(a => a.key === action.actionKey)
      if (!definition) return timeFail('TIME_TYPE_SOURCE_INTEGRITY', '正式行动不属于绑定的非投资计划')
      const stage = instance.plan.configuration.stages.find(s => s.key === definition.stageKey)
      if (!stage) return timeFail('TIME_TYPE_SOURCE_INTEGRITY', '非投资行动阶段不存在')
      return { task, id: action.id, stage: stage.name, needLeader: definition.needLeader, retired: plan.status !== 'locked' || !['active', 'stage_review'].includes(instance.status), requestorId: plan.createdBy }
    })
  }
  if (kind === 'timeline') {
    const rows = await reader.select({ task: todos, link: projectTimelineTasks }).from(projectTimelineTasks).innerJoin(todos, eq(todos.id, projectTimelineTasks.taskId)).where(eq(projectTimelineTasks.projectId, projectId)).orderBy(asc(projectTimelineTasks.taskId))
    return rows.map(({ task, link }) => ({ task, id: link.taskId, stage: link.stage, needLeader: link.needLeader, retired: link.retired }))
  }
  const rows = await reader.select({ task: todos, item: projectWeeklyPlanItems, plan: projectWeeklyPlans }).from(projectWeeklyPlanItems)
    .innerJoin(projectWeeklyPlans, eq(projectWeeklyPlans.id, projectWeeklyPlanItems.planId)).innerJoin(todos, eq(todos.id, projectWeeklyPlanItems.taskId))
    .where(and(eq(projectWeeklyPlans.projectId, projectId), eq(todos.projectId, projectId), eq(projectWeeklyPlanItems.sourceKind, 'manual'))).orderBy(asc(projectWeeklyPlanItems.id))
  return rows.map(({ task, item, plan }) => ({ task, id: item.id, stage: item.sourceStage ?? '', needLeader: item.needLeader, retired: plan.status !== 'published', requestorId: plan.publishedBy ?? plan.createdBy }))
}

function sourceDefinition(project: Project, task: Task, leaderId: string) {
  if (!task.dueDate || !task.dueTime) return null
  const slots = timelineLeaderSlots(project.id, task.id, leaderId, task.dueDate, task.dueTime)
  const fingerprint = timeHash({ taskId: task.id, title: task.title, outcome: task.deliverable, ownerId: task.ownerUserId, deadline: slots.latestFinish, leaderId })
  return { fingerprint, slots, title: task.title, outcome: task.deliverable || '形成可追溯阶段意见' }
}

// Read-only projection also guards mutations: a role/task change cannot leave a stale request confirmable.
export async function readTimelineTimeSource(reader: TimeReader, row: Request) {
  if (!row.sourceTimelineTaskId && !row.sourceWeeklyItemId && !row.sourceTypeActionId) return null
  const kind: SourceKind = row.sourceTypeActionId ? 'type_execution' : row.sourceWeeklyItemId ? 'weekly' : 'timeline'
  const [project] = await reader.select().from(projects).where(eq(projects.id, row.projectId))
  const source = (await sources(reader, row.projectId, kind)).find(item => item.id === sourceId(row) && item.task.id === row.taskId)
  const inactive = !source || !project || project.lifecycle !== 'active' || project.classification === 'pool' || source.retired || !source.needLeader || taskTerminal(source.task.status)
  let reason = inactive ? '来源行动已结束或不再需要领导参与，请按原权限撤回需求或取消已确认排期' : ''
  const roster = source && !inactive ? await leadersFor(reader, row.projectId, source.stage, kind !== 'timeline' ? project : undefined) : null
  if (roster && !roster.leaders.includes(row.leaderId)) reason = '领导参与规则、岗位或项目权限已变化，请核对并撤回或取消原需求'
  const definition = source && !reason ? sourceDefinition(project, source.task, row.leaderId) : null
  if (!reason && !definition) reason = '来源行动缺少有效截止时间，请先完善来源'
  const needed = !reason, changed = !needed || definition!.fingerprint !== row.sourceFingerprint
  const view: TimelineTimeSourceView = { needed, changed, reason: reason || (changed ? '来源行动的期限、职责或交付内容已变化；请核对来源，已确认安排须重新确认' : `由${kind === 'type_execution' ? '已批准非投资计划' : kind === 'weekly' ? '已发布周计划' : '流程'}行动自动生成；仍需指定领导确认`), deadline: definition?.slots.latestFinish ?? null, ...(kind !== 'timeline' ? { kind } : {}) }
  return { view, definition }
}

// Read-only preflight for an overall replan. It must not silently create missing
// leaders or replace a changed roster outside the approved impact list.
export async function inspectReplanLeaderSources(reader: TimeReader, project: Project, taskIds: readonly string[]) {
  const issues: string[] = [], fingerprints: unknown[] = []
  for (const kind of ['timeline', 'weekly'] as const) {
    const links = (await sources(reader, project.id, kind)).filter(s => taskIds.includes(s.task.id) && s.needLeader && !s.retired && !taskTerminal(s.task.status))
    const rows = (await reader.select().from(leaderTimeRequests).where(and(eq(leaderTimeRequests.projectId, project.id), isNotNull(sourceColumn(kind))))).filter(r => r.taskId && taskIds.includes(r.taskId))
    for (const link of links) {
      const roster = await leadersFor(reader, project.id, link.stage, kind === 'weekly' ? project : undefined)
      issues.push(...roster.issues)
      const bound = rows.filter(r => sourceId(r) === link.id)
      if (roster.leaders.some(id => !bound.some(r => r.leaderId === id)) || bound.some(r => !roster.leaders.includes(r.leaderId))) issues.push('领导需求与当前职责不完整一致，请先完成原来源对账，再重新预览整体重排')
      for (const row of bound) if ((await readTimelineTimeSource(reader, row))?.view.changed) issues.push('领导需求来源已变化，请先按原权限核对，再重新预览整体重排')
      fingerprints.push({ kind, sourceId: link.id, roster })
    }
  }
  return { issues: [...new Set(issues)], fingerprints }
}

// Caller has authorized the source command and holds the project lock. No separate transaction or worker.
export async function syncTimelineLeaderTimes(tx: TimeTx, project: Project, actorId: string, kind: SourceKind = 'timeline', onlyTaskIds?: readonly string[]) {
  const links = (await sources(tx, project.id, kind)).filter(row => !onlyTaskIds || onlyTaskIds.includes(row.task.id))
  const rows = (await tx.select().from(leaderTimeRequests).where(and(eq(leaderTimeRequests.projectId, project.id), isNotNull(sourceColumn(kind)))).orderBy(asc(leaderTimeRequests.id)))
    .filter(row => !onlyTaskIds || Boolean(row.taskId && onlyTaskIds.includes(row.taskId)))
  const expected = new Map<string, { task: Task; sourceId: string; requestorId?: string; leaderId: string; definition: NonNullable<ReturnType<typeof sourceDefinition>> }>(), issues: string[] = []
  if (kind === 'weekly' && project.classification === 'pool' && links.some(link => link.needLeader && !link.retired && !taskTerminal(link.task.status))) issues.push('项目仍在项目池，请完成初筛后核对人工周计划领导需求')
  const rosters = new Map<string, Awaited<ReturnType<typeof leadersFor>>>()
  if (project.lifecycle === 'active' && project.classification !== 'pool') for (const link of links) {
    const { task } = link
    if (link.retired || !link.needLeader || taskTerminal(task.status)) continue
    if (!rosters.has(link.stage)) rosters.set(link.stage, await leadersFor(tx, project.id, link.stage, kind !== 'timeline' ? project : undefined))
    const roster = rosters.get(link.stage)!
    issues.push(...roster.issues)
    for (const leaderId of roster.leaders) {
      const definition = sourceDefinition(project, task, leaderId)
      if (definition) expected.set(`${link.id}:${leaderId}`, { task, sourceId: link.id, requestorId: link.requestorId, leaderId, definition })
      else issues.push(`${task.title}：领导时间缺少有效来源期限`)
    }
  }
  for (const id of [...new Set([...rows.map(row => row.leaderId), ...[...expected.values()].map(item => item.leaderId)])].sort()) await tx.execute(sql`SELECT ${users.id} FROM ${users} WHERE ${users.id}=${id} FOR UPDATE`)
  for (const item of expected.values()) {
    const { task, sourceId: originId, requestorId, leaderId, definition } = item, row = rows.find(value => sourceId(value) === originId && value.leaderId === leaderId)
    // Manual coordination, refusal, cancellation, confirmation or edits are never silently overwritten/reopened.
    if (row && (row.version !== row.sourceVersion || row.status === 'confirmed' || timeTerminal(row.status) && !row.sourceRetired)) continue
    if (row && !row.sourceRetired && row.sourceFingerprint === definition.fingerprint) continue
    const id = row?.id ?? randomUUID(), version = (row?.version ?? 0) + 1
    const patch = { title: definition.title, outcome: definition.outcome, preferredStart: timeInstant(definition.slots.preferredStart), alternativeStart: timeInstant(definition.slots.alternativeStart), latestFinish: timeInstant(definition.slots.latestFinish), scheduledStart: timeInstant(definition.slots.preferredStart), durationMinutes: definition.slots.durationMinutes, status: 'requested', version, sourceVersion: version, sourceFingerprint: definition.fingerprint, sourceRetired: false, closureReason: null }
    if (row) await tx.update(leaderTimeRequests).set(patch).where(eq(leaderTimeRequests.id, id))
    else await tx.insert(leaderTimeRequests).values({ ...patch, id, projectId: project.id, taskId: task.id, ...(kind === 'type_execution' ? { sourceTypeActionId: originId } : kind === 'weekly' ? { sourceWeeklyItemId: originId } : { sourceTimelineTaskId: originId }), leaderId, submittedBy: requestorId ?? task.ownerUserId ?? actorId, reason: kind === 'type_execution' ? '独立审核通过的非投资计划行动要求领导参与，按当前有效牵头领导职责生成需求' : kind === 'weekly' ? '已发布周计划的人工行动明确要求领导参与，按来源阶段及有效职责生成需求' : '该流程行动由项目时间线倒推，按有效阶段参与职责生成领导时间需求', impact: '延后可能影响当前阶段里程碑，请核对地点和预期结果', priority: 'P2', location: '待确认' })
    await recordTimeEvent(tx, id, actorId, `${kind}-${row ? row.sourceRetired ? 'restore' : 'update' : 'create'}`, '正式来源对账；仅生成申请或更新未经人工处理的需求，不代表领导确认')
  }
  for (const row of rows) {
    if (expected.has(`${sourceId(row)}:${row.leaderId}`) || timeTerminal(row.status) || row.version !== row.sourceVersion || row.status === 'confirmed') continue
    const version = row.version + 1
    await tx.update(leaderTimeRequests).set({ status: 'withdrawn', sourceRetired: true, version, sourceVersion: version, closureReason: '来源行动结束或领导参与规则变化，自动撤回未经人工处理的需求' }).where(eq(leaderTimeRequests.id, row.id))
    await recordTimeEvent(tx, row.id, actorId, `${kind}-retire`, '自动撤回未处理的来源时间需求；保留来源、历史和原 ID')
  }
  return [...new Set(issues)]
}

// Uses the approved plan's stable action ID; never fabricates an investment or weekly source.
export async function reconcileTypeLeaderTimes(tx: TimeTx, projectId: string, actorId: string, sourceKey: string) {
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.workflowModel !== 'fde-v1' || project.projectType === '投资项目') return
  const linked = await sources(tx, projectId, 'type_execution')
  if (!linked.some(item => item.needLeader)) return
  const [existing] = await tx.select().from(projectTimelineSyncs).where(and(eq(projectTimelineSyncs.projectId, projectId), eq(projectTimelineSyncs.sourceKey, sourceKey)))
  if (existing) return
  const issues = await syncTimelineLeaderTimes(tx, project, actorId, 'type_execution'), id = randomUUID()
  await tx.insert(projectTimelineSyncs).values({ id, projectId, actorId, source: 'type_execution', sourceKey, fingerprint: timeHash({ sourceKey, issues }), changes: [], issues, status: issues.length ? 'pending' : 'completed' })
  if (!issues.length) await tx.update(projectTimelineSyncs).set({ status: 'resolved', resolvedBy: id }).where(and(eq(projectTimelineSyncs.projectId, projectId), eq(projectTimelineSyncs.source, 'type_execution'), eq(projectTimelineSyncs.status, 'pending')))
}

// Caller has already authorized project access. Reading never generates requests or resolves journals.
export async function readTypeLeaderTimes(reader: TimeReader, project: Project) {
  const links = await sources(reader, project.id, 'type_execution'), issues: string[] = []
  if (project.lifecycle === 'active') for (const link of links.filter(l => l.needLeader && !l.retired && !taskTerminal(l.task.status))) {
    const roster = await leadersFor(reader, project.id, link.stage, project)
    issues.push(...roster.issues)
    if (!link.task.dueDate || !link.task.dueTime) issues.push(`${link.task.title}：来源缺少有效截止时刻`)
  }
  const rows = await reader.select({ row: leaderTimeRequests, leaderName: users.name }).from(leaderTimeRequests).innerJoin(users, eq(users.id, leaderTimeRequests.leaderId))
    .where(and(eq(leaderTimeRequests.projectId, project.id), isNotNull(leaderTimeRequests.sourceTypeActionId))).orderBy(asc(leaderTimeRequests.id))
  const requests = []
  for (const { row, leaderName } of rows) {
    const source = await readTimelineTimeSource(reader, row)
    requests.push({ id: row.id, taskId: row.taskId, leaderName, status: row.status, changed: Boolean(source?.view.changed), reason: source?.view.reason ?? '', target: `/collaboration?view=time&week=${weekStartFor(timeLocal(row.scheduledStart ?? row.preferredStart).slice(0, 10))}&request=${row.id}` })
  }
  return { issues: [...new Set(issues)], requests }
}

// Separate weekly-source journal: missing investment timeline configuration must
// not prevent a published manual action from following its own task deadline.
export async function reconcileWeeklyLeaderTimes(tx: TimeTx, projectId: string, actorId: string, sourceKey: string) {
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.workflowModel !== 'fde-v1') return
  const linked = await sources(tx, projectId, 'weekly')
  if (!linked.some(item => item.needLeader)) return
  const [existing] = await tx.select().from(projectTimelineSyncs).where(and(eq(projectTimelineSyncs.projectId, projectId), eq(projectTimelineSyncs.sourceKey, sourceKey)))
  if (existing) return
  const issues = await syncTimelineLeaderTimes(tx, project, actorId, 'weekly'), id = randomUUID()
  await tx.insert(projectTimelineSyncs).values({ id, projectId, actorId, source: 'weekly', sourceKey, fingerprint: timeHash({ sourceKey, issues }), changes: [], issues, status: issues.length ? 'pending' : 'completed' })
  if (!issues.length) await tx.update(projectTimelineSyncs).set({ status: 'resolved', resolvedBy: id }).where(and(eq(projectTimelineSyncs.projectId, projectId), eq(projectTimelineSyncs.source, 'weekly'), eq(projectTimelineSyncs.status, 'pending')))
}
