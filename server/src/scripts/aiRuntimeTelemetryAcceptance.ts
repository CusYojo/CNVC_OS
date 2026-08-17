import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  aiRuntimeTelemetrySnapshot,
  beginAiRuntimeRequest,
  finishAiRuntimeRequest,
  markAiRuntimeFirstToken,
  markAiRuntimeFirstTokenFromSdkMessage,
  resetAiRuntimeTelemetryForAcceptance,
} from '../runtime/aiRuntimeTelemetry.js'
import { evaluateAiRuntimeTelemetryAlerts } from '../services/operationalTelemetryService.js'

const checks: string[] = []
function check(condition: unknown, name: string, detail?: unknown) {
  assert.ok(condition, detail == null ? name : `${name}: ${JSON.stringify(detail)}`)
  checks.push(name)
}

function partialToken(text: string) {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  }
}

function objectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeys)
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, nested]) => [key, ...objectKeys(nested)])
}

async function main() {
  resetAiRuntimeTelemetryForAcceptance()
  const now = Date.parse('2026-08-11T05:00:00.000Z')
  const latencies = [100, 200, 300, 400, 6_000]
  for (let index = 0; index < latencies.length; index += 1) {
    const startedAt = now - 60_000 + index * 1_000
    const requestId = beginAiRuntimeRequest(index === 0 ? 'jw-agent' : 'lead-workflow-agent', startedAt)
    check(markAiRuntimeFirstTokenFromSdkMessage(requestId, partialToken('x'), startedAt + latencies[index]!) === true,
      `streaming-request-${index + 1}-records-first-token`)
    check(markAiRuntimeFirstToken(requestId, startedAt + latencies[index]! + 1_000) === false,
      `streaming-request-${index + 1}-keeps-first-observation`)
    finishAiRuntimeRequest(requestId, index === 3 ? 'failed' : 'succeeded', startedAt + 8_000)
  }
  for (let index = 0; index < 5; index += 1) {
    const startedAt = now - 30_000 + index * 1_000
    const requestId = beginAiRuntimeRequest(index === 0 ? 'gateway-vision' : 'gateway-text', startedAt)
    finishAiRuntimeRequest(requestId, index === 4 ? 'cancelled' : 'succeeded', startedAt + 2_000)
  }
  const activeRequestId = beginAiRuntimeRequest('lead-scoring-agent', now - 1_000)
  const snapshot = aiRuntimeTelemetrySnapshot(now)
  check(snapshot.activeRequests === 1 && snapshot.last15m.requests === 10,
    'active-and-completed-requests-are-separated', snapshot)
  check(snapshot.last15m.succeeded === 8 && snapshot.last15m.failed === 1 && snapshot.last15m.cancelled === 1,
    'success-failure-and-cancellation-are-counted', snapshot.last15m)
  check(snapshot.last15m.firstTokenObserved === 5 && snapshot.last15m.firstTokenUnavailable === 5
    && snapshot.last15m.firstTokenObservationCoverage === 0.5,
  'streaming-coverage-does-not-fake-non-streaming-first-token', snapshot.last15m)
  check(snapshot.last15m.firstTokenLatency.p50Ms === 300
    && snapshot.last15m.firstTokenLatency.p95Ms === 6_000,
  'first-token-percentiles-use-real-sdk-deltas', snapshot.last15m.firstTokenLatency)
  check(snapshot.last15m.totalDuration.samples === 10
    && snapshot.last15m.totalDuration.maximumMs === 8_000,
  'total-duration-is-aggregated-with-first-token-latency')
  check(snapshot.firstTokenDefinition === 'first-non-empty-sdk-text-or-thinking-delta'
    && snapshot.nonStreamingGatewayFirstTokenUnavailable === true,
  'first-token-semantics-and-non-streaming-limit-are-explicit')
  check(snapshot.secretsExcluded && snapshot.identitiesExcluded && snapshot.businessContentExcluded,
    'snapshot-declares-sensitive-and-business-content-exclusion')
  const serialized = JSON.stringify(snapshot)
  const forbiddenKeys = new Set([
    'requestId', 'prompt', 'output', 'model', 'modelId', 'user', 'userId', 'project', 'projectId',
    'conversation', 'conversationId', 'session', 'sessionId', 'tokenValue', 'apiKey', 'secret',
  ])
  check(objectKeys(snapshot).every((key) => !forbiddenKeys.has(key))
    && !serialized.includes('AiRuntimeAcceptancePromptSecretIdentity'),
  'snapshot-exposes-no-request-content-identity-or-secret-fields', objectKeys(snapshot))
  const alertCodes = evaluateAiRuntimeTelemetryAlerts(snapshot).map((alert) => alert.code).sort()
  check(alertCodes.includes('AI_FIRST_TOKEN_P95_LATENCY'), 'high-first-token-p95-emits-alert', alertCodes)
  check(alertCodes.includes('AI_FIRST_TOKEN_OBSERVATION_INCOMPLETE'), 'low-observation-coverage-emits-alert', alertCodes)
  finishAiRuntimeRequest(activeRequestId, 'cancelled', now)
  resetAiRuntimeTelemetryForAcceptance()
  const cleaned = aiRuntimeTelemetrySnapshot(now)
  check(cleaned.activeRequests === 0 && cleaned.last24h.requests === 0,
    'acceptance-telemetry-is-reset-with-zero-residue', cleaned)

  const result = { ok: true, checks, firstTokenSamples: 5, firstTokenP95Ms: 6_000, coverage: 0.5, residue: 0 }
  const evidenceRoot = path.resolve('.runtime/migration-evidence/ai-runtime-telemetry')
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
  await chmod(evidenceRoot, 0o700)
  const reportPath = path.join(evidenceRoot, 'report.json')
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  await chmod(reportPath, 0o600)
  console.log(JSON.stringify(result))
}

main().catch((error) => {
  resetAiRuntimeTelemetryForAcceptance()
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
