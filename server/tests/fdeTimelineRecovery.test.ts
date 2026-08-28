import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearTimelineRecovery, readTimelineRecovery, saveTimelineRecovery, timelineRecoveryKey } from '../../src/lib/fdeTimelineRecovery.js'
const user = '0f6158f1-119d-4ccc-8c9b-93d8ec068b11', project = '5c87f18b-f636-40c8-8b2d-d35ef960c122', request = '307051cd-b476-441a-bd36-a2a63233b234'
const memory = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } } }
test('timeline recovery stores only a UUID scoped by account and project across remount', () => {
  const storage = memory(), key = timelineRecoveryKey(user, project)
  saveTimelineRecovery(storage, key, request)
  assert.equal(readTimelineRecovery(storage, key), request)
  assert.equal(readTimelineRecovery(storage, timelineRecoveryKey(project, user)), null)
  assert.throws(() => saveTimelineRecovery(storage, key, project))
  assert.throws(() => clearTimelineRecovery(storage, key, project))
  clearTimelineRecovery(storage, key, request); assert.equal(readTimelineRecovery(storage, key), null)
})
test('corrupt or unavailable storage does not authorize a new timeline mutation', () => {
  const storage = memory(), key = timelineRecoveryKey(user, project)
  storage.setItem(key, 'payload'); assert.throws(() => readTimelineRecovery(storage, key))
  assert.throws(() => saveTimelineRecovery({ ...storage, getItem: () => { throw new Error('blocked') } }, key, request))
  assert.throws(() => timelineRecoveryKey('invalid', project))
})
