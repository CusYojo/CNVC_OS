import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aiGatewayResponseText,
  buildAiChatFallbackBody,
  buildAiResponsesBody,
  requestAiGatewayText,
  requestAiGatewayVisionText,
} from '../src/services/aiGatewayService.js'

test('AI gateway builds Responses JSON contract and minimal Chat fallback', () => {
  const input = {
    model: 'gpt-5.6-sol',
    messages: [
      { role: 'system' as const, content: 'system' },
      { role: 'user' as const, content: 'user' },
    ],
    maxTokens: 1200,
    json: true,
    reasoningEffort: 'low' as const,
  }
  const responses = buildAiResponsesBody(input)
  assert.equal(responses.max_output_tokens, 1200)
  assert.deepEqual(responses.text, { format: { type: 'json_object' } })
  assert.deepEqual(responses.reasoning, { effort: 'low' })
  assert.equal(responses.input[1]?.content[0]?.type, 'input_text')
  const chat = buildAiChatFallbackBody(input)
  assert.equal(chat.max_tokens, 1200)
  assert.equal('response_format' in chat, false)
  assert.equal('reasoning_effort' in chat, false)
})

test('AI gateway extracts both Responses and Chat payloads', () => {
  assert.equal(aiGatewayResponseText({ output_text: ' responses ' }), 'responses')
  assert.equal(aiGatewayResponseText({
    output: [{ content: [{ type: 'output_text', text: 'nested' }] }],
  }), 'nested')
  assert.equal(aiGatewayResponseText({ choices: [{ message: { content: 'chat' } }] }), 'chat')
})

test('AI gateway prefers Responses and falls back to minimal Chat when unsupported', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) })
    if (String(url).endsWith('/responses')) {
      return new Response('{"error":"unsupported"}', { status: 404 })
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const text = await requestAiGatewayText({
    baseUrl: 'https://gateway.example/v1',
    apiKey: 'test-key',
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'return json' }],
    maxTokens: 100,
    timeoutMs: 1000,
    json: true,
    reasoningEffort: 'low',
    fetchImpl: fetchImpl as typeof fetch,
  })
  assert.equal(text, '{"ok":true}')
  assert.deepEqual(calls.map((call) => call.url), [
    'https://gateway.example/v1/responses',
    'https://gateway.example/v1/chat/completions',
  ])
  assert.equal('response_format' in calls[1]!.body, false)
  assert.equal('reasoning_effort' in calls[1]!.body, false)
})

test('vision gateway uses input_image in Responses contract', async () => {
  let requestBody: Record<string, unknown> = {}
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body || '{}'))
    return new Response(JSON.stringify({ output_text: '识别文本' }), { status: 200 })
  }
  const text = await requestAiGatewayVisionText({
    baseUrl: 'https://gateway.example/v1',
    model: 'vision-model',
    prompt: 'OCR',
    imageDataUrls: ['data:image/png;base64,AA=='],
    maxTokens: 100,
    timeoutMs: 1000,
    fetchImpl: fetchImpl as typeof fetch,
  })
  assert.equal(text, '识别文本')
  const input = requestBody.input as Array<{ content: Array<{ type: string }> }>
  assert.deepEqual(input[0]?.content.map((part) => part.type), ['input_text', 'input_image'])
})
