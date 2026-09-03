import assert from 'node:assert/strict'
import test from 'node:test'
import { leadTopicResearchContract } from '../src/services/leadTopicWebResearchService.js'

test('research topics use stable-identity paper contracts', () => {
  const basic = leadTopicResearchContract('basic_profile', 'research')
  assert.equal(basic.promptVersion, 'lead-research-topic-web-v1-stable-identity')
  assert.ok(basic.factKeys.includes('paper.title'))
  assert.ok(basic.queries.every((query) => query.includes('论文')))
  const products = leadTopicResearchContract('products', 'research')
  assert.ok(products.factKeys.includes('artifact.code_url'))
  assert.equal(products.factKeys.includes('product.name'), false)
})

test('company topic contracts remain unchanged', () => {
  const company = leadTopicResearchContract('financing', 'company')
  assert.equal(company.promptVersion, 'lead-topic-web-research-v9-primary-sources')
  assert.ok(company.factKeys.includes('financing.round'))
})
