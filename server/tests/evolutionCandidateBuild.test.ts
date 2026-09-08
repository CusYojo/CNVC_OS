import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildEvolutionCandidate, parseCandidateArguments } from '../scripts/build-evolution-candidate.mjs'

const baseCommit = 'a'.repeat(40)
const patchHash = 'b'.repeat(64)

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-build-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = path.join(root, 'source')
  const outputRoot = path.join(root, 'candidate')
  await mkdir(sourceRoot)
  await writeFile(path.join(sourceRoot, 'package-lock.json'), '{"lockfileVersion":3}')
  const runCommand = async (_command: string, args: string[]) => {
    if (args.includes('--outDir')) {
      const dir = args[args.indexOf('--outDir') + 1]
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'index.js'), 'export {}')
    }
    if (args[0]?.endsWith('build-evolution-web.mjs')) {
      await mkdir(path.join(outputRoot, 'dist', 'assets'), { recursive: true })
      await writeFile(path.join(outputRoot, 'dist', 'index.html'), '<div id="root"></div>')
      await writeFile(path.join(outputRoot, 'dist', 'assets', 'app.js'), 'console.log("candidate")')
    }
  }
  return { root, sourceRoot, outputRoot, baseCommit, patchHash, runCommand }
}

test('CLI requires explicit roots and immutable provenance and rejects unknown arguments', () => {
  assert.throws(() => parseCandidateArguments([]), /required/)
  assert.throws(() => parseCandidateArguments(['--activate']), /argument/)
  assert.throws(() => parseCandidateArguments(['--output-root', 'x', '--output-root', 'y']), /duplicate/)
})

test('rejects output inside source, source inside output, and existing output', async (t) => {
  const f = await fixture(t)
  await assert.rejects(buildEvolutionCandidate({ ...f, outputRoot: f.sourceRoot }), /overlap/)
  await assert.rejects(buildEvolutionCandidate({ ...f, outputRoot: path.join(f.sourceRoot, 'dist') }), /overlap/)
  await assert.rejects(buildEvolutionCandidate({ ...f, outputRoot: f.root }), /overlap/)
  await mkdir(f.outputRoot)
  await assert.rejects(buildEvolutionCandidate(f), /exist/i)
})

test('candidate manifest hashes every artifact and leaves live files and pointers untouched', async (t) => {
  const f = await fixture(t)
  await mkdir(path.join(f.sourceRoot, '.runtime'))
  const pointer = path.join(f.sourceRoot, '.runtime', 'build-candidate.json')
  await writeFile(pointer, 'original')
  const manifest = await buildEvolutionCandidate(f)
  assert.equal(manifest.baseCommit, baseCommit)
  assert.equal(manifest.patchHash, patchHash)
  assert.equal(manifest.activated, false)
  assert.equal(manifest.artifacts.length, 4)
  assert.ok(manifest.artifacts.some((artifact: {path:string}) => artifact.path === 'server-dist/evolution-build.json'))
  assert.deepEqual(JSON.parse(await readFile(path.join(f.outputRoot, 'server-dist/evolution-build.json'), 'utf8')),
    { schemaVersion: 1, baseCommit, patchHash, lockHash: manifest.lockHash })
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(path.join(f.outputRoot, artifact.path))
    assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(artifact.bytes, bytes.length)
  }
  assert.equal(await readFile(pointer, 'utf8'), 'original')
  await assert.rejects(access(path.join(f.sourceRoot, 'dist')))
})

test('failed build does not publish a success manifest and does not remove evidence', async (t) => {
  const f = await fixture(t)
  await assert.rejects(buildEvolutionCandidate({ ...f, runCommand: async () => { throw new Error('compiler failed') } }), /compiler failed/)
  await assert.rejects(access(path.join(f.outputRoot, 'manifest.json')))
  await access(f.outputRoot)
})

test('rejects secret-bearing output', async (t) => {
  const f = await fixture(t)
  await assert.rejects(buildEvolutionCandidate({ ...f, runCommand: async (command: string, args: string[]) => {
    await f.runCommand(command, args)
    if (args[0]?.endsWith('build-evolution-web.mjs')) await writeFile(path.join(f.outputRoot, 'dist', '.env'), 'PRIVATE=secret')
  } }), /forbidden/)
  await assert.rejects(access(path.join(f.outputRoot, 'manifest.json')))
})

test('rejects linked output directories', async (t) => {
  const f = await fixture(t)
  await assert.rejects(buildEvolutionCandidate({ ...f, runCommand: async (command: string, args: string[]) => {
    await f.runCommand(command, args)
    if (args[0]?.endsWith('build-evolution-web.mjs')) await symlink(f.sourceRoot, path.join(f.outputRoot, 'dist', 'escape'), 'junction')
  } }), /symbolic link/)
})
