import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { fdeWeekStart, shanghaiToday, shiftDate, taskInWeek, weekStartFor, weeklyActionSchema, weeklyManualItem, weeklySaveSchema } from '../src/contracts/fdeWeeklyPlanContract.js'

test('weekly calendar uses actual Shanghai dates, Mondays and cross-year weeks', () => {
  assert.equal(shanghaiToday(new Date('2026-12-31T16:01:00Z')), '2027-01-01')
  assert.equal(weekStartFor('2027-01-03'), '2026-12-28')
  assert.equal(shiftDate('2026-12-28', 6), '2027-01-03')
  assert.equal(fdeWeekStart.safeParse('2026-12-28').success, true)
  for (const value of ['2027-01-03', '2026-02-30', 'garbage', '2026-1-01']) assert.equal(fdeWeekStart.safeParse(value).success, false)
})
test('current week keeps overdue open work, but not cancelled or future work', () => {
  const week = '2026-12-28'
  for (const status of ['未开始', '进行中', '待验收', '已退回']) assert.equal(taskInWeek({ dueDate: '2026-12-20', status }, week), true)
  assert.equal(taskInWeek({ dueDate: '2026-12-20', status: '已完成' }, week), false)
  assert.equal(taskInWeek({ dueDate: '2027-01-03', status: '已完成' }, week), true)
  for (const status of ['已取消', '已关闭', '已归档']) assert.equal(taskInWeek({ dueDate: '2027-01-03', status }, week), false)
  assert.equal(taskInWeek({ dueDate: '2027-01-04', status: '未开始' }, week), false)
  assert.equal(taskInWeek({ dueDate: null, status: '未开始' }, week), false)
})
test('weekly commands require versions, unique manual keys and reasoned return', () => {
  const item = { key: randomUUID(), title: '访谈任务', ownerUserId: randomUUID(), dueDate: '2026-12-30', deliverable: '正式访谈记录' }
  const input = { clientRequestId: randomUUID(), expectedVersion: 1, goal: '完成访谈', manualItems: [item] }
  assert.equal(weeklySaveSchema.safeParse(input).success, true)
  assert.equal(weeklySaveSchema.safeParse({ ...input, manualItems: [item, item] }).success, false)
  assert.equal(weeklySaveSchema.safeParse({ ...input, status: 'published' }).success, false)
  assert.equal(weeklySaveSchema.safeParse({ ...input, expectedVersion: 0 }).success, false)
  assert.equal(weeklyActionSchema.safeParse({ clientRequestId: randomUUID(), expectedVersion: 1, action: 'return', reason: '请补齐任务交付物' }).success, true)
  assert.equal(weeklyActionSchema.safeParse({ clientRequestId: randomUUID(), expectedVersion: 1, action: 'return' }).success, false)
})

test('manual leader participation requires precise time without changing old serialized commands', () => {
  const old = { key: randomUUID(), title: '领导参与访谈', ownerUserId: randomUUID(), dueDate: '2026-12-30', deliverable: '正式访谈记录', priority: '中' }
  assert.deepEqual(weeklyManualItem.parse(old), old)
  assert.equal(weeklyManualItem.safeParse({ ...old, needLeader: true }).success, false)
  for (const dueTime of [null, '', '25:00', '1:00', '10:61']) assert.equal(weeklyManualItem.safeParse({ ...old, needLeader: true, dueTime }).success, false)
  assert.equal(weeklyManualItem.safeParse({ ...old, needLeader: true, dueTime: '18:07' }).success, true, 'deadline is not a scheduled slot and must retain minute precision')
  assert.equal(weeklyManualItem.safeParse({ ...old, needLeader: false, dueTime: null }).success, true)
  for (const injected of [{ sourceStage: '打款' }, { sourceWeeklyItemId: randomUUID() }, { leaderId: randomUUID() }, { taskId: randomUUID() }]) assert.equal(weeklyManualItem.safeParse({ ...old, ...injected }).success, false)
  assert.equal(weeklyActionSchema.safeParse({ clientRequestId: randomUUID(), expectedVersion: 1, action: 'sync-leader-time' }).success, true)
})
