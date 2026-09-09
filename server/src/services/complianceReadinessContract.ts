import type { ComplianceSupplementDecision } from './complianceSupplementDecision.js'

export const COMPLIANCE_COMPONENT_LABELS = {
  fund_agreement: '基金协议适用条款及其证据尚未完整核验',
  transaction_terms: '最终交易条件及其证据尚未完整核验',
  return_investment: '返投口径、余额及测算尚未完整核验',
  concentration: '集中度口径、余额及测算尚未完整核验',
  related_party: '关联方范围及其证据尚未完整核验',
} as const

export type ComplianceReadinessReview = {
  status: string
  errors: string[]
  metrics: {
    components: Record<string, { gaps: string[]; errors: string[] }>
    pending_compliance_items: number[]
  }
}
export function finalizeComplianceReadiness(input: {
  components: Record<string, unknown>
  review: ComplianceReadinessReview
  asOfDate: string
  missingItems: string[]
  blockingIssues: string[]
  decision?: ComplianceSupplementDecision
}) {
  // Only the five reviewed components are copied. Model-supplied authorization,
  // status, dates and user identities can never become host authorization.
  const components = Object.fromEntries(Object.keys(COMPLIANCE_COMPONENT_LABELS)
    .map(key => [key, input.components[key] ?? { status: 'pending', source_ids: [] }]))
  const missing = [...input.missingItems]
  const blocks = [...input.blockingIssues]
  const unclassifiedErrors = input.review.errors.filter(error =>
    !Object.keys(COMPLIANCE_COMPONENT_LABELS).some(key => error.startsWith(`delivery_readiness.${key}:`))
    && !error.startsWith('compliance items remain evidence-limited:')
    && !error.startsWith('delivery_readiness contains unresolved material conflicts or known non-compliance:')
    && !error.includes('transaction investment_amount does not reconcile'))
  if (unclassifiedErrors.length || (input.review.status !== 'pass' && !input.review.errors.length)) {
    throw Object.assign(new Error('合规校验报告包含未识别的失败，不能自动放行'), { code: 'COMPLIANCE_REVIEW_INVALID' })
  }
  for (const [key, label] of Object.entries(COMPLIANCE_COMPONENT_LABELS)) {
    const item = input.review.metrics.components[key]
    if (!item || item.gaps.length) missing.push(label)
    if (item?.errors.length) blocks.push(`${label.split('尚未')[0]}存在数值或规则冲突，需核对后重试`)
  }
  if (input.review.errors.some(error => error.includes('transaction investment_amount does not reconcile'))) {
    blocks.push('交易投资金额与集中度测算使用金额不一致')
  }
  for (const item of input.review.metrics.pending_compliance_items) {
    missing.push(`投资情形分析第${item}项仍有待核验事项`)
  }
  const clean = (items: string[]) => [...new Set(items.map(item => item.trim()).filter(Boolean))]
  const missingItems = clean(missing)
  const blockingIssues = clean(blocks)
  const accepted = input.decision?.action === 'continue_with_gaps'
    ? new Set(input.decision.acceptedMissingItems) : new Set<string>()
  const authorized = !blockingIssues.length && missingItems.length > 0
    && missingItems.every(item => accepted.has(item))
  const status = blockingIssues.length ? 'blocked'
    : missingItems.length ? authorized ? 'proceed_with_available_materials' : 'awaiting_user_input' : 'ready'
  return {
    ...components,
    status, as_of_date: input.asOfDate,
    missing_decisive_inputs: missingItems, blocking_issues: blockingIssues,
    supplement_request: {
      requested: missingItems.length > 0,
      outcome: status === 'awaiting_user_input' ? 'awaiting_response'
        : authorized ? 'not_provided' : 'not_needed',
      requested_items: missingItems,
    },
    continuation_authorization: {
      authorized,
      basis: authorized ? 'explicit_user_instruction' : status === 'awaiting_user_input' ? 'awaiting_response' : 'not_required',
      ...(authorized ? { instruction: '用户已确认列明资料缺口，同意按现有资料继续生成，并保留待核验事项。' } : {}),
    },
  }
}
