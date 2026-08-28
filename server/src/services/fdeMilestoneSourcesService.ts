import { and, asc, eq, gte, inArray, lt, ne, or } from 'drizzle-orm'
import { replanHash } from '../utils/fdeProjectReplanHash.js'
import { db } from '../db/client.js'
import { oaApprovalRequests, projectAgentScheduleRequests, projectDutyAssignments, projectReplanRequests, projectStageDates, projects, users } from '../db/schema.js'
import { fdeWeekStart, shiftDate } from '../contracts/fdeWeeklyPlanContract.js'
import { agentDate } from '../contracts/fdeProjectAgentContract.js'
import type { ApprovedMilestoneFact } from '../contracts/fdeMilestoneSourcesContract.js'
import { projectAccessCondition } from './projectAccessService.js'
import { projectFileWorkspaceCondition } from './projectFileAccessService.js'

type Reader = Pick<typeof db, 'select'>
const fail = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }) }
async function actor(reader: Reader, userId: string) {
  const [user] = await reader.select().from(users).where(and(eq(users.id, userId), eq(users.status, '启用')))
  if (!user) return fail('MILESTONE_ACTOR_UNAVAILABLE', '当前账号不可用', 403)
  return user
}

// Reads the effective date AND its final approved source; no GET writes, fallback
// dates, task copies or calendar occupancy. Report mode also includes approvals
// completed during the week, even when the planned date is in a later week.
export async function collectApprovedMilestones(reader: Reader, userId: string, week: string, options: { projectIds?: string[]; personal?: boolean; report?: boolean } = {}): Promise<ApprovedMilestoneFact[]> {
  fdeWeekStart.parse(week)
  const user = await actor(reader, userId), next = shiftDate(week, 7)
  if (options.projectIds?.length === 0) return []
  const responsible = reader.select({ id: projectDutyAssignments.projectId }).from(projectDutyAssignments).where(and(eq(projectDutyAssignments.userId, userId), eq(projectDutyAssignments.duty, 'secretary')))
  const rows = await reader.select({ date: projectStageDates, request: oaApprovalRequests, schedule: projectAgentScheduleRequests, replan: projectReplanRequests, project: projects }).from(projectStageDates)
    .innerJoin(projects, eq(projects.id, projectStageDates.projectId))
    .innerJoin(oaApprovalRequests, eq(oaApprovalRequests.id, projectStageDates.approvalId))
    .leftJoin(projectAgentScheduleRequests, eq(projectAgentScheduleRequests.requestId, projectStageDates.approvalId))
    .leftJoin(projectReplanRequests, eq(projectReplanRequests.requestId, projectStageDates.approvalId))
    .where(and(eq(projects.workflowModel, 'fde-v1'), options.report ? ne(projects.lifecycle, 'deleted') : eq(projects.lifecycle, 'active'),
      projectAccessCondition({ uid: userId, name: user.name, role: user.role }),
      or(ne(oaApprovalRequests.businessType, 'project_replan'), projectFileWorkspaceCondition(userId)),
      options.projectIds ? inArray(projects.id, options.projectIds) : undefined,
      options.personal ? or(eq(projects.ownerUserId, userId), inArray(projects.id, responsible)) : undefined,
      or(and(gte(projectStageDates.plannedDate, week), lt(projectStageDates.plannedDate, next)), options.report ? and(gte(oaApprovalRequests.completedAt, new Date(`${week}T00:00:00+08:00`)), lt(oaApprovalRequests.completedAt, new Date(`${next}T00:00:00+08:00`))) : undefined),
    )).orderBy(asc(projectStageDates.projectId), asc(projectStageDates.stage), asc(projectStageDates.id)).limit(501)
  if (rows.length > 500) return fail('MILESTONE_SOURCE_LIMIT', '节点日期超过单次容量，请缩小范围；不会静默截断')
  return rows.flatMap<ApprovedMilestoneFact>(({ date, request, schedule, replan, project }) => {
    if (request.businessType === 'project_replan') {
      const change = replan?.impact.stages.find(s => s.id === date.stage)
      if (!replan || replan.projectId !== project.id || request.projectId !== project.id || request.businessPayload.impactHash !== replanHash(replan.impact) || request.status !== '已通过' || !request.completedAt || !change || change.after !== date.plannedDate || !agentDate.safeParse(change.before).success || !agentDate.safeParse(change.after).success) return fail('MILESTONE_SOURCE_INVALID', '节点日期与整体重排批准来源不一致')
      // Freezing a historical projection is preservation, not a newly changed
      // milestone. Do not report a kept date as a fresh schedule achievement.
      if (change.action === 'keep') return []
      return { id: date.id, projectId: project.id, projectName: project.name, stage: date.stage, date: date.plannedDate, version: date.version, approvalId: request.id, previousDate: change.before!, approvedAt: request.completedAt.toISOString(), ownerId: project.ownerUserId, ownerName: project.owner, sourceKind: 'replan' as const }
    }
    if (!schedule || request.businessType !== 'agent_schedule' || request.status !== '已通过' || !request.completedAt || request.projectId !== project.id || schedule.projectId !== project.id || schedule.stage !== date.stage || schedule.requestedDate !== date.plannedDate || !agentDate.safeParse(date.plannedDate).success || !agentDate.safeParse(schedule.previousDate).success) return fail('MILESTONE_SOURCE_INVALID', '节点日期与正式批准来源不一致，请核查；未展示不可靠日期')
    return { id: date.id, projectId: project.id, projectName: project.name, stage: date.stage, date: date.plannedDate, version: date.version,
      approvalId: request.id, previousDate: schedule.previousDate, approvedAt: request.completedAt.toISOString(), ownerId: project.ownerUserId, ownerName: project.owner }
  })
}

// Published facts remain historical after a later approved date replaces the head.
// They still require the original approval identity and current project access.
export async function canReadMilestoneSnapshot(reader: Reader, item: ApprovedMilestoneFact, userId: string) {
  const user = await actor(reader, userId)
  if (item.sourceKind === 'replan') {
    const [row] = await reader.select({ date: projectStageDates, request: oaApprovalRequests, replan: projectReplanRequests }).from(projectStageDates)
      .innerJoin(projects, eq(projects.id, projectStageDates.projectId)).innerJoin(projectReplanRequests, eq(projectReplanRequests.requestId, item.approvalId))
      .innerJoin(oaApprovalRequests, eq(oaApprovalRequests.id, projectReplanRequests.requestId))
      .where(and(eq(projectStageDates.id, item.id), eq(projects.id, item.projectId), projectAccessCondition({ uid: userId, name: user.name, role: user.role }), projectFileWorkspaceCondition(userId)))
    const change = row?.replan.impact.stages.find(s => s.id === item.stage)
    return Boolean(row && row.date.stage === item.stage && row.date.version >= item.version && row.request.projectId === item.projectId && row.replan.projectId === item.projectId && row.request.businessPayload.impactHash === replanHash(row.replan.impact) && row.request.businessType === 'project_replan' && row.request.status === '已通过' && row.request.completedAt?.toISOString() === item.approvedAt && change?.before === item.previousDate && change.after === item.date)
  }
  const [row] = await reader.select({ date: projectStageDates, request: oaApprovalRequests, schedule: projectAgentScheduleRequests }).from(projectStageDates)
    .innerJoin(projects, eq(projects.id, projectStageDates.projectId))
    .innerJoin(projectAgentScheduleRequests, eq(projectAgentScheduleRequests.requestId, item.approvalId))
    .innerJoin(oaApprovalRequests, eq(oaApprovalRequests.id, projectAgentScheduleRequests.requestId))
    .where(and(eq(projectStageDates.id, item.id), eq(projects.id, item.projectId), projectAccessCondition({ uid: userId, name: user.name, role: user.role })))
  return Boolean(row && row.date.stage === item.stage && row.date.version >= item.version && row.request.projectId === item.projectId && row.request.businessType === 'agent_schedule' && row.request.status === '已通过' && row.request.completedAt?.toISOString() === item.approvedAt && row.schedule.projectId === item.projectId && row.schedule.stage === item.stage && row.schedule.requestedDate === item.date && row.schedule.previousDate === item.previousDate)
}
