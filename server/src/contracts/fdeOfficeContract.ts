import { z } from 'zod'
import { officeExecutionFields, officeExecutionPolicy } from './fdeOfficeExecutionContract.js'

export const officeKinds = ['出差', '用印', '报销', '请假', '合同'] as const
export const officeKind = z.enum(officeKinds)
const id = z.string().uuid()
const text = z.string().trim().max(2000)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}, '日期不存在')
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).refine(value => {
  const parsed = new Date(`${value}:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 16) === value
}, '时刻不存在')
export const officeMoney = z.string().regex(/^(0|[1-9]\d{0,10})(\.\d{1,2})?$/, '金额须为非负数，最多两位小数')
export const officeCents = (value: string) => { const [whole, fraction = ''] = officeMoney.parse(value).split('.'); return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) }
const currency = z.string().regex(/^[A-Z]{3}$/)
const ids = z.array(id).max(100).refine(values => new Set(values).size === values.length, '不能重复选择人员或附件')
const itineraryItem = z.object({ id, from: text.default(''), to: text.default(''), date, transport: z.enum(['高铁', '飞机', '自驾', '其他']).default('高铁') }).strict()
const travel = z.object({ kind: z.literal('出差'), travelerIds: ids.default([]), origin: text.default(''), destination: text.default(''), startDate: date.optional(), endDate: date.optional(), travelMode: z.enum(['高铁', '飞机', '自驾', '其他']).default('高铁'), itinerary: z.array(itineraryItem).max(20).default([]), budget: officeMoney.default('0'), currency: currency.default('CNY'), transportBudget: officeMoney.default('0'), lodgingBudget: officeMoney.default('0'), mealBudget: officeMoney.default('0'), otherBudget: officeMoney.default('0'), overageReason: text.default(''), purposeTemplate: text.default(''), invitationLink: z.string().trim().max(2000).default('') }).strict()
const seal = z.object({ kind: z.literal('用印'), entity: text.default('本公司'), sealType: text.default(''), purpose: text.default(''), purposeTemplate: text.default(''), fileTitle: text.default(''), copies: z.number().int().min(1).max(10000).optional(), handlerId: id.optional(), takeOut: z.boolean().default(false), takeOutAt: timestamp.optional(), returnAt: timestamp.optional() }).strict()
const expenseItem = z.object({ id, date, category: text.min(1), description: text.min(1), amount: officeMoney, invoiceNumber: z.string().trim().max(120).default(''), attachmentId: id.optional(), waterAttachmentId: id.optional(), verificationStatus: z.enum(['待核验', '已核验', '有疑点']).default('待核验') }).strict()
const expense = z.object({ kind: z.literal('报销'), currency: currency.default('CNY'), amount: officeMoney.default('0'), items: z.array(expenseItem).max(100).default([]), linkedRequestId: id.optional(), templateName: z.string().trim().max(120).default(''), invoiceLink: z.string().trim().max(2000).default(''), projectExplanation: text.default(''), proofLinks: z.array(z.string().trim().url('证明材料链接格式不正确').max(2000)).max(20).default([]) }).strict()
const leave = z.object({ kind: z.literal('请假'), leaveType: text.default(''), startAt: timestamp.optional(), endAt: timestamp.optional(), hours: z.string().regex(/^(0|[1-9]\d{0,3})(\.\d{1,2})?$/).optional(), handoverUserId: id.optional(), handover: text.default(''), deferProof: z.boolean().default(false), fallbackLeaveType: text.default('') }).strict()
const contract = z.object({ kind: z.literal('合同'), entity: text.default(''), counterparty: text.default(''), documentVersion: text.default(''), amount: officeMoney.default('0'), currency: currency.default('CNY'), startDate: date.optional(), endDate: date.optional(), purpose: text.default('') }).strict()
export const officeDetails = z.discriminatedUnion('kind', [travel, seal, expense, leave, contract])
export const officeDefinition = z.object({ title: z.string().trim().max(255), reason: z.string().trim().max(8000), projectId: id.nullable(), priority: z.enum(['普通', '重要', '紧急']), details: officeDetails, attachmentIds: ids }).strict()
export type OfficeDefinition = z.infer<typeof officeDefinition>
export const officeFieldNames: Record<typeof officeKinds[number], readonly string[]> = {
  出差: ['travelerIds', 'origin', 'startDate', 'endDate', 'destination', 'budget', 'currency'], 用印: ['entity', 'sealType', 'purpose', 'copies', 'handlerId', 'takeOutAt', 'returnAt'],
  报销: ['currency', 'amount', 'items'], 请假: ['leaveType', 'startAt', 'endAt', 'hours'], 合同: ['entity', 'counterparty', 'documentVersion', 'amount', 'currency', 'startDate', 'endDate', 'purpose'],
}
const routeNode = z.object({ key: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), name: z.string().trim().min(1).max(100), roleIds: ids.refine(v => v.length > 0), scope: z.enum(['institution', 'applicant_department']), mode: z.enum(['或签', '会签']), fixedUserIds: ids.default([]), allowTransfer: z.boolean() }).strict()
const condition = z.object({ departmentIds: ids.optional(), priorities: z.array(z.enum(['普通', '重要', '紧急'])).min(1).optional(), currency: currency.optional(), minimum: officeMoney.optional(), maximum: officeMoney.optional() }).strict().refine(c => !c.minimum || !c.maximum || officeCents(c.minimum) <= officeCents(c.maximum), '金额区间顺序错误')
export const officePolicyConfig = z.object({ kind: officeKind, execution: officeExecutionPolicy.optional(), requiredFields: z.array(z.string()).max(20), attachmentRequired: z.boolean(), rejectResubmission: z.boolean(), routes: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), when: condition, nodes: z.array(routeNode).min(1).max(12) }).strict()).min(1).max(30) }).strict().superRefine((value, ctx) => {
  if (value.execution?.requiredFields.some(key => !(officeExecutionFields[value.kind] as readonly string[]).includes(key))) ctx.addIssue({ code: 'custom', message: '执行字段不属于当前业务类型' })
  if (value.requiredFields.some(key => !officeFieldNames[value.kind].includes(key)) || new Set(value.requiredFields).size !== value.requiredFields.length) ctx.addIssue({ code: 'custom', message: '必填字段不属于当前业务类型或重复' })
  if (Object.keys(value.routes.at(-1)!.when).length) ctx.addIssue({ code: 'custom', message: '最后一条路由必须是不带条件的兜底规则' })
  if (value.routes.slice(0, -1).some(route => !Object.keys(route.when).length)) ctx.addIssue({ code: 'custom', message: '无条件规则只能放在最后' })
  if (new Set(value.routes.map(r => r.key)).size !== value.routes.length || value.routes.some(r => new Set(r.nodes.map(n => n.key)).size !== r.nodes.length)) ctx.addIssue({ code: 'custom', message: '路由和节点标识不能重复' })
  if (value.routes.some(r => (r.when.minimum || r.when.maximum) && !r.when.currency)) ctx.addIssue({ code: 'custom', message: '金额路由必须明确币种，不做隐式汇率转换' })
})
export type OfficePolicy = z.infer<typeof officePolicyConfig>
export type OfficeNodeRule = z.infer<typeof routeNode>
export function validateOfficeSubmission(definition: OfficeDefinition, policy: OfficePolicy) {
  const issues: string[] = [], details = definition.details as unknown as Record<string, unknown>
  if (definition.details.kind !== policy.kind) issues.push('申请类型与规则不符')
  if (!definition.title || definition.reason.length < 5) issues.push('标题和至少五字事由必填')
  for (const key of policy.requiredFields) if (details[key] == null || details[key] === '' || (Array.isArray(details[key]) && !(details[key] as unknown[]).length)) issues.push(`缺少必填字段：${key}`)
  if (policy.attachmentRequired && !definition.attachmentIds.length) issues.push('缺少证明附件')
  const d = definition.details
  if ((d.kind === '出差' || d.kind === '合同') && d.startDate && d.endDate && d.endDate < d.startDate) issues.push('结束日期不能早于开始日期')
  if (d.kind === '出差' && d.origin && d.destination && d.origin === d.destination) issues.push('出发城市与目的城市不能相同')
  if (d.kind === '出差' && d.itinerary.some((item, index) => index > 0 && item.date < d.itinerary[index - 1].date)) issues.push('多段行程时间顺序存在冲突')
  if (d.kind === '用印' && d.takeOut && (!d.takeOutAt || !d.returnAt)) issues.push('带出公司时必须填写带出和归还时间')
  if (d.kind === '用印' && d.takeOutAt && d.returnAt && d.returnAt <= d.takeOutAt) issues.push('印章归还时间必须晚于带出时间')
  if (d.kind === '请假' && d.startAt && d.endAt && d.endAt <= d.startAt) issues.push('请假结束必须晚于开始')
  if (d.kind === '报销') {
    const difference = d.items.reduce((sum, item) => sum + officeCents(item.amount), 0n) - officeCents(d.amount)
    if (difference > 100n || difference < -100n) issues.push('报销明细与总额偏差超过 1 元')
    const invoices = d.items.map(i => i.invoiceNumber).filter(Boolean)
    if (new Set(invoices).size !== invoices.length) issues.push('本申请内票据编号重复')
    if (new Set(d.items.map(i => i.id)).size !== d.items.length) issues.push('费用明细标识重复')
    if (d.items.some(i => i.attachmentId && !definition.attachmentIds.includes(i.attachmentId))) issues.push('票据附件必须属于本申请所选材料')
    if (d.items.some(i => i.waterAttachmentId && !definition.attachmentIds.includes(i.waterAttachmentId))) issues.push('消费水单必须属于本申请所选材料')
    if (d.items.some(i => officeCents(i.amount) >= 100000n && !i.waterAttachmentId)) issues.push('单张满 1000 元的票据需附消费水单')
  }
  return issues
}
export function officeRoute(definition: OfficeDefinition, policy: OfficePolicy, departmentIds: string[]) {
  const d = definition.details, money = d.kind === '出差' ? d.budget : d.kind === '报销' || d.kind === '合同' ? d.amount : '0', unit = 'currency' in d ? d.currency : null
  return policy.routes.find(({ when: w }) => (!w.departmentIds || w.departmentIds.some(id => departmentIds.includes(id))) && (!w.priorities || w.priorities.includes(definition.priority)) && (!w.currency || w.currency === unit) && (!w.minimum || officeCents(money) >= officeCents(w.minimum)) && (!w.maximum || officeCents(money) <= officeCents(w.maximum)))!
}
export const officeCommand = z.object({ clientRequestId: id, expectedVersion: z.number().int().positive(), reason: z.string().trim().min(5).max(2000) }).strict()
export const officeResolveCommand = z.object({ clientRequestId: id }).strict()
export const officeReceipt = z.object({ id, version: z.number().int().positive() }).strict()
export const officeResolution = z.discriminatedUnion('state', [
  z.object({ state: z.literal('committed'), receipt: officeReceipt }).strict(),
  z.object({ state: z.literal('not_applied') }).strict(),
])
export const officeSave = z.object({ clientRequestId: id, expectedVersion: z.number().int().min(0), definition: officeDefinition }).strict()
export const officeAction = officeCommand.extend({ action: z.enum(['submit', 'approve', 'return', 'reject', 'withdraw', 'delete', 'transfer']), targetUserId: id.optional(), expectedPolicyVersionId: id.optional(), expectedRouteHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), confirmAttachmentSharing: z.boolean().optional() }).strict()
export const officeGrantCommand = officeCommand.extend({ grants: z.array(z.object({ userId: id, canDownload: z.boolean() }).strict()).max(100).refine(rows => new Set(rows.map(r => r.userId)).size === rows.length) }).strict()
export const officeQuery = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), view: z.enum(['pending', 'tracking', 'processed', 'mine', 'draft', 'completed']).default('pending'), kind: officeKind.optional(), q: z.string().trim().max(100).default('') }).strict()
