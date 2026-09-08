import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createEvolutionCodeExecutor } from '../src/runtime/evolution/evolutionCodeExecutor.js'
import type { ClaimedEvolutionRun } from '../src/runtime/evolution/evolutionRunCoordinator.js'
import { EVOLUTION_REQUIRED_CHECKS } from '../src/contracts/aiEvolutionEvaluationContract.js'

test('executor uses committed sources, persists accounting and defers success to coordinator commit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-executor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
  git('init', '--quiet')
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src/page.ts'), 'export const value = 1\n')
  git('add', 'src/page.ts')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--quiet', '-m', 'baseline')
  const baseCommit = git('rev-parse', 'HEAD').trim()
  await writeFile(path.join(root, 'src/page.ts'), 'uncommitted changes')
  const run = { id: 'run', attempt: 1, leaseToken: 1, repairRounds: 0, inputHash: 'hash', frozenSpec: {
    schemaVersion: 1, kind: 'code', title: 'change', objective: 'value 2', scope: { type: 'user', key: 'user' },
    sourceRefs: [], questions: [], acceptanceCriteria: ['value 2'],
    budget: { maxDurationSeconds: 600, maxModelTokens: 100000, maxRepairRounds: 1 },
    target: { type: 'code', repositoryId: 'repo', baseCommit, allowedPaths: ['src'], databaseChange: false, permissionChange: false },
  } } as ClaimedEvolutionRun
  const calls: string[] = []
  let incomplete = false
  const deps: Parameters<typeof createEvolutionCodeExecutor>[0] = {
    artifacts: {
      verifyManifest: async (runId, manifest) => { assert.equal(runId, 'run'); assert.ok(manifest.artifacts.some((item) => item.kind === 'patch')); calls.push('verify-artifacts') },
      put: async (_runId, content, kind) => ({ storageKey: 'patch.bin', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), kind }),
    },
    modelId: 'fixed-model',
    executionProfileHash: 'f'.repeat(64),
    authorize: async () => { calls.push('authorize'); return { id: 'repo', root, readablePaths: ['src'], editablePaths: ['src'], protectedPaths: [] } },
    runs: {
      bindExecutionProfile: async (_identity, hash) => { assert.equal(hash, 'f'.repeat(64)) },
      transition: async (_identity, status) => { calls.push(status) },
      saveCheckpoint: async (_identity, checkpoint, rounds) => { assert.equal(rounds, 0); assert.ok(checkpoint.candidateHash); calls.push('checkpoint') },
      reserveModelCall: async () => { calls.push('reserve'); return { mayInvoke: true, reservationId: 'reservation' } },
      settleModelCall: async (_identity, _reservation, usage) => { assert.equal(usage, 123); calls.push('settle'); return { budgetExceeded: false } },
    } as Parameters<typeof createEvolutionCodeExecutor>[0]['runs'],
    develop: async ({ files }) => {
      calls.push('model')
      assert.equal(Buffer.from(files[0].contentBase64, 'base64').toString(), 'export const value = 1\n')
      return { totalTokens: 123, text: JSON.stringify({ summary: 'changed', changes: [{ path: files[0].path,
        expectedSha256: files[0].sha256, contentBase64: Buffer.from('export const value = 2\n').toString('base64') }] }) }
    },
    evaluate: async (snapshot, _control, patchHash) => ({
      evaluation: { suiteVersion: 'test-suite', candidateHash: snapshot.contentHash, verdict: 'PASS',
        checks: (incomplete ? ['build'] : EVOLUTION_REQUIRED_CHECKS.code).map((id) => ({ id, verdict: 'PASS', evidence: 'fixture evidence' })) },
      manifest: { schemaVersion: 1, sourceHash: snapshot.contentHash, patchHash, dependencyLockHash: 'b'.repeat(64), environment: 'test', artifacts: [] },
    }),
    candidates: { completeRun: async (_identity, input) => {
      assert.equal(input.baseRef, baseCommit)
      calls.push('commit')
      return { id: 'candidate', contentHash: 'hash', evaluationHash: 'hash', status: 'awaiting_approval' }
    } },
  }
  const control = { signal: new AbortController().signal, identity: { runId: run.id, attempt: 1, leaseToken: 1, inputHash: run.inputHash }, assertCanContinue: async () => {} }
  const execute = createEvolutionCodeExecutor(deps)
  const prepared = await execute(run, control)
  assert.deepEqual(calls, ['authorize', 'executing', 'reserve', 'model', 'settle', 'checkpoint', 'verify-artifacts', 'evaluating'])
  await prepared.commit()
  assert.deepEqual(calls.slice(-3), ['authorize', 'verify-artifacts', 'commit'])
  calls.length = 0
  incomplete = true
  await assert.rejects(execute(run, control), { code: 'EVOLUTION_EVALUATION_INCOMPLETE' })
  assert.equal(calls.includes('commit'), false)
})
