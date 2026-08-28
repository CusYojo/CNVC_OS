import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ApiError } from '../src/contracts/apiErrorContract.js'
import { officeResolveCommand } from '../src/contracts/fdeOfficeContract.js'
import { forgetOfficePending, officeRecoveryKey, officeResolvedResult, officeWriteReceipt, officeWriteResultUnknown, readOfficePending, rememberOfficePending } from '../../src/lib/fdeOfficeRecovery.js'

const memory = () => {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
const marker = () => { const id = randomUUID(); return { id, commandId: randomUUID(), path: `/oa/office/requests/${id}/save` } }
test('office reload recovery retains only identifiers and supports the prior storage shape', () => {
  const storage = memory(), pending = marker(), key = officeRecoveryKey('one')
  rememberOfficePending(storage, key, { ...pending, body: 'private application' } as typeof pending)
  assert.deepEqual(readOfficePending(storage, key), pending)
  assert.equal(readOfficePending(storage, officeRecoveryKey('two')), null)
  assert.equal(storage.getItem(key)?.includes('private'), false)
  assert.equal(officeRecoveryKey('one'), 'fde-office-pending:one')
})
test('office markers reject malformed identifiers, extra fields and replay paths outside their request', () => {
  const storage = memory(), pending = marker()
  for (const bad of [null, false, {}, { ...pending, id: '-'.repeat(36) }, { ...pending, body: 'secret' }, { ...pending, path: 'https://other.invalid/write' }, { ...pending, path: `/oa/office/requests/${randomUUID()}/save` }, { ...pending, path: `${pending.path}?next=other` }, { ...pending, path: pending.path.replace('/save', '/commands/resolve') }]) {
    storage.setItem('bad', JSON.stringify(bad)); assert.throws(() => readOfficePending(storage, 'bad'))
  }
  for (const suffix of ['save', 'actions', `attachments/${randomUUID()}`, `attachments/${randomUUID()}/grants`]) {
    const value = { ...pending, path: `/oa/office/requests/${pending.id}/${suffix}` }
    storage.setItem('valid', JSON.stringify(value)); assert.deepEqual(readOfficePending(storage, 'valid'), value)
  }
})
test('office outstanding key cannot be replaced or removed by a stale completion', () => {
  const storage = memory(), pending = marker(), key = 'pending'
  rememberOfficePending(storage, key, pending)
  assert.throws(() => rememberOfficePending(storage, key, marker()))
  assert.throws(() => rememberOfficePending(storage, key, { ...pending, path: pending.path.replace('/save', '/actions') }))
  assert.equal(forgetOfficePending(storage, key, marker()), false)
  assert.deepEqual(readOfficePending(storage, key), pending)
  assert.equal(forgetOfficePending(storage, key, pending), true)
  assert.equal(readOfficePending(storage, key), null)
})
test('office unavailable storage fails closed without silently dropping the pointer', () => {
  const storage = memory(), pending = marker()
  for (const method of ['getItem', 'setItem'] as const) assert.throws(() => rememberOfficePending({ ...storage, [method]: () => { throw new Error('storage blocked') } }, 'pending', pending))
  rememberOfficePending(storage, 'pending', pending)
  assert.throws(() => forgetOfficePending({ ...storage, removeItem: () => { throw new Error('storage blocked') } }, 'pending', pending))
  assert.deepEqual(readOfficePending(storage, 'pending'), pending)
})
test('office malformed success, foreign receipt and ambiguous errors cannot unlock a new command', () => {
  const id = randomUUID(), receipt = { id, version: 3 }
  assert.deepEqual(officeWriteReceipt(receipt, id), receipt)
  for (const value of [null, {}, { id, version: 0 }, { id, version: '1' }, { ...receipt, title: 'private' }, { ...receipt, id: randomUUID() }, { code: 'BAD_JSON' }]) assert.throws(() => officeWriteReceipt(value, id))
  for (const error of [new TypeError('network'), new ApiError('timeout', 'TIMEOUT', 0), new ApiError('timeout', 'TIMEOUT', 408), new ApiError('html', 'BAD_RESPONSE', 404), new ApiError('proxy', 'HTTP_ERROR', 403), new ApiError('server', 'INTERNAL_ERROR', 500)]) assert.equal(officeWriteResultUnknown(error), true)
  assert.equal(officeWriteResultUnknown(new ApiError('version', 'OFFICE_VERSION_CONFLICT', 409)), false)
})
test('office resolution requires a validated terminal result and forbids injected identity or content', () => {
  const id = randomUUID(), input = { clientRequestId: randomUUID() }
  assert.deepEqual(officeResolveCommand.parse(input), input)
  for (const patch of [{ actorId: randomUUID() }, { state: 'not_applied' }, { title: 'private' }]) assert.throws(() => officeResolveCommand.parse({ ...input, ...patch }))
  assert.deepEqual(officeResolvedResult({ state: 'not_applied' }, id), { state: 'not_applied' })
  assert.deepEqual(officeResolvedResult({ state: 'committed', receipt: { id, version: 2 } }, id), { state: 'committed', receipt: { id, version: 2 } })
  for (const result of [null, { found: false }, { state: 'committed' }, { state: 'not_applied', body: {} }, { state: 'committed', receipt: { id: randomUUID(), version: 1 } }]) assert.throws(() => officeResolvedResult(result, id))
})
