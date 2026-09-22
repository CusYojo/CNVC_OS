import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { calendarHourPixels, calendarMinuteAt, calendarPixelDelta, calendarTimeRange } from '../../src/lib/calendarScale.js'

const row = (startsAt: string, endsAt: string, allDay = false) => ({ startsAt, endsAt, allDay })
const week = '2026-09-21'

test('overview fits the available height without changing the detailed scale', () => {
  assert.equal(calendarHourPixels(520, { start: 420, end: 1200 }, true), 40)
  assert.equal(calendarHourPixels(390, { start: 420, end: 1200 }, true), 30)
  assert.equal(calendarHourPixels(390, { start: 420, end: 1200 }, false), 52)
  assert.equal(calendarHourPixels(120, { start: 420, end: 1200 }, true), 24)
  assert.equal(calendarHourPixels(0, { start: 420, end: 1200 }, true), 36)
  assert.equal(calendarHourPixels(2000, { start: 420, end: 1200 }, true), 64)
})

test('clicks, drag offsets and resize use the same 15-minute geometry at every zoom', () => {
  for (const hourPx of [24, 30, 36, 40, 52, 64]) {
    assert.equal(calendarMinuteAt(hourPx * 2.25, hourPx, { start: 420, end: 1200 }), 555)
    assert.equal(calendarMinuteAt(-30, hourPx, { start: 420, end: 1200 }), 420)
    assert.equal(calendarMinuteAt(hourPx * 15, hourPx, { start: 420, end: 1200 }), 1185)
    assert.equal(calendarPixelDelta(hourPx * 1.5, hourPx), 90)
    assert.equal(calendarPixelDelta(-hourPx / 2, hourPx), -30)
  }
})

test('overview includes early and late schedules in the visible week, ignoring hidden weekends and all-day markers', () => {
  const items = [row(`${week}T06:30:00+08:00`, `${week}T07:30:00+08:00`), row('2026-09-25T21:00:00+08:00', '2026-09-25T22:15:00+08:00'), row('2026-09-26T01:00:00+08:00', '2026-09-26T02:00:00+08:00'), row(`${week}T00:00:00+08:00`, `${week}T23:59:00+08:00`, true)]
  assert.deepEqual(calendarTimeRange(items, week, 5), { start: 360, end: 1380 })
  assert.deepEqual(calendarTimeRange(items, week, 7), { start: 60, end: 1380 })
  assert.deepEqual(calendarTimeRange([], week, 5), { start: 420, end: 1200 })
  assert.deepEqual(calendarTimeRange([row('invalid', 'invalid')], week, 5), { start: 420, end: 1200 })
  assert.deepEqual(calendarTimeRange([row(`${week}T00:00:00+08:00`, '2026-09-23T12:00:00+08:00')], week, 5), { start: 420, end: 1200 })
})

test('personal work screen keeps editable today todos beside the calendar without changing the standard workbench', async () => {
  const dashboard = await readFile(new URL('../../src/pages/DashboardPage.tsx', import.meta.url), 'utf8')
  const grid = await readFile(new URL('../../src/components/FdeTimeGrid.tsx', import.meta.url), 'utf8')
  assert.match(dashboard, /!embedded && \(current\.view === 'admin'/)
  assert.match(dashboard, /overview=\{embedded\}/)
  assert.match(dashboard, /<PersonalScheduleSidebar/)
  assert.doesNotMatch(dashboard, /待办与未来三天/)
  assert.match(dashboard, /className="personal-todo-body"/)
  assert.match(grid, /ResizeObserver/)
  assert.match(grid, /calendarMinuteAt/)
  assert.match(grid, /calendarPixelDelta/)
})

test('calendar card action stays within its block and separate from the resize handle', async () => {
  const css = await readFile(new URL('../../src/pages/CollaborationPage.css', import.meta.url), 'utf8')
  assert.match(css, /\.fde-collab-time-block > button \{[^}]*height: 100%;[^}]*min-height: 0;[^}]*overflow: hidden;/)
  assert.match(css, /\.fde-collab-time-block-head \{[^}]*white-space: nowrap;/)
})
