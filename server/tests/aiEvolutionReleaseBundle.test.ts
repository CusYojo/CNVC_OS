import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { AiEvolutionArtifactStore } from '../src/services/aiEvolutionArtifactStore.js'
import { findEvolutionReleaseIndexArtifact, materializeEvolutionReleaseBundle, parseEvolutionReleaseIndex } from '../src/runtime/evolution/evolutionReleaseBundle.js'

test('release bundle restores approved paths and bytes without invoking any build or activation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-bundle-test-'))
  try {
    const store = new AiEvolutionArtifactStore(root), runId = randomUUID()
    const files = await Promise.all(Object.entries({ 'dist/index.html': '<div id="root"></div>', 'dist/assets/app.js': 'console.log(1)', 'server-dist/index.js': 'export {}' }).map(async ([file, text]) => ({
      path: file, ...await store.put(runId, Buffer.from(text), file.startsWith('dist/') ? 'web' : 'server'),
    })))
    const build = { schemaVersion: 1, baseCommit: 'a'.repeat(40), patchHash: 'b'.repeat(64), lockHash: 'c'.repeat(64), activated: false,
      createdAt: new Date().toISOString(), nodeVersion: 'v22', buildParameters: { mode: 'production', sourceEnvLoaded: false, sourceViteConfigLoaded: false },
      artifacts: files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) }
    const index = { schemaVersion: 1, build, files }
    const indexArtifact = await store.put(runId, Buffer.from(JSON.stringify(index)), 'report')
    const unrelatedReport = await store.put(runId, Buffer.from(JSON.stringify({ verdict: 'PASS' })), 'report')
    const manifest = { schemaVersion: 1 as const, sourceHash: 'd'.repeat(64), patchHash: build.patchHash, dependencyLockHash: build.lockHash,
      environment: 'isolated', artifacts: [...files.map(({path: _path, ...artifact}) => artifact), unrelatedReport, indexArtifact] }
    assert.throws(() => parseEvolutionReleaseIndex(index, manifest, 'e'.repeat(40)), /binding/)
    assert.throws(() => parseEvolutionReleaseIndex({ ...index, files: [files[0], files[0], files[2]] }, manifest, build.baseCommit), /binding/)
    assert.deepEqual(await findEvolutionReleaseIndexArtifact({ runId, baseRef: build.baseCommit, manifest, store, authorize: async () => {} }), indexArtifact)
    const bundle = await materializeEvolutionReleaseBundle({ runId, baseRef: build.baseCommit, manifest, indexArtifact, store, authorize: async () => {} })
    try {
      assert.equal(await readFile(path.join(bundle.root, 'server-dist/index.js'), 'utf8'), 'export {}')
      assert.equal(createHash('sha256').update(await readFile(path.join(bundle.root, 'manifest.json'))).digest('hex'), bundle.manifestHash)
    } finally { await bundle.dispose() }
    await assert.rejects(materializeEvolutionReleaseBundle({ runId, baseRef: build.baseCommit, manifest, indexArtifact, store,
      authorize: async () => { throw Error('revoked') } }), /revoked/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
