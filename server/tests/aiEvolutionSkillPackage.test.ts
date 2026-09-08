import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { captureEvolutionSkill } from '../src/runtime/evolution/evolutionSkillSnapshot.js'
import { saveEvolutionSkillPackage, parseEvolutionSkillPackage, reconstructEvolutionSkillRuntime } from '../src/runtime/evolution/evolutionSkillPackage.js'
import { getAiSkillDirectory, getAiSkillRoot } from '../src/services/aiSkillService.js'
import { AiEvolutionArtifactStore } from '../src/services/aiEvolutionArtifactStore.js'
import { randomUUID } from 'node:crypto'

test('saved skill package reconstructs the complete frozen runtime and rejects changed bytes or permissions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-version-package-'))
  try {
    const snapshot = await captureEvolutionSkill({ capabilityId: randomUUID(), capabilityKey: 'draft-due-diligence-report',
      directory: getAiSkillDirectory('draft-due-diligence-report'), allowedRoot: getAiSkillRoot(), toolNames: [], dependencyNames: [], config: {} })
    const store = new AiEvolutionArtifactStore(root), runId = randomUUID()
    const version = { ...snapshot.version, instructions: snapshot.version.instructions + '\n完整来源约束。' }
    const saved = await saveEvolutionSkillPackage({ runId, snapshot, version }, store)
    const raw = JSON.parse((await store.read(runId, saved.artifact)).toString())
    const restored = parseEvolutionSkillPackage(raw)
    assert.deepEqual(restored.version, version)
    assert.deepEqual(restored.runtimeSnapshot.files, snapshot.files)
    assert.equal(restored.packageHash, saved.packageHash)
    assert.ok(restored.runtimeSnapshot.files.some(file => file.path.startsWith('scripts/')))
    const runtime = reconstructEvolutionSkillRuntime(raw)
    assert.ok(Buffer.from(runtime.files.find(file => file.path === 'SKILL.md')!.contentBase64, 'base64').toString().endsWith('完整来源约束。'))
    assert.deepEqual(runtime.files.filter(file => file.path.startsWith('scripts/')), snapshot.files.filter(file => file.path.startsWith('scripts/')))
    assert.equal(runtime.packageHash, saved.packageHash)
    assert.equal(reconstructEvolutionSkillRuntime(raw).runtimeHash, runtime.runtimeHash)
    const missingReference = { ...version, instructions: version.instructions + '\n[新增规则](references/missing.md)' }
    let written = false
    await assert.rejects(saveEvolutionSkillPackage({ runId, snapshot, version: missingReference }, {
      async put() { written = true; throw Error('Must validate before writing') },
    }), { code: 'EVOLUTION_SKILL_PACKAGE_INVALID' })
    assert.equal(written, false)
    const extraReference = { ...version, references: [...version.references, { name: 'references/unused.md', content: 'unused' }] }
    await assert.rejects(saveEvolutionSkillPackage({ runId, snapshot, version: extraReference }, store), { code: 'EVOLUTION_SKILL_PACKAGE_INVALID' })
    assert.equal((await saveEvolutionSkillPackage({ runId, snapshot, version }, store)).artifact.storageKey, saved.artifact.storageKey)
    raw.runtimeSnapshot.files[0].contentBase64 = Buffer.from('changed').toString('base64')
    assert.throws(() => parseEvolutionSkillPackage(raw), { code: 'EVOLUTION_SKILL_PACKAGE_INVALID' })
    await assert.rejects(saveEvolutionSkillPackage({ runId, snapshot, version: { ...version, toolPermissionHash: '0'.repeat(64) } }, store),
      { code: 'EVOLUTION_SKILL_PACKAGE_INVALID' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
