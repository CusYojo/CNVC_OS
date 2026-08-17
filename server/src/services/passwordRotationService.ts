import bcrypt from 'bcryptjs'
import { identityRepositories } from '../repositories/index.js'
import { emitAuthInvalidation } from '../runtime/authSessionEvents.js'
import { hashNewPassword, passwordBcryptRounds, validateNewPassword } from '../security/passwordPolicy.js'

export async function rotateUserPassword(input: {
  email: string
  password: string
  actor: string
}) {
  const email = input.email.trim().toLowerCase()
  if (!email) throw new Error('必须提供目标用户邮箱')
  const user = await identityRepositories.users.findByEmail(email)
  if (!user) throw new Error(`未找到目标用户：${email}`)
  const violations = validateNewPassword(input.password, { email: user.email, name: user.name })
  if (violations.length) throw new Error(`新密码不符合安全要求：${violations.join('；')}`)
  if (await bcrypt.compare(input.password, user.passwordHash)) throw new Error('新密码不能与当前密码相同')

  const passwordHash = await hashNewPassword(input.password)
  const rotatedAt = new Date()
  const result = await identityRepositories.transaction(async ({ users, audits }) => {
    const current = await users.lockById(user.id)
    if (!current) throw new Error('密码更新未命中唯一用户，事务已回滚')
    if (await bcrypt.compare(input.password, current.passwordHash)) throw new Error('新密码不能与当前密码相同')
    if (!await users.updatePasswordHash(current.id, passwordHash)) {
      throw new Error('密码更新未命中唯一用户，事务已回滚')
    }
    const revokedSessions = await users.revokeActiveSessions(current.id, rotatedAt)
    await audits.append({
      userId: current.id,
      userName: input.actor.trim().slice(0, 64) || '离线安全运维',
      module: '身份与访问',
      action: '离线强制轮换密码',
      target: current.email,
    })
    return { revokedSessions }
  })
  emitAuthInvalidation({ type: 'user', userId: user.id })
  return {
    userId: user.id,
    email: user.email,
    bcryptCost: passwordBcryptRounds(),
    revokedSessions: result.revokedSessions,
    rotatedAt: rotatedAt.toISOString(),
  }
}
