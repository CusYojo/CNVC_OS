import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coordinateRequestedEvolutionRollback } from '../src/runtime/evolution/evolutionRequestedRollback.js'

const hash = (char: string) => char.repeat(64)
const identity = (char: string) => ({ schemaVersion: 1 as const, baseCommit: char.repeat(40), patchHash: hash(char),
  lockHash: hash(char), serverEntrySha256: hash(char), webEntrySha256: hash(char) })
const receipt = { releaseId: 'release-1', candidateHash: hash('a'), previousReleaseId: 'release-0',
  candidateIdentity: identity('a'), previousIdentity: identity('b') }

test('requested rollback reauthorizes around claim and verifies previous identity and health', async () => {
  let state: 'candidate' | 'previous' = 'candidate'
  const calls: string[] = []
  const result = await coordinateRequestedEvolutionRollback({ receipt,
    authorize: async () => { calls.push('authorize') }, claim: async () => { calls.push('claim') },
    inspect: async () => state, rollback: async () => { calls.push('rollback'); state = 'previous' },
    health: async () => { calls.push('health'); return true }, finish: async (_, outcome) => { calls.push(`finish:${outcome}`) } })
  assert.equal(result.outcome, 'rolled_back')
  assert.deepEqual(calls, ['authorize', 'claim', 'authorize', 'rollback', 'health', 'finish:rolled_back'])
})

test('requested rollback refuses stale target before consuming approval', async () => {
  let claimed = false
  await assert.rejects(() => coordinateRequestedEvolutionRollback({ receipt, authorize: async () => undefined,
    claim: async () => { claimed = true }, inspect: async () => 'previous', rollback: async () => undefined,
    health: async () => true, finish: async () => undefined }), (error: { code?: string }) => error.code === 'EVOLUTION_ROLLBACK_STATE')
  assert.equal(claimed, false)
})

test('requested rollback never records success without a stable healthy previous version', async () => {
  let state: 'candidate' | 'previous' | 'unknown' = 'candidate', finished = false
  await assert.rejects(() => coordinateRequestedEvolutionRollback({ receipt, authorize: async () => undefined,
    claim: async () => undefined, inspect: async () => state, rollback: async () => { state = 'unknown' },
    health: async () => true, finish: async () => { finished = true } }),
  (error: { code?: string }) => error.code === 'EVOLUTION_ROLLBACK_RECOVERY_REQUIRED')
  assert.equal(finished, false)
})
