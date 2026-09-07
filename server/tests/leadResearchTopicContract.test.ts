import assert from 'node:assert/strict'
import test from 'node:test'
import {
  leadEnrichmentResearchAgentProfile,
  leadTopicResearchContract,
  parseLeadTopicResearchOutput,
  researchLeadTopicWithWeb,
} from '../src/services/leadTopicWebResearchService.js'

test('isolates enrichment circuit history by backend and model route', () => {
  const repaired = leadEnrichmentResearchAgentProfile('gateway', 'gpt-5.6-sol')
  assert.equal(repaired, leadEnrichmentResearchAgentProfile('gateway', 'gpt-5.6-sol'))
  assert.notEqual(repaired, leadEnrichmentResearchAgentProfile('gateway', 'Doubao-seed-2-0-mini'))
  assert.notEqual(repaired, leadEnrichmentResearchAgentProfile('codex-cli', 'gpt-5.6-sol'))
  assert.ok(repaired.length <= 64)
})

test('accepts reference-grade model output without arbitrary fact-count or gap-shape rejection', () => {
  const facts = Array.from({ length: 31 }, (_, index) => ({
    factKey: 'profile.product', value: `产品${index + 1}`, quote: `产品${index + 1}`,
    sourceUrls: ['https://example.com/source'], extraModelNote: 'ignored',
  }))
  const parsed = parseLeadTopicResearchOutput(JSON.stringify({
    facts,
    gaps: [{ field: 'profile.website', reason: 'not found' }],
    conflicts: [],
    extraEnvelopeNote: 'ignored',
  }))
  assert.equal(parsed.facts.length, 31)
  assert.equal(parsed.gaps.length, 1)
  assert.match(parsed.gaps[0]!, /profile\.website/)
})

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
