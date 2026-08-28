import { z } from 'zod'

export const approvalCenterViews = ['pending', 'tracking', 'processed', 'mine', 'draft', 'completed'] as const
export const approvalCenterViewLabels = {
  pending: '待我审批', tracking: '流程跟踪', processed: '我已审批',
  mine: '我发起的', draft: '草稿箱', completed: '已完成',
} as const
export type ApprovalCenterView = typeof approvalCenterViews[number]
export const approvalCenterQuery = z.object({
  view: z.enum(approvalCenterViews).default('pending'),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  kind: z.string().trim().max(32).optional().transform(value => value || undefined),
  q: z.string().trim().max(100).default(''),
}).strict()

export function approvalCenterReturnPath(raw: string | null) {
  const params = new URLSearchParams(raw ?? '')
  const result = approvalCenterQuery.safeParse(Object.fromEntries(
    ['view', 'page', 'kind', 'q'].flatMap(key => params.has(key) ? [[key, params.get(key)!]] : []),
  ))
  if (!result.success) return '/workflow'
  const query = result.data, safe = new URLSearchParams({ view: query.view, page: String(query.page) })
  if (query.kind) safe.set('kind', query.kind)
  if (query.q) safe.set('q', query.q)
  return `/workflow?${safe}`
}

export type ApprovalCenterRow = {
  id: string; requestNo: string; title: string; kind: string; businessType: string
  status: string; applicantId: string; applicantName: string; projectName: string
  currentNodeName: string; priority: string; version: number; revision: number
  updatedAt: string; submittedAt: string
  notice?: { id: string; readAt: string | null } | null
  projectId?: string | null
}

export function approvalCenterDetailPath(row: Pick<ApprovalCenterRow, 'id' | 'businessType' | 'projectId'>, center = 'view=pending') {
  const id = z.string().uuid().parse(row.id), safeCenter = approvalCenterReturnPath(center).split('?')[1] ?? ''
  if (row.businessType === 'type_execution') {
    const projectId = z.string().uuid().parse(row.projectId)
    return `/projects/${projectId}?tab=workflow&typeReview=${id}&center=${encodeURIComponent(safeCenter)}`
  }
  if (row.businessType === 'office') return `/workflow?${safeCenter}&office=${id}`
  if (row.businessType === 'project_replan') {
    const projectId = z.string().uuid().parse(row.projectId)
    return `/projects/${projectId}?tab=workflow&replan=${id}&center=${encodeURIComponent(safeCenter)}#project-replan-${id}`
  }
  return `/workflow?view=project&request=${id}&center=${encodeURIComponent(safeCenter)}`
}
export function approvalNoticeReadPath(row: Pick<ApprovalCenterRow, 'businessType'>, noticeId: string) {
  const id = z.string().uuid().parse(noticeId)
  return row.businessType === 'type_execution' ? `/oa/type-notices/${id}/read` : `/oa/office/notices/${id}/read`
}
export type ApprovalCenterResult = {
  list: ApprovalCenterRow[]; total: number; page: number; pageSize: number
  counts: Record<ApprovalCenterView, number>; kinds: string[]; canCreateOffice: boolean
}
