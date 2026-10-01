import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProjectDiscoveryScore, fundingAmountDiscoveryScore } from '../src/services/projectDiscoveryScore.js'
import { LEAD_RATING_DIMENSIONS } from '../src/services/leadRatingV3Service.js'

const rating = {
  schemaVersion: 'lead-rating-v3',
  computed: { ratingStatus: '正式评级' },
  detailView: { dimensionScores: [
    { key: 'technology_rd', score: 8.5, assessment: '核心工艺已通过中试验证' },
    { key: 'industry_policy_space', score: 7.5, assessment: '应用场景处于扩张期' },
  ] },
}

test('discovery score uses four evidence-backed dimensions and weighted coverage', () => {
  const score = buildProjectDiscoveryScore({
    institutions: [{ name: '甲基金', major: true }],
    financing: { latestAmountValue: 100_000_000, latestAmountCurrency: 'CNY' },
    ratingV3: rating,
  })
  assert.equal(score.overall, 84.5)
  assert.deepEqual(score.dimensions.map((item) => [item.key, item.score, item.status]), [
    ['investor', 90, 'ready'], ['funding', 90, 'ready'],
    ['frontier', 75, 'ready'], ['technology', 85, 'ready'],
  ])
  assert.equal(score.coverage, 4)
})

test('discovery score leaves unknown dimensions unscored and does not fabricate a composite', () => {
  const score = buildProjectDiscoveryScore({
    institutions: [{ name: '无词典依据基金', major: false }],
    financing: { latestAmount: '近亿元', latestAmountCurrency: 'CNY' },
    ratingV3: { ...rating, status: 'stale' },
  })
  assert.equal(score.overall, null)
  assert.equal(score.coverage, 0)
  assert.ok(score.dimensions.every((item) => item.status === 'insufficient' && item.score === null))
})

test('research-only ratings remain a clearly partial composite and foreign currencies are not silently compared', () => {
  const score = buildProjectDiscoveryScore({
    institutions: [],
    financing: { latestAmountValue: 100_000_000, latestAmountCurrency: 'USD' },
    ratingV3: rating,
  })
  assert.equal(score.overall, 80.8)
  assert.equal(score.coverage, 2)
  assert.equal(score.dimensions[1].score, null)
})

test('full institution projection flag survives a shortened display institution list', () => {
  const score = buildProjectDiscoveryScore({
    institutions: [{ name: '普通机构', major: false }],
    hasMajorInstitution: true,
    ratingV3: rating,
  })
  assert.equal(score.dimensions[0].score, 90)
  assert.equal(score.overall, 83.1)
  assert.match(score.dimensions[0].evidence, /机构词典/)
})

test('funding bands and rating dimension positions remain consistent with database sort expression', () => {
  assert.equal(LEAD_RATING_DIMENSIONS[2].key, 'technology_rd')
  assert.equal(LEAD_RATING_DIMENSIONS[3].key, 'industry_policy_space')
  assert.deepEqual([500_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000]
    .map((value) => fundingAmountDiscoveryScore(value, 'CNY')), [45, 60, 75, 90, 100])
  assert.equal(fundingAmountDiscoveryScore(0, 'CNY'), null)
  assert.equal(fundingAmountDiscoveryScore(Number.NaN, 'CNY'), null)
})
