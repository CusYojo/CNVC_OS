import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveAiSkillDirectory } from '../src/services/aiSkillService.js'

async function addSkill(root: string, relativeDirectory: string) {
  const directory = path.join(root, relativeDirectory)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'SKILL.md'), 'test skill', 'utf8')
  return directory
}

test('Gorden skill resolver accepts the flattened production layout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-skill-flat-'))
  const flatDirectory = await addSkill(root, 'GordenSuperPPTSkill')

  assert.equal(
    resolveAiSkillDirectory('GordenSuperPPTSkill', root),
    flatDirectory,
  )
})

test('Gorden skill resolver prefers the bundled nested development layout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-skill-nested-'))
  await addSkill(root, 'GordenSuperPPTSkill')
  const nestedDirectory = await addSkill(
    root,
    path.join('GordenSuperPPTSkills', 'GordenSuperPPTSkill'),
  )

  assert.equal(
    resolveAiSkillDirectory('GordenSuperPPTSkill', root),
    nestedDirectory,
  )
})
