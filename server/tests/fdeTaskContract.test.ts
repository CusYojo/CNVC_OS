import assert from 'node:assert/strict'
import test from 'node:test'
import { fdeDate, fdeTaskFeedbackSchema, fdeTaskExtensionSchema, taskTerminal } from '../src/contracts/fdeTaskContract.js'

test('FDE task dates reject rollover and preserve date-only Shanghai semantics', () => {
  assert.equal(fdeDate.parse('2028-02-29'), '2028-02-29')
  for (const value of ['2027-02-29', '2028-02-30', '2028-13-01', '2028-1-01', '']) assert.equal(fdeDate.safeParse(value).success, false)
})
test('100 percent is a submission with real file references, not a completion status', () => {
  const input = { expectedVersion: 1, kind: 'submission', progress: 100, result: '提交成果', evidence: [{ fileId: '9e3a0bab-7cc9-460a-8241-2d3073186fd7', version: 1 }] }
  assert.equal(fdeTaskFeedbackSchema.safeParse(input).success, true)
  for (const patch of [{ evidence: [] }, { kind: 'progress' }, { progress: 90 }, { status: '已完成' }, { evidence: [...input.evidence, ...input.evidence] }, { expectedVersion: 0 }]) assert.equal(fdeTaskFeedbackSchema.safeParse({ ...input, ...patch }).success, false)
})
test('extensions require reviewer, reason, version and valid new date', () => {
  assert.equal(fdeTaskExtensionSchema.safeParse({ expectedVersion: 1, requestedDueDate: '2028-03-01', reason: '等待客户补充材料', reviewerUserId: '9e3a0bab-7cc9-460a-8241-2d3073186fd7' }).success, true)
  assert.equal(fdeTaskExtensionSchema.safeParse({ requestedDueDate: '2028-03-01' }).success, false)
  for (const status of ['已完成', '已关闭', '已取消', '已归档']) assert.equal(taskTerminal(status), true)
  assert.equal(taskTerminal('待验收'), false)
})
