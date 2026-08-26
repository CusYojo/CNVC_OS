import assert from 'node:assert/strict'
import test from 'node:test'
import {
  companyRegistrationEligibility,
  isDeregisteredCompany,
  normalizeLeadRegistry,
} from '../src/services/leadRegistry.js'

test('normalizes legacy registry keys into the public contract', () => {
  assert.deepEqual(normalizeLeadRegistry({
    companyName: '示例科技有限公司',
    establishDate: '2020-01-02',
    legalPersonName: '张三',
    address: '北京市海淀区',
  }), {
    companyName: '示例科技有限公司',
    establishDate: '2020-01-02',
    legalPersonName: '张三',
    address: '北京市海淀区',
    foundedAt: '2020-01-02',
    legalRepresentative: '张三',
    registeredAddress: '北京市海淀区',
    regLocation: '北京市海淀区',
  })
})

test('keeps the first meaningful source and rejects placeholders', () => {
  const registry = normalizeLeadRegistry(
    { foundedAt: '2021-03-04', legalRepresentative: '待核验' },
    { foundedAt: '2019-01-01', legalRepresentative: '李四', registeredCapital: '未披露' },
  )
  assert.equal(registry.foundedAt, '2021-03-04')
  assert.equal(registry.legalRepresentative, '李四')
  assert.equal(registry.registeredCapital, undefined)
})

test('normalizes millisecond timestamps without inventing unavailable fields', () => {
  const registry = normalizeLeadRegistry({ setupDate: '1577894400000' })
  assert.equal(registry.foundedAt, '2020-01-02')
  assert.equal(registry.registeredCapital, undefined)
})

test('keeps two-digit month and day values intact', () => {
  assert.equal(normalizeLeadRegistry({ foundedAt: '2017-10-18' }).foundedAt, '2017-10-18')
  assert.equal(normalizeLeadRegistry({ foundedAt: '2017年12月31日' }).foundedAt, '2017-12-31')
})

test('excludes only explicit deregistered companies from the public lead pool', () => {
  assert.equal(isDeregisteredCompany('注销'), true)
  assert.equal(isDeregisteredCompany('已注销'), true)
  assert.equal(companyRegistrationEligibility('登记状态：注销').eligibleForLeadPool, false)
  assert.equal(companyRegistrationEligibility('存续（在营、开业、在册）').eligibleForLeadPool, true)
  assert.equal(companyRegistrationEligibility('吊销未注销').eligibleForLeadPool, true)
  assert.equal(companyRegistrationEligibility('待核验').eligibleForLeadPool, true)
})

test('normalizes common collector registration-status aliases before admission', () => {
  assert.equal(normalizeLeadRegistry({ regStatus: '注销' }).registrationStatus, '注销')
  assert.equal(normalizeLeadRegistry({ regStatusName: '已注销' }).registrationStatus, '已注销')
  assert.equal(normalizeLeadRegistry({ enterpriseStatus: '存续' }).registrationStatus, '存续')
  assert.equal(companyRegistrationEligibility(
    normalizeLeadRegistry({ regStatusName: '已注销' }).registrationStatus,
  ).eligibleForLeadPool, false)
})
