import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyLeadWebEvidence } from '../src/services/leadEvidenceClassificationService.js'

test('regulatory filings are E1 and official public records are E2', () => {
  assert.deepEqual(classifyLeadWebEvidence({ sourceUrl: 'https://static.sse.com.cn/disclosure/listedinfo/announcement.pdf' }), {
    evidenceLevel: 'E1', sourceType: 'official_regulatory_filing',
  })
  assert.deepEqual(classifyLeadWebEvidence({ sourceUrl: 'https://www.gsxt.gov.cn/index.html' }), {
    evidenceLevel: 'E2', sourceType: 'official_public_record',
  })
  assert.deepEqual(classifyLeadWebEvidence({ sourceUrl: 'https://patentscope.wipo.int/search/en/detail.jsf' }), {
    evidenceLevel: 'E2', sourceType: 'official_public_record',
  })
})

test('company publicity, media and deceptive suffix domains remain E3', () => {
  for (const sourceUrl of [
    'https://example-company.com/about',
    'https://news.example.com/story',
    'https://sse.com.cn.evil.example/forged-filing',
    'not-a-url',
  ]) {
    assert.deepEqual(classifyLeadWebEvidence({ sourceUrl }), {
      evidenceLevel: 'E3', sourceType: 'controlled_web_fetch',
    })
  }
})
