import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { processNextEvolutionReleaseJob } from '../src/runtime/evolution/evolutionReleaseJobWorker.js'
import type { EvolutionReleaseJob } from '../src/repositories/mysql/mysqlAiEvolutionReleaseJobRepository.js'

const identity = { schemaVersion: 1 as const, baseCommit: 'a'.repeat(40), patchHash: 'b'.repeat(64),
  lockHash: 'c'.repeat(64), serverEntrySha256: 'd'.repeat(64), webEntrySha256: 'e'.repeat(64) }
const receipt = { releaseId: 'build-fixture', candidateHash: 'f'.repeat(64), previousReleaseId: 'runtime:fixture',
  candidateIdentity: identity, previousIdentity: { ...identity, serverEntrySha256: '1'.repeat(64) } }
function job(status = 'preparing', attempt = 1): EvolutionReleaseJob {
  return { id: randomUUID(), candidateId: randomUUID(), approvalId: randomUUID(), actorUserId: randomUUID(), environment: 'local',
    idempotencyKey: randomUUID(), inputHash: '0'.repeat(64), status, receipt: status === 'prepared' ? receipt : null,
    attempt, leaseToken: 4, leaseOwner: 'publisher', leaseExpiresAt: new Date(Date.now() + 120_000), error: null,
    createdAt: new Date(), updatedAt: new Date(), completedAt: null }
}

test('release job worker renews, durably saves preparation, then dispatches', async () => {
  const row = job(), calls: string[] = []
  const result = await processNextEvolutionReleaseJob({ leaseOwner: 'publisher', claimNext: async () => row,
    renewLease: async () => { calls.push('renew') }, prepare: async (_job, control) => { calls.push('prepare'); await control.assertHeld(); return receipt },
    savePrepared: async (_lease, value) => { calls.push('save'); return { ...row, status: 'prepared', receipt: value } },
    releaseForRetry: async () => { calls.push('retry') }, dispatch: async (_job, value, control) => {
      calls.push('dispatch'); assert.deepEqual(value, receipt); assert.equal(control.signal.aborted, false)
    }, settleDispatchFailure: async () => { calls.push('settle') } })
  assert.deepEqual(result, { jobId: row.id, dispatched: true })
  assert.deepEqual(calls, ['prepare', 'renew', 'renew', 'save', 'renew', 'dispatch'])
})

test('release job worker skips repeated preparation when receipt is already durable', async () => {
  const row = job('prepared'), calls: string[] = []
  await processNextEvolutionReleaseJob({ leaseOwner: 'publisher', claimNext: async () => row,
    renewLease: async () => { calls.push('renew') }, prepare: async () => { throw Error('must not prepare') },
    savePrepared: async () => { throw Error('must not save') }, releaseForRetry: async () => { throw Error('must not retry') },
    dispatch: async () => { calls.push('dispatch') }, settleDispatchFailure: async () => { throw Error('must not settle') } })
  assert.deepEqual(calls, ['renew', 'dispatch'])
})

test('release job worker retries bounded preparation failures and stops after the limit', async () => {
  for (const [attempt, retry] of [[1, true], [3, false]] as const) {
    const row = job('preparing', attempt), decisions: boolean[] = []
    await assert.rejects(processNextEvolutionReleaseJob({ leaseOwner: 'publisher', maxPrepareAttempts: 3,
      claimNext: async () => row, renewLease: async () => {}, prepare: async () => { throw Object.assign(Error('broken'), { code: 'BROKEN' }) },
      savePrepared: async () => row, releaseForRetry: async (_lease, error, value) => { decisions.push(value); assert.equal(error.code, 'BROKEN') },
      dispatch: async () => { throw Error('must not dispatch') }, settleDispatchFailure: async () => { throw Error('must not settle') } }), /broken/)
    assert.deepEqual(decisions, [retry])
  }
})

test('release job worker delegates uncertain dispatch failures to the repository transaction', async () => {
  const row = job('prepared', 2), failures: string[] = []
  await assert.rejects(processNextEvolutionReleaseJob({ leaseOwner: 'publisher', claimNext: async () => row,
    renewLease: async () => {}, prepare: async () => receipt, savePrepared: async () => row, releaseForRetry: async () => {},
    dispatch: async () => { throw Object.assign(Error('activation uncertain'), { code: 'UNCERTAIN' }) },
    settleDispatchFailure: async (_lease, error, max) => { failures.push(`${error.code}:${max}`) } }), /activation uncertain/)
  assert.deepEqual(failures, ['UNCERTAIN:3'])
})
