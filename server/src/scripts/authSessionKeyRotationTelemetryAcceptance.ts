import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, authSessions, users } from '../db/schema.js'
import { operationalTelemetryRepository } from '../repositories/mysql/mysqlOperationalTelemetryRepository.js'
import { httpTelemetrySnapshot } from '../runtime/httpTelemetry.js'
import {
  authSessionKeyTelemetryModule,
  previousAuthSessionKeyAction,
  previousAuthSessionKeyTarget,
} from '../runtime/authSessionKeyTelemetry.js'
import {
  authenticateSessionToken,
  createAuthSession,
  hashPassword,
  renewAuthSession,
} from '../services/authService.js'
import { evaluateOperationalAlerts } from '../services/operationalTelemetryService.js'
import { sessionAuthHealth } from '../services/sessionAuthService.js'

const managedKeys = [
  'AUTH_SESSION_SECRET', 'AUTH_SESSION_PREVIOUS_SECRETS', 'AUTH_SESSION_KEY_ROTATION_STARTED_AT',
  'AUTH_SESSION_TTL_MINUTES', 'AUTH_SESSION_REMEMBER_TTL_DAYS',
] as const
const previousEnvironment = Object.fromEntries(managedKeys.map((name) => [name, process.env[name]]))
const checks: string[] = []
function assert(condition: unknown, check: string): asserts condition {
  if (!condition) throw new Error(check)
  checks.push(check)
}

async function main() {
  const oldSecret = `old-session-key-${randomUUID()}-0123456789abcdef`
  const currentSecret = `current-session-key-${randomUUID()}-0123456789abcdef`
  process.env.AUTH_SESSION_SECRET = oldSecret
  process.env.AUTH_SESSION_PREVIOUS_SECRETS = ''
  process.env.AUTH_SESSION_KEY_ROTATION_STARTED_AT = ''
  process.env.AUTH_SESSION_TTL_MINUTES = '60'
  process.env.AUTH_SESSION_REMEMBER_TTL_DAYS = '30'

  const [user] = await db.insert(users).values({
    email: `session-key-telemetry-${randomUUID()}@example.invalid`,
    name: '会话密钥遥测验收用户',
    role: '投资经理',
    department: '迁移验收',
    passwordHash: await hashPassword(randomUUID()),
  }).$returningId()
  let sessionId: string | null = null
  try {
    const oldSession = await createAuthSession({ userId: user.id })
    sessionId = oldSession.id
    const eventTarget = previousAuthSessionKeyTarget(oldSession.id)
    process.env.AUTH_SESSION_SECRET = currentSecret
    process.env.AUTH_SESSION_PREVIOUS_SECRETS = oldSecret
    process.env.AUTH_SESSION_KEY_ROTATION_STARTED_AT = new Date(Date.now() - 60 * 60_000).toISOString()

    const baseline = await sessionAuthHealth()
    const oldAuthenticated = await authenticateSessionToken(oldSession.sessionToken)
    assert(!oldAuthenticated.usesCurrentSecret, 'previous-key-session-is-detected')
    await authenticateSessionToken(oldSession.sessionToken)
    const active = await sessionAuthHealth()
    assert(
      active.keyRotation.previousKeyMatches24h === baseline.keyRotation.previousKeyMatches24h + 1,
      'previous-key-match-increments-exactly-once-per-session-day',
    )
    assert(
      active.keyRotation.previousSecretCount === 1
        && active.keyRotation.compatibilityWindowOpen
        && active.keyRotation.rotationStartedAtConfigured,
      'rotation-window-configuration-is-observable',
    )
    assert(
      active.keyRotation.secretsExcluded
        && active.keyRotation.tokensExcluded
        && active.keyRotation.identitiesExcluded,
      'rotation-health-declares-sensitive-value-exclusion',
    )

    const events = await db.select().from(auditLogs).where(and(
      eq(auditLogs.module, authSessionKeyTelemetryModule),
      eq(auditLogs.action, previousAuthSessionKeyAction),
      eq(auditLogs.target, eventTarget),
    ))
    assert(events.length === 1 && events[0].userId === null, 'previous-key-event-uses-null-system-actor')
    const serializedEvent = JSON.stringify(events[0])
    assert(
      !serializedEvent.includes(oldSession.id)
        && !serializedEvent.includes(oldSession.sessionToken)
        && !serializedEvent.includes(oldSession.csrfToken)
        && !serializedEvent.includes(oldSecret)
        && !serializedEvent.includes(currentSecret),
      'previous-key-event-excludes-session-token-csrf-and-secrets',
    )

    const rotated = await renewAuthSession(oldAuthenticated)
    assert(rotated, 'previous-key-session-renews-to-current-key')
    const renewed = await authenticateSessionToken(rotated.sessionToken)
    assert(renewed.usesCurrentSecret, 'renewed-session-uses-current-key')
    const afterRenewal = await sessionAuthHealth()
    assert(
      afterRenewal.keyRotation.previousKeyMatches24h === active.keyRotation.previousKeyMatches24h,
      'current-key-authentication-does-not-increment-legacy-activity',
    )

    const database = await operationalTelemetryRepository.snapshot()
    const activeAlerts = evaluateOperationalAlerts({ http: httpTelemetrySnapshot(), database, components: [active] })
    assert(
      activeAlerts.some((alert) => alert.code === 'AUTH_SESSION_LEGACY_KEY_ACTIVITY'),
      'legacy-key-activity-alert-is-emitted',
    )
    const lifecycleAlerts = evaluateOperationalAlerts({
      http: httpTelemetrySnapshot(),
      database,
      components: [{
        name: 'mysql-auth-sessions',
        keyRotation: {
          currentSecretConfigured: false,
          previousSecretCount: 1,
          rotationStartedAtConfigured: false,
          previousKeyMatches24h: 0,
          rotationWindowOverdue: true,
        },
      }],
    })
    const lifecycleCodes = new Set(lifecycleAlerts.map((alert) => alert.code))
    assert(lifecycleCodes.has('AUTH_SESSION_CURRENT_KEY_UNCONFIGURED'), 'unconfigured-current-key-alert-is-emitted')
    assert(lifecycleCodes.has('AUTH_SESSION_KEY_ROTATION_UNTRACKED'), 'untracked-key-rotation-alert-is-emitted')
    assert(lifecycleCodes.has('AUTH_SESSION_PREVIOUS_KEYS_OVERDUE'), 'overdue-previous-key-alert-is-emitted')

    await db.delete(auditLogs).where(and(
      eq(auditLogs.module, authSessionKeyTelemetryModule),
      eq(auditLogs.action, previousAuthSessionKeyAction),
      eq(auditLogs.target, eventTarget),
    ))
    const residue = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(
      eq(auditLogs.module, authSessionKeyTelemetryModule),
      eq(auditLogs.action, previousAuthSessionKeyAction),
      eq(auditLogs.target, eventTarget),
    ))
    assert(residue.length === 0, 'session-key-telemetry-fixture-residue-is-zero')

    const result = {
      ok: true,
      checks,
      previousKeyMatchesIncrement: 1,
      previousKeyEventCount: events.length,
      fixtureResidue: 0,
      secretsExcluded: true,
      tokensExcluded: true,
      identitiesExcluded: true,
    }
    const evidenceRoot = path.resolve('.runtime/migration-evidence/auth-session-key-rotation-telemetry')
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
    await chmod(evidenceRoot, 0o700)
    const reportPath = path.join(evidenceRoot, 'report.json')
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
    await chmod(reportPath, 0o600)
    console.log(JSON.stringify(result))
  } finally {
    if (sessionId) {
      await db.delete(auditLogs).where(and(
        eq(auditLogs.module, authSessionKeyTelemetryModule),
        eq(auditLogs.action, previousAuthSessionKeyAction),
        eq(auditLogs.target, previousAuthSessionKeyTarget(sessionId)),
      ))
    }
    await db.delete(authSessions).where(eq(authSessions.userId, user.id))
    await db.delete(users).where(eq(users.id, user.id))
    for (const name of managedKeys) {
      const value = previousEnvironment[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await pool.end()
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
