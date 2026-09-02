import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveDataUpdatedAt,
  deriveIndustryTags,
  derivePoolEnteredAt,
} from '../src/services/aiSummaryService.js'

test('uses the database insertion timestamp as the pool entry time', () => {
  const createdAt = new Date('2026-07-31T03:08:00.949Z')
  assert.equal(derivePoolEnteredAt(createdAt), '2026-07-31T03:08:00.949Z')
})

test('does not invent a pool entry time when the timestamp is missing', () => {
  assert.equal(derivePoolEnteredAt(null), '')
  assert.equal(derivePoolEnteredAt(new Date('invalid')), '')
})

test('uses the latest rating timestamp in the displayed update date', () => {
  assert.equal(deriveDataUpdatedAt({
    ratingV3: { scoredAt: '2026-09-02T01:00:00.000Z' },
    scored_at: '2026-08-25T01:00:00.000Z',
  }, {
    publishedAt: '2026-08-20T01:00:00.000Z',
  }, new Date('2026-08-15T01:00:00.000Z')), '2026-09-02')
})

test('projects normalized source-sector labels into visible industry tags', () => {
  assert.deepEqual(deriveIndustryTags(
    '前沿技术、医疗健康',
    ['artificial_intelligence'],
  ), ['人工智能', '前沿技术', '医疗健康'])
})
