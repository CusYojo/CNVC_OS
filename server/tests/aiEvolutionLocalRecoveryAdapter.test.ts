import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { captureEvolutionRuntimeIdentity } from '../src/services/aiEvolutionRuntimeIdentity.js'
import { createLocalEvolutionRecoveryAdapter } from '../src/runtime/evolution/evolutionLocalRecoveryAdapter.js'

test('local recovery verifies actual files and backup before invoking trusted lifecycle commands', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-local-recovery-'))
  const releaseId = 'build-20260908T120000000Z-123-abcd1234'
  const backup = path.join(root, '.runtime/build-rollbacks', releaseId)
  const files = ['server-dist/index.js', 'server-dist/evolution-build.json', 'dist/index.html']
  const writeBuild = async (directory: string, label: string) => {
    await mkdir(path.join(directory, 'server-dist'), { recursive: true }); await mkdir(path.join(directory, 'dist'), { recursive: true })
    await writeFile(path.join(directory, files[0]), label)
    await writeFile(path.join(directory, files[1]), JSON.stringify({ schemaVersion: 1, baseCommit: 'a'.repeat(40), patchHash: 'b'.repeat(64), lockHash: 'c'.repeat(64) }))
    await writeFile(path.join(directory, files[2]), `<div>${label}</div>`)
    return (await captureEvolutionRuntimeIdentity(path.join(directory, files[0])))!
  }
  try {
    const candidateIdentity = await writeBuild(root, 'candidate')
    const previousIdentity = await writeBuild(backup, 'previous')
    const receipt = { releaseId, previousReleaseId: 'old', candidateHash: 'd'.repeat(64), candidateIdentity, previousIdentity }
    const calls: string[] = [], signal = new AbortController().signal
    const adapter = await createLocalEvolutionRecoveryAdapter({ root, receipt,
      healthUrl: 'http://127.0.0.1/api/health',
      fetchImpl: async () => Response.json({ ok: true, service: 'cybernaut-app', status: 'ready', deploymentIdentity: candidateIdentity }),
      stop: async () => { calls.push('stop') },
      rollbackBuild: async () => { calls.push('rollback'); for (const file of files) await copyFile(path.join(backup, file), path.join(root, file)) },
      start: async () => { calls.push('start') },
    })
    assert.equal(await adapter.inspect(receipt, signal), 'candidate')
    assert.equal(await adapter.health(receipt, 'candidate', signal), true)
    assert.equal(await adapter.health(receipt, 'previous', signal), false)
    const pointer = { version: 1, releaseId, rollbackReleaseId: releaseId, hadPrevious: true }
    const pointerPath = path.join(root, '.runtime/build-rollback.json')
    await writeFile(pointerPath, JSON.stringify({ ...pointer, releaseId: 'wrong' }))
    await assert.rejects(adapter.rollback(receipt, signal), /pointer does not match/)
    assert.deepEqual(calls, [])
    await writeFile(pointerPath, JSON.stringify(pointer))
    await assert.rejects(adapter.rollback(receipt, AbortSignal.abort()))
    assert.deepEqual(calls, [])
    await adapter.rollback(receipt, signal)
    assert.deepEqual(calls, ['stop', 'rollback', 'start'])
    assert.equal(await adapter.inspect(receipt, signal), 'previous')
    await assert.rejects(adapter.rollback(receipt, signal), /different deployment/)
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('evolution-local-recovery-'))
    await rm(root, { recursive: true, force: true })
  }
})
