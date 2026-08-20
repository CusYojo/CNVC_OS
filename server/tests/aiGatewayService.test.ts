import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aiGatewayResponseText,
  buildAiChatFallbackBody,
  buildAiResponsesBody,
  requestAiGatewayText,
  requestAiGatewayVisionText,
  fetchAiGatewayChatCompatible,
} from '../src/services/aiGatewayService.js'
import {
  normalizeAiTaskModelUsage,
  runWithAiTaskModelUsage,
  type AiTaskModelUsage,
} from '../src/runtime/aiTaskModelUsage.js'

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

test('AI gateway normalizes Responses, Chat and Anthropic-compatible token usage', () => {
  assert.deepEqual(normalizeAiTaskModelUsage({ usage: {
    input_tokens: 100,
    output_tokens: 40,
    total_tokens: 140,
    input_tokens_details: { cached_tokens: 25 },
    output_tokens_details: { reasoning_tokens: 12 },
  } }), {
    inputTokens: 100,
    outputTokens: 40,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 25,
    reasoningTokens: 12,
    totalTokens: 140,
  })
  assert.deepEqual(normalizeAiTaskModelUsage({
    prompt_tokens: 80,
    completion_tokens: 20,
    total_tokens: 100,
    prompt_tokens_details: { cached_tokens: 10 },
  }), {
    inputTokens: 80,
    outputTokens: 20,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 10,
    reasoningTokens: 0,
    totalTokens: 100,
  })
  assert.deepEqual(normalizeAiTaskModelUsage({
    input_tokens: 60,
    output_tokens: 15,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 30,
  }), {
    inputTokens: 60,
    outputTokens: 15,
    cacheCreationInputTokens: 5,
    cacheReadInputTokens: 30,
    reasoningTokens: 0,
    totalTokens: 110,
  })
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

test('AI gateway records task usage and preserves it in Chat-compatible responses', async () => {
  const observed: Array<AiTaskModelUsage | null> = []
  const fetchImpl = async () => new Response(JSON.stringify({
    output_text: '{"ok":true}',
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens_details: { reasoning_tokens: 8 },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  const response = await runWithAiTaskModelUsage({
    taskId: 'task-usage-test',
    onModelCall: (usage) => { observed.push(usage) },
  }, () => fetchAiGatewayChatCompatible('https://gateway.example/v1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'return json' }],
      max_tokens: 100,
    }),
  }, fetchImpl as typeof fetch, 1000))

  const payload = await response.json() as {
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      total_tokens?: number
      prompt_tokens_details?: { cached_tokens?: number }
      completion_tokens_details?: { reasoning_tokens?: number }
    }
  }
  assert.equal(observed.length, 1)
  assert.equal(observed[0]?.totalTokens, 150)
  assert.equal(payload.usage?.prompt_tokens, 120)
  assert.equal(payload.usage?.completion_tokens, 30)
  assert.equal(payload.usage?.total_tokens, 150)
  assert.equal(payload.usage?.prompt_tokens_details?.cached_tokens, 40)
  assert.equal(payload.usage?.completion_tokens_details?.reasoning_tokens, 8)
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
