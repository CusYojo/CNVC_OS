import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { captureEvolutionRuntimeIdentity } from '../src/services/aiEvolutionRuntimeIdentity.js'
import { createLocalEvolutionReleaseAdapter } from '../src/runtime/evolution/evolutionLocalReleaseAdapter.js'

test('local release adapter verifies staged identity and restarts around activation and rollback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-local-release-'))
  const releaseId = 'build-20260908T120000000Z-123-abcd1234'
  const candidate = path.join(root, '.runtime/build-candidates', releaseId)
  const backup = path.join(root, '.runtime/build-rollbacks', releaseId)
  const files = ['server-dist/index.js', 'server-dist/evolution-build.json', 'dist/index.html']
  const writeBuild = async (directory: string, label: string) => {
    await mkdir(path.join(directory, 'server-dist'), { recursive: true }); await mkdir(path.join(directory, 'dist'), { recursive: true })
    await writeFile(path.join(directory, files[0]), label)
    await writeFile(path.join(directory, files[1]), JSON.stringify({ schemaVersion: 1, baseCommit: 'a'.repeat(40), patchHash: 'b'.repeat(64), lockHash: 'c'.repeat(64) }))
    await writeFile(path.join(directory, files[2]), `<div>${label}</div>`)
    return (await captureEvolutionRuntimeIdentity(path.join(directory, files[0])))!
  }
  const copyBuild = async (from: string, to: string) => { for (const file of files) await copyFile(path.join(from, file), path.join(to, file)) }
  try {
    const previousIdentity = await writeBuild(root, 'previous')
    await writeBuild(backup, 'previous')
    const candidateIdentity = await writeBuild(candidate, 'candidate')
    await mkdir(path.join(root, '.runtime'), { recursive: true })
    await writeFile(path.join(root, '.runtime/build-candidate.json'), JSON.stringify({ version: 1, releaseId }))
    const receipt = { releaseId, candidateHash: 'd'.repeat(64), previousReleaseId: 'old', candidateIdentity, previousIdentity }
    const calls: string[] = []
    const adapter = await createLocalEvolutionReleaseAdapter({ root, receipt, healthUrl: 'http://127.0.0.1/health',
      fetchImpl: async () => Response.json({ ok: true, service: 'cybernaut-app', status: 'ready', deploymentIdentity: candidateIdentity }),
      stop: async () => { calls.push('stop') }, start: async () => { calls.push('start') },
      activateBuild: async () => { calls.push('activate'); await copyBuild(candidate, root) },
      rollbackBuild: async () => { calls.push('rollback'); await copyBuild(backup, root) } })
    assert.equal(await adapter.inspect(receipt, new AbortController().signal), 'previous')
    await adapter.activate(receipt, new AbortController().signal)
    assert.deepEqual(calls, ['stop', 'activate', 'start'])
    assert.equal(await adapter.inspect(receipt, new AbortController().signal), 'candidate')
    await adapter.rollback(receipt, new AbortController().signal)
    assert.deepEqual(calls, ['stop', 'activate', 'start', 'stop', 'rollback', 'start'])
    assert.equal(await adapter.inspect(receipt, new AbortController().signal), 'previous')
    await writeFile(path.join(root, '.runtime/build-candidate.json'), JSON.stringify({ version: 1, releaseId: 'wrong' }))
    await assert.rejects(adapter.activate(receipt, new AbortController().signal), /pointer changed/)
    assert.equal(calls.length, 6)
  } finally { await rm(root, { recursive: true, force: true }) }
})
