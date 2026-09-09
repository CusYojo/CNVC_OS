import assert from 'node:assert/strict'
import test from 'node:test'
import { COMPLIANCE_COMPONENT_LABELS, finalizeComplianceReadiness, type ComplianceReadinessReview } from '../src/services/complianceReadinessContract.js'
import { complianceSupplementSnapshot, decideComplianceSupplement } from '../src/services/complianceSupplementDecision.js'
import { bindComplianceReadinessEvidence } from '../src/services/aiComplianceReadinessService.js'

const review: ComplianceReadinessReview = {
  status: 'pass', errors: [], metrics: {
    components: Object.fromEntries(Object.keys(COMPLIANCE_COMPONENT_LABELS).map(key => [key, { gaps: [], errors: [] }])),
    pending_compliance_items: [],
  },
}
const base = { components: {}, review, asOfDate: '2026-09-07', missingItems: ['公开记录尚未核验'], blockingIssues: [] }
const snapshot = complianceSupplementSnapshot({ taskId: 'synthetic-task', projectId: 'synthetic-project', missingItems: base.missingItems, blockingIssues: [] })
const decision = decideComplianceSupplement({ snapshot, choice: { action: 'continue_with_gaps', snapshotId: snapshot.snapshotId }, actorId: 'synthetic-user', decidedAt: new Date('2026-09-07T00:00:00Z') })

test('readiness requires explicit consent for all current gaps and never inherits model authorization', () => {
  assert.equal(finalizeComplianceReadiness(base).status, 'awaiting_user_input')
  const accepted = finalizeComplianceReadiness({ ...base, decision, components: { status: 'ready', continuation_authorization: { authorized: true } } })
  assert.equal(accepted.status, 'proceed_with_available_materials')
  assert.equal(accepted.continuation_authorization.authorized, true)
  assert.equal(finalizeComplianceReadiness({ ...base, decision, missingItems: [...base.missingItems, '新缺口'] }).status, 'awaiting_user_input')
  assert.equal(finalizeComplianceReadiness({ ...base, decision, blockingIssues: ['已知禁止性冲突'] }).status, 'blocked')
})
test('native calculation conflicts and missing components remain visible', () => {
  const modified = structuredClone(review)
  modified.metrics.components.concentration.errors = ['post investment ratio exceeds limit']
  modified.metrics.components.fund_agreement.gaps = ['missing clauses']
  const result = finalizeComplianceReadiness({ ...base, review: modified, decision })
  assert.equal(result.status, 'blocked')
  assert.ok(result.missing_decisive_inputs.includes(COMPLIANCE_COMPONENT_LABELS.fund_agreement))
  assert.ok(result.blocking_issues.length)
  assert.equal(result.continuation_authorization.authorized, false)
  assert.throws(() => finalizeComplianceReadiness({ ...base, review: { ...review, status: 'fail', errors: ['unknown native failure'] }, decision }), { code: 'COMPLIANCE_REVIEW_INVALID' })
})

test('invalid references or invented quotations cannot mark components verified, but numbers remain for conflict review', () => {
  const sources = [{ sourceId: 'actual', sourceType: 'test', sourceName: '合成证据', content: '合成资料明确列明本次交易投资金额为十万元。' }]
  const component = { status: 'verified', source_ids: ['actual'], evidence_quotes: [{ source_id: 'actual', quote: '本次交易投资金额为十万元' }], calculation: { denominator: 100, post_investment_ratio: 0.5, limit_ratio: 0.1 } }
  const good = bindComplianceReadinessEvidence({ concentration: component }, sources).components.concentration as typeof component
  assert.equal(good.status, 'verified')
  assert.equal((bindComplianceReadinessEvidence({ concentration: component }, [...sources, { ...sources[0], content: '同一文件的另一资料分块。' }]).components.concentration as typeof component).status, 'verified')
  for (const invalid of [{ ...component, source_ids: ['invented'] }, { ...component, evidence_quotes: [{ source_id: 'actual', quote: '不存在的核验原文' }] }]) {
    const result = bindComplianceReadinessEvidence({ concentration: invalid }, sources).components.concentration as typeof component
    assert.equal(result.status, 'pending')
    assert.deepEqual(result.source_ids, [])
    assert.deepEqual(result.calculation, component.calculation)
  }
})
