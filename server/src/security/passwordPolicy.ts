import bcrypt from 'bcryptjs'

export const KNOWN_INSECURE_PASSWORDS = Object.freeze([
  '123456', 'password', 'admin123', '12345678',
])

export type PasswordIdentity = { email: string; name?: string | null }

function normalizedIdentityParts(identity: PasswordIdentity): string[] {
  const localPart = identity.email.split('@')[0]?.trim().toLowerCase() || ''
  const name = identity.name?.trim().toLowerCase() || ''
  return [localPart, name].filter((value) => value.length >= 3)
}

export function validateNewPassword(password: string, identity: PasswordIdentity): string[] {
  const violations: string[] = []
  if (password.length < 14) violations.push('密码至少需要 14 个字符')
  if (password.length > 128) violations.push('密码不能超过 128 个字符')
  if (!/[a-z]/.test(password)) violations.push('密码必须包含小写字母')
  if (!/[A-Z]/.test(password)) violations.push('密码必须包含大写字母')
  if (!/\d/.test(password)) violations.push('密码必须包含数字')
  if (!/[^A-Za-z0-9]/.test(password)) violations.push('密码必须包含符号')
  if (/\s/.test(password)) violations.push('密码不能包含空白字符')
  if (KNOWN_INSECURE_PASSWORDS.includes(password.toLowerCase())) violations.push('密码属于已知弱密码')
  const lowered = password.toLowerCase()
  if (normalizedIdentityParts(identity).some((part) => lowered.includes(part))) {
    violations.push('密码不能包含账号邮箱前缀或姓名')
  }
  return violations
}

export function passwordBcryptRounds(): number {
  const raw = process.env.AUTH_PASSWORD_BCRYPT_ROUNDS || '12'
  const rounds = Number(raw)
  if (!Number.isInteger(rounds) || rounds < 12 || rounds > 15) {
    throw new Error('AUTH_PASSWORD_BCRYPT_ROUNDS must be an integer between 12 and 15')
  }
  return rounds
}

export async function hashNewPassword(password: string): Promise<string> {
  return bcrypt.hash(password, passwordBcryptRounds())
}
