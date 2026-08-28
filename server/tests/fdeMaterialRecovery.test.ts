import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ApiError } from '../src/contracts/apiErrorContract.js'
import { materialResolveCommand } from '../src/contracts/fdeMaterialContract.js'
import { forgetMaterialPending, materialRecoveryKey, materialWriteId, materialWriteResultUnknown, readMaterialPending, rememberMaterialPending } from '../../src/lib/fdeMaterialRecovery.js'

const memory = () => {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
test('material recovery persists identifiers only, isolated by user/project across remount', () => {
  const storage = memory(), key = materialRecoveryKey('one', 'project'), request = { clientRequestId: randomUUID(), kind: 'submit' as const }
  rememberMaterialPending(storage, key, { ...request, title: 'never cache' } as typeof request)
  assert.deepEqual(readMaterialPending(storage, key), request)
  assert.equal(readMaterialPending(storage, materialRecoveryKey('two', 'project')), null)
  assert.equal(readMaterialPending(storage, materialRecoveryKey('one', 'other')), null)
  assert.equal(storage.getItem(key)?.includes('never cache'), false)
})
test('unresolved request cannot be replaced and stale completion cannot remove a different pointer', () => {
  const storage = memory(), key = 'recovery', request = { clientRequestId: randomUUID(), kind: 'return' as const }
  rememberMaterialPending(storage, key, request)
  assert.throws(() => rememberMaterialPending(storage, key, { ...request, clientRequestId: randomUUID() }))
  forgetMaterialPending(storage, key, randomUUID()); assert.deepEqual(readMaterialPending(storage, key), request)
  forgetMaterialPending(storage, key, request.clientRequestId); assert.equal(readMaterialPending(storage, key), null)
})
test('corrupt or unavailable recovery storage fails closed before sending a command', () => {
  const storage = memory(); storage.setItem('bad', '{broken')
  assert.throws(() => readMaterialPending(storage, 'bad'))
  storage.setItem('bad', JSON.stringify({ clientRequestId: randomUUID(), kind: 'approve', feedback: 'private' }))
  assert.throws(() => readMaterialPending(storage, 'bad'))
  assert.throws(() => rememberMaterialPending({ ...storage, setItem: () => { throw new Error('blocked storage') } }, 'new', { clientRequestId: randomUUID(), kind: 'withdraw' }))
})
test('transport/server/malformed responses remain unknown; explicit business rejection is distinct', () => {
  for (const error of [new TypeError('network failed'), new ApiError('timeout', 'TIMEOUT', 0), new ApiError('gateway', 'UPSTREAM', 502), new ApiError('html', 'BAD_RESPONSE', 404), new ApiError('untyped', 'HTTP_ERROR', 408)]) assert.equal(materialWriteResultUnknown(error), true)
  for (const error of [new ApiError('stale', 'VERSION_CONFLICT', 409), new ApiError('denied', 'MATERIAL_FORBIDDEN', 403), new ApiError('csrf', 'CSRF_INVALID', 403)]) assert.equal(materialWriteResultUnknown(error), false)
  const id = randomUUID(); assert.equal(materialWriteId({ id }), id)
  for (const result of [null, {}, { id: 'not-a-uuid' }, { code: 'BAD_JSON' }]) assert.throws(() => materialWriteId(result))
})
test('resolution input cannot inject actor, project, receipt outcome or material content', () => {
  const input = { clientRequestId: randomUUID() }
  assert.ok(materialResolveCommand.safeParse(input).success)
  for (const patch of [{ clientRequestId: '' }, { actorId: randomUUID() }, { state: 'committed' }, { title: 'forged' }]) assert.equal(materialResolveCommand.safeParse({ ...input, ...patch }).success, false)
})
