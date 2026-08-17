import { monitorEventLoopDelay } from 'node:perf_hooks'
import { loadavg } from 'node:os'
import { httpTelemetrySnapshot } from '../runtime/httpTelemetry.js'
import { agentSocketHealth } from '../runtime/agentSocketService.js'
import { jwAgentRuntimeHealth } from '../runtime/jwAgentRuntime.js'
import { supervisedProcessHealth } from '../runtime/supervisedProcessService.js'
import { aiTaskWorkerHealth } from './aiTaskService.js'
import { leadScoreJobHealth } from './leadScoreJobService.js'
import { leadBpWorkerHealth } from './leadIntakeService.js'
import { operationalTelemetryRepository } from '../repositories/mysql/mysqlOperationalTelemetryRepository.js'
import { projectScoreJobHealth } from './projectScoreJobService.js'
import { radarMySqlSourceHealth } from './radarDataMigrationService.js'
import { runtimeJobSchedulerHealth } from './runtimeJobScheduler.js'
import { sessionAuthHealth } from './sessionAuthService.js'
import type { OperationalDatabaseMetrics } from '../repositories/operationalTelemetryRepository.js'
import { operationalAlertPolicy } from '../config/operationalAlertPolicy.js'
import { documentNativeRuntimeHealth } from './documentNativeRuntimeTelemetryService.js'
import { fileStorageCapacityHealth } from './fileStorageCapacityTelemetryService.js'
import { aiRuntimeTelemetrySnapshot } from '../runtime/aiRuntimeTelemetry.js'
import { migrationReadinessHealth } from './migrationReadinessTelemetryService.js'

const eventLoop = monitorEventLoopDelay({ resolution: 20 })
eventLoop.enable()

type AlertSeverity = 'warning' | 'critical'
export type OperationalAlert = {
  code: string
  severity: AlertSeverity
  metric: string
  value: number
  threshold: number
}

function threshold(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be ${minimum}..${maximum}`)
  }
  return value
}

const thresholds = {
  httpMinimumRequests: threshold('OPS_HTTP_MIN_REQUESTS', 20, 1, 1_000_000),
  httpServerErrorRate: threshold('OPS_HTTP_SERVER_ERROR_RATE_WARN', 0.05, 0, 1),
  httpP95Ms: threshold('OPS_HTTP_P95_MS_WARN', 2_000, 1, 3_600_000),
  mysqlWaitingRequests: threshold('OPS_MYSQL_WAITING_REQUESTS_WARN', 1, 0, 1_000_000),
  mysqlCurrentRowLockWaits: threshold('OPS_MYSQL_ROW_LOCK_CURRENT_WAITS_WARN', 1, 0, 1_000_000),
  mysqlReplicationLagSeconds: threshold('OPS_MYSQL_REPLICATION_LAG_SECONDS_WARN', 300, 0, 86_400),
  queueDeadLetters: threshold('OPS_QUEUE_DEAD_LETTERS_WARN', 1, 0, 1_000_000),
  fileParseFailures: threshold('OPS_FILE_PARSE_FAILURES_WARN', 1, 0, 1_000_000),
  authenticationDenied15m: threshold('OPS_AUTH_DENIED_15M_WARN', 5, 0, 1_000_000),
  authPreviousKeyMatches24h: threshold('OPS_AUTH_PREVIOUS_KEY_MATCHES_24H_WARN', 1, 1, 1_000_000),
  credentialChanges15m: threshold('OPS_CREDENTIAL_CHANGES_15M_WARN', 1, 0, 1_000_000),
  highRiskToolDenied15m: threshold('OPS_HIGH_RISK_TOOL_DENIED_15M_WARN', 1, 0, 1_000_000),
  cdcLagMs: threshold('OPS_CDC_LAG_MS_WARN', 300_000, 0, 86_400_000),
  sourceMissing: threshold('OPS_LEAD_SOURCE_MISSING_WARN', 1, 0, 1_000_000),
  leadReviewPending: threshold('OPS_LEAD_REVIEW_PENDING_WARN', 20, 1, 1_000_000),
  leadReviewOldestAgeMs: threshold('OPS_LEAD_REVIEW_OLDEST_AGE_MS_WARN', 86_400_000, 60_000, 2_592_000_000),
  leadEntityDuplicateGroups: threshold('OPS_LEAD_ENTITY_DUPLICATE_GROUPS_WARN', 1, 1, 1_000_000),
  documentRenderFailures: threshold('OPS_DOCUMENT_RENDER_FAILURES_WARN', 1, 0, 1_000_000),
  documentQualityFailures: threshold('OPS_DOCUMENT_QUALITY_FAILURES_WARN', 1, 0, 1_000_000),
  documentFontFailures: threshold('OPS_DOCUMENT_FONT_FAILURES_WARN', 1, 0, 1_000_000),
  jobFailures24h: threshold('OPS_JOB_FAILURES_24H_WARN', 1, 0, 1_000_000),
  jobDeadLetters24h: threshold('OPS_JOB_DEAD_LETTERS_24H_WARN', 1, 0, 1_000_000),
  jobRetriedRecords24h: threshold('OPS_JOB_RETRIED_RECORDS_24H_WARN', 5, 0, 1_000_000),
  jobTimeoutFailures24h: threshold('OPS_JOB_TIMEOUT_FAILURES_24H_WARN', 1, 0, 1_000_000),
  jobLeaseRecoveries24h: threshold('OPS_JOB_LEASE_RECOVERIES_24H_WARN', 1, 0, 1_000_000),
  jobExpiredLeases: threshold('OPS_JOB_EXPIRED_LEASES_WARN', 1, 0, 1_000_000),
  jobLeaseContentions24h: threshold('OPS_JOB_LEASE_CONTENTIONS_24H_WARN', 10, 0, 1_000_000),
  jobDuplicateSuppressed24h: threshold('OPS_JOB_DUPLICATE_SUPPRESSED_24H_WARN', 20, 0, 1_000_000),
  jobStaleCompletionRejected24h: threshold('OPS_JOB_STALE_COMPLETIONS_24H_WARN', 1, 0, 1_000_000),
  supervisedProcessFailures24h: threshold('OPS_SUPERVISED_PROCESS_FAILURES_24H_WARN', 1, 0, 1_000_000),
  supervisedProcessTimeouts24h: threshold('OPS_SUPERVISED_PROCESS_TIMEOUTS_24H_WARN', 1, 0, 1_000_000),
  supervisedProcessForceKills24h: threshold('OPS_SUPERVISED_PROCESS_FORCE_KILLS_24H_WARN', 1, 0, 1_000_000),
  fileDiskFreeBytes: threshold('OPS_FILE_DISK_FREE_BYTES_WARN', 5 * 1024 ** 3, 0, Number.MAX_SAFE_INTEGER),
  fileDiskUsedRatio: threshold('OPS_FILE_DISK_USED_RATIO_WARN', 0.9, 0, 1),
  fileDiskUsedRatioGrowth24h: threshold('OPS_FILE_DISK_USED_RATIO_GROWTH_24H_WARN', 0.05, 0, 1),
  aiFirstTokenMinimumRequests: threshold('OPS_AI_FIRST_TOKEN_MIN_REQUESTS', 5, 1, 1_000_000),
  aiFirstTokenP95Ms: threshold('OPS_AI_FIRST_TOKEN_P95_MS_WARN', 5_000, 1, 3_600_000),
  aiFirstTokenObservationCoverage: threshold('OPS_AI_FIRST_TOKEN_OBSERVATION_COVERAGE_WARN', 0.8, 0, 1),
}

type ComponentSummary = Record<string, unknown>

export function evaluateAiRuntimeTelemetryAlerts(component: ComponentSummary | undefined): OperationalAlert[] {
  if (!component) return []
  const last15m = component.last15m as Record<string, unknown> | undefined
  const requests = Number(last15m?.requests || 0)
  const observed = Number(last15m?.firstTokenObserved || 0)
  const coverage = Number(last15m?.firstTokenObservationCoverage ?? 1)
  const firstTokenLatency = last15m?.firstTokenLatency as Record<string, unknown> | undefined
  const p95Ms = Number(firstTokenLatency?.p95Ms || 0)
  const alerts: OperationalAlert[] = []
  if (observed >= thresholds.aiFirstTokenMinimumRequests && p95Ms >= thresholds.aiFirstTokenP95Ms) {
    alerts.push({
      code: 'AI_FIRST_TOKEN_P95_LATENCY', severity: 'warning',
      metric: 'components.aiRuntime.last15m.firstTokenLatency.p95Ms',
      value: p95Ms, threshold: thresholds.aiFirstTokenP95Ms,
    })
  }
  if (requests >= thresholds.aiFirstTokenMinimumRequests
    && coverage < thresholds.aiFirstTokenObservationCoverage) {
    alerts.push({
      code: 'AI_FIRST_TOKEN_OBSERVATION_INCOMPLETE', severity: 'warning',
      metric: 'components.aiRuntime.last15m.firstTokenObservationCoverage',
      value: coverage, threshold: thresholds.aiFirstTokenObservationCoverage,
    })
  }
  return alerts
}

export function evaluateOperationalAlerts(input: {
  http: ReturnType<typeof httpTelemetrySnapshot>
  database: OperationalDatabaseMetrics
  components: ComponentSummary[]
}): OperationalAlert[] {
  const alerts: OperationalAlert[] = []
  const add = (condition: boolean, alert: OperationalAlert) => { if (condition) alerts.push(alert) }
  const httpReady = input.http.last5m.requests >= thresholds.httpMinimumRequests
  alerts.push(...evaluateAiRuntimeTelemetryAlerts(
    input.components.find((component) => component.kind === 'ai-runtime-telemetry'),
  ))
  add(httpReady && input.http.last5m.serverErrorRate >= thresholds.httpServerErrorRate, {
    code: 'HTTP_SERVER_ERROR_RATE', severity: 'critical', metric: 'http.last5m.serverErrorRate',
    value: input.http.last5m.serverErrorRate, threshold: thresholds.httpServerErrorRate,
  })
  add(httpReady && input.http.last5m.p95Ms >= thresholds.httpP95Ms, {
    code: 'HTTP_P95_LATENCY', severity: 'warning', metric: 'http.last5m.p95Ms',
    value: input.http.last5m.p95Ms, threshold: thresholds.httpP95Ms,
  })
  add(input.database.mysqlPool.waitingRequests >= thresholds.mysqlWaitingRequests, {
    code: 'MYSQL_POOL_WAITING', severity: 'critical', metric: 'database.mysqlPool.waitingRequests',
    value: input.database.mysqlPool.waitingRequests, threshold: thresholds.mysqlWaitingRequests,
  })
  add(!input.database.mysqlServer.statusObservationAvailable, {
    code: 'MYSQL_STATUS_OBSERVATION_UNAVAILABLE', severity: 'critical',
    metric: 'database.mysqlServer.statusObservationAvailable', value: 1, threshold: 1,
  })
  add(input.database.mysqlServer.statusObservationAvailable
    && input.database.mysqlServer.currentRowLockWaits >= thresholds.mysqlCurrentRowLockWaits, {
    code: 'MYSQL_ROW_LOCK_WAITING', severity: 'critical', metric: 'database.mysqlServer.currentRowLockWaits',
    value: input.database.mysqlServer.currentRowLockWaits, threshold: thresholds.mysqlCurrentRowLockWaits,
  })
  add(!input.database.mysqlServer.deadlockObservationAvailable, {
    code: 'MYSQL_DEADLOCK_OBSERVATION_UNAVAILABLE', severity: 'warning',
    metric: 'database.mysqlServer.deadlockObservationAvailable', value: 1, threshold: 1,
  })
  add(!input.database.mysqlServer.replicationObservationAvailable, {
    code: 'MYSQL_REPLICATION_OBSERVATION_UNAVAILABLE', severity: 'warning',
    metric: 'database.mysqlServer.replicationObservationAvailable', value: 1, threshold: 1,
  })
  const stoppedReplicaThreads = input.database.mysqlServer.replicaConfigured
    ? Number(!input.database.mysqlServer.replicaIoRunning) + Number(!input.database.mysqlServer.replicaSqlRunning)
    : 0
  add(input.database.mysqlServer.replicationObservationAvailable && stoppedReplicaThreads > 0, {
    code: 'MYSQL_REPLICA_NOT_RUNNING', severity: 'critical', metric: 'database.mysqlServer.stoppedReplicaThreads',
    value: stoppedReplicaThreads, threshold: 1,
  })
  add(input.database.mysqlServer.replicationObservationAvailable
    && input.database.mysqlServer.replicaConfigured
    && input.database.mysqlServer.replicationLagSeconds >= thresholds.mysqlReplicationLagSeconds, {
    code: 'MYSQL_REPLICATION_LAG', severity: 'critical', metric: 'database.mysqlServer.replicationLagSeconds',
    value: input.database.mysqlServer.replicationLagSeconds, threshold: thresholds.mysqlReplicationLagSeconds,
  })
  const componentDeadLetters = input.components.reduce((sum, component) => sum + Number(component.deadLetter || 0), 0)
  const deadLetters = componentDeadLetters + input.database.im.deadLetter
  add(deadLetters >= thresholds.queueDeadLetters, {
    code: 'QUEUE_DEAD_LETTER', severity: 'critical', metric: 'queues.deadLetter',
    value: deadLetters, threshold: thresholds.queueDeadLetters,
  })
  add(input.database.files.parseFailed >= thresholds.fileParseFailures, {
    code: 'FILE_PARSE_FAILURE', severity: 'warning', metric: 'database.files.parseFailed',
    value: input.database.files.parseFailed, threshold: thresholds.fileParseFailures,
  })
  add(input.database.security.authenticationDenied15m >= thresholds.authenticationDenied15m, {
    code: 'AUTH_DENIED_SPIKE', severity: 'warning', metric: 'database.security.authenticationDenied15m',
    value: input.database.security.authenticationDenied15m, threshold: thresholds.authenticationDenied15m,
  })
  const authSessions = input.components.find((component) => component.name === 'mysql-auth-sessions')
  const keyRotation = authSessions?.keyRotation as Record<string, unknown> | undefined
  const previousSecretCount = Number(keyRotation?.previousSecretCount || 0)
  const previousKeyMatches24h = Number(keyRotation?.previousKeyMatches24h || 0)
  add(Boolean(keyRotation) && keyRotation?.currentSecretConfigured !== true, {
    code: 'AUTH_SESSION_CURRENT_KEY_UNCONFIGURED', severity: 'critical',
    metric: 'components.authSessions.keyRotation.currentSecretConfigured', value: 1, threshold: 1,
  })
  add(previousSecretCount > 0 && keyRotation?.rotationStartedAtConfigured !== true, {
    code: 'AUTH_SESSION_KEY_ROTATION_UNTRACKED', severity: 'warning',
    metric: 'components.authSessions.keyRotation.rotationStartedAtConfigured', value: 1, threshold: 1,
  })
  add(previousKeyMatches24h >= thresholds.authPreviousKeyMatches24h, {
    code: 'AUTH_SESSION_LEGACY_KEY_ACTIVITY', severity: 'warning',
    metric: 'components.authSessions.keyRotation.previousKeyMatches24h',
    value: previousKeyMatches24h, threshold: thresholds.authPreviousKeyMatches24h,
  })
  add(keyRotation?.rotationWindowOverdue === true, {
    code: 'AUTH_SESSION_PREVIOUS_KEYS_OVERDUE', severity: 'warning',
    metric: 'components.authSessions.keyRotation.rotationWindowOverdue', value: 1, threshold: 1,
  })
  add(input.database.security.credentialChanges15m >= thresholds.credentialChanges15m, {
    code: 'SECURITY_CREDENTIAL_CHANGED', severity: 'warning', metric: 'database.security.credentialChanges15m',
    value: input.database.security.credentialChanges15m, threshold: thresholds.credentialChanges15m,
  })
  add(input.database.security.highRiskToolDenied15m >= thresholds.highRiskToolDenied15m, {
    code: 'SECURITY_HIGH_RISK_TOOL_DENIED', severity: 'critical', metric: 'database.security.highRiskToolDenied15m',
    value: input.database.security.highRiskToolDenied15m, threshold: thresholds.highRiskToolDenied15m,
  })
  add(input.database.cdc.sources > 0 && input.database.cdc.maxReplicationLagMs >= thresholds.cdcLagMs, {
    code: 'CDC_REPLICATION_LAG', severity: 'critical', metric: 'database.cdc.maxReplicationLagMs',
    value: input.database.cdc.maxReplicationLagMs, threshold: thresholds.cdcLagMs,
  })
  add(input.database.cdc.unhealthySources > 0, {
    code: 'CDC_SOURCE_UNHEALTHY', severity: 'critical', metric: 'database.cdc.unhealthySources',
    value: input.database.cdc.unhealthySources, threshold: 1,
  })
  add(input.database.leadAgents.missingTokenRuns24h > 0, {
    code: 'AI_TOKEN_USAGE_INCOMPLETE', severity: 'warning', metric: 'database.leadAgents.missingTokenRuns24h',
    value: input.database.leadAgents.missingTokenRuns24h, threshold: 1,
  })
  add(input.database.leadAgents.pendingReviews >= thresholds.leadReviewPending, {
    code: 'LEAD_REVIEW_BACKLOG', severity: 'warning', metric: 'database.leadAgents.pendingReviews',
    value: input.database.leadAgents.pendingReviews, threshold: thresholds.leadReviewPending,
  })
  add(input.database.leadAgents.oldestPendingReviewAgeMs >= thresholds.leadReviewOldestAgeMs, {
    code: 'LEAD_REVIEW_STALE', severity: 'warning', metric: 'database.leadAgents.oldestPendingReviewAgeMs',
    value: input.database.leadAgents.oldestPendingReviewAgeMs, threshold: thresholds.leadReviewOldestAgeMs,
  })
  add(input.database.leadAgents.duplicateEntityGroups >= thresholds.leadEntityDuplicateGroups, {
    code: 'LEAD_ENTITY_DUPLICATE_GROUPS', severity: 'warning', metric: 'database.leadAgents.duplicateEntityGroups',
    value: input.database.leadAgents.duplicateEntityGroups, threshold: thresholds.leadEntityDuplicateGroups,
  })
  add(input.database.leadReserve.sourceMissing >= thresholds.sourceMissing, {
    code: 'LEAD_SOURCE_MISSING', severity: 'warning', metric: 'database.leadReserve.sourceMissing',
    value: input.database.leadReserve.sourceMissing, threshold: thresholds.sourceMissing,
  })
  const missingDocumentDependencies = input.components.reduce((maximum, component) => (
    component.kind === 'document-native-runtime'
      ? Math.max(maximum, Number(component.missingRequired || 0))
      : maximum
  ), 0)
  add(missingDocumentDependencies > 0, {
    code: 'DOCUMENT_NATIVE_RUNTIME_MISSING', severity: 'critical', metric: 'components.documentNativeRuntime.missingRequired',
    value: missingDocumentDependencies, threshold: 1,
  })
  add(input.database.documents.renderFailures24h >= thresholds.documentRenderFailures, {
    code: 'DOCUMENT_RENDER_FAILURE', severity: 'critical', metric: 'database.documents.renderFailures24h',
    value: input.database.documents.renderFailures24h, threshold: thresholds.documentRenderFailures,
  })
  add(input.database.documents.qualityFailed24h >= thresholds.documentQualityFailures, {
    code: 'DOCUMENT_ARTIFACT_QUALITY_FAILURE', severity: 'warning', metric: 'database.documents.qualityFailed24h',
    value: input.database.documents.qualityFailed24h, threshold: thresholds.documentQualityFailures,
  })
  add(input.database.documents.fontFailures24h >= thresholds.documentFontFailures, {
    code: 'DOCUMENT_FONT_FAILURE', severity: 'warning', metric: 'database.documents.fontFailures24h',
    value: input.database.documents.fontFailures24h, threshold: thresholds.documentFontFailures,
  })
  add(input.database.jobHistory.failed24h >= thresholds.jobFailures24h, {
    code: 'JOB_FAILURE_24H', severity: 'warning', metric: 'database.jobHistory.failed24h',
    value: input.database.jobHistory.failed24h, threshold: thresholds.jobFailures24h,
  })
  add(input.database.jobHistory.deadLetter24h >= thresholds.jobDeadLetters24h, {
    code: 'JOB_DEAD_LETTER_24H', severity: 'critical', metric: 'database.jobHistory.deadLetter24h',
    value: input.database.jobHistory.deadLetter24h, threshold: thresholds.jobDeadLetters24h,
  })
  add(input.database.jobHistory.retriedRecords24h >= thresholds.jobRetriedRecords24h, {
    code: 'JOB_RETRY_ACTIVITY_24H', severity: 'warning', metric: 'database.jobHistory.retriedRecords24h',
    value: input.database.jobHistory.retriedRecords24h, threshold: thresholds.jobRetriedRecords24h,
  })
  add(input.database.jobHistory.timeoutFailures24h >= thresholds.jobTimeoutFailures24h, {
    code: 'JOB_TIMEOUT_FAILURE_24H', severity: 'critical', metric: 'database.jobHistory.timeoutFailures24h',
    value: input.database.jobHistory.timeoutFailures24h, threshold: thresholds.jobTimeoutFailures24h,
  })
  add(input.database.jobHistory.leaseRecoveries24h >= thresholds.jobLeaseRecoveries24h, {
    code: 'JOB_LEASE_RECOVERY_24H', severity: 'warning', metric: 'database.jobHistory.leaseRecoveries24h',
    value: input.database.jobHistory.leaseRecoveries24h, threshold: thresholds.jobLeaseRecoveries24h,
  })
  add(input.database.jobHistory.expiredLeases >= thresholds.jobExpiredLeases, {
    code: 'JOB_EXPIRED_LEASE', severity: 'critical', metric: 'database.jobHistory.expiredLeases',
    value: input.database.jobHistory.expiredLeases, threshold: thresholds.jobExpiredLeases,
  })
  add(input.database.jobHistory.leaseContentions24h >= thresholds.jobLeaseContentions24h, {
    code: 'JOB_LEASE_CONTENTION_24H', severity: 'warning', metric: 'database.jobHistory.leaseContentions24h',
    value: input.database.jobHistory.leaseContentions24h, threshold: thresholds.jobLeaseContentions24h,
  })
  add(input.database.jobHistory.duplicateSuppressed24h >= thresholds.jobDuplicateSuppressed24h, {
    code: 'JOB_DUPLICATE_SUPPRESSED_24H', severity: 'warning', metric: 'database.jobHistory.duplicateSuppressed24h',
    value: input.database.jobHistory.duplicateSuppressed24h, threshold: thresholds.jobDuplicateSuppressed24h,
  })
  add(input.database.jobHistory.staleCompletionRejected24h >= thresholds.jobStaleCompletionRejected24h, {
    code: 'JOB_STALE_COMPLETION_REJECTED_24H', severity: 'critical', metric: 'database.jobHistory.staleCompletionRejected24h',
    value: input.database.jobHistory.staleCompletionRejected24h, threshold: thresholds.jobStaleCompletionRejected24h,
  })
  add(input.database.processHistory.failed24h >= thresholds.supervisedProcessFailures24h, {
    code: 'SUPERVISED_PROCESS_FAILURE_24H', severity: 'warning', metric: 'database.processHistory.failed24h',
    value: input.database.processHistory.failed24h, threshold: thresholds.supervisedProcessFailures24h,
  })
  add(input.database.processHistory.timeout24h >= thresholds.supervisedProcessTimeouts24h, {
    code: 'SUPERVISED_PROCESS_TIMEOUT_24H', severity: 'warning', metric: 'database.processHistory.timeout24h',
    value: input.database.processHistory.timeout24h, threshold: thresholds.supervisedProcessTimeouts24h,
  })
  add(input.database.processHistory.forceKilled24h >= thresholds.supervisedProcessForceKills24h, {
    code: 'SUPERVISED_PROCESS_FORCE_KILL_24H', severity: 'critical', metric: 'database.processHistory.forceKilled24h',
    value: input.database.processHistory.forceKilled24h, threshold: thresholds.supervisedProcessForceKills24h,
  })
  const storageCapacity = input.components.find((component) => component.kind === 'file-storage-capacity')
  const missingStorageRoots = Number(storageCapacity?.missingRequired || 0)
  const minimumFreeBytes = Number(storageCapacity?.minimumFreeBytes || 0)
  const maximumUsedRatio = Number(storageCapacity?.maximumUsedRatio || 0)
  const historyObservationAvailable = storageCapacity?.historyObservationAvailable === true
  const capacityBaselineAvailable = storageCapacity?.baselineAvailable === true
  const usedRatioIncrease24h = Number(storageCapacity?.usedRatioIncrease24h || 0)
  add(missingStorageRoots > 0, {
    code: 'FILE_STORAGE_ROOT_UNAVAILABLE', severity: 'critical', metric: 'components.fileStorageCapacity.missingRequired',
    value: missingStorageRoots, threshold: 1,
  })
  add(Boolean(storageCapacity) && missingStorageRoots === 0 && minimumFreeBytes <= thresholds.fileDiskFreeBytes, {
    code: 'FILE_STORAGE_FREE_BYTES_LOW', severity: 'critical', metric: 'components.fileStorageCapacity.minimumFreeBytes',
    value: minimumFreeBytes, threshold: thresholds.fileDiskFreeBytes,
  })
  add(Boolean(storageCapacity) && missingStorageRoots === 0 && maximumUsedRatio >= thresholds.fileDiskUsedRatio, {
    code: 'FILE_STORAGE_USED_RATIO_HIGH', severity: 'warning', metric: 'components.fileStorageCapacity.maximumUsedRatio',
    value: maximumUsedRatio, threshold: thresholds.fileDiskUsedRatio,
  })
  add(Boolean(storageCapacity) && !historyObservationAvailable, {
    code: 'FILE_STORAGE_HISTORY_UNAVAILABLE', severity: 'critical',
    metric: 'components.fileStorageCapacity.historyObservationAvailable', value: 1, threshold: 1,
  })
  add(Boolean(storageCapacity) && historyObservationAvailable && !capacityBaselineAvailable, {
    code: 'FILE_STORAGE_GROWTH_BASELINE_UNAVAILABLE', severity: 'warning',
    metric: 'components.fileStorageCapacity.baselineAvailable', value: 1, threshold: 1,
  })
  add(Boolean(storageCapacity) && capacityBaselineAvailable
    && usedRatioIncrease24h >= thresholds.fileDiskUsedRatioGrowth24h, {
    code: 'FILE_STORAGE_USED_RATIO_GROWTH_24H', severity: 'warning',
    metric: 'components.fileStorageCapacity.usedRatioIncrease24h',
    value: usedRatioIncrease24h, threshold: thresholds.fileDiskUsedRatioGrowth24h,
  })
  return alerts
}

function processSnapshot() {
  const memory = process.memoryUsage()
  const cpu = process.cpuUsage()
  return {
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    memoryBytes: {
      rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal,
      external: memory.external, arrayBuffers: memory.arrayBuffers,
    },
    cpuMicroseconds: { user: cpu.user, system: cpu.system },
    loadAverage: loadavg(),
    eventLoopDelayMs: {
      mean: Number((eventLoop.mean / 1_000_000).toFixed(3)),
      p95: Number((eventLoop.percentile(95) / 1_000_000).toFixed(3)),
      p99: Number((eventLoop.percentile(99) / 1_000_000).toFixed(3)),
      max: Number((eventLoop.max / 1_000_000).toFixed(3)),
    },
  }
}

export async function operationalTelemetrySnapshot() {
  const [database, ...components] = await Promise.all([
    operationalTelemetryRepository.snapshot(),
    Promise.resolve(jwAgentRuntimeHealth()),
    Promise.resolve(agentSocketHealth()),
    Promise.resolve(aiRuntimeTelemetrySnapshot()),
    runtimeJobSchedulerHealth(),
    leadScoreJobHealth(),
    leadBpWorkerHealth(),
    projectScoreJobHealth(),
    aiTaskWorkerHealth(),
    Promise.resolve(supervisedProcessHealth()),
    sessionAuthHealth(),
    radarMySqlSourceHealth(),
    documentNativeRuntimeHealth(),
    fileStorageCapacityHealth(),
    migrationReadinessHealth(),
  ])
  const http = httpTelemetrySnapshot()
  const alerts = evaluateOperationalAlerts({ http, database, components })
  const policy = operationalAlertPolicy()
  const alertRouting = {
    ownerRole: policy.ownerRole,
    notificationChannelConfigured: policy.notificationChannelConfigured,
    escalationPolicyConfigured: policy.escalationPolicyConfigured,
    inProcessOutboxDeliveryConfigured: policy.inProcessOutboxDeliveryConfigured,
  }
  return {
    ok: components.every((component) => component.ok !== false),
    status: alerts.some((alert) => alert.severity === 'critical') ? 'critical' : alerts.length ? 'warning' : 'ok',
    service: 'cybernaut-app',
    timestamp: new Date().toISOString(),
    http,
    process: processSnapshot(),
    database,
    components,
    alerts,
    thresholds,
    alertRouting,
    sensitiveValuesExcluded: true,
    businessContentExcluded: true,
  }
}
