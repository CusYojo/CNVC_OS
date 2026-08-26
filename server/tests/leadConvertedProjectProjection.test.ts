import assert from 'node:assert/strict'
import test from 'node:test'
import { buildConvertedProjectFundingPatch } from '../src/services/leadPublicIntelService.js'

const fact = {
  round: '天使++轮',
  amount: '5亿元人民币',
  valuation: '未披露',
  sourceUrl: 'https://mp.weixin.qq.com/s/example',
  idempotencyKey: 'fact-1',
}

test('converted project projection fills only empty or placeholder financing fields', () => {
  const result = buildConvertedProjectFundingPatch({
    round: '待核验',
    financing: '',
    valuation: '未披露',
  }, fact)
  assert.deepEqual(result.patch, {
    round: '天使++轮',
    financing: '5亿元人民币',
  })
  assert.deepEqual(result.changes.map((item) => item.field), ['round', 'financing'])
})

test('converted project projection preserves meaningful human-maintained fields', () => {
  const result = buildConvertedProjectFundingPatch({
    round: 'A轮（项目经理确认）',
    financing: '3亿元，以交割文件为准',
    valuation: '20亿元',
  }, fact)
  assert.deepEqual(result, { patch: {}, changes: [] })
})

test('converted project projection is idempotent after the values have been filled', () => {
  const result = buildConvertedProjectFundingPatch({
    round: '天使++轮',
    financing: '5亿元人民币',
    valuation: '',
  }, fact)
  assert.deepEqual(result, { patch: {}, changes: [] })
})
