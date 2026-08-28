import { z } from 'zod'
import { fridayLocalTime } from './fdeFridayMeetingContract.js'

export const directiveCreateSchema = z.object({
  clientRequestId: z.string().uuid(), content: z.string().trim().min(2).max(300),
  ownerUserId: z.string().uuid(), dueAt: fridayLocalTime,
  conversion: z.enum(['action', 'pending', 'leadership']), requiresReceipt: z.boolean().default(true),
}).strict()
export const directiveActionSchema = z.object({
  clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(),
  action: z.enum(['acknowledge', 'withdraw']), reason: z.string().trim().max(2000).default(''),
}).strict().superRefine((value, ctx) => {
  if (value.reason.length < (value.action === 'withdraw' ? 5 : 2)) ctx.addIssue({ code: 'custom', message: value.action === 'withdraw' ? '撤回须填写至少五字原因' : '请填写回执说明' })
})
export function directiveStatus(input: { withdrawnAt: Date | null; acknowledgedAt: Date | null; requiresReceipt: boolean }, taskStatus: string) {
  if (input.withdrawnAt) return '已撤回'
  if (taskStatus === '已完成') return '已落实'
  if (['已关闭', '已归档', '已取消'].includes(taskStatus)) return '已关闭'
  if (taskStatus === '待确认') return '待确认事项'
  if (taskStatus === '待验收') return '待验收'
  if (taskStatus === '已退回') return '成果退回'
  if (!input.acknowledgedAt && input.requiresReceipt) return '待回执'
  return taskStatus === '未开始' ? '待执行' : '执行中'
}
