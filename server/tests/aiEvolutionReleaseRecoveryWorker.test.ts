import assert from 'node:assert/strict'
import test from 'node:test'
import { createEvolutionReleaseRecoveryWorker, type PendingEvolutionRelease } from '../src/services/aiEvolutionReleaseRecoveryWorker.js'

const row = (id: string): PendingEvolutionRelease => ({ approvalId: id, candidateId: `candidate-${id}`,
  actorUserId: `actor-${id}`, targetEnvironment: 'local' })

test('recovery worker serializes ticks, advances past failures and retries them on the next scan', async () => {
  const calls: string[] = [], errors: string[] = []
  let scans = 0, releaseList: (() => void) | undefined
  const worker = createEvolutionReleaseRecoveryWorker({
    list: async cursor => { calls.push(`list:${cursor ?? ''}`); scans += 1; return scans <= 2 ? [row('1'), row('2')] : [] },
    recover: async item => {
      calls.push(`recover:${item.approvalId}`)
      if (item.approvalId === '1' && scans === 1) throw Error('temporary')
      if (item.approvalId === '2' && scans === 2) await new Promise<void>(resolve => { releaseList = resolve })
    },
    onError: (error, item) => errors.push(`${item?.approvalId}:${(error as Error).message}`),
  })
  await worker.tick()
  assert.deepEqual(calls, ['list:', 'recover:1', 'recover:2'])
  assert.deepEqual(errors, ['1:temporary'])
  const active = worker.tick(), duplicate = worker.tick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.filter(value => value === 'list:').length, 2)
  releaseList!(); await Promise.all([active, duplicate])
  assert.deepEqual(calls.slice(-2), ['recover:1', 'recover:2'])
  await worker.stop()
  await worker.tick()
  assert.equal(calls.filter(value => value.startsWith('list:')).length, 2)
})

test('recovery worker reports list failures and can retry without overlapping scans', async () => {
  let scans = 0
  const errors: string[] = []
  const worker = createEvolutionReleaseRecoveryWorker({ list: async () => { scans += 1; if (scans === 1) throw Error('db down'); return [] },
    recover: async () => assert.fail('empty scan'), onError: error => errors.push((error as Error).message) })
  await worker.tick(); await worker.tick(); await worker.stop()
  assert.equal(scans, 2); assert.deepEqual(errors, ['db down'])
})
