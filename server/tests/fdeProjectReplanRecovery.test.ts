import assert from 'node:assert/strict'
import test from 'node:test'
import { clearReplanPending, readReplanPending, replanRecoveryKey, saveReplanPending, validateReplanReceipt, validateReplanResolution, type ReplanPending } from '../../src/lib/fdeProjectReplanRecovery.js'
import { approvalCenterDetailPath } from '../src/contracts/fdeApprovalCenterContract.js'
import { milestoneSourceTarget } from '../src/contracts/fdeMilestoneSourcesContract.js'
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222', c = '33333333-3333-4333-8333-333333333333'
const storage = () => { const values = new Map<string, string>(); return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v) }, removeItem: (k: string) => { values.delete(k) } } }
const submit: ReplanPending = { kind: 'submit', commandId: c }
test('recovery is scoped by real project/account and stores only opaque identifiers', () => {
  assert.notEqual(replanRecoveryKey(a, b), replanRecoveryKey(b, a))
  assert.throws(() => replanRecoveryKey('admin', b))
  const s = storage(), key = replanRecoveryKey(a, b)
  saveReplanPending(s, key, submit); assert.deepEqual(readReplanPending(s, key), submit)
  assert.throws(() => saveReplanPending(s, key, submit))
  assert.throws(() => clearReplanPending(s, key, { kind: 'submit', commandId: a }))
  clearReplanPending(s, key, submit); assert.equal(readReplanPending(s, key), null)
})
test('malformed, foreign and failed storage remain fail-closed', () => {
  const s = storage(), key = replanRecoveryKey(a, b)
  for (const bad of ['{', 'null', JSON.stringify({ ...submit, targetDate: '2026-01-01' })]) { s.setItem(key, bad); assert.throws(() => readReplanPending(s, key)); assert.throws(() => saveReplanPending(s, key, submit)) }
  assert.throws(() => saveReplanPending({ getItem: () => null, setItem: () => {}, removeItem: () => {} }, key, submit))
})
test('matching receipt and terminal unknown-request fence only', () => {
  assert.equal(validateReplanReceipt({ kind: 'replan', id: a, version: 1 }, submit).id, a)
  assert.throws(() => validateReplanReceipt({ kind: 'schedule', id: a, version: 1 }, submit))
  assert.throws(() => validateReplanReceipt({ kind: 'replan', id: a, version: 2 }, submit))
  const action: ReplanPending = { kind: 'action', commandId: c, requestId: b, expectedVersion: 3 }
  assert.throws(() => validateReplanReceipt({ kind: 'replan', id: a, version: 4 }, action))
  assert.throws(() => validateReplanReceipt({ kind: 'replan', id: b, version: 3 }, action))
  assert.equal(validateReplanResolution({ state: 'committed', receipt: { kind: 'replan', id: b, version: 4 } }, action).state, 'committed')
  assert.equal(validateReplanResolution({ state: 'closed', receipt: null }, action).state, 'closed')
  assert.throws(() => validateReplanResolution({ state: 'unknown', receipt: null }, action))
})
test('approval center and calendar route to exact overall request, not node approval', () => {
  const path = approvalCenterDetailPath({ id: a, projectId: b, businessType: 'project_replan' }, 'view=processed&page=2')
  assert.match(path, /replan=/); assert.match(path, /project-replan-/); assert.doesNotMatch(path, /schedule=/)
  assert.equal(milestoneSourceTarget({ projectId: b, approvalId: a, sourceKind: 'replan' }), `/projects/${b}?tab=workflow&replan=${a}#project-replan-${a}`)
  assert.match(milestoneSourceTarget({ projectId: b, approvalId: a }), /schedule=/)
})
