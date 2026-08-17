type RuntimeEnvironment = Record<string, string | undefined>

function integerSetting(
  env: RuntimeEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim()
  const value = raw ? Number(raw) : fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`[auth session policy] ${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

export function resolveAuthSessionPolicy(env: RuntimeEnvironment = process.env) {
  const explicitCurrentSecret = env.AUTH_SESSION_SECRET?.trim() || env.JWT_SECRET?.trim()
  const currentSecret = explicitCurrentSecret
    || 'cybernaut-dev-secret-change-me'
  const previousSecrets = (env.AUTH_SESSION_PREVIOUS_SECRETS || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value, index, values) => value && value !== currentSecret && values.indexOf(value) === index)
  const transientTtlMinutes = integerSetting(env, 'AUTH_SESSION_TTL_MINUTES', 24 * 60, 5, 7 * 24 * 60)
  const persistentTtlDays = integerSetting(env, 'AUTH_SESSION_REMEMBER_TTL_DAYS', 30, 1, 365)
  const renewWindowPercent = integerSetting(env, 'AUTH_SESSION_RENEW_WINDOW_PERCENT', 25, 1, 50)
  const maxActiveSessions = integerSetting(env, 'AUTH_SESSION_MAX_ACTIVE', 5, 1, 50)
  const rotationStartedAtRaw = env.AUTH_SESSION_KEY_ROTATION_STARTED_AT?.trim() || ''
  const rotationStartedAtMs = rotationStartedAtRaw ? Date.parse(rotationStartedAtRaw) : null
  if (rotationStartedAtMs !== null && (!Number.isFinite(rotationStartedAtMs) || rotationStartedAtMs > Date.now() + 5 * 60_000)) {
    throw new Error('[auth session policy] AUTH_SESSION_KEY_ROTATION_STARTED_AT must be a valid past ISO timestamp')
  }
  return Object.freeze({
    currentSecret,
    currentSecretExplicitlyConfigured: Boolean(explicitCurrentSecret),
    previousSecrets: Object.freeze(previousSecrets),
    rotationStartedAt: rotationStartedAtMs === null ? null : new Date(rotationStartedAtMs),
    transientTtlMs: transientTtlMinutes * 60_000,
    persistentTtlMs: persistentTtlDays * 24 * 60 * 60_000,
    renewWindowPercent,
    maxActiveSessions,
  })
}
