import { resolveAuthSessionPolicy } from './authSessionPolicy.js'
import { resolveJwConversationRolloutPolicy } from './jwConversationRolloutPolicy.js'
import { resolveLegacyBearerPolicy } from './legacyBearerPolicy.js'
import { resolveExtensionFeatureFlags } from './extensionFeatureFlags.js'
import { resolveMigrationWriteFreezePolicy } from './migrationWriteFreezePolicy.js'

type RuntimeEnvironment = Record<string, string | undefined>

function configuredBoolean(env: RuntimeEnvironment, name: string, fallback: boolean): boolean {
  const value = env[name]?.trim().toLowerCase()
  if (!value) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`[runtime config] ${name} must be true or false`)
}

function strongSecret(env: RuntimeEnvironment, name: string): string {
  const value = env[name]?.trim() || ''
  if (value.length < 32 || /^(?:change-me|change-me-too|cybernaut-dev-secret-change-me)$/i.test(value)) {
    throw new Error(`[runtime config] ${name} must be a non-example secret of at least 32 characters`)
  }
  return value
}

function modelCredentialEncryptionKeyReady(env: RuntimeEnvironment): boolean {
  const value = env.MODEL_CREDENTIAL_ENCRYPTION_KEY?.trim() || ''
  if (/^[0-9a-f]{64}$/i.test(value)) return true
  try { return Buffer.from(value, 'base64').length === 32 } catch { return false }
}

function integrationCredentialEncryptionKeyReady(env: RuntimeEnvironment): boolean {
  const value = env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY?.trim() || ''
  if (/^[0-9a-f]{64}$/i.test(value)) return true
  try { return Buffer.from(value, 'base64').length === 32 } catch { return false }
}

function modelProviderAllowedHosts(env: RuntimeEnvironment, production: boolean): string[] {
  const hosts = (env.MODEL_PROVIDER_ALLOWED_HOSTS || '').split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (production && hosts.length === 0) {
    throw new Error('[runtime config] MODEL_PROVIDER_ALLOWED_HOSTS must contain at least one approved model gateway host in production')
  }
  for (const host of hosts) {
    if (host.includes('://') || host.includes('/') || host.includes('@') || host.includes(':')) {
      throw new Error(`[runtime config] MODEL_PROVIDER_ALLOWED_HOSTS entries must be hostnames without scheme, path or port: ${host}`)
    }
    try {
      const parsed = new URL(`https://${host}`)
      if (parsed.hostname !== host) throw new Error('not a hostname')
    } catch {
      throw new Error(`[runtime config] invalid MODEL_PROVIDER_ALLOWED_HOSTS entry: ${host}`)
    }
  }
  return hosts
}

function allowedOrigins(env: RuntimeEnvironment, production: boolean): string[] {
  const values = (env.AUTH_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean)
  if (production && values.length === 0) {
    throw new Error('[runtime config] AUTH_ALLOWED_ORIGINS must contain at least one HTTPS origin in production')
  }
  for (const value of values) {
    let parsed: URL
    try { parsed = new URL(value) }
    catch { throw new Error(`[runtime config] invalid AUTH_ALLOWED_ORIGINS entry: ${value}`) }
    if (parsed.origin !== value.replace(/\/$/, '') || parsed.username || parsed.password) {
      throw new Error(`[runtime config] AUTH_ALLOWED_ORIGINS entries must be origins without paths or credentials: ${value}`)
    }
    if (production && parsed.protocol !== 'https:') {
      throw new Error(`[runtime config] production origin must use HTTPS: ${value}`)
    }
  }
  return values
}

export function validateRuntimeConfiguration(env: RuntimeEnvironment = process.env) {
  const production = env.NODE_ENV === 'production'
  const port = Number(env.API_PORT || 4100)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('[runtime config] API_PORT must be an integer between 1 and 65535')
  }
  const secureCookie = configuredBoolean(env, 'AUTH_COOKIE_SECURE', production)
  const legacyBearerPolicy = resolveLegacyBearerPolicy(env)
  const legacyBearer = legacyBearerPolicy.enabled
  const seedDemoUsers = configuredBoolean(env, 'SEED_DEMO_USERS', false)
  const sameSite = (env.AUTH_COOKIE_SAME_SITE || 'lax').trim().toLowerCase()
  if (!['lax', 'strict', 'none'].includes(sameSite)) {
    throw new Error('[runtime config] AUTH_COOKIE_SAME_SITE must be lax, strict or none')
  }
  if (sameSite === 'none' && !secureCookie) {
    throw new Error('[runtime config] SameSite=None requires AUTH_COOKIE_SECURE=true')
  }
  const origins = allowedOrigins(env, production)
  const providerAllowedHosts = modelProviderAllowedHosts(env, production)
  const sessionPolicy = resolveAuthSessionPolicy(env)
  const jwConversationRollout = resolveJwConversationRolloutPolicy(env)
  const extensionFeatures = resolveExtensionFeatureFlags(env)
  const migrationWriteFreeze = resolveMigrationWriteFreezePolicy(env)
  if (production) {
    strongSecret(env, 'AUTH_SESSION_SECRET')
    strongSecret(env, 'JWT_SECRET')
    for (const previousSecret of sessionPolicy.previousSecrets) {
      if (previousSecret.length < 32 || /^(?:change-me|change-me-too|cybernaut-dev-secret-change-me)$/i.test(previousSecret)) {
        throw new Error('[runtime config] every AUTH_SESSION_PREVIOUS_SECRETS entry must be a non-example secret of at least 32 characters')
      }
    }
    if (!secureCookie) throw new Error('[runtime config] production requires AUTH_COOKIE_SECURE=true and TLS')
    if (legacyBearer) throw new Error('[runtime config] production legacy Bearer is disabled; use an approved migration-only environment for legacy JWT testing')
    if (seedDemoUsers) throw new Error('[runtime config] production must not seed demo users')
    if (!modelCredentialEncryptionKeyReady(env)) {
      throw new Error('[runtime config] MODEL_CREDENTIAL_ENCRYPTION_KEY must be 32-byte Base64 or 64-character hex in production')
    }
    if (extensionFeatures.imIntegrationsEnabled && !integrationCredentialEncryptionKeyReady(env)) {
      throw new Error('[runtime config] INTEGRATION_CREDENTIAL_ENCRYPTION_KEY must be 32-byte Base64 or 64-character hex in production')
    }
  }
  return Object.freeze({
    production, port, secureCookie, legacyBearer, legacyBearerPolicy: {
      enabled: legacyBearerPolicy.enabled,
      active: legacyBearerPolicy.active,
      cutoff: legacyBearerPolicy.cutoff?.toISOString() ?? null,
      allowedUserCount: legacyBearerPolicy.allowedUserIds.length,
    }, seedDemoUsers, sameSite, origins, providerAllowedHosts, sessionPolicy, jwConversationRollout, extensionFeatures,
    migrationWriteFreeze,
  })
}

export function assertRuntimeConfiguration(): void {
  validateRuntimeConfiguration(process.env)
}
