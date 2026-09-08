import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { captureEvolutionSkill } from '../src/runtime/evolution/evolutionSkillSnapshot.js'
import { AI_TEMPLATE_DRIVEN_SKILL_NAME, getAiSkillDirectory, getAiSkillRoot } from '../src/services/aiSkillService.js'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'
import { loadEvolutionSkill } from '../src/services/aiEvolutionLoadedSkill.js'

test('uploaded-template skill loads frozen instructions and rejects a foreign or corrupted package', async () => {
  const name = AI_TEMPLATE_DRIVEN_SKILL_NAME
  const snapshot = await captureEvolutionSkill({ capabilityId: randomUUID(), capabilityKey: name,
    directory: getAiSkillDirectory(name), allowedRoot: getAiSkillRoot(), toolNames: [], dependencyNames: [], config: {} })
  const bundle = { schemaVersion: 1, version: snapshot.version, contentHash: snapshot.contentHash,
    packageHash: evolutionContentHash({ contentHash: snapshot.contentHash, runtimePackageHash: snapshot.packageHash }), runtimeSnapshot: snapshot }
  const loaded = loadEvolutionSkill(bundle, name)
  assert.equal(loaded.instructions, snapshot.version.instructions)
  assert.equal(loaded.sha256, snapshot.contentHash)
  assert.deepEqual(loaded.referenceNames, snapshot.version.references.map(ref => ref.name))
  assert.throws(() => loadEvolutionSkill(bundle, 'other-skill'), /不一致/)
  assert.throws(() => loadEvolutionSkill({ ...bundle, version: { ...bundle.version, instructions: 'changed' } }, name))
})
