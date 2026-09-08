import test from 'node:test'
import assert from 'node:assert/strict'
import { assertEvolutionSkillRuntimePermissions } from '../src/services/aiEvolutionSkillRuntimePolicy.js'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'

test('frozen content cannot retain revoked tools or changed dependency permissions', () => {
  const current = { id: 'capability', kind: 'skill', enabled: true, toolNames: ['read'], dependencyNames: ['renderer'], config: { write: false } }
  const version = { capabilityId: current.id, instructions: 'frozen instructions', references: [],
    dependencies: [{ name: 'capability-dependencies', contentHash: evolutionContentHash(current.dependencyNames) }],
    toolPermissionHash: evolutionContentHash({ toolNames: current.toolNames, config: current.config }) }
  assert.doesNotThrow(() => assertEvolutionSkillRuntimePermissions(version, current))
  for (const change of [{ toolNames: [] }, { toolNames: ['read', 'write'] }, { dependencyNames: ['other'] },
    { config: { write: true } }, { enabled: false }, { id: 'foreign' }]) {
    assert.throws(() => assertEvolutionSkillRuntimePermissions(version, { ...current, ...change }), { code: 'EVOLUTION_SKILL_PERMISSIONS_CHANGED' })
  }
  assert.throws(() => assertEvolutionSkillRuntimePermissions({ ...version, dependencies: [] }, current), { code: 'EVOLUTION_SKILL_PERMISSIONS_CHANGED' })
})
