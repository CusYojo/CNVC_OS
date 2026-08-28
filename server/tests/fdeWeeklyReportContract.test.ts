import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { reportWindow, weeklyReportActionSchema, weeklyReportCreateSchema, weeklyReportSaveSchema, weeklyReportSourceOptions } from '../src/contracts/fdeWeeklyReportContract.js'

test('weekly report range is a Shanghai half-open week across year boundary', () => {
  const { start, end } = reportWindow('2026-12-28')
  assert.equal(start.toISOString(), '2026-12-27T16:00:00.000Z')
  assert.equal(end.toISOString(), '2027-01-03T16:00:00.000Z')
  assert.throws(() => reportWindow('2027-01-03'))
})
test('report creation requires explicit unique project scope and rejects injected facts', () => {
  const projectId = randomUUID(), input = { clientRequestId: randomUUID(), weekStart: '2026-12-28', projectIds: [projectId] }
  assert.equal(weeklyReportCreateSchema.safeParse(input).success, true)
  for (const patch of [{ projectIds: [] }, { projectIds: [projectId, projectId] }, { facts: {} }, { authorId: randomUUID() }]) assert.equal(weeklyReportCreateSchema.safeParse({ ...input, ...patch }).success, false)
})
test('report commands preserve actor, source, state and recipient boundaries', () => {
  const base = { clientRequestId: randomUUID(), expectedVersion: 1 }
  assert.equal(weeklyReportSaveSchema.safeParse({ ...base, body: '人工核对正文' }).success, true)
  assert.equal(weeklyReportSaveSchema.safeParse({ ...base, body: '正文', facts: {} }).success, false)
  assert.equal(weeklyReportActionSchema.safeParse({ ...base, action: 'publish', recipientIds: [] }).success, true)
  assert.equal(weeklyReportActionSchema.safeParse({ ...base, action: 'withdraw', reason: '发布内容需重新核对' }).success, true)
  assert.equal(weeklyReportActionSchema.safeParse({ ...base, action: 'withdraw' }).success, false)
  const recipient = randomUUID()
  assert.equal(weeklyReportActionSchema.safeParse({ ...base, action: 'publish', recipientIds: [recipient, recipient] }).success, false)
  assert.equal(weeklyReportActionSchema.safeParse({ ...base, action: 'regenerate', recipientIds: [recipient] }).success, false)
})
test('nonproject sources require explicit selection and private calendar opt-in cannot bypass calendar scope', () => {
  const input={clientRequestId:randomUUID(),weekStart:'2026-12-28',projectIds:[]}
  assert.ok(weeklyReportCreateSchema.safeParse({...input,sourceOptions:{calendar:true}}).success)
  assert.ok(weeklyReportCreateSchema.safeParse({...input,sourceOptions:{independentWork:true}}).success)
  assert.equal(weeklyReportCreateSchema.safeParse({...input,sourceOptions:{privateCalendar:true}}).success,false)
  assert.equal(weeklyReportCreateSchema.parse({...input,sourceOptions:{calendar:true}}).sourceOptions.privateCalendar,false)
  assert.equal(JSON.stringify(weeklyReportSourceOptions.parse({calendar:true,privateCalendar:false,independentWork:false})),JSON.stringify(weeklyReportSourceOptions.parse({independentWork:false,privateCalendar:false,calendar:true})))
})
