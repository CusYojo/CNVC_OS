import { shiftDate, shanghaiToday, weekStartFor } from '../../server/src/contracts/fdeWeeklyPlanContract'

export type CollaborationTask = {
  id: string; title: string; owner: string; ownerUserId: string; dueDate: string | null; dueTime: string | null
  status: string; executionModel: string; directiveId: string | null; planActionId: string | null
  timelineSource: { needLeader: boolean; stage: string } | null
  feedbacks: Array<{ blocker: string }>; extensions: Array<{ status: string }>
  capabilities: { canFeedback: boolean; canAccept: boolean; canExtend: boolean; canCancel: boolean }
}
export type CollaborationAction = CollaborationTask & { projectId: string; projectName: string; projectType: string; needLeader: boolean; leaderLinked: boolean }
export type CollaborationGroup = 'project' | 'person' | 'date'
export const collaborationTabs = [['weekly', '本周工作'], ['calendar', '日历'], ['review', '周报与例会']] as const
export function collaborationView(value: string | null) {
  if (value === 'time' || value === 'calendar') return 'calendar'
  if (['reports', 'friday', 'review', 'committee', 'meetings'].includes(value ?? '')) return 'review'
  return 'weekly'
}
const closed = (status: string) => ['已完成', '已关闭', '已取消'].includes(status)
export function weeklyActions(actions: CollaborationAction[], week: string, group: CollaborationGroup, today = shanghaiToday()) {
  const next = shiftDate(week, 7)
  return actions.filter(item => item.executionModel !== 'approval' && !['已关闭', '已取消'].includes(item.status) && Boolean(item.dueDate) && (
    item.dueDate! >= week && item.dueDate! < next || week === weekStartFor(today) && item.dueDate! < week && !closed(item.status)
  )).sort((a, b) => {
    const key = (item: CollaborationAction) => group === 'person' ? `${item.owner}:${item.ownerUserId}` : group === 'date' ? `${item.dueDate ?? ''}:${item.dueTime ?? '23:59'}` : `${item.projectName}:${item.projectId}`
    return key(a).localeCompare(key(b), 'zh-CN') || `${a.dueDate}:${a.dueTime ?? '23:59'}`.localeCompare(`${b.dueDate}:${b.dueTime ?? '23:59'}`) || a.id.localeCompare(b.id)
  })
}
export function weeklySummary(items: CollaborationAction[], today = shanghaiToday()) {
  return { total: items.length, completed: items.filter(item => item.status === '已完成').length,
    urgent: items.filter(item => !closed(item.status) && (item.dueDate! <= today || Boolean(item.feedbacks[0]?.blocker))).length,
    leaders: items.filter(item => item.needLeader).length, linked: items.filter(item => item.needLeader && item.leaderLinked).length,
    timeline: items.filter(item => item.timelineSource || item.planActionId).length }
}

// Bound request fan-out; a failed project is never silently represented as zero work.
export async function mapCollaborationProjects<T, R>(items: T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (index < items.length) { const current = index++; results[current] = await read(items[current]) }
  }))
  return results
}
