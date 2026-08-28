import { z } from 'zod'
import { fdeDate, fdeDueTime, taskTerminal } from './fdeTaskContract.js'

export function shanghaiToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
export function shiftDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
}
export function weekStartFor(date: string) {
  fdeDate.parse(date)
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
  return shiftDate(date, -(weekday === 0 ? 6 : weekday - 1))
}
export const fdeWeekStart = fdeDate.refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).getUTCDay() === 1, '周计划开始日期必须为周一')
export function taskInWeek(task: { dueDate: string | null; status: string }, weekStart: string) {
  if (!task.dueDate || ['已取消', '已归档', '已关闭'].includes(task.status)) return false
  return task.dueDate <= shiftDate(weekStart, 6) && (task.dueDate >= weekStart || !taskTerminal(task.status))
}
export const weeklyManualItem = z.object({
  key: z.string().uuid(), title: z.string().trim().min(2).max(255),
  ownerUserId: z.string().uuid(), dueDate: fdeDate,
  deliverable: z.string().trim().min(2).max(2000), priority: z.enum(['高', '中', '低']).default('中'),
  // Optional rather than defaulted: old command hashes and meeting snapshots stay compatible.
  dueTime: fdeDueTime.nullable().optional(), needLeader: z.boolean().optional(),
}).strict().refine(item => !item.needLeader || Boolean(item.dueTime), '需领导参与的行动必须填写精确截止时刻')
export const weeklyCreateSchema = z.object({ clientRequestId: z.string().uuid(), weekStart: fdeWeekStart }).strict()
export const weeklySaveSchema = z.object({
  clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(),
  goal: z.string().trim().min(2).max(4000), manualItems: z.array(weeklyManualItem).max(100),
}).strict().refine((input) => new Set(input.manualItems.map((item) => item.key)).size === input.manualItems.length, '新增行动编号不能重复')
export const weeklyActionSchema = z.object({
  clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(),
  action: z.enum(['reconcile', 'submit', 'publish', 'return', 'discard', 'sync-leader-time']),
  reason: z.string().trim().max(2000).default(''),
}).strict().superRefine((input, ctx) => {
  if (['return', 'discard'].includes(input.action) && input.reason.length < 5) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '退回或丢弃请填写至少五字原因' })
})

export type WeeklyManualItem = z.infer<typeof weeklyManualItem>
