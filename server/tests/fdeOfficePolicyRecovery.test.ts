import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { officePolicyCommandTarget } from '../src/contracts/fdeOfficePolicyCommandContract.js'
import { forgetPolicyPending, policyCommandPath, policyRecoveryKey, policyResolvedResult, policyWriteReceipt, readPolicyPending, rememberPolicyPending, type PolicyPending } from '../../src/lib/fdeOfficePolicyRecovery.js'

const marker = (): PolicyPending => ({ id: randomUUID(), clientRequestId: randomUUID(), action: 'save' })
const memory = () => { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) }, removeItem: (key: string) => { map.delete(key) } } }
test('rule recovery retains only an account-scoped action/target/command', () => {
  const s = memory(), m = marker(), key = policyRecoveryKey('a')
  rememberPolicyPending(s, key, { ...m, configuration: 'private' } as PolicyPending)
  assert.deepEqual(readPolicyPending(s, key), m); assert.equal(readPolicyPending(s, policyRecoveryKey('b')), null)
  assert.equal(s.getItem(key)?.includes('private'), false)
})
test('rule recovery rejects arbitrary paths, identity injection and corrupt storage', () => {
  const s = memory(), m = marker()
  for (const value of [null, {}, { ...m, id: 'x' }, { ...m, action: 'delete' }, { ...m, actorId: randomUUID() }, { ...m, path: '/admin' }]) {
    s.setItem('key', JSON.stringify(value)); assert.throws(() => readPolicyPending(s, 'key')); assert.equal(officePolicyCommandTarget.safeParse(value).success, false)
  }
})
test('pending rule marker cannot be replaced or cleared by a different operation', () => {
  const s = memory(), m = marker(); rememberPolicyPending(s, 'key', m)
  assert.throws(() => rememberPolicyPending(s, 'key', marker())); assert.throws(() => forgetPolicyPending(s, 'key', { ...m, action: 'publish' }))
  assert.deepEqual(readPolicyPending(s, 'key'), m); forgetPolicyPending(s, 'key', m); assert.equal(readPolicyPending(s, 'key'), null)
})
test('blocked storage does not silently remove recovery protection', () => {
  const s = memory(), m = marker(); rememberPolicyPending(s, 'key', m)
  for (const method of ['getItem', 'setItem'] as const) assert.throws(() => rememberPolicyPending({ ...s, [method]: () => { throw new Error('blocked') } }, 'key', m))
  assert.throws(() => forgetPolicyPending({ ...s, removeItem: () => { throw new Error('blocked') } }, 'key', m)); assert.deepEqual(readPolicyPending(s, 'key'), m)
})
test('rule receipts bind the action/target and reject private fields or malformed success', () => {
  const m = marker(), receipt = { id: m.id, action: m.action, policyId: randomUUID(), version: 1, policyVersion: 2, status: 'draft', enabled: false }
  assert.deepEqual(policyWriteReceipt(receipt, m), receipt)
  for (const value of [{}, { ...receipt, id: randomUUID() }, { ...receipt, action: 'publish' }, { ...receipt, version: 0 }, { ...receipt, configuration: {} }]) assert.throws(() => policyWriteReceipt(value, m))
  assert.deepEqual(policyResolvedResult({ state: 'not_applied' }, m), { state: 'not_applied' })
  assert.deepEqual(policyResolvedResult({ state: 'committed', receipt }, m), { state: 'committed', receipt })
  assert.throws(() => policyResolvedResult({ found: false }, m)); assert.throws(() => policyResolvedResult({ state: 'committed', receipt: { ...receipt, action: 'enabled' } }, m))
})
test('rule actions use constrained routes, never a stored request URL', () => {
  const m = marker(); assert.equal(policyCommandPath(m), `/system-administration/office-policy-versions/${m.id}/save`)
  assert.equal(policyCommandPath({ ...m, action: 'publish' }), `/system-administration/office-policy-versions/${m.id}/publish`)
  assert.equal(policyCommandPath({ ...m, action: 'enabled' }), `/system-administration/office-policies/${m.id}/enabled`)
})
