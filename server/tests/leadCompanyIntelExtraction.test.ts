import assert from 'node:assert/strict'
import test from 'node:test'
import { validateLeadCompanyIntelExtraction } from '../src/services/leadCompanyIntelExtractionService.js'

const evidence = [{
  title: '示例科技有限公司工商信息',
  snippet: '当前工商全称为示例科技有限公司，注册资本1000万元人民币，统一社会信用代码91110108MA01ABC123，企业类型为有限责任公司。',
  url: 'https://example.com/company',
}]

test('accepts only evidence-bound requested company fields', () => {
  const result = validateLeadCompanyIntelExtraction({
    requestedFields: ['registeredCapital', 'creditCode'],
    searchEvidence: evidence,
    raw: { fields: [
      { field: 'registeredCapital', value: '1000万元人民币', quote: '注册资本1000万元人民币', sourceUrl: evidence[0].url },
      { field: 'creditCode', value: '91110108ma01abc123', quote: '统一社会信用代码91110108MA01ABC123', sourceUrl: evidence[0].url },
      { field: 'companyType', value: '有限责任公司', quote: '企业类型为有限责任公司', sourceUrl: evidence[0].url },
    ] },
  })
  assert.deepEqual(result.map((item) => [item.field, item.value]), [
    ['registeredCapital', '1000万元人民币'],
    ['creditCode', '91110108MA01ABC123'],
  ])
})

test('accepts an evidence-bound legal entity name and rejects a group alias', () => {
  const accepted = validateLeadCompanyIntelExtraction({
    requestedFields: ['companyName'],
    searchEvidence: evidence,
    raw: { fields: [{
      field: 'companyName',
      value: '示例科技有限公司',
      quote: '当前工商全称为示例科技有限公司',
      sourceUrl: evidence[0].url,
    }] },
  })
  assert.equal(accepted[0]?.value, '示例科技有限公司')

  const rejected = validateLeadCompanyIntelExtraction({
    requestedFields: ['companyName'],
    searchEvidence: evidence,
    raw: { fields: [{
      field: 'companyName',
      value: '示例科技集团',
      quote: '当前工商全称为示例科技有限公司',
      sourceUrl: evidence[0].url,
    }] },
  })
  assert.deepEqual(rejected, [])
})

test('rejects hallucinated values, quotes and source URLs', () => {
  const result = validateLeadCompanyIntelExtraction({
    requestedFields: ['registeredCapital', 'creditCode'],
    searchEvidence: evidence,
    raw: { fields: [
      { field: 'registeredCapital', value: '5000万元人民币', quote: '注册资本1000万元人民币', sourceUrl: evidence[0].url },
      { field: 'creditCode', value: '91110108MA01ABC123', quote: '统一社会信用代码91110108MA01ABC123', sourceUrl: 'https://invalid.example/company' },
    ] },
  })
  assert.deepEqual(result, [])
})

test('accepts a source-bound company introduction', () => {
  const result = validateLeadCompanyIntelExtraction({
    requestedFields: ['companyIntroduction'],
    searchEvidence: evidence,
    raw: { fields: [{
      field: 'companyIntroduction',
      value: '示例科技有限公司主要提供企业级软件与数据服务，面向产业客户交付数字化解决方案。',
      quote: evidence[0].snippet,
      sourceUrl: evidence[0].url,
    }] },
  })
  assert.equal(result[0]?.field, 'companyIntroduction')
})

test('keeps narrative founding claims separate from registry establishment dates', () => {
  const sourceUrl = 'https://example.com/company'
  const result = validateLeadCompanyIntelExtraction({
    requestedFields: ['foundedAt'],
    searchEvidence: [{
      title: '示例科技有限公司信息',
      snippet: '官网称团队成立于2025年8月；工商登记成立日期为2025年6月23日。',
      url: sourceUrl,
    }],
    raw: { fields: [
      { field: 'foundedAt', value: '2025年8月', quote: '官网称团队成立于2025年8月', sourceUrl },
      { field: 'foundedAt', value: '2025年6月23日', quote: '工商登记成立日期为2025年6月23日', sourceUrl },
    ] },
  })
  assert.deepEqual(result.map((item) => item.value), ['2025年6月23日'])
})
