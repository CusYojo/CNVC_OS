import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSameComplianceDecision, complianceSupplementSnapshot, decideComplianceSupplement, restoreComplianceSupplementDecision } from '../src/services/complianceSupplementDecision.js'

const snapshot = complianceSupplementSnapshot({ taskId: 'task-a', projectId: 'project-a', missingItems: ['基金协议'], blockingIssues: [] })
const input = { snapshot, actorId: 'authenticated-user', decidedAt: new Date('2026-09-07T08:00:00Z') }

test('generation restores only the owned decision for the current reviewed gaps', () => {
  const record = decideComplianceSupplement({ ...input, choice: { action: 'continue_with_gaps', snapshotId: snapshot.snapshotId } })
  assert.deepEqual(restoreComplianceSupplementDecision({ ...input, record }), record)
  for (const changed of [
    { ...input, actorId: 'other-user' },
    { ...input, snapshot: complianceSupplementSnapshot({ ...snapshot, projectId: 'other-project' }) },
    { ...input, snapshot: complianceSupplementSnapshot({ ...snapshot, missingItems: ['新的交易缺口'] }) },
    { ...input, snapshot: complianceSupplementSnapshot({ ...snapshot, blockingIssues: ['禁止性冲突'] }) },
  ]) assert.throws(() => restoreComplianceSupplementDecision({ ...changed, record }))
  for (const invalid of [null, {}, { ...record, decidedAt: 'invalid' },
    { ...record, requiresEvidenceReview: false }, { ...record, acceptedMissingItems: [] }]) {
    assert.throws(() => restoreComplianceSupplementDecision({ ...input, record: invalid }))
  }
})

test('idempotent confirmation permits timestamp changes but rejects altered consent or ownership', () => {
  const decision = decideComplianceSupplement({ ...input, choice: { action: 'continue_with_gaps', snapshotId: snapshot.snapshotId } })
  assert.doesNotThrow(() => assertSameComplianceDecision({ ...decision, decidedAt: '2026-09-07T09:00:00Z' }, decision))
  for (const altered of [null, { ...decision, actorId: 'other-user' },
    { ...decision, action: 'supplement' }, { ...decision, acceptedMissingItems: [] },
    { ...decision, sourceTaskId: 'other-task' }]) {
    assert.throws(() => assertSameComplianceDecision(altered, decision), { code: 'COMPLIANCE_DECISION_CONFLICT' })
  }
})

test('explicit continuation records task, actor and accepted gaps without claiming verification', () => {
  const result = decideComplianceSupplement({ ...input, choice: { action: 'continue_with_gaps', snapshotId: snapshot.snapshotId } })
  assert.deepEqual(result.acceptedMissingItems, ['基金协议'])
  assert.equal(result.sourceTaskId, 'task-a')
  assert.equal(result.actorId, 'authenticated-user')
  assert.equal(result.requiresEvidenceReview, true)
  assert.equal('validation_status' in result, false)
})

test('changed gaps or a different task invalidate previous confirmation', () => {
  for (const changed of [
    complianceSupplementSnapshot({ ...snapshot, missingItems: ['基金协议', '交易金额'] }),
    complianceSupplementSnapshot({ ...snapshot, taskId: 'task-b' }),
  ]) assert.throws(() => decideComplianceSupplement({ ...input, snapshot: changed, choice: { action: 'continue_with_gaps', snapshotId: snapshot.snapshotId } }), { code: 'COMPLIANCE_GAPS_CHANGED' })
})

test('known conflict cannot be waived by consent', () => {
  const blocked = complianceSupplementSnapshot({ ...snapshot, blockingIssues: ['集中度超限'] })
  assert.throws(() => decideComplianceSupplement({ ...input, snapshot: blocked, choice: { action: 'continue_with_gaps', snapshotId: blocked.snapshotId } }), { code: 'COMPLIANCE_BLOCKING_CONFLICT' })
})

test('supplement means re-review, not accepting gaps or certifying truth', () => {
  const result = decideComplianceSupplement({ ...input, choice: { action: 'supplement', snapshotId: snapshot.snapshotId, supplementText: '补充的交易说明，需核验。' } })
  assert.deepEqual(result.acceptedMissingItems, [])
  assert.equal(result.requiresEvidenceReview, true)
  assert.throws(() => decideComplianceSupplement({ ...input, choice: { action: 'supplement', snapshotId: snapshot.snapshotId } }), { code: 'COMPLIANCE_SUPPLEMENT_REQUIRED' })
})
