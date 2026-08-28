import { z } from 'zod'
import { fdeDate } from './fdeTaskContract.js'

export const responsibilityEvents = [
  { code: 'on_time', label: '按时完成', mode: 'automatic', positive: true },
  { code: 'early_critical', label: '提前完成关键行动', mode: 'automatic', positive: true },
  { code: 'feedback', label: '按要求反馈', mode: 'automatic', positive: true },
  { code: 'major_risk', label: '发现重大风险', mode: 'manual', positive: true },
  { code: 'unblocked', label: '有效解除阻塞', mode: 'manual', positive: true },
  { code: 'no_feedback', label: '逾期未反馈', mode: 'manual', positive: false },
  { code: 'unjustified_delay', label: '无理由超时', mode: 'manual', positive: false },
  { code: 'incorrect_completion', label: '错误确认完成', mode: 'manual', positive: false },
] as const
export const responsibilityEventCode = z.enum(['on_time', 'early_critical', 'feedback', 'major_risk', 'unblocked', 'no_feedback', 'unjustified_delay', 'incorrect_completion'])
export type ResponsibilityEventCode = z.infer<typeof responsibilityEventCode>
const ruleSchema = z.object({
  code: responsibilityEventCode,
  enabled: z.boolean(),
  points: z.number().int().min(-100).max(100).nullable(),
  mode: z.enum(['automatic', 'manual']),
}).strict()

// Values are explicit policy choices, not demo defaults. These limits bound
// configuration size; they do not approve any production scoring policy.
export const responsibilityPolicySchema = z.object({
  rules: z.array(ruleSchema).length(8),
  timezone: z.literal('Asia/Shanghai'),
  calendar: z.object({
    workingWeekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    holidays: z.array(fdeDate).max(800),
    extraWorkingDates: z.array(fdeDate).max(800),
  }).strict(),
  earlyWorkingDays: z.number().int().min(1).max(30).nullable(),
  graceMinutes: z.number().int().min(0).max(43_200).nullable(),
  appealLimit: z.literal(1),
  appealAggregation: z.enum(['exclude_pending', 'retain_pending']),
  allowAdjustment: z.boolean(),
  allowExemption: z.boolean(),
  completionAggregation: z.literal('one_per_task'),
  feedbackAggregation: z.literal('one_per_actor_task_business_day'),
  missingReviewer: z.literal('retain_pending_assignment'),
  history: z.literal('append_only_no_automatic_rescore'),
}).strict().superRefine((value, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message })
  if (new Set(value.rules.map(rule => rule.code)).size !== 8) issue(['rules'], '八类事件必须各配置一次')
  value.rules.forEach((rule, index) => {
    const reference = responsibilityEvents.find(event => event.code === rule.code)!
    if (reference.mode !== rule.mode) issue(['rules', index, 'mode'], '不能将人工责任判断改为自动计分')
    if (rule.enabled && (rule.points === null || (reference.positive ? rule.points <= 0 : rule.points >= 0))) issue(['rules', index, 'points'], '启用事件必须显式配置方向正确的非零分值')
    if (rule.enabled && rule.code === 'early_critical' && value.earlyWorkingDays === null) issue(['earlyWorkingDays'], '提前完成规则需要明确工作日门槛')
    if (rule.enabled && ['no_feedback', 'unjustified_delay'].includes(rule.code) && value.graceMinutes === null) issue(['graceMinutes'], '期限责任规则需要明确宽限时间')
  })
  for (const key of ['workingWeekdays', 'holidays', 'extraWorkingDates'] as const) {
    if (new Set<string | number>(value.calendar[key]).size !== value.calendar[key].length) issue(['calendar', key], '日历配置不能重复')
  }
  if (value.calendar.holidays.some(date => value.calendar.extraWorkingDates.includes(date))) issue(['calendar'], '同一天不能同时配置为休息和补班')
})
export type ResponsibilityPolicy = z.infer<typeof responsibilityPolicySchema>
const reason = z.string().trim().min(5).max(1000)
const command = { commandId: z.string().uuid(), reason }
const draft = { versionId: z.string().uuid(), expectedDraftVersion: z.number().int().positive() }
export const responsibilityPolicyCommand = z.discriminatedUnion('action', [
  z.object({ ...command, action: z.literal('create'), expectedPolicyVersion: z.number().int().nonnegative(), configuration: responsibilityPolicySchema }).strict(),
  z.object({ ...command, ...draft, action: z.literal('save'), configuration: responsibilityPolicySchema }).strict(),
  z.object({ ...command, ...draft, action: z.literal('approve') }).strict(),
  z.object({ ...command, ...draft, action: z.literal('publish'), expectedPolicyVersion: z.number().int().positive() }).strict(),
  z.object({ ...command, action: z.literal('toggle'), expectedPolicyVersion: z.number().int().positive(), enabled: z.boolean() }).strict(),
])
export type ResponsibilityPolicyCommand = z.infer<typeof responsibilityPolicyCommand>
export const responsibilityPolicyReceipt = z.object({
  commandId: z.string().uuid(), action: z.enum(['create', 'save', 'approve', 'publish', 'toggle']),
  policyVersion: z.number().int().positive(), versionId: z.string().uuid().nullable(),
  draftVersion: z.number().int().positive().nullable(), status: z.enum(['draft', 'approved', 'published', 'enabled', 'disabled']),
}).strict()
export type ResponsibilityPolicyReceipt = z.infer<typeof responsibilityPolicyReceipt>
export const responsibilityPolicyRecovery = z.object({ commandId: z.string().uuid() }).strict()

export function responsibilityBusinessDate(instant: Date) {
  if (!Number.isFinite(instant.getTime())) throw new Error('无效业务时刻')
  return new Date(instant.getTime() + 8 * 3_600_000).toISOString().slice(0, 10)
}

export function isResponsibilityWorkingDate(date: string, calendar: ResponsibilityPolicy['calendar']) {
  fdeDate.parse(date)
  if (calendar.extraWorkingDates.includes(date)) return true
  if (calendar.holidays.includes(date)) return false
  return calendar.workingWeekdays.includes(new Date(`${date}T12:00:00+08:00`).getUTCDay())
}

// Count (from, to], bounded to avoid unbounded loops on corrupt historical data.
export function responsibilityWorkingDaysBetween(from: string, to: string, calendar: ResponsibilityPolicy['calendar']) {
  fdeDate.parse(from); fdeDate.parse(to)
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`)
  if (end < start || end - start > 3660 * 86_400_000) throw new Error('工作日计算区间无效或超出十年范围')
  let days = 0
  for (let time = start + 86_400_000; time <= end; time += 86_400_000) if (isResponsibilityWorkingDate(new Date(time).toISOString().slice(0, 10), calendar)) days++
  return days
}
