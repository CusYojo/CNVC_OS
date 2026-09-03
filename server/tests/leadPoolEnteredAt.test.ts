import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveAuthoritativeLeadRegion,
  deriveDataUpdatedAt,
  deriveIndustryTags,
  derivePoolEnteredAt,
  LEAD_LIST_READ_TRANSACTION,
  literalLeadLikePattern,
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

test('uses other only as the complement of known industry rules', () => {
  assert.deepEqual(deriveIndustryTags('其他、医疗健康'), ['医疗健康'])
  assert.deepEqual(deriveIndustryTags('空间计算'), ['其他'])
  assert.deepEqual(deriveIndustryTags('待核验'), ['待确认'])
})

test('escapes SQL LIKE wildcards as literal lead-pool search text', () => {
  assert.equal(literalLeadLikePattern('100%_完成=是'), '%100=%=_完成==是%')
})

test('reads lead-list totals and rows in a repeatable read-only transaction', () => {
  assert.deepEqual(LEAD_LIST_READ_TRANSACTION, {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  })
})

test('list region uses only the authoritative stored business region', () => {
  assert.deepEqual(deriveAuthoritativeLeadRegion({
    businessRegion: '江苏省', businessRegionSource: '工商注册地', businessRegionConfidence: '高',
  }), { region: '江苏', source: '工商注册地', confidence: '高' })
  assert.equal(deriveAuthoritativeLeadRegion({ businessRegion: null }), null)
})
