import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEvolutionDurableModelBudget } from '../src/runtime/evolution/evolutionDurableModelBudget.js'

const identity = { runId: 'run', attempt: 1, leaseToken: 1, inputHash: 'a'.repeat(64) }
test('reservation keys survive adapter recreation and uncertain calls are never silently repeated', async () => {
  const keys = new Set<string>()
  const repository = {
    reserveModelCall: async (_identity: unknown, key: string) => {
      const mayInvoke = !keys.has(key); keys.add(key)
      return { reservationId: key, mayInvoke, status: 'reserved' }
    },
    settleModelCall: async () => ({ budgetExceeded: false, duplicate: false }),
  }
  const first = createEvolutionDurableModelBudget(repository, identity, 'model')
  await first.reserveModelTokens(1000)
  const restarted = createEvolutionDurableModelBudget(repository, identity, 'model')
  await assert.rejects(restarted.reserveModelTokens(1000), { code: 'EVOLUTION_MODEL_CALL_UNCERTAIN' })
  await first.recordModelUsage(null, 1000)
  await first.reserveModelTokens(1000)
  assert.equal(keys.size, 2)
})
