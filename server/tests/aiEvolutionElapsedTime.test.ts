import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountEvolutionTime } from '../src/services/aiEvolutionElapsedTime.js'

test('frequent heartbeats preserve fractional time and clock rollback cannot reduce usage', () => {
  const start = new Date('2026-09-07T00:00:00Z')
  let row = { elapsedSeconds: 20, timeAccountedAt: start }
  for (let milliseconds = 100; milliseconds <= 2500; milliseconds += 100) {
    row = accountEvolutionTime(row, new Date(start.getTime() + milliseconds))
  }
  assert.equal(row.elapsedSeconds, 22)
  assert.equal(row.timeAccountedAt.getTime(), start.getTime() + 2000)
  assert.deepEqual(accountEvolutionTime(row, start), row)
  assert.equal(accountEvolutionTime(row, new Date(start.getTime() + 61000)).elapsedSeconds, 81)
})
