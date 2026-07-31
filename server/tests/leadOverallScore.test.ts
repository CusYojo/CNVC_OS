import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveOverallScore } from '../src/services/aiSummaryService.js'

test('uses the latest scoring total instead of a stale stored score', () => {
  assert.equal(deriveOverallScore({ total: 55 }, 64), 55)
})

test('falls back to the stored score when scoring total is unavailable', () => {
  assert.equal(deriveOverallScore({}, 64), 64)
  assert.equal(deriveOverallScore({ total: null }, 64), 64)
})

test('accepts a numeric scoring total returned as text', () => {
  assert.equal(deriveOverallScore({ total: '62' }, 64), 62)
})
