import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { and, eq, isNull } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, authSessions, users } from '../db/schema.js'
import { createAuthSession, hashPassword } from '../services/authService.js'
import { rotateUserPassword } from '../services/passwordRotationService.js'
import { passwordBcryptRounds, validateNewPassword } from '../security/passwordPolicy.js'

async function main() {
  const marker = randomUUID()
  const email = `password-rotation-${marker}@example.invalid`
  const oldPassword = `Old-A9!-${marker}`
  const newPassword = `New-Z8!-${marker}`
  const [user] = await db.insert(users).values({
    email,
    name: '密码轮换验收用户',
    role: '投资经理',
    department: '验收部',
    passwordHash: await hashPassword(oldPassword),
  }).$returningId()
  try {
    await Promise.all([
      createAuthSession({ userId: user.id }),
      createAuthSession({ userId: user.id, remember: true }),
    ])
    const weakViolations = validateNewPassword('123456', { email, name: '密码轮换验收用户' })
    if (!weakViolations.length) throw new Error('known weak password was not rejected')

    const result = await rotateUserPassword({ email, password: newPassword, actor: '密码轮换验收' })
    const expectedCost = passwordBcryptRounds()
    if (result.revokedSessions !== 2 || result.bcryptCost !== expectedCost) throw new Error('rotation summary is invalid')
    const [rotated] = await db.select().from(users).where(eq(users.id, user.id)).limit(1)
    if (!rotated || await bcrypt.compare(oldPassword, rotated.passwordHash) || !(await bcrypt.compare(newPassword, rotated.passwordHash))) {
      throw new Error('rotated bcrypt verification failed')
    }
    if (bcrypt.getRounds(rotated.passwordHash) !== expectedCost) throw new Error('rotated bcrypt cost does not match policy')
    const activeSessions = await db.select({ id: authSessions.id }).from(authSessions).where(and(
      eq(authSessions.userId, user.id), isNull(authSessions.revokedAt),
    ))
    if (activeSessions.length) throw new Error('active sessions remained after password rotation')
    const logs = await db.select().from(auditLogs).where(and(
      eq(auditLogs.userId, user.id), eq(auditLogs.action, '离线强制轮换密码'),
    ))
    if (logs.length !== 1 || logs[0].target !== email || JSON.stringify(logs[0]).includes(newPassword)) {
      throw new Error('password rotation audit record is invalid')
    }
    const samePasswordError = await rotateUserPassword({ email, password: newPassword, actor: '密码轮换验收' })
      .then(() => null, (error: unknown) => error as Error)
    if (!samePasswordError || !/不能与当前密码相同/.test(samePasswordError.message)) {
      throw new Error('same-password rotation was not rejected')
    }
    console.log(JSON.stringify({
      ok: true,
      checks: ['weak-password-rejection', 'bcrypt-policy-cost', 'old-password-invalidated', 'new-password-valid', 'all-sessions-revoked', 'audit-without-secret', 'same-password-rejection'],
    }))
  } finally {
    await db.delete(auditLogs).where(eq(auditLogs.userId, user.id))
    await db.delete(authSessions).where(eq(authSessions.userId, user.id))
    await db.delete(users).where(eq(users.id, user.id))
  }
}

await main().finally(async () => pool.end())
