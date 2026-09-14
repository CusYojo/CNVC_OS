import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { agentScheduleAction, agentScheduleSubmit, agentScheduleWindow, buildAgentTimeline } from '../src/contracts/fdeAgentScheduleContract.js'

test('schedule commands require identity, version and reason; forbid client-selected reviewers and stage transitions', () => {
  const input = { clientRequestId: randomUUID(), expectedVersion: 2, requestedDate: '2026-09-19', reason: '节点资料已经准备齐全' }
  assert.ok(agentScheduleSubmit.safeParse(input).success)
  for (const value of [{ ...input, reviewers: [] }, { ...input, targetStage: '打款' }, { ...input, requestedDate: '2026-02-30' }]) assert.equal(agentScheduleSubmit.safeParse(value).success, false)
  for (const action of ['return', 'resubmit', 'transfer']) assert.equal(agentScheduleAction.safeParse({ clientRequestId: randomUUID(), expectedVersion: 1, action, reason: input.reason }).success, false)
})
test('timeline preserves approved date versions without pretending the entire cycle or actual completion was approved', () => {
  const timeline = buildAgentTimeline('2026-09-30', 40, [{ stage: '内核', plannedDate: '2026-09-19', version: 2, approvalId: 'approval' }])
  assert.equal(timeline.find(item => item.stage === '内核')?.basis, 'approved')
  assert.equal(timeline.find(item => item.stage === '投决')?.date, '2026-09-26')
  assert.equal(timeline.find(item => item.stage === '投决')?.basis, 'cycle_projection')
  assert.ok(timeline.every(item => item.actualDate === null))
})
test('date window uses prior actual completion when present and next planned date minus one', () => {
  const timeline = buildAgentTimeline('2026-09-30', 40, [], { 尽调: '2026-09-18' })
  assert.deepEqual(agentScheduleWindow(timeline, '内核', '2026-09-30', '2026-08-28'), { currentDate: '2026-09-20', minimum: '2026-09-19', maximum: '2026-09-25', available: true })
  assert.equal(agentScheduleWindow(timeline, '内核', '2026-09-30', '2026-09-26')?.available, false)
  assert.equal(agentScheduleWindow(timeline, '未知节点', '2026-09-30', '2026-08-28'), null)
})
test('first stage cannot move before today; last stage cannot extend project final date', () => {
  const timeline = buildAgentTimeline('2026-09-30', 40, [])
  assert.equal(agentScheduleWindow(timeline, '入库', '2026-09-30', '2026-08-28')?.minimum, '2026-08-28')
  assert.equal(agentScheduleWindow(timeline, '打款', '2026-09-30', '2026-08-28')?.maximum, '2026-09-30')
  assert.equal(buildAgentTimeline(null, 40, []).length, 0)
})
