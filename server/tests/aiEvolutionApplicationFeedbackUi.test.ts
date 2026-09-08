import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('experience application feedback binds the persisted application and current task evidence', async () => {
  const source = await readFile('src/components/ai-evolution/AiExperienceApplication.tsx', 'utf8')
  assert.match(source, /applicationId: value\.id/)
  assert.match(source, /evidenceRefs: \[\{ type: 'task', id: taskId \}\]/)
  assert.match(source, /'Idempotency-Key': crypto\.randomUUID\(\)/)
  for (const label of ['效果良好', '结果不正确', '发现回归', '改进建议']) assert.match(source, new RegExp(label))
})
