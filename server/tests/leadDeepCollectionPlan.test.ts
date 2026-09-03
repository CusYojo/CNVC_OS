import assert from 'node:assert/strict'
import test from 'node:test'
import {
  leadDeepCollectionGapTopics,
  planLeadDeepCollection,
} from '../src/services/leadDeepCollectionPlan.js'

const now = new Date('2026-09-03T00:00:00.000Z')

test('selects a visible lead that has never produced the current snapshot', () => {
  const plan = planLeadDeepCollection({
    snapshot: null, hasActiveJob: false, maxAgeDays: 30, retryGaps: false, force: false, now,
  })
  assert.equal(plan.selected, true)
  assert.deepEqual(plan.reasons, ['no_current_snapshot'])
})

test('keeps a fresh ready snapshot out of the default collection batch', () => {
  const plan = planLeadDeepCollection({
    snapshot: {
      status: 'ready', topicStates: { basic_profile: 'completed' }, coverage: 100,
      createdAt: '2026-09-02T00:00:00.000Z',
    },
    hasActiveJob: false, maxAgeDays: 30, retryGaps: false, force: false, now,
  })
  assert.equal(plan.selected, false)
  assert.deepEqual(plan.reasons, [])
})

test('selects a stale snapshot by configured freshness window', () => {
  const plan = planLeadDeepCollection({
    snapshot: {
      status: 'ready', topicStates: {}, coverage: 100,
      createdAt: '2026-07-01T00:00:00.000Z',
    },
    hasActiveJob: false, maxAgeDays: 30, retryGaps: false, force: false, now,
  })
  assert.equal(plan.selected, true)
  assert.deepEqual(plan.reasons, ['snapshot_stale'])
  assert((plan.snapshotAgeDays ?? 0) > 60)
})

test('retries only product-visible gap topics when explicitly enabled', () => {
  const topicStates = {
    basic_profile: 'completed', financing: 'partial', team: 'review',
    customers_contracts: 'missing', technology_ip: 'failed', industrialization: 'review',
    competition: 'missing', transaction_exit: 'failed', financial_operations: 'missing', market_policy: 'failed',
  }
  assert.deepEqual(leadDeepCollectionGapTopics(topicStates), ['financing', 'team'])
  const plan = planLeadDeepCollection({
    snapshot: { status: 'review', topicStates, coverage: 80, createdAt: '2026-09-02T00:00:00.000Z' },
    hasActiveJob: false, maxAgeDays: 30, retryGaps: true, force: false, now,
  })
  assert.equal(plan.selected, true)
  assert.deepEqual(plan.reasons, ['snapshot_has_gaps'])
})

test('never duplicates an active current-schema job even when forced', () => {
  const plan = planLeadDeepCollection({
    snapshot: null, hasActiveJob: true, maxAgeDays: 30, retryGaps: true, force: true, now,
  })
  assert.equal(plan.selected, false)
  assert.deepEqual(plan.reasons, ['forced_refresh', 'no_current_snapshot'])
})
