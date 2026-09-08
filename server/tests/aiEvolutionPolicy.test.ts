import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertEvolutionLease, assertEvolutionOwner, assertEvolutionSpecAccess, evolutionContentHash, type EvolutionPolicyDependencies } from '../src/services/aiEvolutionPolicyService.js'
import type { EvolutionSpec } from '../src/contracts/aiEvolutionContract.js'

const actor = { userId: 'user-1', enabled: true }
const spec: EvolutionSpec = {
  schemaVersion: 1, kind: 'code', title: '来源入口', objective: '展开已有来源',
  scope: { type: 'user', key: actor.userId }, sourceRefs: [{ type: 'message', id: 'message-1' }],
  acceptanceCriteria: ['可以展开'], questions: [], budget: { maxDurationSeconds: 600, maxModelTokens: 20_000, maxRepairRounds: 3 },
  target: { type: 'code', repositoryId: 'repo-1', baseCommit: 'a'.repeat(40), allowedPaths: ['src/pages'], databaseChange: false, permissionChange: false },
}
const deps: EvolutionPolicyDependencies = {
  canAccessProject: async () => true, canAccessSource: async () => true, canManageScope: async () => false,
  canDevelopRepository: async () => false, canManageCapability: async () => false,
  codeEnvironmentAvailable: async () => true, budgetLimit: spec.budget,
}

test('project access never grants repository execution and a proposal is not authorization', async () => {
  await assertEvolutionSpecAccess(actor, spec, deps)
  await assert.rejects(assertEvolutionSpecAccess(actor, spec, deps, true), { code: 'EVOLUTION_REPOSITORY_FORBIDDEN' })
  await assertEvolutionSpecAccess(actor, spec, { ...deps, canDevelopRepository: async () => true }, true)
})

test('rechecks source, user, scope and environment on execution', async () => {
  await assert.rejects(assertEvolutionSpecAccess(actor, spec, { ...deps, canAccessSource: async () => false }, true), { code: 'EVOLUTION_SOURCE_FORBIDDEN' })
  assert.throws(() => assertEvolutionOwner(actor, 'another-user'), { code: 'EVOLUTION_NOT_FOUND' })
  await assert.rejects(assertEvolutionSpecAccess({ ...actor, enabled: false }, spec, deps), { code: 'EVOLUTION_USER_DISABLED' })
  await assert.rejects(assertEvolutionSpecAccess(actor, { ...spec, scope: { type: 'organization', key: 'org' } }, deps), { code: 'EVOLUTION_SCOPE_FORBIDDEN' })
  await assert.rejects(assertEvolutionSpecAccess(actor, spec, { ...deps, canDevelopRepository: async () => true, codeEnvironmentAvailable: async () => false }, true), { code: 'EVOLUTION_ENVIRONMENT_UNAVAILABLE' })
})

test('canonical hashes ignore object key ordering but preserve semantic and array changes', () => {
  assert.equal(evolutionContentHash({ a: 1, b: { c: 2 } }), evolutionContentHash({ b: { c: 2 }, a: 1 }))
  assert.notEqual(evolutionContentHash([1, 2]), evolutionContentHash([2, 1]))
  assert.notEqual(evolutionContentHash(spec), evolutionContentHash({ ...spec, objective: 'different' }))
  assert.throws(() => evolutionContentHash({ value: NaN }))
})

test('project scope authorization receives the exact target and still requires project access', async () => {
  const scoped = { ...spec, businessProjectId: 'project-1', scope: { type: 'project' as const, key: 'project-1' } }
  let observed: EvolutionSpec['target'] | undefined
  const granted = { ...deps, canManageScope: async (_user: string, _scope: EvolutionSpec['scope'], target: EvolutionSpec['target']) => {
    observed = target; return true
  } }
  await assertEvolutionSpecAccess(actor, scoped, granted)
  assert.deepEqual(observed, spec.target)
  await assert.rejects(assertEvolutionSpecAccess(actor, scoped, { ...granted, canAccessProject: async () => false }), { code: 'EVOLUTION_PROJECT_FORBIDDEN' })
})

test('fencing rejects mismatched attempts, tokens, inputs, expired leases and cancelled success', () => {
  const identity = { runId: 'run-1', attempt: 2, leaseToken: 3, inputHash: 'a'.repeat(64) }
  const stored = { ...identity, leaseExpiresAt: new Date(2000), cancelRequestedAt: null }
  assertEvolutionLease(stored, identity, new Date(1000))
  for (const changed of [{ attempt: 1 }, { leaseToken: 2 }, { runId: 'run-2' }, { inputHash: 'other' }]) {
    assert.throws(() => assertEvolutionLease(stored, { ...identity, ...changed }, new Date(1000)), { code: 'EVOLUTION_STALE_EXECUTOR' })
  }
  assert.throws(() => assertEvolutionLease(stored, identity, new Date(2000)), { code: 'EVOLUTION_STALE_EXECUTOR' })
  assert.throws(() => assertEvolutionLease({ ...stored, cancelRequestedAt: new Date(500) }, identity, new Date(1000)), { code: 'EVOLUTION_CANCEL_REQUESTED' })
})
