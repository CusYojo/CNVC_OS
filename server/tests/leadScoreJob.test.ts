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
