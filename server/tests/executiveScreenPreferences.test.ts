import assert from 'node:assert/strict'
import test from 'node:test'
import { executiveScreenAtPosition, executiveScreenProgress, executiveScreenScrollLeft } from '../../src/lib/executiveScreen'
import {
  defaultExecutiveScreenPreferences, normalizeExecutiveScreenPreferences, visibleExecutiveScreenIds,
  moveExecutiveScreen, toggleExecutiveScreen, resolveExecutiveScreen,
  executiveScreenPreferenceKey, readExecutiveScreenPreferences, saveExecutiveScreenPreferences,
} from '../../src/lib/executiveScreenPreferences'

test('preferences sanitize unknown or duplicate modules and retain at least one visible module', () => {
  const defaults = defaultExecutiveScreenPreferences()
  for (const invalid of [null, [], 'bad', { version: 99 }, { order: [] }]) {
    assert.deepEqual(normalizeExecutiveScreenPreferences(invalid), defaults)
  }
  const value = normalizeExecutiveScreenPreferences({ version: 1, order: ['risks', 'risks', 'bad', 'overview'], hidden: ['team', 'team', 'bad'] })
  assert.deepEqual(value.order, ['risks', 'overview', 'projects', 'directives', 'team', 'personal'])
  assert.deepEqual(value.hidden, ['team'])
  assert.deepEqual(visibleExecutiveScreenIds(normalizeExecutiveScreenPreferences({ ...defaults, hidden: defaults.order })), ['overview'])
  assert.deepEqual(normalizeExecutiveScreenPreferences({ version: 1, order: null, hidden: null }), defaults)
})

test('reordering and visibility changes are immutable and cannot hide the final module', () => {
  const defaults = defaultExecutiveScreenPreferences()
  const moved = moveExecutiveScreen(defaults, 'projects', -1)
  assert.deepEqual(moved.order.slice(0, 2), ['projects', 'overview'])
  assert.equal(defaults.order[0], 'overview')
  assert.deepEqual(moveExecutiveScreen(moved, 'projects', -1), moved)
  assert.deepEqual(moveExecutiveScreen(defaults, 'personal', 1), defaults)
  assert.deepEqual(moveExecutiveScreen(moved, 'projects', 1), defaults)
  let only = defaults
  for (const id of defaults.order.slice(1)) only = toggleExecutiveScreen(only, id)
  assert.deepEqual(visibleExecutiveScreenIds(only), ['overview'])
  assert.deepEqual(toggleExecutiveScreen(only, 'overview'), only)
  assert.deepEqual(visibleExecutiveScreenIds(toggleExecutiveScreen(only, 'personal')), ['overview', 'personal'])
})

test('active module survives reordering; hiding it selects the first visible module', () => {
  assert.equal(resolveExecutiveScreen('personal', ['risks', 'personal']), 'personal')
  assert.equal(resolveExecutiveScreen('overview', ['risks', 'personal']), 'risks')
  assert.equal(resolveExecutiveScreen(undefined, ['personal']), 'personal')
  const preferences = { ...defaultExecutiveScreenPreferences(), hidden: ['risks'] as const }
  assert.ok(!visibleExecutiveScreenIds(preferences).includes('risks'))
  assert.ok(visibleExecutiveScreenIds(preferences, 'risks').includes('risks'))
  assert.deepEqual(preferences.hidden, ['risks']) // A shortcut never silently changes the saved selection.
})

test('swiping, page count and positions use selected order, not the original six modules', () => {
  const order = ['personal', 'overview', 'risks'] as const
  assert.equal(executiveScreenAtPosition(0, 1000, 20, order), 'personal')
  assert.equal(executiveScreenAtPosition(1020, 1000, 20, order), 'overview')
  assert.equal(executiveScreenAtPosition(99999, 1000, 20, order), 'risks')
  assert.equal(executiveScreenScrollLeft('risks', 1000, 20, order), 2040)
  assert.equal(executiveScreenScrollLeft('projects', 1000, 20, order), null)
  assert.equal(executiveScreenProgress(99999, 1000, 20, 3), 2)
  assert.equal(executiveScreenAtPosition(99999, 1000, 20, ['personal']), 'personal')
  assert.equal(executiveScreenProgress(99999, 1000, 20, 1), 0)
})

test('preferences persist per account; corrupt or inaccessible browser storage is safe', () => {
  const values = new Map<string, string>()
  const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } })
  const saved = toggleExecutiveScreen(moveExecutiveScreen(defaultExecutiveScreenPreferences(), 'projects', -1), 'team')
  assert.notEqual(executiveScreenPreferenceKey('a'), executiveScreenPreferenceKey('b'))
  assert.equal(saveExecutiveScreenPreferences('a', saved, storage), true)
  assert.deepEqual(readExecutiveScreenPreferences('a', storage), saved)
  assert.deepEqual(readExecutiveScreenPreferences('b', storage), defaultExecutiveScreenPreferences())
  values.set(executiveScreenPreferenceKey('a'), '{broken')
  assert.deepEqual(readExecutiveScreenPreferences('a', storage), defaultExecutiveScreenPreferences())
  const blocked = () => { throw new Error('Storage unavailable') }
  assert.deepEqual(readExecutiveScreenPreferences('a', blocked), defaultExecutiveScreenPreferences())
  assert.equal(saveExecutiveScreenPreferences('a', saved, blocked), false)
  assert.deepEqual(readExecutiveScreenPreferences('', storage), defaultExecutiveScreenPreferences())
  assert.equal(saveExecutiveScreenPreferences('', saved, storage), false)
})
