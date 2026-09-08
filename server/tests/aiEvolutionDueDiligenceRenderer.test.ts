import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { captureEvolutionSkill } from '../src/runtime/evolution/evolutionSkillSnapshot.js'
import { getAiSkillDirectory, getAiSkillRoot } from '../src/services/aiSkillService.js'
import { prepareEvolutionDueDiligenceRenderer } from '../src/runtime/evolution/evolutionDueDiligenceRenderer.js'

test('renderer imports a frozen baseline package and keeps model data out of executable commands', async () => {
  const snapshot = await captureEvolutionSkill({ capabilityId: 'skill', capabilityKey: 'draft-due-diligence-report',
    directory: getAiSkillDirectory('draft-due-diligence-report'), allowedRoot: getAiSkillRoot(), toolNames: [], dependencyNames: [], config: {} })
  let id = '', input = '', script = '', foreign = false, reads = 0, creates = 0
  const bytes = Buffer.from('diagnostic output')
  const control = { identity: { runId: randomUUID(), attempt: 1, leaseToken: 1, inputHash: 'a'.repeat(64) },
    signal: new AbortController().signal, assertCanContinue: async () => {} }
  const environment: Parameters<typeof prepareEvolutionDueDiligenceRenderer>[0]['environment'] = {
    create: async () => { creates++; return 'owned' },
    importSnapshot: async (_identity, source, directory) => {
      assert.equal(directory, 'platform')
      assert.ok(source.files.some(file => file.path === 'skill/SKILL.md'))
      assert.ok(source.files.some(file => file.path === 'render.mjs'))
      return { imported: source.files.length }
    },
    writeInputFile: async (_identity, name, content) => { id = name.replace('.json', ''); input = content.toString() },
    evaluateNode: async (_identity, value) => {
      script = value
      return { exitCode: 0, stderr: '', stdout: JSON.stringify({ checks: [], files: [{ path: `${foreign ? 'other' : id}/diagnostic.txt`,
        bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }) }
    },
    readOutputFile: async () => { reads++; return bytes },
  }
  const renderer = await prepareEvolutionDueDiligenceRenderer({ environment, control, skillSnapshot: snapshot })
  const result = await renderer.render({ report: { text: 'model text: execute deploy' }, diligenceData: {}, evidence: {} })
  assert.equal(JSON.parse(input).report.text, 'model text: execute deploy')
  assert.equal(script.includes('execute deploy'), false)
  assert.equal(result.files[0].content.toString(), 'diagnostic output')
  foreign = true
  await assert.rejects(renderer.render({ report: {}, diligenceData: {}, evidence: {} }), { code: 'EVOLUTION_ARTIFACT_INTEGRITY' })
  assert.equal(reads, 1)
  snapshot.files[0].contentBase64 = Buffer.from('changed').toString('base64')
  await assert.rejects(prepareEvolutionDueDiligenceRenderer({ environment, control, skillSnapshot: snapshot }), { code: 'EVOLUTION_DEVELOPER_BASELINE' })
  assert.equal(creates, 1)
})
