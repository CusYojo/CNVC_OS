import { createHash } from 'node:crypto'
import type { ComplianceSupplementChoice, ComplianceSupplementSnapshot } from '../contracts/complianceSupplementContract.js'

function reject(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, status: 409 })
}

// Repeated HTTP requests may have a new timestamp, but must describe the exact
// same decision. Never silently reuse a different choice under one retry key.
export function assertSameComplianceDecision(existing: unknown, expected: ReturnType<typeof decideComplianceSupplement>) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    reject('COMPLIANCE_DECISION_CONFLICT', '确认记录不一致，请刷新后重新提交')
  }
  const record = existing as Record<string, unknown>
  const keys = ['sourceTaskId', 'projectId', 'snapshotId', 'actorId', 'action',
    'acceptedMissingItems', 'supplementText', 'requiresEvidenceReview'] as const
  if (keys.some(key => JSON.stringify(record[key]) !== JSON.stringify(expected[key]))) {
    reject('COMPLIANCE_DECISION_CONFLICT', '同一次重试不能提交不同选择，请刷新后重新提交')
  }
}

export type ComplianceSupplementDecision = ReturnType<typeof decideComplianceSupplement>

// Rebuild from the current server-side snapshot rather than trusting persisted
// flags. This also rejects a decision from another user, task, or project.
export function restoreComplianceSupplementDecision(input: {
  record: unknown; snapshot: ComplianceSupplementSnapshot; actorId: string
}): ComplianceSupplementDecision {
  if (!input.record || typeof input.record !== 'object' || Array.isArray(input.record)) {
    reject('COMPLIANCE_DECISION_INVALID', '用户确认记录不可用，请重新确认')
  }
  const record = input.record as Record<string, unknown>
  if (typeof record.decidedAt !== 'string' || typeof record.snapshotId !== 'string'
    || (record.action !== 'supplement' && record.action !== 'continue_with_gaps')
    || typeof record.supplementText !== 'string') {
    reject('COMPLIANCE_DECISION_INVALID', '用户确认记录格式无效，请重新确认')
  }
  const decision = decideComplianceSupplement({
    snapshot: input.snapshot, actorId: input.actorId,
    decidedAt: new Date(record.decidedAt),
    choice: { action: record.action, snapshotId: record.snapshotId, supplementText: record.supplementText },
  })
  assertSameComplianceDecision(record, decision)
  return decision
}

// Input must come from the owned task's server-side evidence review, never from
// client-supplied missingItems or model-generated authorization fields.
export function complianceSupplementSnapshot(input: {
  taskId: string; projectId: string; missingItems: string[]; blockingIssues: string[]
}): ComplianceSupplementSnapshot {
  const clean = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))]
  const data = { taskId: input.taskId, projectId: input.projectId,
    missingItems: clean(input.missingItems), blockingIssues: clean(input.blockingIssues) }
  return { ...data, snapshotId: createHash('sha256').update(JSON.stringify(data)).digest('hex') }
}

// The authenticated route supplies actorId. A retry without a choice is not
// consent. This returns an audit decision, not a claim of verified compliance.
export function decideComplianceSupplement(input: {
  snapshot: ComplianceSupplementSnapshot
  choice: ComplianceSupplementChoice
  actorId: string
  decidedAt: Date
}) {
  const { snapshot, choice } = input
  if (!input.actorId.trim() || !Number.isFinite(input.decidedAt.getTime())) {
    reject('COMPLIANCE_DECISION_INVALID', '无法记录有效的用户确认信息')
  }
  if (choice.snapshotId !== snapshot.snapshotId) {
    reject('COMPLIANCE_GAPS_CHANGED', '资料缺口已变化，请刷新后重新确认')
  }
  if (choice.action !== 'supplement' && choice.action !== 'continue_with_gaps') {
    reject('COMPLIANCE_DECISION_INVALID', '请选择补充资料或按现有资料继续生成')
  }
  if (choice.action === 'continue_with_gaps' && snapshot.blockingIssues.length) {
    reject('COMPLIANCE_BLOCKING_CONFLICT', '存在重大冲突，不能按现有资料直接生成')
  }
  if (choice.action === 'continue_with_gaps' && !snapshot.missingItems.length) {
    reject('COMPLIANCE_NO_GAPS_TO_ACCEPT', '当前没有需要确认的资料缺口')
  }
  const supplementText = choice.supplementText?.trim() ?? ''
  if (supplementText.length > 2000) reject('COMPLIANCE_DECISION_INVALID', '补充信息不能超过 2000 字')
  if (choice.action === 'supplement' && !supplementText) {
    reject('COMPLIANCE_SUPPLEMENT_REQUIRED', '请先填写补充信息或完成材料上传')
  }
  return {
    sourceTaskId: snapshot.taskId, projectId: snapshot.projectId,
    snapshotId: snapshot.snapshotId, actorId: input.actorId,
    decidedAt: input.decidedAt.toISOString(), action: choice.action,
    acceptedMissingItems: choice.action === 'continue_with_gaps' ? [...snapshot.missingItems] : [],
    supplementText: choice.action === 'supplement' ? supplementText : '',
    requiresEvidenceReview: true,
  }
}
