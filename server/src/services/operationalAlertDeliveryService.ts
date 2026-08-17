import { createHash, randomUUID } from 'node:crypto'
import { operationalAlertPolicy } from '../config/operationalAlertPolicy.js'
import { imIntegrationRepository } from '../repositories/index.js'
import type { OperationalAlert } from './operationalTelemetryService.js'
import { operationalTelemetrySnapshot } from './operationalTelemetryService.js'

type AlertSnapshot = {
  timestamp: string
  status: 'ok' | 'warning' | 'critical'
  alerts: OperationalAlert[]
}

function sha256(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function alertFingerprint(alerts: OperationalAlert[]) {
  return sha256(alerts.map((alert) => ({ code: alert.code, severity: alert.severity })).sort((left, right) =>
    left.code.localeCompare(right.code) || left.severity.localeCompare(right.severity)))
}

function activeMessage(snapshot: AlertSnapshot) {
  const lines = snapshot.alerts.slice().sort((left, right) => left.code.localeCompare(right.code)).map((alert) =>
    `- [${alert.severity}] ${alert.code}: ${alert.metric}=${alert.value} (threshold=${alert.threshold})`)
  return [`[cybernaut-app] ${snapshot.status.toUpperCase()} operational alert`, ...lines].join('\n').slice(0, 4_000)
}

function recoveredMessage(alertCodes: string[]) {
  return [
    '[cybernaut-app] RECOVERED operational alert',
    `- cleared: ${alertCodes.slice().sort().join(', ') || 'previous alert set'}`,
  ].join('\n').slice(0, 4_000)
}

export async function dispatchOperationalAlerts(input?: { snapshot?: AlertSnapshot; now?: Date }) {
  const policy = operationalAlertPolicy()
  if (!policy.bindingId) return { configured: false, status: 'disabled' as const, enqueued: 0 }
  if (!policy.inProcessOutboxDeliveryConfigured) {
    return { configured: true, status: 'scheduler_disabled' as const, enqueued: 0 }
  }
  const now = input?.now ?? new Date()
  const collected = input?.snapshot ?? await operationalTelemetrySnapshot()
  const snapshot: AlertSnapshot = {
    timestamp: collected.timestamp,
    status: collected.status === 'critical' ? 'critical' : collected.status === 'warning' ? 'warning' : 'ok',
    alerts: collected.alerts,
  }
  const latest = await imIntegrationRepository.findLatestOperationalAlert(policy.bindingId)
  const active = snapshot.alerts.length > 0
  if (!active && !latest) {
    return { configured: true, status: 'quiet' as const, enqueued: 0 }
  }
  if (!active && latest?.state === 'recovered') {
    return { configured: true, status: 'deduplicated' as const, enqueued: 0, state: 'recovered' as const }
  }

  const state = active ? 'active' as const : 'recovered' as const
  const fingerprint = active ? alertFingerprint(snapshot.alerts) : sha256({ recovered: latest?.fingerprint || '' })
  const reminderMs = policy.reminderMinutes * 60_000
  const sameState = latest?.state === state && latest.fingerprint === fingerprint
  if (sameState && now.getTime() - latest.createdAt.getTime() < reminderMs) {
    return { configured: true, status: 'deduplicated' as const, enqueued: 0, state }
  }

  const reminderBucket = sameState ? Math.floor(now.getTime() / reminderMs) : null
  const transitionIdentity = sameState ? `reminder:${reminderBucket}` : `after:${latest?.id || 'none'}`
  const idempotencyKey = `ops-alert:${state}:${fingerprint}:${transitionIdentity}`
  const alertCodes = active ? snapshot.alerts.map((alert) => alert.code).sort() : latest?.alertCodes || []
  const payload = {
    kind: 'operational-alert',
    state,
    fingerprint,
    alertCodes,
    severity: active ? snapshot.status : 'ok',
    observedAt: snapshot.timestamp,
    message: active ? activeMessage(snapshot) : recoveredMessage(alertCodes),
  }
  const payloadHash = sha256(payload)
  const id = randomUUID()
  const result = await imIntegrationRepository.enqueueOperationalAlert({
    id,
    bindingId: policy.bindingId,
    idempotencyKey,
    payloadHash,
    payload,
    audit: {
      userId: null,
      userName: 'cybernaut-app',
      module: '运维告警',
      action: state === 'active' ? '创建告警发送任务' : '创建恢复通知任务',
      target: `${id}:${state}:${fingerprint}`,
      result: 'success',
    },
  })
  if (result.status === 'binding_disabled') {
    throw Object.assign(new Error('configured operational alert IM binding is unavailable'), {
      code: 'OPS_ALERT_BINDING_UNAVAILABLE',
    })
  }
  if (result.status === 'idempotency_conflict') {
    throw Object.assign(new Error('operational alert idempotency conflict'), {
      code: 'OPS_ALERT_IDEMPOTENCY_CONFLICT',
    })
  }
  return {
    configured: true,
    status: result.status,
    enqueued: result.status === 'created' ? 1 : 0,
    state,
    alertCodes,
  }
}
