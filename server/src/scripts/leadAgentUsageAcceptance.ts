import assert from 'node:assert/strict'
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { leadAgentUsageMetrics } from '../services/leadAgentUsageService.js'

function result(input: {
  usage?: Record<string, unknown>
  modelUsage?: Record<string, Record<string, unknown>>
}) {
  return input as unknown as Pick<SDKResultMessage, 'usage' | 'modelUsage'>
}

const aggregate = leadAgentUsageMetrics(result({
  usage: {
    input_tokens: 100,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 30,
    output_tokens: 40,
  },
  modelUsage: { ignored: { inputTokens: 999, outputTokens: 999 } },
}))
assert.deepEqual(aggregate, {
  inputTokens: 150, outputTokens: 40, totalTokens: 190, source: 'aggregate-usage',
})

const modelFallback = leadAgentUsageMetrics(result({
  usage: { input_tokens: 0, output_tokens: 60 },
  modelUsage: {
    primary: { inputTokens: 200, cacheCreationInputTokens: 10, cacheReadInputTokens: 15, outputTokens: 55 },
    fallback: { input_tokens: 30, cache_read_input_tokens: 5, output_tokens: 7 },
  },
}))
assert.deepEqual(modelFallback, {
  inputTokens: 260, outputTokens: 60, totalTokens: 320, source: 'model-usage',
})

const unavailable = leadAgentUsageMetrics(result({
  usage: { input_tokens: -1, output_tokens: -2 },
  modelUsage: { invalid: { inputTokens: Number.NaN, outputTokens: -3 } },
}))
assert.deepEqual(unavailable, {
  inputTokens: 0, outputTokens: 0, totalTokens: 0, source: 'unavailable',
})

console.log(JSON.stringify({
  ok: true,
  checks: [
    'aggregate-snake-case-usage-includes-cache-input',
    'model-usage-fallback-supports-camel-and-snake-case',
    'aggregate-output-remains-authoritative-when-input-falls-back',
    'negative-and-non-finite-usage-is-not-invented',
  ],
}))
