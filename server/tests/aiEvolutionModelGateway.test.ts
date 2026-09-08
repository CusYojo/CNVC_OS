import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEvolutionModelDeveloper } from '../src/runtime/evolution/evolutionModelGateway.js'
import type { EvolutionSpec } from '../src/contracts/aiEvolutionContract.js'

const route = { modelId: 'fixed-id', model: 'fixed-model', providerId: 'provider', baseUrl: 'https://example.test/v1', apiKey: 'test-credential', timeoutMs: 1000 }
const specification = { title: '修改', objective: '显示来源' } as EvolutionSpec

test('cancelled execution cannot invoke the model or fall back to another endpoint', async () => {
  const controller = new AbortController()
  let calls = 0
  const develop = createEvolutionModelDeveloper(route, async () => {
    calls++
    controller.abort(new Error('cancelled'))
    return new Response('', { status: 404 })
  })
  const input = { signal: controller.signal, modelId: route.modelId, specification, files: [], feedback: null, maxOutputTokens: 100 }
  await assert.rejects(develop(input), /cancelled/)
  assert.equal(calls, 1)
  await assert.rejects(develop(input), /cancelled/)
  assert.equal(calls, 1)
})

test('gateway preserves fixed model and actual usage; model gets text files but no credentials', async () => {
  let captured = ''
  const fetchImpl: typeof fetch = async (_url, init) => {
    captured = String(init?.body)
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-credential')
    return new Response(JSON.stringify({ output: [{ content: [{ text: JSON.stringify({ summary: '显示来源', changes: [{ path: 'src/page.ts', expectedSha256: null, content: 'export const name = "来源"' }] }) }] }], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } }), { status: 200 })
  }
  const develop = createEvolutionModelDeveloper(route, fetchImpl)
  const result = await develop({ modelId: route.modelId, specification, files: [], feedback: null, maxOutputTokens: 100 })
  assert.equal(result.totalTokens, 30)
  assert.equal(result.format, 'utf8-patch')
  assert.equal(JSON.parse(result.text).changes[0].content, 'export const name = "来源"')
  assert.equal(captured.includes(route.apiKey), false)
  assert.equal(JSON.parse(captured).model, 'fixed-model')
  await assert.rejects(develop({ modelId: 'changed', specification, files: [], feedback: null, maxOutputTokens: 100 }), { code: 'EVOLUTION_MODEL_CHANGED' })
})

test('missing provider usage remains unknown', async () => {
  const develop = createEvolutionModelDeveloper(route, async () => new Response(JSON.stringify({ output: [{ content: [{ text: JSON.stringify({ summary: '修改', changes: [{ path: 'src/a.ts', expectedSha256: null, content: '' }] }) }] }] }), { status: 200 }))
  const result = await develop({ modelId: route.modelId, specification, files: [], feedback: null, maxOutputTokens: 100 })
  assert.equal(result.totalTokens, null)
})
