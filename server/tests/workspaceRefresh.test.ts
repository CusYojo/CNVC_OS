import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createLatestRequestGuard, subscribeWorkspaceRefresh } from '../../src/lib/workspaceRefresh.js'

test('task, approval and calendar updates invalidate sibling views once per operation', async () => {
  const events = new EventTarget()
  let calls = 0
  const stop = subscribeWorkspaceRefresh(() => { calls++ }, events)
  for (const name of ['fde-task-changed', 'fde-calendar-refresh', 'fde-approval-changed']) events.dispatchEvent(new Event(name))
  assert.equal(calls, 0)
  await Promise.resolve()
  assert.equal(calls, 1)
  events.dispatchEvent(new Event('fde-task-changed'))
  await Promise.resolve()
  assert.equal(calls, 2)
  stop()
  events.dispatchEvent(new Event('fde-task-changed'))
  await Promise.resolve()
  assert.equal(calls, 2)
})

test('unmount cancels an already queued refresh', async () => {
  const events = new EventTarget()
  let calls = 0
  const stop = subscribeWorkspaceRefresh(() => { calls++ }, events)
  events.dispatchEvent(new Event('fde-approval-changed'))
  stop()
  await Promise.resolve()
  assert.equal(calls, 0)
})

test('old week / account / pre-mutation responses cannot overwrite current data', () => {
  const guard = createLatestRequestGuard()
  const oldWeek = guard.begin()
  const newWeek = guard.begin()
  assert.equal(oldWeek(), false)
  assert.equal(newWeek(), true)
  guard.invalidate()
  assert.equal(newWeek(), false)
  const afterWrite = guard.begin()
  assert.equal(afterWrite(), true)
})

test('both personal views subscribe; personal mutations publish shared invalidation', async () => {
  const dashboard = await readFile(new URL('../../src/pages/DashboardPage.tsx', import.meta.url), 'utf8')
  const calendar = await readFile(new URL('../../src/components/FdeCalendarPanel.tsx', import.meta.url), 'utf8')
  const weekly = await readFile(new URL('../../src/components/FdeCollaborationWeekly.tsx', import.meta.url), 'utf8')
  for (const source of [dashboard, calendar, weekly]) assert.match(source, /subscribeWorkspaceRefresh/)
  assert.ok((dashboard.match(/notifyTaskChanged\(\)/g) ?? []).length >= 4)
  assert.match(calendar, /notifyTaskChanged\(\)/)
  assert.match(calendar, /createLatestRequestGuard/)
  assert.match(dashboard, /createLatestRequestGuard/)
})
