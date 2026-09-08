import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('JW runtime loads approved experiences and summarizes only successful completed turns', async () => {
  const source = await readFile(new URL('../src/runtime/jwAgentRuntime.ts', import.meta.url), 'utf8')
  assert.match(source, /loadAssistantExperiencePrompt\(userId, refreshed\.agent\.projectId\)/)
  assert.match(source, /loadedAssistantExperiences: loaded\.versions/)
  assert.match(source, /!raw\.is_error && session\.assistantSeenForPending/)
  assert.match(source, /recordAssistantCompletedTurn/)
  assert.match(source, /\[当前用户请求\]/)
})
