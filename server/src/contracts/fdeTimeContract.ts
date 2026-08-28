import { z } from 'zod'
import { fridayLocalTime } from './fdeFridayMeetingContract.js'
import { fdeWeekStart } from './fdeWeeklyPlanContract.js'

export const TIME_ZONE = 'Asia/Shanghai'
export const timeDuration = z.number().int().min(15).max(780).multipleOf(15)
export const timeInstant = (local: string) => new Date(`${local}:00+08:00`)
export const timeLocal = (instant: Date) => new Date(instant.getTime() + 8 * 3600000).toISOString().slice(0, 16)
export const timeEnd = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60000)
export const intervalsOverlap = (start: Date, end: Date, otherStart: Date, otherEnd: Date) => start < otherEnd && otherStart < end
export const timeTerminal = (status: string) => ['rejected', 'withdrawn', 'cancelled'].includes(status)
export function validLeaderSlot(start: string, durationMinutes: number) {
  if (!fridayLocalTime.safeParse(start).success || !timeDuration.safeParse(durationMinutes).success) return false
  const minute = Number(start.slice(11, 13)) * 60 + Number(start.slice(14, 16))
  return minute % 15 === 0 && minute >= 420 && minute + durationMinutes <= 1200
}
const definition = {
  title: z.string().trim().min(2).max(300),
  reason: z.string().trim().min(5).max(4000),
  outcome: z.string().trim().min(2).max(4000),
  impact: z.string().trim().min(2).max(4000),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).nullable().default(null),
  // Historical requests keep an explicitly unknown deadline; new/edited forms require one below.
  latestFinish: fridayLocalTime.nullable().default(null),
  preferredStart: fridayLocalTime,
  alternativeStart: fridayLocalTime,
  durationMinutes: timeDuration,
  location: z.string().trim().min(2).max(255),
}
function validateSlots(value: { preferredStart: string; alternativeStart: string; durationMinutes: number }, ctx: z.RefinementCtx) {
  for (const key of ['preferredStart', 'alternativeStart'] as const) if (!validLeaderSlot(value[key], value.durationMinutes)) ctx.addIssue({ code: 'custom', path: [key], message: '排期须在 07:00—20:00 内，开始时间和时长按 15 分钟步长' })
  if (value.preferredStart === value.alternativeStart) ctx.addIssue({ code: 'custom', path: ['alternativeStart'], message: '备选时间应与首选时间不同' })
}
export const timeDefinitionSchema = z.object(definition).strict().superRefine(validateSlots)
export const timeCreateSchema = z.object({ clientRequestId: z.string().uuid(), projectId: z.string().uuid(), leaderId: z.string().uuid(), ...definition, latestFinish: fridayLocalTime }).strict().superRefine(validateSlots)
export const timeSaveSchema = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), ...definition, latestFinish: fridayLocalTime }).strict().superRefine(validateSlots)
export const timeActionSchema = z.object({
  clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(),
  action: z.enum(['submit', 'coordinate', 'confirm', 'reject', 'supplement', 'withdraw', 'cancel', 'refresh-source']),
  reason: z.string().trim().min(2).max(2000),
  scheduledStart: fridayLocalTime.optional(), durationMinutes: timeDuration.optional(),
  method: z.enum(['form', 'drag', 'resize', 'keyboard']).default('form'),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'coordinate') {
    if (!value.scheduledStart || !value.durationMinutes || !validLeaderSlot(value.scheduledStart, value.durationMinutes)) ctx.addIssue({ code: 'custom', message: '请提供有效的 15 分钟排期方案' })
  } else if (value.scheduledStart !== undefined || value.durationMinutes !== undefined) ctx.addIssue({ code: 'custom', message: '只有调整时间操作可修改排期' })
})
export const calendarDefinitionSchema = z.object({
  title: z.string().trim().min(2).max(255), detail: z.string().trim().max(4000).default(''),
  startsAt: fridayLocalTime, endsAt: fridayLocalTime,
  visibility: z.enum(['private', 'company']).default('private'),
}).strict().superRefine((value, ctx) => {
  const duration = timeInstant(value.endsAt).getTime() - timeInstant(value.startsAt).getTime()
  if (duration <= 0 || duration > 86400000 || duration % 900000 || Number(value.startsAt.slice(14)) % 15) ctx.addIssue({ code: 'custom', message: '日程按 15 分钟步长，结束须晚于开始且不超过 24 小时' })
})
export const calendarWriteSchema = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive().optional(), definition: calendarDefinitionSchema }).strict()
export const calendarCancelSchema = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(2).max(2000) }).strict()

export const autoScheduleSelection = z.object({ weekStart: fdeWeekStart, requests: z.array(z.object({ id: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict()).min(1).max(100) }).strict()
  .refine(value => new Set(value.requests.map(row => row.id)).size === value.requests.length, '需求不能重复')
export const autoScheduleApply = z.object({ clientRequestId: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), selection: autoScheduleSelection }).strict()
export type AutoScheduleItem = { id: string; title: string; priority: string | null; latestFinish?: string | null; expectedVersion: number; from: string | null; scheduledStart: string | null; durationMinutes: number; result: 'arranged' | 'overflow' | 'skipped'; reason: string }
// v1 remains readable for immutable historical batch replays.
export type AutoScheduleResult = { weekStart: string; fingerprint: string; items: AutoScheduleItem[]; arranged: number; overflow: number; skipped: number; rulesVersion: 'fde-priority-v1' | 'fde-priority-deadline-v2' }
