import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalLeadSourceUrl,
  fetchLeadSourceDocument,
  isPrivateLeadSourceAddress,
  sourceDocumentContainsQuote,
} from '../src/services/leadSourceDocumentService.js'

test('normalizes tracking parameters and identifies private address ranges', () => {
  assert.equal(canonicalLeadSourceUrl('HTTPS://Example.COM/path?utm_source=x&id=1#part'), 'https://example.com/path?id=1')
  assert.equal(isPrivateLeadSourceAddress('127.0.0.1'), true)
  assert.equal(isPrivateLeadSourceAddress('169.254.10.2'), true)
  assert.equal(isPrivateLeadSourceAddress('8.8.8.8'), false)
})

test('rejects local and private source targets before fetching', async () => {
  let called = false
  await assert.rejects(fetchLeadSourceDocument({
    url: 'http://localhost/private',
    persist: false,
    respectRobots: false,
    resolveHost: async () => ['127.0.0.1'],
    fetchImpl: (async () => { called = true; return new Response('no') }) as typeof fetch,
  }), /private hostname rejected/)
  assert.equal(called, false)
})

test('follows only validated public redirects and extracts a hash-addressable quote', async () => {
  const seen: string[] = []
  const document = await fetchLeadSourceDocument({
    url: 'https://example.com/start?utm_source=test',
    persist: false,
    respectRobots: false,
    resolveHost: async () => ['93.184.216.34'],
    fetchImpl: (async (url: string | URL | Request) => {
      const value = String(url)
      seen.push(value)
      if (value.includes('/start')) return new Response('', { status: 302, headers: { location: '/article' } })
      return new Response('<html><head><title>Example Evidence</title><meta property="og:site_name" content="Publisher"></head><body><p>营业收入为 1 亿元，统计期间为 2025 年。</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }) as typeof fetch,
  })
  assert.deepEqual(seen, ['https://example.com/start', 'https://example.com/article'])
  assert.equal(document.title, 'Example Evidence')
  assert.equal(document.publisher, 'Publisher')
  assert.equal(document.contentHash.length, 64)
  assert.equal(sourceDocumentContainsQuote(document.text, '营业收入为 1 亿元'), true)
  assert.equal(sourceDocumentContainsQuote(document.text, '估值为 1 亿元'), false)
})

test('honors a robots.txt disallow rule', async () => {
  await assert.rejects(fetchLeadSourceDocument({
    url: 'https://example.com/private/page',
    persist: false,
    resolveHost: async () => ['93.184.216.34'],
    fetchImpl: (async (url: string | URL | Request) => {
      if (String(url).endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /private', { status: 200 })
      return new Response('<p>must not fetch</p>', { status: 200, headers: { 'content-type': 'text/html' } })
    }) as typeof fetch,
  }), /robots policy disallows/)
})
