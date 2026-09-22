import { normalizeTaskStatus, TASK_STATUS_LABELS, type UnifiedTaskStatus } from '../../server/src/contracts/unifiedTaskContract'
import { fdeTaskDecisionSchema } from '../../server/src/contracts/fdeTaskContract'

export type TaskActionState = {
  id: string
  status: string
  version: number
  capabilities?: {
    canStart?: boolean; canSubmit?: boolean; canFeedback?: boolean
    canAccept?: boolean; canExtend?: boolean; canCancel?: boolean
  }
  extensions?: Array<{ status: string }>
}

export function canPerformTaskAction(action: string, task: Pick<TaskActionState, 'status' | 'capabilities' | 'extensions'>): boolean {
  const status = task.status in TASK_STATUS_LABELS ? task.status as UnifiedTaskStatus : normalizeTaskStatus(task.status)
  const capabilities = task.capabilities ?? {}
  if (action === 'project' || action === 'view' || action === 'completed' || action === 'cancelled' || action === 'approval') return true
  if (status === 'completed' || status === 'cancelled') return false
  if (action === 'not_started') return status === 'not_started' && Boolean(capabilities.canStart ?? capabilities.canFeedback)
  if (['submission', 'in_progress', 'returned'].includes(action)) return ['not_started', 'in_progress', 'returned'].includes(status) && Boolean(capabilities.canSubmit ?? capabilities.canFeedback)
  if (action === 'feedback' || action === 'progress') return status !== 'pending_acceptance' && Boolean(capabilities.canFeedback)
  if (['accept', 'return', 'pending_acceptance'].includes(action)) return status === 'pending_acceptance' && Boolean(capabilities.canAccept)
  if (action === 'extension') return Boolean(capabilities.canExtend) && !task.extensions?.some(item => item.status === '审批中')
  if (action === 'cancel') return Boolean(capabilities.canCancel)
  return false
}

export function taskRecovery<T extends TaskActionState>(action: string, taskId: string, tasks: T[]) {
  const task = tasks.find(item => item.id === taskId) ?? null
  return { task, canContinue: Boolean(task && canPerformTaskAction(action, task)) }
}

export function taskRequiresReview(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const failure = error as { status?: number; code?: string }
  return [403, 404, 409].includes(failure.status ?? 0) || /VERSION_CONFLICT|OPTIMISTIC_LOCK|STALE|SUBMISSION_CHANGED/.test(failure.code ?? '')
}

export function taskEvidencePath(fileId: string, version: number) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId) || !Number.isInteger(version) || version < 1) return null
  return `/api/projects/files/${fileId}/versions/${version}/download`
}

export function taskDecisionRequest(task: TaskActionState & { feedbacks: Array<{ id: string; kind: string }> }, action: 'accept' | 'return', reason: string) {
  if (!canPerformTaskAction(action, task)) throw new Error('当前账号不能验收此任务，请重新查看任务')
  const feedbackId = task.feedbacks.find(feedback => feedback.kind === 'submission')?.id
  const result = fdeTaskDecisionSchema.safeParse({ expectedVersion: task.version, feedbackId, action, reason })
  if (!result.success) throw new Error(feedbackId ? '请填写至少两个字的验收意见' : '没有可验收的成果提交，请重新读取任务')
  return result.data
}
