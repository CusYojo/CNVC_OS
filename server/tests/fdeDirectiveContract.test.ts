import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { directiveActionSchema, directiveCreateSchema, directiveStatus } from '../src/contracts/fdeDirectiveContract.js'
import { fdeTaskExtensionSchema, taskDeadlineKey } from '../src/contracts/fdeTaskContract.js'

test('directive contract preserves exact Shanghai time, stable owner and three conversions', () => {
  const input = { clientRequestId: randomUUID(), content: '核对客户反馈', ownerUserId: randomUUID(), dueAt: '2028-02-29T16:45', conversion: 'action' }
  for (const conversion of ['action', 'pending', 'leadership']) assert.equal(directiveCreateSchema.parse({ ...input, conversion }).dueAt, input.dueAt)
  for (const dueAt of ['2027-02-29T16:45', '2028-02-29', '2028-02-29T24:00']) assert.equal(directiveCreateSchema.safeParse({ ...input, dueAt }).success, false)
  assert.equal(directiveCreateSchema.safeParse({ ...input, ownerUserId: '显示姓名' }).success, false)
  assert.equal(directiveCreateSchema.safeParse({ ...input, status: '已落实' }).success, false)
})
test('directive actions require version and meaningful reason; execution owns final state', () => {
  const input = { clientRequestId: randomUUID(), expectedVersion: 1, action: 'withdraw', reason: '业务要求发生调整' }
  assert.equal(directiveActionSchema.parse(input).action, 'withdraw')
  assert.equal(directiveActionSchema.safeParse({ ...input, reason: '' }).success, false)
  const state = { withdrawnAt: null, acknowledgedAt: null, requiresReceipt: true }
  assert.equal(directiveStatus(state, '待确认'), '待确认事项')
  assert.equal(directiveStatus(state, '未开始'), '待回执')
  assert.equal(directiveStatus(state, '待验收'), '待验收')
  assert.equal(directiveStatus(state, '已完成'), '已落实')
  assert.equal(directiveStatus(state, '已关闭'), '已关闭')
  assert.equal(directiveStatus({ ...state, withdrawnAt: new Date() }, '进行中'), '已撤回')
})
test('precise extension time and end-of-day semantics remain distinct', () => {
  assert.ok(taskDeadlineKey('2028-02-29', '17:00') > taskDeadlineKey('2028-02-29', '16:45'))
  assert.ok(taskDeadlineKey('2028-02-29', null) > taskDeadlineKey('2028-02-29', '23:59'))
  const base = { expectedVersion: 1, requestedDueDate: '2028-02-29', reviewerUserId: randomUUID(), reason: '客户需要补充反馈' }
  assert.equal(fdeTaskExtensionSchema.parse(base).requestedDueTime, null)
  assert.equal(fdeTaskExtensionSchema.parse({ ...base, requestedDueTime: '16:45' }).requestedDueTime, '16:45')
  assert.equal(fdeTaskExtensionSchema.safeParse({ ...base, requestedDueTime: '24:00' }).success, false)
})
