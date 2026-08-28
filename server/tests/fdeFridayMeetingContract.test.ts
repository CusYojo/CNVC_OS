import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { fridayActionSchema, fridayCreateSchema, fridayLocalTime, nextMeetingWeek } from '../src/contracts/fdeFridayMeetingContract.js'

test('例会时间严格采用上海日期，拒绝伪日期并覆盖跨年下一周', () => {
  assert.equal(fridayLocalTime.safeParse('2026-02-30T16:00').success, false)
  assert.equal(fridayLocalTime.safeParse('2026-08-28T25:00').success, false)
  assert.equal(fridayLocalTime.safeParse('2026-08-28T16:00').success, true)
  assert.equal(nextMeetingWeek('2026-12-31T16:00'), '2027-01-04')
  assert.equal(nextMeetingWeek(new Date('2026-08-30T16:05:00Z')), '2026-09-07')
})
test('主持人必须在稳定参会人名单，结束时间晚于开始，不能注入状态', () => {
  const id = randomUUID(), input = { clientRequestId: randomUUID(), title: '周五例会', startsAt: '2026-08-28T16:00', endsAt: '2026-08-28T17:00', hostUserId: id, participantIds: [id], minutes: { agenda: '核对当周进展' } }
  assert.equal(fridayCreateSchema.safeParse(input).success, true)
  assert.equal(fridayCreateSchema.safeParse({ ...input, workflowStatus: 'completed' }).success, false)
  assert.equal(fridayCreateSchema.safeParse({ ...input, participantIds: [randomUUID()] }).success, false)
  assert.equal(fridayCreateSchema.safeParse({ ...input, participantIds: [id, id] }).success, false)
  assert.equal(fridayCreateSchema.safeParse({ ...input, endsAt: input.startsAt }).success, false)
})
test('取消必须有原因，未知决定或客户端计划ID不得注入', () => {
  const input = { clientRequestId: randomUUID(), expectedVersion: 1, action: 'cancel' }
  assert.equal(fridayActionSchema.safeParse(input).success, false)
  assert.equal(fridayActionSchema.safeParse({ ...input, reason: '本周会议计划取消' }).success, true)
  assert.equal(fridayActionSchema.safeParse({ ...input, action: 'derive', planId: randomUUID() }).success, false)
})
