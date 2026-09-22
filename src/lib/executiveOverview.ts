import type { executivePortfolio } from './executiveDashboardData'
import { taskTargetFromPath } from './taskWorkspace'

export function executiveFocusProjects(portfolio: ReturnType<typeof executivePortfolio>) {
  // The portfolio already excludes historical projects and ranks actual risk signals.
  return portfolio.filter(row => row.project.classification === 'key')
}

export function executiveAgendaAction(item: { to: string }) {
  const task = taskTargetFromPath(item.to)
  if (task) return { kind: 'task' as const, ...task }
  let url: URL
  try { url = new URL(item.to, 'http://localhost') } catch { return { kind: 'link' as const, to: item.to } }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (url.origin === 'http://localhost') {
    const projectId = url.pathname.match(/^\/projects\/([^/]+)$/)?.[1]
    if (projectId && uuid.test(projectId) && url.searchParams.get('tab') === 'workflow') return { kind: 'project' as const, id: projectId }
    const meetingId = url.searchParams.get('meeting')
    if (url.pathname === '/meetings' && meetingId && uuid.test(meetingId)) return { kind: 'meeting' as const, id: meetingId }
  }
  return { kind: 'link' as const, to: item.to }
}
