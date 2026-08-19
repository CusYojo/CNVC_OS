import assert from 'node:assert/strict'
import test from 'node:test'
import { isMissingSdkConversationError, isMissingSdkConversationResult } from './jwAgentRuntime.js'

test('recognizes only the recoverable missing SDK conversation result', () => {
  assert.equal(isMissingSdkConversationResult({
    type: 'result',
    is_error: true,
    result: 'Claude Code returned an error result: No conversation found with session ID: session-1',
  }), true)
  assert.equal(isMissingSdkConversationResult({
    type: 'result',
    is_error: true,
    errors: ['No conversation found with session ID: session-2'],
  }), true)
  assert.equal(isMissingSdkConversationResult({
    type: 'result', is_error: true, result: '模型额度不足',
  }), false)
  assert.equal(isMissingSdkConversationResult({
    type: 'result', is_error: false, result: 'No conversation found with session ID: session-3',
  }), false)
  assert.equal(isMissingSdkConversationError(
    new Error('Claude Code returned an error result: No conversation found with session ID: stale-id'),
  ), true)
  assert.equal(isMissingSdkConversationError(new Error('其他运行时错误')), false)
})
