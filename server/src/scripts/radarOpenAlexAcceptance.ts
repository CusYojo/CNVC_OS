import assert from 'node:assert/strict'
import { parseOpenAlexWorks } from '../services/radarCollectorService.js'

const source = {
  key: 'openalex_acceptance',
  name: 'OpenAlex Acceptance',
  url: 'https://api.openalex.org/works',
  group: '论文',
  type: 'openalex_api' as const,
  enabled: true,
  frequency: '每天',
}

const rows = parseOpenAlexWorks(source, {
  meta: { count: 1 },
  results: [{
    id: 'https://openalex.org/W1234567890',
    doi: 'https://doi.org/10.1000/example',
    title: 'Investment-oriented artificial intelligence platform',
    publication_date: '2026-08-16',
    cited_by_count: 12,
    abstract_inverted_index: { An: [0], auditable: [1], platform: [2] },
    authorships: [
      { author: { id: 'https://openalex.org/A1', display_name: 'Ada Example' } },
      { author: { id: 'https://openalex.org/A2', display_name: 'Lin Example' } },
    ],
    topics: [{ id: 'https://openalex.org/T1', display_name: 'Artificial Intelligence' }],
    keywords: [{ id: 'https://openalex.org/K1', display_name: 'Machine Learning' }],
    primary_location: { landing_page_url: 'https://example.org/work' },
    best_oa_location: { pdf_url: 'https://example.org/work.pdf' },
  }],
}, 10)

assert.equal(rows.length, 1)
assert.equal(rows[0].source, 'openalex')
assert.equal(rows[0].source_id, 'W1234567890')
assert.equal(rows[0].summary, 'An auditable platform')
assert.deepEqual(rows[0].authors, ['Ada Example', 'Lin Example'])
assert.equal(rows[0].pdf_url, 'https://example.org/work.pdf')
assert.equal(rows[0].cited_by_count, 12)
assert.ok(Array.isArray(rows[0].categories) && rows[0].categories.includes('Artificial Intelligence'))
assert.equal(parseOpenAlexWorks(source, { results: [] }).length, 0)
assert.throws(() => parseOpenAlexWorks(source, null), /返回格式无效/)

console.log(JSON.stringify({
  ok: true,
  checks: [
    'official-works-response-is-normalized',
    'abstract-inverted-index-is-reconstructed',
    'authors-topics-keywords-and-links-are-preserved',
    'empty-and-malformed-responses-are-deterministic',
  ],
}))
