import { resolveExtensionFeatureFlags } from './extensionFeatureFlags.js'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be ${minimum}..${maximum}`)
  }
  return value
}

function safeIdentifier(name: string, fallback: string) {
  const value = (process.env[name] || fallback).trim()
  if (!/^[A-Za-z0-9_.:/\-\u4e00-\u9fff]{3,128}$/.test(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function enabled(name: string, fallback = true) {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) return fallback
  return !['0', 'false', 'no', 'off'].includes(value)
}

export function operationalAlertPolicy() {
  const rawBindingId = process.env.OPS_ALERT_NOTIFICATION_CHANNEL_ID?.trim() || ''
  if (rawBindingId && !uuidPattern.test(rawBindingId)) {
    throw new Error('OPS_ALERT_NOTIFICATION_CHANNEL_ID must be an enabled IM binding UUID')
  }
  const escalationPolicyId = process.env.OPS_ALERT_ESCALATION_POLICY_ID?.trim() || ''
  if (escalationPolicyId) safeIdentifier('OPS_ALERT_ESCALATION_POLICY_ID', escalationPolicyId)
  const outboxDeliveryEnabled = resolveExtensionFeatureFlags().imIntegrationsEnabled
    && enabled('IM_OUTBOX_ENABLED')
  return {
    ownerRole: safeIdentifier('OPS_ALERT_OWNER_ROLE', 'operations-on-call'),
    bindingId: rawBindingId || null,
    notificationChannelConfigured: Boolean(rawBindingId),
    escalationPolicyConfigured: Boolean(escalationPolicyId),
    inProcessOutboxDeliveryConfigured: Boolean(rawBindingId) && outboxDeliveryEnabled,
    reminderMinutes: boundedInteger('OPS_ALERT_REMINDER_MINUTES', 60, 5, 10_080),
  }
}
