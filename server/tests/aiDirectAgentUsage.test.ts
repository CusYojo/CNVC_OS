import assert from 'node:assert/strict'
import test from 'node:test'
import { directAgentTurnUsage } from '../src/runtime/directAgentUsage.js'

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
})
