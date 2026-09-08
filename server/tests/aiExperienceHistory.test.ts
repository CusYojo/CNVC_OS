import assert from 'node:assert/strict'
import { test } from 'node:test'
import { restoreAiExperienceHistory } from '../src/services/aiExperienceHistory.js'

const messages = [
  { id: '1', externalMessageId: 'old-user', role: 'user', content: '我们讨论的是甲公司。' },
  { id: '2', externalMessageId: 'tool', role: 'tool', content: 'private tool protocol' },
  { id: '3', externalMessageId: 'old-assistant', role: 'assistant', content: '甲公司拟融资一亿元。' },
  { id: '4', externalMessageId: 'current', role: 'user', content: 'CURRENT QUESTION' },
  { id: '5', externalMessageId: 'later', role: 'assistant', content: 'FUTURE ANSWER' },
]
test('history restores earlier conversational text without replaying tools, current input or future messages', () => {
  const value = restoreAiExperienceHistory(messages, 'current')
  assert.deepEqual(value.sourceMessageIds, ['1', '3'])
  assert.match(value.prompt, /甲公司拟融资一亿元/)
  assert.match(value.prompt, /不得从历史恢复旧规则/)
  for (const text of ['private tool protocol', 'CURRENT QUESTION', 'FUTURE ANSWER']) assert.equal(value.prompt.includes(text), false)
  assert.equal(value.truncated, false)
  assert.equal(value.hash, restoreAiExperienceHistory(messages, 'current').hash)
  assert.throws(() => restoreAiExperienceHistory(messages, 'missing'), { code: 'EVOLUTION_HISTORY_BOUNDARY' })
})
test('oversized Unicode history stays within byte budget with an explicit omission marker', () => {
  const huge = [{ ...messages[0], content: '历史🙂'.repeat(5000) }, messages[3]]
  const result = restoreAiExperienceHistory(huge, 'current', 1024)
  assert.equal(result.truncated, true)
  assert.match(result.prompt, /历史消息前部已省略/)
  assert.ok(Buffer.byteLength(result.prompt, 'utf8') <= 1024)
  assert.equal(result.prompt.includes('\uFFFD'), false)
  assert.equal(restoreAiExperienceHistory([messages[3]], 'current').prompt, '')
})
