import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

test('migrations use explicit timestamp defaults on their dedicated connection', async () => {
  const source = await readFile(new URL('../src/db/migrate.ts', import.meta.url), 'utf8')
  const setup = source.indexOf("await connection.query('SET SESSION explicit_defaults_for_timestamp = ON')")
  const migrate = source.indexOf('await migrate(migrationDb')
  assert.ok(setup >= 0 && setup < migrate, 'nullable timestamp DDL must work when the server uses legacy defaults')
  assert.match(source, /SELECT @@session\.explicit_defaults_for_timestamp AS enabled/)
  assert.match(source, /await connection\.query\('SET SESSION explicit_defaults_for_timestamp = OFF'\)/)
})

async function runMigration(options: { migrationFails?: boolean; cleanupFails?: boolean; restoreFails?: boolean; originallyEnabled?: boolean } = {}) {
  const source = await readFile(new URL('../src/db/migrate.ts', import.meta.url), 'utf8')
  const syntax = ts.createSourceFile('migrate.ts', source, ts.ScriptTarget.Latest, true)
  const subject = syntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'applySchemaMigrations')
  assert.ok(subject)
  const compiled = ts.transpileModule(subject.getText(syntax), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const calls: string[] = []
  const connection = {
    async query(sql: string) {
      calls.push(sql)
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]]
      if (sql.includes('@@session')) return [[{ enabled: options.originallyEnabled ? 1 : 0 }]]
      if (sql.endsWith('= OFF') && options.restoreFails) throw new Error('restore failed')
      return [[]]
    },
    release() { calls.push('release') },
    destroy() { calls.push('destroy') },
  }
  const migrate = runInNewContext(`${compiled}\nexports.applySchemaMigrations`, {
    exports: {}, createHash, verifyMySqlRuntime: async () => {}, pool: { getConnection: async () => connection },
    mysqlConfig: { database: 'test', tablePrefix: 'sbl_' }, mysqlTableName: (name: string) => `sbl_${name}`,
    prepareMigrationsFolder: async () => ({ folder: '/test', cleanup: async () => {
      calls.push('cleanup'); if (options.cleanupFails) throw new Error('cleanup failed')
    } }),
    drizzle: () => ({}), migrate: async () => { calls.push('migrate'); if (options.migrationFails) throw new Error('migration failed') },
    console: { log() {} },
  })
  let error: unknown
  try { await migrate() } catch (cause) { error = cause }
  return { calls, error }
}

for (const [name, options, expectedError] of [
  ['success', {}, undefined],
  ['migration failure', { migrationFails: true }, 'migration failed'],
  ['temporary directory cleanup failure', { cleanupFails: true }, 'cleanup failed'],
] as const) {
  test(`migration restores a pooled connection after ${name}`, async () => {
    const { calls, error } = await runMigration(options)
    assert.equal(error instanceof Error ? error.message : error, expectedError)
    assert.deepEqual(calls.slice(-3), ['SELECT RELEASE_LOCK(?)', 'SET SESSION explicit_defaults_for_timestamp = OFF', 'release'])
    assert.ok(calls.indexOf('SET SESSION explicit_defaults_for_timestamp = ON') < calls.indexOf('migrate'))
  })
}

test('migration destroys a connection whose original timestamp setting cannot be restored', async () => {
  const { calls, error } = await runMigration({ restoreFails: true })
  assert.equal((error as Error).message, 'restore failed')
  assert.equal(calls.at(-1), 'destroy')
  assert.ok(!calls.includes('release'))
})

test('migration preserves an originally enabled timestamp setting', async () => {
  const { calls, error } = await runMigration({ originallyEnabled: true })
  assert.equal(error, undefined)
  assert.ok(!calls.includes('SET SESSION explicit_defaults_for_timestamp = OFF'))
  assert.equal(calls.at(-1), 'release')
})
