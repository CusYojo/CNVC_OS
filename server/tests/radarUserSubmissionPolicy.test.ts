import assert from 'node:assert/strict'
import test from 'node:test'
import { radarUnavailableReviewTransition } from '../src/services/radarUserSubmissionPolicy.js'

test('keeps an explicit WeChat project submission in manual review when AI is unavailable', () => {
  assert.deepEqual(radarUnavailableReviewTransition({
    source: 'weixin_link',
    reviewStatus: 'failed',
    reason: 'gateway balance unavailable',
  }), {
    status: 'review',
    reason: 'gateway balance unavailable',
    error: null,
  })
})

test('keeps ordinary radar model failures retryable', () => {
  assert.deepEqual(radarUnavailableReviewTransition({
    source: 'rss',
    reviewStatus: 'failed',
    reason: 'gateway unavailable',
  }), {
    status: 'failed',
    reason: 'radar subject review failed',
    error: 'gateway unavailable',
  })
})
