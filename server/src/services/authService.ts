import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { authLegacyBearerPolicy, authSessions } from '../db/schema.js'
import { createMySqlIdentityRepositoryContext, identityRepositories } from '../repositories/index.js'
import { emitAuthInvalidation } from '../runtime/authSessionEvents.js'
import { recordPreviousAuthSessionKeyUseSafely } from '../runtime/authSessionKeyTelemetry.js'
import { resolveAuthSessionPolicy } from '../config/authSessionPolicy.js'
import { legacyBearerUserAllowed, resolveLegacyBearerPolicy } from '../config/legacyBearerPolicy.js'
import { writeAudit } from './auditService.js'
import { migrationWriteFreezePolicy } from '../config/migrationWriteFreezePolicy.js'
import { resolveLoginIdentity } from '../security/loginIdentity.js'

const SECRET = process.env.JWT_SECRET || 'cybernaut-dev-secret-change-me'
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h'

export interface JwtPayload {
  uid: string
  email: string
  name: string
  role: string
  department: string
  iat?: number
  exp?: number
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN as jwt.SignOptions['expiresIn'] })
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, SECRET) as JwtPayload
}

export function legacyBearerAllowed(): boolean {
  return resolveLegacyBearerPolicy().enabled
}

export function legacyBearerAllowedForUser(userId: string): boolean {
  return legacyBearerUserAllowed(userId)
}

function secretHashWith(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex')
}

function secretHash(value: string): string {
  return secretHashWith(value, resolveAuthSessionPolicy().currentSecret)
}

function secretHashCandidates(value: string): string[] {
  const policy = resolveAuthSessionPolicy()
  return [policy.currentSecret, ...policy.previousSecrets].map((secret) => secretHashWith(value, secret))
}

export function csrfMatches(rawToken: string, expectedHash: string): boolean {
  const expected = Buffer.from(expectedHash, 'hex')
  return secretHashCandidates(rawToken).some((candidate) => {
    const actual = Buffer.from(candidate, 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  })
}

export async function createAuthSession(input: {
  userId: string
  remember?: boolean
  userAgent?: string
  ipAddress?: string
}) {
  const policy = resolveAuthSessionPolicy()
  const sessionToken = randomBytes(32).toString('base64url')
  const csrfToken = randomBytes(24).toString('base64url')
  const ttlMs = input.remember ? policy.persistentTtlMs : policy.transientTtlMs
  const expiresAt = new Date(Date.now() + ttlMs)
  const created = await db.transaction(async (tx) => {
    const identity = createMySqlIdentityRepositoryContext(tx)
    const lockedUser = await identity.users.lockById(input.userId)
    if (!lockedUser) throw Object.assign(new Error('账号不存在'), { code: 'AUTH_NOT_FOUND' })
    const active = await tx.select({ id: authSessions.id }).from(authSessions).where(and(
      eq(authSessions.userId, input.userId),
      isNull(authSessions.revokedAt),
      gt(authSessions.expiresAt, new Date()),
    )).orderBy(desc(authSessions.createdAt), desc(authSessions.id))
    const revokedSessionIds = active.slice(Math.max(0, policy.maxActiveSessions - 1)).map((session) => session.id)
    if (revokedSessionIds.length) {
      await tx.update(authSessions).set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(inArray(authSessions.id, revokedSessionIds))
    }
    const [row] = await tx.insert(authSessions).values({
      userId: input.userId,
      tokenHash: secretHash(sessionToken),
      csrfHash: secretHash(csrfToken),
      expiresAt,
      userAgent: input.userAgent?.slice(0, 1_000),
      ipAddress: input.ipAddress?.slice(0, 64),
    }).$returningId()
    return { id: row.id, revokedSessionIds }
  })
  for (const sessionId of created.revokedSessionIds) emitAuthInvalidation({ type: 'session', sessionId })
  return { id: created.id, sessionToken, csrfToken, expiresAt }
}

export async function authenticateSessionToken(sessionToken: string) {
  const candidateHashes = secretHashCandidates(sessionToken)
  const [session] = await db.select().from(authSessions).where(and(
    inArray(authSessions.tokenHash, candidateHashes),
    isNull(authSessions.revokedAt),
  )).limit(1)
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    throw Object.assign(new Error('登录会话无效或已过期'), { code: 'AUTH_INVALID' })
  }
  const user = await identityRepositories.users.findById(session.userId)
  if (!user || user.status !== '启用') {
    emitAuthInvalidation({ type: 'user', userId: session.userId })
    throw Object.assign(new Error('账号不存在或已禁用'), { code: 'AUTH_DISABLED' })
  }
  const usesCurrentSecret = session.tokenHash === candidateHashes[0]
  if (!usesCurrentSecret && !migrationWriteFreezePolicy.enabled) {
    await recordPreviousAuthSessionKeyUseSafely(session.id)
  }
  if (!migrationWriteFreezePolicy.enabled && Date.now() - session.lastSeenAt.getTime() > 5 * 60_000) {
    await db.update(authSessions).set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(authSessions.id, session.id))
  }
  return {
    session,
    usesCurrentSecret,
    user: {
      uid: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      department: user.department,
    } satisfies JwtPayload,
  }
}

export function authSessionNeedsRenewal(input: Awaited<ReturnType<typeof authenticateSessionToken>>): boolean {
  if (!input.usesCurrentSecret) return true
  const policy = resolveAuthSessionPolicy()
  const originalLifetime = Math.max(1, input.session.expiresAt.getTime() - input.session.createdAt.getTime())
  const remaining = input.session.expiresAt.getTime() - Date.now()
  return remaining <= originalLifetime * policy.renewWindowPercent / 100
}

export async function renewAuthSession(input: Awaited<ReturnType<typeof authenticateSessionToken>>) {
  const policy = resolveAuthSessionPolicy()
  const sessionToken = randomBytes(32).toString('base64url')
  const csrfToken = randomBytes(24).toString('base64url')
  const originalLifetime = input.session.expiresAt.getTime() - input.session.createdAt.getTime()
  const persistent = originalLifetime > policy.transientTtlMs * 2
  const expiresAt = new Date(Date.now() + (persistent ? policy.persistentTtlMs : policy.transientTtlMs))
  const [updated] = await db.update(authSessions).set({
    tokenHash: secretHash(sessionToken),
    csrfHash: secretHash(csrfToken),
    expiresAt,
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(authSessions.id, input.session.id),
    eq(authSessions.tokenHash, input.session.tokenHash),
    isNull(authSessions.revokedAt),
    gt(authSessions.expiresAt, new Date()),
  ))
  if (updated.affectedRows !== 1) return null
  return { sessionToken, csrfToken, expiresAt, persistent }
}

export async function revokeAuthSession(sessionId: string): Promise<void> {
  await db.update(authSessions).set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)))
  emitAuthInvalidation({ type: 'session', sessionId })
}

export async function revokeUserAuthSessions(userId: string): Promise<void> {
  await db.update(authSessions).set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
  emitAuthInvalidation({ type: 'user', userId })
}

export async function purgeExpiredAuthSessions() {
  const [result] = await db.delete(authSessions).where(lt(authSessions.expiresAt, new Date()))
  return { deleted: result.affectedRows }
}

export async function authenticateToken(token: string): Promise<JwtPayload> {
  const payload = verifyToken(token)
  const policy = resolveLegacyBearerPolicy()
  if (!policy.enabled) throw Object.assign(new Error('Bearer 迁移窗口已关闭'), { code: 'AUTH_LEGACY_DISABLED' })
  if (policy.expired) throw Object.assign(new Error('旧 JWT 迁移窗口已到期'), { code: 'AUTH_LEGACY_EXPIRED' })
  if (!policy.allowedUserIds.includes(String(payload.uid || '').toLowerCase())) {
    throw Object.assign(new Error('当前用户不在旧 JWT 迁移白名单'), { code: 'AUTH_LEGACY_SCOPE_DENIED' })
  }
  if (!Number.isSafeInteger(payload.iat) || Number(payload.iat) <= 0) {
    throw Object.assign(new Error('旧 JWT 缺少可审计签发时间'), { code: 'AUTH_LEGACY_IAT_REQUIRED' })
  }
  const [control] = await db.select().from(authLegacyBearerPolicy)
    .where(eq(authLegacyBearerPolicy.id, 'global')).limit(1)
  if (!control) throw Object.assign(new Error('旧 JWT 强制失效策略不存在'), { code: 'AUTH_LEGACY_POLICY_MISSING' })
  if (Number(payload.iat) * 1_000 <= control.revokedBefore.getTime()) {
    throw Object.assign(new Error('旧 JWT 已被强制失效'), { code: 'AUTH_LEGACY_REVOKED' })
  }
  const user = await identityRepositories.users.findById(payload.uid)
  if (!user || user.status !== '启用') {
    throw Object.assign(new Error('账号不存在或已禁用'), { code: 'AUTH_DISABLED' })
  }
  return {
    uid: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    department: user.department,
  }
}

export async function auditLegacyBearerUse(input: {
  user: JwtPayload
  surface: 'rest' | 'socket'
  ipAddress?: string
}) {
  await writeAudit({
    userId: input.user.uid,
    userName: input.user.name,
    module: '账号安全',
    action: '旧 JWT 迁移窗口使用',
    target: input.surface,
    ip: input.ipAddress,
  })
}

export async function invalidateAllLegacyBearerTokens(input: {
  approvedUserId: string
  reason: string
  now?: Date
}) {
  const reason = input.reason.normalize('NFKC').replace(/\u0000/g, '').trim().slice(0, 1_000)
  if (reason.length < 8) throw new Error('旧 JWT 强制失效必须填写至少 8 个字符的批准理由')
  const revokedBefore = input.now ?? new Date()
  return await db.transaction(async (tx) => {
    const identity = createMySqlIdentityRepositoryContext(tx)
    const approver = await identity.users.lockById(input.approvedUserId)
    if (!approver || approver.status !== '启用' || approver.role !== '系统管理员') {
      throw Object.assign(new Error('仅启用的系统管理员可以强制失效旧 JWT'), { code: 'AUTH_LEGACY_INVALIDATION_FORBIDDEN' })
    }
    await tx.execute(sql`SELECT id FROM ${authLegacyBearerPolicy} WHERE id='global' FOR UPDATE`)
    await tx.update(authLegacyBearerPolicy).set({
      revokedBefore,
      version: sql`${authLegacyBearerPolicy.version} + 1`,
      reason,
      updatedBy: approver.id,
      updatedAt: revokedBefore,
    }).where(eq(authLegacyBearerPolicy.id, 'global'))
    await identity.audits.append({
      userId: approver.id,
      userName: approver.name,
      module: '账号安全',
      action: '强制失效全部旧 JWT',
      target: reason,
      result: 'success',
    })
    const [updated] = await tx.select().from(authLegacyBearerPolicy)
      .where(eq(authLegacyBearerPolicy.id, 'global')).limit(1)
    if (!updated) throw new Error('旧 JWT 强制失效策略更新失败')
    return { version: Number(updated.version), revokedBefore: updated.revokedBefore }
  })
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10)
}

export async function checkPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

export async function login(identifier: string, password: string) {
  const user = await resolveLoginIdentity(identifier, identityRepositories.users)
  if (!user || user.status !== '启用') {
    throw Object.assign(new Error('账号不存在或已禁用'), { code: 'AUTH_NOT_FOUND' })
  }
  const ok = await checkPassword(password, user.passwordHash)
  if (!ok) {
    throw Object.assign(new Error('密码错误'), { code: 'AUTH_BAD_PASSWORD' })
  }
  // 更新 last_login
  await identityRepositories.users.touchLastLogin(user.id, new Date())
  const payload: JwtPayload = {
    uid: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    department: user.department,
  }
  return { payload, user: sanitize(user) }
}

export async function seedUsers() {
  // The historical fixed demo-account bootstrap is permanently retired. Keep
  // this no-op entrypoint temporarily so older deployment code can upgrade
  // without branching, but never create an account even if a stale environment
  // still sets SEED_DEMO_USERS=1.
  return { seeded: 0, skipped: true as const, retired: true as const }
}

function sanitize<T extends Record<string, unknown>>(row: T): Omit<T, 'passwordHash'> {
  const { passwordHash: _omit, ...rest } = row as Record<string, unknown>
  return rest as Omit<T, 'passwordHash'>
}
