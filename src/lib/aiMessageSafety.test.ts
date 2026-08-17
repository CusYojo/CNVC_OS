import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeAgentMessages } from './aiMessageSafety.js'

test('filters empty assistant retry messages while retaining visible messages', () => {
  const messages = normalizeAgentMessages([
    { id: 'user', role: 'user', parts: [{ type: 'text', text: '生成五页 PPT' }] },
    { id: 'empty-parts', role: 'assistant', parts: [] },
    { id: 'empty-text', role: 'assistant', parts: [{ type: 'text', text: '   ' }] },
    { id: 'tool', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'search', state: 'call' }] },
    { id: 'answer', role: 'assistant', parts: [{ type: 'text', text: '任务已创建' }] },
  ])

  assert.deepEqual(messages.map((message) => message.id), ['user', 'tool', 'answer'])
})

test('retains malformed assistant messages so the diagnostic remains visible', () => {
  const messages = normalizeAgentMessages([
    { id: 'malformed', role: 'assistant' },
  ])

  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.parts[0]?.type, 'unsupported')
})
