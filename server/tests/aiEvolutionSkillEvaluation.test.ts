import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { AiEvolutionArtifactStore } from '../src/services/aiEvolutionArtifactStore.js'
import { previewEvolutionSkillComparison } from '../src/services/aiEvolutionSkillComparisonPreview.js'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'
import { evaluateEvolutionSkill, type EvolutionSkillVersion } from '../src/runtime/evolution/evolutionSkillEvaluation.js'
import { EVOLUTION_REQUIRED_CHECKS } from '../src/contracts/aiEvolutionEvaluationContract.js'

const version: EvolutionSkillVersion = { capabilityId: 'capability', instructions: 'baseline', references: [], dependencies: [], toolPermissionHash: 'a'.repeat(64) }

test('identical supporting files remain linked to both sides but form a valid unique persisted manifest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-shared-evidence-'))
  try {
    const store = new AiEvolutionArtifactStore(root), runId = randomUUID()
    const f = fixture()
    f.input.store = store
    f.input.control.identity.runId = runId
    const shared = await store.put(runId, Buffer.from('shared rendered page fixture'), 'screenshot')
    f.input.run = async ({ skill }) => ({ content: Buffer.from(skill.instructions), contentType: 'text/plain', supportingArtifacts: [shared] })
    const result = await evaluateEvolutionSkill(f.input)
    await store.verifyManifest(runId, { schemaVersion: 1, sourceHash: result.candidateHash, patchHash: 'a'.repeat(64),
      dependencyLockHash: 'b'.repeat(64), environment: 'test', artifacts: result.artifacts })
    assert.equal(result.artifacts.filter(item => item.storageKey === shared.storageKey).length, 1)
    const report = JSON.parse((await store.read(runId, result.artifacts.find(item => item.kind === 'report')!)).toString())
    assert.equal(report.comparisons[0].sides[0].supportingArtifacts[0].storageKey, shared.storageKey)
    assert.equal(report.comparisons[0].sides[1].supportingArtifacts[0].storageKey, shared.storageKey)
    const candidate = { runId, baseRef: result.baselineHash, manifest: { schemaVersion: 1 as const, sourceHash: result.candidateHash,
      patchHash: 'a'.repeat(64), dependencyLockHash: 'b'.repeat(64), environment: 'test', artifacts: result.artifacts },
      evaluation: { hash: evolutionContentHash(result.evaluation), report: result.evaluation } }
    const preview = await previewEvolutionSkillComparison(candidate, store)
    assert.equal(preview.samples[0].sides[0].downloads[1].index, preview.samples[0].sides[1].downloads[1].index)
    assert.equal(JSON.stringify(preview).includes('storageKey'), false)
    await assert.rejects(previewEvolutionSkillComparison({ ...candidate, evaluation: { ...candidate.evaluation, hash: '0'.repeat(64) } }, store))
    await assert.rejects(previewEvolutionSkillComparison({ ...candidate, manifest: { ...candidate.manifest,
      artifacts: candidate.manifest.artifacts.filter(row => row.storageKey !== shared.storageKey) } }, store))
  } finally { await rm(root, { recursive: true, force: true }) }
})
function fixture(fail = false, improves = true) {
  const received: unknown[] = [], stored: Buffer[] = []
  const input: Parameters<typeof evaluateEvolutionSkill>[0] = {
    baseline: version, candidate: { ...version, instructions: 'candidate' },
    samples: [{ id: 'sample-1', input: 'same material', materialHashes: ['b'.repeat(64)] }],
    runtime: { modelId: 'fixed', modelVersion: 'v1', rendererVersion: 'v1', promptHash: 'c'.repeat(64) },
    suiteVersion: 'reviewed-v1', metric: { name: 'required evidence coverage', direction: 'higher', minimumImprovement: 1 },
    control: { signal: new AbortController().signal, identity: { runId: 'run', attempt: 1, leaseToken: 1, inputHash: 'd'.repeat(64) }, assertCanContinue: async () => {} },
    store: { put: async (_run, bytes, kind) => { stored.push(Buffer.from(bytes)); const hash = createHash('sha256').update(bytes).digest('hex'); return { storageKey: `${hash}.bin`, sha256: hash, bytes: bytes.length, kind } } },
    run: async ({ sample, skill, runtime }) => {
      received.push(structuredClone({ sample, runtime }))
      sample.input = 'mutated callback input'
      return { content: Buffer.from(skill.instructions), contentType: 'text/plain' }
    },
    assess: async ({ output }) => ({ score: output.content.toString() === 'baseline' || !improves ? 1 : 2,
      checks: EVOLUTION_REQUIRED_CHECKS.skill.map((id) => ({ id, verdict: fail && id === 'sources' ? 'FAIL' : 'PASS', evidence: 'independent measured evidence' })) }),
  }
  return { input, received, stored }
}

test('skill comparison freezes identical sample/runtime inputs and stores both outputs with measured improvement', async () => {
  const f = fixture()
  const result = await evaluateEvolutionSkill(f.input)
  assert.equal(result.eligibleForApproval, true)
  assert.deepEqual(f.received[0], f.received[1])
  assert.equal(f.stored[0].toString(), 'baseline')
  assert.equal(f.stored[1].toString(), 'candidate')
  assert.equal(JSON.parse(f.stored[2].toString()).instructions, 'baseline')
  assert.equal(JSON.parse(f.stored[3].toString()).instructions, 'candidate')
  const report = JSON.parse(f.stored[4].toString())
  assert.equal(report.comparisons[0].sides.length, 2)
  assert.equal(report.runtime.modelVersion, 'v1')
  assert.notEqual(result.baselineHash, result.candidateHash)
})

test('hard check failure or no measured improvement prevents approval eligibility', async () => {
  for (const f of [fixture(true), fixture(false, false)]) {
    const result = await evaluateEvolutionSkill(f.input)
    assert.equal(result.evaluation.verdict, 'FAIL')
    assert.equal(result.eligibleForApproval, false)
  }
})

test('dependency changes require code review before any generation; cancellation prevents calls', async () => {
  const f = fixture()
  f.input.candidate = { ...f.input.candidate, dependencies: [{ name: 'new-script', contentHash: 'f'.repeat(64) }] }
  await assert.rejects(evaluateEvolutionSkill(f.input), { code: 'EVOLUTION_SEPARATE_REVIEW_REQUIRED' })
  assert.equal(f.received.length, 0)
  const cancelled = fixture()
  cancelled.input.control.signal = AbortSignal.abort(new Error('cancelled'))
  await assert.rejects(evaluateEvolutionSkill(cancelled.input), /cancelled/)
  assert.equal(cancelled.received.length, 0)
})
