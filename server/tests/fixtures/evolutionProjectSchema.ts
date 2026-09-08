import assert from 'node:assert/strict'
import { SQL } from 'drizzle-orm'
import { getTableConfig, MySqlDialect } from 'drizzle-orm/mysql-core'
import { escape, format } from 'mysql2'

/** Isolated authorization fixture only: column definitions come from the current application schema. */
export async function prepareEvolutionProjectSchema() {
  assert.equal(process.env.DB_HOST, '127.0.0.1')
  assert.equal(process.env.DB_PORT, '43318')
  assert.equal(process.env.DB_DATABASE, 'evolution_isolated_test')
  assert.equal(process.env.DB_FREFIX, 'evo_test_')
  const { pool } = await import('../../src/db/client.js')
  const schema = await import('../../src/db/schema.js')
  const dialect = new MySqlDialect()
  const quote = (name: string) => { assert.match(name, /^[a-zA-Z0-9_]+$/); return '`' + name + '`' }
  for (const table of [schema.projects, schema.projectMembers, schema.projectDutyAssignments, schema.aiTasks, schema.auditLogs,
    schema.roles, schema.permissions, schema.rolePermissions, schema.userRoles, schema.userDepartments]) {
    const config = getTableConfig(table)
    assert.ok(config.name.startsWith('evo_test_'))
    const columns = config.columns.map(column => {
      let defaultSql = ''
      if (column.default !== undefined) {
        const value = column.default
        if (value instanceof SQL) {
          const query = dialect.sqlToQuery(value)
          defaultSql = format(query.sql, query.params)
        } else defaultSql = escape(typeof value === 'object' && value !== null ? JSON.stringify(value) : value)
      }
      return `${quote(column.name)} ${column.getSQLType()}${column.notNull ? ' NOT NULL' : ''}${defaultSql ? ` DEFAULT ${defaultSql}` : ''}${column.primary ? ' PRIMARY KEY' : ''}`
    })
    await pool.query(`CREATE TABLE IF NOT EXISTS ${quote(config.name)} (${columns.join(',')})`)
  }
}
