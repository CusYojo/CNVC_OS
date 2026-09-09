import assert from 'node:assert/strict'
import test from 'node:test'
import {
  codexStructuredOutputRuntime,
  runCodexStructuredOutput,
} from '../src/services/codexStructuredOutputService.js'

test('Codex gateway transport uses the compatible model endpoint and retains usage', async () => {
  const previousBase = process.env.LLM_BASE_URL
  const previousKey = process.env.LLM_API_KEY
  process.env.LLM_BASE_URL = 'https://gateway.example/v1'
  process.env.LLM_API_KEY = 'test-key'
  try {
    const execution = await runCodexStructuredOutput({
      profile: 'test-profile',
      systemPrompt: 'Return JSON.',
      prompt: 'Return ok.',
      outputSchema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' } }, required: ['ok'],
      },
      model: 'gpt-5.6-sol',
      timeoutMs: 30_000,
      runtime: 'codex-gateway',
      fetchImpl: (async () => new Response(JSON.stringify({
        output_text: '{"ok":true}',
        usage: { input_tokens: 12, output_tokens: 3 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch,
    })
    assert.equal(execution.runtime, 'codex-gateway')
    assert.deepEqual(execution.output, { ok: true })
    assert.equal(execution.usage.inputTokens, 12)
    assert.equal(execution.usage.outputTokens, 3)
    assert.equal(execution.usage.totalTokens, 15)
  } finally {
    if (previousBase === undefined) delete process.env.LLM_BASE_URL
    else process.env.LLM_BASE_URL = previousBase
    if (previousKey === undefined) delete process.env.LLM_API_KEY
    else process.env.LLM_API_KEY = previousKey
  }
})

test('Codex transport defaults to CLI and supports an explicit gateway override', () => {
  assert.equal(codexStructuredOutputRuntime({}), 'codex-cli')
  assert.equal(codexStructuredOutputRuntime({ CODEX_STRUCTURED_OUTPUT_TRANSPORT: 'gateway' }), 'codex-gateway')
})
