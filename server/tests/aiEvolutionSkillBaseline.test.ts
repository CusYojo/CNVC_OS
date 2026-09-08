import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEvolutionSkillBaselineLoader } from '../src/services/aiEvolutionSkillBaseline.js'
import type { AiCapabilityRecord } from '../src/repositories/aiConfigurationRepository.js'

function fixture() {
  const capability = { id: 'skill', kind: 'skill', source: 'uploaded', capabilityKey: 'uploaded-skill', version: 2,
    enabled: true, allowedRoles: [], config: { runtime: 'uploaded-skill', instructions: 'Write sourced facts.' },
    toolNames: [], dependencyNames: [], packageVersion: '1', createdAt: new Date(), updatedAt: new Date() } as unknown as AiCapabilityRecord
  const grant = { capabilityId: capability.id, capabilityKey: capability.capabilityKey, source: capability.source,
    capabilityRevision: 2, grantRevision: 1, authorizationHash: 'a'.repeat(64) }
  return { capability, grant }
}

test('uploaded baseline freezes actual capability content separately from concurrency and grant versions', async () => {
  const { capability, grant } = fixture()
  const load = createEvolutionSkillBaselineLoader({ registry: { resolve: async () => grant }, capability: async () => capability })
  const baseline = await load('user', 'skill')
  assert.equal(baseline.version.instructions, capability.config.instructions)
  assert.equal(baseline.capabilityRevision, 2)
  assert.equal(baseline.grantRevision, 1)
  capability.config.instructions = 'New rule.'
  assert.equal(baseline.version.instructions, 'Write sourced facts.')
  assert.notEqual((await load('user', 'skill')).contentHash, baseline.contentHash)
  grant.authorizationHash = 'b'.repeat(64)
  assert.notEqual((await load('user', 'skill')).authorizationHash, baseline.authorizationHash)
})

test('baseline loading rejects changed grants, extra execution configuration and changed capability content', async () => {
  const { capability, grant } = fixture()
  let reads = 0
  const load = createEvolutionSkillBaselineLoader({ registry: { resolve: async () => grant }, capability: async () => {
    if (++reads === 2) capability.config.instructions = 'changed during read'
    return capability
  } })
  await assert.rejects(load('user', 'skill'), { code: 'EVOLUTION_AUTHORIZATION_CHANGED' })
  capability.config.command = 'deploy'
  await assert.rejects(createEvolutionSkillBaselineLoader({ registry: { resolve: async () => grant }, capability: async () => capability })('user', 'skill'))
  delete capability.config.command
  capability.toolNames = ['shell']
  await assert.rejects(createEvolutionSkillBaselineLoader({ registry: { resolve: async () => grant }, capability: async () => capability })('user', 'skill'), { code: 'EVOLUTION_SEPARATE_REVIEW_REQUIRED' })
})
