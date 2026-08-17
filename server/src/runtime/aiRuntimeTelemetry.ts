import { randomUUID } from 'node:crypto'

export const AI_RUNTIME_TELEMETRY_COMPONENT = 'ai-runtime-telemetry'

export type AiRuntimeScope =
  | 'gateway-text'
  | 'gateway-vision'
  | 'jw-agent'
  | 'lead-subject-agent'
  | 'lead-scoring-agent'
  | 'lead-workflow-agent'

type AiRuntimeOutcome = 'succeeded' | 'failed' | 'cancelled'

type ActiveRequest = {
  scope: AiRuntimeScope
  startedAt: number
  firstTokenAt: number | null
}

type CompletedRequest = ActiveRequest & {
  completedAt: number
  outcome: AiRuntimeOutcome
}

const retentionMs = 24 * 60 * 60 * 1_000
const maximumEvents = 5_000
const active = new Map<string, ActiveRequest>()
let completed: CompletedRequest[] = []

function nonNegativeTimestamp(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : Date.now()
}

function prune(now: number) {
  const cutoff = now - retentionMs
  completed = completed.filter((event) => event.completedAt >= cutoff).slice(-maximumEvents)
}

function percentile(values: number[], percentileValue: number) {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)
  return sorted[Math.min(index, sorted.length - 1)] || 0
}

function latencySummary(values: number[]) {
  return {
    samples: values.length,
    averageMs: values.length
      ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
      : 0,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maximumMs: values.length ? Math.max(...values) : 0,
  }
}

function windowSnapshot(events: CompletedRequest[]) {
  const firstTokenLatencies = events.flatMap((event) => (
    event.firstTokenAt == null ? [] : [Math.max(0, event.firstTokenAt - event.startedAt)]
  ))
  const totalLatencies = events.map((event) => Math.max(0, event.completedAt - event.startedAt))
  const firstTokenObserved = firstTokenLatencies.length
  const firstTokenUnavailable = Math.max(0, events.length - firstTokenObserved)
  return {
    requests: events.length,
    succeeded: events.filter((event) => event.outcome === 'succeeded').length,
    failed: events.filter((event) => event.outcome === 'failed').length,
    cancelled: events.filter((event) => event.outcome === 'cancelled').length,
    firstTokenObserved,
    firstTokenUnavailable,
    firstTokenObservationCoverage: events.length ? firstTokenObserved / events.length : 1,
    firstTokenLatency: latencySummary(firstTokenLatencies),
    totalDuration: latencySummary(totalLatencies),
  }
}

export function beginAiRuntimeRequest(scope: AiRuntimeScope, startedAt = Date.now()) {
  const requestId = randomUUID()
  active.set(requestId, {
    scope,
    startedAt: nonNegativeTimestamp(startedAt),
    firstTokenAt: null,
  })
  return requestId
}

export function markAiRuntimeFirstToken(requestId: string | null | undefined, observedAt = Date.now()) {
  if (!requestId) return false
  const request = active.get(requestId)
  if (!request || request.firstTokenAt != null) return false
  request.firstTokenAt = Math.max(request.startedAt, nonNegativeTimestamp(observedAt))
  return true
}

export function markAiRuntimeFirstTokenFromSdkMessage(
  requestId: string | null | undefined,
  message: unknown,
  observedAt = Date.now(),
) {
  if (!message || typeof message !== 'object') return false
  const raw = message as Record<string, unknown>
  if (raw.type !== 'stream_event' || !raw.event || typeof raw.event !== 'object') return false
  const event = raw.event as Record<string, unknown>
  if (event.type === 'content_block_start' && event.content_block && typeof event.content_block === 'object') {
    const block = event.content_block as Record<string, unknown>
    const initial = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : null
    return typeof initial === 'string' && initial.length > 0
      ? markAiRuntimeFirstToken(requestId, observedAt)
      : false
  }
  if (event.type !== 'content_block_delta' || !event.delta || typeof event.delta !== 'object') return false
  const delta = event.delta as Record<string, unknown>
  const token = delta.type === 'text_delta' ? delta.text : delta.type === 'thinking_delta' ? delta.thinking : null
  return typeof token === 'string' && token.length > 0
    ? markAiRuntimeFirstToken(requestId, observedAt)
    : false
}

export function finishAiRuntimeRequest(
  requestId: string | null | undefined,
  outcome: AiRuntimeOutcome,
  completedAt = Date.now(),
) {
  if (!requestId) return false
  const request = active.get(requestId)
  if (!request) return false
  active.delete(requestId)
  const endedAt = Math.max(request.startedAt, nonNegativeTimestamp(completedAt))
  completed.push({ ...request, completedAt: endedAt, outcome })
  prune(endedAt)
  return true
}

export async function observeNonStreamingAiRuntimeRequest<T>(
  scope: Extract<AiRuntimeScope, 'gateway-text' | 'gateway-vision'>,
  execute: () => Promise<T>,
) {
  const requestId = beginAiRuntimeRequest(scope)
  try {
    const result = await execute()
    finishAiRuntimeRequest(requestId, 'succeeded')
    return result
  } catch (error) {
    finishAiRuntimeRequest(requestId, 'failed')
    throw error
  }
}

export function aiRuntimeTelemetrySnapshot(now = Date.now()) {
  const observedAt = nonNegativeTimestamp(now)
  prune(observedAt)
  const recent15m = completed.filter((event) => event.completedAt >= observedAt - 15 * 60 * 1_000)
  const recent24h = completed.filter((event) => event.completedAt >= observedAt - retentionMs)
  const scopes = (Object.entries(recent24h.reduce<Record<string, number>>((counts, event) => {
    counts[event.scope] = (counts[event.scope] || 0) + 1
    return counts
  }, {})) as Array<[AiRuntimeScope, number]>).map(([scope, requests]) => ({ scope, requests }))
  return {
    ok: true,
    name: AI_RUNTIME_TELEMETRY_COMPONENT,
    kind: 'ai-runtime-telemetry',
    activeRequests: active.size,
    last15m: windowSnapshot(recent15m),
    last24h: windowSnapshot(recent24h),
    scopes,
    retentionWindowMinutes: retentionMs / 60_000,
    maximumEvents,
    firstTokenDefinition: 'first-non-empty-sdk-text-or-thinking-delta',
    nonStreamingGatewayFirstTokenUnavailable: true,
    processLocalWindow: true,
    restartResetsWindow: true,
    secretsExcluded: true,
    identitiesExcluded: true,
    businessContentExcluded: true,
  }
}

export function resetAiRuntimeTelemetryForAcceptance() {
  active.clear()
  completed = []
}
