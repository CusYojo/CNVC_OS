import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadEvolutionPublisherLifecycle } from '../src/services/aiEvolutionPublisherLifecycleRegistry.js'

test('publisher lifecycle loads only fixed argv commands and loopback health', { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'evolution-publisher-config-'))
  const root = path.join(directory, 'target'), config = path.join(directory, 'publisher.json')
  const prior = process.env.AI_EVOLUTION_PUBLISHER_LIFECYCLE_FILE
  try {
    await mkdir(path.join(root, 'server/scripts'), { recursive: true })
    await copyFile('server/scripts/build-platform.mjs', path.join(root, 'server/scripts/build-platform.mjs'))
    const body = { schemaVersion: 1, targets: [{ targetId: 'local', healthUrl: 'http://127.0.0.1:3001/api/health',
      stop: { file: process.execPath, args: ['-e', 'process.exit(0)'] }, start: { file: process.execPath, args: ['-e', 'process.exit(0)'] } }] }
    await writeFile(config, JSON.stringify(body)); process.env.AI_EVOLUTION_PUBLISHER_LIFECYCLE_FILE = config
    const lifecycle = await loadEvolutionPublisherLifecycle('local', root)
    await lifecycle.stop(new AbortController().signal); await lifecycle.start(new AbortController().signal)
    assert.equal(lifecycle.healthUrl, body.targets[0].healthUrl)
    await writeFile(config, JSON.stringify({ ...body, targets: [{ ...body.targets[0], healthUrl: 'https://example.com/health' }] }))
    await assert.rejects(loadEvolutionPublisherLifecycle('local', root))
  } finally {
    if (prior === undefined) delete process.env.AI_EVOLUTION_PUBLISHER_LIFECYCLE_FILE
    else process.env.AI_EVOLUTION_PUBLISHER_LIFECYCLE_FILE = prior
    await rm(directory, { recursive: true, force: true })
  }
})
