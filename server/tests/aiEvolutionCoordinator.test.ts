import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EvolutionRunCoordinator, type ClaimedEvolutionRun } from '../src/runtime/evolution/evolutionRunCoordinator.js'

test('typed coordinator applies the same kind to queue claims and cleanup recovery', async () => {
  const kinds: unknown[] = []
  const f = fixture()
  const coordinator = new EvolutionRunCoordinator({ ...f.repository,
    claimNext: async (_worker, _lease, _now, kind) => { kinds.push(kind); return null },
    revokeExpired: async (_now, kind) => { kinds.push(kind); return [] },
    listPendingTermination: async kind => { kinds.push(kind); return [] },
  }, 'skill-worker', async () => { assert.fail('no queued task') }, f.terminate, 'skill')
  await coordinator.tick()
  assert.deepEqual(kinds, ['skill', 'skill', 'skill'])
})

function fixture() {
  const calls: string[] = []
  const errors: { code: string; message: string }[] = []
  const run = { id: 'run', attempt: 1, leaseToken: 2, inputHash: 'hash', elapsedSeconds: 0, budget: { maxDurationSeconds: 60 } } as ClaimedEvolutionRun
  const repository = {
    revokeExpired: async () => [], listPendingTermination: async () => [],
    claimNext: async () => { calls.push('claim'); return run }, heartbeat: async () => ({ cancelRequested: false, budget: run.budget }),
    revokeRun: async (_identity: unknown, error: { code: string; message: string }) => { errors.push(error); calls.push('revoke'); return { ...run, leaseToken: 3 } },
    confirmTermination: async () => { calls.push('confirmed') },
  }
  const terminate = async () => { calls.push('terminate') }
  return { calls, run, repository, terminate, errors }
}

test('execution failure revokes lease before cleanup and only then confirms terminal status', async () => {
  const f = fixture()
  const coordinator = new EvolutionRunCoordinator(f.repository, 'worker', async () => { throw new Error('private error') }, f.terminate)
  await coordinator.tick()
  assert.deepEqual(f.calls, ['claim', 'revoke', 'terminate', 'confirmed'])
  assert.equal(f.errors[0].code, 'EVOLUTION_EXECUTION_FAILED')
  assert.equal(JSON.stringify(f.errors).includes('private error'), false)
})

test('failed acceptance persists its specific repair-budget reason for the run UI', async () => {
  const f = fixture()
  const coordinator = new EvolutionRunCoordinator(f.repository, 'worker', async () => {
    throw Object.assign(new Error('private model response'), { code: 'EVOLUTION_REPAIR_BUDGET_EXHAUSTED' })
  }, f.terminate)
  await coordinator.tick()
  assert.deepEqual(f.errors, [{ code: 'EVOLUTION_REPAIR_BUDGET_EXHAUSTED', message: '候选验收未通过，修复轮次已用完，请查看验收证据' }])
})

test('cancel request prevents execution and still goes through termination confirmation', async () => {
  const f = fixture()
  f.repository.heartbeat = async () => ({ cancelRequested: true, budget: f.run.budget })
  const coordinator = new EvolutionRunCoordinator(f.repository, 'worker', async () => { assert.fail('must not execute') }, f.terminate)
  await coordinator.tick()
  assert.deepEqual(f.calls, ['claim', 'revoke', 'terminate', 'confirmed'])
})

test('cleanup failure never confirms that the environment has stopped', async () => {
  const f = fixture()
  const coordinator = new EvolutionRunCoordinator(f.repository, 'worker', async () => { throw new Error('failure') }, async () => { throw new Error('docker unavailable') })
  await assert.rejects(coordinator.tick(), /docker unavailable/)
  assert.equal(f.calls.includes('confirmed'), false)
})

test('successful candidate is committed only after its environment has stopped', async () => {
  const f = fixture()
  const coordinator = new EvolutionRunCoordinator(f.repository, 'worker', async () => {
    f.calls.push('prepared')
    return { commit: async () => { f.calls.push('committed') } }
  }, f.terminate)
  await coordinator.tick()
  assert.deepEqual(f.calls, ['claim', 'prepared', 'terminate', 'committed'])
})

test('cancellation during successful cleanup prevents candidate success', async () => {
  const f = fixture()
  const coordinator = new EvolutionRunCoordinator(f.repository, 'worker', async () => ({
    commit: async () => { assert.fail('cancelled candidate must not be committed') },
  }), async () => {
    f.calls.push('terminate')
    f.repository.heartbeat = async () => ({ cancelRequested: true, budget: f.run.budget })
  })
  await coordinator.tick()
  assert.deepEqual(f.calls, ['claim', 'terminate', 'revoke', 'terminate', 'confirmed'])
})

test('recovery never claims new work while an expired environment cannot be confirmed stopped', async () => {
  const f = fixture()
  const repository = { ...f.repository,
    listPendingTermination: async () => [{ ...f.run, leaseToken: 3 }],
  }
  const coordinator = new EvolutionRunCoordinator(repository, 'restarted-worker', async () => { assert.fail('must not execute') },
    async (identity) => {
      assert.equal(identity.leaseToken, 2, 'cleanup must address the previous executor container')
      throw Error('daemon unreachable')
    })
  await assert.rejects(coordinator.tick(), /daemon unreachable/)
  assert.equal(f.calls.includes('claim'), false)
  assert.equal(f.calls.includes('confirmed'), false)
})
