export function assertIsolatedMysqlAcceptanceDatabase(scriptName: string): void {
  const explicitOptIn = process.env.ALLOW_MYSQL_ACCEPTANCE_WRITES === '1'
  const databaseName = process.env.DB_DATABASE?.trim() ?? ''
  const isolatedDatabase = /(?:^|[_-])(?:test|tests|acceptance)(?:[_-]|$)/i.test(databaseName)

  if (!explicitOptIn || !isolatedDatabase) {
    throw new Error(
      `${scriptName} writes acceptance fixtures and requires `
      + 'ALLOW_MYSQL_ACCEPTANCE_WRITES=1 with a dedicated test/acceptance MySQL database',
    )
  }
}

