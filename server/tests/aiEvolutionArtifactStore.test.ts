import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { AiEvolutionArtifactStore } from '../src/services/aiEvolutionArtifactStore.js'

test('immutable artifacts round-trip and reject corruption and cross-task reads', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-artifacts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new AiEvolutionArtifactStore(root)
  const runId = randomUUID()
  const artifact = await store.put(runId, Buffer.from('verified report'), 'report')
  assert.equal((await store.read(runId, artifact)).toString(), 'verified report')
  const manifest = { schemaVersion: 1 as const, sourceHash: 'a'.repeat(64), patchHash: 'b'.repeat(64), dependencyLockHash: 'c'.repeat(64), environment: 'test', artifacts: [artifact] }
  await store.verifyManifest(runId, manifest)
  await assert.rejects(store.verifyManifest(runId, { ...manifest, artifacts: [artifact, artifact] }), { code: 'EVOLUTION_ARTIFACTS_INCOMPLETE' })
  assert.deepEqual(await store.put(runId, Buffer.from('verified report'), 'report'), artifact)
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => store.put(runId, Buffer.from('concurrent report'), 'report')))
  assert.equal(new Set(concurrent.map((item) => item.storageKey)).size, 1)
  await assert.rejects(store.read(randomUUID(), artifact), { code: 'EVOLUTION_ARTIFACT_KEY' })
  await writeFile(path.join(root, artifact.storageKey), 'corrupt content')
  await assert.rejects(store.verifyManifest(runId, manifest), { code: 'EVOLUTION_ARTIFACT_INTEGRITY' })
  await assert.rejects(store.read(runId, artifact), { code: 'EVOLUTION_ARTIFACT_INTEGRITY' })
  await assert.rejects(store.put(runId, Buffer.from('verified report'), 'report'), { code: 'EVOLUTION_ARTIFACT_INTEGRITY' })
})

test('rejects task directories redirected through junctions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-artifacts-link-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const outside = path.join(root, 'outside')
  await mkdir(outside)
  const runId = randomUUID()
  await symlink(outside, path.join(root, runId), 'junction')
  await assert.rejects(new AiEvolutionArtifactStore(root).put(runId, Buffer.from('content'), 'report'), { code: 'EVOLUTION_ARTIFACT_PATH' })
})
