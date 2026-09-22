import { APPROVAL_CHANGED } from './approvalWorkspace'
import { TASK_CHANGED } from './taskWorkspace'

// One business action can notify several domains. Coalesce these notifications
// while still reloading authoritative data in every mounted view.
export function subscribeWorkspaceRefresh(refresh: () => void, target: EventTarget = window) {
  let active = true, queued = false
  const receive = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => { queued = false; if (active) refresh() })
  }
  const events = [TASK_CHANGED, APPROVAL_CHANGED, 'fde-calendar-refresh']
  events.forEach(event => target.addEventListener(event, receive))
  return () => { active = false; events.forEach(event => target.removeEventListener(event, receive)) }
}

export function createLatestRequestGuard() {
  let generation = 0
  return {
    begin() { const current = ++generation; return () => current === generation },
    invalidate() { generation++ },
  }
}
