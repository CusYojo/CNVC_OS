import assert from 'node:assert/strict'
import test from 'node:test'
import {
  displayLeadDetailValue,
  displayLeadEvidenceStatus,
  displayLeadFundingValue,
  displayLeadInvestorNames,
  isLegalCompanyName,
  verifiedCompanyWebsite,
} from '../../src/lib/leadPresentation.js'

test('project detail replaces every pending-verification value with a dash', () => {
  assert.equal(displayLeadDetailValue('待核验'), '-')
  assert.equal(displayLeadDetailValue('融资轮次待核验'), '-')
  assert.equal(displayLeadDetailValue('原文已标注，待交叉核验'), '-')
  assert.equal(displayLeadDetailValue('注册地址待核实'), '-')
  assert.equal(displayLeadDetailValue('主体待确认'), '-')
  assert.equal(displayLeadDetailValue('未确认'), '-')
  assert.equal(displayLeadDetailValue('未披露'), '-')
  assert.equal(displayLeadDetailValue('A轮'), 'A轮')
  assert.equal(displayLeadDetailValue(null), '-')
})

test('real funding facts are not hidden by unverified placeholders', () => {
  assert.equal(displayLeadFundingValue('融资金额待核验', '5 亿元', ''), '5 亿元')
  assert.equal(displayLeadFundingValue('融资轮次待核验', '天使++轮', '待核验'), '天使++轮')
  assert.equal(displayLeadFundingValue('融资金额未披露', '', '待核验'), '')
})

test('evidence status is displayed separately from the fact value', () => {
  assert.equal(displayLeadEvidenceStatus('source_labeled'), '原文已标注，待交叉核验')
  assert.equal(displayLeadEvidenceStatus('source_supported'), '多源已核验')
  assert.equal(displayLeadEvidenceStatus('unverified'), '')
})

test('a WeChat source article can never be used as the company website', () => {
  assert.equal(verifiedCompanyWebsite('https://mp.weixin.qq.com/s?__biz=abc'), '')
  assert.equal(verifiedCompanyWebsite('', 'https://knowinai.com/?lang=zh'), 'https://knowinai.com/?lang=zh')
})

test('brand aliases remain distinct from legal entity names', () => {
  assert.equal(isLegalCompanyName('诺因智能'), false)
  assert.equal(isLegalCompanyName('深圳诺因智能有限公司'), true)
})

test('lead investor display keeps institution names and drops editorial fragments', () => {
  assert.deepEqual(
    displayLeadInvestorNames(['经纬创投', '经纬观点', '本轮融资由经纬创投领投', '经纬创投']),
    ['经纬创投'],
  )
})
