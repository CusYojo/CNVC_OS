import assert from 'node:assert/strict'
import test from 'node:test'
import { runEvolutionReleaseRecovery } from '../src/runtime/evolution/evolutionReleaseRecovery.js'

const identity = { schemaVersion: 1 as const, baseCommit: 'a'.repeat(40), patchHash: 'b'.repeat(64), lockHash: 'c'.repeat(64),
  serverEntrySha256: 'd'.repeat(64), webEntrySha256: 'e'.repeat(64) }

function fixture() {
  let authorized = true, held = true
  const calls: string[] = []
  const controller = new AbortController()
  const input: Parameters<typeof runEvolutionReleaseRecovery>[0] = {
    claim: { status: 'activating', receipt: { releaseId: 'new', previousReleaseId: 'old', candidateHash: 'a'.repeat(64), candidateIdentity: identity, previousIdentity: identity } },
    control: { signal: controller.signal, assertHeld: async () => { if (!held) throw Error('lock lost') } },
    authorize: async () => { if (!authorized) throw Error('permission revoked') },
    adapter: {
      inspect: async () => { calls.push('inspect'); return 'candidate' },
      health: async (_receipt, _version, signal) => { assert.equal(signal, controller.signal); calls.push('health'); return true },
      rollback: async () => { calls.push('rollback') },
    },
    finish: async (_receipt, outcome) => { calls.push(outcome) },
  }
  return { input, calls, revoke: () => { authorized = false }, lose: () => { held = false; controller.abort() } }
}

test('persisted completed recovery is idempotent and does not access deployment', async () => {
  const f = fixture(); f.input.claim.status = 'active'
  assert.equal((await runEvolutionReleaseRecovery(f.input)).duplicate, true)
  assert.deepEqual(f.calls, [])
  f.revoke()
  await assert.rejects(runEvolutionReleaseRecovery(f.input), /permission revoked/)
})

test('locked recovery verifies deployment before writing completion', async () => {
  const f = fixture()
  const result = await runEvolutionReleaseRecovery(f.input)
  assert.equal(result.outcome, 'active'); assert.equal(result.duplicate, false)
  assert.deepEqual(f.calls, ['inspect', 'health', 'inspect', 'active'])
})

test('revocation or lock loss during health prevents completion and rollback', async () => {
  for (const reason of ['revoked', 'lost']) {
    const f = fixture()
    f.input.adapter.health = async () => { reason === 'revoked' ? f.revoke() : f.lose(); return true }
    await assert.rejects(runEvolutionReleaseRecovery(f.input))
    assert.equal(f.calls.includes('active'), false)
    assert.equal(f.calls.includes('rollback'), false)
  }
})
