import { createHash } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'

const forbiddenRuntimePrivileges = [
  'ALL PRIVILEGES',
  'GRANT OPTION',
  'CREATE USER',
  'CREATE',
  'DROP',
  'ALTER',
  'INDEX',
  'REFERENCES',
  'EXECUTE',
  'EVENT',
  'TRIGGER',
  'LOCK TABLES',
  'SHOW DATABASES',
  'RELOAD',
  'PROCESS',
  'SHUTDOWN',
  'SUPER',
  'FILE',
  'REPLICATION SLAVE',
  'REPLICATION CLIENT',
  'SYSTEM_USER',
  'ROLE_ADMIN',
] as const

function runtimeGrantViolations(grants: string[]): string[] {
  const violations: string[] = forbiddenRuntimePrivileges.filter((privilege) => (
    grants.some((grant) => privilege === 'GRANT OPTION'
      ? /\bWITH\s+GRANT\s+OPTION\b/i.test(grant)
      : new RegExp(
          `(?:GRANT|,)\\s*${privilege.replaceAll(' ', '\\s+')}(?:\\s*,|\\s+ON)`,
          'i',
        ).test(grant))
  ))
  if (grants.some((grant) => (
    /\sON\s+\*\.\*/i.test(grant)
    && !/^GRANT\s+USAGE\s+ON\s+\*\.\*/i.test(grant.trim())
  ))) violations.push('GLOBAL_SCOPE')
  return [...new Set(violations)]
}

function identityHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

const safeFixture = runtimeGrantViolations([
  "GRANT USAGE ON *.* TO 'runtime_create_name'@'%'",
  "GRANT SELECT, INSERT, UPDATE, DELETE ON `fixture`.* TO 'runtime_create_name'@'%'",
])
const unsafeFixture = runtimeGrantViolations([
  "GRANT CREATE USER, PROCESS ON *.* TO 'unsafe'@'%' WITH GRANT OPTION",
])
if (safeFixture.length || !['CREATE USER', 'PROCESS', 'GRANT OPTION', 'GLOBAL_SCOPE'].every((item) => unsafeFixture.includes(item))) {
  throw new Error('[mysql privilege audit] grant parser self-test failed')
}

try {
  const [identityRows] = await pool.query<RowDataPacket[]>('SELECT CURRENT_USER() AS principal')
  const principal = String(identityRows[0]?.principal || 'unknown')
  const [grantRows] = await pool.query<RowDataPacket[]>('SHOW GRANTS FOR CURRENT_USER()')
  const grants = grantRows.map((row) => String(Object.values(row)[0] || ''))
  const violations = runtimeGrantViolations(grants)
  const result = {
    ok: violations.length === 0,
    principalSha256: identityHash(principal),
    principalExcluded: true,
    runtimeAccount: 'DB_USERNAME',
    violations,
    grantCount: grants.length,
    parserSelfTest: true,
    remediation: 'Use a DML-only DB_USERNAME at runtime and pass DDL credentials only through root-owned DB_MIGRATION_ENV_FILE during deploy.',
  }
  console.log(JSON.stringify(result))
  if (!result.ok) process.exitCode = 2
} finally {
  await pool.end()
}
