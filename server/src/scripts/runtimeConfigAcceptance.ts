import assert from 'node:assert/strict'
import { validateRuntimeConfiguration } from '../config/runtimeSafety.js'

const productionBase = {
  NODE_ENV: 'production',
  API_PORT: '3100',
  AUTH_SESSION_SECRET: 'session-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
  JWT_SECRET: 'jwt-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
  AUTH_COOKIE_SECURE: 'true',
  AUTH_COOKIE_SAME_SITE: 'lax',
  AUTH_ALLOWED_ORIGINS: 'https://investment.example.com',
  AUTH_ALLOW_LEGACY_BEARER: 'false',
  SEED_DEMO_USERS: 'false',
  MODEL_CREDENTIAL_ENCRYPTION_KEY: '11'.repeat(32),
  INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: '22'.repeat(32),
  MODEL_PROVIDER_ALLOWED_HOSTS: 'skill.zeelin.cn',
}
const legacyMigrationPatch = {
  AUTH_ALLOW_LEGACY_BEARER: 'true',
  AUTH_LEGACY_BEARER_CUTOFF: new Date(Date.now() + 60 * 60_000).toISOString(),
  AUTH_LEGACY_BEARER_ALLOWED_USER_IDS: '11111111-1111-4111-8111-111111111111',
}

function rejected(name: string, patch: Record<string, string | undefined>, pattern: RegExp) {
  assert.throws(() => validateRuntimeConfiguration({ ...productionBase, ...patch }), pattern, name)
}

const valid = validateRuntimeConfiguration(productionBase)
assert.equal(valid.production, true)
assert.equal(valid.secureCookie, true)
assert.equal(valid.jwConversationRollout.globalNewConversationsEnabled, true)
assert.equal(valid.jwConversationRollout.projectNewConversationsEnabled, true)
assert.equal(valid.extensionFeatures.aiCapabilitiesEnabled, true)
assert.equal(valid.extensionFeatures.imIntegrationsEnabled, true)
assert.equal(valid.migrationWriteFreeze.enabled, false)
rejected('missing session secret', { AUTH_SESSION_SECRET: undefined }, /AUTH_SESSION_SECRET/)
rejected('example JWT secret', { JWT_SECRET: 'change-me' }, /JWT_SECRET/)
rejected('insecure production cookie', { AUTH_COOKIE_SECURE: 'false' }, /AUTH_COOKIE_SECURE/)
rejected('HTTP production origin', { AUTH_ALLOWED_ORIGINS: 'http:\/\/investment.example.com' }, /HTTPS/)
rejected('origin with path', { AUTH_ALLOWED_ORIGINS: 'https:\/\/investment.example.com\/api' }, /without paths/)
rejected('legacy Bearer in production', legacyMigrationPatch, /legacy Bearer/)
rejected('legacy Bearer missing cutoff', {
  NODE_ENV: 'development', AUTH_ALLOW_LEGACY_BEARER: 'true',
  AUTH_LEGACY_BEARER_ALLOWED_USER_IDS: legacyMigrationPatch.AUTH_LEGACY_BEARER_ALLOWED_USER_IDS,
}, /CUTOFF/)
rejected('legacy Bearer missing user scope', {
  NODE_ENV: 'development', AUTH_ALLOW_LEGACY_BEARER: 'true',
  AUTH_LEGACY_BEARER_CUTOFF: legacyMigrationPatch.AUTH_LEGACY_BEARER_CUTOFF,
}, /1-100 UUIDs/)
rejected('demo users in production', { SEED_DEMO_USERS: 'true' }, /demo users/)
rejected('missing model credential encryption key', { MODEL_CREDENTIAL_ENCRYPTION_KEY: undefined }, /MODEL_CREDENTIAL_ENCRYPTION_KEY/)
rejected('missing integration credential encryption key', { INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: undefined }, /INTEGRATION_CREDENTIAL_ENCRYPTION_KEY/)
rejected('missing model provider host allowlist', { MODEL_PROVIDER_ALLOWED_HOSTS: undefined }, /MODEL_PROVIDER_ALLOWED_HOSTS/)
rejected('SameSite none without secure cookie', {
  NODE_ENV: 'development', AUTH_COOKIE_SAME_SITE: 'none', AUTH_COOKIE_SECURE: 'false',
}, /SameSite=None/)
rejected('invalid API port', { API_PORT: '70000' }, /API_PORT/)
rejected('weak previous session secret', {
  AUTH_SESSION_PREVIOUS_SECRETS: 'weak-old-secret',
}, /AUTH_SESSION_PREVIOUS_SECRETS/)
rejected('invalid concurrent session limit', { AUTH_SESSION_MAX_ACTIVE: '0' }, /AUTH_SESSION_MAX_ACTIVE/)
rejected('invalid session renewal window', { AUTH_SESSION_RENEW_WINDOW_PERCENT: '80' }, /AUTH_SESSION_RENEW_WINDOW_PERCENT/)
rejected('invalid global JW rollout flag', { JW_GLOBAL_NEW_CONVERSATIONS_ENABLED: '1' }, /JW_GLOBAL_NEW_CONVERSATIONS_ENABLED/)
rejected('invalid project JW rollout flag', { JW_PROJECT_NEW_CONVERSATIONS_ENABLED: 'yes' }, /JW_PROJECT_NEW_CONVERSATIONS_ENABLED/)
rejected('invalid AI capabilities flag', { AI_CAPABILITIES_ENABLED: '1' }, /AI_CAPABILITIES_ENABLED/)
rejected('invalid IM integrations flag', { IM_INTEGRATIONS_ENABLED: 'yes' }, /IM_INTEGRATIONS_ENABLED/)
rejected('invalid migration write freeze flag', { MIGRATION_WRITE_FREEZE: '1' }, /MIGRATION_WRITE_FREEZE/)
rejected('write freeze without rollback-window mode', {
  MIGRATION_WRITE_FREEZE: 'true', MIGRATION_WRITE_FREEZE_MODE: undefined,
}, /MIGRATION_WRITE_FREEZE_MODE/)
rejected('write freeze with unsupported mode', {
  MIGRATION_WRITE_FREEZE: 'true', MIGRATION_WRITE_FREEZE_MODE: 'maintenance',
}, /rollback-window/)
rejected('stale write freeze mode while disabled', {
  MIGRATION_WRITE_FREEZE: 'false', MIGRATION_WRITE_FREEZE_MODE: 'rollback-window',
}, /must be empty/)

const independentJwRollout = validateRuntimeConfiguration({
  ...productionBase,
  JW_GLOBAL_NEW_CONVERSATIONS_ENABLED: 'true',
  JW_PROJECT_NEW_CONVERSATIONS_ENABLED: 'false',
})
assert.equal(independentJwRollout.jwConversationRollout.globalNewConversationsEnabled, true)
assert.equal(independentJwRollout.jwConversationRollout.projectNewConversationsEnabled, false)

const independentExtensions = validateRuntimeConfiguration({
  ...productionBase,
  AI_CAPABILITIES_ENABLED: 'false',
  IM_INTEGRATIONS_ENABLED: 'true',
})
assert.equal(independentExtensions.extensionFeatures.aiCapabilitiesEnabled, false)
assert.equal(independentExtensions.extensionFeatures.imIntegrationsEnabled, true)

const rollbackWindow = validateRuntimeConfiguration({
  ...productionBase,
  MIGRATION_WRITE_FREEZE: 'true',
  MIGRATION_WRITE_FREEZE_MODE: 'rollback-window',
})
assert.equal(rollbackWindow.migrationWriteFreeze.enabled, true)
assert.equal(rollbackWindow.migrationWriteFreeze.mode, 'rollback-window')

console.log(JSON.stringify({
  ok: true,
  checks: [
    'valid-production-contract', 'strong-session-secret', 'strong-jwt-secret',
    'secure-cookie-required', 'https-origin-required', 'origin-path-rejected',
    'legacy-bearer-rejected', 'legacy-bearer-cutoff-required', 'legacy-bearer-user-scope-required',
    'demo-seed-rejected', 'same-site-secure-coupling', 'api-port-range',
    'previous-session-secret-strength', 'concurrent-session-limit-range', 'renew-window-range',
    'model-credential-encryption-key-required', 'model-provider-host-allowlist-required',
    'integration-credential-encryption-key-required',
    'jw-global-project-new-conversation-flags-independent-and-strictly-boolean',
    'ai-capability-and-im-extension-flags-independent-and-strictly-boolean',
    'migration-write-freeze-flag-and-mode-fail-closed',
  ],
}))
