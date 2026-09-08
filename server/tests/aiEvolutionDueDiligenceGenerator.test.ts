import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEvolutionDueDiligenceGenerator } from '../src/runtime/evolution/evolutionDueDiligenceGenerator.js'
import { buildDueDiligencePackageModelInput } from '../src/services/aiDueDiligencePackage.js'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'

const route = { modelId: 'fixed-id', model: 'fixed-model', providerId: 'provider', baseUrl: 'https://example.test/v1', apiKey: 'test-secret', timeoutMs: 1000 }
const sample: Parameters<typeof buildDueDiligencePackageModelInput>[0] = {
  project: { name: '测试项目', companyName: '测试公司' }, sourceCutoffDate: '2026-09-07', diligenceScope: {}, sectionTitles: [],
  content: { title: '尽调', executiveSummary: '客户收入待核验', sections: [], highlights: [], risks: [], missing: ['客户合同'] },
  evidence: { project: { name: '测试项目', legal_entity: '测试公司', cutoff_date: '2026-09-07', currency: 'CNY' }, facts: [] },
}
const skill = { capabilityId: 'skill', instructions: '明确区分事实与资料缺口', references: [{ name: 'evidence.md', content: '资料不能替代来源验证' }],
  dependencies: [], toolPermissionHash: 'a'.repeat(64) }

test('comparison generation uses the actual report contract, frozen routing and metered raw evidence without claiming acceptance', async () => {
  const events: string[] = []
  let body: Record<string, unknown> = {}
  const localRoute = { ...route }
  const generator = createEvolutionDueDiligenceGenerator(localRoute, async (_url, init) => {
    events.push('model'); body = JSON.parse(String(init?.body))
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-secret')
    return new Response(JSON.stringify({ output: [{ content: [{ text: JSON.stringify({ reportMode: 'screening_public',
      blockedReasons: ['缺少客户合同'], diligenceData: {}, report: {} }) }] }], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } }))
  })
  localRoute.model = 'changed'
  const output = await generator.generate({ sample, skill, signal: new AbortController().signal, maxOutputTokens: 1000,
    budget: { reserveModelTokens: async amount => { assert.ok(amount > 1000); events.push('reserve') },
      recordModelUsage: async amount => { assert.equal(amount, 30); events.push('settle') } } })
  assert.deepEqual(events, ['reserve', 'model', 'settle'])
  assert.equal(body.model, 'fixed-model')
  assert.equal(JSON.stringify(body).includes(route.apiKey), false)
  assert.ok(JSON.stringify(body).includes('明确区分事实与资料缺口'))
  const result = JSON.parse(output.content.toString())
  assert.equal(result.skillHash, evolutionContentHash(skill))
  assert.equal(result.sampleHash, evolutionContentHash(sample))
  assert.deepEqual(result.blockedReasons, ['缺少客户合同'])
  assert.equal(result.normalizedPackage.report.meta.legal_entity, '测试公司')
  assert.equal(result.rawPackage.report.meta, undefined)
  assert.equal('verdict' in result, false)
})

test('bad model output still settles usage while oversized or cancelled comparisons never call', async () => {
  let calls = 0, settled = 0
  const generator = createEvolutionDueDiligenceGenerator(route, async () => {
    calls++
    return new Response(JSON.stringify({ output: [{ content: [{ text: 'invalid JSON' }] }] }))
  })
  const input = { sample, skill, signal: new AbortController().signal, maxOutputTokens: 1000,
    budget: { reserveModelTokens: async () => {}, recordModelUsage: async (tokens: number | null) => { assert.equal(tokens, null); settled++ } } }
  await assert.rejects(generator.generate(input))
  assert.equal(calls, 1); assert.equal(settled, 1)
  await assert.rejects(generator.generate({ ...input, sample: { ...sample, content: { ...sample.content, executiveSummary: 'x'.repeat(90_001) } } }), { code: 'EVOLUTION_CONTEXT_BUDGET' })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(generator.generate({ ...input, signal: controller.signal }))
  assert.equal(calls, 1)
})
