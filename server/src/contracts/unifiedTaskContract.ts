export const TASK_CATEGORY_LABELS = {
  personal: '个人事项',
  mine: '我的任务',
  project: '项目任务',
  approval: '审批待办',
} as const

export type TaskCategory = keyof typeof TASK_CATEGORY_LABELS

export const TASK_SOURCE_LABELS = {
  personal: '个人创建',
  plan: '倒排计划',
  workflow: '流程行动',
  directive: '领导批示',
  approval: '审批流程',
  meeting: '项目会议',
  project: '项目分配',
} as const

export type UnifiedTaskSource = keyof typeof TASK_SOURCE_LABELS

export const TASK_STATUS_LABELS = {
  not_started: '未开始',
  in_progress: '进行中',
  pending_acceptance: '待验收',
  returned: '已退回',
  completed: '已完成',
  cancelled: '已取消',
} as const

export type UnifiedTaskStatus = keyof typeof TASK_STATUS_LABELS

export const TASK_PRIMARY_ACTIONS = {
  not_started: '开始任务',
  in_progress: '提交成果',
  pending_acceptance: '验收',
  returned: '重新提交',
  completed: '查看成果',
  cancelled: '查看记录',
} as const

export type UnifiedTaskPrimaryAction = keyof typeof TASK_PRIMARY_ACTIONS | 'approval'

export type UnifiedTaskPerson = { id: string; name: string; role?: string | null }
export type UnifiedTaskAttachment = { fileId: string; name: string; version: number }
export type UnifiedTaskHistory = { id: string; kind: string; title: string; detail: string; actorName?: string | null; createdAt: string }

export type UnifiedTask = {
  id: string
  title: string
  category: TaskCategory
  source: UnifiedTaskSource
  sourceLabel: string
  status: UnifiedTaskStatus
  statusLabel: string
  rawStatus: string
  primaryAction: UnifiedTaskPrimaryAction
  primaryActionLabel: string
  project: { id: string; name: string } | null
  owner: UnifiedTaskPerson
  participants: UnifiedTaskPerson[]
  startsAt: string | null
  dueDate: string | null
  dueTime: string | null
  deliverable: string | null
  progress: number
  feedbacks: Array<{
    id: string; kind: string; progress: number; result: string; blocker: string
    estimatedDate: string | null; submittedAt: string
    submittedBy?: string | null; evidence: UnifiedTaskAttachment[]
    acceptance: { decision: string; reason: string; acceptedAt?: string | null } | null
  }>
  attachments: UnifiedTaskAttachment[]
  acceptance: { decision: string; reason: string; acceptedAt?: string | null } | null
  calendar: { startsAt: string; endsAt: string; hidden: boolean; version: number } | null
  version: number
  history: UnifiedTaskHistory[]
  capabilities: {
    canStart: boolean; canSubmit: boolean; canAccept: boolean
    canFeedback: boolean; canExtend: boolean; canCancel: boolean; canEditParticipants: boolean
  }
}

export function normalizeTaskStatus(status: string): UnifiedTaskStatus {
  if (status === '待验收') return 'pending_acceptance'
  if (status === '已退回') return 'returned'
  if (['已完成', '已关闭', '已归档'].includes(status)) return 'completed'
  if (status === '已取消') return 'cancelled'
  if (status === '进行中') return 'in_progress'
  return 'not_started'
}

export function taskPrimaryAction(status: UnifiedTaskStatus, approval = false) {
  return approval
    ? { key: 'approval' as const, label: '处理审批' }
    : { key: status, label: TASK_PRIMARY_ACTIONS[status] }
}
