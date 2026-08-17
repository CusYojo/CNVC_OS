import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { quoteMysqlIdentifier } from '../db/config.js'

export const MYSQL_RUNTIME_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const
export const MYSQL_MIGRATION_PRIVILEGES = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'INDEX', 'REFERENCES',
] as const

export type MysqlAccountSpec = {
  username: string
  host: string
  password: string
}

export type MysqlAccountSeparationSpec = {
  database: string
  runtime: MysqlAccountSpec
  migration: MysqlAccountSpec
}

function validateAccountPart(value: string, label: string, maximum: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || !/^[A-Za-z0-9_.:%-]+$/.test(normalized)) {
    throw new Error(`[mysql-account] ${label} contains unsafe characters or length`)
  }
  return normalized
}

function validatePassword(value: string, label: string): void {
  if (value.length < 20 || value.length > 255) throw new Error(`[mysql-account] ${label} must contain 20-255 characters`)
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length
  if (classes < 3) throw new Error(`[mysql-account] ${label} must contain at least three character classes`)
}

export function validatedAccountSpec(spec: MysqlAccountSpec, label: string): MysqlAccountSpec {
  const username = validateAccountPart(spec.username, `${label} username`, 32)
  const host = validateAccountPart(spec.host, `${label} host`, 255)
  validatePassword(spec.password, `${label} password`)
  return { username, host, password: spec.password }
}

export function mysqlAccountLiteral(spec: Pick<MysqlAccountSpec, 'username' | 'host'>): string {
  const username = validateAccountPart(spec.username, 'username', 32)
  const host = validateAccountPart(spec.host, 'host', 255)
  return `'${username}'@'${host}'`
}

export function mysqlAccountProvisioningPreview(spec: MysqlAccountSeparationSpec): string[] {
  const runtime = validatedAccountSpec(spec.runtime, 'runtime')
  const migration = validatedAccountSpec(spec.migration, 'migration')
  if (runtime.username === migration.username && runtime.host === migration.host) {
    throw new Error('[mysql-account] runtime and migration accounts must be different')
  }
  const database = quoteMysqlIdentifier(spec.database)
  const statements = []
  for (const [account, privileges] of [
    [runtime, MYSQL_RUNTIME_PRIVILEGES],
    [migration, MYSQL_MIGRATION_PRIVILEGES],
  ] as const) {
    const literal = mysqlAccountLiteral(account)
    statements.push(`CREATE USER IF NOT EXISTS ${literal} IDENTIFIED BY <redacted-password>`)
    statements.push(`ALTER USER ${literal} IDENTIFIED BY <redacted-password>`)
    statements.push(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${literal}`)
    statements.push(`GRANT ${privileges.join(', ')} ON ${database}.* TO ${literal}`)
  }
  return statements
}

async function grantsFor(connection: PoolConnection, account: MysqlAccountSpec): Promise<string[]> {
  const [rows] = await connection.query<RowDataPacket[]>(`SHOW GRANTS FOR ${mysqlAccountLiteral(account)}`)
  return rows.map((row) => String(Object.values(row)[0] || ''))
}

export function assessMysqlGrants(
  grants: string[],
  database: string,
  required: readonly string[],
  forbidden: readonly string[],
): { ok: boolean; requiredMissing: string[]; forbiddenPresent: string[]; globalPrivilegePresent: boolean } {
  const upper = grants.map((grant) => grant.toUpperCase())
  const schemaMarker = `ON \`${database.toUpperCase()}\`.*`
  const schemaGrants = upper.filter((grant) => grant.includes(schemaMarker))
  const requiredMissing = required.filter((privilege) => !schemaGrants.some((grant) => (
    new RegExp(`(?:GRANT|,)\\s*${privilege}(?:\\s*,|\\s+ON)`).test(grant)
  )))
  const forbiddenPresent = forbidden.filter((privilege) => upper.some((grant) => (
    new RegExp(`(?:GRANT|,)\\s*${privilege}(?:\\s*,|\\s+ON)`).test(grant)
  )))
  const globalPrivilegePresent = upper.some((grant) => grant.includes(' ON *.*') && !grant.startsWith('GRANT USAGE ON *.*'))
  return {
    ok: requiredMissing.length === 0 && forbiddenPresent.length === 0 && !globalPrivilegePresent,
    requiredMissing,
    forbiddenPresent,
    globalPrivilegePresent,
  }
}

export async function provisionSeparatedMysqlAccounts(connection: PoolConnection, input: MysqlAccountSeparationSpec) {
  const runtime = validatedAccountSpec(input.runtime, 'runtime')
  const migration = validatedAccountSpec(input.migration, 'migration')
  if (runtime.username === migration.username && runtime.host === migration.host) {
    throw new Error('[mysql-account] runtime and migration accounts must be different')
  }
  const database = quoteMysqlIdentifier(input.database)
  for (const [account, privileges] of [
    [runtime, MYSQL_RUNTIME_PRIVILEGES],
    [migration, MYSQL_MIGRATION_PRIVILEGES],
  ] as const) {
    const literal = mysqlAccountLiteral(account)
    await connection.query(`CREATE USER IF NOT EXISTS ${literal} IDENTIFIED BY ?`, [account.password])
    await connection.query(`ALTER USER ${literal} IDENTIFIED BY ?`, [account.password])
    await connection.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${literal}`)
    await connection.query(`GRANT ${privileges.join(', ')} ON ${database}.* TO ${literal}`)
  }
  const [runtimeGrants, migrationGrants] = await Promise.all([
    grantsFor(connection, runtime),
    grantsFor(connection, migration),
  ])
  const runtimeAssessment = assessMysqlGrants(
    runtimeGrants,
    input.database,
    MYSQL_RUNTIME_PRIVILEGES,
    MYSQL_MIGRATION_PRIVILEGES.filter((privilege) => !MYSQL_RUNTIME_PRIVILEGES.includes(privilege as typeof MYSQL_RUNTIME_PRIVILEGES[number])),
  )
  const migrationAssessment = assessMysqlGrants(
    migrationGrants,
    input.database,
    MYSQL_MIGRATION_PRIVILEGES,
    ['CREATE USER', 'GRANT OPTION', 'FILE', 'PROCESS', 'RELOAD', 'REPLICATION CLIENT', 'REPLICATION SLAVE'],
  )
  if (!runtimeAssessment.ok || !migrationAssessment.ok) {
    throw new Error(`[mysql-account] grant verification failed: ${JSON.stringify({ runtimeAssessment, migrationAssessment })}`)
  }
  return {
    runtime: {
      principal: `${runtime.username}@${runtime.host}`,
      privileges: [...MYSQL_RUNTIME_PRIVILEGES],
      grantCount: runtimeGrants.length,
      assessment: runtimeAssessment,
    },
    migration: {
      principal: `${migration.username}@${migration.host}`,
      privileges: [...MYSQL_MIGRATION_PRIVILEGES],
      grantCount: migrationGrants.length,
      assessment: migrationAssessment,
    },
  }
}

export async function dropMysqlAccount(connection: PoolConnection, account: Pick<MysqlAccountSpec, 'username' | 'host'>) {
  await connection.query(`DROP USER IF EXISTS ${mysqlAccountLiteral(account)}`)
}
