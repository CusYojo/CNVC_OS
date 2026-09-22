import assert from 'node:assert/strict'
import test from 'node:test'
import { executiveScreens, executiveScreenAtPosition, executiveVisibleRows, executiveScreenScrollLeft, executiveScreenProgress, executiveNavigationLens } from '../../src/lib/executiveScreen'

test('the executive home exposes every module in one horizontal reading order', () => {
  assert.deepEqual(executiveScreens.map(section => section.id), ['overview', 'projects', 'directives', 'risks', 'team', 'personal'])
  assert.equal(new Set(executiveScreens.map(section => section.id)).size, 6)
})

test('horizontal position selects the nearest screen and clamps elastic overscroll', () => {
  assert.equal(executiveScreenAtPosition(0, 1000, 20), 'overview')
  assert.equal(executiveScreenAtPosition(1020, 1000, 20), 'projects')
  assert.equal(executiveScreenAtPosition(1600, 1000, 20), 'directives')
  assert.equal(executiveScreenAtPosition(-80, 1000, 20), 'overview')
  assert.equal(executiveScreenAtPosition(99999, 1000, 20), 'personal')
  assert.equal(executiveScreenAtPosition(100, 0, 20), 'overview')
  assert.equal(executiveScreenAtPosition(NaN, 1000, 20), 'overview')
})

test('screen positioning uses the container width and preserves the module after resizing', () => {
  assert.equal(executiveScreenScrollLeft('projects', 1000, 20), 1020)
  assert.equal(executiveScreenScrollLeft('risks', 700, 12), 2136)
  assert.equal(executiveScreenScrollLeft('overview', 1000, 20), 0)
  assert.equal(executiveScreenScrollLeft('personal', 0, 20), 0)
  for (const screen of executiveScreens) {
    for (const width of [320, 768, 1280, 1920]) {
      assert.equal(executiveScreenAtPosition(executiveScreenScrollLeft(screen.id, width, 20), width, 20), screen.id)
    }
  }
})

test('expanding a collection preserves earlier rows and never mutates the source', () => {
  const rows = Array.from({ length: 19 }, (_, i) => i)
  assert.deepEqual(executiveVisibleRows(rows, false), rows.slice(0, 6))
  assert.deepEqual(executiveVisibleRows(rows, true), rows)
  assert.deepEqual(executiveVisibleRows([], true), [])
  assert.equal(rows.length, 19)
})

test('liquid navigation follows fractional scrolling without escaping the first or last screen', () => {
  assert.equal(executiveScreenProgress(510, 1000, 20), .5)
  assert.equal(executiveScreenProgress(-50, 1000, 20), 0)
  assert.equal(executiveScreenProgress(99000, 1000, 20), 5)
  assert.equal(executiveScreenProgress(NaN, 1000, 20), 0)
  assert.equal(executiveScreenProgress(100, 0, 20), 0)
  assert.equal(executiveScreenProgress(100, Infinity, 20), 0)
})

test('navigation lens settles exactly on each button and stretches gently in transit', () => {
  const bounds = [{ left: 4, top: 4, width: 100, height: 38 }, { left: 108, top: 4, width: 120, height: 38 }]
  assert.deepEqual(executiveNavigationLens(0, bounds), bounds[0])
  assert.deepEqual(executiveNavigationLens(1, bounds), bounds[1])
  const halfway = executiveNavigationLens(.5, bounds)!
  assert.equal(halfway.top, 4)
  assert.equal(halfway.height, 38)
  assert.equal(halfway.left + halfway.width / 2, 111)
  assert.ok(halfway.width > 110 && halfway.width <= 122)
  assert.deepEqual(executiveNavigationLens(-2, bounds), bounds[0])
  assert.deepEqual(executiveNavigationLens(99, bounds), bounds[1])
  assert.deepEqual(executiveNavigationLens(NaN, bounds), bounds[0])
  assert.equal(executiveNavigationLens(1, []), null)
})

test('lens handles wrapped navigation and respects reduced motion without stretching', () => {
  const bounds = [{ left: 160, top: 4, width: 100, height: 38 }, { left: 4, top: 46, width: 100, height: 38 }]
  const halfway = executiveNavigationLens(.5, bounds)!
  assert.equal(halfway.top, 25)
  assert.equal(halfway.left + halfway.width / 2, 132)
  assert.deepEqual(executiveNavigationLens(.25, bounds, true), bounds[0])
  assert.deepEqual(executiveNavigationLens(.75, bounds, true), bounds[1])
  assert.deepEqual(executiveNavigationLens(.5, [bounds[0]]), bounds[0])
})
