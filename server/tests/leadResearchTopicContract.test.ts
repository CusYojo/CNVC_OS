import assert from 'node:assert/strict'
import test from 'node:test'
import { leadTopicResearchContract, researchLeadTopicWithWeb } from '../src/services/leadTopicWebResearchService.js'

test('research topics use stable-identity paper contracts', () => {
  const basic = leadTopicResearchContract('basic_profile', 'research')
  assert.equal(basic.promptVersion, 'lead-research-topic-web-v5-web-hit')
  assert.ok(basic.factKeys.includes('paper.title'))
  assert.ok(basic.queries.every((query) => query.includes('论文')))
  const products = leadTopicResearchContract('products', 'research')
  assert.ok(products.factKeys.includes('artifact.code_url'))
  assert.equal(products.factKeys.includes('product.name'), false)
})

test('company topic contracts expose the trimmed core scope', () => {
  const company = leadTopicResearchContract('financing', 'company')
  assert.equal(company.promptVersion, 'lead-topic-web-research-v13-web-hit')
  assert.ok(company.factKeys.includes('financing.round'))
  assert.equal(company.factKeys.includes('financing.investors'), false)
})

test('direct web research rejects topics excluded from the active enrichment scope before any model call', async () => {
  await assert.rejects(
    researchLeadTopicWithWeb({ topicKey: 'technology_ip', subjectName: '示例企业', entityType: 'company' }),
    (error: unknown) => (error as { code?: string }).code === 'LEAD_TOPIC_NOT_APPLICABLE',
  )
  await assert.rejects(
    researchLeadTopicWithWeb({ topicKey: 'financing', subjectName: '示例论文', entityType: 'research' }),
    (error: unknown) => (error as { code?: string }).code === 'LEAD_TOPIC_NOT_APPLICABLE',
  )
})
