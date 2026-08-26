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
  assert.equal('text' in requestBody, false)
  assert.equal(result.text, '{"companies":[]}')
  assert.equal(result.sources[0]?.url, 'https://example.com/company')
})
