import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { z } from 'zod'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'
import { freezeEvolutionSkillSampleSuite, readEvolutionSkillSampleSuiteFile } from '../src/runtime/evolution/evolutionSkillSampleSuite.js'

test('host sample suite enforces actor binding, complete visible selection and mandatory hidden cases', async () => {
  const userId = randomUUID(), capabilityId = randomUUID()
  const config = { schemaVersion: 1, suiteId: 'fixture-v1', capabilityId, allowedUserIds: [userId],
    samples: [false, true].map(hidden => { const input = { text: hidden ? 'hidden hard case' : 'visible case' }; return {
      id: hidden ? 'hidden' : 'visible', hidden, input, inputHash: evolutionContentHash(input), materialHashes: ['a'.repeat(64)],
      rules: ['sources', 'required_fields', 'scope', 'regression'].map(gate => ({ id: gate, gate, text: 'expected', expectation: 'present', weight: 1 })) } }) }
  const parser = (input: unknown) => z.object({ text: z.string() }).strict().parse(input)
  const suite = freezeEvolutionSkillSampleSuite(config, parser)
  const actor = { userId, capabilityId, sampleIds: ['visible'] }
  const selected = suite.select(actor)
  assert.deepEqual(selected.samples.map(sample => sample.id), ['visible', 'hidden'])
  assert.equal(selected.assessment.samples.length, 2)
  config.samples[1].input.text = 'changed outside factory'
  selected.samples[1].input.text = 'changed returned copy'
  assert.equal(suite.select(actor).samples[1].input.text, 'hidden hard case')
  assert.throws(() => suite.select({ ...actor, sampleIds: [] }), { code: 'EVOLUTION_SAMPLE_SET_CHANGED' })
  assert.throws(() => suite.select({ ...actor, sampleIds: ['visible', 'hidden'] }), { code: 'EVOLUTION_SAMPLE_SET_CHANGED' })
  assert.throws(() => suite.select({ ...actor, userId: randomUUID() }), { code: 'EVOLUTION_SAMPLE_FORBIDDEN' })
  assert.throws(() => freezeEvolutionSkillSampleSuite(config, parser), { code: 'EVOLUTION_SAMPLE_SUITE_INVALID' })
  config.samples[1].input.text = 'hidden hard case'
  assert.throws(() => freezeEvolutionSkillSampleSuite(config, () => ({ text: 'silently normalized' })), { code: 'EVOLUTION_SAMPLE_SUITE_INVALID' })
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-sample-suite-'))
  try {
    const filename = path.join(root, 'suite.json')
    await writeFile(filename, JSON.stringify(config))
    assert.equal(freezeEvolutionSkillSampleSuite(await readEvolutionSkillSampleSuiteFile(filename), parser).profileHash, suite.profileHash)
    await writeFile(filename, Buffer.from([0xff, 0xfe]))
    await assert.rejects(readEvolutionSkillSampleSuiteFile(filename))
    await assert.rejects(readEvolutionSkillSampleSuiteFile('relative.json'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
