import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractLeadFinancingFacts,
  extractLeadFinancingFactsWithStatus,
  normalizeFinancingRound,
  normalizeFinancingText,
} from '../src/services/leadFinancingFactService.js'

const knowinArticle = '消费级家庭具身智能公司诺因智能近期完成天使 ++ 轮融资，单笔金额 5 亿元人民币，本轮融资由经纬创投领投。资金将主要用于 GLOW 生成式具身大模型研发迭代。'

test('extracts the Knowin angel++ financing fact with exact source evidence', () => {
  const [fact] = extractLeadFinancingFacts({
    text: knowinArticle,
    sourceUrl: 'https://mp.weixin.qq.com/s?__biz=example',
    publishedAt: '2026-08-25',
  })
  assert.equal(fact.round, '天使++轮')
  assert.equal(fact.roundRaw, '天使 ++ 轮')
  assert.equal(fact.amount, '5亿元人民币')
  assert.equal(fact.amountRaw, '5 亿元人民币')
  assert.equal(fact.currency, 'CNY')
  assert.deepEqual(fact.leadInvestors, ['经纬创投'])
  assert.deepEqual(fact.investors, ['经纬创投'])
  assert.match(fact.evidenceQuote, /完成天使 \+\+ 轮融资，单笔金额 5 亿元人民币/)
  assert.equal(fact.evidenceStatus, 'source_labeled')
  assert.equal(fact.sourceUrl, 'https://mp.weixin.qq.com/s?__biz=example')
})

test('normalizes equivalent CNY amount typography to one display value', () => {
  const variants = [
    '公司已完成天使轮融资，单笔金额5 亿元人民币。',
    '公司已完成天使轮融资，单笔金额人民币5亿元。',
    '公司已完成天使轮融资，单笔金额RMB 5亿。',
  ]
  for (const text of variants) {
    const [fact] = extractLeadFinancingFacts({ text })
    assert.equal(fact.amount, '5亿元人民币', text)
    assert.equal(fact.currency, 'CNY', text)
  }
})

test('normalizes round spacing, full-width plus signs and Pre round typography', () => {
  assert.equal(normalizeFinancingRound('天使 ++ 轮'), '天使++轮')
  assert.equal(normalizeFinancingRound('天使 ＋＋ 轮'), '天使++轮')
  assert.equal(normalizeFinancingRound('Pre - A + 轮'), 'Pre-A+轮')
  assert.equal(normalizeFinancingText('完成天使 + + 轮融资'), '完成天使++轮融资')
})

test('does not turn market size, fundraising targets, valuation or contracts into completed financing', () => {
  const texts = [
    '该赛道市场规模达到5亿元人民币。',
    '公司拟融资5亿元人民币，用于扩建产线。',
    '公司本轮融资目标为5亿元人民币。',
    '公司最新估值5亿元人民币。',
    '公司获得合同金额5亿元人民币的订单。',
  ]
  for (const text of texts) assert.deepEqual(extractLeadFinancingFacts({ text }), [], text)
})

test('keeps separate completed rounds and remains idempotent on replay', () => {
  const text = '公司2022年完成A轮融资1亿元人民币。公司近期完成B轮融资2亿元人民币，由甲方资本领投。'
  const first = extractLeadFinancingFacts({ text, sourceUrl: 'https://example.com/a' })
  const replay = extractLeadFinancingFacts({ text, sourceUrl: 'https://example.com/a' })
  assert.deepEqual(first.map((item) => [item.round, item.amount]), [
    ['A轮', '1亿元人民币'],
    ['B轮', '2亿元人民币'],
  ])
  assert.deepEqual(replay.map((item) => item.idempotencyKey), first.map((item) => item.idempotencyKey))
  assert.equal(new Set(first.map((item) => item.idempotencyKey)).size, 2)
})

test('does not include publisher column labels or financing sentence fragments as investors', () => {
  const [fact] = extractLeadFinancingFacts({
    text: '公司完成天使轮融资，金额1亿元人民币，本轮融资由经纬创投领投。经纬观点 作为天使轮的领投方，经纬创投管理合伙人表示看好该团队。',
  })
  assert.deepEqual(fact.leadInvestors, ['经纬创投'])
  assert.equal(fact.investors.some((item) => /经纬观点|融资由|轮融资/.test(item)), false)
})

test('reports fact extraction state separately from document availability', () => {
  const succeeded = extractLeadFinancingFactsWithStatus({ text: knowinArticle })
  assert.equal(succeeded.status, 'succeeded')
  assert.equal(succeeded.facts.length, 1)
  const noCandidate = extractLeadFinancingFactsWithStatus({ text: '公司发布首款家庭机器人产品。' })
  assert.equal(noCandidate.status, 'no_candidate')
  assert.deepEqual(noCandidate.facts, [])
})
