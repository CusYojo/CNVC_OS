export type TaskActionTarget = { projectId: string; taskId: string; action: string }
export const TASK_ACTION_OPEN = 'fde-task-action-open'
export const TASK_CHANGED = 'fde-task-changed'
export function notifyTaskChanged() {
  window.dispatchEvent(new Event(TASK_CHANGED))
  window.dispatchEvent(new Event('fde-calendar-refresh'))
}
export function taskTargetFromPath(path: string, origin = 'http://localhost'): TaskActionTarget | null {
  let url: URL
  try { url = new URL(path, origin) } catch { return null }
  const projectId = url.pathname.match(/^\/projects\/([^/]+)$/)?.[1], taskId = url.searchParams.get('task')
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const action = url.searchParams.get('action') || 'view'
  if (url.origin !== origin || !projectId || !taskId || !uuid.test(projectId) || !uuid.test(taskId) || !['view', 'start', 'progress', 'submission', 'accept', 'extension', 'cancel'].includes(action)) return null
  return { projectId, taskId, action }
}
export function openTaskAction(projectId: string, taskId: string, action: string) {
  window.dispatchEvent(new CustomEvent(TASK_ACTION_OPEN, { detail: { projectId, taskId, action } }))
}
export function openTaskPath(path: string) {
  const target = taskTargetFromPath(path, window.location.origin)
  if (!target) return false
  openTaskAction(target.projectId, target.taskId, target.action)
  return true
}
