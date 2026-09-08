import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { AiEvolutionRepositoryRegistry, parseEvolutionRepositoryRegistry } from '../src/services/aiEvolutionRepositoryRegistry.js'

test('repository registry requires explicit grants and observes revocation without restart', async () => {
  const userId = '00000000-0000-4000-8000-000000000001', id = '00000000-0000-4000-8000-000000000002'
  const config = { schemaVersion: 1, repositories: [{ id, root: path.resolve('.'), readablePaths: ['src', 'server'], editablePaths: ['src'], protectedPaths: [], allowedUserIds: [userId] }] }
  const registry = new AiEvolutionRepositoryRegistry(async () => config)
  assert.equal(await registry.canDevelop(userId, id), true)
  assert.equal(await registry.canDevelop('00000000-0000-4000-8000-000000000003', id), false)
  assert.ok((await registry.resolve(userId, id)).protectedPaths.includes('server/tests'))
  config.repositories[0].allowedUserIds = []
  assert.equal(await registry.canDevelop(userId, id), false)
  assert.throws(() => parseEvolutionRepositoryRegistry({ ...config, repositories: [...config.repositories, ...config.repositories] }), { code: 'EVOLUTION_REGISTRY_INVALID' })
  assert.throws(() => parseEvolutionRepositoryRegistry({ ...config, repositories: [{ ...config.repositories[0], editablePaths: ['outside'] }] }), { code: 'EVOLUTION_REGISTRY_INVALID' })
})
