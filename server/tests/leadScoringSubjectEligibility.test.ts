import test from 'node:test'
import assert from 'node:assert/strict'
import { isLeadScoringSubjectEligible } from '../src/services/leadSubjectName.js'

test('评分允许已绑定工商全称的短品牌主体', () => {
  assert.equal(isLeadScoringSubjectEligible({
    name: '元境',
    companyName: '北京元境科技有限公司',
  }), true)
  assert.equal(isLeadScoringSubjectEligible({
    name: '新星',
    radarProfile: { registry: { companyName: '深圳新星机器人有限责任公司' } },
  }), true)
  assert.equal(isLeadScoringSubjectEligible({
    name: '智核',
    scoring: { registry: { companyName: '智核科技股份有限公司' } },
  }), true)
})

test('评分仍拒绝没有主体证据的泛化短词', () => {
  assert.equal(isLeadScoringSubjectEligible({ name: '公司' }), false)
})
