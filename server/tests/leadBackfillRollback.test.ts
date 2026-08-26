import assert from 'node:assert/strict'
import test from 'node:test'
import { buildConditionalRollbackPatch } from '../src/services/leadBackfillRollbackService.js'

test('batch rollback restores only fields still equal to the applied snapshot', () => {
  const result = buildConditionalRollbackPatch({
    before: { round: '待核验', financing: '', sources: [{ url: 'old' }] },
    after: { round: '天使++轮', financing: '5亿元人民币', sources: [{ url: 'new' }] },
    current: { round: '天使++轮', financing: '人工改为6亿元', sources: [{ url: 'new' }] },
  })
  assert.deepEqual(result.patch, { round: '待核验', sources: [{ url: 'old' }] })
  assert.deepEqual(result.restored, ['round', 'sources'])
  assert.deepEqual(result.conflicts, [{ field: 'financing', reason: 'current value changed after this batch' }])
})

test('batch rollback is a no-op when the apply made no changes', () => {
  const state = { fundingRounds: [{ round: '天使++轮' }] }
  const result = buildConditionalRollbackPatch({ before: state, after: state, current: state })
  assert.deepEqual(result, { patch: {}, restored: [], conflicts: [] })
})

test('replaying an already completed batch rollback is idempotent', () => {
  const result = buildConditionalRollbackPatch({
    before: { round: '待核验' },
    after: { round: '天使++轮' },
    current: { round: '待核验' },
  })
  assert.deepEqual(result, { patch: {}, restored: [], conflicts: [] })
})
