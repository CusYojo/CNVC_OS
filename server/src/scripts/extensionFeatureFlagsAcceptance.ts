import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import { resolveExtensionFeatureFlags } from '../config/extensionFeatureFlags.js'
import { validateRuntimeConfiguration } from '../config/runtimeSafety.js'
import { aiCapabilitiesRouter } from '../routes/aiCapabilities.js'
import { imInboundRouter, imIntegrationsRouter } from '../routes/imIntegrations.js'
import { leadPushTargetsRouter } from '../routes/leadPushTargets.js'
import { resolveAgentRuntimePolicy, resolveSelectedRuntimeCapabilities } from '../services/aiCapabilityService.js'
import { runtimeJobDefinitions } from '../services/runtimeJobScheduler.js'

const original = {
  AI_CAPABILITIES_ENABLED: process.env.AI_CAPABILITIES_ENABLED,
  IM_INTEGRATIONS_ENABLED: process.env.IM_INTEGRATIONS_ENABLED,
  IM_OUTBOX_ENABLED: process.env.IM_OUTBOX_ENABLED,
}

const productionBase = {
  NODE_ENV: 'production', API_PORT: '3100',
  AUTH_SESSION_SECRET: 'session-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
  JWT_SECRET: 'jwt-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
  AUTH_COOKIE_SECURE: 'true', AUTH_COOKIE_SAME_SITE: 'lax',
  AUTH_ALLOWED_ORIGINS: 'https://investment.example.com',
  AUTH_ALLOW_LEGACY_BEARER: 'false', SEED_DEMO_USERS: 'false',
  MODEL_CREDENTIAL_ENCRYPTION_KEY: '11'.repeat(32),
  MODEL_PROVIDER_ALLOWED_HOSTS: 'skill.zeelin.cn',
}

async function main() {
  assert.deepEqual(resolveExtensionFeatureFlags({}), {
    aiCapabilitiesEnabled: true, imIntegrationsEnabled: true,
  })
  assert.throws(() => resolveExtensionFeatureFlags({ AI_CAPABILITIES_ENABLED: '1' }), /AI_CAPABILITIES_ENABLED/)
  assert.throws(() => resolveExtensionFeatureFlags({ IM_INTEGRATIONS_ENABLED: 'yes' }), /IM_INTEGRATIONS_ENABLED/)

  const disabledConfig = validateRuntimeConfiguration({
    ...productionBase,
    AI_CAPABILITIES_ENABLED: 'false',
    IM_INTEGRATIONS_ENABLED: 'false',
  })
  assert.equal(disabledConfig.extensionFeatures.aiCapabilitiesEnabled, false)
  assert.equal(disabledConfig.extensionFeatures.imIntegrationsEnabled, false)
  assert.throws(() => validateRuntimeConfiguration({
    ...productionBase,
    IM_INTEGRATIONS_ENABLED: 'true',
  }), /INTEGRATION_CREDENTIAL_ENCRYPTION_KEY/)

  process.env.AI_CAPABILITIES_ENABLED = 'false'
  process.env.IM_INTEGRATIONS_ENABLED = 'false'
  process.env.IM_OUTBOX_ENABLED = 'true'
  const policy = await resolveAgentRuntimePolicy('interactive-assistant')
  assert.equal(policy.profileKey, 'interactive-assistant')
  const fallback = await resolveSelectedRuntimeCapabilities({
    userId: '00000000-0000-4000-8000-000000000001', userName: '开关验收', role: '投资经理', department: '验收部',
  }, '00000000-0000-4000-8000-000000000002')
  assert.equal(fallback.length, 1)
  assert.equal(fallback[0].capabilityKey, 'interactive-assistant')
  assert.deepEqual(fallback[0].toolNames, [])
  assert.equal(runtimeJobDefinitions().find((item) => item.id === 'im-outbox-dispatch')?.enabled, false)

  const app = express()
  app.use(express.json())
  app.use('/capabilities', aiCapabilitiesRouter)
  app.use('/im', imIntegrationsRouter)
  app.use('/inbound', imInboundRouter)
  app.use('/push-targets', leadPushTargetsRouter)
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('feature flag acceptance server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    for (const [path, code] of [
      ['/capabilities', 'AI_CAPABILITIES_DISABLED'],
      ['/im', 'IM_INTEGRATIONS_DISABLED'],
      ['/inbound/00000000-0000-4000-8000-000000000003', 'IM_INTEGRATIONS_DISABLED'],
      ['/push-targets', 'IM_INTEGRATIONS_DISABLED'],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`)
      assert.equal(response.status, 503, `${path} should be disabled`)
      assert.equal((await response.json() as { code?: string }).code, code)
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }

  process.env.IM_INTEGRATIONS_ENABLED = 'true'
  assert.equal(runtimeJobDefinitions().find((item) => item.id === 'im-outbox-dispatch')?.enabled, true)

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'extension-flags-default-enabled-and-strictly-boolean',
      'capability-and-im-flags-are-independent',
      'disabled-im-does-not-require-production-credential-key',
      'enabled-im-requires-production-credential-key',
      'disabled-capabilities-fall-back-to-tool-free-core-agent',
      'disabled-im-stops-outbox-job',
      'disabled-capability-management-api-fails-closed',
      'disabled-im-management-inbound-and-lead-push-apis-fail-closed',
      're-enabled-im-restores-outbox-job-definition',
    ],
    count: 9,
  }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
