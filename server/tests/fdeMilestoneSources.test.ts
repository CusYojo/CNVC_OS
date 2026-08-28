import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { milestoneInWeek, milestoneQueryFlag, milestoneReportBody, milestoneSourceTarget } from '../src/contracts/fdeMilestoneSourcesContract.js'
import { weeklyReportCreateSchema, weeklyReportSourceOptions } from '../src/contracts/fdeWeeklyReportContract.js'

test('milestone opt-in is strict and absent options preserve historical report serialization', () => {
  assert.equal(milestoneQueryFlag.parse(undefined), false)
  assert.equal(milestoneQueryFlag.parse('false'), false)
  assert.equal(milestoneQueryFlag.parse('true'), true)
  for (const value of ['1', 'yes', ['true'], true]) assert.equal(milestoneQueryFlag.safeParse(value).success, false)
  assert.deepEqual(weeklyReportSourceOptions.parse({}), { calendar: false, privateCalendar: false, independentWork: false })
  assert.equal('projectTimeline' in weeklyReportSourceOptions.parse({ calendar: true }), false)
  const base = { clientRequestId: randomUUID(), weekStart: '2026-12-28', projectIds: [], sourceOptions: { calendar: true, projectTimeline: true } }
  assert.equal(weeklyReportCreateSchema.safeParse(base).success, false)
  assert.equal(weeklyReportCreateSchema.safeParse({ ...base, projectIds: [randomUUID()] }).success, true)
  assert.equal(weeklyReportCreateSchema.safeParse({ ...base, projectIds: [randomUUID()], milestones: [] }).success, false)
})
test('date markers use half-open Shanghai calendar weeks including year boundaries', () => {
  assert.equal(milestoneInWeek('2026-12-28', '2026-12-28'), true)
  assert.equal(milestoneInWeek('2027-01-03', '2026-12-28'), true)
  assert.equal(milestoneInWeek('2027-01-04', '2026-12-28'), false)
  assert.equal(milestoneInWeek('2026-12-27', '2026-12-28'), false)
  assert.throws(() => milestoneInWeek('2026-02-30', '2026-02-23'))
})
test('milestone text distinguishes date approval from stage completion and links exact approval', () => {
  const item = { id: randomUUID(), projectId: randomUUID(), projectName: '真实项目', stage: '投决', date: '2027-01-02', version: 2, approvalId: randomUUID(), previousDate: '2027-01-01', approvedAt: '2026-12-28T01:00:00.000Z', ownerId: randomUUID(), ownerName: '负责人' }
  assert.match(milestoneReportBody([item]), /不计任务完成、不代表阶段通过/)
  assert.match(milestoneReportBody([item]), /2027-01-01 → 2027-01-02/)
  assert.ok(milestoneSourceTarget(item).endsWith(`#agent-schedule-${item.approvalId}`))
  assert.ok(milestoneSourceTarget(item).includes('?tab=workflow&schedule='))
})
