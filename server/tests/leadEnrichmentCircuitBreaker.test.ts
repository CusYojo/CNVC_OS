import assert from 'node:assert/strict'
import test from 'node:test'
import { createLeadEnrichmentCircuitBreaker } from '../src/services/leadEnrichmentCircuitBreaker.js'

test('lead enrichment gateway circuit opens at threshold and blocks until cooldown', () => {
  let now = Date.parse('2026-08-26T00:00:00.000Z')
  const circuit = createLeadEnrichmentCircuitBreaker({ failureThreshold: 3, cooldownMs: 10_000, now: () => now })
  assert.equal(circuit.canRequest(), true)
  circuit.recordFailure('network')
  circuit.recordFailure('rate_limit')
  assert.equal(circuit.snapshot().open, false)
  const opened = circuit.recordFailure('model')
  assert.equal(opened.open, true)
  assert.equal(opened.consecutiveFailures, 3)
  assert.equal(circuit.canRequest(), false)
  now += 9_999
  assert.equal(circuit.canRequest(), false)
  now += 1
  assert.equal(circuit.canRequest(), true)
  assert.equal(circuit.snapshot().openUntil, null)
})

test('non-gateway errors do not open the circuit and success resets failures', () => {
  const circuit = createLeadEnrichmentCircuitBreaker({ failureThreshold: 2 })
  circuit.recordFailure('validation')
  assert.equal(circuit.snapshot().consecutiveFailures, 0)
  circuit.recordFailure('network')
  assert.equal(circuit.snapshot().consecutiveFailures, 1)
  const reset = circuit.recordSuccess()
  assert.equal(reset.consecutiveFailures, 0)
  assert.equal(reset.open, false)
})

test('provider billing failure pauses new gateway work immediately without treating local budget as global', () => {
  let now = Date.parse('2026-08-26T00:00:00.000Z')
  const circuit = createLeadEnrichmentCircuitBreaker({
    failureThreshold: 5, cooldownMs: 10_000, billingCooldownMs: 60_000, now: () => now,
  })
  circuit.recordFailure('budget')
  assert.equal(circuit.snapshot().open, false)
  const opened = circuit.recordFailure('billing')
  assert.equal(opened.open, true)
  assert.equal(opened.openReason, 'billing')
  assert.equal(opened.consecutiveFailures, 5)
  assert.equal(circuit.canRequest(), false)
  now += 60_000
  assert.equal(circuit.canRequest(), true)
  assert.equal(circuit.snapshot().openReason, null)
})
