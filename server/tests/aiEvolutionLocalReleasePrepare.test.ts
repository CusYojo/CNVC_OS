import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { prepareLocalEvolutionRelease } from '../src/runtime/evolution/evolutionLocalReleasePrepare.js'

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')

test('actual build staging produces a receipt bound to candidate and previous runtime identities without activation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-release-prepare-'))
  const target = path.join(root, 'target'), bundle = path.join(root, 'bundle')
  try {
    await mkdir(path.join(target, 'server/scripts'), { recursive: true })
    await copyFile('server/scripts/build-platform.mjs', path.join(target, 'server/scripts/build-platform.mjs'))
    await copyFile('server/scripts/stage-evolution-build.mjs', path.join(target, 'server/scripts/stage-evolution-build.mjs'))
    const identity = (label: string) => ({ schemaVersion: 1, baseCommit: 'a'.repeat(40), patchHash: digest(`${label}:patch`), lockHash: digest(`${label}:lock`) })
    const writeRuntime = async (directory: string, label: string) => {
      await mkdir(path.join(directory, 'dist/assets'), { recursive: true }); await mkdir(path.join(directory, 'server-dist'), { recursive: true })
      const files = new Map([
        ['dist/index.html', Buffer.from(`<div id="root">${label}</div>`)],
        ['dist/assets/app.js', Buffer.from(`console.log(${JSON.stringify(label)})`)],
        ['server-dist/index.js', Buffer.from(`export const version=${JSON.stringify(label)}`)],
        ['server-dist/evolution-build.json', Buffer.from(JSON.stringify(identity(label)))],
      ])
      for (const [name, bytes] of files) await writeFile(path.join(directory, name), bytes)
      return files
    }
    const oldFiles = await writeRuntime(target, 'old')
    const newFiles = await writeRuntime(bundle, 'new')
    const nextIdentity = identity('new')
    const manifest = { ...nextIdentity, activated: false, createdAt: new Date().toISOString(), nodeVersion: 'v22',
      buildParameters: { mode: 'production', sourceEnvLoaded: false, sourceViteConfigLoaded: false },
      artifacts: [...newFiles].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: digest(bytes) })) }
    const manifestBytes = Buffer.from(JSON.stringify(manifest))
    await writeFile(path.join(bundle, 'manifest.json'), manifestBytes)
    let authorizations = 0
    const receipt = await prepareLocalEvolutionRelease({ targetRoot: target, bundleRoot: bundle,
      manifestSha256: digest(manifestBytes), candidateHash: 'f'.repeat(64), authorize: async () => { authorizations += 1 } })
    assert.equal(authorizations, 3)
    assert.equal(receipt.candidateHash, 'f'.repeat(64))
    assert.equal(receipt.candidateIdentity.patchHash, nextIdentity.patchHash)
    assert.equal(receipt.previousIdentity?.serverEntrySha256, digest(oldFiles.get('server-dist/index.js')!))
    assert.match(receipt.previousReleaseId!, /^runtime:[a-f0-9]{64}$/)
    assert.equal(await readFile(path.join(target, 'server-dist/index.js'), 'utf8'), oldFiles.get('server-dist/index.js')!.toString())
    const pointer = JSON.parse(await readFile(path.join(target, '.runtime/build-candidate.json'), 'utf8'))
    assert.equal(pointer.releaseId, receipt.releaseId)
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('evolution-release-prepare-'))
    await rm(root, { recursive: true, force: true })
  }
})

test('ambiguous staging output is rejected before a receipt can be claimed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-release-output-'))
  const target = path.join(root, 'target'), bundle = path.join(root, 'bundle')
  try {
    await mkdir(path.join(target, 'server/scripts'), { recursive: true }); await mkdir(bundle)
    await writeFile(path.join(target, 'server/scripts/build-platform.mjs'), '')
    await assert.rejects(prepareLocalEvolutionRelease({ targetRoot: target, bundleRoot: bundle,
      manifestSha256: 'a'.repeat(64), candidateHash: 'b'.repeat(64), authorize: async () => {},
      run: async () => ({ stdout: '{}\n{}\n', stderr: '' }) as never }), { code: 'EVOLUTION_RELEASE_PREPARE_OUTPUT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
