import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { collectEvolutionBuildArtifacts } from '../src/runtime/evolution/evolutionBuildArtifacts.js'
import { AiEvolutionArtifactStore } from '../src/services/aiEvolutionArtifactStore.js'

test('build export preserves original paths and rejects baseline mismatch before reading files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-export-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new AiEvolutionArtifactStore(root)
  const contents = new Map([['dist/index.html', Buffer.from('<html></html>')], ['server-dist/index.js', Buffer.from('export {}')]])
  const baseCommit = 'a'.repeat(40), patchHash = 'b'.repeat(64), lockHash = 'c'.repeat(64)
  const manifest = { schemaVersion: 1, baseCommit, patchHash, lockHash, activated: false, createdAt: new Date().toISOString(), nodeVersion: 'v22',
    buildParameters: { mode: 'production', sourceEnvLoaded: false, sourceViteConfigLoaded: false },
    artifacts: [...contents].map(([file, bytes]) => ({ path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) }
  let reads = 0
  const input = { identity: { runId: randomUUID(), attempt: 1, leaseToken: 1, inputHash: 'd'.repeat(64) }, baseCommit, patchHash, lockHash, manifest, store,
    environment: { readOutputFile: async (_identity: unknown, file: { path: string }) => { reads++; return contents.get(file.path)! } }, assertCanContinue: async () => {} }
  const result = await collectEvolutionBuildArtifacts(input)
  assert.equal(reads, 2)
  assert.deepEqual(result.files.map((file) => file.path), [...contents.keys()])
  const index = JSON.parse((await store.read(input.identity.runId, result.pathIndex)).toString())
  assert.equal(index.build.baseCommit, baseCommit)
  assert.equal(index.files[0].path, 'dist/index.html')
  await assert.rejects(collectEvolutionBuildArtifacts({ ...input, baseCommit: 'e'.repeat(40) }), { code: 'EVOLUTION_BUILD_BINDING' })
  assert.equal(reads, 2)
})
