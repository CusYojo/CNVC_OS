import { z } from 'zod'

export const fdeDate = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}, '必须填写有效日期')
export const fdeTaskVersion = z.number().int().positive()
export const fdeDueTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '截止时刻须为 HH:mm')
export function taskDeadlineKey(date: string, time?: string | null) { return `${date}T${time ?? '23:59'}:${time ? '00.000' : '59.999'}` }
export const fdeTaskFeedbackSchema = z.object({
  expectedVersion: fdeTaskVersion,
  kind: z.enum(['progress', 'submission']),
  progress: z.number().int().min(0).max(100),
  result: z.string().trim().min(2).max(8000),
  blocker: z.string().trim().max(4000).default(''),
  estimatedDate: fdeDate.nullable().default(null),
  evidence: z.array(z.object({ fileId: z.string().uuid(), version: fdeTaskVersion }).strict()).max(20).default([]),
}).strict().superRefine((input, ctx) => {
  if (input.kind === 'submission' && (input.progress !== 100 || !input.evidence.length)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '申请验收须提交 100% 进度和真实项目文件证据' })
  if (input.kind === 'progress' && input.progress === 100) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '100% 进度请通过提交成果进入待验收，不能直接完成' })
  if (new Set(input.evidence.map((item) => item.fileId)).size !== input.evidence.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '证据文件不可重复' })
})
export const fdeTaskDecisionSchema = z.object({ expectedVersion: fdeTaskVersion, feedbackId: z.string().uuid(), action: z.enum(['accept', 'return']), reason: z.string().trim().min(2).max(4000) }).strict()
export const fdeTaskExtensionSchema = z.object({ expectedVersion: fdeTaskVersion, requestedDueDate: fdeDate, requestedDueTime: fdeDueTime.nullable().default(null), reason: z.string().trim().min(5).max(4000), reviewerUserId: z.string().uuid() }).strict()
export const fdeTaskCreateSchema = z.object({ clientRequestId: z.string().uuid(), title: z.string().trim().min(1).max(255), ownerUserId: z.string().uuid(), dueDate: fdeDate, dueTime: fdeDueTime.nullable().default(null), deliverable: z.string().trim().min(2).max(2000), priority: z.enum(['高', '中', '低']).default('中') }).strict()
export const FDE_TASK_TERMINAL = ['已完成', '已关闭', '已取消', '已归档'] as const
export const taskTerminal = (status: string) => (FDE_TASK_TERMINAL as readonly string[]).includes(status)
