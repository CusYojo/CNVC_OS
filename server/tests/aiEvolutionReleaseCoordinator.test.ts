import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coordinateEvolutionRelease, parseEvolutionReleaseReceipt, recoverEvolutionRelease } from '../src/runtime/evolution/evolutionReleaseCoordinator.js'

const identity = { schemaVersion: 1 as const, baseCommit: 'a'.repeat(40), patchHash: 'b'.repeat(64), lockHash: 'c'.repeat(64),
  serverEntrySha256: 'd'.repeat(64), webEntrySha256: 'e'.repeat(64) }

function fixture() {
  const calls: string[] = []
  let state: 'candidate' | 'previous' | 'unknown' = 'previous'
  const input: Parameters<typeof coordinateEvolutionRelease>[0] = {
    candidateHash: 'f'.repeat(64), authorize: async () => { calls.push('authorize') },
    prepare: async () => ({ releaseId: 'new', candidateHash: 'f'.repeat(64), previousReleaseId: 'old', candidateIdentity: identity, previousIdentity: identity }),
    claim: async () => { calls.push('claim') }, activate: async () => { calls.push('activate'); state = 'candidate' },
    inspect: async () => state, health: async () => true,
    rollback: async () => { calls.push('rollback'); state = 'previous' },
    finish: async (_receipt, outcome) => { calls.push(outcome) },
  }
  return { input, calls, setState: (value: typeof state) => { state = value } }
}

test('release receipt requires frozen runtime identities before any deployment action', async () => {
  assert.throws(() => parseEvolutionReleaseReceipt({ releaseId: 'new', candidateHash: 'f'.repeat(64), previousReleaseId: null }))
  assert.throws(() => parseEvolutionReleaseReceipt({ releaseId: 'new', candidateHash: 'f'.repeat(64), previousReleaseId: 'old', candidateIdentity: identity, previousIdentity: null }))
  const f = fixture()
  f.input.prepare = async () => ({ releaseId: 'new', candidateHash: 'f'.repeat(64), previousReleaseId: null,
    candidateIdentity: identity, previousIdentity: identity })
  await assert.rejects(coordinateEvolutionRelease(f.input))
  assert.deepEqual(f.calls, ['authorize'])
})

test('restart recovery records a healthy candidate without activating or claiming again', async () => {
  const f = fixture(); f.setState('candidate')
  const receipt = await f.input.prepare()
  assert.equal((await recoverEvolutionRelease({ ...f.input, receipt })).outcome, 'active')
  assert.deepEqual(f.calls, ['authorize', 'active'])
})

test('restart recovery rolls an unhealthy candidate back and verifies the previous version', async () => {
  const f = fixture(); f.setState('candidate')
  f.input.health = async (_receipt, version) => version === 'previous'
  assert.equal((await recoverEvolutionRelease({ ...f.input, receipt: await f.input.prepare() })).outcome, 'rolled_back')
  assert.deepEqual(f.calls, ['authorize', 'authorize', 'rollback', 'rolled_back'])
})

test('restart recovery never guesses success for unknown or changing target state', async () => {
  for (const mode of ['unknown', 'changed']) {
    const f = fixture(); f.setState(mode === 'unknown' ? 'unknown' : 'candidate')
    f.input.health = async () => { f.setState('unknown'); return true }
    await assert.rejects(recoverEvolutionRelease({ ...f.input, receipt: await f.input.prepare() }), { code: 'EVOLUTION_RELEASE_RECOVERY_REQUIRED' })
    assert.deepEqual(f.calls, ['authorize'])
  }
})

test('restart recovery preserves healthy state on bookkeeping failure and reports previous conservatively', async () => {
  const f = fixture(); f.setState('candidate')
  f.input.finish = async () => { throw Error('database unavailable') }
  await assert.rejects(recoverEvolutionRelease({ ...f.input, receipt: await f.input.prepare() }), /database unavailable/)
  assert.equal(f.calls.includes('rollback'), false)
  const previous = fixture()
  assert.equal((await recoverEvolutionRelease({ ...previous.input, receipt: await previous.input.prepare() })).outcome, 'failed')
  assert.deepEqual(previous.calls, ['authorize', 'failed'])
})
test('publication claims approval before activation and only records active after identity and health checks', async () => {
  const f = fixture()
  assert.equal((await coordinateEvolutionRelease(f.input)).outcome, 'active')
  assert.deepEqual(f.calls, ['authorize', 'authorize', 'claim', 'authorize', 'activate', 'active'])
})
test('an activation error after switching is recovered by verified rollback', async () => {
  const f = fixture()
  f.input.activate = async () => { f.setState('candidate'); throw Error('connection lost after switching') }
  assert.equal((await coordinateEvolutionRelease(f.input)).outcome, 'rolled_back')
  assert.deepEqual(f.calls.slice(-2), ['rollback', 'rolled_back'])
})
test('unknown target or unverified rollback never records a terminal release outcome', async () => {
  for (const mode of ['unknown', 'rollback-failed']) {
    const f = fixture()
    f.input.activate = async () => { f.setState(mode === 'unknown' ? 'unknown' : 'candidate'); throw Error('uncertain') }
    f.input.rollback = async () => { throw Error('unreachable') }
    await assert.rejects(coordinateEvolutionRelease(f.input), { code: 'EVOLUTION_RELEASE_RECOVERY_REQUIRED' })
    assert.equal(f.calls.some((call) => ['active', 'failed', 'rolled_back'].includes(call)), false)
  }
})
test('recording failure after a healthy deployment does not trigger an unrequested rollback', async () => {
  const f = fixture()
  f.input.finish = async () => { throw Error('database unavailable') }
  await assert.rejects(coordinateEvolutionRelease(f.input), /database unavailable/)
  assert.equal(f.calls.includes('rollback'), false)
})
