import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { parseEvolutionHostConfig } from '../src/runtime/evolution/evolutionHostConfig.js'
import { parseEvolutionSkillHostConfig } from '../src/runtime/evolution/evolutionSkillHostConfig.js'

const config = { schemaVersion: 1, image: `sha256:${'a'.repeat(64)}`, modelId: '00000000-0000-4000-8000-000000000001',
  browserModulePath: path.resolve('browser-runtime'), suiteVersion: 'reviewed-v1', functionalGate: { file: 'leadFacts.test.ts', minimumTests: 1 } }

test('host requires immutable image and fixed gate filename without weakening minimum test count', () => {
  assert.equal(parseEvolutionHostConfig(config).browserChannel, 'chromium')
  for (const value of [
    { ...config, image: 'node:latest' },
    { ...config, browserModulePath: './runtime' },
    { ...config, functionalGate: { file: '../candidate.test.ts', minimumTests: 1 } },
    { ...config, functionalGate: { file: 'leadFacts.test.ts', minimumTests: 0 } },
    { ...config, command: 'arbitrary candidate command' },
  ]) assert.throws(() => parseEvolutionHostConfig(value))
})

test('skill host accepts only fixed image, model, capability and complete host sample configuration', () => {
  const skill = { schemaVersion: 1, image: config.image, modelId: config.modelId, capabilityId: config.modelId,
    sampleSuiteFile: path.resolve('host-samples.json'), maxOutputTokens: 16000,
    metric: { name: 'coverage', direction: 'higher', minimumImprovement: 1 } }
  assert.deepEqual(parseEvolutionSkillHostConfig(skill), skill)
  for (const input of [{ ...skill, image: 'node:latest' }, { ...skill, sampleSuiteFile: './samples.json' },
    { ...skill, maxOutputTokens: 0 }, { ...skill, capabilityId: 'unregistered' },
    { ...skill, metric: { ...skill.metric, minimumImprovement: 0 } }, { ...skill, command: 'candidate-script' }]) {
    assert.throws(() => parseEvolutionSkillHostConfig(input))
  }
})
