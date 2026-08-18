import type { TestOptions } from 'node:test'

const explicitOptIn = process.env.ALLOW_MYSQL_INTEGRATION_TESTS === '1'
const databaseName = process.env.DB_DATABASE?.trim() ?? ''
const isolatedDatabase = /(?:^|[_-])(?:test|tests|acceptance)(?:[_-]|$)/i.test(databaseName)

export const mysqlIntegrationTestOptions: TestOptions = explicitOptIn && isolatedDatabase
  ? {}
  : {
      skip: 'requires ALLOW_MYSQL_INTEGRATION_TESTS=1 and a dedicated test/acceptance MySQL database',
    }

