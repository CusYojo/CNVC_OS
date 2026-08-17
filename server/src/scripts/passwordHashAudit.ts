import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { KNOWN_INSECURE_PASSWORDS } from '../security/passwordPolicy.js'

type SourceUser = { id: string; email: string; passwordHash: string }
type TargetUser = RowDataPacket & { id: string; email: string; passwordHash: string }
type Mapping = RowDataPacket & { sourceUserId: string; sourceEmail: string; targetUserId: string }

function table(name: string) {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

function decodeCopyValue(value: string) {
  if (value === '\\N') return ''
  return value.replace(/\\([\\btnrfv])/g, (_match, escaped: string) => ({
    '\\': '\\', b: '\b', t: '\t', n: '\n', r: '\r', f: '\f', v: '\v',
  })[escaped] || escaped)
}

function parseUsersCopy(sql: string): SourceUser[] {
  const header = /^COPY public\.users \(([^)]+)\) FROM stdin;$/m.exec(sql)
  if (!header || header.index == null) throw new Error('[password audit] public.users COPY block is missing')
  const columns = header[1].split(',').map((value) => value.trim())
  const idIndex = columns.indexOf('id')
  const emailIndex = columns.indexOf('email')
  const hashIndex = columns.indexOf('password_hash')
  if ([idIndex, emailIndex, hashIndex].some((index) => index < 0)) {
    throw new Error('[password audit] users COPY block is missing id/email/password_hash')
  }
  const bodyStart = sql.indexOf('\n', header.index + header[0].length) + 1
  const bodyEnd = sql.indexOf('\n\\.\n', bodyStart)
  if (bodyStart < 1 || bodyEnd < bodyStart) throw new Error('[password audit] users COPY terminator is missing')
  return sql.slice(bodyStart, bodyEnd).split('\n').filter(Boolean).map((line) => {
    const fields = line.split('\t').map(decodeCopyValue)
    return { id: fields[idIndex], email: fields[emailIndex], passwordHash: fields[hashIndex] }
  })
}

function bcryptCost(hash: string): number | null {
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) return null
  try {
    const rounds = bcrypt.getRounds(hash)
    return rounds >= 10 && rounds <= 15 ? rounds : null
  } catch {
    return null
  }
}

async function main() {
  const dumpPath = path.resolve(process.env.POSTGRES_DUMP_FILE || 'cybernaut_mvp_dump.sql')
  const dump = await readFile(dumpPath, 'utf8')
  const dumpSha256 = createHash('sha256').update(dump).digest('hex')
  const sourceUsers = parseUsersCopy(dump)
  const [targetUsers, mappings] = await Promise.all([
    pool.query<TargetUser[]>(`SELECT id,email,password_hash AS passwordHash FROM ${table('users')}`).then(([rows]) => rows),
    pool.query<Mapping[]>(`SELECT source_user_id AS sourceUserId,source_email AS sourceEmail,target_user_id AS targetUserId
      FROM ${table('iam_user_mappings')} WHERE source_system='postgres_dump'`).then(([rows]) => rows),
  ])
  const sourceById = new Map(sourceUsers.map((user) => [user.id, user]))
  const targetById = new Map(targetUsers.map((user) => [user.id, user]))
  const violations: string[] = []
  const warnings: string[] = []
  let weakSourceUsers = 0
  let weakTargetUsers = 0
  const costs = new Map<number, number>()
  for (const user of sourceUsers) {
    const cost = bcryptCost(user.passwordHash)
    if (cost == null) violations.push(`source:${user.id}:invalid-or-plaintext-hash`)
    else costs.set(cost, (costs.get(cost) || 0) + 1)
    if ((await Promise.all(KNOWN_INSECURE_PASSWORDS.map((password) => bcrypt.compare(password, user.passwordHash)))).some(Boolean)) {
      weakSourceUsers += 1
    }
  }
  for (const user of targetUsers) {
    if (bcryptCost(user.passwordHash) == null) violations.push(`target:${user.id}:invalid-or-plaintext-hash`)
    if ((await Promise.all(KNOWN_INSECURE_PASSWORDS.map((password) => bcrypt.compare(password, user.passwordHash)))).some(Boolean)) {
      weakTargetUsers += 1
      violations.push(`target:${user.id}:known-insecure-password`)
    }
  }
  for (const mapping of mappings) {
    const source = sourceById.get(mapping.sourceUserId)
    const target = targetById.get(mapping.targetUserId)
    if (!source) violations.push(`mapping:${mapping.sourceUserId}:source-missing`)
    else if (!target) violations.push(`mapping:${mapping.sourceUserId}:target-missing`)
    else {
      if (source.passwordHash !== target.passwordHash) warnings.push(`mapping:${mapping.sourceUserId}:hash-changed-valid-bcrypt`)
      if (source.email.toLowerCase() !== mapping.sourceEmail.toLowerCase()) violations.push(`mapping:${mapping.sourceUserId}:email-mismatch`)
      // A negative comparison proves bcryptjs can parse and execute the migrated legacy hash.
      if (await bcrypt.compare(`not-the-password-${mapping.sourceUserId}`, target.passwordHash)) {
        violations.push(`mapping:${mapping.sourceUserId}:unexpected-negative-password-match`)
      }
    }
  }
  if (mappings.length !== sourceUsers.length) violations.push(`mapping-count:${mappings.length}/${sourceUsers.length}`)
  const issueCode = (value: string) => {
    if (value.includes('known-insecure-password')) return 'KNOWN_INSECURE_PASSWORD'
    if (value.includes('invalid-or-plaintext-hash')) return 'INVALID_OR_PLAINTEXT_HASH'
    if (value.includes('source-missing')) return 'MAPPING_SOURCE_MISSING'
    if (value.includes('target-missing')) return 'MAPPING_TARGET_MISSING'
    if (value.includes('email-mismatch')) return 'MAPPING_EMAIL_MISMATCH'
    if (value.includes('unexpected-negative-password-match')) return 'UNEXPECTED_NEGATIVE_PASSWORD_MATCH'
    if (value.startsWith('mapping-count:')) return 'MAPPING_COUNT_MISMATCH'
    if (value.includes('hash-changed-valid-bcrypt')) return 'HASH_CHANGED_VALID_BCRYPT'
    return 'PASSWORD_AUDIT_ISSUE'
  }
  const counts = (values: string[]) => Object.fromEntries([...new Set(values.map(issueCode))].sort().map((code) => [
    code, values.filter((value) => issueCode(value) === code).length,
  ]))
  const summary = {
    dumpSha256,
    sourceUsers: sourceUsers.length,
    targetUsers: targetUsers.length,
    mappedUsers: mappings.length,
    exactHashMatches: mappings.filter((mapping) => {
      const source = sourceById.get(mapping.sourceUserId)
      const target = targetById.get(mapping.targetUserId)
      return source && target && source.passwordHash === target.passwordHash
    }).length,
    bcryptCosts: Object.fromEntries([...costs.entries()].sort((left, right) => left[0] - right[0])),
    plaintextOrInvalid: violations.filter((value) => value.includes('invalid-or-plaintext')).length,
    weakSourceUsers,
    weakTargetUsers,
    warningCount: warnings.length,
    warningCounts: counts(warnings),
    violationCount: violations.length,
    violationCounts: counts(violations),
    pathsExcluded: true,
    identitiesExcluded: true,
    passwordsExcluded: true,
    bcryptHashesExcluded: true,
    databaseWrites: 0,
  }
  console.log(JSON.stringify({ ok: violations.length === 0, ...summary }))
  if (violations.length) process.exitCode = 2
}

await main().finally(async () => pool.end())
