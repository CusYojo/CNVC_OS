import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertIsolatedMysqlAcceptanceDatabase } from '../src/scripts/mysqlAcceptanceSafety.js'

// No .env is loaded, no database module is imported, and no passing configuration
// is ever used to launch an acceptance process. These are rejection-only probes.
const entry = new URL('../src/scripts/fdeMigrationAcceptance.ts', import.meta.url)
const expected = /requires ALLOW_MYSQL_ACCEPTANCE_WRITES=1 with a dedicated test\/acceptance MySQL database/
const cases = [
  { name: 'missing database', database: undefined, optIn: '1' },
  { name: 'blank database', database: ' ', optIn: '1' },
  { name: 'business database despite opt-in', database: 'business', optIn: '1' },
  { name: 'test substring is not a dedicated name', database: 'contest', optIn: '1' },
  { name: 'dedicated database without opt-in', database: 'fde_test', optIn: undefined },
  { name: 'dedicated database with disabled opt-in', database: 'fde_acceptance', optIn: '0' },
  { name: 'non-contract opt-in value', database: 'fde_tests', optIn: 'true' },
]
for (const fixture of cases) test(`migration entry rejects ${fixture.name} before opening resources`, () => {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    DB_HOST: '127.0.0.1', DB_PORT: '1', DB_DATABASE: fixture.database,
    DB_USERNAME: 'fixture', DB_PASSWORD: 'fixture', DB_FREFIX: 'fde_accept_1234567890_',
    FDE_ACCEPTANCE_PREFIX: 'fde_accept_1234567890_',
    ALLOW_MYSQL_ACCEPTANCE_WRITES: fixture.optIn,
    // These synthetic credentials must not make an unsafe database acceptable.
    DB_MIGRATION_USERNAME: 'fixture-migration', DB_MIGRATION_PASSWORD: 'fixture-migration',
  }
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry.pathname, '--committee'], { env, encoding: 'utf8', timeout: 10_000 })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.match(result.stderr, expected)
  assert.doesNotMatch(result.stdout + result.stderr, /ECONNREFUSED|ENOTFOUND|fixturePrefix|fixtureRoot|cleanupStarted|ER_ACCESS_DENIED/)
  assert.equal(result.stdout, '', 'must reject before resource or migration output')
})

test('the shared guard accepts only the explicit contract, without connecting', () => {
  const saved = { database: process.env.DB_DATABASE, optIn: process.env.ALLOW_MYSQL_ACCEPTANCE_WRITES }
  try {
    process.env.ALLOW_MYSQL_ACCEPTANCE_WRITES = '1'
    for (const name of ['test', 'tests', 'acceptance', 'fde_test', 'fde-acceptance-0084']) {
      process.env.DB_DATABASE = name
      assert.doesNotThrow(() => assertIsolatedMysqlAcceptanceDatabase('pure-test'))
    }
  } finally {
    if (saved.database === undefined) delete process.env.DB_DATABASE; else process.env.DB_DATABASE = saved.database
    if (saved.optIn === undefined) delete process.env.ALLOW_MYSQL_ACCEPTANCE_WRITES; else process.env.ALLOW_MYSQL_ACCEPTANCE_WRITES = saved.optIn
  }
})

test('entry guard precedes credentials, connections, directories and migrations', () => {
  const source = readFileSync(entry, 'utf8')
  const guard = source.indexOf("assertIsolatedMysqlAcceptanceDatabase('fdeMigrationAcceptance')")
  assert.ok(guard >= 0)
  for (const operation of ['process.env.DB_USERNAME =', 'mysql.createConnection(', 'await tables(', 'await mkdtemp(', 'await applySchemaMigrations()']) {
    assert.ok(source.indexOf(operation) > guard, `${operation} must follow guard`)
  }
  assert.doesNotMatch(source, /process\.env\.ALLOW_MYSQL_ACCEPTANCE_WRITES\s*=/, 'entry must not manufacture write opt-in')
  assert.doesNotMatch(source, /process\.env\.DB_DATABASE\s*=/, 'entry must not rename a business database into an apparent test configuration')
})
