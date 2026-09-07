import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOpenAlexWorksUrl } from '../src/services/radarCollectorService.js'
import { DEFAULT_RADAR_PUBLIC_SOURCES } from '../src/services/radarSourceCatalog.js'

test('OpenAlex paper source is a default enabled fallback and does not require an API key', () => {
  const source = DEFAULT_RADAR_PUBLIC_SOURCES.find((item) => item.key === 'openalex_ai')
  assert.equal(source?.enabled, true)
  const url = new URL(buildOpenAlexWorksUrl({
    sourceUrl: 'https://api.openalex.org/works',
    query: 'artificial intelligence',
    fromDate: '2026-09-01',
    toDate: '2026-09-07',
    limit: 50,
  }))
  assert.equal(url.searchParams.has('api_key'), false)
  assert.equal(url.searchParams.get('per_page'), '50')
  assert.equal(url.searchParams.get('sort'), 'publication_date:desc')
  assert.equal(url.searchParams.get('filter'), 'from_publication_date:2026-09-01,to_publication_date:2026-09-07')
})

test('OpenAlex request includes optional credentials only when configured', () => {
  const url = new URL(buildOpenAlexWorksUrl({
    sourceUrl: 'https://api.openalex.org/works',
    apiKey: 'configured-key',
    mailto: 'ops@example.com',
    query: 'robotics',
    fromDate: '2026-09-01',
    toDate: '2026-09-07',
    limit: 500,
  }))
  assert.equal(url.searchParams.get('api_key'), 'configured-key')
  assert.equal(url.searchParams.get('mailto'), 'ops@example.com')
  assert.equal(url.searchParams.get('per_page'), '100')
})
