import { z } from 'zod'
import { fdeDate } from './fdeTaskContract.js'

const id = z.string().uuid()
const clock = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).refine(value => {
  const date = new Date(`${value}:00Z`)
  return Number(value.slice(0, 4)) >= 1900 && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 16) === value
}, '请输入有效的上海日期及时间')
const ids = z.array(id).min(1).max(100).refine(values => new Set(values).size === values.length, '账号不能重复')
export const committeeFileRef = z.object({ fileId: id, version: z.number().int().positive() }).strict()
export const committeeDefinition = z.object({
  title: z.string().trim().min(2).max(255), hostUserId: id, startsAt: clock, endsAt: clock,
  ruleNote: z.string().trim().min(5).max(2000), materialCheckAt: clock.nullable(),
  agendas: z.array(z.object({ id, projectId: id, title: z.string().trim().min(2).max(255),
    participantIds: ids, materials: z.array(committeeFileRef).max(30).refine(rows => new Set(rows.map(row => row.fileId)).size === rows.length, '同议题文件不能重复'),
  }).strict()).min(1).max(20),
}).strict().superRefine((value, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (value.endsAt <= value.startsAt) issue('结束时间必须晚于开始时间')
  if (Date.parse(`${value.endsAt}:00+08:00`) - Date.parse(`${value.startsAt}:00+08:00`) > 7 * 86400000) issue('单场会议时段不能超过七天')
  if (value.materialCheckAt && value.materialCheckAt > value.startsAt) issue('材料检查时点不能晚于开会时间')
  if (new Set(value.agendas.map(row => row.id)).size !== value.agendas.length) issue('议题编号不能重复')
  if (!value.agendas.some(row => row.participantIds.includes(value.hostUserId))) issue('主持人必须明确加入至少一个议题，不隐式获得其他议题权限')
})
export type CommitteeDefinition = z.infer<typeof committeeDefinition>
const base = { commandId: id, reason: z.string().trim().min(5).max(2000) }
const existing = { meetingId: id, expectedVersion: z.number().int().positive() }
export const committeeCommand = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('create'), definition: committeeDefinition }).strict(),
  z.object({ ...base, ...existing, action: z.literal('save'), definition: committeeDefinition }).strict(),
  z.object({ ...base, ...existing, action: z.enum(['check_materials', 'schedule', 'complete', 'cancel', 'archive']) }).strict(),
  z.object({ ...base, ...existing, action: z.literal('record'), agendaId: id, minutes: z.string().trim().min(5).max(10000), minutesFile: committeeFileRef,
    resolutionNote: z.string().trim().max(10000), resolutionFile: committeeFileRef.nullable(), approvalId: id.nullable(),
  }).strict(),
  // An append-only link before archive, never a command to amend minutes,
  // replace an existing decision, vote, or advance the investment project.
  z.object({ ...base, ...existing, action: z.literal('link_decision'), agendaId: id, resolutionFile: committeeFileRef, approvalId: id }).strict(),
]).superRefine((value, ctx) => {
  if (value.action === 'record' && Boolean(value.resolutionFile) !== Boolean(value.approvalId)) ctx.addIssue({ code: 'custom', message: '正式决议原件与对应审批须同时关联' })
})
export type CommitteeCommand = z.infer<typeof committeeCommand>
export const committeeReceipt = z.object({ commandId: id, meetingId: id, version: z.number().int().positive(),
  action: z.enum(['create', 'save', 'check_materials', 'schedule', 'record', 'link_decision', 'complete', 'cancel', 'archive']),
}).strict()
export type CommitteeReceipt = z.infer<typeof committeeReceipt>
export const committeeRecovery = z.object({ commandId: id }).strict()
export const committeeQuery = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
  view: z.enum(['active', 'archived', 'all']).default('active'), q: z.string().trim().max(100).default(''), date: fdeDate.optional(),
}).strict()
export const committeeLabels = { draft: '草案', scheduled: '待召开', completed: '纪要已确认', cancelled: '已取消' } as const
export const committeeActionLabels = { create: '创建草案', save: '保存或改期', check_materials: '核对材料', schedule: '确认排期', record: '记录议题纪要', link_decision: '追加正式审批关联', complete: '确认会议纪要', cancel: '取消会议', archive: '归档' } as const

const pageQuery = { page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20), q: z.string().trim().max(100).default('') }
export const committeeHistoryQuery = z.object(pageQuery).strict()
export const committeeOptionsQuery = z.object({ ...pageQuery, projectId: id.optional(), kind: z.enum(['all', 'people', 'files', 'approvals']).default('all') }).strict().superRefine((value, ctx) => {
  if (!value.projectId && value.kind !== 'all') ctx.addIssue({ code: 'custom', message: '人员、原件和审批候选须指定项目' })
})
export function committeePageWindow(total: number, requestedPage: number, pageSize: number) {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('分页计数无效')
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)))
  return { total, page, pageSize, hasMore: page * pageSize < total, offset: (page - 1) * pageSize }
}
export const committeeSearchPattern = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`
// State-only predicate. Callers must additionally check current actor, project,
// agenda, original files and the independently approved investment request.
export function committeeCanAppendDecision(value: { status: string; archived: boolean; recorded: boolean; hasMinutes: boolean; linked: boolean }) {
  return value.status === 'completed' && !value.archived && value.recorded && value.hasMinutes && !value.linked
}
export const committeeEditorAccessQuery = z.object({
  action: committeeReceipt.shape.action,
  meetingId: id.optional(), agendaId: id.optional(),
  projectIds: z.array(id).max(20),
  files: z.array(z.object({ projectId: id, ...committeeFileRef.shape }).strict()).max(660),
  participants: z.array(z.object({ projectId: id, userId: id }).strict()).max(2000),
}).strict().superRefine((value, ctx) => {
  if ((value.action !== 'create') !== Boolean(value.meetingId)) ctx.addIssue({ code: 'custom', message: '编辑权限核对缺少对应会议' })
  if (['record', 'link_decision'].includes(value.action) !== Boolean(value.agendaId)) ctx.addIssue({ code: 'custom', message: '议题操作须绑定原议题' })
})
