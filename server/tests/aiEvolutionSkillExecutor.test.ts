import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createEvolutionSkillExecutor } from '../src/runtime/evolution/evolutionSkillExecutor.js'
import { evaluateEvolutionSkill } from '../src/runtime/evolution/evolutionSkillEvaluation.js'
import { AiEvolutionArtifactStore } from '../src/services/aiEvolutionArtifactStore.js'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'
import { EVOLUTION_REQUIRED_CHECKS } from '../src/contracts/aiEvolutionEvaluationContract.js'
import type { ClaimedEvolutionRun } from '../src/runtime/evolution/evolutionRunCoordinator.js'
import { previewEvolutionPatch } from '../src/services/aiEvolutionPatchPreview.js'
import { readEvolutionSkillCheckpoint } from '../src/services/aiEvolutionSkillCheckpoint.js'

test('skill executor joins durable metering, real comparison artifacts and deferred candidate persistence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-skill-executor-'))
  try {
    const baseline = { capabilityId: 'capability', instructions: 'baseline', references: [], dependencies: [], toolPermissionHash: 'a'.repeat(64) }
    let current = baseline, commits = 0, reserved = 0, settled = 0, authorizationHash = 'f'.repeat(64)
    const profiles: string[] = []
    const checkpoints: Record<string, unknown>[] = []
    let failQuality = false
    const store = new AiEvolutionArtifactStore(root), id = randomUUID()
    const run = { id, inputHash: 'b'.repeat(64), repairRounds: 0, frozenSpec: { schemaVersion: 1, kind: 'skill', title: '改进技能', objective: '改进证据覆盖',
      target: { type: 'skill', capabilityId: 'capability', baseContentHash: evolutionContentHash(baseline), sampleIds: ['sample'] },
      budget: { maxModelTokens: 100000, maxDurationSeconds: 600, maxRepairRounds: 0 } } } as ClaimedEvolutionRun
    const control = { identity: { runId: id, attempt: 1, leaseToken: 1, inputHash: run.inputHash }, signal: new AbortController().signal, assertCanContinue: async () => {} }
    const deps: Parameters<typeof createEvolutionSkillExecutor>[0] = {
      modelId: 'fixed', executionProfileHash: 'c'.repeat(64), environment: 'fixture', artifacts: store,
      authorize: async () => ({ version: current, authorizationHash }),
      runs: { transition: async () => {}, saveCheckpoint: async (_identity: unknown, value: Record<string, unknown>) => { checkpoints.push(value) }, bindExecutionProfile: async (_identity: unknown, hash: string) => { profiles.push(hash) },
        reserveModelCall: async () => { reserved++; return { mayInvoke: true, reservationId: randomUUID() } },
        settleModelCall: async () => { settled++; return { budgetExceeded: false } },
      } as Parameters<typeof createEvolutionSkillExecutor>[0]['runs'],
      candidates: { completeRun: async (_identity, input) => {
        commits++; assert.equal(input.baseRef, evolutionContentHash(baseline)); await store.verifyManifest(id, input.manifest)
        const patch = input.manifest.artifacts.find(artifact => artifact.kind === 'patch')!
        const comparison = previewEvolutionPatch(await store.read(id, patch), { patchHash: input.manifest.patchHash,
          sourceHash: input.manifest.sourceHash, baseRef: input.baseRef })
        assert.equal(comparison.changes[0].before?.text, 'baseline')
        assert.equal(comparison.changes[0].after?.text, 'candidate')
        return { id: 'candidate', contentHash: input.manifest.sourceHash, evaluationHash: evolutionContentHash(input.evaluation), status: 'awaiting_approval' }
      } },
      develop: async () => ({ text: JSON.stringify({ summary: '加强证据覆盖', instructions: 'candidate', references: [] }), totalTokens: 21 }),
      evaluate: async ({ baseline, candidate, sampleIds, control, budget }) => evaluateEvolutionSkill({ baseline, candidate, control, store,
        samples: sampleIds.map(id => ({ id, input: 'same input', materialHashes: ['d'.repeat(64)] })),
        runtime: { modelId: 'fixed', modelVersion: 'v1', promptHash: 'e'.repeat(64), rendererVersion: 'v1' }, suiteVersion: 'fixture-v1',
        metric: { name: 'coverage', direction: 'higher', minimumImprovement: 1 },
        run: async ({ skill }) => { await budget.reserveModelTokens(100); await budget.recordModelUsage(11, 100); return { content: Buffer.from(skill.instructions), contentType: 'text/plain' } },
        assess: async ({ output }) => ({ score: output.content.toString() === 'baseline' ? 1 : 2,
          checks: EVOLUTION_REQUIRED_CHECKS.skill.map(id => ({ id, verdict: failQuality && id === 'render' ? 'FAIL' : 'PASS', evidence: 'fixture measurement' })) }),
      }),
    }
    const prepared = await createEvolutionSkillExecutor(deps)(run, control)
    assert.equal(commits, 0); assert.equal(reserved, 3); assert.equal(settled, 3)
    assert.equal(profiles[0], evolutionContentHash({ executionProfileHash: deps.executionProfileHash,
      authorizationHash, baselineHash: evolutionContentHash(baseline) }))
    authorizationHash = '1'.repeat(64)
    await assert.rejects(prepared.commit(), { code: 'EVOLUTION_AUTHORIZATION_CHANGED' }); assert.equal(commits, 0)
    authorizationHash = 'f'.repeat(64)
    current = { ...baseline, instructions: 'changed baseline' }
    await assert.rejects(prepared.commit(), { code: 'EVOLUTION_DEVELOPER_BASELINE' }); assert.equal(commits, 0)
    current = baseline
    await prepared.commit(); assert.equal(commits, 1)
    assert.equal(checkpoints[0].baselineHash, evolutionContentHash(baseline))
    assert.equal(typeof checkpoints[0].candidateHash, 'string')
    failQuality = true
    await assert.rejects(createEvolutionSkillExecutor(deps)(run, control), { code: 'EVOLUTION_REPAIR_BUDGET_EXHAUSTED' })
    const failedCheckpoint = checkpoints.at(-1)!
    assert.equal((failedCheckpoint.evaluation as { verdict: string }).verdict, 'FAIL')
    const failedArtifacts = failedCheckpoint.artifacts as Parameters<AiEvolutionArtifactStore['verifyManifest']>[1]['artifacts']
    const savedFailure = JSON.parse((await store.read(id, failedArtifacts.find(row => row.kind === 'report')!)).toString())
    assert.equal(savedFailure.evaluation.verdict, 'FAIL')
    const checkpointInput = { runId: id, baselineHash: evolutionContentHash(baseline), checkpoint: failedCheckpoint }
    const preview = await readEvolutionSkillCheckpoint(checkpointInput, store)
    assert.equal(preview.comparison.samples[0].sides[1].checks.find(row => row.id === 'render')?.verdict, 'FAIL')
    assert.equal(JSON.stringify(preview.comparison).includes('storageKey'), false)
    await assert.rejects(readEvolutionSkillCheckpoint({ ...checkpointInput, expectedHash: '0'.repeat(64) }, store),
      { code: 'EVOLUTION_CHECKPOINT_CHANGED' })
    await assert.rejects(readEvolutionSkillCheckpoint({ ...checkpointInput, baselineHash: '0'.repeat(64) }, store),
      { code: 'EVOLUTION_EVALUATION_BINDING' })
    await assert.rejects(readEvolutionSkillCheckpoint({ ...checkpointInput, runId: randomUUID() }, store))
    await assert.rejects(readEvolutionSkillCheckpoint({ ...checkpointInput, checkpoint: null }, store),
      { code: 'EVOLUTION_REPORT_NOT_FOUND' })
    assert.equal(commits, 1)
    failQuality = false
    deps.develop = async () => ({ text: JSON.stringify({ summary: 'bad', instructions: 'candidate', references: [], toolPermissionHash: 'unauthorized' }), totalTokens: 1 })
    await assert.rejects(createEvolutionSkillExecutor(deps)(run, control))
    assert.equal(commits, 1)

    const beforeRevocation = settled
    deps.develop = async () => {
      authorizationHash = '2'.repeat(64)
      return { text: JSON.stringify({ summary: 'candidate', instructions: 'candidate', references: [] }), totalTokens: 21 }
    }
    await assert.rejects(createEvolutionSkillExecutor(deps)(run, control), { code: 'EVOLUTION_AUTHORIZATION_CHANGED' })
    assert.equal(settled, beforeRevocation + 1, 'returned usage must be recorded even if access changed during the call')
    assert.equal(commits, 1)

    deps.develop = async () => ({ text: JSON.stringify({ summary: 'candidate', instructions: 'candidate', references: [] }), totalTokens: 21 })
    const beforeComparison = reserved
    deps.evaluate = async ({ budget }) => {
      authorizationHash = '3'.repeat(64)
      await budget.reserveModelTokens(100)
      throw Error('revoked comparison should never reserve or invoke a model')
    }
    await assert.rejects(createEvolutionSkillExecutor(deps)(run, control), { code: 'EVOLUTION_AUTHORIZATION_CHANGED' })
    assert.equal(reserved, beforeComparison + 1, 'only development may reserve; revoked comparison cannot')
  } finally { await rm(root, { recursive: true, force: true }) }
})
