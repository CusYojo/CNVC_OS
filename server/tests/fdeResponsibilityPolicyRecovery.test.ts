import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { responsibilityPolicyCurrentView, responsibilityPolicyFormMatches, responsibilityPolicyListView } from '../src/contracts/fdeResponsibilityPolicyViewContract.js'
import { responsibilityEvents } from '../src/contracts/fdeResponsibilityPolicyContract.js'
import { forgetResponsibilityPolicyPending, readResponsibilityPolicyPending, rememberResponsibilityPolicyPending, responsibilityPolicyPending, responsibilityPolicyRecoveryKey, responsibilityPolicyResolvedResult, responsibilityPolicyWriteReceipt, type ResponsibilityPolicyPending } from '../../src/lib/fdeResponsibilityPolicyRecovery.js'

const marker = (): ResponsibilityPolicyPending => ({ action: 'save', commandId: randomUUID(), versionId: randomUUID(), enabled: null })
const memory = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } } }
test('responsibility policy markers are actor scoped, minimal and reject arbitrary payloads', () => {
  const store = memory(), value = marker(), key = responsibilityPolicyRecoveryKey('one')
  rememberResponsibilityPolicyPending(store, key, value)
  assert.deepEqual(readResponsibilityPolicyPending(store, key), value)
  assert.equal(readResponsibilityPolicyPending(store, responsibilityPolicyRecoveryKey('two')), null)
  for (const bad of [{ ...value, reason: 'private' }, { ...value, configuration: {} }, { ...value, url: '/admin' }, { ...value, versionId: '../../admin' }, { ...value, enabled: true }]) assert.equal(responsibilityPolicyPending.safeParse(bad).success, false)
})
test('policy pending writes and clears compare the entire marker', () => {
  const store = memory(), value = marker()
  rememberResponsibilityPolicyPending(store, 'k', value)
  for (const bad of [marker(), { ...value, action: 'approve' as const }]) {
    assert.throws(() => rememberResponsibilityPolicyPending(store, 'k', bad))
    assert.throws(() => forgetResponsibilityPolicyPending(store, 'k', bad))
  }
  assert.deepEqual(readResponsibilityPolicyPending(store, 'k'), value)
  forgetResponsibilityPolicyPending(store, 'k', value); assert.equal(readResponsibilityPolicyPending(store, 'k'), null)
})
test('blocked or corrupt storage cannot be treated as no pending policy command', () => {
  const store = memory(), value = marker()
  for (const method of ['getItem', 'setItem'] as const) assert.throws(() => rememberResponsibilityPolicyPending({ ...store, [method]: () => { throw new Error('blocked') } }, 'k', value))
  rememberResponsibilityPolicyPending(store, 'k', value)
  assert.throws(() => forgetResponsibilityPolicyPending({ ...store, removeItem: () => { throw new Error('blocked') } }, 'k', value))
  store.setItem('k', '{'); assert.throws(() => readResponsibilityPolicyPending(store, 'k'))
})
test('all five policy receipts bind command, action, target and semantic result', () => {
  for (const action of ['create', 'save', 'approve', 'publish', 'toggle'] as const) {
    const value = responsibilityPolicyPending.parse({ action, commandId: randomUUID(), versionId: action === 'create' || action === 'toggle' ? null : randomUUID(), enabled: action === 'toggle' ? false : null })
    const receipt = { commandId: value.commandId, action, versionId: action === 'create' ? randomUUID() : value.versionId, draftVersion: action === 'toggle' ? null : 2, policyVersion: 3, status: action === 'create' || action === 'save' ? 'draft' : action === 'approve' ? 'approved' : action === 'publish' ? 'published' : 'disabled' }
    assert.deepEqual(responsibilityPolicyWriteReceipt(receipt, value), receipt)
    assert.deepEqual(responsibilityPolicyResolvedResult({ state: 'committed', receipt }, value), { state: 'committed', receipt })
    assert.throws(() => responsibilityPolicyWriteReceipt({ ...receipt, commandId: randomUUID() }, value))
    assert.throws(() => responsibilityPolicyWriteReceipt({ ...receipt, status: 'enabled' }, value))
    assert.throws(() => responsibilityPolicyWriteReceipt({ ...receipt, versionId: action === 'create' ? null : randomUUID() }, value))
  }
})
test('a reliable miss requires the explicit closed result, not an empty lookup', () => {
  const value = marker()
  assert.deepEqual(responsibilityPolicyResolvedResult({ state: 'not_committed', receipt: null }, value), { state: 'not_committed', receipt: null })
  for (const bad of [null, {}, { found: false }, { state: 'not_committed', receipt: {} }]) assert.throws(() => responsibilityPolicyResolvedResult(bad, value))
})
test('policy views distinguish absent publication, disabled publication and paging', () => {
  const current = { policy: null, activeVersion: null, capabilities: { manage: true, approve: false } }
  assert.deepEqual(responsibilityPolicyCurrentView.parse(current), current)
  const list = { ...current, versions: [], events: [], page: 2, eventPage: 1, hasMore: false, eventsHaveMore: false, productionScoringImplemented: false }
  assert.deepEqual(responsibilityPolicyListView.parse(list), list)
  assert.equal(responsibilityPolicyCurrentView.safeParse({ ...current, personnelScores: [] }).success, false)
  assert.equal(responsibilityPolicyListView.safeParse({ ...list, productionScoringImplemented: true }).success, false)
})

test('approval cannot target a persisted version while the form displays unsaved or invalid changes', () => {
  const config = { rules: responsibilityEvents.map(rule => ({ code: rule.code, mode: rule.mode, enabled: false, points: null })), timezone: 'Asia/Shanghai', calendar: { workingWeekdays: [1], holidays: [], extraWorkingDates: [] }, earlyWorkingDays: null, graceMinutes: null, appealLimit: 1, appealAggregation: 'exclude_pending', allowAdjustment: false, allowExemption: false, completionAggregation: 'one_per_task', feedbackAggregation: 'one_per_actor_task_business_day', missingReviewer: 'retain_pending_assignment', history: 'append_only_no_automatic_rescore' }
  assert.equal(responsibilityPolicyFormMatches(structuredClone(config), config), true)
  for (const changed of [{ ...config, graceMinutes: 30 }, { ...config, allowAdjustment: true }, { ...config, calendar: { ...config.calendar, holidays: ['2026-10-01'] } }, { ...config, rules: [] }]) assert.equal(responsibilityPolicyFormMatches(changed, config), false)
})
