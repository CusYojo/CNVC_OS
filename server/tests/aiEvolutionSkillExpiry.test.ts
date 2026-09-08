import test from 'node:test'
import assert from 'node:assert/strict'
import { createSkillExpiryWorker } from '../src/services/aiEvolutionSkillExpiryService.js'

test('expiry advances past failures and wraps after the final page', async () => {
  const cursors: Array<string | undefined> = []
  const expired: string[] = []
  const errors: unknown[] = []
  const worker = createSkillExpiryWorker({
    listExpired: async (_now, cursor) => {
      cursors.push(cursor)
      return cursor ? [{ id: 'last' }] : Array.from({ length: 100 }, (_, i) => ({ id: String(i) }))
    },
    expire: async id => { expired.push(id); if (id === '0') throw Error('unavailable artifact') },
    onError: error => { errors.push(error) },
  })
  await worker.tick(); await worker.tick(); await worker.tick()
  assert.deepEqual(cursors, [undefined, '99', undefined])
  assert.ok(expired.includes('last'))
  assert.equal(errors.length, 2)
  await worker.stop()
})

test('overlapping ticks share work and shutdown waits without starting another item', async () => {
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const expired: string[] = []
  const worker = createSkillExpiryWorker({ listExpired: async () => [{ id: 'first' }, { id: 'second' }],
    expire: async id => { expired.push(id); await barrier }, onError: error => { throw error } })
  const first = worker.tick()
  assert.equal(worker.tick(), first)
  await Promise.resolve()
  const stopped = worker.stop()
  release()
  await stopped
  await worker.tick()
  assert.deepEqual(expired, ['first'])
})
