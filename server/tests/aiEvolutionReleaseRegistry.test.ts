import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { AiEvolutionReleaseRegistry } from '../src/services/aiEvolutionReleaseRegistry.js'

test('release grants bind user, repository and environment and revocation is immediate', async () => {
  const user = '00000000-0000-4000-8000-000000000001', repo = '00000000-0000-4000-8000-000000000002'
  const target = { id: 'staging', label: '测试环境', repositoryId: repo, root: path.resolve('target'), baseRef: 'HEAD', allowedUserIds: [user] }
  let config = { schemaVersion: 1, targets: [target] }
  const registry = new AiEvolutionReleaseRegistry(async () => config)
  assert.equal((await registry.resolve(user, repo, 'staging')).id, 'staging')
  await assert.rejects(registry.resolve(user, user, 'staging'), { code: 'EVOLUTION_RELEASE_FORBIDDEN' })
  await assert.rejects(registry.resolve(repo, repo, 'staging'), { code: 'EVOLUTION_RELEASE_FORBIDDEN' })
  await assert.rejects(registry.resolve(user, repo, 'production'), { code: 'EVOLUTION_RELEASE_FORBIDDEN' })
  config = { ...config, targets: [] }
  await assert.rejects(registry.resolve(user, repo, 'staging'), { code: 'EVOLUTION_RELEASE_FORBIDDEN' })
  config = { ...config, targets: [target, target] }
  await assert.rejects(registry.list(user, repo), { code: 'EVOLUTION_RELEASE_REGISTRY_INVALID' })
})
