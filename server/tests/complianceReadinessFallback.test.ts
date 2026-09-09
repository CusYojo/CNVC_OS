import assert from 'node:assert/strict'
import test from 'node:test'
import { deterministicPendingComplianceCandidate } from '../src/services/aiComplianceReadinessService.js'

test('deterministic compliance fallback never invents verified evidence or blockers', () => {
  const candidate = deterministicPendingComplianceCandidate('COMPLIANCE_REVIEW_FAILED') as Record<string, any>
  for (const key of ['fund_agreement', 'transaction_terms', 'return_investment', 'concentration', 'related_party']) {
    assert.equal(candidate[key].status, 'pending')
    assert.deepEqual(candidate[key].source_ids, [])
    assert.deepEqual(candidate[key].evidence_quotes, [])
  }
  assert.deepEqual(candidate.blocking_issues, [])
  assert.equal(candidate.review_fallback.mode, 'deterministic_pending')
})
