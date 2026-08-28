import { z } from 'zod'
import { fdeDate } from './fdeTaskContract.js'
import { FDE_PROJECT_DUTIES } from './fdeGovernanceContract.js'

// Candidate catalogue from the reference, not approved production templates.
// Government cooperation and fund management remain distinct pending DEC-003.
export const FDE_NON_INVESTMENT_TYPES = [
  { code: 'fundraising', name: '基金募资项目' }, { code: 'fund_management', name: '基金管理项目' },
  { code: 'lp_relations', name: 'LP 关系项目' }, { code: 'major_meeting', name: '重要会议项目' },
  { code: 'post_investment', name: '投后专项项目' }, { code: 'short_cycle', name: '短周期专项项目' },
  { code: 'government_industry', name: '政府及产业合作' },
] as const
export const typeCode = z.enum(['fundraising', 'fund_management', 'lp_relations', 'major_meeting', 'post_investment', 'short_cycle', 'government_industry'])
export const typeDuty = z.enum(['owner', ...FDE_PROJECT_DUTIES.map(item => item.code)] as ['owner', ...Array<typeof FDE_PROJECT_DUTIES[number]['code']>])
const key = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/), reason = z.string().trim().min(5).max(1000)
const calendar = z.object({
  basis: z.enum(['calendar', 'working']), workingWeekdays: z.array(z.number().int().min(0).max(6)).max(7),
  holidays: z.array(fdeDate).max(366), extraWorkingDates: z.array(fdeDate).max(366),
}).strict()
// Optional for existing, hash-bound definitions. No registration authority is
// inferred from a candidate type, system.manage, or an organization role name.
export const typeRegistrationPolicy = z.object({
  roleIds: z.array(z.string().uuid()).min(1).max(30).refine(ids => new Set(ids).size === ids.length, '登记角色不能重复'),
  ownership: z.literal('registrar'), classification: z.enum(['normal', 'key']),
  onDisable: z.literal('continue_bound_version'),
  ruleReference: z.string().trim().min(5).max(2000),
}).strict()
export const typePolicyDefinition = z.object({
  schemaVersion: z.literal(2), type: typeCode, timezone: z.literal('Asia/Shanghai'),
  registration: typeRegistrationPolicy.optional(),
  // Optional for historical definition hashes; execution requires an explicit
  // independently reviewed plan policy, never an inferred investment approver.
  planApprovals: z.array(z.object({ duty: typeDuty, name: z.string().trim().min(1).max(100), mode: z.enum(['会签', '或签']) }).strict()).min(1).max(12).optional(),
  cycleDays: z.array(z.union([z.literal(15), z.literal(30), z.literal(40), z.literal(50)])).min(1).max(4), calendar,
  stages: z.array(z.object({
    key, name: z.string().trim().min(1).max(16), outcome: z.string().trim().min(5).max(2000),
    allowWaiver: z.boolean(), materials: z.array(z.object({ key, label: z.string().trim().min(1).max(100) }).strict()).max(30),
    approvals: z.array(z.object({ duty: typeDuty, name: z.string().trim().min(1).max(100), mode: z.enum(['会签', '或签']) }).strict()).min(1).max(12),
  }).strict()).min(2).max(12),
  actions: z.array(z.object({ key, stageKey: key, title: z.string().trim().min(1).max(100), duty: typeDuty,
    deliverable: z.string().trim().min(5).max(2000), position: z.number().int().min(0).max(100), needLeader: z.boolean(),
  }).strict()).min(2).max(80),
}).strict().superRefine((value, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
  const unique = (items: Array<string | number>, label: string) => { if (new Set(items).size !== items.length) issue(`${label}不能重复`) }
  unique(value.cycleDays, '周期'); unique(value.stages.map(s => s.key), '阶段编号'); unique(value.stages.map(s => s.name), '阶段名称'); unique(value.actions.map(a => a.key), '行动编号')
  for (const name of ['workingWeekdays', 'holidays', 'extraWorkingDates'] as const) unique(value.calendar[name], '业务日历')
  if (value.calendar.holidays.some(d => value.calendar.extraWorkingDates.includes(d))) issue('同一天不能同时休息与补班')
  if (value.calendar.basis === 'calendar' && [value.calendar.workingWeekdays, value.calendar.holidays, value.calendar.extraWorkingDates].some(a => a.length)) issue('自然日模板不能暗含工作日日历')
  if (value.calendar.basis === 'working' && !value.calendar.workingWeekdays.length) issue('工作日模板必须明确每周工作日')
  const order = new Map(value.stages.map((s, i) => [s.key, i]))
  value.stages.forEach(s => {
    unique(s.materials.map(m => m.key), `${s.name}材料编号`)
    if (!value.actions.some(a => a.stageKey === s.key)) issue(`${s.name}至少需要一个可验收行动`)
  })
  let previousStage = -1, previousPosition = -1
  for (const action of value.actions) {
    const stage = order.get(action.stageKey)
    if (stage === undefined) issue('行动引用的阶段不存在')
    else { if (stage < previousStage) issue('行动须按阶段顺序排列'); previousStage = stage }
    if (action.position < previousPosition) issue('行动日期比例不得倒序'); previousPosition = action.position
  }
  if (value.actions.at(-1)?.position !== 100 || value.actions.at(-1)?.stageKey !== value.stages.at(-1)?.key) issue('最终验收行动必须对应最后阶段及目标日')
})
export type TypePolicyDefinition = z.infer<typeof typePolicyDefinition>
export const typePolicyName = (type: TypePolicyDefinition['type']) => FDE_NON_INVESTMENT_TYPES.find(t => t.code === type)!.name
export const typePolicyCode = (type: TypePolicyDefinition['type']) => `noninvestment:${type}`
const base = { commandId: z.string().uuid(), reason }
const version = { policyId: z.string().uuid(), versionId: z.string().uuid(), expectedVersion: z.number().int().positive() }
export const typePolicyCommand = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('create'), expectedPolicyVersion: z.number().int().nonnegative(), configuration: typePolicyDefinition }).strict(),
  z.object({ ...base, ...version, action: z.literal('save'), configuration: typePolicyDefinition }).strict(),
  z.object({ ...base, ...version, action: z.literal('approve') }).strict(),
  z.object({ ...base, ...version, action: z.literal('publish'), expectedPolicyVersion: z.number().int().positive() }).strict(),
  z.object({ ...base, ...version, action: z.literal('activate'), expectedPolicyVersion: z.number().int().positive() }).strict(),
  z.object({ ...base, ...version, action: z.literal('deactivate'), expectedPolicyVersion: z.number().int().positive() }).strict(),
])
export type TypePolicyCommand = z.infer<typeof typePolicyCommand>
export const typePolicyReceipt = z.object({ commandId: z.string().uuid(), action: z.enum(['create', 'save', 'approve', 'publish', 'activate', 'deactivate']), policyId: z.string().uuid(), versionId: z.string().uuid(), policyVersion: z.number().int().positive(), version: z.number().int().positive(), status: z.enum(['draft', 'approved', 'published']), enabled: z.boolean().optional() }).strict().superRefine((value, ctx) => {
  if (['activate', 'deactivate'].includes(value.action) && (value.status !== 'published' || value.enabled !== (value.action === 'activate'))) ctx.addIssue({ code: 'custom', message: '启停回执与动作不一致' })
})
export type TypePolicyReceipt = z.infer<typeof typePolicyReceipt>
export const typePolicyRecovery = z.object({ commandId: z.string().uuid() }).strict()
export const typePolicyPreview = z.object({ configuration: typePolicyDefinition, cycleDays: z.number().int(), targetDate: fdeDate }).strict()

// Pure preview: never creates a project/task or infers approvals from names.
export function previewTypePlan(raw: unknown) {
  const { configuration, cycleDays, targetDate } = typePolicyPreview.parse(raw)
  if (!configuration.cycleDays.includes(cycleDays as 15 | 30 | 40 | 50)) throw new Error('周期不属于该模板允许范围')
  const isWorking = (date: string) => configuration.calendar.extraWorkingDates.includes(date) || !configuration.calendar.holidays.includes(date) && configuration.calendar.workingWeekdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay())
  if (configuration.calendar.basis === 'working' && !isWorking(targetDate)) throw new Error('工作日模板的目标日必须是工作日，不静默顺延')
  const dates = [targetDate]
  for (let i = 1, instant = Date.parse(`${targetDate}T00:00:00Z`); dates.length <= cycleDays && i <= 3660; i++) {
    instant -= 86400000
    const date = new Date(instant).toISOString().slice(0, 10)
    if (configuration.calendar.basis === 'calendar' || isWorking(date)) dates.push(date)
  }
  if (dates.length <= cycleDays) throw new Error('业务日历无法在允许范围内生成计划')
  return { type: configuration.type, targetDate, cycleDays, startDate: dates[cycleDays], actions: configuration.actions.map(action => ({ ...action, dueDate: dates[Math.round(cycleDays * (100 - action.position) / 100)] })), persisted: false as const }
}
