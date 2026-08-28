import { z } from 'zod'
import { responsibilityEventCode, type ResponsibilityPolicy } from './fdeResponsibilityPolicyContract.js'
import { fdeDate, fdeDueTime, taskDeadlineKey } from './fdeTaskContract.js'

export const responsibilityStatus = z.enum(['pending_confirmation', 'effective', 'appealing', 'upheld', 'adjusted', 'exempted', 'revoked'])
export const responsibilityStatusLabels: Record<z.infer<typeof responsibilityStatus>, string> = { pending_confirmation: '待责任确认', effective: '已生效', appealing: '申诉中', upheld: '复核维持', adjusted: '已调整', exempted: '已豁免', revoked: '已撤销' }
export const responsibilityEvidence = z.object({ fileId: z.string().uuid(), version: z.number().int().positive() }).strict()
const reason = z.string().trim().min(5).max(2000)
const command = { commandId: z.string().uuid(), reason }
const record = { recordId: z.string().uuid(), expectedVersion: z.number().int().positive() }
export const responsibilityCommand = z.discriminatedUnion('action', [
  z.object({ ...command, action: z.literal('mark_critical'), taskId: z.string().uuid(), expectedTaskVersion: z.number().int().positive(), expectedMarkerVersion: z.number().int().nonnegative(), critical: z.boolean() }).strict(),
  z.object({ ...command, action: z.literal('propose'), taskId: z.string().uuid(), expectedTaskVersion: z.number().int().positive(), eventCode: z.enum(['major_risk', 'unblocked', 'no_feedback', 'unjustified_delay', 'incorrect_completion']), sourceId: z.string().uuid().nullable(), relatedSourceId: z.string().uuid().nullable(), evidence: z.array(responsibilityEvidence).min(1).max(20) }).strict(),
  z.object({ ...command, ...record, action: z.literal('confirm'), decision: z.enum(['confirm', 'revoke']) }).strict(),
  z.object({ ...command, ...record, action: z.literal('appeal'), evidence: z.array(responsibilityEvidence).min(1).max(20) }).strict(),
  z.object({ ...command, ...record, action: z.literal('review'), decision: z.enum(['uphold', 'revoke', 'adjust', 'exempt']), adjustedPoints: z.number().int().min(-100).max(100).nullable() }).strict(),
  z.object({ ...command, ...record, action: z.literal('reroute') }).strict(),
  z.object({ ...command, ...record, action: z.literal('read_notice') }).strict(),
])
export const responsibilityQuery = z.object({ projectId: z.string().uuid().optional(), status: responsibilityStatus.optional(), eventCode: responsibilityEventCode.optional(), view: z.enum(['mine', 'review', 'managed', 'assignment']).default('mine'), page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) }).strict()
export const responsibilityReceipt = z.object({ commandId: z.string().uuid(), projectId: z.string().uuid(), recordId: z.string().uuid().nullable(), taskId: z.string().uuid(), version: z.number().int().positive(), status: z.string().max(32) }).strict()
export type ResponsibilityReceipt = z.infer<typeof responsibilityReceipt>
export type ResponsibilityStatus = z.infer<typeof responsibilityStatus>

export function responsibilityDeadline(date: string, time: string | null) {
  fdeDate.parse(date); fdeDueTime.nullable().parse(time)
  return new Date(`${taskDeadlineKey(date, time)}+08:00`)
}
export function responsibilityCountedPoints(status: string, effectivePoints: number, policy: Pick<ResponsibilityPolicy, 'appealAggregation'>) {
  return status === 'pending_confirmation' || status === 'revoked' || status === 'exempted' || status === 'appealing' && policy.appealAggregation === 'exclude_pending' ? 0 : effectivePoints
}
export function responsibilityReviewPoints(original: number, current: number, decision: 'uphold' | 'revoke' | 'adjust' | 'exempt', adjusted: number | null, policy: Pick<ResponsibilityPolicy, 'allowAdjustment' | 'allowExemption'>) {
  if (decision === 'adjust') {
    if (!policy.allowAdjustment || adjusted === null || !Number.isInteger(adjusted) || adjusted < original || adjusted > 0) throw new Error('调整须获规则允许，且不能加重负向责任或改为奖励')
    return adjusted
  }
  if (adjusted !== null) throw new Error('仅调整结论可以填写修订分值')
  if (decision === 'exempt' && !policy.allowExemption) throw new Error('当前规则未允许人工豁免')
  return decision === 'uphold' ? current : 0
}
