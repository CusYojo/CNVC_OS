import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeAgentMessage } from '../../src/lib/aiMessageSafety.js'

test('experience links preserve the external user message key only on user messages', () => {
  const id = 'user:00000000-0000-4000-8000-000000000001'
  const message = { id: 'database-id', role: 'user', parts: [{ type: 'text', text: '问题' }], metadata: { experienceTaskId: id } }
  assert.equal(normalizeAgentMessage(message).experienceTaskId, id)
  assert.equal(normalizeAgentMessage({ ...message, role: 'assistant' }).experienceTaskId, undefined)
  assert.equal(normalizeAgentMessage({ ...message, metadata: { experienceTaskId: '../other-task' } }).experienceTaskId, undefined)
  assert.equal(normalizeAgentMessage({ ...message, metadata: null }).experienceTaskId, undefined)
  assert.equal(normalizeAgentMessage(message).parts[0].text, '问题')
})
