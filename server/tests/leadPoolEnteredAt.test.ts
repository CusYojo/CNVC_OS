import assert from 'node:assert/strict'
import test from 'node:test'
import { derivePoolEnteredAt } from '../src/services/aiSummaryService.js'

test('uses the database insertion timestamp as the pool entry time', () => {
  const createdAt = new Date('2026-07-31T03:08:00.949Z')
  assert.equal(derivePoolEnteredAt(createdAt), '2026-07-31T03:08:00.949Z')
})

test('does not invent a pool entry time when the timestamp is missing', () => {
  assert.equal(derivePoolEnteredAt(null), '')
  assert.equal(derivePoolEnteredAt(new Date('invalid')), '')
})
