import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { officeCalendarWindow } from '../src/contracts/fdeOfficeSourcesContract.js'
import { weeklyReportCreateSchema, weeklyReportSourceOptions } from '../src/contracts/fdeWeeklyReportContract.js'

const person = randomUUID(), other = randomUUID()
const definition = (details: unknown) => ({ title: '批准安排', reason: '仅为日程来源测试', projectId: null, priority: '普通', attachmentIds: [], details })
test('approved travel uses inclusive dates, explicit travelers and Shanghai year boundaries', () => {
  const result = officeCalendarWindow(definition({ kind: '出差', travelerIds: [person, other], startDate: '2026-12-31', endDate: '2027-01-01' }), person)!
  assert.equal(result.startsAt.toISOString(), '2026-12-30T16:00:00.000Z')
  assert.equal(result.endsAt.toISOString(), '2027-01-01T16:00:00.000Z')
  assert.equal(result.allDay, true); assert.deepEqual(result.ownerIds, [person, other].sort())
})
test('leave keeps exact times and never derives a duration from requested hours', () => {
  const result = officeCalendarWindow(definition({ kind: '请假', startAt: '2026-12-31T23:30', endAt: '2027-01-01T01:15', hours: '1' }), person)!
  assert.equal(result.endsAt.getTime() - result.startsAt.getTime(), 105 * 60000)
  assert.equal(result.allDay, false); assert.deepEqual(result.ownerIds, [person])
})
test('incomplete, invalid and non-calendar applications do not fabricate dates or travelers', () => {
  for (const details of [{ kind: '出差' }, { kind: '出差', travelerIds: [], startDate: '2026-12-31', endDate: '2027-01-01' },
    { kind: '出差', travelerIds: [person], startDate: '2026-02-30', endDate: '2026-03-02' },
    { kind: '请假', startAt: '2026-12-31T10:00', endAt: '2026-12-31T09:00' }, { kind: '报销' }, { kind: '合同' }, { kind: '用印' }]) assert.equal(officeCalendarWindow(definition(details), person), null)
})
test('office report selection is explicit and preserves historical option serialization', () => {
  assert.deepEqual(weeklyReportSourceOptions.parse({}), { calendar: false, privateCalendar: false, independentWork: false })
  const input = { clientRequestId: randomUUID(), weekStart: '2026-12-28', projectIds: [], sourceOptions: { office: true } }
  assert.equal(weeklyReportCreateSchema.safeParse(input).success, true)
  assert.equal(weeklyReportCreateSchema.safeParse({ ...input, sourceOptions: { office: false } }).success, false)
  assert.equal(weeklyReportCreateSchema.safeParse({ ...input, facts: {} }).success, false)
  assert.equal(weeklyReportCreateSchema.safeParse({ ...input, sourceOptions: { office: 'true' } }).success, false)
})
