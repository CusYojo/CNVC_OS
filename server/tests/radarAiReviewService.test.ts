import assert from 'node:assert/strict'
import test from 'node:test'
import {
  prepareRadarAiCandidate,
  revalidateEvidenceOnlyPaperReview,
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

test('accepts a complete paper title for an explicit paper candidate', () => {
  const title = 'GeoMix: Descriptor-Free Visual Localization via Global Context and Multi-Detector Training'
  const source = `${title}\nThis paper presents a descriptor-free visual localization method.`
  const result = validateRadarAiDecision({
    candidateId: 'paper-1',
    decision: 'accept',
    subjectType: 'paper',
    subjectName: title,
    legalName: '',
    evidence: `标题：${title} 摘要：This paper presents a descriptor-free visual localization method.`,
    translatedTitle: 'GeoMix：基于全局上下文与多检测器训练的无描述符视觉定位',
    translatedSummary: '本文提出一种无需局部描述符的视觉定位方法。',
    confidence: 0.95,
    rejectReason: '',
  }, source, 'test-model', '2026-07-31T00:00:00.000Z', true)

  assert.equal(result.status, 'accepted')
  assert.equal(result.decision.subjectType, 'paper')
  assert.equal(result.decision.subjectName, title)
  assert.equal(result.decision.translatedTitle, 'GeoMix：基于全局上下文与多检测器训练的无描述符视觉定位')
  assert.equal(result.decision.translatedSummary, '本文提出一种无需局部描述符的视觉定位方法。')
})

test('does not expose an English-only string as a Chinese paper translation', () => {
  const title = 'Paper Translation Validation'
  const result = validateRadarAiDecision({
    candidateId: 'paper-translation',
    decision: 'accept',
    subjectType: 'paper',
    subjectName: title,
    legalName: '',
    evidence: title,
    translatedTitle: 'Paper Translation Validation',
    translatedSummary: 'English summary only.',
    confidence: 0.95,
    rejectReason: '',
  }, title, 'test-model', '2026-08-03T00:00:00.000Z', true)

  assert.equal(result.status, 'accepted')
  assert.equal(result.decision.translatedTitle, '')
  assert.equal(result.decision.translatedSummary, '')
})

test('promotes a cached paper review that only failed because prompt labels wrapped its evidence', () => {
  const title = 'GeoMix: Descriptor-Free Visual Localization via Global Context and Multi-Detector Training'
  const result = revalidateEvidenceOnlyPaperReview({
    decision: 'review',
    subjectType: 'paper',
    subjectName: title,
    legalName: '',
    evidence: `标题：${title} 摘要：A descriptor-free localization method.`,
    confidence: 0.99,
    rejectReason: '模型给出的主体名称或来源证据无法在原文中核验',
    model: 'test-model',
    reviewedAt: '2026-07-31T00:00:00.000Z',
  }, `${title}\nA descriptor-free localization method.`)

  assert.equal(result?.status, 'accepted')
  assert.equal(result?.decision.decision, 'accept')
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

test('marks arXiv and paper-group candidates as papers before model review', () => {
  const investment = prepareRadarAiCandidate({ source: '36kr', title: 'Company A raises funding' }, 'test-model')
  const direct = prepareRadarAiCandidate({ source: 'arxiv', title: 'Paper A' }, 'test-model')
  const grouped = prepareRadarAiCandidate({
    source: 'investment',
    source_group: '论文',
    source_key: 'arxiv_cs_ai',
    title: 'Paper B',
  }, 'test-model')

  assert.equal(direct.isPaper, true)
  assert.equal(grouped.isPaper, true)
  assert.equal(investment.promptVersion, 'radar-subject-v3-paper-v2')
  assert.equal(direct.promptVersion, 'radar-subject-v4-paper-zh-v2')
  assert.match(grouped.promptText, /线索类型：论文/)
})
