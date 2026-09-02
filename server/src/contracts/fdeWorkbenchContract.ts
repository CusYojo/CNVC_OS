import { shiftDate } from './fdeWeeklyPlanContract.js'

export type WorkbenchView = 'leader' | 'lead' | 'secretary' | 'member' | 'specialist' | 'coordinator' | 'admin' | 'unassigned'
export type WorkbenchTone = 'info' | 'success' | 'warning' | 'danger' | 'purple' | 'neutral'
export type WorkbenchMetric = { label: string; value: number | string | null; note: string; tone: WorkbenchTone; to: string }
export type WorkbenchAction = { id: string; projectId: string | null; projectName: string; title: string; ownerUserId: string | null; dueDate: string | null; status: string; to: string }
export type WorkbenchProject = { id: string; name: string; owner: string; ownerUserId: string | null; secretary: string; classification: string; health: string; priority: string; targetDate: string | null; stage: string; stageSource: string | null; updatedAt: string; related: boolean; secretaryId: string | null; actions: WorkbenchAction[]; done: number; total: number; leaderParticipation: string | null }
export type WorkbenchAttention = { id: string; title: string; detail: string; icon: string; to: string; status?: string }
export type WorkbenchData = {
  actorId: string; name: string; view: WorkbenchView; perspective: string; specialty: string; asOf: string; today: string; weekStart: string
  metrics: WorkbenchMetric[]; projects: WorkbenchProject[]; actions: WorkbenchAction[]; attention: WorkbenchAttention[]
  capacity: { requested: number; confirmed: number; pending: number; conflicts: number } | null
  warnings: string[]
}

// Role names are display-only. A view never grants business access.
export function workbenchView(bindings: { category: string | null; primary?: boolean }[]): WorkbenchView {
  const map: Record<string, WorkbenchView> = { institution_leader: 'leader', project_lead: 'lead', secretary: 'secretary', member: 'member', specialist: 'specialist', coordinator: 'coordinator', system_admin: 'admin' }
  const known = bindings.filter(b => b.category && map[b.category])
  const business = known.filter(b => b.category !== 'system_admin')
  const selected = [...(business.length ? business : known)].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))[0]
  return selected?.category ? map[selected.category] : 'unassigned'
}

export const workbenchTaskOpen = (status: string) => !['已完成', '已关闭', '已取消', '已归档'].includes(status)
export function workbenchActions<T extends WorkbenchAction>(rows: T[], today: string) {
  const lastDay = shiftDate(today, 3)
  return rows
    .filter(t => workbenchTaskOpen(t.status) && Boolean(t.dueDate) && t.dueDate! >= today && t.dueDate! <= lastDay)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.id.localeCompare(b.id))
}
export function workbenchProjectRank(rows: WorkbenchProject[]) {
  const health: Record<string, number> = { 已停滞: 0, 紧急抢救: 0, 存在风险: 1, 需关注: 2, 正常: 3 }
  const priority: Record<string, number> = { P0: 0, P1: 1, 高: 1, P2: 2, 中: 2, P3: 3, 低: 3 }
  return rows.filter(p => p.classification === 'key').sort((a, b) => (health[a.health] ?? 4) - (health[b.health] ?? 4) || (priority[a.priority] ?? 4) - (priority[b.priority] ?? 4) || a.id.localeCompare(b.id)).slice(0, 8)
}
export function workbenchActionCounts(rows: WorkbenchAction[], actorId: string, today: string) {
  const own = rows.filter(t => t.ownerUserId === actorId && workbenchTaskOpen(t.status))
  return { own, count: own.length, dueToday: own.filter(t => t.dueDate === today).length, dueSoon: own.filter(t => t.dueDate && t.dueDate >= today && t.dueDate <= shiftDate(today, 2)).length }
}
export function workbenchTone(status: string): WorkbenchTone {
  if (['已完成', '已确认', '正常', 'confirmed'].includes(status)) return 'success'
  if (['存在风险', '已停滞', '紧急抢救', '已逾期', '已退回'].includes(status)) return 'danger'
  if (['进行中', '审批中', '处理中'].includes(status)) return 'info'
  if (['需关注', '待确认', '待处理', '临期', '待验收', 'pending', 'requested', 'supplement'].includes(status)) return 'warning'
  return 'neutral'
}
export function workbenchTargetLabel(date: string | null, today: string) {
  if (!date) return '未配置目标日'
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000)
  return !Number.isFinite(days) ? '日期待核对' : days < 0 ? `已逾期 ${-days} 天` : days === 0 ? '今天到期' : `剩余 ${days} 天`
}
