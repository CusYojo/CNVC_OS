import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { KNOWN_INSECURE_PASSWORDS } from '../security/passwordPolicy.js'

type UserRow = RowDataPacket & {
  id: string
  email: string
  name: string
  status: string
  passwordHash: string
  migratedFromPostgres: number
  rotationAuditCount: number
  lastRotationAt: Date | string | null
}

const strict = process.argv.includes('--strict')
const rosterPath = path.resolve(process.env.WEAK_PASSWORD_ROTATION_ROSTER_FILE
  || '.runtime/migration-decisions/weak-password-rotation-roster.json')
const evidenceDirectory = path.resolve('.runtime/migration-evidence/password-rotation-roster')

function table(name: string) {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function bcryptCost(hash: string) {
  try { return bcrypt.getRounds(hash) } catch { return null }
}

async function assertSafeExistingTarget(target: string) {
  try {
    const stat = await lstat(target)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error('WEAK_PASSWORD_ROSTER_TARGET_MUST_BE_OWNER_ONLY_REGULAR_FILE')
    }
    await readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function atomicOwnerOnlyWrite(target: string, value: string) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  await assertSafeExistingTarget(target)
  const temporary = `${target}.tmp-${process.pid}`
  await writeFile(temporary, value, { mode: 0o600, flag: 'wx' })
  await rename(temporary, target)
}

async function main() {
  const [rows] = await pool.query<UserRow[]>(`
    SELECT u.id,u.email,u.name,u.status,u.password_hash passwordHash,
      EXISTS(SELECT 1 FROM ${table('iam_user_mappings')} m
        WHERE m.target_user_id=u.id AND m.source_system='postgres_dump') migratedFromPostgres,
      (SELECT COUNT(*) FROM ${table('audit_logs')} a
        WHERE a.action='离线强制轮换密码' AND BINARY a.target=BINARY u.email) rotationAuditCount,
      (SELECT MAX(a.created_at) FROM ${table('audit_logs')} a
        WHERE a.action='离线强制轮换密码' AND BINARY a.target=BINARY u.email) lastRotationAt
    FROM ${table('users')} u ORDER BY u.email,u.id`)
  const accounts = []
  for (const row of rows) {
    const weak = (await Promise.all(KNOWN_INSECURE_PASSWORDS
      .map((password) => bcrypt.compare(password, row.passwordHash).catch(() => false)))).some(Boolean)
    accounts.push({
      userId: row.id,
      email: row.email,
      displayName: row.name,
      status: row.status,
      migratedFromPostgres: Boolean(row.migratedFromPostgres),
      passwordHashFingerprint: sha256(row.passwordHash),
      bcryptCost: bcryptCost(row.passwordHash),
      weakPasswordDetected: weak,
      rotationRequired: weak,
      rotationAuditCount: Number(row.rotationAuditCount || 0),
      lastRotationAt: row.lastRotationAt instanceof Date ? row.lastRotationAt.toISOString()
        : typeof row.lastRotationAt === 'string' ? new Date(row.lastRotationAt).toISOString() : null,
      rotationCommand: `npm run rotate:user-password -- --email ${row.email}`,
    })
  }
  const weakAccounts = accounts.filter((account) => account.rotationRequired)
  const migratedAccounts = accounts.filter((account) => account.migratedFromPostgres)
  const generatedAt = new Date().toISOString()
  const roster = {
    schemaVersion: '1.0', generatedAt,
    securityBoundary: {
      passwordsStored: false,
      fullBcryptHashesStored: false,
      ownerOnlyFileRequired: true,
      passwordInputMethod: 'hidden interactive terminal or controlled two-line stdin only',
    },
    summary: {
      targetAccounts: accounts.length,
      migratedAccounts: migratedAccounts.length,
      weakAccounts: weakAccounts.length,
      readyAccounts: accounts.length - weakAccounts.length,
    },
    accountSetSha256: sha256(JSON.stringify(accounts.map((account) => account.userId).sort())),
    accounts,
  }
  await atomicOwnerOnlyWrite(rosterPath, `${JSON.stringify(roster, null, 2)}\n`)
  const evidence = {
    schemaVersion: '1.0', generatedAt, ok: weakAccounts.length === 0,
    strict, targetAccounts: accounts.length, migratedAccounts: migratedAccounts.length,
    weakAccounts: weakAccounts.length, readyAccounts: accounts.length - weakAccounts.length,
    accountSetSha256: roster.accountSetSha256,
    privateRosterMode: '0600', passwordsStored: false, fullBcryptHashesStored: false,
    databaseWrites: 0,
  }
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
  await writeFile(path.join(evidenceDirectory, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify(evidence))
  if (strict && weakAccounts.length > 0) process.exitCode = 2
}

await main().finally(async () => pool.end())
