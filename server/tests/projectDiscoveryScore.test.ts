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
    institutions: [{ name: 'IDG资本', role: 'lead' }],
    financing: { latestAmountValue: 100_000_000, latestAmountCurrency: 'CNY', latestRound: 'A轮' },
    ratingV3: rating,
  })
  assert.equal(score.overall, 83.5)
  assert.deepEqual(score.dimensions.map((item) => [item.key, item.score, item.status]), [
    ['investor', 95, 'ready'], ['funding', 80, 'ready'],
    ['frontier', 75, 'ready'], ['technology', 85, 'ready'],
  ])
  assert.equal(score.coverage, 4)
})

test('discovery score leaves unknown dimensions unscored and does not fabricate a composite', () => {
  const score = buildProjectDiscoveryScore({
    institutions: [],
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
  assert.equal(score.overall, null)
  assert.equal(score.coverage, 2)
  assert.equal(score.dimensions[1].score, null)
})

test('institution score follows published rank bands and rewards a verified lead investor only once', () => {
  const score = buildProjectDiscoveryScore({
    institutions: [{ name: 'IDG资本', role: 'lead' }, { name: '锡创投', role: 'follow' }],
    ratingV3: rating,
  })
  assert.equal(score.dimensions[0].score, 95)
  assert.match(score.dimensions[0].evidence, /2025|TOP100|Top100/u)
  assert.equal(score.dimensions[0].sourceUrl, 'https://www.chinaventure.com.cn/rank/210/3182.html')
  assert.equal(score.overall, 84.4)
})

test('a verified unranked investor receives a neutral score instead of a celebrity score', () => {
  const score = buildProjectDiscoveryScore({
    institutions: [{ name: '某已核验地方基金', role: 'follow', major: true }],
    ratingV3: rating,
  })
  assert.equal(score.dimensions[0].score, 50)
  assert.doesNotMatch(score.dimensions[0].evidence, /重点机构/u)
})

test('stale investment projections cannot contribute institution or financing points', () => {
  const score = buildProjectDiscoveryScore({
    investmentProfileStatus: 'stale',
    institutions: [{ name: 'IDG资本', role: 'lead' }],
    financing: { latestAmountValue: 100_000_000, latestAmountCurrency: 'CNY', latestRound: 'A轮' },
    ratingV3: rating,
  })
  assert.deepEqual(score.dimensions.slice(0, 2).map((item) => item.score), [null, null])
  assert.equal(score.coverage, 2)
  assert.equal(score.overall, null)
})

test('funding reference bands compare like financing rounds and never treat an undisclosed round as a precise amount', () => {
  assert.equal(fundingAmountDiscoveryScore(100_000_000, 'CNY', 'A轮'), 80)
  assert.equal(fundingAmountDiscoveryScore(100_000_000, 'CNY', '天使轮'), 90)
  assert.equal(fundingAmountDiscoveryScore(100_000_000, 'CNY', 'B轮'), 65)
  assert.equal(fundingAmountDiscoveryScore(100_000_000, 'CNY', undefined), null)
})

test('an opaque major-institution flag does not invent a rank when names are unavailable', () => {
  const score = buildProjectDiscoveryScore({
    institutions: [{ name: '普通机构', major: false }],
    hasMajorInstitution: true,
    ratingV3: rating,
  })
  assert.equal(score.dimensions[0].score, 50)
  assert.equal(score.overall, 73.1)
  assert.doesNotMatch(score.dimensions[0].evidence, /重点机构/u)
})

test('funding bands and rating dimension positions remain consistent with database sort expression', () => {
  assert.equal(LEAD_RATING_DIMENSIONS[2].key, 'technology_rd')
  assert.equal(LEAD_RATING_DIMENSIONS[3].key, 'industry_policy_space')
  assert.deepEqual([5_000_000, 10_000_000, 30_000_000, 100_000_000]
    .map((value) => fundingAmountDiscoveryScore(value, 'CNY', '天使轮')), [50, 65, 80, 90])
  assert.equal(fundingAmountDiscoveryScore(0, 'CNY', 'A轮'), null)
  assert.equal(fundingAmountDiscoveryScore(Number.NaN, 'CNY', 'A轮'), null)
})

test('a sourced project without four verified dimensions receives only a provisional reference score', () => {
  const score = buildProjectDiscoveryScore({
    summary: '企业研发用于工业场景的具身智能机器人控制系统。',
    sourceUrls: ['javascript:alert(1)', 'https://example.org/news/project'],
    industryTags: ['具身智能/机器人'],
    technologies: ['机器人控制算法'],
    teamDescription: '创始团队来自清华大学并有产业化经验。',
  })
  assert.equal(score.overall, null)
  assert.equal(score.coverage, 0)
  assert.ok(score.referenceScore !== null && score.referenceScore > 50 && score.referenceScore <= 75)
  assert.equal(score.referenceSourceUrl, 'https://example.org/news/project')
  assert.match(score.referenceEvidence.join('；'), /待核验/u)
  assert.ok(score.dimensions.every((item) => item.score === null))
})

test('a missing summary or safe article URL cannot receive an initial reference score', () => {
  assert.equal(buildProjectDiscoveryScore({ summary: '', sourceUrls: ['https://example.org/news'] }).referenceScore, null)
  assert.equal(buildProjectDiscoveryScore({ summary: '公司披露新产品', sourceUrls: ['javascript:alert(1)'] }).referenceScore, null)
})

test('generic industry and ambiguous financing do not invent premium evidence', () => {
  const base = { summary: '公司披露了产品及应用场景。', sourceUrls: ['https://example.org/news'], industryTags: ['其他'] }
  const neutral = buildProjectDiscoveryScore(base)
  const ambiguous = buildProjectDiscoveryScore({ ...base, financing: { latestAmountValue: 100_000_000, latestAmountCurrency: 'USD' }, candidateFinancing: { latestAmount: '近亿元', status: '候选冲突' } })
  assert.equal(neutral.referenceScore, 50)
  assert.equal(ambiguous.referenceScore, neutral.referenceScore)
})

test('a recent page of 100 sourced summaries can be scored without fabricating four-dimension ratings', () => {
  const scores = Array.from({ length: 100 }, (_, index) => buildProjectDiscoveryScore({
    summary: `项目 ${index + 1} 披露了产品和应用场景。`,
    sourceUrls: ['', 'about:blank', `https://example.org/news/${index + 1}`],
    industryTags: index % 5 === 0 ? ['其他'] : ['半导体'],
  }))
  assert.equal(scores.filter((score) => typeof score.referenceScore === 'number').length, 100)
  assert.equal(scores.filter((score) => score.overall !== null).length, 0)
})
