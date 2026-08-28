import { z } from 'zod'
import { shiftDate, weekStartFor, weeklyManualItem } from './fdeWeeklyPlanContract.js'

// Local wall time is explicit; JS/browser timezone must not change the meeting instant.
export const fridayLocalTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).refine((value) => {
  const instant = new Date(`${value}:00+08:00`)
  return Number.isFinite(instant.getTime()) && new Date(instant.getTime() + 8 * 3600000).toISOString().slice(0, 16) === value
}, '请输入真实的上海日期和时间')
export const fridayMinutesSchema = z.object({
  agenda: z.string().trim().min(2).max(4000),
  result: z.string().trim().max(4000).default(''),
  blocked: z.string().trim().max(4000).default(''),
  decision: z.string().trim().max(4000).default(''),
  nextGoal: z.string().trim().max(4000).default(''),
  nextActions: z.array(weeklyManualItem).max(100).default([]),
}).strict().refine((value) => new Set(value.nextActions.map((item) => item.key)).size === value.nextActions.length, '下周行动编号不能重复')
const definition = {
  title: z.string().trim().min(2).max(255),
  startsAt: fridayLocalTime,
  endsAt: fridayLocalTime,
  hostUserId: z.string().uuid(),
  participantIds: z.array(z.string().uuid()).min(1).max(100),
  minutes: fridayMinutesSchema,
}
function validDefinition(value: { startsAt: string; endsAt: string; hostUserId: string; participantIds: string[] }, ctx: z.RefinementCtx) {
  if (value.endsAt <= value.startsAt || Date.parse(`${value.endsAt}:00+08:00`) - Date.parse(`${value.startsAt}:00+08:00`) > 86400000) ctx.addIssue({ code: 'custom', message: '结束时间须晚于开始时间，且时长不超过 24 小时' })
  if (!value.participantIds.includes(value.hostUserId) || new Set(value.participantIds).size !== value.participantIds.length) ctx.addIssue({ code: 'custom', message: '主持人须在参会名单中，参会人不能重复' })
}
export const fridayCreateSchema = z.object({ clientRequestId: z.string().uuid(), ...definition }).strict().superRefine(validDefinition)
export const fridaySaveSchema = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(5).max(2000), ...definition }).strict().superRefine(validDefinition)
export const fridayActionSchema = z.object({
  clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(),
  action: z.enum(['schedule', 'confirm', 'cancel', 'derive']), reason: z.string().trim().max(2000).default(''),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'cancel' && value.reason.length < 5) ctx.addIssue({ code: 'custom', message: '取消会议请填写至少五字原因' })
})
export function nextMeetingWeek(startsAt: string | Date) {
  const date = typeof startsAt === 'string' ? startsAt.slice(0, 10) : new Date(startsAt.getTime() + 8 * 3600000).toISOString().slice(0, 10)
  return shiftDate(weekStartFor(date), 7)
}
export type FridayMinutes = z.infer<typeof fridayMinutesSchema>
