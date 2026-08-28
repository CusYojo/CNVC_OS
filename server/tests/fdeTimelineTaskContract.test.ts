import assert from 'node:assert/strict'
import { test } from 'node:test'
import { timelineSyncInput, timelineTaskProposals, timelineTaskProtection } from '../src/contracts/fdeTimelineTaskContract.js'

test('timeline proposals retain reference stable keys, precise clocks and duty mapping', () => {
  const items = timelineTaskProposals('启动尽调', '2026-09-10', [{ key: 'financial_dd', label: '财务尽调材料' }, { key: 'legal_dd', label: '法律尽调材料' }], true)
  assert.equal(items.find(item => item.key === 'material:financial_dd')?.duty, 'finance')
  assert.equal(items.find(item => item.key === 'material:legal_dd')?.dueDate, '2026-09-09')
  assert.equal(items.find(item => item.key === 'team_informal')?.dueTime, '19:00')
  assert.equal(items.find(item => item.key === 'conclusion')?.dueTime, '12:00')
  assert.equal(new Set(items.map(item => item.key)).size, items.length)
})
test('intake and system approval have their own generation semantics', () => {
  assert.equal(timelineTaskProposals('入库', '2026-09-10', [], false)[0].duty, 'owner')
  assert.deepEqual(timelineTaskProposals('尽调计划审核', '2026-09-10', [], true), [])
})
test('protected deadlines and results are not rewritten by template synchronization', () => {
  const baseline = { dueDate: '2026-09-10', dueTime: '12:00', ownerUserId: 'owner' }, task = { ...baseline, status: '进行中' }
  assert.equal(timelineTaskProtection(task, baseline, false, false), null)
  for (const status of ['已完成', '已关闭', '待验收', '已取消', '已归档']) assert.ok(timelineTaskProtection({ ...task, status }, baseline, false, false))
  assert.ok(timelineTaskProtection({ ...task, dueTime: '16:00' }, baseline, false, false))
  assert.ok(timelineTaskProtection(task, baseline, true, false))
  assert.equal(timelineTaskProtection({ ...task, status: '已取消' }, baseline, false, true), null)
})
test('client cannot forge generated tasks or owners in synchronization', () => {
  const input = { clientRequestId: '5e90bd20-0eda-4a27-b583-baf9517831be', fingerprint: 'a'.repeat(64) }
  assert.ok(timelineSyncInput.safeParse(input).success)
  assert.equal(timelineSyncInput.safeParse({ ...input, ownerUserId: 'spoof' }).success, false)
  assert.equal(timelineSyncInput.safeParse({ ...input, fingerprint: 'short' }).success, false)
})
