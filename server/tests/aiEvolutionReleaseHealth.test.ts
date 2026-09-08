import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { captureEvolutionRuntimeIdentity } from '../src/services/aiEvolutionRuntimeIdentity.js'
import { probeEvolutionReleaseHealth, waitForEvolutionReleaseHealth } from '../src/runtime/evolution/evolutionReleaseHealth.js'

test('startup identity stays frozen and health requires the expected build, not merely status 200', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-identity-'))
  try {
    await mkdir(path.join(root, 'server-dist')); await mkdir(path.join(root, 'dist'))
    const provenance = { schemaVersion: 1, baseCommit: 'a'.repeat(40), patchHash: 'b'.repeat(64), lockHash: 'c'.repeat(64) }
    await writeFile(path.join(root, 'server-dist/evolution-build.json'), JSON.stringify(provenance))
    await writeFile(path.join(root, 'server-dist/index.js'), 'old process')
    await writeFile(path.join(root, 'dist/index.html'), '<div>old</div>')
    const identity = (await captureEvolutionRuntimeIdentity(path.join(root, 'server-dist/index.js')))!
    assert.ok(identity)
    await writeFile(path.join(root, 'server-dist/index.js'), 'new process')
    const next = (await captureEvolutionRuntimeIdentity(path.join(root, 'server-dist/index.js')))!
    assert.notEqual(identity.serverEntrySha256, next.serverEntrySha256)
    const expected = { url: 'http://127.0.0.1/api/health', expected: next }
    for (const [deploymentIdentity, status, passes] of [[identity, 'ready', false], [next, 'starting', false], [next, 'ready', true], [undefined, 'ready', false]] as const) {
      const result = await probeEvolutionReleaseHealth({ ...expected,
        fetchImpl: async () => Response.json({ ok: true, service: 'cybernaut-app', status, deploymentIdentity }) })
      assert.equal(result, passes)
    }
    assert.equal(await probeEvolutionReleaseHealth({ ...expected, fetchImpl: async () => new Response('x'.repeat(65537)) }), false)
    assert.equal(await probeEvolutionReleaseHealth({ ...expected, signal: AbortSignal.abort(), fetchImpl: async () => { assert.fail('cancelled probe must not connect') } }), false)
    let attempts = 0
    assert.equal(await waitForEvolutionReleaseHealth({ ...expected, timeoutMs: 100, intervalMs: 1,
      fetchImpl: async () => Response.json({ ok: true, service: 'cybernaut-app', status: ++attempts < 3 ? 'starting' : 'ready', deploymentIdentity: next }) }), true)
    assert.equal(attempts, 3)
    attempts = 0
    assert.equal(await waitForEvolutionReleaseHealth({ ...expected, timeoutMs: 100, intervalMs: 1,
      stillExpected: async () => false, fetchImpl: async () => { attempts++; return Response.json({}) } }), false)
    assert.equal(attempts, 0)
    assert.equal(await captureEvolutionRuntimeIdentity(path.join(root, 'server/src/index.ts')), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})
