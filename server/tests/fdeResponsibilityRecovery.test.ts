import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ApiError } from '../src/contracts/apiErrorContract.js'
import { responsibilityOverview, responsibilityDetail, responsibilityAssignmentState, responsibilityActionLabels } from '../src/contracts/fdeResponsibilityViewContract.js'
import { responsibilityPending, responsibilityRecoveryKey, readResponsibilityPending, rememberResponsibilityPending, forgetResponsibilityPending, responsibilityCommandPath, responsibilityWriteReceipt, responsibilityResolvedResult, responsibilityResultUnknown, type ResponsibilityPending } from '../../src/lib/fdeResponsibilityRecovery.js'

const marker = (): ResponsibilityPending => ({ projectId: randomUUID(), recordId: randomUUID(), commandId: randomUUID(), action: 'appeal' })
const memory = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } } }
test('responsibility recovery persists minimal actor-scoped identifiers without payload', () => {
  const storage = memory(), value = marker(), key = responsibilityRecoveryKey('actor-a')
  rememberResponsibilityPending(storage, key, value)
  assert.deepEqual(readResponsibilityPending(storage, key), value)
  assert.equal(readResponsibilityPending(storage, responsibilityRecoveryKey('actor-b')), null)
  assert.throws(() => rememberResponsibilityPending(storage, key, { ...value, reason: 'private', path: '/admin' } as ResponsibilityPending))
  assert.equal(storage.getItem(key)?.includes('private'), false)
})
test('invalid recovery targets and arbitrary routes are rejected', () => {
  const value = marker()
  for (const bad of [{}, null, { ...value, recordId: '../../admin' }, { ...value, action: 'propose' }, { ...value, actorId: randomUUID() }]) assert.equal(responsibilityPending.safeParse(bad).success, false)
  assert.equal(responsibilityCommandPath(value), `/responsibility/projects/${value.projectId}/commands`)
})
test('a pending request cannot be replaced or cleared by a stale action', () => {
  const storage = memory(), value = marker()
  rememberResponsibilityPending(storage, 'key', value)
  assert.throws(() => rememberResponsibilityPending(storage, 'key', marker()))
  assert.throws(() => forgetResponsibilityPending(storage, 'key', { ...value, action: 'review' }))
  assert.deepEqual(readResponsibilityPending(storage, 'key'), value)
  forgetResponsibilityPending(storage, 'key', value)
  assert.equal(readResponsibilityPending(storage, 'key'), null)
})
test('storage failures and corrupt data fail closed', () => {
  const storage = memory(), value = marker()
  rememberResponsibilityPending(storage, 'key', value)
  for (const method of ['getItem', 'setItem'] as const) assert.throws(() => rememberResponsibilityPending({ ...storage, [method]: () => { throw new Error('blocked') } }, 'key', value))
  assert.throws(() => forgetResponsibilityPending({ ...storage, removeItem: () => { throw new Error('blocked') } }, 'key', value))
  assert.deepEqual(readResponsibilityPending(storage, 'key'), value)
  storage.setItem('key', '{'); assert.throws(() => readResponsibilityPending(storage, 'key'))
})
test('receipts bind command, record and project; absence alone is not a recovery result', () => {
  const value = marker(), receipt = { commandId: value.commandId, projectId: value.projectId, recordId: value.recordId, taskId: randomUUID(), status: 'appealing', version: 3 }
  assert.deepEqual(responsibilityWriteReceipt(receipt, value), receipt)
  assert.deepEqual(responsibilityResolvedResult({ state: 'committed', receipt }, value), { state: 'committed', receipt })
  assert.deepEqual(responsibilityResolvedResult({ state: 'not_committed', receipt: null }, value), { state: 'not_committed', receipt: null })
  for (const key of ['projectId', 'recordId', 'commandId']) assert.throws(() => responsibilityWriteReceipt({ ...receipt, [key]: randomUUID() }, value))
  for (const bad of [{ found: false }, { state: 'not_committed', receipt }, { state: 'committed', receipt: { ...receipt, reason: 'private' } }]) assert.throws(() => responsibilityResolvedResult(bad, value))
})
test('unknown transport and malformed receipts never authorize automatic replay', () => {
  for (const error of [new Error('network'), new ApiError('timeout', 'TIMEOUT', 408), new ApiError('server', 'FAIL', 500), new ApiError('bad', 'BAD_JSON', 200)]) assert.equal(responsibilityResultUnknown(error), true)
  assert.equal(responsibilityResultUnknown(new ApiError('version', 'VERSION_CONFLICT', 409)), false)
})
test('workbench capability contract excludes personnel scores and requires real counts', () => {
  const value = { management: false, assignmentAccess: true, assignment: 0, mine: 2, review: 0, unread: 1 }
  assert.deepEqual(responsibilityOverview.parse(value), value)
  assert.equal(responsibilityOverview.safeParse({ ...value, ranking: [] }).success, false)
  assert.equal(responsibilityOverview.safeParse({ ...value, review: -1 }).success, false)
  assert.equal(responsibilityOverview.safeParse({ ...value, assignment: -1 }).success, false)
  assert.equal(responsibilityOverview.safeParse({ ...value, assignmentAccess: undefined }).success, false)
})
test('assignment state distinguishes missing and stale reviewers; scanner history has a human label', () => {
  for (const state of ['not_required', 'unassigned', 'invalid', 'assigned']) assert.equal(responsibilityAssignmentState.parse(state), state)
  assert.equal(responsibilityAssignmentState.safeParse('auto_approved').success, false)
  assert.equal(responsibilityActionLabels.scan_candidate, '系统期限扫描形成候选')
})
test('view contracts retain complete frozen evidence metadata without weakening write targets', () => {
  const proof = { fileId: randomUUID(), version: 1, fileVersionId: randomUUID(), sha256: 'a'.repeat(64), byteSize: 32 }
  const linked = { ...proof, id: randomUUID(), recordId: randomUUID(), fileName: '原件.txt', canDownload: false }
  assert.deepEqual(responsibilityDetail.shape.evidence.parse([linked]), [linked])
  assert.equal(responsibilityDetail.shape.evidence.safeParse([{ ...linked, fileVersionId: 'invalid' }]).success, false)
  const appeal = { reason: '已批准延期的合成证据', createdAt: new Date().toISOString(), version: 3, evidence: [proof] }
  assert.deepEqual(responsibilityDetail.shape.appeal.parse(appeal), appeal)
})
