import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAiExperienceModelChecker } from '../src/services/aiExperienceModelChecker.js'
import { checkAiExperienceOutput } from '../src/services/aiExperienceOutputCheck.js'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'

const route = { modelId: 'reviewer-id', model: 'reviewer', providerId: 'provider', apiKey: 'test-secret', baseUrl: 'https://example.test/v1', timeoutMs: 1000 }
test('model checker keeps fixed instructions and routing, accounts usage and feeds bound output evidence', async () => {
  const reservations: number[] = [], usages: (number | null)[] = []
  const checker = createAiExperienceModelChecker(route, { reserveModelTokens: async n => { reservations.push(n) }, recordModelUsage: async n => { usages.push(n) } }, async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, 'reviewer')
    assert.equal(String(init?.body).includes('test-secret'), false)
    assert.ok(String(init?.body).includes('不可信资料'))
    return new Response(JSON.stringify({ output: [{ content: [{ text: JSON.stringify({ checks: [{ versionId: 'version', verdict: 'PASS', explanation: '包含证据缺口标注', excerpts: ['尚无证据'] }] }) }] }], usage: { input_tokens: 30, output_tokens: 20, total_tokens: 50 } }))
  })
  const snapshot = { schemaVersion: 1, taskType: 'chat', businessProjectId: null, excluded: [],
    loaded: [{ versionId: 'version', experienceId: 'experience', contentHash: 'hash', rule: '标明证据缺口', exceptions: [] }] }
  const result = await checkAiExperienceOutput({ ...checker, snapshot, snapshotHash: evolutionContentHash(snapshot), output: '尚无证据', assertAuthorized: async () => {} })
  assert.equal(result.verdict, 'PASS')
  assert.equal(reservations.length, 1)
  assert.deepEqual(usages, [50])
  assert.equal(result.checkerVersion, checker.checkerVersion)
})

test('oversized or cancelled checks make no calls; unknown usage is never converted to zero', async () => {
  let calls = 0, reserves = 0
  const usage: (number | null)[] = []
  const checker = createAiExperienceModelChecker(route, { reserveModelTokens: async () => { reserves++ }, recordModelUsage: async n => { usage.push(n) } }, async () => {
    calls++
    return new Response(JSON.stringify({ output: [{ content: [{ text: '{"checks":[]}' }] }] }))
  })
  await assert.rejects(checker.assess({ rules: [], output: 'x'.repeat(48_001) }), { code: 'EVOLUTION_CONTEXT_BUDGET' })
  const controller = new AbortController(); controller.abort(Error('cancelled'))
  await assert.rejects(checker.assess({ rules: [], output: '', signal: controller.signal }), /cancelled/)
  assert.equal(calls, 0); assert.equal(reserves, 0)
  await checker.assess({ rules: [], output: '' })
  assert.deepEqual(usage, [null])
})
