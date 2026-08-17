import assert from 'node:assert/strict'
import test from 'node:test'
import { readLeadScoreJob } from '../src/services/aiSummaryService.js'

test('restores persisted score retry metadata safely', () => {
  assert.deepEqual(readLeadScoreJob({
    scoreJob: {
      status: 'retrying',
      attempts: 3,
      maxAttempts: 3,
      retryCycles: 2,
      updatedAt: '2026-07-29T03:00:00.000Z',
      nextRetryAt: '2026-07-29T03:02:00.000Z',
    },
  }), {
    status: 'retrying',
    attempts: 3,
    maxAttempts: 3,
    retryCycles: 2,
    queuedAt: undefined,
    startedAt: undefined,
    updatedAt: '2026-07-29T03:00:00.000Z',
    completedAt: undefined,
    nextRetryAt: '2026-07-29T03:02:00.000Z',
    error: undefined,
  })
})

test('rejects unknown persisted score states', () => {
  assert.equal(readLeadScoreJob({ scoreJob: { status: 'unknown' } }), null)
})

test('restores a persisted lead score dead letter for explicit manual retry', () => {
  const restored = readLeadScoreJob({
    scoreJob: {
      status: 'dead_letter',
      attempts: 3,
      maxAttempts: 3,
      retryCycles: 1,
      updatedAt: '2026-08-09T04:00:00.000Z',
      completedAt: '2026-08-09T04:00:00.000Z',
      error: 'automatic retry limit exhausted',
    },
  })
  assert.equal(restored?.status, 'dead_letter')
  assert.equal(restored?.attempts, 3)
  assert.equal(restored?.error, 'automatic retry limit exhausted')
})
