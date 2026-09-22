import type { ApprovalCenterRow } from '../../server/src/contracts/fdeApprovalCenterContract'

export type ApprovalTarget = { id: string; kind: 'project' | 'office' | 'type_execution' | 'project_replan' | 'agent_schedule'; projectId?: string }
export const APPROVAL_OPEN = 'fde-open-approval'
export const APPROVAL_CHANGED = 'fde-approval-changed'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function approvalTarget(row: Pick<ApprovalCenterRow, 'id' | 'businessType' | 'projectId'>): ApprovalTarget {
  const kind = ['office', 'type_execution', 'project_replan', 'agent_schedule'].includes(row.businessType) ? row.businessType as ApprovalTarget['kind'] : 'project'
  return { id: row.id, kind, projectId: row.projectId ?? undefined }
}

// Only recognised, same-origin business links are intercepted. New-tab gestures remain native.
export function approvalTargetFromPath(path: string, origin = 'http://localhost'): ApprovalTarget | 'inbox' | null {
  let url: URL
  try { url = new URL(path, origin) } catch { return null }
  if (url.origin !== origin) return null
  const params = url.searchParams
  if (url.pathname === '/workflow') {
    for (const [key, kind] of [['office', 'office'], ['request', 'project']] as const) {
      const id = params.get(key)
      if (id && uuid.test(id)) return { id, kind, projectId: params.get('project') || undefined }
    }
    if (params.get('view') === 'pending' && !params.has('project')) return 'inbox'
  }
  const projectId = url.pathname.match(/^\/projects\/([^/]+)$/)?.[1]
  if (projectId && uuid.test(projectId)) {
    for (const [key, kind] of [['typeReview', 'type_execution'], ['replan', 'project_replan'], ['schedule', 'agent_schedule']] as const) {
      const id = params.get(key)
      if (id && uuid.test(id)) return { id, kind, projectId }
    }
  }
  return null
}

export function openApproval(target: ApprovalTarget | 'inbox' = 'inbox') {
  window.dispatchEvent(new CustomEvent(APPROVAL_OPEN, { detail: target }))
}
export function openApprovalPath(path: string) {
  const target = approvalTargetFromPath(path, window.location.origin)
  if (!target) return false
  openApproval(target)
  return true
}

export function nextApproval(rows: ApprovalCenterRow[], handled: ApprovalTarget) {
  // Never use an old array index after the server has removed a handled item.
  return rows.find(row => row.id !== handled.id) ?? null
}

export type ApprovalSession = {
  requestId: string
  navigation: import('react').ReactNode
  onClose: () => void
  onHandled: () => Promise<void>
  onBusyChange: (busy: boolean) => void
  onDirtyChange: (dirty: boolean) => void
}
