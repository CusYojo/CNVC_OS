import assert from 'node:assert/strict'
import test from 'node:test'
import { leadEnrichmentRetryDecision } from '../src/services/leadEnrichmentRetryPolicy.js'

test('lead enrichment retry policy classifies failures and applies category-specific backoff', () => {
  assert.deepEqual(leadEnrichmentRetryDecision({
    error: Object.assign(new Error('HTTP 429'), { category: 'rate_limit' }), executionAttempts: 2, maxAttempts: 4,
  }), { errorClass: 'rate_limit', retry: true, retrySeconds: 240, terminalStatus: 'retrying' })
  assert.deepEqual(leadEnrichmentRetryDecision({
    error: Object.assign(new Error('gateway timeout'), { category: 'network' }), executionAttempts: 2, maxAttempts: 4,
  }), { errorClass: 'network', retry: true, retrySeconds: 60, terminalStatus: 'retrying' })
  assert.deepEqual(leadEnrichmentRetryDecision({
    error: Object.assign(new Error('invalid JSON'), { category: 'parse' }), executionAttempts: 2, maxAttempts: 4,
  }), { errorClass: 'parse', retry: true, retrySeconds: 30, terminalStatus: 'retrying' })
})

test('lead enrichment retry policy dead-letters permanent, budget and exhausted failures', () => {
  for (const input of [
    { error: Object.assign(new Error('budget exceeded'), { category: 'budget' }), executionAttempts: 1, maxAttempts: 4 },
    { error: Object.assign(new Error('invalid subject'), { retryable: false }), executionAttempts: 1, maxAttempts: 4 },
    { error: Object.assign(new Error('model unavailable'), { category: 'model' }), executionAttempts: 4, maxAttempts: 4 },
  ]) {
    const decision = leadEnrichmentRetryDecision(input)
    assert.equal(decision.retry, false)
    assert.equal(decision.retrySeconds, 0)
    assert.equal(decision.terminalStatus, 'dead_letter')
  }
})

test('provider credit exhaustion overrides a generic gateway category and never retries', () => {
  for (const error of [
    Object.assign(new Error('联网搜索网关 403：令牌额度不足：需要 0.0251，可用 0.0032'), { category: 'network' }),
    Object.assign(new Error('insufficient quota for this request'), { code: 'insufficient_quota', category: 'model' }),
    Object.assign(new Error('payment required: credit balance exhausted'), { category: 'network' }),
  ]) {
    assert.deepEqual(leadEnrichmentRetryDecision({ error, executionAttempts: 1, maxAttempts: 3 }), {
      errorClass: 'budget', retry: false, retrySeconds: 0, terminalStatus: 'dead_letter',
    })
  }
})
