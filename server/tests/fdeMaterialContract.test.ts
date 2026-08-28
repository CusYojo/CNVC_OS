import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { aggregateMaterialStatus, materialCreateCommand, materialDecisionCommand, materialListQuery, materialReadCommand, materialWithdrawCommand } from '../src/contracts/fdeMaterialContract.js'

test('material aggregate follows every FDE per-recipient state without approving a subset', () => {
  const unread = { readAt: null, decision: null }, read = { readAt: new Date(), decision: null }, approved = { readAt: new Date(), decision: 'approve' }, returned = { readAt: new Date(), decision: 'return' }
  for (const [input, expected] of [[[unread, unread], 'pending'], [[read, unread], 'pending'], [[read, read], 'read'], [[approved, unread], 'partial'], [[returned, unread], 'partial_returned'], [[approved, returned], 'returned'], [[approved, approved], 'approved']] as const) assert.equal(aggregateMaterialStatus([...input]), expected)
  assert.equal(aggregateMaterialStatus([unread], true), 'withdrawn')
  assert.throws(() => aggregateMaterialStatus([]))
})
test('material create freezes stable file, content, ACL, project and governance versions', () => {
  const base = { clientRequestId: randomUUID(), fileId: randomUUID(), fileVersion: 1, expectedAccessVersion: 1, expectedProjectVersion: 2, expectedGovernanceVersion: 1, title: '资料反馈', recipientIds: [randomUUID()] }
  assert.equal(materialCreateCommand.parse(base).note, '')
  for (const patch of [{ senderId: randomUUID() }, { status: 'approved' }, { recipientIds: [] }, { recipientIds: [...base.recipientIds, ...base.recipientIds] }, { fileVersion: 0 }, { expectedAccessVersion: undefined }, { expectedGovernanceVersion: undefined }, { title: ' ' }, { note: 'x'.repeat(301) }]) assert.equal(materialCreateCommand.safeParse({ ...base, ...patch }).success, false)
})
test('decisions require independent recipient versions and nonblank feedback', () => {
  const base = { clientRequestId: randomUUID(), expectedRecipientVersion: 1, decision: 'approve', feedback: '同意当前版本材料' }
  assert.ok(materialDecisionCommand.safeParse(base).success)
  for (const patch of [{ expectedVersion: 1 }, { expectedRecipientVersion: 0 }, { feedback: ' ' }, { decision: 'withdraw' }, { userId: randomUUID() }]) assert.equal(materialDecisionCommand.safeParse({ ...base, ...patch }).success, false)
})
test('reading is explicit and withdrawal requires a reason and aggregate version', () => {
  assert.ok(materialReadCommand.safeParse({ clientRequestId: randomUUID() }).success)
  assert.equal(materialReadCommand.safeParse({ clientRequestId: 'not-an-id' }).success, false)
  const base = { clientRequestId: randomUUID(), expectedVersion: 1, reason: '补充材料后重新送审' }
  assert.ok(materialWithdrawCommand.safeParse(base).success)
  assert.equal(materialWithdrawCommand.safeParse({ ...base, reason: '' }).success, false)
})
test('material list has bounded pagination and only permitted views', () => {
  assert.equal(materialListQuery.parse({}).pageSize, 20)
  for (const input of [{ page: 0 }, { pageSize: 51 }, { view: 'secret' }, { userId: randomUUID() }]) assert.equal(materialListQuery.safeParse(input).success, false)
})
