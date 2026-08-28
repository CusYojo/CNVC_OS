import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ApiError } from '../src/contracts/apiErrorContract.js'
import { knowledgeCommandTarget } from '../src/contracts/fdeKnowledgeCommandContract.js'
import { forgetKnowledgePending, knowledgeCommandPath, knowledgeRecoveryKey, knowledgeResolvedResult, knowledgeWriteReceipt, knowledgeWriteResultUnknown, readKnowledgePending, rememberKnowledgePending, type KnowledgePending } from '../../src/lib/fdeKnowledgeRecovery.js'

const marker = (): KnowledgePending => ({ id: randomUUID(), clientRequestId: randomUUID(), action: 'save' })
const memory = () => { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) }, removeItem: (key: string) => { map.delete(key) } } }
test('knowledge recovery survives reread with only account-scoped identifiers', () => {
  const storage = memory(), value = marker(), key = knowledgeRecoveryKey('a')
  rememberKnowledgePending(storage, key, { ...value, summary: 'private', payload: {}, path: '/admin' } as KnowledgePending)
  assert.deepEqual(readKnowledgePending(storage, key), value)
  assert.equal(readKnowledgePending(storage, knowledgeRecoveryKey('b')), null)
  assert.equal(storage.getItem(key)?.includes('private'), false)
})
test('strict knowledge targets bind comment identity and reject identity/path injection', () => {
  const value = marker()
  for (const raw of [null, {}, { ...value, actorId: randomUUID() }, { ...value, path: '/admin' }, { ...value, action: 'delete' }, { ...value, commentId: randomUUID() }, { ...value, action: 'withdraw-comment' }]) assert.equal(knowledgeCommandTarget.safeParse(raw).success, false)
  const comment = { ...value, action: 'withdraw-comment' as const, commentId: randomUUID() }
  assert.deepEqual(knowledgeCommandTarget.parse(comment), comment)
})
test('knowledge marker replacement and stale cleanup cannot erase another operation', () => {
  const storage = memory(), value = marker(); rememberKnowledgePending(storage, 'key', value)
  assert.throws(() => rememberKnowledgePending(storage, 'key', marker()))
  assert.throws(() => forgetKnowledgePending(storage, 'key', { ...value, action: 'publish' }))
  assert.deepEqual(readKnowledgePending(storage, 'key'), value)
  forgetKnowledgePending(storage, 'key', value); assert.equal(readKnowledgePending(storage, 'key'), null)
})
test('corrupt or blocked storage fails closed and retains the original marker', () => {
  const storage = memory(), value = marker(); rememberKnowledgePending(storage, 'key', value)
  for (const method of ['getItem', 'setItem'] as const) assert.throws(() => rememberKnowledgePending({ ...storage, [method]: () => { throw new Error('blocked') } }, 'key', value))
  assert.throws(() => forgetKnowledgePending({ ...storage, removeItem: () => { throw new Error('blocked') } }, 'key', value))
  assert.deepEqual(readKnowledgePending(storage, 'key'), value)
  storage.setItem('key', '{'); assert.throws(() => readKnowledgePending(storage, 'key'))
})
test('knowledge receipts are minimal and bound to the entry, not found=false', () => {
  const value = marker(), receipt = { id: value.id, version: 1 }
  assert.deepEqual(knowledgeWriteReceipt(receipt, value), receipt)
  assert.deepEqual(knowledgeResolvedResult({ state: 'committed', receipt }, value), { state: 'committed', receipt })
  assert.deepEqual(knowledgeResolvedResult({ state: 'not_applied' }, value), { state: 'not_applied' })
  for (const bad of [{}, { ...receipt, id: randomUUID() }, { ...receipt, version: 0 }, { ...receipt, summary: 'private' }]) assert.throws(() => knowledgeWriteReceipt(bad, value))
  assert.throws(() => knowledgeResolvedResult({ found: false }, value))
  assert.throws(() => knowledgeResolvedResult({ state: 'not_applied', receipt }, value))
})
test('all knowledge action routes are derived, never read from browser storage', () => {
  const value = marker(), commentId = randomUUID()
  for (const [action, suffix] of [['save', 'save'], ['publish', 'actions'], ['archive', 'actions'], ['comment', 'comments'], ['rate', 'rating']] as const) assert.equal(knowledgeCommandPath({ ...value, action }), `/company-knowledge/${value.id}/${suffix}`)
  assert.equal(knowledgeCommandPath({ ...value, action: 'withdraw-comment', commentId }), `/company-knowledge/${value.id}/comments/${commentId}/withdraw`)
})
test('network, malformed and server responses remain unknown; explicit rejection still needs fencing', () => {
  for (const error of [new Error('network'), new ApiError('timeout', 'TIMEOUT', 408), new ApiError('server', 'FAIL', 500), new ApiError('bad', 'BAD_JSON', 200), new ApiError('bad', 'HTTP_ERROR', 403)]) assert.equal(knowledgeWriteResultUnknown(error), true)
  assert.equal(knowledgeWriteResultUnknown(new ApiError('version', 'VERSION_CONFLICT', 409)), false)
})
