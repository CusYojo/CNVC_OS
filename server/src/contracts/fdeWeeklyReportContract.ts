import { z } from 'zod'
import { fdeWeekStart, shiftDate } from './fdeWeeklyPlanContract.js'
import { timeLocal } from './fdeTimeContract.js'
import type { OfficeReportSource } from './fdeOfficeSourcesContract.js'
import { milestoneReportBody, type ApprovedMilestoneFact } from './fdeMilestoneSourcesContract.js'

export const weeklyReportSourceOptions = z.object({
  calendar: z.boolean().default(false),
  privateCalendar: z.boolean().default(false),
  independentWork: z.boolean().default(false),
  // Omission preserves the serialized options of existing report snapshots.
  office: z.boolean().optional(),
  projectTimeline: z.boolean().optional(),
}).strict().refine(value => !value.privateCalendar || value.calendar, '私人日历须同时选择日历来源')
export type WeeklyReportSourceOptions = z.infer<typeof weeklyReportSourceOptions>

export const weeklyReportCreateSchema = z.object({
  clientRequestId: z.string().uuid(), weekStart: fdeWeekStart,
  projectIds: z.array(z.string().uuid()).max(50),
  sourceOptions: weeklyReportSourceOptions.default({ calendar: false, privateCalendar: false, independentWork: false }),
}).strict().refine((value) => new Set(value.projectIds).size === value.projectIds.length, '项目不能重复')
  .refine(value => !value.sourceOptions.projectTimeline || value.projectIds.length > 0, '节点日期来源须明确选择项目')
  .refine(value => value.projectIds.length > 0 || value.sourceOptions.calendar || value.sourceOptions.independentWork || value.sourceOptions.office, '请选择项目、日历、办公或独立工作来源')
export const weeklyReportSaveSchema = z.object({
  clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(),
  body: z.string().trim().min(2).max(20000),
}).strict()
export const weeklyReportActionSchema = z.object({
  clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(),
  action: z.enum(['regenerate', 'publish', 'withdraw', 'discard']),
  recipientIds: z.array(z.string().uuid()).max(50).default([]),
  reason: z.string().trim().max(1000).default(''),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.recipientIds).size !== value.recipientIds.length) ctx.addIssue({ code: 'custom', message: '接收人不能重复' })
  if (value.action !== 'publish' && value.recipientIds.length) ctx.addIssue({ code: 'custom', message: '仅发布操作可指定接收人' })
  if (['withdraw', 'discard'].includes(value.action) && value.reason.length < 5) ctx.addIssue({ code: 'custom', message: '撤回或丢弃须填写至少五字原因' })
})

export function reportWindow(weekStart: string) {
  fdeWeekStart.parse(weekStart)
  return { start: new Date(`${weekStart}T00:00:00+08:00`), end: new Date(`${shiftDate(weekStart, 7)}T00:00:00+08:00`) }
}
export type WeeklyReportFacts = {
  weekStart: string
  weekEnd: string
  generatedAt: string
  projects: Array<{ id: string; name: string }>
  sourceOptions?: WeeklyReportSourceOptions
  tasks: Array<{ id: string; projectId: string | null; ownerUserId?: string | null; title: string; version: number; status: string; dueDate: string | null; dueTime?: string | null; completedAt: string | null; progress: number }>
  approvals: Array<{ id: string; requestId: string; projectId: string; taskId?: string | null; title: string; action: string; occurredAt: string }>
  meetings: Array<{ id: string; projectId: string | null; title: string; version: number; startedAt: string; accessUserIds?: string[]; committee?: boolean }>
  calendar?: WeeklyReportCalendarFact[]
  office?: OfficeReportSource[]
  milestones?: ApprovedMilestoneFact[]
  metrics: { completedInWeek: number; dueInWeek: number; overdueOpen: number; cancelledDueInWeek: number; approvalActions: number; meetingRecords: number }
  unavailable: string[]
}

export type WeeklyReportCalendarFact = {
  id: string; source: 'personal' | 'leader' | 'meeting' | 'office'; projectId: string | null;
  ownerId: string; title: string; version: number; startsAt: string; endsAt: string | null;
  status: string; visibility: 'private' | 'company' | 'project'; taskId?: string | null; accessUserIds?: string[]; revision?: number; committee?: boolean;
}

export function weeklyReportBody(facts: WeeklyReportFacts) {
  const m = facts.metrics
  const meetingIds = new Set(facts.meetings.map(item => item.id))
  const local = (value: string) => timeLocal(new Date(value)).replace('T', ' ')
  const calendar = facts.calendar?.filter(item => item.status !== 'cancelled' && (item.source !== 'meeting' || !meetingIds.has(item.id))) ?? []
  const terminal = new Set(['已完成', '已关闭', '已取消', '已归档'])
  const completed = facts.tasks.filter(task => task.status === '已完成')
  const open = facts.tasks.filter(task => !terminal.has(task.status))
  const overdue = open.filter(task => Boolean(task.dueDate && task.dueDate < facts.weekStart))
  const sections: string[] = []
  const add = (title: string, rows: string[]) => { if (rows.length) sections.push(`${title}\n${rows.join('\n')}`) }
  const due = (task: WeeklyReportFacts['tasks'][number]) => task.dueDate ? `${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ''}` : '待排期'

  const overview = [
    m.completedInWeek ? `完成 ${m.completedInWeek} 项` : '',
    open.length ? `推进中 ${open.length} 项` : '',
    m.approvalActions ? `处理审批 ${m.approvalActions} 次` : '',
    m.meetingRecords ? `参与会议 ${m.meetingRecords} 场` : '',
    overdue.length ? `逾期 ${overdue.length} 项` : '',
  ].filter(Boolean)
  if (overview.length) sections.push(`本周概览\n${overview.join(' · ')}`)
  add('已完成事项', completed.map(task => `- ${task.title}`))
  add('重点推进', open.filter(task => !overdue.includes(task)).map(task => `- ${task.title}｜${task.status}｜${due(task)}${task.progress > 0 ? `｜${task.progress}%` : ''}`))
  add('风险与阻塞', overdue.map(task => `- ${task.title}｜已逾期｜原定 ${due(task)}`))
  add('审批与会议', [
    ...facts.approvals.map(item => `- ${item.title}｜${item.action}`),
    ...facts.meetings.map(item => `- ${item.title}｜${local(item.startedAt)}`),
  ])
  add('办公事项', (facts.office ?? []).map(item => `- ${item.title}｜${item.kind}｜${item.status}`))
  add('重要安排', calendar.map(item => `- ${item.title}｜${local(item.startsAt)}${item.endsAt ? `—${local(item.endsAt)}` : ''}`))
  if (facts.milestones?.length) sections.push(milestoneReportBody(facts.milestones).trim())
  if (!sections.length) sections.push('本周暂无可汇总事项。')
  return `${facts.weekStart} 至 ${facts.weekEnd} 个人周报\n\n${sections.join('\n\n')}`
}
