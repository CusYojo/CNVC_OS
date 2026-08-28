import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { typeRuntimeCommand, typeRuntimeEffectiveDeadline } from '../src/contracts/fdeTypeRuntimeContract.js'
import { readTypeRuntimePending, typeRuntimeMarker, typeRuntimePendingKey, verifyTypeRuntimeReceipt, verifyTypeRuntimeRecovery } from '../../src/lib/fdeTypeRuntimeRecovery.js'

test('current task date-only deadline never restores the old precise plan clock', () => {
  const plan = { dueDate: '2026-10-05', dueTime: '18:07' }
  assert.deepEqual(typeRuntimeEffectiveDeadline(plan), plan)
  assert.deepEqual(typeRuntimeEffectiveDeadline(plan, { dueDate: '2026-10-08', dueTime: null }), { dueDate: '2026-10-08', dueTime: null })
  assert.deepEqual(typeRuntimeEffectiveDeadline(plan, { dueDate: null, dueTime: null }), { dueDate: null, dueTime: null })
  assert.deepEqual(typeRuntimeEffectiveDeadline(plan, { dueDate: '2026-10-08', dueTime: '19:13' }), { dueDate: '2026-10-08', dueTime: '19:13' })
})

test('runtime commands reject client-supplied trusted facts, bypasses and unknown actions', () => {
  const base = { commandId: randomUUID(), expectedVersion: 2, reason: '明确的阶段提交理由', action: 'submit_stage', stageKey: 'first_phase', expectedGovernanceVersion: 2, result: '实际完成成果说明', materials: [] }
  assert.ok(typeRuntimeCommand.safeParse(base).success)
  for (const extra of [{ tasks: [{ status: '已完成' }] }, { actorId: randomUUID() }, { nextStageKey: 'last_phase' }, { approved: true }, { lifecycle: 'closed' }]) assert.equal(typeRuntimeCommand.safeParse({ ...base, ...extra }).success, false)
  for (const action of ['activate', 'create_project', 'convert_lead', 'close', 'skip']) assert.equal(typeRuntimeCommand.safeParse({ ...base, action }).success, false)
  assert.equal(typeRuntimeCommand.safeParse({ ...base, materials: [{ requirementKey: 'evidence', kind: 'file', fileId: randomUUID(), version: 1, sha256: 'a'.repeat(64) }] }).success, false)
})
test('runtime pending recovery is scoped and contains no sensitive command payload', () => {
  const command = typeRuntimeCommand.parse({ commandId: randomUUID(), expectedVersion: 2, reason: '敏感的业务操作原因', action: 'submit_plan' }), projectId = randomUUID(), uid = randomUUID()
  const pending = typeRuntimeMarker(projectId, command), serialized = JSON.stringify(pending)
  assert.equal(serialized.includes(command.reason), false)
  assert.deepEqual(Object.keys(pending).sort(), ['action', 'commandId', 'expectedVersion', 'projectId'])
  assert.notEqual(typeRuntimePendingKey(uid, projectId), typeRuntimePendingKey(randomUUID(), projectId))
  assert.notEqual(typeRuntimePendingKey(uid, projectId), typeRuntimePendingKey(uid, randomUUID()))
  assert.deepEqual(readTypeRuntimePending({ getItem: () => serialized }, 'key'), pending)
  assert.throws(() => readTypeRuntimePending({ getItem: () => '{broken' }, 'key'))
})
test('leader reconciliation has an exact recoverable command and rejects forged sources', () => {
  const body = { action: 'reconcile_times', commandId: randomUUID(), expectedVersion: 3, reason: '按当前有效职责核对来源' }
  const command = typeRuntimeCommand.parse(body), marker = typeRuntimeMarker(randomUUID(), command)
  const receipt = { projectId: marker.projectId, commandId: command.commandId, action: command.action, version: 4, requestId: null }
  assert.deepEqual(verifyTypeRuntimeReceipt(receipt, marker), receipt)
  for (const extra of [{ leaderId: randomUUID() }, { sourceTypeActionId: randomUUID() }, { dueDate: '2027-02-01' }, { approved: true }]) assert.equal(typeRuntimeCommand.safeParse({ ...body, ...extra }).success, false)
})
test('runtime receipts and recovery verify exact project, actor-owned marker, command and next version', () => {
  const pending = typeRuntimeMarker(randomUUID(), typeRuntimeCommand.parse({ commandId: randomUUID(), expectedVersion: 8, action: 'submit_plan', reason: '明确操作的业务原因' }))
  const receipt = { projectId: pending.projectId, commandId: pending.commandId, action: pending.action, version: 9, requestId: randomUUID() }
  assert.deepEqual(verifyTypeRuntimeReceipt(receipt, pending), receipt)
  for (const patch of [{ projectId: randomUUID() }, { commandId: randomUUID() }, { action: 'decide' }, { version: 10 }]) assert.throws(() => verifyTypeRuntimeReceipt({ ...receipt, ...patch }, pending))
  assert.equal(verifyTypeRuntimeRecovery({ state: 'committed', receipt }, pending).state, 'committed')
  assert.equal(verifyTypeRuntimeRecovery({ state: 'not_committed', receipt: null }, pending).state, 'not_committed')
  assert.throws(() => verifyTypeRuntimeRecovery({ state: 'not_committed', receipt }, pending))
})
