import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { projectRecordAction, projectRecordComment, projectRecordCreate, projectRecordDetailQuery, projectRecordQuery } from '../src/contracts/fdeProjectRecordContract.js'

test('record form preserves FDE kinds and rejects injected identities, source and status', () => {
  const record = { clientRequestId: randomUUID(), kind: '关键判断', title: '记录', content: '业务判断依据' }
  assert.ok(projectRecordCreate.safeParse(record).success)
  for (const patch of [{ authorId: randomUUID() }, { sourceMeetingId: randomUUID() }, { status: 'published' }, { kind: '审批结论' }, { content: ' ' }, { content: '长'.repeat(601) }]) assert.equal(projectRecordCreate.safeParse({ ...record, ...patch }).success, false)
})
test('record comments and lifecycle require versions, bounded content and reasons', () => {
  const base = { clientRequestId: randomUUID(), expectedVersion: 1 }
  assert.ok(projectRecordComment.safeParse({ ...base, content: '补充讨论' }).success)
  assert.equal(projectRecordComment.safeParse({ ...base, content: '长'.repeat(301) }).success, false)
  assert.equal(projectRecordAction.safeParse({ ...base, action: 'withdraw', reason: '短' }).success, false)
  assert.ok(projectRecordAction.safeParse({ ...base, action: 'archive', reason: '记录讨论已结束' }).success)
  assert.equal(projectRecordAction.safeParse({ ...base, action: 'restore', reason: '不能自行增加恢复' }).success, false)
})
test('record lists and history use explicit bounded pages without client project scope overrides', () => {
  assert.deepEqual(projectRecordQuery.parse({}), { view: 'published', keyword: '', page: 1, pageSize: 20 })
  assert.equal(projectRecordQuery.safeParse({ pageSize: 500 }).success, false)
  assert.equal(projectRecordQuery.safeParse({ projectId: randomUUID() }).success, false)
  assert.equal(projectRecordDetailQuery.safeParse({ historyPage: 0 }).success, false)
})
