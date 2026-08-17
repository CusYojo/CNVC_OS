import type { RequestHandler } from 'express'

type RuntimeEnvironment = Record<string, string | undefined>

function strictBoolean(env: RuntimeEnvironment, name: string, fallback: boolean): boolean {
  const value = env[name]?.trim().toLowerCase()
  if (!value) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`[runtime config] ${name} must be true or false`)
}

export function resolveExtensionFeatureFlags(env: RuntimeEnvironment = process.env) {
  return Object.freeze({
    aiCapabilitiesEnabled: strictBoolean(env, 'AI_CAPABILITIES_ENABLED', true),
    imIntegrationsEnabled: strictBoolean(env, 'IM_INTEGRATIONS_ENABLED', true),
  })
}

function requireFeature(
  enabled: () => boolean,
  code: string,
  message: string,
): RequestHandler {
  return (_req, res, next) => {
    if (enabled()) {
      next()
      return
    }
    res.status(503).json({ code, message, details: null, requestId: String(res.locals.requestId || '') })
  }
}

export const requireAiCapabilitiesEnabled = requireFeature(
  () => resolveExtensionFeatureFlags().aiCapabilitiesEnabled,
  'AI_CAPABILITIES_DISABLED',
  '能力扩展当前已由运维开关停用。',
)

export const requireImIntegrationsEnabled = requireFeature(
  () => resolveExtensionFeatureFlags().imIntegrationsEnabled,
  'IM_INTEGRATIONS_DISABLED',
  'IM 集成当前已由运维开关停用。',
)
