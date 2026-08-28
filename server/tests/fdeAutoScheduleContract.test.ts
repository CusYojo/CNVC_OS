import assert from 'node:assert/strict'
import test from 'node:test'
import { planLeadershipTimes, type ScheduleCandidate } from '../src/contracts/fdeAutoScheduleContract.js'
import { timeInstant } from '../src/contracts/fdeTimeContract.js'

const week = '2030-01-07', now = timeInstant('2030-01-07T07:00')
const item = (id: string, priority = 'P2'): ScheduleCandidate => ({ id, priority, leaderId: 'leader', latestFinish: timeInstant(`${week}T18:00`).toISOString(), preferredStart: timeInstant(`${week}T10:00`).toISOString(), alternativeStart: timeInstant(`${week}T14:00`).toISOString(), durationMinutes: 60 })
test('FDE automatic schedule preserves priorities, preferred/alternative and deterministic stable order', () => {
  const input = [item('low','P3'), item('high','P0')]
  const output = planLeadershipTimes(input, {}, week, now)
  assert.deepEqual(output, [{ id:'high', scheduledStart:timeInstant(`${week}T10:00`).toISOString() }, { id:'low', scheduledStart:timeInstant(`${week}T14:00`).toISOString() }])
  assert.deepEqual(planLeadershipTimes([...input].reverse(), {}, week, now), output)
})
test('FDE automatic schedule respects occupied time, half-open adjacency and separate leaders', () => {
  const occupied = { leader: [{ startsAt:timeInstant(`${week}T09:00`).toISOString(), endsAt:timeInstant(`${week}T10:00`).toISOString() }] }
  const output = planLeadershipTimes([item('a'),{...item('b'),leaderId:'other'}], occupied, week, now)
  assert.ok(output.every(row=>row.scheduledStart===timeInstant(`${week}T10:00`).toISOString()))
  assert.equal(occupied.leader.length,1)
})
test('same priority uses latest finish then stable ID, unknown legacy deadlines last', () => {
  const early = { ...item('z-earlier'), latestFinish: timeInstant(`${week}T11:00`).toISOString() }
  const late = { ...item('a-later'), latestFinish: timeInstant(`${week}T18:00`).toISOString() }
  const unknown = { ...item('0-unknown'), latestFinish: null }
  const result = planLeadershipTimes([unknown, late, early], {}, week, now)
  assert.deepEqual(result.map(row => row.id), ['z-earlier', 'a-later', '0-unknown'])
  assert.equal(result[0].scheduledStart, timeInstant(`${week}T10:00`).toISOString())
  assert.deepEqual(planLeadershipTimes([item('b'), item('a')], {}, week, now).map(row => row.id), ['a', 'b'])
  // The reference uses latest for ranking, not as an unapproved hard stop.
  assert.equal(planLeadershipTimes([{ ...early, latestFinish: timeInstant(`${week}T08:00`).toISOString() }], {}, week, now)[0].scheduledStart, timeInstant(`${week}T10:00`).toISOString())
})
test('FDE no-slot result does not shorten duration, overflow the week, or schedule in the past', () => {
  const occupied = { leader:[{startsAt:timeInstant(`${week}T00:00`).toISOString(),endsAt:timeInstant('2030-01-14T00:00').toISOString()}] }
  assert.equal(planLeadershipTimes([item('a')],occupied,week,now)[0].scheduledStart,null)
  assert.equal(planLeadershipTimes([item('a')],{},week,timeInstant('2030-01-14T00:00'))[0].scheduledStart,null)
})
