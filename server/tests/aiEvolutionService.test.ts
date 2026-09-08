import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AiEvolutionService } from '../src/services/aiEvolutionService.js'
import type { EvolutionSpec } from '../src/contracts/aiEvolutionContract.js'
import { AiEvolutionExecutorRegistry } from '../src/services/aiEvolutionExecutorRegistry.js'

const uid = '00000000-0000-4000-8000-000000000001'
const spec: EvolutionSpec = {
  schemaVersion: 1, kind: 'experience', title: '来源规则', objective: '缺少来源标待核验',
  sourceRefs: [{ type: 'message', id: 'message-1' }], scope: { type: 'user', key: uid }, acceptanceCriteria: ['显示待核验'],
  questions: [], budget: { maxDurationSeconds: 600, maxModelTokens: 1000, maxRepairRounds: 3 },
  target: { type: 'experience', rule: '缺少来源标待核验', taskTypes: ['chat'], exceptions: [], replacesVersionIds: [] },
}

function fixture(executors = new AiEvolutionExecutorRegistry()) {
  let sourceAllowed = true
  let frozenSourceAllowed = true
  let creates = 0
  const now = new Date()
  const proposal = { id: 'proposal', ownerUserId: uid, kind: spec.kind, spec, specHash: 'hash', status: 'ready', revision: 1,
    idempotencyKey: 'private-key', createInputHash: 'hash', createdAt: now, updatedAt: now }
  const row = { id: 'run', proposalId: proposal.id, inputHash: 'hash', status: 'executing', stage: 'executing', attempt: 1,
    budget: spec.budget, modelTokens: null, elapsedSeconds: 10, repairRounds: 0, cancelRequestedAt: null,
    error: null, createdAt: now, updatedAt: now, leaseToken: 999, leaseOwner: 'private-host', frozenSpec: { ...spec, sourceRefs: [{ type: 'message', id: 'original-source' }] } }
  const repository = {
    createProposal: async () => { creates++; return proposal }, findProposal: async () => proposal,
    listProposals: async () => [proposal], listProposalActivity: async () => ({ [proposal.id]: { runStatus: row.status } }), findRun: async () => row,
    decideProposal: async (_userId: string, _id: string, revision: number, decision: 'rejected' | 'deferred') => ({ ...proposal,
      status: decision === 'rejected' ? 'rejected' : 'draft', revision: revision + 1 }),
    requestCancel: async () => ({ ...row, cancelRequestedAt: now }),
  } as unknown as ConstructorParameters<typeof AiEvolutionService>[0]
  const service = new AiEvolutionService(repository, {
    canAccessSource: async (_userId, source) => source.id === 'original-source' ? frozenSourceAllowed : sourceAllowed, canAccessProject: async () => true, canManageScope: async () => false,
    canDevelopRepository: async () => false, canManageCapability: async () => false, codeEnvironmentAvailable: async () => false,
    budgetLimit: spec.budget,
  }, async (userId) => ({ userId, enabled: true }), executors)
  return { service, denySource: () => { sourceAllowed = false }, denyFrozenSource: () => { frozenSourceAllowed = false }, creates: () => creates }
}

test('a ready code worker cannot admit or resume an experience run through the service', async () => {
  const registry = new AiEvolutionExecutorRegistry()
  registry.register({ available: async () => true }, 'code')
  const f = fixture(registry)
  await assert.rejects(f.service.execute(uid, 'proposal', { expectedRevision: 1 }, 'execute-key'), { code: 'EVOLUTION_EXECUTOR_NOT_READY' })
  await assert.rejects(f.service.resume(uid, 'run', 1), { code: 'EVOLUTION_EXECUTOR_NOT_READY' })
  // The repository fixture deliberately has no enqueue/resume implementation: neither may be reached.
  f.denySource()
  await assert.rejects(f.service.execute(uid, 'proposal', { expectedRevision: 1 }, 'execute-key'), { code: 'EVOLUTION_SOURCE_FORBIDDEN' })
})

test('service validates idempotency and source before writing any proposal', async () => {
  const f = fixture()
  await assert.rejects(f.service.create(uid, { spec }, undefined), { code: 'EVOLUTION_IDEMPOTENCY_REQUIRED' })
  f.denySource()
  await assert.rejects(f.service.create(uid, { spec }, 'valid-key'), { code: 'EVOLUTION_SOURCE_FORBIDDEN' })
  assert.equal(f.creates(), 0)
})

test('DTOs exclude private idempotency, lease and execution internals', async () => {
  const f = fixture()
  const proposal = await f.service.create(uid, { spec }, 'key')
  assert.equal('idempotencyKey' in proposal, false)
  const run = await f.service.run(uid, 'run')
  for (const key of ['leaseToken', 'leaseOwner', 'frozenSpec']) assert.equal(key in run, false)
  assert.equal(run.usage.modelTokens, null)
})

test('revoked source disappears from lists and blocks reads but owner can still request cancellation', async () => {
  const f = fixture()
  f.denySource()
  assert.deepEqual((await f.service.list(uid, {})).list, [])
  await assert.rejects(f.service.get(uid, 'proposal'), { code: 'EVOLUTION_SOURCE_FORBIDDEN' })
  const cancelled = await f.service.cancel(uid, 'run')
  assert.equal(cancelled.status, 'executing')
  assert.ok(cancelled.cancelRequestedAt)
})

test('editing proposal sources cannot bypass revoked access to the original run snapshot', async () => {
  const f = fixture()
  f.denyFrozenSource()
  assert.equal((await f.service.get(uid, 'proposal')).id, 'proposal')
  await assert.rejects(f.service.run(uid, 'run'), { code: 'EVOLUTION_SOURCE_FORBIDDEN' })
  await assert.rejects(f.service.authorizeRun(uid, 'run', true), { code: 'EVOLUTION_SOURCE_FORBIDDEN' })
  await assert.rejects(f.service.authorizeSpec(uid, { ...spec, sourceRefs: [{ type: 'message', id: 'original-source' }] }), { code: 'EVOLUTION_SOURCE_FORBIDDEN' })
  const cancelled = await f.service.cancel(uid, 'run')
  assert.ok(cancelled.cancelRequestedAt)
})

test('proposal decisions use the current revision and preserve a deferred proposal as draft', async () => {
  const f = fixture()
  assert.equal((await f.service.decideProposal(uid, 'proposal', { expectedRevision: 1, decision: 'deferred' })).status, 'draft')
  assert.equal((await f.service.decideProposal(uid, 'proposal', { expectedRevision: 1, decision: 'rejected' })).status, 'rejected')
  await assert.rejects(f.service.decideProposal(uid, 'proposal', { expectedRevision: 1, decision: 'approved' }))
})
