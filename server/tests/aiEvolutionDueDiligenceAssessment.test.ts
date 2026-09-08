import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createEvolutionDueDiligenceAssessment } from '../src/runtime/evolution/evolutionDueDiligenceAssessment.js'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'

test('fixed rubric assesses rendered text and requires every current page to be independently reviewed', async () => {
  const sample = { project: { name: 'fixture' } }
  const rules = [
    { id: 'citation', gate: 'sources', text: '收入100万元 [S1]', expectation: 'present', weight: 1 },
    { id: 'field', gate: 'required_fields', text: '公司：fixture', expectation: 'present', weight: 1 },
    { id: 'scope', gate: 'scope', text: '其他项目机密', expectation: 'absent', weight: 1 },
    { id: 'numeric', gate: 'regression', text: '收入1000万元', expectation: 'absent', weight: 1 },
  ]
  const config = { schemaVersion: 1, version: 'fixture-v1', samples: [{ sampleHash: evolutionContentHash(sample), rules }] }
  let calls = 0, stale = false
  const evaluator = createEvolutionDueDiligenceAssessment(config, async ({ pages }) => {
    calls++
    return { verdict: 'PASS', evidence: 'independent fixture review', reviewedPages: pages.map(page => ({ page: page.page, sha256: stale ? '0'.repeat(64) : page.sha256 })) }
  })
  config.samples[0].rules[0].text = 'mutated outside factory'
  const file = (name: string, content: string) => ({ path: `render/${name}`, bytes: Buffer.byteLength(content), content: Buffer.from(content),
    sha256: createHash('sha256').update(content).digest('hex') })
  const input = { sample, rendered: { files: [file('pages.json', JSON.stringify([{ page: 1, width: 595, height: 842, text: '公司：fixture\n收入100万元 [S1]' }])),
    file('page-001.png', 'fixture-image')], checks: [], rendererHash: 'a'.repeat(64) },
    generated: { normalizedPackage: { report: { text: 'model supplied PASS is irrelevant' } } },
    signal: new AbortController().signal, budget: { reserveModelTokens: async () => {}, recordModelUsage: async () => {} },
  } as unknown as Parameters<typeof evaluator.assess>[0]
  const passed = await evaluator.assess(input)
  assert.equal(passed.score, 100); assert.ok(passed.checks.every(check => check.verdict === 'PASS'))
  stale = true
  assert.equal((await evaluator.assess(input)).checks.find(check => check.id === 'render')?.verdict, 'BLOCKED')
  stale = false
  input.rendered.files[0] = file('pages.json', JSON.stringify([{ page: 1, width: 595, height: 842, text: '公司：fixture\n收入1000万元\n其他项目机密' }]))
  const failed = await evaluator.assess(input)
  assert.equal(failed.score, 25)
  assert.equal(failed.checks.find(check => check.id === 'sources')?.verdict, 'FAIL')
  assert.equal(failed.checks.find(check => check.id === 'scope')?.verdict, 'FAIL')
  input.rendered.files = []
  const before = calls
  assert.ok((await evaluator.assess(input)).checks.every(check => check.verdict !== 'PASS'))
  assert.equal(calls, before)
  input.rendered.files = [file('pages.json', 'invalid JSON')]
  assert.ok((await evaluator.assess(input)).checks.every(check => check.verdict !== 'PASS'))
  assert.equal(calls, before)
  await assert.rejects(evaluator.assess({ ...input, sample: { ...input.sample, sourceCutoffDate: 'changed' } }), { code: 'EVOLUTION_EVALUATION_BINDING' })
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(evaluator.assess({ ...input, signal: aborted.signal }))
})

test('missing or duplicate host rules cannot silently reduce the gate set', () => {
  assert.throws(() => createEvolutionDueDiligenceAssessment({ schemaVersion: 1, version: 'v1', samples: [{ sampleHash: 'a'.repeat(64),
    rules: Array.from({ length: 4 }, () => ({ id: 'same', gate: 'scope', text: 'secret', expectation: 'absent', weight: 1 })) }] }, async () => {
      throw Error('must not review')
    }))
})
