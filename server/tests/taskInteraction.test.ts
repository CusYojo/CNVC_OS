import assert from 'node:assert/strict'
import test from 'node:test'
import { canPerformTaskAction, taskRecovery, taskRequiresReview, taskEvidencePath, taskDecisionRequest } from '../../src/lib/taskInteraction.js'
import { fdeTaskDecisionSchema } from '../src/contracts/fdeTaskContract.js'

const capabilities = { canFeedback: true, canAccept: false, canExtend: true, canCancel: false }
const task = { id: 'task', version: 1, status: '进行中', capabilities, extensions: [] }

test('task actions respect canonical state and explicit capabilities, including readonly owner acceptance', () => {
  assert.equal(canPerformTaskAction('not_started', { ...task, status: '未开始' }), true)
  assert.equal(canPerformTaskAction('not_started', task), false)
  assert.equal(canPerformTaskAction('submission', task), true)
  assert.equal(canPerformTaskAction('submission', { ...task, status: '待验收' }), false)
  assert.equal(canPerformTaskAction('pending_acceptance', { ...task, status: '待验收' }), false)
  const reviewer = { ...task, status: 'pending_acceptance', capabilities: { ...capabilities, canAccept: true } }
  assert.equal(canPerformTaskAction('accept', reviewer), true)
  assert.equal(canPerformTaskAction('return', reviewer), true)
  assert.equal(canPerformTaskAction('feedback', { ...task, capabilities: {} }), false)
  assert.equal(canPerformTaskAction('extension', { ...task, extensions: [{ status: '审批中' }] }), false)
  assert.equal(canPerformTaskAction('cancel', task), false)
  assert.equal(canPerformTaskAction('in_progress', { ...task, capabilities: { ...capabilities, canSubmit: false } }), false)
  for (const status of ['已完成', '已取消', '已关闭', '已归档']) {
    for (const action of ['progress', 'submission', 'accept', 'return', 'extension', 'cancel']) {
      assert.equal(canPerformTaskAction(action, { ...task, status, capabilities: { canFeedback: true, canAccept: true, canExtend: true, canCancel: true } }), false)
    }
  }
})

test('conflict recovery only offers an explicit reviewed snapshot, never overwrites the original draft', () => {
  const draft = { task, result: '保留正在填写的成果', reason: '保留说明', files: ['file'] }
  const latest = { ...task, version: 2 }
  const recovery = taskRecovery('submission', task.id, [latest])
  assert.equal(recovery.task, latest)
  assert.equal(recovery.canContinue, true)
  assert.equal(draft.task.version, 1)
  assert.equal(draft.result, '保留正在填写的成果')
  assert.deepEqual(draft.files, ['file'])
  assert.equal(taskRecovery('submission', task.id, [{ ...latest, status: '待验收' }]).canContinue, false)
  assert.equal(taskRecovery('submission', task.id, [{ ...latest, capabilities: {} }]).canContinue, false)
  assert.equal(taskRecovery('submission', task.id, []).task, null)
  assert.equal(taskRecovery('accept', task.id, [{ ...latest, status: '待验收', capabilities: { canAccept: true } }]).canContinue, true)
})

test('state and permission failures require fresh review; transient network failures do not auto-retry', () => {
  for (const failure of [{ status: 409 }, { status: 403 }, { status: 404 }, { code: 'VERSION_CONFLICT' }, { code: 'FDE_TASK_SUBMISSION_CHANGED' }]) assert.equal(taskRequiresReview(failure), true)
  for (const failure of [null, new Error('网络失败'), { status: 500 }, { status: 0, code: 'NETWORK_ERROR' }]) assert.equal(taskRequiresReview(failure), false)
})

test('return requires a reason and references exactly the submitted file version', () => {
  const id = '10000000-0000-4000-8000-000000000001'
  const decision = { expectedVersion: 2, feedbackId: id, action: 'return', reason: '请补充核对结果' }
  assert.equal(fdeTaskDecisionSchema.safeParse(decision).success, true)
  assert.equal(fdeTaskDecisionSchema.safeParse({ ...decision, reason: ' ' }).success, false)
  assert.equal(taskEvidencePath(id, 3), `/api/projects/files/${id}/versions/3/download`)
  assert.equal(taskEvidencePath('../other', 3), null)
  assert.equal(taskEvidencePath(id, 0), null)
})

test('acceptance and return bind to the latest submission and reject readonly or missing-result requests', () => {
  const id = '10000000-0000-4000-8000-000000000001'
  const reviewable = { ...task, status: '待验收', capabilities: { canAccept: true }, feedbacks: [{ id, kind: 'submission' }] }
  assert.deepEqual(taskDecisionRequest(reviewable, 'return', '需要补充数据'), { expectedVersion: 1, feedbackId: id, action: 'return', reason: '需要补充数据' })
  assert.deepEqual(taskDecisionRequest({ ...reviewable, version: 2 }, 'accept', '同意验收'), { expectedVersion: 2, feedbackId: id, action: 'accept', reason: '同意验收' })
  assert.throws(() => taskDecisionRequest(reviewable, 'return', ' '))
  assert.throws(() => taskDecisionRequest({ ...reviewable, capabilities: { canAccept: false } }, 'accept', '同意验收'))
  assert.throws(() => taskDecisionRequest({ ...reviewable, feedbacks: [] }, 'accept', '同意验收'))
})
