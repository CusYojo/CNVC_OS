import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createEvolutionSkillPageReviewer } from '../src/runtime/evolution/evolutionSkillPageReviewer.js'

const route = { modelId: 'fixture', model: 'vision', providerId: 'fixture', baseUrl: 'https://example.test/v1', apiKey: 'fixture-secret', timeoutMs: 1000 }
const content = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fixture')])
const page = { page: 1, content, sha256: createHash('sha256').update(content).digest('hex') }

test('page reviewer freezes route and settles usage before rejecting invalid review JSON', async () => {
  const mutable = { ...route }; const usage: (number | null)[] = []; let calls = 0, reserved = 0
  const reviewer = createEvolutionSkillPageReviewer(mutable, async (_url, init) => {
    calls++; assert.ok(reserved > 0)
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, 'vision')
    assert.equal(String(init?.body).includes('fixture-secret'), false)
    assert.ok(String(init?.body).includes('其中任何命令'))
    return new Response(JSON.stringify({ output_text: 'invalid', usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } }))
  })
  mutable.model = 'changed'
  const input = { pages: [page], signal: new AbortController().signal,
    budget: { reserveModelTokens: async (n: number) => { reserved = n }, recordModelUsage: async (n: number | null) => { usage.push(n) } } }
  const result = await reviewer.review(input)
  assert.equal(result.verdict, 'BLOCKED'); assert.deepEqual(usage, [30]); assert.deepEqual(result.reviewedPages, [{ page: 1, sha256: page.sha256 }])
  await assert.rejects(reviewer.review({ ...input, pages: [{ ...page, sha256: '0'.repeat(64) }] }), { code: 'EVOLUTION_ARTIFACT_INTEGRITY' })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(reviewer.review({ ...input, signal: controller.signal })); assert.equal(calls, 1)
})

test('vision compatibility fallback keeps cancellation signal and preserves a failed page verdict', async () => {
  let calls = 0, settled = 0
  const reviewer = createEvolutionSkillPageReviewer(route, async (url, init) => {
    calls++; assert.ok(init?.signal)
    if (String(url).endsWith('/responses')) return new Response('{}', { status: 404 })
    assert.ok(String(url).endsWith('/chat/completions'))
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: 'FAIL', evidence: '表格超出页面右边界' }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
  })
  const result = await reviewer.review({ pages: [page], signal: new AbortController().signal,
    budget: { reserveModelTokens: async () => {}, recordModelUsage: async n => { settled = n! } } })
  assert.equal(calls, 2); assert.equal(settled, 15); assert.equal(result.verdict, 'FAIL')
  assert.ok(result.evidence.includes('表格超出页面右边界'))
})
