type LegacyBearerEnvironment = Record<string, string | undefined>

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function enabled(env: LegacyBearerEnvironment) {
  const value = env.AUTH_ALLOW_LEGACY_BEARER?.trim().toLowerCase()
  if (!value || value === 'false') return false
  if (value === 'true') return true
  throw new Error('[legacy bearer] AUTH_ALLOW_LEGACY_BEARER must be true or false')
}

export function resolveLegacyBearerPolicy(
  env: LegacyBearerEnvironment = process.env,
  now = Date.now(),
) {
  const isEnabled = enabled(env)
  if (!isEnabled) {
    return Object.freeze({ enabled: false, active: false, expired: false, cutoff: null, allowedUserIds: [] as string[] })
  }
  const cutoffText = env.AUTH_LEGACY_BEARER_CUTOFF?.trim() || ''
  const cutoff = new Date(cutoffText)
  if (!cutoffText || !Number.isFinite(cutoff.getTime()) || cutoff.toISOString() !== cutoffText) {
    throw new Error('[legacy bearer] AUTH_LEGACY_BEARER_CUTOFF must be an exact UTC ISO timestamp')
  }
  if (cutoff.getTime() > now + 30 * 24 * 60 * 60_000) {
    throw new Error('[legacy bearer] approved migration window cannot exceed 30 days')
  }
  const allowedUserIds = [...new Set((env.AUTH_LEGACY_BEARER_ALLOWED_USER_IDS || '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))]
  if (!allowedUserIds.length || allowedUserIds.length > 100 || allowedUserIds.some((value) => !uuidPattern.test(value))) {
    throw new Error('[legacy bearer] AUTH_LEGACY_BEARER_ALLOWED_USER_IDS must contain 1-100 UUIDs')
  }
  const expired = cutoff.getTime() <= now
  return Object.freeze({ enabled: true, active: !expired, expired, cutoff, allowedUserIds })
}

export function legacyBearerUserAllowed(userId: string, env: LegacyBearerEnvironment = process.env) {
  const policy = resolveLegacyBearerPolicy(env)
  return policy.active && policy.allowedUserIds.includes(userId.toLowerCase())
}
