import { createHash, randomUUID } from 'node:crypto'
import { imIntegrationRepository } from '../repositories/index.js'
import { summarizeRadarSourceRun, type RadarRunAction } from './radarSourceRunSummary.js'

export { summarizeRadarSourceRun, type RadarRunAction } from './radarSourceRunSummary.js'

function enabledEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) return fallback
  return !['0', 'false', 'no', 'off'].includes(value)
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export async function reportRadarSourceRun(
  action: RadarRunAction,
  input: { result?: Record<string, unknown>; error?: unknown; observedAt?: Date },
) {
  const summary = summarizeRadarSourceRun(action, input.result, input.error)
  const observedAt = (input.observedAt ?? new Date()).toISOString()
  const log = { event: 'radar.source_run', observedAt, ...summary }
  if (summary.status === 'failed') console.error(JSON.stringify(log))
  else if (summary.status === 'partial') console.warn(JSON.stringify(log))
  else console.log(JSON.stringify(log))

  const bindingId = process.env.RADAR_NOTIFICATION_CHANNEL_ID?.trim()
    || process.env.OPS_ALERT_NOTIFICATION_CHANNEL_ID?.trim()
  const shouldNotify = summary.status !== 'succeeded' || enabledEnv('RADAR_NOTIFY_SUCCESS', true)
  if (!bindingId || !shouldNotify) {
    return { ...summary, configured: Boolean(bindingId), enqueued: 0 }
  }
  const payload = {
    kind: 'radar-source-monitor',
    action,
    status: summary.status,
    observedAt,
    metrics: summary.metrics,
    message: summary.message,
  }
  const payloadHash = sha256(payload)
  const result = await imIntegrationRepository.enqueueSystemNotification({
    id: randomUUID(),
    bindingId,
    idempotencyKey: `radar-source:${action}:${payloadHash}`,
    payloadHash,
    payload,
    audit: {
      userId: null,
      userName: 'cybernaut-app',
      module: '数据源监控',
      action: '创建采集状态通知',
      target: `${action}:${summary.status}:${payloadHash.slice(0, 16)}`,
      result: 'success',
    },
  })
  if (result.status === 'binding_disabled') throw new Error('Radar 通知绑定未启用')
  if (result.status === 'idempotency_conflict') throw new Error('Radar 通知幂等键冲突')
  return { ...summary, configured: true, enqueued: result.status === 'created' ? 1 : 0 }
}
