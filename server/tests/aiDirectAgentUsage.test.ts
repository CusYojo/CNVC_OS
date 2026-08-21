import assert from 'node:assert/strict'
import test from 'node:test'
import {
  directAgentResultUsage,
  directAgentTurnUsage,
} from '../src/runtime/directAgentUsage.js'

test('direct Skill Agent exposes completed assistant-turn usage before the final result', () => {
  const usage = {
    input_tokens: 120,
    output_tokens: 30,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 50,
  }
  assert.deepEqual(directAgentTurnUsage({
    type: 'assistant',
    message: { usage },
  }), usage)
})

test('direct Skill Agent ignores aggregate result and malformed usage for incremental accounting', () => {
  assert.equal(directAgentTurnUsage({ type: 'result', message: { usage: { input_tokens: 1 } } }), null)
  assert.equal(directAgentTurnUsage({ type: 'assistant', message: { usage: null } }), null)
  assert.equal(directAgentTurnUsage({
    type: 'assistant',
    message: { usage: { input_tokens: 0, output_tokens: 0 } },
  }), null)
})

test('direct Skill Agent falls back to modelUsage when aggregate usage is all zero', () => {
  assert.deepEqual(directAgentResultUsage({
    type: 'result',
    usage: { input_tokens: 0, output_tokens: 60 },
    modelUsage: {
      primary: {
        inputTokens: 200,
        outputTokens: 55,
        cacheCreationInputTokens: 10,
        cacheReadInputTokens: 15,
      },
      fallback: {
        input_tokens: 30,
        output_tokens: 7,
        cache_read_input_tokens: 5,
      },
    },
  }), {
    input_tokens: 230,
    output_tokens: 60,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 20,
    total_tokens: 320,
  })
})

test('direct Skill Agent does not publish a numeric total when all final sources are zero', () => {
  assert.equal(directAgentResultUsage({
    type: 'result',
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: { primary: { inputTokens: 0, outputTokens: 0 } },
  }), null)
})
