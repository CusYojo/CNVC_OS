import assert from 'node:assert/strict'
import test from 'node:test'
import { assertIsolatedMysqlAcceptanceDatabase } from '../src/scripts/mysqlAcceptanceSafety.js'

function withAcceptanceEnvironment(
  values: { enabled?: string; database?: string },
  check: () => void,
): void {
  const previousEnabled = process.env.ALLOW_MYSQL_ACCEPTANCE_WRITES
  const previousDatabase = process.env.DB_DATABASE
  try {
    if (values.enabled == null) delete process.env.ALLOW_MYSQL_ACCEPTANCE_WRITES
    else process.env.ALLOW_MYSQL_ACCEPTANCE_WRITES = values.enabled
    if (values.database == null) delete process.env.DB_DATABASE
    else process.env.DB_DATABASE = values.database
    check()
  } finally {
    if (previousEnabled == null) delete process.env.ALLOW_MYSQL_ACCEPTANCE_WRITES
    else process.env.ALLOW_MYSQL_ACCEPTANCE_WRITES = previousEnabled
    if (previousDatabase == null) delete process.env.DB_DATABASE
    else process.env.DB_DATABASE = previousDatabase
  }
}

test('MySQL fixture acceptance rejects a production database even with explicit opt-in', () => {
  withAcceptanceEnvironment({ enabled: '1', database: 'sbl_fde' }, () => {
    assert.throws(
      () => assertIsolatedMysqlAcceptanceDatabase('fixtureAcceptance'),
      /dedicated test\/acceptance MySQL database/,
    )
  })
})

test('MySQL fixture acceptance rejects an isolated database without explicit opt-in', () => {
  withAcceptanceEnvironment({ database: 'sbl_acceptance' }, () => {
    assert.throws(
      () => assertIsolatedMysqlAcceptanceDatabase('fixtureAcceptance'),
      /ALLOW_MYSQL_ACCEPTANCE_WRITES=1/,
    )
  })
})

test('MySQL fixture acceptance permits only an explicitly enabled isolated database', () => {
  withAcceptanceEnvironment({ enabled: '1', database: 'sbl_acceptance' }, () => {
    assert.doesNotThrow(() => assertIsolatedMysqlAcceptanceDatabase('fixtureAcceptance'))
  })
})

