import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEvolutionDueDiligenceEvaluator } from '../src/runtime/evolution/evolutionDueDiligenceEvaluator.js'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'

test('composed evaluator binds fixed configuration and rejects unauthorized or changed baselines before rendering', async () => {
  const version = { capabilityId: 'skill', instructions: 'baseline', references: [], dependencies: [], toolPermissionHash: 'a'.repeat(64) }
  let prepared = 0, terminated = 0, selection = 0
  const config: Parameters<typeof createEvolutionDueDiligenceEvaluator>[0] = {
    route: { modelId: 'model', providerId: 'provider', model: 'fixture', baseUrl: 'https://example.test', apiKey: 'secret', timeoutMs: 1000 },
    image: `sha256:${'b'.repeat(64)}`, maxOutputTokens: 1000,
    snapshot: { version, contentHash: evolutionContentHash(version), packageHash: evolutionContentHash([]), files: [], manifest: [] },
    metric: { name: 'coverage', direction: 'higher', minimumImprovement: 1 },
    samples: { profileHash: 'c'.repeat(64), select: actor => {
      selection++; assert.equal(actor.userId, 'owner'); throw Object.assign(Error('unauthorized sample'), { code: 'EVOLUTION_SAMPLE_FORBIDDEN' })
    } },
    environment: { create: async () => { prepared++; throw Error('must not create') }, importSnapshot: async () => { throw Error('must not import') },
      writeInputFile: async () => { throw Error('must not write') }, evaluateNode: async () => { throw Error('must not execute') },
      readOutputFile: async () => { throw Error('must not read') }, terminate: async () => { terminated++; return { confirmed: true } } },
    store: { put: async () => { throw Error('must not write') } },
  }
  const evaluator = await createEvolutionDueDiligenceEvaluator(config)
  assert.notEqual(evaluator.profileHash, (await createEvolutionDueDiligenceEvaluator({ ...config, maxOutputTokens: 2000 })).profileHash)
  const control = { identity: { runId: 'run', attempt: 1, leaseToken: 1, inputHash: 'd'.repeat(64) },
    signal: new AbortController().signal, assertCanContinue: async () => {} }
  const args = { ownerUserId: 'owner', baseline: version, candidate: { ...version, instructions: 'candidate' }, sampleIds: ['visible'], control,
    budget: { reserveModelTokens: async () => {}, recordModelUsage: async () => {} } }
  await assert.rejects(evaluator.evaluate({ ...args, baseline: { ...version, instructions: 'changed' } }), { code: 'EVOLUTION_DEVELOPER_BASELINE' })
  assert.equal(selection, 0)
  await assert.rejects(evaluator.evaluate(args), { code: 'EVOLUTION_SAMPLE_FORBIDDEN' })
  assert.equal(prepared, 0)
  await evaluator.terminate(control.identity); assert.equal(terminated, 1)
})
