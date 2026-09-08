import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { applyEvolutionChanges, captureEvolutionSource, safeEvolutionSourcePath, type EvolutionRepositoryRegistration } from '../src/runtime/evolution/evolutionSourceSnapshot.js'

test('fixed-commit snapshot excludes secrets and working tree changes; patches preserve scope and hashes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
  git('init', '--quiet')
  await mkdir(path.join(root, 'src'))
  await mkdir(path.join(root, 'tests'))
  await writeFile(path.join(root, 'src', 'page.ts'), 'export const value = 1\n')
  await writeFile(path.join(root, 'tests', 'gate.ts'), 'protected gate\n')
  await writeFile(path.join(root, '.env'), 'PRIVATE=fixture-only\n')
  git('add', 'src/page.ts', 'tests/gate.ts', '.env')
  git('-c', 'user.name=Evolution Test', '-c', 'user.email=evolution@example.test', 'commit', '--quiet', '-m', 'fixture')
  const commit = git('rev-parse', 'HEAD').trim()
  await writeFile(path.join(root, 'src', 'page.ts'), 'uncommitted work must not be read')
  const registration: EvolutionRepositoryRegistration = { id: 'test', root, readablePaths: ['src', 'tests', '.env'], editablePaths: ['src', 'tests'], protectedPaths: ['tests'] }
  const snapshot = await captureEvolutionSource(registration, commit)
  assert.deepEqual(snapshot.files.map((file) => file.path), ['src/page.ts', 'tests/gate.ts'])
  assert.equal(Buffer.from(snapshot.files[0].contentBase64, 'base64').toString(), 'export const value = 1\n')
  const change = { path: 'src/page.ts', expectedSha256: snapshot.files[0].sha256, contentBase64: Buffer.from('export const value = 2\n').toString('base64') }
  const candidate = applyEvolutionChanges(snapshot, registration, ['src'], [change])
  assert.notEqual(candidate.contentHash, snapshot.contentHash)
  assert.equal(snapshot.files[0].sha256, change.expectedSha256)
  assert.throws(() => applyEvolutionChanges(snapshot, registration, ['src'], [{ ...change, expectedSha256: 'bad' }]), { code: 'EVOLUTION_PATCH_BASELINE' })
  for (const name of ['../.env', '.env', 'tests/gate.ts', '/etc/passwd', 'src/../tests/gate.ts']) {
    assert.throws(() => applyEvolutionChanges(snapshot, registration, ['src', 'tests'], [{ ...change, path: name }]), { code: 'EVOLUTION_PATCH_SCOPE' })
  }
  await assert.rejects(captureEvolutionSource(registration, 'HEAD'), { code: 'EVOLUTION_INVALID_SOURCE_BASELINE' })
})

test('portable paths reject Windows devices, ambiguity and traversal', () => {
  for (const name of ['src/NUL.ts', 'src/a.', 'src/a ', 'src\\a', 'C:/a', 'src//a', 'src/../a', 'src/*']) assert.equal(safeEvolutionSourcePath(name), false, name)
  assert.equal(safeEvolutionSourcePath('src/来源说明.tsx'), true)
})
