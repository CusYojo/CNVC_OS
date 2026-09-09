import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { reportWindow, weeklyReportActionSchema, weeklyReportBody, weeklyReportCreateSchema, weeklyReportSaveSchema, weeklyReportSourceOptions, type WeeklyReportFacts } from '../src/contracts/fdeWeeklyReportContract.js'

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
test('weekly report keeps useful sections and omits cancelled or implementation-focused noise', () => {
  const facts: WeeklyReportFacts = {
    weekStart: '2026-12-28', weekEnd: '2027-01-03', generatedAt: '2026-12-31T08:00:00.000Z', projects: [], approvals: [], meetings: [], unavailable: ['内部来源说明'],
    tasks: [
      { id: randomUUID(), projectId: null, title: '完成访谈纪要', version: 1, status: '已完成', dueDate: '2026-12-29', completedAt: '2026-12-29T08:00:00.000Z', progress: 100 },
      { id: randomUUID(), projectId: null, title: '推进项目复核', version: 1, status: '进行中', dueDate: '2026-12-30', completedAt: null, progress: 60 },
    ],
    calendar: [
      { id: randomUUID(), source: 'personal', projectId: null, ownerId: randomUUID(), title: '有效安排', version: 1, startsAt: '2026-12-30T02:00:00.000Z', endsAt: '2026-12-30T03:00:00.000Z', status: 'active', visibility: 'private' },
      { id: randomUUID(), source: 'meeting', projectId: null, ownerId: randomUUID(), title: '已取消会议', version: 2, startsAt: '2026-12-30T04:00:00.000Z', endsAt: '2026-12-30T05:00:00.000Z', status: 'cancelled', visibility: 'project' },
    ],
    metrics: { completedInWeek: 1, dueInWeek: 2, overdueOpen: 0, cancelledDueInWeek: 1, approvalActions: 0, meetingRecords: 0 },
  }
  const body = weeklyReportBody(facts)
  assert.match(body, /已完成事项\n- 完成访谈纪要/)
  assert.match(body, /重点推进\n- 推进项目复核/)
  assert.match(body, /重要安排\n- 有效安排/)
  assert.doesNotMatch(body, /已取消会议|内部来源说明|请人工补充|版本|来源快照/)
})
