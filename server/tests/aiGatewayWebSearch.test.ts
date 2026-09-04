import assert from 'node:assert/strict'
import test from 'node:test'
import { requestAiGatewayWebSearchText } from '../src/services/aiGatewayService.js'

test('uses Responses web_search without incompatible JSON mode and returns tool sources', async () => {
  let requestBody: Record<string, unknown> = {}
  const result = await requestAiGatewayWebSearchText({
    baseUrl: 'https://gateway.example/v1',
    apiKey: 'test-key',
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'search company' }],
    maxTokens: 1_000,
    timeoutMs: 5_000,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({
        output: [
          { type: 'web_search_call', action: { sources: [{ title: 'Company', url: 'https://example.com/company' }] } },
          { type: 'message', content: [{ type: 'output_text', text: '{"companies":[]}' }] },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch,
  })
  assert.deepEqual(requestBody.tools, [{ type: 'web_search' }])
  assert.deepEqual(requestBody.include, ['web_search_call.action.sources'])
  assert.equal('text' in requestBody, false)
  assert.equal(result.text, '{"companies":[]}')
  assert.equal(result.sources[0]?.url, 'https://example.com/company')
})

test('uses Jumu Responses annotations as web search sources without unsupported include', async () => {
  let requestBody: Record<string, unknown> = {}
  const result = await requestAiGatewayWebSearchText({
    baseUrl: 'https://getways-jumu.zeelin.cn/v1',
    apiKey: 'test-key',
    model: 'Doubao-seed-2-0-mini',
    messages: [{ role: 'user', content: 'search company' }],
    maxTokens: 6_000,
    timeoutMs: 5_000,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({
        output: [
          { type: 'web_search_call', action: { query: 'company' } },
          {
            type: 'message',
            content: [{
              type: 'output_text',
              text: '{"companies":[]}',
              annotations: [
                { type: 'url_citation', title: 'Company', url: 'https://example.com/company' },
                { type: 'url_citation', title: 'Duplicate', url: 'https://example.com/company' },
              ],
            }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch,
  })
  assert.equal('include' in requestBody, false)
  assert.equal(requestBody.max_output_tokens, 6_000)
  assert.equal(result.text, '{"companies":[]}')
  assert.deepEqual(result.sources, [{ url: 'https://example.com/company', title: 'Duplicate' }])
})
