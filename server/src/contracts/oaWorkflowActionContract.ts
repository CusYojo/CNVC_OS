import { z } from 'zod'

export const oaActionSchema = z.object({
  action: z.enum(['approve', 'return', 'reject', 'withdraw', 'resubmit']),
  comment: z.string().trim().min(2).max(8_000),
  expectedVersion: z.number().int().positive().optional(),
}).superRefine((value, context) => {
  if (value.action === 'return' && value.comment.length < 5) {
    context.addIssue({ code: 'custom', path: ['comment'], message: '退回意见至少填写 5 个字' })
  }
})
