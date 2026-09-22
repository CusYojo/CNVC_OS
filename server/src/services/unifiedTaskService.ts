import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  projectDirectives, projectFiles, projectPlanActions, projectTimelineTasks,
  todoAcceptances, todoCalendarSchedules, todoFeedbackEvidence, todoFeedbacks,
  todos, users,
} from '../db/schema.js'
import {
  TASK_SOURCE_LABELS, TASK_STATUS_LABELS, normalizeTaskStatus, taskPrimaryAction,
  type UnifiedTask, type UnifiedTaskSource,
} from '../contracts/unifiedTaskContract.js'
import { getTodo } from './meetingService.js'
import { getFdeTasks } from './fdeTaskService.js'
import type { ProjectAccessActor } from './projectAccessService.js'

function sourceFor(task: typeof todos.$inferSelect, linked: { directive: boolean; timeline: boolean }): UnifiedTaskSource {
  if (task.approvalRequestId || task.type === '流程' || task.type === '审批') return 'approval'
  if (linked.directive) return 'directive'
  if (linked.timeline) return 'workflow'
  if (task.planActionId) return 'plan'
  if (task.meetingId) return 'meeting'
  if (!task.projectId) return 'personal'
  return 'project'
}

export async function getUnifiedTask(taskId: string, actor: ProjectAccessActor): Promise<UnifiedTask | null> {
  const base = await getTodo(taskId, actor)
  if (!base) return null

  const [directive, timeline, schedule, planAction] = await Promise.all([
    db.select({ id: projectDirectives.id }).from(projectDirectives).where(eq(projectDirectives.taskId, base.id)).limit(1).then(rows => rows[0]),
    db.select({ id: projectTimelineTasks.taskId }).from(projectTimelineTasks).where(eq(projectTimelineTasks.taskId, base.id)).limit(1).then(rows => rows[0]),
    db.select().from(todoCalendarSchedules).where(eq(todoCalendarSchedules.taskId, base.id)).limit(1).then(rows => rows[0]),
    base.planActionId
      ? db.select().from(projectPlanActions).where(eq(projectPlanActions.id, base.planActionId)).limit(1).then(rows => rows[0])
      : Promise.resolve(undefined),
  ])
  const participantIds = [...new Set([base.ownerUserId, ...(planAction?.participantUserIds ?? [])].filter((id): id is string => Boolean(id)))]
  const people = participantIds.length
    ? await db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(inArray(users.id, participantIds))
    : []
  const owner = people.find(person => person.id === base.ownerUserId) ?? { id: base.ownerUserId ?? '', name: base.owner || '待绑定', role: null }

  let richTask: Awaited<ReturnType<typeof getFdeTasks>>['tasks'][number] | undefined
  if (base.projectId && base.executionModel === 'fde-v1') {
    const projectTasks = await getFdeTasks(base.projectId, actor.uid)
    richTask = projectTasks.tasks.find(task => task.id === base.id)
  }
  const feedbackRows = await db.select().from(todoFeedbacks).where(eq(todoFeedbacks.todoId, base.id)).orderBy(asc(todoFeedbacks.submittedAt))
  const feedbackIds = feedbackRows.map(item => item.id)
  const [evidenceRows, acceptanceRows] = await Promise.all([
    feedbackIds.length ? db.select().from(todoFeedbackEvidence).where(inArray(todoFeedbackEvidence.feedbackId, feedbackIds)) : Promise.resolve([]),
    feedbackIds.length ? db.select().from(todoAcceptances).where(inArray(todoAcceptances.feedbackId, feedbackIds)) : Promise.resolve([]),
  ])
  const fileIds = [...new Set(evidenceRows.map(item => item.fileId))]
  const files = fileIds.length ? await db.select({ id: projectFiles.id, name: projectFiles.name }).from(projectFiles).where(inArray(projectFiles.id, fileIds)) : []
  const attachments = evidenceRows.map(item => ({ fileId: item.fileId, version: item.version, name: files.find(file => file.id === item.fileId)?.name ?? '项目文件' }))
  const feedbacks = feedbackRows.map(feedback => {
    const acceptance = acceptanceRows.find(item => item.feedbackId === feedback.id) ?? null
    return {
      id: feedback.id, kind: feedback.kind, progress: feedback.progress, result: feedback.result,
      blocker: feedback.blocker, estimatedDate: feedback.estimatedDate,
      submittedAt: feedback.submittedAt instanceof Date ? feedback.submittedAt.toISOString() : String(feedback.submittedAt),
      submittedBy: 'submittedBy' in feedback ? feedback.submittedBy : null,
      evidence: attachments.filter(item => evidenceRows.some(ref => ref.feedbackId === feedback.id && ref.fileId === item.fileId && ref.version === item.version)),
      acceptance: acceptance ? { decision: acceptance.decision, reason: acceptance.reason, acceptedAt: acceptance.decidedAt.toISOString() } : null,
    }
  })
  const latestAcceptance = feedbacks.map(item => item.acceptance).filter((item): item is NonNullable<typeof item> => Boolean(item)).at(-1) ?? null
  const source = sourceFor(base, { directive: Boolean(directive), timeline: Boolean(timeline) })
  const status = normalizeTaskStatus(base.status)
  const primary = taskPrimaryAction(status, source === 'approval')
  const capabilities = richTask?.capabilities
  const history = [
    { id: `created:${base.id}`, kind: 'created', title: '创建任务', detail: TASK_SOURCE_LABELS[source], createdAt: base.createdAt.toISOString() },
    ...feedbacks.map(item => ({ id: item.id, kind: item.kind, title: item.kind === 'submission' ? '提交成果' : '更新进度', detail: item.result, createdAt: item.submittedAt })),
    ...feedbacks.flatMap(item => item.acceptance ? [{ id: `acceptance:${item.id}`, kind: 'acceptance', title: item.acceptance.decision === 'accept' ? '验收通过' : '验收退回', detail: item.acceptance.reason, createdAt: item.acceptance.acceptedAt ?? item.submittedAt }] : []),
    ...(schedule ? [{ id: `calendar:${base.id}:${schedule.version}`, kind: 'calendar', title: schedule.hidden ? '移出时间轴' : '更新时间安排', detail: schedule.hidden ? '' : `${schedule.startsAt.toISOString()} — ${schedule.endsAt.toISOString()}`, createdAt: schedule.updatedAt.toISOString() }] : []),
  ].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))

  return {
    id: base.id, title: base.title, category: source === 'approval' ? 'approval' : source === 'personal' ? 'personal' : 'project',
    source, sourceLabel: TASK_SOURCE_LABELS[source], status, statusLabel: TASK_STATUS_LABELS[status], rawStatus: base.status,
    primaryAction: primary.key, primaryActionLabel: primary.label,
    approvalRequestId: base.approvalRequestId ?? null,
    project: base.projectId ? { id: base.projectId, name: base.projectName ?? '' } : null,
    owner, participants: people, startsAt: schedule && !schedule.hidden ? schedule.startsAt.toISOString() : null,
    dueDate: base.dueDate ?? null, dueTime: base.dueTime ?? null, deliverable: base.deliverable ?? null,
    progress: base.progress, feedbacks, attachments, acceptance: latestAcceptance,
    calendar: schedule ? { startsAt: schedule.startsAt.toISOString(), endsAt: schedule.endsAt.toISOString(), hidden: schedule.hidden, version: schedule.version } : null,
    version: base.version, history,
    capabilities: {
      canStart: Boolean(capabilities?.canFeedback && status === 'not_started'),
      canSubmit: Boolean(capabilities?.canFeedback && ['in_progress', 'returned', 'not_started'].includes(status)),
      canAccept: Boolean(capabilities?.canAccept), canFeedback: Boolean(capabilities?.canFeedback),
      canExtend: Boolean(capabilities?.canExtend), canCancel: Boolean(capabilities?.canCancel),
      canEditParticipants: false,
    },
  }
}
