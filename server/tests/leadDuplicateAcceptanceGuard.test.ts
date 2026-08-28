import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertLeadDuplicateAcceptanceIsolation } from '../src/scripts/leadDuplicateAcceptanceGuard.js'

const root = '/tmp/lead-duplicate-release-Abc123'
const env = {
  DB_FREFIX: 'fde_accept_0123456789_', LEAD_ACCEPTANCE_PREFIX: 'fde_accept_0123456789_',
  LEAD_ACCEPTANCE_SOURCE_PREFIX: 'business_', LEAD_ACCEPTANCE_ROOT: root,
}
test('isolated acceptance requires matching random prefix and temporary cwd', () => {
  assert.doesNotThrow(() => assertLeadDuplicateAcceptanceIsolation(env, root))
})
test('canonical temporary root agrees with real child cwd, including macOS /var aliases', async () => {
  const fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'lead-duplicate-release-')))
  try {
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: fixtureRoot, encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    assert.doesNotThrow(() => assertLeadDuplicateAcceptanceIsolation({ ...env, LEAD_ACCEPTANCE_ROOT: fixtureRoot }, child.stdout))
  } finally { await rm(fixtureRoot, { recursive: true, force: true }) }
})
test('real apply acceptance entry rejects a business prefix before opening a connection', () => {
  const child = spawnSync(process.execPath, [
    '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/scripts/leadDuplicateApplyAcceptance.ts', import.meta.url)),
  ], { encoding: 'utf8', timeout: 5000, env: {
    NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: '1', DB_DATABASE: 'isolated_guard_test',
    DB_USERNAME: 'synthetic_guard', DB_PASSWORD: 'synthetic-only-no-server', DB_FREFIX: 'business_',
  } })
  assert.equal(child.status, 1, child.stderr)
  assert.match(child.stderr, /LEAD_ACCEPTANCE_REQUIRES_ISOLATED_PREFIX/)
  assert.doesNotMatch(child.stderr, /ECONNREFUSED|ETIMEDOUT/)
})
test('release acceptance rejects a business database before opening a connection', () => {
  const child = spawnSync(process.execPath, [
    '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/scripts/leadDuplicateReleaseAcceptance.ts', import.meta.url)),
  ], { encoding: 'utf8', timeout: 5000, env: {
    NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: '1', DB_DATABASE: 'business',
    DB_USERNAME: 'synthetic_guard', DB_PASSWORD: 'synthetic-only-no-server', DB_FREFIX: 'business_',
    ALLOW_MYSQL_ACCEPTANCE_WRITES: '1',
  } })
  assert.equal(child.status, 1, child.stderr)
  assert.match(child.stderr, /requires.*dedicated test\/acceptance MySQL database/)
  assert.doesNotMatch(child.stderr, /ECONNREFUSED|ETIMEDOUT/)
})
for (const [name, patch, cwd] of [
  ['business prefix', { DB_FREFIX: 'business_', LEAD_ACCEPTANCE_PREFIX: 'business_' }, root],
  ['missing confirmation', { LEAD_ACCEPTANCE_PREFIX: undefined }, root],
  ['wrong confirmation', { LEAD_ACCEPTANCE_PREFIX: 'fde_accept_abcdef1234_' }, root],
  ['missing source', { LEAD_ACCEPTANCE_SOURCE_PREFIX: undefined }, root],
  ['same source', { LEAD_ACCEPTANCE_SOURCE_PREFIX: env.DB_FREFIX }, root],
  ['relative root', { LEAD_ACCEPTANCE_ROOT: 'lead-duplicate-release-Abc123' }, root],
  ['repository cwd', {}, '/workspace/repo'],
  ['broad root', { LEAD_ACCEPTANCE_ROOT: '/tmp' }, '/tmp'],
] as const) {
  test(`acceptance rejects ${name}`, () => {
    assert.throws(() => assertLeadDuplicateAcceptanceIsolation({ ...env, ...patch }, cwd), /LEAD_ACCEPTANCE_/)
  })
}
