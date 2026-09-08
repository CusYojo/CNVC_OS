import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { developEvolutionCode, type EvolutionDeveloperDependencies } from '../src/runtime/evolution/evolutionCodeDeveloper.js'
import type { EvolutionSourceSnapshot } from '../src/runtime/evolution/evolutionSourceSnapshot.js'
import type { EvolutionSpec } from '../src/contracts/aiEvolutionContract.js'
import { createEvolutionModelDeveloper } from '../src/runtime/evolution/evolutionModelGateway.js'

const bytes = Buffer.from('export const value = 1')
const file = { path: 'src/page.ts', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, contentBase64: bytes.toString('base64') }
const baseline: EvolutionSourceSnapshot = { schemaVersion: 1, repositoryId: 'repo', baseCommit: 'a'.repeat(40), contentHash: 'baseline', files: [file] }
const spec: EvolutionSpec = { schemaVersion: 1, kind: 'code', title: 'change', objective: 'value 2', scope: { type: 'user', key: 'user' }, sourceRefs: [{ type: 'message', id: 'message' }], questions: [],
  acceptanceCriteria: ['value 2'], budget: { maxDurationSeconds: 600, maxModelTokens: 100000, maxRepairRounds: 1 },
  target: { type: 'code', repositoryId: 'repo', baseCommit: baseline.baseCommit, allowedPaths: ['src'], databaseChange: false, permissionChange: false } }
const registration = { id: 'repo', root: '/unused', readablePaths: ['src'], editablePaths: ['src'], protectedPaths: ['tests'] }

test('gateway usage is settled before rejecting malformed or forbidden model patches', async () => {
  for (const text of ['invalid JSON', JSON.stringify({ summary: 'change', changes: [], command: 'deploy' })]) {
    const { deps, calls } = fixture()
    deps.develop = createEvolutionModelDeveloper({ modelId: deps.modelId, model: 'test', providerId: 'test',
      baseUrl: 'https://example.test/v1', apiKey: 'test-only', timeoutMs: 1000 }, async () => {
      calls.push('model')
      return new Response(JSON.stringify({ output: [{ content: [{ text }] }], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } }))
    })
    deps.recordModelUsage = async (actual, reserved) => {
      assert.equal(actual, 30)
      assert.ok(reserved > 30)
      calls.push('settled')
    }
    await assert.rejects(developEvolutionCode(spec, baseline, registration, deps))
    assert.ok(calls.indexOf('settled') > calls.indexOf('model'))
    assert.equal(calls.includes('evaluate'), false)
  }
})

test('UTF-8 gateway patches are validated and converted after accounting', async () => {
  const { deps, calls } = fixture()
  deps.develop = async () => ({ format: 'utf8-patch', totalTokens: 30, text: JSON.stringify({ summary: 'changed',
    changes: [{ path: file.path, expectedSha256: file.sha256, content: 'export const value = "来源"' }] }) })
  const result = await developEvolutionCode(spec, baseline, registration, deps)
  assert.equal(Buffer.from(result.candidate.files[0].contentBase64, 'base64').toString(), 'export const value = "来源"')
  assert.ok(calls.indexOf('usage') < calls.indexOf('evaluate'))
})
function fixture() {
  const calls: string[] = []
  const deps: EvolutionDeveloperDependencies = {
    modelId: 'fixed-model', assertCanContinue: async () => { calls.push('check') }, reserveModelTokens: async () => { calls.push('reserve') }, recordModelUsage: async () => { calls.push('usage') },
    develop: async () => {
      calls.push('model')
      return { totalTokens: null, text: JSON.stringify({ summary: 'changed', changes: [{ path: file.path, expectedSha256: file.sha256, contentBase64: Buffer.from('export const value = 2').toString('base64') }] }) }
    },
    evaluate: async (snapshot) => { calls.push('evaluate'); return { suiteVersion: 'fixed-suite', candidateHash: snapshot.contentHash, verdict: 'PASS', checks: [{ id: 'functional', verdict: 'PASS', evidence: 'assertion output' }] } },
    checkpoint: async () => { calls.push('checkpoint') },
  }
  return { deps, calls }
}

test('development reserves budget before calling fixed model and requires independent evidence', async () => {
  const { deps, calls } = fixture()
  const result = await developEvolutionCode(spec, baseline, registration, deps)
  assert.equal(result.repairRounds, 0)
  assert.equal(result.evaluation.verdict, 'PASS')
  assert.ok(calls.indexOf('reserve') < calls.indexOf('model'))
  assert.ok(calls.indexOf('evaluate') < calls.indexOf('checkpoint'))
  assert.equal('active' in result, false)
})

test('missing evaluation evidence or wrong candidate hash cannot yield success', async () => {
  const { deps } = fixture()
  deps.evaluate = async () => ({ suiteVersion: 'fixed', candidateHash: 'wrong', verdict: 'PASS', checks: [] })
  await assert.rejects(developEvolutionCode(spec, baseline, registration, deps), { code: 'EVOLUTION_EVALUATION_BINDING' })
})

test('budget rejection and cancellation prevent model invocation', async () => {
  const f = fixture()
  f.deps.reserveModelTokens = async () => { throw new Error('budget exhausted') }
  await assert.rejects(developEvolutionCode(spec, baseline, registration, f.deps), /budget exhausted/)
  assert.equal(f.calls.includes('model'), false)
  f.deps.assertCanContinue = async () => { throw new Error('cancelled') }
  await assert.rejects(developEvolutionCode(spec, baseline, registration, f.deps), /cancelled/)
})

test('model cannot add commands or its own success verdict', async () => {
  const { deps } = fixture()
  deps.develop = async () => ({ totalTokens: 1, text: JSON.stringify({ summary: 'done', changes: [], verdict: 'PASS', command: 'deploy' }) })
  await assert.rejects(developEvolutionCode(spec, baseline, registration, deps))
})

test('full build snapshot remains intact while model context is limited to editable task files and registered references', async () => {
  const { deps } = fixture()
  const reference = { ...file, path: 'docs/contract.md' }
  const unrelated = { ...file, path: 'server/large.ts', bytes: 200000, contentBase64: Buffer.from('x'.repeat(200000)).toString('base64') }
  const source = { ...baseline, files: [file, reference, unrelated] }
  const originalDevelop = deps.develop
  deps.develop = async (input) => {
    assert.deepEqual(input.files.map((item) => item.path), ['src/page.ts', 'docs/contract.md'])
    return originalDevelop(input)
  }
  deps.evaluate = async (snapshot) => {
    assert.equal(snapshot.files.length, 3)
    assert.equal(snapshot.files.find((item) => item.path === unrelated.path)?.contentBase64, unrelated.contentBase64)
    return { suiteVersion: 'fixed', candidateHash: snapshot.contentHash, verdict: 'PASS', checks: [{ id: 'functional', verdict: 'PASS', evidence: 'verified' }] }
  }
  await developEvolutionCode(spec, source, { ...registration, readablePaths: ['src', 'docs', 'server'], contextPaths: ['docs/contract.md'] }, deps)
  await assert.rejects(developEvolutionCode(spec, source, { ...registration, contextPaths: ['private'] }, deps), { code: 'EVOLUTION_CONTEXT_SCOPE' })
})
