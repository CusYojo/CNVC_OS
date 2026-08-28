import type { UserRepository } from '../repositories/identityRepository.js'

export async function resolveLoginIdentity(
  identifier: string,
  repository: Pick<UserRepository, 'findByEmail' | 'findByTrimmedName'>,
) {
  const value = identifier.trim()
  if (!value || value.length > 255) return null
  // An email must never fall back to a display name belonging to another user.
  if (value.includes('@')) return repository.findByEmail(value.toLowerCase())
  if (value.length > 64) return null
  // Include disabled accounts in ambiguity detection: enabling/disabling a
  // namesake must not silently change which identity a name authenticates.
  const matches = await repository.findByTrimmedName(value, 2)
  if (matches.length > 1) {
    throw Object.assign(new Error('存在同名账号，请使用邮箱登录'), { code: 'AUTH_AMBIGUOUS_NAME' })
  }
  return matches[0] ?? null
}
