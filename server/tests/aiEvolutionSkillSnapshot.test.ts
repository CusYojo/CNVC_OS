import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { captureEvolutionSkill } from '../src/runtime/evolution/evolutionSkillSnapshot.js'

test('skill snapshot binds actual references, scripts, frontmatter and permissions without changing live files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-skill-snapshot-'))
  try {
    const directory = path.join(root, 'skill')
    await mkdir(path.join(directory, 'references'), { recursive: true })
    await mkdir(path.join(directory, 'scripts'))
    const source = '---\nname: skill\ndescription: evidence\n---\nUse [evidence](references/evidence.md).'
    await writeFile(path.join(directory, 'SKILL.md'), source)
    await writeFile(path.join(directory, 'references/evidence.md'), 'source facts')
    await writeFile(path.join(directory, 'scripts/render.mjs'), 'throw Error("must never execute")')
    const input = { capabilityId: 'capability', capabilityKey: 'skill', directory, allowedRoot: root,
      toolNames: ['read'], dependencyNames: ['renderer'], config: { runtime: 'controlled-ai-task' } }
    const first = await captureEvolutionSkill(input)
    assert.equal(first.version.references[0].content, 'source facts')
    assert.ok(first.version.dependencies.some(row => row.name === 'file:scripts/render.mjs'))
    assert.equal(first.manifest.length, 3)
    assert.deepEqual(await captureEvolutionSkill(input), first)
    await writeFile(path.join(directory, 'scripts/render.mjs'), 'throw Error("changed")')
    const scripts = await captureEvolutionSkill(input)
    assert.notEqual(scripts.contentHash, first.contentHash)
    assert.notEqual(scripts.packageHash, first.packageHash)
    assert.equal(scripts.version.instructions, first.version.instructions)
    assert.notEqual((await captureEvolutionSkill({ ...input, toolNames: ['write'] })).version.toolPermissionHash, first.version.toolPermissionHash)
    await writeFile(path.join(directory, 'references/evidence.md'), 'new facts')
    assert.notEqual((await captureEvolutionSkill(input)).contentHash, scripts.contentHash)
    assert.equal(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), source)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('skill snapshot rejects linked reference directories, secret files and missing references', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-skill-source-boundary-'))
  try {
    const directory = path.join(root, 'skill'), outside = path.join(root, 'outside')
    await mkdir(directory); await mkdir(outside)
    await writeFile(path.join(directory, 'SKILL.md'), '---\nname: skill\ndescription: test\n---\nRead [source](references/source.md).')
    await writeFile(path.join(outside, 'source.md'), 'unregistered source')
    const input = { capabilityId: 'capability', capabilityKey: 'skill', directory, allowedRoot: root,
      toolNames: [], dependencyNames: [], config: {} }
    await assert.rejects(captureEvolutionSkill(input))
    await symlink(outside, path.join(directory, 'references'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(captureEvolutionSkill(input), { code: 'EVOLUTION_SKILL_SOURCE_INVALID' })
    await rm(path.join(directory, 'references'))
    await writeFile(path.join(directory, '.env'), 'test-only')
    await assert.rejects(captureEvolutionSkill(input), { code: 'EVOLUTION_SKILL_SOURCE_INVALID' })
    await assert.rejects(captureEvolutionSkill({ ...input, directory: root }), { code: 'EVOLUTION_SKILL_SOURCE_INVALID' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
