import { z } from 'zod'

const id = z.string().uuid()
const ids = z.array(id).min(1).max(100).refine(v => new Set(v).size === v.length, '岗位或账号不能重复')
export const officeExecutionFields = {
  出差: ['reference', 'description'], 用印: ['reference', 'entity', 'sealType', 'copies', 'description'],
  报销: ['reference', 'amount', 'currency', 'description'], 请假: ['reference', 'description'],
  合同: ['reference', 'documentVersion', 'description'],
} as const
export const officeExecutionPolicy = z.object({
  enabled: z.boolean(), roleIds: ids, userIds: ids, scope: z.enum(['institution', 'applicant_department']),
  requiredFields: z.array(z.string().max(40)).max(10).refine(v => new Set(v).size === v.length),
  authorizationNote: z.string().trim().min(10).max(2000),
}).strict()
export type OfficeExecutionPolicy = z.infer<typeof officeExecutionPolicy>
export function officeExecutionAuthorized(policy: OfficeExecutionPolicy | undefined, userId: string, roleIds: string[], departmentIds: string[], applicantDepartments: string[]) {
  return Boolean(policy?.enabled && policy.userIds.includes(userId) && policy.roleIds.some(role => roleIds.includes(role))
    && (policy.scope === 'institution' || departmentIds.some(id => applicantDepartments.includes(id))))
}
export function officeAttachmentGrantAuthority(input: {
  purpose: string; uploadedBy: string; applicantId: string; userId: string; executionEligible: boolean
}) {
  // Read/download grants never imply ownership or permission to regrant.
  if (input.purpose === 'execution') return input.uploadedBy === input.userId && input.executionEligible
  return ['application', 'signed'].includes(input.purpose) && input.applicantId === input.userId
}
export const officeExecutionFile = z.object({ fileId: id, version: z.literal(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const officeExecutionCommand = z.object({
  clientRequestId: id, expectedVersion: z.number().int().positive(), expectedLatestId: id.nullable(),
  action: z.enum(['record', 'retry', 'correct']), outcome: z.enum(['succeeded', 'failed']),
  occurredAt: z.string().datetime({ offset: true }), reason: z.string().trim().min(5).max(2000),
  facts: z.record(z.string().max(40), z.string().trim().max(2000)),
  files: z.array(officeExecutionFile).min(1).max(30).refine(v => new Set(v.map(f => f.fileId)).size === v.length, '原件不能重复'),
}).strict()
export type OfficeExecutionCommand = z.infer<typeof officeExecutionCommand>
export function validateOfficeExecution(input: OfficeExecutionCommand, kind: keyof typeof officeExecutionFields, policy: OfficeExecutionPolicy,
  previous: { id: string; outcome: string } | null, approvedAt: Date, now = new Date()) {
  const issues: string[] = []
  if (!policy.enabled) issues.push('执行规则未启用')
  if (input.expectedLatestId !== (previous?.id ?? null)) issues.push('执行记录已变化')
  if (input.action === 'record' && previous) issues.push('已有执行记录，须明确重试或更正')
  if (input.action !== 'record' && !previous) issues.push('缺少待重试或更正的原记录')
  if (input.action === 'retry' && previous?.outcome !== 'failed') issues.push('仅失败记录允许登记新的重试事实')
  const time = Date.parse(input.occurredAt)
  if (!Number.isFinite(time) || time < approvedAt.getTime() || time > now.getTime()) issues.push('实际办理时间须在批准后且不晚于当前时间')
  const allowed = officeExecutionFields[kind] as readonly string[]
  if (Object.keys(input.facts).some(key => !allowed.includes(key))) issues.push('包含本类型未支持的执行字段')
  if (policy.requiredFields.some(key => !allowed.includes(key) || !input.facts[key])) issues.push('缺少规则要求的执行字段')
  if (input.facts.amount != null && !/^(0|[1-9]\d{0,10})(\.\d{1,2})?$/.test(input.facts.amount)) issues.push('实际金额格式不合法')
  if (input.facts.currency != null && !/^[A-Z]{3}$/.test(input.facts.currency)) issues.push('实际金额币种不合法')
  if (Boolean(input.facts.amount) !== Boolean(input.facts.currency)) issues.push('实际金额与币种必须同时填写')
  if (input.facts.copies != null && !/^[1-9]\d{0,3}$/.test(input.facts.copies)) issues.push('实际用印份数格式不合法')
  return issues
}
export const officeExecutionLabels = { record: '登记人工执行事实', retry: '登记失败后重试事实', correct: '更正原执行记录（保留原记录）' } as const
export type OfficeExecutionView = {
  canRecord: boolean; blockedReason: string; latestId: string | null; fields: readonly string[]; requiredFields: string[];
  records: Array<{ id: string; action: keyof typeof officeExecutionLabels; outcome: 'succeeded' | 'failed'; occurredAt: string; recordedAt: string; actorName: string; supersedesId: string | null; facts: Record<string, string>; reason: string; files: Array<{ fileId: string; version: 1; sha256: string; name: string }> }>;
  hasMore: boolean; hiddenRecords: number;
}
