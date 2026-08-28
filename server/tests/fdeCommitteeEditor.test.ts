import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { committeeCommand } from '../src/contracts/fdeCommitteeContract.js'
import { CommitteeEditorEpoch, committeeEditorAccessFailure, committeeFormError, pinCommitteeEditorTarget, reconcileCommitteeEditor } from '../../src/lib/fdeCommitteeEditor.js'
import { committeePendingKey, markerForCommittee, readCommitteePending, reserveCommitteePending, validateCommitteeRecovery } from '../../src/lib/fdeCommitteeRecovery.js'

test('editor target is a frozen copy: a background detail refresh cannot rebase old input', () => {
  const detail = { id: randomUUID(), version: 3 }, target = pinCommitteeEditorTarget(detail)
  const originalId = detail.id
  detail.id = randomUUID(); detail.version = 9
  assert.deepEqual(target, { meetingId: originalId, expectedVersion: 3 })
  assert.ok(Object.isFrozen(target))
  assert.throws(() => pinCommitteeEditorTarget({ id: 'display-name', version: 1 }))
})
test('late success or failure from another selection, editor generation or account cannot update the active editor', () => {
  const clock = new CommitteeEditorEpoch(), account = randomUUID(), first = randomUUID(), second = randomUUID()
  const opening = clock.begin(account, first)
  assert.ok(clock.accepts(opening, account, first))
  assert.equal(clock.accepts(opening, account, second), false)
  assert.equal(clock.accepts(opening, randomUUID(), first), false)
  clock.invalidate()
  assert.equal(clock.accepts(opening, account, first), false)
  const newest = clock.begin(account, second)
  assert.ok(clock.accepts(newest, account, second))
  assert.equal(clock.accepts(opening, account, first), false)
})
test('a second focus check invalidates a late first check, including a late permission denial', () => {
  const clock = new CommitteeEditorEpoch(), account = randomUUID(), meeting = randomUUID()
  const first = clock.begin(account, meeting), latest = clock.begin(account, meeting)
  assert.equal(clock.accepts(first, account, meeting), false)
  assert.ok(clock.accepts(latest, account, meeting))
})
test('clearing protected views rejects late board, detail and project-candidate reads without discarding the draft', () => {
  const views = new CommitteeEditorEpoch(), account = randomUUID(), draft = { minutes: '仍有权限时保留输入', target: pinCommitteeEditorTarget({ id: randomUUID(), version: 2 }) }
  const pending = ['board', 'detail', 'project-candidates'].map(() => views.capture(account, ''))
  const before = JSON.stringify(draft)
  views.invalidate()
  for (const token of pending) assert.equal(views.accepts(token, account, ''), false)
  assert.equal(JSON.stringify(draft), before)
  assert.ok(views.accepts(views.capture(account, ''), account, ''))
})
test('authorized unchanged focus preserves a draft; changed version or archive blocks without changing its pinned version', () => {
  const target = pinCommitteeEditorTarget({ id: randomUUID(), version: 7 }), draft = { title: '尚未保存的纪要', target, minutes: '原输入不丢弃' }
  const before = JSON.stringify(draft)
  assert.equal(reconcileCommitteeEditor(target, { allowed: true, version: 7, writable: true }), 'ready')
  assert.equal(reconcileCommitteeEditor(target, { allowed: true, version: 8, writable: true }), 'conflict')
  assert.equal(reconcileCommitteeEditor(target, { allowed: true, version: 7, writable: false }), 'conflict')
  assert.equal(JSON.stringify(draft), before)
  assert.equal(reconcileCommitteeEditor(null, { allowed: true, version: null, writable: true }), 'ready')
})
test('wrong or malformed permission replies never restore protected input', () => {
  const target = pinCommitteeEditorTarget({ id: randomUUID(), version: 1 })
  for (const reply of [{ allowed: false, version: 1, writable: true }, { allowed: true, version: null, writable: true }, { allowed: true, version: 1, writable: true, contents: 'injected' }, { allowed: true, version: 1 }]) assert.throws(() => reconcileCommitteeEditor(target, reply))
  assert.throws(() => reconcileCommitteeEditor(null, { allowed: true, version: 1, writable: true }))
})
test('revocation/session loss clears protected input; network/server failures keep it hidden rather than treating absence as authorization', () => {
  for (const status of [401, 403, 404]) assert.equal(committeeEditorAccessFailure({ status }), 'clear')
  for (const status of [0, 408, 409, 500, 503]) assert.equal(committeeEditorAccessFailure({ status }), 'hidden')
  assert.equal(committeeEditorAccessFailure(new Error('offline')), 'hidden')
})
test('validation errors are readable field messages for the dialog, not raw Zod JSON', () => {
  const parsed = committeeCommand.safeParse({ action: 'link_decision' })
  assert.equal(parsed.success, false)
  if (!parsed.success) { const message = committeeFormError(parsed.error); assert.ok(message.includes('meetingId')); assert.ok(!message.startsWith('[\n')); assert.ok(message.includes('；')) }
})

function storage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
// Deterministic lock adapter tests the real reservation helper; it does not mock
// a successful API, database transaction or browser end-to-end result.
function locks() {
  let tail = Promise.resolve()
  return { request: (_key: string, callback: () => Promise<void>) => { const work = tail.then(callback); tail = work.catch(() => {}); return work } } as unknown as Pick<LockManager, 'request'>
}
test('two tabs cannot both reserve different commands into the same account slot', async () => {
  const store = storage(), lock = locks(), key = committeePendingKey(randomUUID())
  const a = { commandId: randomUUID(), action: 'record' as const, meetingId: randomUUID() }, b = { ...a, commandId: randomUUID() }
  const results = await Promise.allSettled([reserveCommitteePending(lock, store, key, a), reserveCommitteePending(lock, store, key, b)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.deepEqual(readCommitteePending(store, key), a)
})
test('different accounts retain separate slots; unsupported locking fails before writing a marker', async () => {
  const store = storage(), lock = locks(), key = committeePendingKey(randomUUID()), other = committeePendingKey(randomUUID())
  const marker = { commandId: randomUUID(), action: 'cancel' as const, meetingId: randomUUID() }
  await assert.rejects(reserveCommitteePending(undefined, store, key, marker), /跨标签提交保护/)
  assert.equal(readCommitteePending(store, key), null)
  await Promise.all([reserveCommitteePending(lock, store, key, marker), reserveCommitteePending(lock, store, other, marker)])
  assert.deepEqual(readCommitteePending(store, key), readCommitteePending(store, other))
})
test('late decision recovery keeps only IDs, binds action and never persists minutes or original-file metadata', () => {
  const command = committeeCommand.parse({ action: 'link_decision', commandId: randomUUID(), meetingId: randomUUID(), expectedVersion: 4, agendaId: randomUUID(), approvalId: randomUUID(), resolutionFile: { fileId: randomUUID(), version: 2 }, reason: '追加既有正式投决审批' })
  const marker = markerForCommittee(command)
  assert.deepEqual(Object.keys(marker).sort(), ['action', 'commandId', 'meetingId'])
  assert.equal(validateCommitteeRecovery({ state: 'committed', receipt: { ...marker, version: 5 } }, marker).state, 'committed')
  assert.throws(() => validateCommitteeRecovery({ state: 'committed', receipt: { ...marker, version: 5, action: 'record' } }, marker))
})
