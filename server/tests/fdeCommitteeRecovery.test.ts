import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { committeePendingKey, forgetCommitteePending, markerForCommittee, readCommitteePending, rememberCommitteePending, validateCommitteeReceipt, validateCommitteeRecovery } from '../../src/lib/fdeCommitteeRecovery.js'

test('committee recovery retains only actor-scoped IDs and refuses another pending command', () => {
  const storage = new Map<string, string>(), store = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) }, removeItem: (key: string) => { storage.delete(key) } }
  const key = committeePendingKey(randomUUID()), marker = markerForCommittee({ action: 'cancel', meetingId: randomUUID(), commandId: randomUUID(), expectedVersion: 4, reason: '不能进入浏览器存储的私人原因' })
  rememberCommitteePending(store, key, marker)
  assert.deepEqual(Object.keys(readCommitteePending(store, key)!).sort(), ['action', 'commandId', 'meetingId'])
  assert.ok(!store.getItem(key)?.includes('私人'))
  assert.throws(() => rememberCommitteePending(store, key, { ...marker, commandId: randomUUID() }))
  assert.throws(() => forgetCommitteePending(store, key, { ...marker, commandId: randomUUID() }))
  assert.equal(readCommitteePending(store, committeePendingKey(randomUUID())), null)
  forgetCommitteePending(store, key, marker); assert.equal(readCommitteePending(store, key), null)
})
test('committee recovery validates action, original meeting and minimal receipt; corrupt markers fail closed', () => {
  const marker = { action: 'save' as const, commandId: randomUUID(), meetingId: randomUUID() }
  const receipt = { ...marker, version: 2 }
  assert.deepEqual(validateCommitteeReceipt(receipt, marker), receipt)
  assert.throws(() => validateCommitteeReceipt({ ...receipt, meetingId: randomUUID() }, marker))
  assert.throws(() => validateCommitteeReceipt({ ...receipt, action: 'archive' }, marker))
  assert.throws(() => validateCommitteeRecovery({ state: 'committed', receipt: { ...receipt, minutes: 'secret' } }, marker))
  assert.deepEqual(validateCommitteeRecovery({ state: 'not_committed', receipt: null }, marker), { state: 'not_committed', receipt: null })
  assert.throws(() => readCommitteePending({ getItem: () => '{broken', setItem: () => {}, removeItem: () => {} }, 'x'))
})
