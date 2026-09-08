import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEvolutionSkillModelDeveloper } from '../src/runtime/evolution/evolutionSkillModelGateway.js'
import type { EvolutionSpec } from '../src/contracts/aiEvolutionContract.js'

const route = { modelId: 'fixed', model: 'skill-developer', providerId: 'provider', baseUrl: 'https://example.test/v1', apiKey: 'fixture-secret', timeoutMs: 1000 }
const skill = { capabilityId: 'capability', instructions: 'original', references: [], dependencies: [], toolPermissionHash: 'a'.repeat(64) }
const spec = { kind: 'skill', target: { type: 'skill', capabilityId: 'capability' } } as EvolutionSpec
test('skill developer freezes routing, keeps credentials out of content and preserves usage before parsing', async () => {
  const mutable = { ...route }
  const { develop, profileHash } = createEvolutionSkillModelDeveloper(mutable, async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, 'skill-developer')
    assert.equal(String(init?.body).includes('fixture-secret'), false)
    assert.ok(String(init?.body).includes('不能改变权限或验收标准'))
    return new Response(JSON.stringify({ output: [{ content: [{ text: 'invalid candidate JSON' }] }], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } }))
  })
  mutable.model = 'changed'
  const result = await develop({ spec, skill, feedback: null, signal: new AbortController().signal, maxOutputTokens: 100 })
  assert.equal(result.totalTokens, 30)
  assert.equal(result.text, 'invalid candidate JSON')
  assert.notEqual(profileHash, createEvolutionSkillModelDeveloper(mutable).profileHash)
})
test('invalid skill bindings and cancellation prevent any model call', async () => {
  let calls = 0
  const { develop } = createEvolutionSkillModelDeveloper(route, async () => { calls++; throw Error('must not call') })
  const controller = new AbortController()
  const input = { spec, skill, feedback: null, signal: controller.signal, maxOutputTokens: 100 }
  await assert.rejects(develop({ ...input, skill: { ...skill, capabilityId: 'other' } }), { code: 'EVOLUTION_EXECUTOR_KIND' })
  controller.abort(Error('cancelled'))
  await assert.rejects(develop(input), /cancelled/)
  assert.equal(calls, 0)
})
