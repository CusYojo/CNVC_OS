import { z } from 'zod'

export const materialStatuses = ['pending', 'read', 'partial', 'partial_returned', 'approved', 'returned', 'withdrawn'] as const
export type MaterialStatus = typeof materialStatuses[number]
export const materialStatusLabels: Record<MaterialStatus, string> = { pending: '待批复', read: '已阅待复', partial: '部分反馈', partial_returned: '部分退回', approved: '已批复', returned: '已退回', withdrawn: '已撤回' }

// The aggregate is a projection of independent recipient facts, never a client input.
export function aggregateMaterialStatus(states: Array<{ readAt: unknown; decision: string | null }>, withdrawn = false): MaterialStatus {
  if (withdrawn) return 'withdrawn'
  if (!states.length) throw new Error('材料送审必须至少有一位接收人')
  const decisions = states.filter(state => state.decision)
  if (states.every(state => state.decision === 'approve')) return 'approved'
  if (states.some(state => state.decision === 'return')) return decisions.length === states.length ? 'returned' : 'partial_returned'
  if (decisions.length) return 'partial'
  return states.every(state => state.readAt) ? 'read' : 'pending'
}

const request = { clientRequestId: z.string().uuid() }
const version = z.number().int().positive()
export const materialCreateCommand = z.object({
  ...request, fileId: z.string().uuid(), fileVersion: version, expectedAccessVersion: version,
  expectedProjectVersion: version, expectedGovernanceVersion: version,
  title: z.string().trim().min(1).max(100), note: z.string().trim().max(300).default(''),
  recipientIds: z.array(z.string().uuid()).min(1).max(50).refine(ids => new Set(ids).size === ids.length, '接收人不能重复'),
  previousSubmissionId: z.string().uuid().optional(),
}).strict()
export const materialReadCommand = z.object(request).strict()
export const materialResolveCommand = z.object(request).strict()
export const materialDecisionCommand = z.object({ ...request, expectedRecipientVersion: version, decision: z.enum(['approve', 'return']), feedback: z.string().trim().min(1).max(400) }).strict()
export const materialWithdrawCommand = z.object({ ...request, expectedVersion: version, reason: z.string().trim().min(5).max(600) }).strict()
export const materialListQuery = z.object({
  view: z.enum(['all', 'received', 'sent', 'pending', 'withdrawn']).default('all'),
  keyword: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict()
export const materialHistoryQuery = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) }).strict()
