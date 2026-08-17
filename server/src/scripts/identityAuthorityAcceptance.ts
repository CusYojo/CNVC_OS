import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { identityRepositories } from '../repositories/index.js'

const checks: string[] = []
function assert(condition: unknown, check: string): asserts condition {
  if (!condition) throw new Error(check)
  checks.push(check)
}

async function filesUnder(root: string): Promise<string[]> {
  const result: string[] = []
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (/\.(?:ts|tsx)$/.test(entry.name)) result.push(absolute)
    }
  }
  await walk(root)
  return result
}

async function main() {
  const userTable = mysqlTableName('users')
  const [tableRows] = await pool.query<Array<RowDataPacket & { TABLE_NAME: string }>>(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' AND TABLE_NAME IN (?,?,?,?,?)`,
    [mysqlConfig.database, userTable, mysqlTableName('iam_users'), mysqlTableName('legacy_users'), mysqlTableName('mock_users'), mysqlTableName('accounts')],
  )
  const presentTables = new Set(tableRows.map((row) => String(row.TABLE_NAME)))
  assert(presentTables.has(userTable), 'physical-users-table-is-the-iam-authority')
  assert(
    [...presentTables].every((name) => name === userTable),
    'no-iam-users-legacy-users-mock-users-or-accounts-second-authority',
  )

  const [indexRows] = await pool.query<Array<RowDataPacket & { INDEX_NAME: string; COLUMN_NAME: string; NON_UNIQUE: number }>>(
    `SELECT INDEX_NAME,COLUMN_NAME,NON_UNIQUE FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX`,
    [mysqlConfig.database, userTable],
  )
  assert(indexRows.some((row) => row.COLUMN_NAME === 'email' && Number(row.NON_UNIQUE) === 0), 'users-email-has-database-unique-authority')
  const [userIntegrityRows] = await pool.query<Array<RowDataPacket & {
    total: number; duplicate_emails: number; invalid_statuses: number; invalid_ids: number
  }>>(
    `SELECT COUNT(*) AS total,
       (SELECT COUNT(*) FROM (SELECT LOWER(TRIM(email)) normalized FROM ${quoteMysqlIdentifier(userTable)} GROUP BY normalized HAVING COUNT(*)>1) duplicates) AS duplicate_emails,
       SUM(status NOT IN ('启用','禁用')) AS invalid_statuses,
       SUM(id NOT REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') AS invalid_ids
     FROM ${quoteMysqlIdentifier(userTable)}`,
  )
  const integrity = userIntegrityRows[0]
  assert(Number(integrity?.duplicate_emails || 0) === 0, 'normalized-user-email-collisions-absent')
  assert(Number(integrity?.invalid_statuses || 0) === 0 && Number(integrity?.invalid_ids || 0) === 0, 'user-status-and-stable-id-contract-valid')

  const [foreignKeys] = await pool.query<Array<RowDataPacket & { TABLE_NAME: string; COLUMN_NAME: string }>>(
    `SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME=?
      ORDER BY TABLE_NAME,COLUMN_NAME`,
    [mysqlConfig.database, mysqlConfig.database, userTable],
  )
  assert(foreignKeys.length >= 40, 'all-identity-domains-reference-one-users-table')
  let orphanedReferences = 0
  for (const foreignKey of foreignKeys) {
    if (!/^[A-Za-z0-9_]+$/.test(foreignKey.TABLE_NAME) || !/^[A-Za-z0-9_]+$/.test(foreignKey.COLUMN_NAME)) {
      throw new Error('unsafe identity foreign-key metadata')
    }
    const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) AS count FROM ${quoteMysqlIdentifier(foreignKey.TABLE_NAME)} child
        LEFT JOIN ${quoteMysqlIdentifier(userTable)} authority
          ON authority.id=child.${quoteMysqlIdentifier(foreignKey.COLUMN_NAME)}
       WHERE child.${quoteMysqlIdentifier(foreignKey.COLUMN_NAME)} IS NOT NULL AND authority.id IS NULL`,
    )
    orphanedReferences += Number(rows[0]?.count || 0)
  }
  assert(orphanedReferences === 0, 'all-users-foreign-key-references-have-authority-records')

  const [sessionRows] = await pool.query<Array<RowDataPacket & { invalid: number }>>(
    `SELECT COUNT(*) AS invalid FROM ${quoteMysqlIdentifier(mysqlTableName('auth_sessions'))} sessions
      JOIN ${quoteMysqlIdentifier(userTable)} users ON users.id=sessions.user_id
     WHERE sessions.revoked_at IS NULL AND sessions.expires_at>NOW(3) AND users.status<>'启用'`,
  )
  assert(Number(sessionRows[0]?.invalid || 0) === 0, 'disabled-users-have-no-active-authoritative-session')
  const [ownerRows] = await pool.query<Array<RowDataPacket & { invalid: number }>>(
    `SELECT COUNT(*) AS invalid FROM ${quoteMysqlIdentifier(mysqlTableName('projects'))} projects
      WHERE projects.owner_user_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ${quoteMysqlIdentifier(mysqlTableName('project_members'))} members
         WHERE members.project_id=projects.id AND members.user_id=projects.owner_user_id AND members.member_role='owner'
      )`,
  )
  assert(Number(ownerRows[0]?.invalid || 0) === 0, 'project-owner-permission-binds-authoritative-user-id')

  const safeUsers = await identityRepositories.users.listSafe()
  assert(safeUsers.length > 0, 'identity-repository-returns-authoritative-users')
  assert(!safeUsers.some((user) => 'passwordHash' in user), 'safe-user-repository-never-returns-password-hash')

  const [authService, authMiddleware, socketService, authStore, runtimeSafety, mysqlIdentityRepository] = await Promise.all([
    readFile(path.resolve('server/src/services/authService.ts'), 'utf8'),
    readFile(path.resolve('server/src/middleware/requireAuth.ts'), 'utf8'),
    readFile(path.resolve('server/src/runtime/agentSocketService.ts'), 'utf8'),
    readFile(path.resolve('src/store/useAuthStore.ts'), 'utf8'),
    readFile(path.resolve('server/src/config/runtimeSafety.ts'), 'utf8'),
    readFile(path.resolve('server/src/repositories/mysql/mysqlIdentityRepository.ts'), 'utf8'),
  ])
  assert(
    /async listSafe\(\)[\s\S]*?passwordHash[\s\S]*?\.from\(users\)\.orderBy/.test(mysqlIdentityRepository) === false
      && /async listSafe\(\)[\s\S]*?id: users\.id[\s\S]*?email: users\.email[\s\S]*?\.from\(users\)\.orderBy/.test(mysqlIdentityRepository),
    'identity-repository-list-safe-is-unfiltered-and-excludes-password-hash',
  )
  assert(
    /identityRepositories\.users\.findById/.test(authService)
      && /identityRepositories\.users\.findByEmail/.test(authService),
    'login-cookie-and-legacy-window-reload-the-same-user-repository',
  )
  assert(/authenticateHttpRequest/.test(authMiddleware) && /assertRequestCsrf/.test(authMiddleware), 'rest-authentication-uses-authoritative-session-and-user')
  assert(/authenticateSessionToken/.test(socketService) && /reauthenticateSocket/.test(socketService), 'socket-authentication-reuses-authoritative-session-and-user')
  assert(/\/api\/auth\/me/.test(authStore) && !/localStorage|sessionStorage|persist\(/.test(authStore), 'browser-restores-user-from-server-session-without-local-authority')
  assert(
    /if \(legacyBearer\).*production legacy Bearer is disabled/s.test(runtimeSafety),
    'production-forbids-legacy-bearer-user-authority',
  )

  const runtimeFiles = (await Promise.all([
    filesUnder(path.resolve('server/src/routes')),
    filesUnder(path.resolve('server/src/services')),
    filesUnder(path.resolve('server/src/runtime')),
    filesUnder(path.resolve('server/src/middleware')),
  ])).flat()
  const directUserTableImports: string[] = []
  const mockIdentityImports: string[] = []
  for (const file of runtimeFiles) {
    const source = await readFile(file, 'utf8')
    if (/from ['"][^'"]*mock[^'"]*['"]/.test(source)) mockIdentityImports.push(path.relative(process.cwd(), file))
    const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:\.\.\/)+db\/schema\.js['"]/g)]
    if (imports.some((match) => match[1].split(',').map((name) => name.trim()).includes('users'))) {
      directUserTableImports.push(path.relative(process.cwd(), file))
    }
  }
  assert(mockIdentityImports.length === 0, 'runtime-has-no-mock-identity-imports')
  assert(directUserTableImports.length === 0, 'runtime-user-table-access-is-repository-only')
  const retiredMocksAbsent = await Promise.all([
    stat(path.resolve('server/src/mock/db.ts')).then(() => false, () => true),
    stat(path.resolve('src/mock/data.ts')).then(() => false, () => true),
  ])
  assert(retiredMocksAbsent.every(Boolean), 'retired-server-and-browser-user-fixtures-are-absent')

  const result = {
    ok: true,
    checks,
    physicalAuthority: 'users',
    conceptualAuthority: 'iam_users',
    users: Number(integrity?.total || 0),
    userForeignKeys: foreignKeys.length,
    orphanedUserReferences: orphanedReferences,
    directRuntimeUserTableImports: directUserTableImports.length,
    mockIdentityImports: mockIdentityImports.length,
    databaseConnectionIdentityExcluded: true,
    userIdentityValuesExcluded: true,
    noFixturesOrBusinessWrites: true,
  }
  const evidenceRoot = path.resolve('.runtime/migration-evidence/identity-authority')
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
  await chmod(evidenceRoot, 0o700)
  const reportPath = path.join(evidenceRoot, 'report.json')
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  await chmod(reportPath, 0o600)
  console.log(JSON.stringify(result))
  await pool.end()
}

main().catch(async (error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  await pool.end().catch(() => undefined)
  process.exitCode = 1
})
