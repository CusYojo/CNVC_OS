import type { Request, Response } from 'express'
import type { RowDataPacket } from 'mysql2'
import {
  authenticateSessionToken,
  authenticateToken,
  auditLegacyBearerUse,
  authSessionNeedsRenewal,
  csrfMatches,
  legacyBearerAllowed,
  renewAuthSession,
  type JwtPayload,
} from './authService.js'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { resolveLegacyBearerPolicy } from '../config/legacyBearerPolicy.js'
import { resolveAuthSessionPolicy } from '../config/authSessionPolicy.js'
import { migrationWriteFreezePolicy } from '../config/migrationWriteFreezePolicy.js'
import {
  authSessionKeyTelemetryModule,
  previousAuthSessionKeyAction,
} from '../runtime/authSessionKeyTelemetry.js'

export const SESSION_COOKIE_NAME = 'cybernaut_session'
export const CSRF_COOKIE_NAME = 'cybernaut_csrf'

export type RequestAuth = {
  user: JwtPayload
  mode: 'session' | 'legacy-bearer'
  sessionId?: string
  csrfHash?: string
  sessionToken?: string
  authenticatedSession?: Awaited<ReturnType<typeof authenticateSessionToken>>
}

function cookieOptions() {
  const sameSiteValue = (process.env.AUTH_COOKIE_SAME_SITE || 'lax').toLowerCase()
  const sameSite = (['lax', 'strict', 'none'].includes(sameSiteValue) ? sameSiteValue : 'lax') as 'lax' | 'strict' | 'none'
  const secure = process.env.AUTH_COOKIE_SECURE
    ? process.env.AUTH_COOKIE_SECURE === 'true'
    : process.env.NODE_ENV === 'production'
  return {
    httpOnly: true,
    secure,
    sameSite,
    path: '/',
    ...(process.env.AUTH_COOKIE_DOMAIN?.trim() ? { domain: process.env.AUTH_COOKIE_DOMAIN.trim() } : {}),
  } as const
}

type SessionHealthRow = RowDataPacket & {
  active: number | string
  revoked: number | string
  expired: number | string
}

type KeyRotationHealthRow = RowDataPacket & {
  matches_24h: number | string
  matches_since_start: number | string
}

export async function sessionAuthHealth() {
  const table = quoteMysqlIdentifier(mysqlTableName('auth_sessions'))
  const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
  const authPolicy = resolveAuthSessionPolicy()
  const [sessionResult, keyRotationResult] = await Promise.all([
    pool.query<SessionHealthRow[]>(`SELECT
       SUM(revoked_at IS NULL AND expires_at > NOW(3)) AS active,
       SUM(revoked_at IS NOT NULL) AS revoked,
       SUM(expires_at <= NOW(3)) AS expired
     FROM ${table}`),
    pool.query<KeyRotationHealthRow[]>(`SELECT
       SUM(created_at >= NOW(3) - INTERVAL 24 HOUR) AS matches_24h,
       SUM(CASE WHEN ? IS NULL THEN 0 ELSE created_at >= ? END) AS matches_since_start
     FROM ${auditTable} WHERE module=? AND action=? AND result='success'`, [
      authPolicy.rotationStartedAt,
      authPolicy.rotationStartedAt,
      authSessionKeyTelemetryModule,
      previousAuthSessionKeyAction,
    ]),
  ])
  const rows = sessionResult[0]
  const keyRotationRows = keyRotationResult[0]
  const options = cookieOptions()
  const legacyPolicy = resolveLegacyBearerPolicy()
  const productionReady = process.env.NODE_ENV !== 'production' || options.secure
  const observationAgeHours = authPolicy.rotationStartedAt
    ? Math.max(0, (Date.now() - authPolicy.rotationStartedAt.getTime()) / 3_600_000)
    : 0
  const maximumSessionLifetimeHours = authPolicy.persistentTtlMs / 3_600_000
  const previousSecretCount = authPolicy.previousSecrets.length
  const previousKeyMatches24h = Number(keyRotationRows[0]?.matches_24h || 0)
  const previousKeyMatchesSinceStart = Number(keyRotationRows[0]?.matches_since_start || 0)
  const rotationWindowOverdue = previousSecretCount > 0
    && Boolean(authPolicy.rotationStartedAt)
    && observationAgeHours >= maximumSessionLifetimeHours
  return {
    name: 'mysql-auth-sessions',
    ok: true,
    inProcess: true,
    active: Number(rows[0]?.active || 0),
    revoked: Number(rows[0]?.revoked || 0),
    expired: Number(rows[0]?.expired || 0),
    legacyBearerAllowed: legacyBearerAllowed(),
    legacyBearerActive: legacyPolicy.active,
    legacyBearerCutoff: legacyPolicy.cutoff?.toISOString() ?? null,
    legacyBearerAllowedUserCount: legacyPolicy.allowedUserIds.length,
    cookie: {
      secure: options.secure,
      sameSite: options.sameSite,
      path: options.path,
      domainScoped: 'domain' in options,
    },
    allowedOrigins: (process.env.AUTH_ALLOWED_ORIGINS || '').split(',').filter((value) => value.trim()).length,
    keyRotation: {
      currentSecretConfigured: authPolicy.currentSecretExplicitlyConfigured,
      previousSecretCount,
      compatibilityWindowOpen: previousSecretCount > 0,
      rotationStartedAtConfigured: Boolean(authPolicy.rotationStartedAt),
      observationAgeHours: Number(observationAgeHours.toFixed(3)),
      maximumSessionLifetimeHours,
      previousKeyMatches24h,
      previousKeyMatchesSinceStart,
      rotationWindowOverdue,
      readyToRetirePreviousSecrets: rotationWindowOverdue && previousKeyMatchesSinceStart === 0,
      complete: previousSecretCount === 0 && previousKeyMatches24h === 0,
      secretsExcluded: true,
      tokensExcluded: true,
      identitiesExcluded: true,
    },
    productionReady,
    warning: productionReady ? null : 'production cookie is not Secure; enable TLS before release',
  }
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {}
  return Object.fromEntries(cookieHeader.split(';').flatMap((entry) => {
    const separator = entry.indexOf('=')
    if (separator < 1) return []
    const key = entry.slice(0, separator).trim()
    const raw = entry.slice(separator + 1).trim()
    try { return [[key, decodeURIComponent(raw)]] }
    catch { return [] }
  }))
}

export function setAuthCookies(
  res: Response,
  input: { sessionToken: string; csrfToken: string; expiresAt: Date; persistent?: boolean },
): void {
  const options = cookieOptions()
  const persistence = input.persistent ? { expires: input.expiresAt } : {}
  res.cookie(SESSION_COOKIE_NAME, input.sessionToken, { ...options, ...persistence })
  res.cookie(CSRF_COOKIE_NAME, input.csrfToken, {
    ...options,
    httpOnly: false,
    ...persistence,
  })
}

export function clearAuthCookies(res: Response): void {
  const options = cookieOptions()
  res.clearCookie(SESSION_COOKIE_NAME, options)
  res.clearCookie(CSRF_COOKIE_NAME, { ...options, httpOnly: false })
}

export async function authenticateCookieHeader(cookieHeader: string | undefined): Promise<RequestAuth | null> {
  const sessionToken = parseCookieHeader(cookieHeader)[SESSION_COOKIE_NAME]
  if (!sessionToken) return null
  const authenticated = await authenticateSessionToken(sessionToken)
  return {
    user: authenticated.user,
    mode: 'session',
    sessionId: authenticated.session.id,
    csrfHash: authenticated.session.csrfHash,
    sessionToken,
    authenticatedSession: authenticated,
  }
}

export async function renewAuthCookiesIfNeeded(res: Response, auth: RequestAuth): Promise<boolean> {
  if (migrationWriteFreezePolicy.enabled) return false
  if (auth.mode !== 'session' || !auth.authenticatedSession || !authSessionNeedsRenewal(auth.authenticatedSession)) return false
  const renewed = await renewAuthSession(auth.authenticatedSession)
  if (!renewed) return false
  setAuthCookies(res, renewed)
  auth.sessionToken = renewed.sessionToken
  return true
}

export async function authenticateHttpRequest(req: Request): Promise<RequestAuth> {
  const cookieAuth = await authenticateCookieHeader(req.headers.cookie)
  if (cookieAuth) return cookieAuth
  const header = req.headers.authorization
  if (legacyBearerAllowed() && header?.startsWith('Bearer ')) {
    const user = await authenticateToken(header.slice(7))
    await auditLegacyBearerUse({ user, surface: 'rest', ipAddress: req.ip })
    return { user, mode: 'legacy-bearer' }
  }
  throw Object.assign(new Error('未提供有效登录会话'), { code: 'AUTH_REQUIRED' })
}

export function requestOriginAllowed(headers: Request['headers']): boolean {
  const origin = typeof headers.origin === 'string' ? headers.origin : ''
  if (!origin) return true
  const forwardedProto = typeof headers['x-forwarded-proto'] === 'string'
    ? headers['x-forwarded-proto'].split(',')[0].trim()
    : ''
  const protocol = forwardedProto || (process.env.NODE_ENV === 'production' ? 'https' : 'http')
  const host = typeof headers.host === 'string' ? headers.host : ''
  const sameOrigin = host ? `${protocol}://${host}` : ''
  const allowed = (process.env.AUTH_ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean)
  return origin === sameOrigin || allowed.includes(origin)
}

export function assertRequestCsrf(req: Request, auth: RequestAuth): void {
  if (auth.mode !== 'session' || ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) return
  if (!requestOriginAllowed(req.headers)) {
    throw Object.assign(new Error('请求来源不受信任'), { status: 403, code: 'ORIGIN_FORBIDDEN' })
  }
  const csrf = req.headers['x-csrf-token']
  if (typeof csrf !== 'string' || !auth.csrfHash || !csrfMatches(csrf, auth.csrfHash)) {
    throw Object.assign(new Error('CSRF 校验失败'), { status: 403, code: 'CSRF_INVALID' })
  }
}
