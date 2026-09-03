import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const entry = new URL('../src/scripts/stablePaginationAcceptance.ts', import.meta.url)
const enrichmentFixtureEntry = new URL('../src/scripts/leadEnrichmentMysqlFixtureAcceptance.ts', import.meta.url)
const enrichmentFixtureRunnerEntry = new URL('../src/scripts/leadEnrichmentMysqlFixtureRunner.ts', import.meta.url)

test('lead-pool MySQL acceptance rejects a business database before importing the DB client', async () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry.pathname], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      DB_DATABASE: 'business',
      DB_HOST: '127.0.0.1',
      DB_PORT: '1',
      DB_USERNAME: 'fixture',
      DB_PASSWORD: 'fixture',
      DB_FREFIX: 'sbl_',
      ALLOW_MYSQL_ACCEPTANCE_WRITES: '1',
    },
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /requires ALLOW_MYSQL_ACCEPTANCE_WRITES=1 with a dedicated test\/acceptance MySQL database/)

  const source = await readFile(entry, 'utf8')
  const guard = source.indexOf("assertIsolatedMysqlAcceptanceDatabase('stablePaginationAcceptance')")
  const databaseImport = source.indexOf("import('../db/client.js')")
  assert.ok(guard >= 0 && databaseImport > guard, 'write guard must run before the DB client is imported')
  assert.doesNotMatch(source, /process\.env\.(?:DB_DATABASE|ALLOW_MYSQL_ACCEPTANCE_WRITES)\s*=/)
})

test('lead-enrichment MySQL fixture rejects a business database before its first write', async () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', enrichmentFixtureEntry.pathname], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      DB_DATABASE: 'business',
      DB_HOST: '127.0.0.1',
      DB_PORT: '1',
      DB_USERNAME: 'fixture',
      DB_PASSWORD: 'fixture',
      DB_FREFIX: 'sbl_',
      ALLOW_MYSQL_ACCEPTANCE_WRITES: '1',
    },
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /requires ALLOW_MYSQL_ACCEPTANCE_WRITES=1 with a dedicated test\/acceptance MySQL database/)

  const source = await readFile(enrichmentFixtureEntry, 'utf8')
  const guard = source.indexOf("assertIsolatedMysqlAcceptanceDatabase('leadEnrichmentMysqlFixtureAcceptance')")
  const firstWrite = source.indexOf('INSERT INTO ${usersTable}')
  assert.ok(guard >= 0 && firstWrite > guard, 'write guard must run before the first fixture mutation')
  assert.match(source, /DELETE FROM \$\{investmentProfilesTable\} WHERE lead_id=\?/)
  assert.match(source, /refreshLeadInvestmentProfileProjectionWithReceipt\(\{\s*leadId, snapshotId: frozen\.snapshotId,\s*\}\)/)
  assert.doesNotMatch(source, /process\.env\.(?:DB_DATABASE|ALLOW_MYSQL_ACCEPTANCE_WRITES)\s*=/)
})

test('lead-enrichment MySQL fixture runner guards before importing DB-dependent fixture modules', async () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', enrichmentFixtureRunnerEntry.pathname], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      DB_DATABASE: 'business',
      ALLOW_MYSQL_ACCEPTANCE_WRITES: '1',
    },
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /requires ALLOW_MYSQL_ACCEPTANCE_WRITES=1 with a dedicated test\/acceptance MySQL database/)

  const source = await readFile(enrichmentFixtureRunnerEntry, 'utf8')
  const guard = source.indexOf("assertIsolatedMysqlAcceptanceDatabase('leadEnrichmentMysqlFixtureAcceptance')")
  const fixtureImport = source.indexOf("import('./leadEnrichmentMysqlFixtureAcceptance.js')")
  assert.ok(guard >= 0 && fixtureImport > guard, 'write guard must run before DB-dependent fixture modules are imported')
  assert.doesNotMatch(source, /from ['"]\.\.\/db\//)
  assert.doesNotMatch(source, /process\.env\.(?:DB_DATABASE|ALLOW_MYSQL_ACCEPTANCE_WRITES)\s*=/)

  const acceptanceSource = await readFile(new URL('../src/scripts/leadEnrichmentMysqlAcceptance.ts', import.meta.url), 'utf8')
  assert.match(acceptanceSource, /runScript\('server\/src\/scripts\/leadEnrichmentMysqlFixtureRunner\.ts'/)
  assert.doesNotMatch(acceptanceSource, /runScript\('server\/src\/scripts\/leadEnrichmentMysqlFixtureAcceptance\.ts'/)
})
