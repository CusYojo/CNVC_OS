import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDirectSkillDiagnostics } from '../src/services/directSkillDiagnostics.js'

test('tool failures are correlated, persisted as error, and do not leak content', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'skill-diagnostics-'))
  const records: Record<string, unknown>[] = []
  try {
    const log = createDirectSkillDiagnostics(directory, { taskId: 'task', skill: 'proposal', model: 'test' }, (record) => records.push(record))
    await log.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'PRIVATE_ARGUMENT' } }] } })
    await log.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', is_error: true, content: 'Permission denied PRIVATE_COMPANY_FACT token=secret' }] } })
    const content = await readFile(path.join(directory, 'agent.jsonl'), 'utf8')
    assert.equal(content.includes('PRIVATE_'), false)
    assert.equal(content.includes('token=secret'), false)
    assert.equal(records[1].level, 'error')
    assert.equal(records[1].toolName, 'Bash')
    assert.equal(records[1].toolUseId, 'tool1')
    assert.equal(records[1].diagnostic, 'permission_denied')
    assert.equal(typeof records[1].durationMs, 'number')
    assert.equal(content.trim().split('\n').length, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('successful tool and result text are omitted; result metadata is retained', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'skill-diagnostics-'))
  try {
    const log = createDirectSkillDiagnostics(directory, { taskId: 'task', skill: 'proposal', model: 'test' }, () => {})
    await log.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read1', content: 'PRIVATE_SOURCE_TEXT' }] } })
    await log.observe({ type: 'result', subtype: 'success', result: 'PRIVATE_FINAL_TEXT', num_turns: 4 })
    const content = await readFile(path.join(directory, 'agent.jsonl'), 'utf8')
    assert.equal(content.includes('PRIVATE_'), false)
    assert.equal(JSON.parse(content.trim().split('\n')[1]).numTurns, 4)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
