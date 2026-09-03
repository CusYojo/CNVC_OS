import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLeadResearchProfile, isLeadResearchProfileFactKey, leadResearchTopicGaps, leadResearchTopicGapsByTopic } from '../src/services/leadResearchProfileProjectionService.js'
import { leadResearchWebEnrichmentEnabled } from '../src/services/leadEnrichmentContract.js'

test('research profile maps deterministic paper metadata without company investment fields', () => {
  const profile = buildLeadResearchProfile({
    leadId: 'paper-1', name: '科研成果一', updatedAt: '2026-09-03T00:00:00Z',
    radarProfile: { channel: '论文', sourceName: 'arXiv', sourceId: '2501.12345', paperMeta: {
      title: 'Evidence-aware Agents', authors: ['Alice', 'Bob'], categories: ['cs.AI'], venue: 'ICML', publishedAt: '2026-08-31',
      affiliations: [{ name: 'Example University' }],
      rights: { articleLicense: { code: 'CC BY 4.0' }, code: { url: 'https://example.org/code' } },
      metadataSource: { provider: 'arxiv', url: 'https://arxiv.org/abs/2501.12345' },
    } },
  })
  assert.equal(profile.subject.type, 'research')
  assert.equal(profile.subject.providerIds.sourceId, '2501.12345')
  assert.deepEqual(profile.team.authors.map((author) => author.name), ['Alice', 'Bob'])
  assert.deepEqual(profile.team.affiliations, ['Example University'])
  assert.equal(profile.progress.codeUrl, 'https://example.org/code')
  assert.equal(profile.rights.articleLicense, 'CC BY 4.0')
  assert.equal('financing' in profile, false)
  assert.equal('valuation' in profile, false)
  assert.equal('customers' in profile, false)
})

test('research facts supplement transfer and maturity without inventing facts', () => {
  const profile = buildLeadResearchProfile({ leadId: 'paper-2', name: '论文二', radarProfile: { channel: '论文', paperMeta: { authors: ['A'] } }, facts: [
    { id: 'f1', factKey: 'research.trl', value: '4' },
    { id: 'f2', factKey: 'technology.transfer_status', value: '已签署许可协议' },
    { id: 'f3', factKey: 'financing.round', value: 'A轮' },
  ] })
  assert.equal(profile.valueAndTransfer.trl, '4')
  assert.equal(profile.valueAndTransfer.transferStatus, '已签署许可协议')
  assert.deepEqual(profile.sourceFactIds, ['f1', 'f2'])
  assert.equal(isLeadResearchProfileFactKey('financing.round'), false)
})

test('research web rollout is gap-driven and cutoff protected', () => {
  const radarProfile = { sourceId: '2501.1', paperMeta: { abstract: 'abstract', authors: ['A'], categories: ['cs.AI'], affiliations: [{ name: 'U' }], rights: { articleLicense: { code: 'CC BY 4.0' } } } }
  assert.deepEqual(leadResearchTopicGaps('basic_profile', radarProfile), [])
  assert.deepEqual(leadResearchTopicGaps('team', radarProfile), ['作者与机构逐一绑定'])
  assert.deepEqual(leadResearchTopicGaps('industrialization', radarProfile), ['技术成熟度、复现性、验证或应用阶段'])
  assert.deepEqual(Object.keys(leadResearchTopicGapsByTopic(radarProfile)), [
    'basic_profile', 'team', 'products', 'technology_ip', 'industrialization', 'latest_developments',
  ])
  const env = { LEAD_RESEARCH_WEB_ENRICHMENT_ENABLED: 'true', LEAD_RESEARCH_WEB_ENRICHMENT_AFTER: '2026-09-03T02:30:00Z' }
  assert.equal(leadResearchWebEnrichmentEnabled({ jobCreatedAt: '2026-09-03T02:29:59Z', env }), false)
  assert.equal(leadResearchWebEnrichmentEnabled({ jobCreatedAt: '2026-09-03T02:30:00Z', env }), true)
  assert.equal(leadResearchWebEnrichmentEnabled({ jobCreatedAt: '2026-09-03T03:00:00Z', env: { ...env, LEAD_RESEARCH_WEB_ENRICHMENT_AFTER: 'invalid' } }), false)
})
