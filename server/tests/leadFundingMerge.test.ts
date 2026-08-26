import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeFundingRounds } from '../src/services/leadPublicIntelService.js'

test('evidence-bound extraction supersedes a polluted placeholder record from the same article', () => {
  const sourceUrl = 'https://mp.weixin.qq.com/s/example'
  const merged = mergeFundingRounds([{
    round: '待核验',
    amount: '5 亿元',
    valuation: '未披露',
    investors: '经纬创投；融资由经纬创投；经纬观点 作为天使 ++ 轮的',
    sourceUrl,
  }], [{
    round: '天使++轮',
    date: '',
    amount: '5亿元人民币',
    valuation: '未披露',
    investors: '经纬创投',
    leadInvestors: ['经纬创投'],
    sourceUrl,
    evidenceQuote: '公司完成天使 ++ 轮融资，单笔金额 5 亿元人民币，本轮融资由经纬创投领投。',
    evidenceStatus: 'source_labeled',
    idempotencyKey: 'fact-1',
  }])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].round, '天使++轮')
  assert.equal(merged[0].investors, '经纬创投')
})

test('a separate historical round from the same source is retained', () => {
  const sourceUrl = 'https://example.com/history'
  const merged = mergeFundingRounds([{
    round: 'A轮', amount: '1亿元', date: '2022', valuation: '', investors: '甲资本', sourceUrl,
  }], [{
    round: 'B轮', amount: '2亿元', date: '2024', valuation: '', investors: '乙资本', sourceUrl,
    evidenceQuote: '公司于2024年完成B轮融资2亿元。', idempotencyKey: 'fact-b',
  }])
  assert.equal(merged.length, 2)
})
