import assert from 'node:assert/strict'
import test from 'node:test'
import { createDirectSkillExecutionGuard } from '../src/services/directSkillExecutionGuard.js'

test('cancel interrupts a permanently silent SDK promise', async () => {
  const guard = createDirectSkillExecutionGuard({ totalMs: 1000, idleMs: 1000, pollMs: 5, shouldCancel: async () => true })
  try {
    await assert.rejects(guard.wait(new Promise(() => {})), { code: 'AI_TASK_CANCELLED' })
    assert.equal(guard.controller.signal.aborted, true)
  } finally { guard.dispose() }
})

test('silence and total deadlines are distinguishable', async () => {
  for (const [totalMs, idleMs, code] of [[1000, 10, 'DIRECT_SKILL_AGENT_IDLE_TIMEOUT'], [10, 1000, 'DIRECT_SKILL_AGENT_TIMEOUT']] as const) {
    const guard = createDirectSkillExecutionGuard({ totalMs, idleMs })
    try { await assert.rejects(guard.wait(new Promise(() => {})), { code }) }
    finally { guard.dispose() }
  }
})

test('resolved values pass through and disposing clears timers', async () => {
  const guard = createDirectSkillExecutionGuard({ totalMs: 1000, idleMs: 1000 })
  assert.equal(await guard.wait(Promise.resolve(42)), 42)
  guard.activity()
  guard.dispose()
  assert.equal(guard.controller.signal.aborted, false)
})

test('cancellation check failure fails closed without leaking database error', async () => {
  const guard = createDirectSkillExecutionGuard({ totalMs: 1000, idleMs: 1000, pollMs: 5, shouldCancel: async () => { throw Error('PRIVATE_DB_ADDRESS') } })
  try {
    await assert.rejects(guard.wait(new Promise(() => {})), (error: Error & { code?: string }) =>
      error.code === 'DIRECT_SKILL_AGENT_CANCEL_CHECK_FAILED' && !error.message.includes('PRIVATE'))
  } finally { guard.dispose() }
})
