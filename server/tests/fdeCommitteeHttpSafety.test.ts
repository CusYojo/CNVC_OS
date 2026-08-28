import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const entry = new URL('../src/scripts/fdeCommitteeHttpAcceptance.ts', import.meta.url)
// Never launch this script with an accepted database configuration. A synthetic
// environment and network/listener traps keep rejection probes independent of
// business credentials, .env, real sockets, fixtures and the HTTP service.
const bootstrap = `
  import net from 'node:net';
  import { Server } from 'node:http';
  net.Socket.prototype.connect = function () { throw new Error('UNEXPECTED_NETWORK_BEFORE_GUARD') };
  Server.prototype.listen = function () { throw new Error('UNEXPECTED_LISTENER_BEFORE_GUARD') };
  await import(${JSON.stringify(entry.href)});
`
for (const fixture of [
  { name: 'missing database', database: undefined, optIn: '1' },
  { name: 'business database even with opt-in', database: 'business', optIn: '1' },
  { name: 'dedicated-name database without write opt-in', database: 'fde_test', optIn: undefined },
]) test(`committee HTTP entry rejects ${fixture.name} before sockets or fixtures`, () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', bootstrap], {
    env: { PATH: process.env.PATH, DB_HOST: '127.0.0.1', DB_PORT: '1', DB_DATABASE: fixture.database,
      DB_USERNAME: 'fixture', DB_PASSWORD: 'fixture', DB_FREFIX: 'fde_accept_1234567890_', FDE_ACCEPTANCE_PREFIX: 'fde_accept_1234567890_',
      ALLOW_MYSQL_ACCEPTANCE_WRITES: fixture.optIn },
    encoding: 'utf8', timeout: 10000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /fdeCommitteeHttpAcceptance writes acceptance fixtures and requires ALLOW_MYSQL_ACCEPTANCE_WRITES=1 with a dedicated test\/acceptance MySQL database/)
  assert.equal(result.stdout, '')
  assert.doesNotMatch(result.stderr, /UNEXPECTED_NETWORK_BEFORE_GUARD|UNEXPECTED_LISTENER_BEFORE_GUARD|ECONNREFUSED|ENOTFOUND|ER_ACCESS_DENIED/)
})

test('committee HTTP guard stays before credential changes, dynamic database imports, seeding and listening', () => {
  const source = readFileSync(entry, 'utf8')
  const guard = source.indexOf("assertIsolatedMysqlAcceptanceDatabase('fdeCommitteeHttpAcceptance')")
  assert.ok(guard >= 0)
  for (const operation of ['process.env.AUTH_COOKIE_SECURE =', 'process.env.JWT_SECRET =', "await import('../db/client.js')", 'await db.insert(', 'await seedCommitteeBrowser(', 'app.listen(']) {
    assert.ok(source.indexOf(operation) > guard, `${operation} must occur after the dedicated-database guard`)
  }
  assert.doesNotMatch(source, /process\.env\.(?:DB_DATABASE|ALLOW_MYSQL_ACCEPTANCE_WRITES)\s*=/)
  assert.doesNotMatch(source, /(?:^|\n)import\s[^\n]*from\s['"][^'"\n]*\/(?:db|services)\//, 'no eager database/service imports before the guard')
})
