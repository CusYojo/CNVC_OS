import assert from 'node:assert/strict'
import test from 'node:test'
import {
  prepareRadarAiCandidate,
  validateRadarAiDecision,
} from '../src/services/radarAiReviewService.js'

test('accepts a high-confidence subject only when name and evidence occur in source', () => {
  const source = '36氪获悉，AI创业公司「MobAI」已完成数百万元天使轮融资。'
  const result = validateRadarAiDecision({
    candidateId: 'mobai',
    decision: 'accept',
    subjectType: 'company',
    subjectName: 'MobAI',
    legalName: '',
    evidence: source,
    confidence: 0.93,
    rejectReason: '',
  }, source, 'test-model', '2026-07-30T00:00:00.000Z')

  assert.equal(result.status, 'accepted')
  assert.equal(result.decision.subjectName, 'MobAI')
  assert.equal(result.decision.subjectType, 'company')
})

test('holds hallucinated or paraphrased evidence out of the public pool', () => {
  const source = '某创业团队宣布完成天使轮融资，但原文未披露主体名称。'
  const result = validateRadarAiDecision({
    candidateId: 'unknown',
    decision: 'accept',
    subjectType: 'company',
    subjectName: '未来智能',
    legalName: '未来智能科技有限公司',
    evidence: '未来智能完成天使轮融资。',
    confidence: 0.98,
    rejectReason: '',
  }, source)

  assert.equal(result.status, 'review')
  assert.equal(result.decision.decision, 'review')
  assert.equal(result.decision.legalName, '')
  assert.match(result.decision.rejectReason, /无法在原文中核验/)
})

test('keeps explicit model rejections rejected without inventing a subject', () => {
  const source = '胡隆华教授获Mid-Career Researcher Award荣誉。'
  const result = validateRadarAiDecision({
    candidateId: 'award',
    decision: 'reject',
    subjectType: null,
    subjectName: '',
    legalName: '',
    evidence: '',
    confidence: 0.99,
    rejectReason: '人物获奖信息，不构成投资标的。',
  }, source)

  assert.equal(result.status, 'rejected')
  assert.equal(result.decision.subjectName, '')
})

test('uses confidence thresholds for automatic admission', () => {
  const source = '海昶生物已完成A轮融资并启动多肽偶联药物产业化。'
  const review = validateRadarAiDecision({
    candidateId: 'haichang',
    decision: 'accept',
    subjectType: 'company',
    subjectName: '海昶生物',
    legalName: '',
    evidence: source,
    confidence: 0.72,
    rejectReason: '',
  }, source)
  const reject = validateRadarAiDecision({
    candidateId: 'haichang-low',
    decision: 'accept',
    subjectType: 'company',
    subjectName: '海昶生物',
    legalName: '',
    evidence: source,
    confidence: 0.42,
    rejectReason: '',
  }, source)

  assert.equal(review.status, 'review')
  assert.equal(reject.status, 'rejected')
})

test('cache key changes when candidate content changes', () => {
  const base = {
    source: '36kr',
    source_id: 'article-1',
    title: 'MobAI完成天使轮融资',
    summary: 'MobAI完成数百万元天使轮融资。',
  }
  const first = prepareRadarAiCandidate(base, 'test-model')
  const same = prepareRadarAiCandidate({ ...base }, 'test-model')
  const changed = prepareRadarAiCandidate({
    ...base,
    summary: 'MobAI完成新一轮融资。',
  }, 'test-model')

  assert.equal(first.cacheKey, same.cacheKey)
  assert.notEqual(first.cacheKey, changed.cacheKey)
  assert.equal(first.sourceKey, '36kr:article-1')
})

