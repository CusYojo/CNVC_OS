import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
const entry = new URL('../src/scripts/fdeProjectReplanAcceptance.ts', import.meta.url)
for (const [database, optIn] of [['business', '1'], ['fde_acceptance', '0']]) test(`replan acceptance rejects unsafe environment: ${database}/${optIn}`, () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry.pathname], { env: { PATH: process.env.PATH, DB_DATABASE: database, ALLOW_MYSQL_ACCEPTANCE_WRITES: optIn, DB_FREFIX: 'fde_accept_1234567890_', FDE_ACCEPTANCE_PREFIX: 'fde_accept_1234567890_' }, encoding: 'utf8', timeout: 10000 })
  assert.ifError(result.error); assert.equal(result.status, 1)
  assert.match(result.stderr, /requires ALLOW_MYSQL_ACCEPTANCE_WRITES=1 with a dedicated test\/acceptance MySQL database/)
  assert.doesNotMatch(result.stderr, /required environment variable|ECONNREFUSED|ENOTFOUND/)
  assert.equal(result.stdout, '')
})
test('replan guard runs before the first dynamic DB import; migration seeds no policy', () => {
  const source = readFileSync(entry, 'utf8')
  assert.ok(source.indexOf("assertIsolatedMysqlAcceptanceDatabase('fdeProjectReplanAcceptance')") < source.indexOf("await import('../db/client.js')"))
  assert.doesNotMatch(readFileSync(new URL('../drizzle/0086_add_fde_project_replan.sql', import.meta.url), 'utf8'), /INSERT\s+INTO/i)
})
