export type OperationalDatabaseMetrics = {
  mysqlPool: {
    configuredLimit: number
    totalConnections: number
    freeConnections: number
    waitingRequests: number
  }
  mysqlServer: {
    statusObservationAvailable: boolean
    threadsConnected: number
    threadsRunning: number
    maxUsedConnections: number
    slowQueriesTotal: number
    currentRowLockWaits: number
    rowLockWaitsTotal: number
    rowLockTimeMsTotal: number
    deadlocksTotal: number
    deadlockObservationAvailable: boolean
    replicationObservationAvailable: boolean
    replicaConfigured: boolean
    replicaIoRunning: boolean
    replicaSqlRunning: boolean
    replicationLagSeconds: number
  }
  im: {
    queued: number
    sending: number
    failed: number
    deadLetter: number
    deliveries15m: number
    deliveryFailures15m: number
    averageDeliveryMs15m: number
  }
  files: {
    total: number
    totalBytes: number
    parsing: number
    parseFailed: number
    missingContentIdentity: number
    downloads15m: number
    previews15m: number
  }
  security: {
    auditEvents15m: number
    deniedEvents15m: number
    authenticationDenied15m: number
    credentialChanges15m: number
    highRiskToolDenied15m: number
  }
  leadAgents: {
    runs24h: number
    failed24h: number
    inputTokens24h: number
    outputTokens24h: number
    missingTokenRuns24h: number
    toolCalls24h: number
    averageDurationMs24h: number
    costMicrousd24h: number
    pendingReviews: number
    openedReviews24h: number
    resolvedReviews24h: number
    averageReviewResolutionMs24h: number
    oldestPendingReviewAgeMs: number
    duplicateNameGroups: number
    duplicateNameRecords: number
    duplicateCompanyGroups: number
    duplicateCompanyRecords: number
    duplicateEntityGroups: number
  }
  documents: {
    tasks24h: number
    failedTasks24h: number
    nativeDependencyFailures24h: number
    renderFailures24h: number
    fontFailures24h: number
    artifacts24h: number
    qualityFailed24h: number
    qualityUnchecked24h: number
  }
  jobHistory: {
    lifecycleRecords24h: number
    failed24h: number
    deadLetter24h: number
    cancelled24h: number
    retriedRecords24h: number
    timeoutFailures24h: number
    leaseRecoveries24h: number
    expiredLeases: number
    leaseContentions24h: number
    duplicateSuppressed24h: number
    staleCompletionRejected24h: number
    leaseRecoveryEvents24h: number
  }
  processHistory: {
    exits24h: number
    succeeded24h: number
    failed24h: number
    nonZeroExit24h: number
    timeout24h: number
    aborted24h: number
    shutdown24h: number
    maxBuffer24h: number
    forceKilled24h: number
    averageDurationMs24h: number
  }
  cdc: {
    sources: number
    unhealthySources: number
    maxReplicationLagMs: number
    watermarkGap: number
    deleteEvents: number
    cascadeDeleteEvents: number
  }
  leadReserve: {
    total: number
    imported: number
    importedTimestampMissing: number
    sourceMissing: number
    awaitingProcessing: number
    maxSequence: number
    rawEventMissing: number
  }
  radar: {
    rawEvents: number
    candidates: number
    collectorStates: number
    sourceRegistry: number
    syncStates: number
    incompleteBackfills: number
    latestCursorTimestamp: number
    runtimeJobs: number
    failedRuntimeJobs: number
  }
}

export interface OperationalTelemetryRepository {
  snapshot(): Promise<OperationalDatabaseMetrics>
}
