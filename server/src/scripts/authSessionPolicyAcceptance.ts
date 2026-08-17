import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, authSessions, users } from '../db/schema.js'
import { hashPassword } from '../services/authService.js'
import {
  authSessionKeyTelemetryModule,
  previousAuthSessionKeyAction,
  previousAuthSessionKeyTarget,
} from '../runtime/authSessionKeyTelemetry.js'

const managedKeys = [
  'AUTH_SESSION_SECRET', 'AUTH_SESSION_PREVIOUS_SECRETS', 'AUTH_SESSION_MAX_ACTIVE',
  'AUTH_SESSION_TTL_MINUTES', 'AUTH_SESSION_REMEMBER_TTL_DAYS', 'AUTH_SESSION_RENEW_WINDOW_PERCENT',
] as const
const originalEnvironment = Object.fromEntries(managedKeys.map((key) => [key, process.env[key]]))

async function main() {
  process.env.AUTH_SESSION_SECRET = 'acceptance-current-session-secret-0123456789abcdef'
  process.env.AUTH_SESSION_PREVIOUS_SECRETS = ''
  process.env.AUTH_SESSION_MAX_ACTIVE = '2'
  process.env.AUTH_SESSION_TTL_MINUTES = '60'
  process.env.AUTH_SESSION_REMEMBER_TTL_DAYS = '30'
  process.env.AUTH_SESSION_RENEW_WINDOW_PERCENT = '25'

  const {
    authenticateSessionToken,
    authSessionNeedsRenewal,
    createAuthSession,
    csrfMatches,
    renewAuthSession,
  } = await import('../services/authService.js')
  const email = `session-policy-${randomUUID()}@example.invalid`
  const [created] = await db.insert(users).values({
    email,
    name: '会话策略验收用户',
    role: '投资经理',
    department: '迁移验收',
    passwordHash: await hashPassword(randomUUID()),
  }).$returningId()
  let oldSessionId: string | null = null
  try {
    const firstSessions = await Promise.all(Array.from({ length: 2 }, (_, index) => createAuthSession({
      userId: created.id,
      userAgent: `acceptance-${index}`,
      ipAddress: '127.0.0.1',
    })))
    const newestSession = await createAuthSession({
      userId: created.id,
      userAgent: 'acceptance-newest',
      ipAddress: '127.0.0.1',
    })
    const sessions = [...firstSessions, newestSession]
    const activeRows = await db.select().from(authSessions).where(and(
      eq(authSessions.userId, created.id),
      isNull(authSessions.revokedAt),
    ))
    assert.equal(activeRows.length, 2)
    const tokenResults = await Promise.all(sessions.map(async (session) => {
      try { await authenticateSessionToken(session.sessionToken); return true } catch { return false }
    }))
    assert.equal(tokenResults.filter(Boolean).length, 2)
    assert.equal(tokenResults[2], true)

    await db.delete(authSessions).where(eq(authSessions.userId, created.id))
    process.env.AUTH_SESSION_SECRET = 'acceptance-old-session-secret-0123456789abcdef'
    const oldSession = await createAuthSession({ userId: created.id })
    oldSessionId = oldSession.id
    assert.equal(csrfMatches(oldSession.csrfToken, (await authenticateSessionToken(oldSession.sessionToken)).session.csrfHash), true)

    process.env.AUTH_SESSION_SECRET = 'acceptance-new-session-secret-0123456789abcdef'
    process.env.AUTH_SESSION_PREVIOUS_SECRETS = 'acceptance-old-session-secret-0123456789abcdef'
    const oldAuthenticated = await authenticateSessionToken(oldSession.sessionToken)
    assert.equal(oldAuthenticated.usesCurrentSecret, false)
    assert.equal(authSessionNeedsRenewal(oldAuthenticated), true)
    assert.equal(csrfMatches(oldSession.csrfToken, oldAuthenticated.session.csrfHash), true)
    const rotated = await renewAuthSession(oldAuthenticated)
    assert.ok(rotated)
    await assert.rejects(() => authenticateSessionToken(oldSession.sessionToken), /无效或已过期/)
    const currentAuthenticated = await authenticateSessionToken(rotated.sessionToken)
    assert.equal(currentAuthenticated.usesCurrentSecret, true)
    assert.equal(csrfMatches(rotated.csrfToken, currentAuthenticated.session.csrfHash), true)

    const nearExpiry = new Date(Date.now() + 30_000)
    const oldCreatedAt = new Date(Date.now() - 60 * 60_000)
    await db.update(authSessions).set({ createdAt: oldCreatedAt, expiresAt: nearExpiry })
      .where(eq(authSessions.id, currentAuthenticated.session.id))
    const expiring = await authenticateSessionToken(rotated.sessionToken)
    assert.equal(authSessionNeedsRenewal(expiring), true)
    const extended = await renewAuthSession(expiring)
    assert.ok(extended)
    assert.ok(extended.expiresAt.getTime() > Date.now() + 55 * 60_000)

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'concurrent-session-limit-revokes-oldest-under-user-lock',
        'revoked-session-token-is-rejected',
        'previous-session-secret-remains-valid-during-rotation-window',
        'old-secret-session-renews-to-current-secret-and-rotates-csrf',
        'near-expiry-session-renews-with-configured-ttl',
      ],
    }))
  } finally {
    if (oldSessionId) {
      await db.delete(auditLogs).where(and(
        eq(auditLogs.module, authSessionKeyTelemetryModule),
        eq(auditLogs.action, previousAuthSessionKeyAction),
        eq(auditLogs.target, previousAuthSessionKeyTarget(oldSessionId)),
      ))
    }
    await db.delete(users).where(eq(users.id, created.id))
  }
}

await main().finally(async () => {
  for (const key of managedKeys) {
    const value = originalEnvironment[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await pool.end()
})
