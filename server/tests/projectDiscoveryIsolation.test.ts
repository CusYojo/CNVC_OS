import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isProjectDiscoverySourceKey } from '../src/services/projectDiscoveryScope.js'

test('project discovery accepts only migrated VC Hunter and future page uploads', () => {
  assert.equal(isProjectDiscoverySourceKey('vc-hunter:candidate-screenshot-123'), true)
  assert.equal(isProjectDiscoverySourceKey('bp-upload:123'), true)
  assert.equal(isProjectDiscoverySourceKey('batch-import:123'), false)
  assert.equal(isProjectDiscoverySourceKey('investment:123'), false)
  assert.equal(isProjectDiscoverySourceKey('radar:123'), false)
})

test('project discovery uses an isolated endpoint instead of the shared lead pool endpoint', async () => {
  const [page, routes] = await Promise.all([
    readFile(new URL('../../src/pages/ProjectDiscoveryPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/meta.ts', import.meta.url), 'utf8'),
  ])
  assert.match(page, /\/project-discovery\/leads/)
  assert.doesNotMatch(page, /fetchLeads\(/)
  assert.match(routes, /get\('\/project-discovery\/leads'/)
  assert.match(routes, /projectDiscoveryOnly:\s*true/)
})
