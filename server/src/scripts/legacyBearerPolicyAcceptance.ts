import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { and, eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { auditLogs, authLegacyBearerPolicy, users } from '../db/schema.js'
import { resolveLegacyBearerPolicy } from '../config/legacyBearerPolicy.js'

const managedKeys = [
  'JWT_SECRET', 'AUTH_ALLOW_LEGACY_BEARER',
  'AUTH_LEGACY_BEARER_CUTOFF', 'AUTH_LEGACY_BEARER_ALLOWED_USER_IDS',
] as const
const originalEnvironment = Object.fromEntries(managedKeys.map((key) => [key, process.env[key]]))

async function main() {
  await ensureSchema()
  const [originalControl] = await db.select().from(authLegacyBearerPolicy)
    .where(eq(authLegacyBearerPolicy.id, 'global')).limit(1)
  assert(originalControl)
  const approvedUserId = randomUUID()
  const outsideUserId = randomUUID()
  process.env.JWT_SECRET = 'legacy-bearer-acceptance-jwt-secret-0123456789abcdef'
  process.env.AUTH_ALLOW_LEGACY_BEARER = 'true'
  process.env.AUTH_LEGACY_BEARER_CUTOFF = new Date(Date.now() + 60 * 60_000).toISOString()
  process.env.AUTH_LEGACY_BEARER_ALLOWED_USER_IDS = approvedUserId
  await db.insert(users).values([{
    id: approvedUserId,
    email: `legacy-approved-${approvedUserId}@example.invalid`,
    name: '旧 JWT 批准验收管理员',
    role: '系统管理员',
    department: '迁移验收',
    passwordHash: await bcrypt.hash(randomUUID(), 10),
  }, {
    id: outsideUserId,
    email: `legacy-outside-${outsideUserId}@example.invalid`,
    name: '旧 JWT 非白名单用户',
    role: '投资经理',
    department: '迁移验收',
    passwordHash: await bcrypt.hash(randomUUID(), 10),
  }])
  try {
    await db.update(authLegacyBearerPolicy).set({
      revokedBefore: new Date(Date.now() - 5_000),
      reason: 'legacy bearer acceptance baseline',
      updatedBy: null,
      updatedAt: new Date(),
    }).where(eq(authLegacyBearerPolicy.id, 'global'))
    const auth = await import('../services/authService.js')
    const approvedPayload = {
      uid: approvedUserId,
      email: `legacy-approved-${approvedUserId}@example.invalid`,
      name: '旧 JWT 批准验收管理员',
      role: '系统管理员',
      department: '迁移验收',
    }
    const approvedToken = auth.signToken(approvedPayload)
    const authenticated = await auth.authenticateToken(approvedToken)
    assert.equal(authenticated.uid, approvedUserId)
    assert.equal(auth.legacyBearerAllowedForUser(approvedUserId), true)

    const outsideToken = auth.signToken({ ...approvedPayload, uid: outsideUserId })
    await assert.rejects(() => auth.authenticateToken(outsideToken), (error: unknown) =>
      (error as { code?: string }).code === 'AUTH_LEGACY_SCOPE_DENIED')

    await auth.auditLegacyBearerUse({ user: authenticated, surface: 'rest', ipAddress: '127.0.0.1' })
    const auditBefore = await db.select().from(auditLogs).where(and(
      eq(auditLogs.userId, approvedUserId),
      eq(auditLogs.action, '旧 JWT 迁移窗口使用'),
    ))
    assert.equal(auditBefore.length, 1)
    assert.equal(auditBefore[0].target, 'rest')

    const approvedCutoff = process.env.AUTH_LEGACY_BEARER_CUTOFF
    process.env.AUTH_LEGACY_BEARER_CUTOFF = new Date(Date.now() - 1).toISOString()
    await assert.rejects(() => auth.authenticateToken(approvedToken), (error: unknown) =>
      (error as { code?: string }).code === 'AUTH_LEGACY_EXPIRED')
    process.env.AUTH_LEGACY_BEARER_CUTOFF = approvedCutoff

    await assert.rejects(() => auth.invalidateAllLegacyBearerTokens({
      approvedUserId: outsideUserId,
      reason: '非管理员不得强制失效旧 JWT',
    }), (error: unknown) => (error as { code?: string }).code === 'AUTH_LEGACY_INVALIDATION_FORBIDDEN')
    const invalidated = await auth.invalidateAllLegacyBearerTokens({
      approvedUserId,
      reason: '迁移验收：立即失效全部旧 JWT',
    })
    assert.equal(invalidated.version, Number(originalControl.version) + 1)
    await assert.rejects(() => auth.authenticateToken(approvedToken), (error: unknown) =>
      (error as { code?: string }).code === 'AUTH_LEGACY_REVOKED')
    const invalidationAudit = await db.select().from(auditLogs).where(and(
      eq(auditLogs.userId, approvedUserId),
      eq(auditLogs.action, '强制失效全部旧 JWT'),
    ))
    assert.equal(invalidationAudit.length, 1)

    const now = Date.now()
    assert.equal(resolveLegacyBearerPolicy({
      AUTH_ALLOW_LEGACY_BEARER: 'true',
      AUTH_LEGACY_BEARER_CUTOFF: new Date(now - 1).toISOString(),
      AUTH_LEGACY_BEARER_ALLOWED_USER_IDS: approvedUserId,
    }, now).expired, true)
    assert.throws(() => resolveLegacyBearerPolicy({
      AUTH_ALLOW_LEGACY_BEARER: 'true',
      AUTH_LEGACY_BEARER_CUTOFF: new Date(now + 60_000).toISOString(),
      AUTH_LEGACY_BEARER_ALLOWED_USER_IDS: '',
    }, now), /1-100 UUIDs/)

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'legacy-window-requires-future-utc-cutoff-and-stable-user-allowlist',
        'allowlisted-enabled-user-token-is-accepted',
        'out-of-scope-user-token-is-denied',
        'accepted-rest-use-is-audited-without-token-content',
        'expired-window-rejects-legacy-token-with-explicit-auth-code',
        'database-watermark-invalidates-all-earlier-tokens-immediately',
        'invalidation-requires-enabled-system-admin-and-is-audited',
      ],
    }))
  } finally {
    await db.update(authLegacyBearerPolicy).set({
      revokedBefore: originalControl.revokedBefore,
      version: originalControl.version,
      reason: originalControl.reason,
      updatedBy: originalControl.updatedBy,
      updatedAt: originalControl.updatedAt,
    }).where(eq(authLegacyBearerPolicy.id, 'global'))
    await db.delete(auditLogs).where(inArray(auditLogs.userId, [approvedUserId, outsideUserId]))
    await db.delete(users).where(inArray(users.id, [approvedUserId, outsideUserId]))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  for (const key of managedKeys) {
    const value = originalEnvironment[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await pool.end()
})
