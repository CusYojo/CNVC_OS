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
  const calendar = facts.calendar?.filter(item => item.source !== 'meeting' || !meetingIds.has(item.id))
  const states: Record<string, string> = { active: '已安排', confirmed: '领导已确认', scheduled: '已安排', completed: '会议纪要已确认', cancelled: '已取消', approved: '获批安排，非执行证明' }
  const officeBody = facts.office ? `办公申请与处理（当前修订；审批不代表执行完成）\n${facts.office.map(item => `- ${item.title}（${item.kind}，修订 ${item.revision}）：${item.status}；本周本人操作 ${item.actions.map(a => `${a.action} ${local(a.occurredAt)}`).join('、')}`).join('\n') || '本次范围无可读取的本周办公操作'}\n\n` : ''
  const calendarBody = calendar ? `日历安排（不代表已完成或实际出席）\n${calendar.map(item => `- ${item.title}：${states[item.status] ?? item.status}，${local(item.startsAt)} 至 ${item.endsAt ? local(item.endsAt) : '结束时间未记录'}${item.visibility === 'private' ? item.source === 'personal' ? '（私人来源，仅本人）' : item.source === 'office' ? '（按原申请权限）' : '（受限参会范围）' : ''}`).join('\n') || '本次范围无新增日历安排；已列会议不重复展示'}\n\n` : ''
  return `${facts.weekStart} 至 ${facts.weekEnd} 个人周报\n\n` +
    `本周完成：${m.completedInWeek} 项（按正式完成时间）\n本周到期：${m.dueInWeek} 项\n前期遗留未结束：${m.overdueOpen} 项（生成时状态）\n本周期限且现已取消：${m.cancelledDueInWeek} 项（不代表本周发生取消）\n本人项目审批操作：${m.approvalActions} 次\n本人参与会议记录：${m.meetingRecords} 条\n\n` +
    `任务进展\n${facts.tasks.map((task) => `- ${task.title}：${task.status}，有效期限 ${task.dueDate ?? '未设置'}${task.dueTime ? ` ${task.dueTime}` : ''}，进度 ${task.progress}%`).join('\n') || '本次范围无匹配记录'}\n\n` +
    `审批与会议\n${[...facts.approvals.map((item) => `- ${item.title}：${item.action}`), ...facts.meetings.map((item) => `- 会议记录：${item.title}`)].join('\n') || '本周无匹配记录'}\n\n` + officeBody + calendarBody + (facts.milestones ? milestoneReportBody(facts.milestones) : '') + `阻塞与需要支持\n请人工补充。\n\n下周计划\n请人工补充。`
}
