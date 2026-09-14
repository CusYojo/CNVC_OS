import assert from 'node:assert/strict'
import { test } from 'node:test'
import { timeSourceLabel, timelineLeaderDuties, timelineLeaderSlots } from '../src/contracts/fdeTimelineTimeContract.js'
import { validLeaderSlot, timeActionSchema } from '../src/contracts/fdeTimeContract.js'

test('leadership participation differs from plan approval and never uses demo names', () => {
  for (const stage of ['入库', '尽调计划制定', '尽调计划审核', '未知']) assert.deepEqual(timelineLeaderDuties(stage), [])
  assert.deepEqual(timelineLeaderDuties('立项'), ['concerned_leader'])
  for (const stage of ['尽调', '内核', '投决', '打款']) assert.deepEqual(timelineLeaderDuties(stage), ['chairman', 'president'])
})
test('source slots are stable, distinct, 45 minutes and use the actual source date', () => {
  for (let i = 0; i < 100; i++) {
    const args = ['project', `task-${i}`, 'leader', '2027-02-10', '12:00'] as const
    const slots = timelineLeaderSlots(...args)
    assert.deepEqual(slots, timelineLeaderSlots(...args))
    assert.ok(validLeaderSlot(slots.preferredStart, slots.durationMinutes))
    assert.ok(validLeaderSlot(slots.alternativeStart, slots.durationMinutes))
    assert.notEqual(slots.preferredStart, slots.alternativeStart)
    assert.equal(slots.durationMinutes, 45); assert.equal(slots.latestFinish, '2027-02-10T12:00')
  }
  assert.throws(() => timelineLeaderSlots('p', 't', 'l', '2027-02-30', '12:00'))
})
test('source acknowledgement does not accept forged dates or source identifiers', () => {
  const input = { clientRequestId: '5e90bd20-0eda-4a27-b583-baf9517831be', expectedVersion: 1, action: 'refresh-source', reason: '核对真实来源' }
  assert.ok(timeActionSchema.safeParse(input).success)
  assert.equal(timeActionSchema.safeParse({ ...input, scheduledStart: '2027-02-10T09:00' }).success, false)
  assert.equal(timeActionSchema.safeParse({ ...input, sourceTimelineTaskId: 'spoof' }).success, false)
  assert.equal(timeActionSchema.safeParse({ ...input, sourceTypeActionId: 'spoof' }).success, false)
  assert.equal(timeSourceLabel('type_execution'), '非投资计划行动')
  assert.equal(timeSourceLabel('weekly'), '周计划行动')
  assert.equal(timeSourceLabel(), '流程行动')
})
