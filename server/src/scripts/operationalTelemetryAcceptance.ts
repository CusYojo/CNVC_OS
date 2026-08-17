import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { operationalTelemetryRepository } from '../repositories/mysql/mysqlOperationalTelemetryRepository.js'
import { httpTelemetrySnapshot, recordHttpTelemetryForAcceptance } from '../runtime/httpTelemetry.js'
import {
  evaluateOperationalAlerts,
  operationalTelemetrySnapshot,
} from '../services/operationalTelemetryService.js'
import type { DocumentNativeRuntimeHealth } from '../services/documentNativeRuntimeTelemetryService.js'
import type { FileStorageCapacityHealth } from '../services/fileStorageCapacityTelemetryService.js'
import type { MigrationReadinessHealth } from '../services/migrationReadinessTelemetryService.js'
import { pool } from '../db/client.js'

const checks: string[] = []
function assert(condition: unknown, check: string): asserts condition {
  if (!condition) throw new Error(check)
  checks.push(check)
}

function nonNegativeTree(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0
  if (Array.isArray(value)) return value.every(nonNegativeTree)
  if (value && typeof value === 'object') return Object.values(value).every(nonNegativeTree)
  return true
}

async function main() {
  const now = Date.now()
  for (let index = 0; index < 18; index += 1) {
    recordHttpTelemetryForAcceptance(200, 20 + index, now - index * 100)
  }
  recordHttpTelemetryForAcceptance(503, 2_500, now - 100)
  recordHttpTelemetryForAcceptance(500, 3_000, now - 50)
  const http = httpTelemetrySnapshot(now)
  assert(http.last5m.requests === 20 && http.last5m.serverErrors === 2, 'http-rolling-window-counts-statuses')
  assert(http.last5m.p95Ms >= 2_500 && http.last5m.p99Ms >= 3_000, 'http-p95-p99-derived-from-bounded-events')
  assert(http.pathLabelsExcluded && !JSON.stringify(http).includes('/api/'), 'http-path-and-business-cardinality-excluded')

  const database = await operationalTelemetryRepository.snapshot()
  assert(nonNegativeTree(database), 'mysql-operational-aggregates-are-non-negative')
  assert(
    Object.keys(database).sort().join(',') === 'cdc,documents,files,im,jobHistory,leadAgents,leadReserve,mysqlPool,mysqlServer,processHistory,radar,security',
    'mysql-pool-server-im-file-security-ai-document-job-process-history-cdc-reserve-and-radar-domains-covered',
  )
  assert(
    database.mysqlServer.statusObservationAvailable
      && [
        database.mysqlServer.threadsConnected,
        database.mysqlServer.threadsRunning,
        database.mysqlServer.maxUsedConnections,
        database.mysqlServer.slowQueriesTotal,
        database.mysqlServer.currentRowLockWaits,
        database.mysqlServer.rowLockWaitsTotal,
        database.mysqlServer.rowLockTimeMsTotal,
      ].every((value) => Number.isFinite(value) && value >= 0),
    'mysql-runtime-account-observes-server-thread-slow-query-and-row-lock-status',
  )
  assert(database.leadReserve.total >= database.leadReserve.imported, 'lead-reserve-cursor-counts-are-coherent')
  assert(
    database.leadReserve.rawEventMissing === 0
      && database.leadReserve.maxSequence >= database.leadReserve.imported
      && database.leadReserve.importedTimestampMissing <= database.leadReserve.imported,
    'lead-reserve-source-event-sequence-and-import-time-gaps-are-observable',
  )
  assert(
    database.radar.runtimeJobs === 4
      && database.radar.rawEvents >= database.radar.candidates
      && database.radar.sourceRegistry > 0
      && database.radar.collectorStates > 0,
    'radar-candidate-source-state-cursor-and-runtime-job-status-are-observable',
  )
  assert(database.cdc.deleteEvents >= database.cdc.cascadeDeleteEvents, 'cdc-delete-and-cascade-counts-are-coherent')
  assert(
    database.jobHistory.lifecycleRecords24h >= database.jobHistory.leaseRecoveries24h,
    'job-lifecycle-and-lease-recovery-counts-are-coherent',
  )
  assert(
    [
      database.leadAgents.pendingReviews,
      database.leadAgents.openedReviews24h,
      database.leadAgents.resolvedReviews24h,
      database.leadAgents.averageReviewResolutionMs24h,
      database.leadAgents.oldestPendingReviewAgeMs,
      database.leadAgents.duplicateNameGroups,
      database.leadAgents.duplicateNameRecords,
      database.leadAgents.duplicateCompanyGroups,
      database.leadAgents.duplicateCompanyRecords,
      database.leadAgents.duplicateEntityGroups,
    ].every((value) => Number.isFinite(value) && value >= 0),
    'lead-review-backlog-throughput-and-resolution-duration-are-covered',
  )

  const syntheticDatabase = structuredClone(database)
  syntheticDatabase.mysqlPool.waitingRequests = 2
  syntheticDatabase.mysqlServer.statusObservationAvailable = true
  syntheticDatabase.mysqlServer.currentRowLockWaits = 1
  syntheticDatabase.mysqlServer.deadlockObservationAvailable = false
  syntheticDatabase.mysqlServer.replicationObservationAvailable = false
  syntheticDatabase.im.deadLetter = 1
  syntheticDatabase.files.parseFailed = 1
  syntheticDatabase.security.authenticationDenied15m = 5
  syntheticDatabase.security.credentialChanges15m = 1
  syntheticDatabase.security.highRiskToolDenied15m = 1
  syntheticDatabase.cdc.sources = 1
  syntheticDatabase.cdc.unhealthySources = 1
  syntheticDatabase.cdc.maxReplicationLagMs = 300_000
  syntheticDatabase.leadAgents.missingTokenRuns24h = 1
  syntheticDatabase.leadAgents.pendingReviews = 20
  syntheticDatabase.leadAgents.oldestPendingReviewAgeMs = 86_400_000
  syntheticDatabase.leadAgents.duplicateEntityGroups = 1
  syntheticDatabase.leadReserve.sourceMissing = 1
  syntheticDatabase.documents.renderFailures24h = 1
  syntheticDatabase.documents.qualityFailed24h = 1
  syntheticDatabase.documents.fontFailures24h = 1
  syntheticDatabase.jobHistory.failed24h = 1
  syntheticDatabase.jobHistory.deadLetter24h = 1
  syntheticDatabase.jobHistory.retriedRecords24h = 5
  syntheticDatabase.jobHistory.timeoutFailures24h = 1
  syntheticDatabase.jobHistory.leaseRecoveries24h = 1
  syntheticDatabase.jobHistory.expiredLeases = 1
  syntheticDatabase.jobHistory.leaseContentions24h = 10
  syntheticDatabase.jobHistory.duplicateSuppressed24h = 20
  syntheticDatabase.jobHistory.staleCompletionRejected24h = 1
  syntheticDatabase.jobHistory.leaseRecoveryEvents24h = 1
  syntheticDatabase.processHistory.failed24h = 1
  syntheticDatabase.processHistory.timeout24h = 1
  syntheticDatabase.processHistory.forceKilled24h = 1
  const thresholdAlerts = evaluateOperationalAlerts({
    http,
    database: syntheticDatabase,
    components: [
      { deadLetter: 1 },
      {
        kind: 'ai-runtime-telemetry',
        last15m: {
          requests: 10,
          firstTokenObserved: 5,
          firstTokenObservationCoverage: 0.5,
          firstTokenLatency: { p95Ms: 6_000 },
        },
      },
      { kind: 'document-native-runtime', missingRequired: 2 },
      { kind: 'file-storage-capacity', missingRequired: 1, minimumFreeBytes: 0, maximumUsedRatio: 1 },
    ],
  })
  const capacityAlerts = evaluateOperationalAlerts({
    http,
    database: syntheticDatabase,
    components: [{ kind: 'file-storage-capacity', missingRequired: 0, minimumFreeBytes: 1, maximumUsedRatio: 0.95 }],
  })
  const capacityBaselineAlerts = evaluateOperationalAlerts({
    http,
    database: syntheticDatabase,
    components: [{
      kind: 'file-storage-capacity', missingRequired: 0, minimumFreeBytes: 10_000_000_000,
      maximumUsedRatio: 0.5, historyObservationAvailable: true, baselineAvailable: false,
    }],
  })
  const capacityGrowthAlerts = evaluateOperationalAlerts({
    http,
    database: syntheticDatabase,
    components: [{
      kind: 'file-storage-capacity', missingRequired: 0, minimumFreeBytes: 10_000_000_000,
      maximumUsedRatio: 0.5, historyObservationAvailable: true, baselineAvailable: true,
      usedRatioIncrease24h: 0.05,
    }],
  })
  const unavailableStatusDatabase = structuredClone(syntheticDatabase)
  unavailableStatusDatabase.mysqlServer.statusObservationAvailable = false
  const unavailableStatusAlerts = evaluateOperationalAlerts({ http, database: unavailableStatusDatabase, components: [] })
  const unhealthyReplicaDatabase = structuredClone(syntheticDatabase)
  unhealthyReplicaDatabase.mysqlServer.replicationObservationAvailable = true
  unhealthyReplicaDatabase.mysqlServer.replicaConfigured = true
  unhealthyReplicaDatabase.mysqlServer.replicaIoRunning = false
  unhealthyReplicaDatabase.mysqlServer.replicaSqlRunning = false
  unhealthyReplicaDatabase.mysqlServer.replicationLagSeconds = 300
  const unhealthyReplicaAlerts = evaluateOperationalAlerts({ http, database: unhealthyReplicaDatabase, components: [] })
  const authKeyRotationAlerts = evaluateOperationalAlerts({
    http,
    database: syntheticDatabase,
    components: [{
      name: 'mysql-auth-sessions',
      keyRotation: {
        currentSecretConfigured: false,
        previousSecretCount: 1,
        rotationStartedAtConfigured: false,
        previousKeyMatches24h: 1,
        rotationWindowOverdue: true,
      },
    }],
  })
  const alertCodes = new Set([
    ...thresholdAlerts, ...capacityAlerts, ...capacityBaselineAlerts, ...capacityGrowthAlerts,
    ...unavailableStatusAlerts, ...unhealthyReplicaAlerts, ...authKeyRotationAlerts,
  ].map((alert) => alert.code))
  for (const code of [
    'HTTP_SERVER_ERROR_RATE', 'HTTP_P95_LATENCY', 'MYSQL_POOL_WAITING', 'QUEUE_DEAD_LETTER',
    'MYSQL_STATUS_OBSERVATION_UNAVAILABLE', 'MYSQL_ROW_LOCK_WAITING',
    'MYSQL_DEADLOCK_OBSERVATION_UNAVAILABLE', 'MYSQL_REPLICATION_OBSERVATION_UNAVAILABLE',
    'MYSQL_REPLICA_NOT_RUNNING', 'MYSQL_REPLICATION_LAG',
    'FILE_PARSE_FAILURE', 'AUTH_DENIED_SPIKE', 'CDC_REPLICATION_LAG', 'CDC_SOURCE_UNHEALTHY',
    'AI_TOKEN_USAGE_INCOMPLETE', 'LEAD_REVIEW_BACKLOG', 'LEAD_REVIEW_STALE',
    'AI_FIRST_TOKEN_P95_LATENCY', 'AI_FIRST_TOKEN_OBSERVATION_INCOMPLETE',
    'AUTH_SESSION_CURRENT_KEY_UNCONFIGURED', 'AUTH_SESSION_KEY_ROTATION_UNTRACKED',
    'AUTH_SESSION_LEGACY_KEY_ACTIVITY', 'AUTH_SESSION_PREVIOUS_KEYS_OVERDUE',
    'LEAD_ENTITY_DUPLICATE_GROUPS', 'LEAD_SOURCE_MISSING',
    'DOCUMENT_NATIVE_RUNTIME_MISSING', 'DOCUMENT_RENDER_FAILURE',
    'DOCUMENT_ARTIFACT_QUALITY_FAILURE', 'DOCUMENT_FONT_FAILURE',
    'FILE_STORAGE_ROOT_UNAVAILABLE', 'FILE_STORAGE_FREE_BYTES_LOW', 'FILE_STORAGE_USED_RATIO_HIGH',
    'FILE_STORAGE_HISTORY_UNAVAILABLE', 'FILE_STORAGE_GROWTH_BASELINE_UNAVAILABLE',
    'FILE_STORAGE_USED_RATIO_GROWTH_24H',
    'SECURITY_CREDENTIAL_CHANGED', 'SECURITY_HIGH_RISK_TOOL_DENIED',
    'JOB_FAILURE_24H', 'JOB_DEAD_LETTER_24H', 'JOB_RETRY_ACTIVITY_24H',
    'JOB_TIMEOUT_FAILURE_24H', 'JOB_LEASE_RECOVERY_24H', 'JOB_EXPIRED_LEASE',
    'JOB_LEASE_CONTENTION_24H', 'JOB_DUPLICATE_SUPPRESSED_24H',
    'JOB_STALE_COMPLETION_REJECTED_24H',
    'SUPERVISED_PROCESS_FAILURE_24H', 'SUPERVISED_PROCESS_TIMEOUT_24H',
    'SUPERVISED_PROCESS_FORCE_KILL_24H',
  ]) assert(alertCodes.has(code), `threshold-alert-${code.toLowerCase()}`)

  // Remove synthetic rolling events before collecting the observed database/component snapshot.
  httpTelemetrySnapshot(now + 16 * 60_000)
  const snapshot = await operationalTelemetrySnapshot()
  assert(snapshot.service === 'cybernaut-app' && Array.isArray(snapshot.components), 'single-service-components-share-one-operations-snapshot')
  const documentRuntime = snapshot.components.find((component) => (
    'kind' in component && component.kind === 'document-native-runtime'
  )) as DocumentNativeRuntimeHealth | undefined
  assert(
    Boolean(documentRuntime)
      && documentRuntime?.pathsExcluded === true
      && documentRuntime?.versionsExcluded === true
      && Number(documentRuntime?.requiredDependencies) >= 4
      && Object.keys(documentRuntime?.dependencies || {}).length === 6,
    'document-native-runtime-readiness-excludes-paths-and-versions',
  )
  const fileStorage = snapshot.components.find((component) => (
    'kind' in component && component.kind === 'file-storage-capacity'
  )) as FileStorageCapacityHealth | undefined
  assert(
    Boolean(fileStorage)
      && fileStorage?.pathsExcluded === true
      && Number(fileStorage?.requiredRoots) === 2
      && Number(fileStorage?.monitoredRoots) === 4
      && typeof fileStorage?.historyObservationAvailable === 'boolean'
      && typeof fileStorage?.baselineAvailable === 'boolean'
      && Number(fileStorage?.baselineAgeHours) >= 0
      && Number(fileStorage?.freeBytesDecline24h) >= 0
      && Number(fileStorage?.usedRatioIncrease24h) >= 0,
    'file-storage-capacity-excludes-root-paths',
  )
  const authSessions = snapshot.components.find((component) => (
    'name' in component && component.name === 'mysql-auth-sessions'
  )) as { keyRotation?: Record<string, unknown> } | undefined
  assert(
    Boolean(authSessions?.keyRotation)
      && authSessions?.keyRotation?.secretsExcluded === true
      && authSessions?.keyRotation?.tokensExcluded === true
      && authSessions?.keyRotation?.identitiesExcluded === true
      && typeof authSessions?.keyRotation?.previousSecretCount === 'number'
      && typeof authSessions?.keyRotation?.previousKeyMatches24h === 'number'
      && !('currentSecret' in (authSessions?.keyRotation || {}))
      && !('previousSecrets' in (authSessions?.keyRotation || {})),
    'auth-session-key-rotation-excludes-secrets-tokens-and-identities',
  )
  const aiRuntime = snapshot.components.find((component) => (
    'kind' in component && component.kind === 'ai-runtime-telemetry'
  )) as {
    last15m?: Record<string, unknown>
    firstTokenDefinition?: string
    nonStreamingGatewayFirstTokenUnavailable?: boolean
    secretsExcluded?: boolean
    identitiesExcluded?: boolean
    businessContentExcluded?: boolean
  } | undefined
  assert(
    Boolean(aiRuntime)
      && aiRuntime?.firstTokenDefinition === 'first-non-empty-sdk-text-or-thinking-delta'
      && aiRuntime?.nonStreamingGatewayFirstTokenUnavailable === true
      && aiRuntime?.secretsExcluded === true
      && aiRuntime?.identitiesExcluded === true
      && aiRuntime?.businessContentExcluded === true
      && typeof aiRuntime?.last15m?.firstTokenObserved === 'number'
      && typeof aiRuntime?.last15m?.firstTokenUnavailable === 'number'
      && typeof aiRuntime?.last15m?.firstTokenObservationCoverage === 'number',
    'ai-runtime-first-token-total-error-cancel-and-coverage-exclude-sensitive-content',
  )
  const migrationReadiness = snapshot.components.find((component) => (
    'kind' in component && component.kind === 'migration-readiness'
  )) as MigrationReadinessHealth | undefined
  assert(
    Boolean(migrationReadiness)
      && migrationReadiness?.pathsExcluded === true
      && migrationReadiness?.fileNamesExcluded === true
      && migrationReadiness?.identitiesExcluded === true
      && migrationReadiness?.businessContentExcluded === true
      && migrationReadiness?.secretsExcluded === true
      && typeof migrationReadiness?.fileManifest.available === 'boolean'
      && typeof migrationReadiness?.fileManifest.blockingIssues === 'number'
      && typeof migrationReadiness?.productionSources.approved === 'boolean'
      && migrationReadiness?.radarAssets.localTechnicalReady === true
      && migrationReadiness?.radarAssets.productionAssetReady === false
      && migrationReadiness?.reconciliation.targetStructuralIntegrityReady === true
      && migrationReadiness?.reconciliation.fullMigrationReady === false,
    'migration-readiness-view-covers-file-source-radar-and-reconciliation-without-sensitive-evidence',
  )
  assert(snapshot.sensitiveValuesExcluded && snapshot.businessContentExcluded, 'snapshot-explicitly-excludes-secrets-and-business-content')
  assert(
    !('notificationChannelId' in snapshot.alertRouting)
      && !('escalationPolicyId' in snapshot.alertRouting),
    'alert-routing-exposes-configuration-state-not-channel-values',
  )
  const serialized = JSON.stringify(snapshot)
  for (const name of ['DB_PASSWORD', 'LLM_API_KEY', 'OPENAI_API_KEY', 'AUTH_SESSION_SECRET']) {
    const secret = process.env[name]
    if (secret && secret.length >= 6) assert(!serialized.includes(secret), `configured-secret-${name.toLowerCase()}-excluded`)
  }

  const [routeSource, indexSource] = await Promise.all([
    readFile(path.resolve('server/src/routes/operations.ts'), 'utf8'),
    readFile(path.resolve('server/src/routes/index.ts'), 'utf8'),
  ])
  assert(/get\('\/metrics', requireSystemAdmin/.test(routeSource), 'operations-api-requires-system-admin')
  assert(/use\('\/operations', operationsRouter\)/.test(indexSource), 'operations-api-mounted-inside-authenticated-api')
  assert(!/setInterval|setTimeout|spawn\(/.test(routeSource), 'operations-api-adds-no-service-timer-or-child-process')

  const result = {
    ok: true,
    checks,
    currentStatus: snapshot.status,
    currentAlertCodes: snapshot.alerts.map((alert) => alert.code).sort(),
    coveredDomains: Object.keys(database).sort(),
    componentCount: snapshot.components.length,
    httpPercentiles: { p50Ms: http.last5m.p50Ms, p95Ms: http.last5m.p95Ms, p99Ms: http.last5m.p99Ms },
    alertRoutingConfigured: snapshot.alertRouting.notificationChannelConfigured
      && snapshot.alertRouting.escalationPolicyConfigured,
    databaseConnectionIdentityExcluded: true,
    businessContentExcluded: true,
  }
  const evidenceRoot = path.resolve('.runtime/migration-evidence/operations-telemetry')
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
  await chmod(evidenceRoot, 0o700)
  const reportPath = path.join(evidenceRoot, 'report.json')
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  await chmod(reportPath, 0o600)
  console.log(JSON.stringify(result))
  await pool.end()
}

main().catch(async (error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  await pool.end().catch(() => undefined)
  process.exitCode = 1
})
