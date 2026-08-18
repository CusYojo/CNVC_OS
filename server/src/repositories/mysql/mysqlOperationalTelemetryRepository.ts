import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../../db/client.js'
import { mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../../db/config.js'
import type {
  OperationalDatabaseMetrics,
  OperationalTelemetryRepository,
} from '../operationalTelemetryRepository.js'

type MetricRow = RowDataPacket & Record<string, number | string | null>
type StatusRow = RowDataPacket & { Variable_name: string; Value: string | number }
type ReplicaStatusRow = RowDataPacket & {
  Replica_IO_Running?: string
  Replica_SQL_Running?: string
  Seconds_Behind_Source?: number | string | null
}

function table(name: string) {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

function number(row: MetricRow | undefined, key: string) {
  const value = Number(row?.[key] || 0)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function poolSnapshot() {
  const internal = pool.pool as unknown as {
    _allConnections?: { length: number }
    _freeConnections?: { length: number }
    _connectionQueue?: { length: number }
  }
  return {
    configuredLimit: mysqlConfig.connectionLimit,
    totalConnections: Number(internal._allConnections?.length || 0),
    freeConnections: Number(internal._freeConnections?.length || 0),
    waitingRequests: Number(internal._connectionQueue?.length || 0),
  }
}

async function mysqlServerSnapshot(): Promise<OperationalDatabaseMetrics['mysqlServer']> {
  const metrics: OperationalDatabaseMetrics['mysqlServer'] = {
    statusObservationAvailable: false,
    threadsConnected: 0,
    threadsRunning: 0,
    maxUsedConnections: 0,
    slowQueriesTotal: 0,
    currentRowLockWaits: 0,
    rowLockWaitsTotal: 0,
    rowLockTimeMsTotal: 0,
    deadlocksTotal: 0,
    deadlockObservationAvailable: false,
    replicationObservationAvailable: false,
    replicaConfigured: false,
    replicaIoRunning: false,
    replicaSqlRunning: false,
    replicationLagSeconds: 0,
  }
  try {
    const [rows] = await pool.query<StatusRow[]>(`SHOW GLOBAL STATUS WHERE Variable_name IN (
      'Threads_connected','Threads_running','Max_used_connections','Slow_queries',
      'Innodb_row_lock_current_waits','Innodb_row_lock_waits','Innodb_row_lock_time','Innodb_deadlocks'
    )`)
    const values = new Map(rows.map((row) => [String(row.Variable_name), Number(row.Value)]))
    const value = (name: string) => {
      const observed = values.get(name)
      return Number.isFinite(observed) && Number(observed) >= 0 ? Number(observed) : 0
    }
    metrics.statusObservationAvailable = [
      'Threads_connected', 'Threads_running', 'Max_used_connections', 'Slow_queries',
      'Innodb_row_lock_current_waits', 'Innodb_row_lock_waits', 'Innodb_row_lock_time',
    ].every((name) => values.has(name))
    metrics.threadsConnected = value('Threads_connected')
    metrics.threadsRunning = value('Threads_running')
    metrics.maxUsedConnections = value('Max_used_connections')
    metrics.slowQueriesTotal = value('Slow_queries')
    metrics.currentRowLockWaits = value('Innodb_row_lock_current_waits')
    metrics.rowLockWaitsTotal = value('Innodb_row_lock_waits')
    metrics.rowLockTimeMsTotal = value('Innodb_row_lock_time')
    metrics.deadlockObservationAvailable = values.has('Innodb_deadlocks')
    metrics.deadlocksTotal = value('Innodb_deadlocks')
  } catch {
    // Missing SHOW STATUS authority is reported as unavailable, never as a healthy zero.
  }
  try {
    const [rows] = await pool.query<ReplicaStatusRow[]>('SHOW REPLICA STATUS')
    metrics.replicationObservationAvailable = true
    const replica = rows[0]
    metrics.replicaConfigured = Boolean(replica)
    if (replica) {
      metrics.replicaIoRunning = replica.Replica_IO_Running === 'Yes'
      metrics.replicaSqlRunning = replica.Replica_SQL_Running === 'Yes'
      const lag = Number(replica.Seconds_Behind_Source)
      metrics.replicationLagSeconds = Number.isFinite(lag) && lag >= 0 ? lag : 0
    }
  } catch {
    // The DML-only Runtime account intentionally has no REPLICATION CLIENT privilege.
  }
  return metrics
}

export class MysqlOperationalTelemetryRepository implements OperationalTelemetryRepository {
  async snapshot(): Promise<OperationalDatabaseMetrics> {
    const [
      mysqlServer,
      imResult, deliveryResult, fileResult, securityResult, leadAgentResult, leadReviewResult,
      leadDuplicateResult,
      documentTaskResult, documentArtifactResult, runtimeJobResult, leadScoreJobResult,
      processHistoryResult, projectScoreJobResult, coordinationResult, aiTaskResult, cdcResult, reserveResult,
      radarResult,
    ] = await Promise.all([
      mysqlServerSnapshot(),
      pool.query<MetricRow[]>(
        `SELECT
           SUM(status IN ('pending','retrying')) AS queued,
           SUM(status='sending') AS sending,
           SUM(status='failed') AS failed,
           SUM(status='dead_letter') AS dead_letter
         FROM ${table('im_outbox')}`,
      ),
      pool.query<MetricRow[]>(
        `SELECT COUNT(*) AS deliveries,
           SUM(status='failed') AS failures,
           COALESCE(AVG(duration_ms),0) AS average_duration_ms
         FROM ${table('im_delivery_logs')} WHERE created_at >= NOW(3) - INTERVAL 15 MINUTE`,
      ),
      pool.query<MetricRow[]>(
        `SELECT COUNT(*) AS total,
           COALESCE(SUM(byte_size),0) AS total_bytes,
           SUM(parse_status IN ('解析中','pending','parsing')) AS parsing,
           SUM(parse_status IN ('失败','failed')) AS parse_failed,
           SUM(sha256 IS NULL OR byte_size <= 0 OR storage_path IS NULL) AS missing_content_identity
         FROM ${table('project_files')}`,
      ),
      pool.query<MetricRow[]>(
        `SELECT COUNT(*) AS audit_events,
           SUM(result <> 'success') AS denied_events,
           SUM(result <> 'success' AND (module LIKE '%认证%' OR action LIKE '%登录%' OR action LIKE '%会话%' OR action LIKE '%CSRF%')) AS authentication_denied,
           SUM(result='success' AND action IN ('替换 Provider 凭据','替换机器人凭据')) AS credential_changes,
           SUM(result <> 'success' AND (module='AI助手安全' OR action='拒绝 Agent Runtime 越界访问')) AS high_risk_tool_denied,
           SUM(result='success' AND action IN ('下载项目资料','下载项目资料历史版本','下载AI产物','下载Agent产物')) AS file_downloads,
           SUM(result='success' AND action IN ('预览项目资料','预览AI产物','预览Agent产物')) AS file_previews
         FROM ${table('audit_logs')} WHERE created_at >= NOW(3) - INTERVAL 15 MINUTE`,
      ),
      pool.query<MetricRow[]>(
        `SELECT COUNT(*) AS runs,
           SUM(status='failed') AS failed,
           COALESCE(SUM(input_tokens),0) AS input_tokens,
           COALESCE(SUM(output_tokens),0) AS output_tokens,
           SUM(input_tokens IS NULL OR input_tokens <= 0 OR output_tokens IS NULL) AS missing_token_runs,
           COALESCE(SUM(tool_calls),0) AS tool_calls,
           COALESCE(AVG(duration_ms),0) AS average_duration_ms,
           COALESCE(SUM(cost_microusd),0) AS cost_microusd
         FROM ${table('lead_pipeline_runs')} WHERE started_at >= NOW(3) - INTERVAL 24 HOUR`,
      ),
      pool.query<MetricRow[]>(
        `SELECT
           SUM(status='pending') AS pending_reviews,
           SUM(created_at >= NOW(3) - INTERVAL 24 HOUR) AS opened_reviews,
           SUM(status='resolved' AND resolved_at >= NOW(3) - INTERVAL 24 HOUR) AS resolved_reviews,
           COALESCE(AVG(CASE
             WHEN status='resolved' AND resolved_at >= NOW(3) - INTERVAL 24 HOUR
             THEN TIMESTAMPDIFF(MICROSECOND, created_at, resolved_at) / 1000
             ELSE NULL END),0) AS average_resolution_ms,
           COALESCE(MAX(CASE
             WHEN status='pending' THEN TIMESTAMPDIFF(MICROSECOND, created_at, NOW(3)) / 1000
             ELSE 0 END),0) AS oldest_pending_age_ms
         FROM ${table('lead_pipeline_reviews')}`,
      ),
      pool.query<MetricRow[]>(
        `SELECT
           SUM(field_name='name') AS duplicate_name_groups,
           COALESCE(SUM(CASE WHEN field_name='name' THEN record_count ELSE 0 END),0) AS duplicate_name_records,
           SUM(field_name='company_name') AS duplicate_company_groups,
           COALESCE(SUM(CASE WHEN field_name='company_name' THEN record_count ELSE 0 END),0) AS duplicate_company_records
         FROM (
           SELECT 'name' AS field_name, COUNT(*) AS record_count
           FROM ${table('leads')}
           WHERE name IS NOT NULL AND TRIM(name)<>''
           GROUP BY BINARY name HAVING COUNT(*)>1
           UNION ALL
           SELECT 'company_name' AS field_name, COUNT(*) AS record_count
           FROM ${table('leads')}
           WHERE company_name IS NOT NULL AND TRIM(company_name)<>''
           GROUP BY BINARY company_name HAVING COUNT(*)>1
         ) duplicate_groups`,
      ),
      pool.query<MetricRow[]>(
        `SELECT COUNT(*) AS tasks,
           SUM(status='failed') AS failed_tasks,
           SUM(status='failed' AND LOWER(CONCAT(COALESCE(error_code,''),' ',COALESCE(error_message,''))) REGEXP 'python|soffice|libreoffice|poppler|pdfto|tesseract|fontconfig|native runtime|原生依赖') AS native_dependency_failures,
           SUM(status='failed' AND LOWER(CONCAT(COALESCE(error_code,''),' ',COALESCE(error_message,''))) REGEXP 'render|office|pdf|ppt|docx|渲染') AS render_failures,
           SUM(status='failed' AND LOWER(CONCAT(COALESCE(error_code,''),' ',COALESCE(error_message,''))) REGEXP 'font|字体|字形') AS font_failures
         FROM ${table('ai_tasks')}
         WHERE type IN ('compliance_statement','investment_proposal','investment_recommendation_ppt','due_diligence_report','project_qa','custom_template_document')
           AND created_at >= NOW(3) - INTERVAL 24 HOUR`,
      ),
      pool.query<MetricRow[]>(
        `SELECT COUNT(*) AS artifacts,
           SUM(quality_status='failed') AS quality_failed,
           SUM(quality_status='unchecked') AS quality_unchecked
         FROM ${table('ai_artifacts')}
         WHERE created_at >= NOW(3) - INTERVAL 24 HOUR`,
      ),
      pool.query<MetricRow[]>(
        `SELECT COUNT(*) AS lifecycle_records,
           SUM(status='failed') AS failed,
           SUM(status='dead_letter') AS dead_letter,
           SUM(status='cancelled') AS cancelled,
           SUM(attempt > 1) AS retried_records,
           SUM(status IN ('failed','dead_letter') AND LOWER(COALESCE(error,'')) REGEXP 'timeout|timed out|超时') AS timeout_failures,
           SUM(status='abandoned') AS lease_recoveries,
           (SELECT COUNT(*) FROM ${table('runtime_jobs')}
             WHERE current_run_id IS NOT NULL AND lease_expires_at < NOW(3)) AS expired_leases
         FROM ${table('runtime_job_runs')}
         WHERE started_at >= NOW(3) - INTERVAL 24 HOUR`,
      ),
      pool.query<MetricRow[]>(
        `SELECT COUNT(*) AS lifecycle_records,
           SUM(status='failed') AS failed,
           SUM(status='dead_letter') AS dead_letter,
           SUM(status='discarded') AS cancelled,
           SUM(execution_attempts > 1 OR manual_retry_count > 0) AS retried_records,
           SUM(status IN ('failed','dead_letter') AND LOWER(COALESCE(last_error,'')) REGEXP 'timeout|timed out|超时') AS timeout_failures,
           SUM(LOWER(COALESCE(last_error,'')) LIKE 'lease expired before completion%') AS lease_recoveries,
           (SELECT COUNT(*) FROM ${table('lead_score_jobs')}
             WHERE status='running' AND lease_expires_at < NOW(3)) AS expired_leases
         FROM ${table('lead_score_jobs')}
         WHERE updated_at >= NOW(3) - INTERVAL 24 HOUR`,
      ),
      pool.query<MetricRow[]>(
        `SELECT COUNT(*) AS exits,
           SUM(action='子进程成功退出') AS succeeded,
           SUM(result='failed') AS failed,
           SUM(target REGEXP '(^|;)exit_code=[1-9][0-9]*(;|$)') AS non_zero_exit,
           SUM(action='子进程超时终止') AS timed_out,
           SUM(action='子进程取消终止') AS aborted,
           SUM(action='子进程停机终止') AS shutdown_terminated,
           SUM(action='子进程缓冲区终止') AS max_buffer,
           SUM(target LIKE '%;escalated=1') AS force_killed,
           COALESCE(AVG(CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(target,'duration_ms=',-1),';',1) AS UNSIGNED)),0)
             AS average_duration_ms
         FROM ${table('audit_logs')}
         WHERE module='进程监督' AND created_at >= NOW(3) - INTERVAL 24 HOUR`,
      ),
      pool.query<MetricRow[]>(
        `SELECT COUNT(*) AS lifecycle_records,
           0 AS failed,
           SUM(status='dead_letter') AS dead_letter,
           0 AS cancelled,
           SUM(execution_attempts > 1) AS retried_records,
           SUM(status='dead_letter' AND LOWER(COALESCE(last_error,'')) REGEXP 'timeout|timed out|超时') AS timeout_failures,
           SUM(LOWER(COALESCE(last_error,'')) LIKE 'lease expired before completion%') AS lease_recoveries,
           (SELECT COUNT(*) FROM ${table('project_score_jobs')}
             WHERE status='running' AND lease_expires_at < NOW(3)) AS expired_leases
         FROM ${table('project_score_jobs')}
         WHERE updated_at >= NOW(3) - INTERVAL 24 HOUR`,
      ),
      pool.query<MetricRow[]>(
        `SELECT
           SUM(action='租约领取争抢未获') AS lease_contentions,
           SUM(action='重复任务入队已抑制') AS duplicate_suppressed,
           SUM(action='过期执行结果已拒绝') AS stale_completion_rejected,
           SUM(action='过期租约已恢复') AS lease_recovery_events
         FROM ${table('audit_logs')}
         WHERE module='任务协调' AND result='success'
           AND created_at >= NOW(3) - INTERVAL 24 HOUR`,
      ),
      pool.query<MetricRow[]>(
        `SELECT COUNT(*) AS lifecycle_records,
           SUM(status='failed') AS failed,
           0 AS dead_letter,
           SUM(status='cancelled') AS cancelled,
           SUM(execution_attempts > 1 OR retry_of_task_id IS NOT NULL) AS retried_records,
           SUM(status='failed' AND LOWER(CONCAT(COALESCE(error_code,''),' ',COALESCE(error_message,''))) REGEXP 'timeout|timed out|超时') AS timeout_failures,
           0 AS lease_recoveries,
           (SELECT COUNT(*) FROM ${table('ai_tasks')}
             WHERE status='running' AND lease_expires_at < NOW(3)) AS expired_leases
         FROM ${table('ai_tasks')}
         WHERE updated_at >= NOW(3) - INTERVAL 24 HOUR`,
      ),
      pool.query<MetricRow[]>(
        `SELECT COUNT(*) AS sources,
           SUM(status NOT IN ('idle','running','caught_up')) AS unhealthy_sources,
           COALESCE(MAX(replication_lag_ms),0) AS max_replication_lag_ms,
           COALESCE(SUM(GREATEST(source_observed_watermark-source_safe_watermark,0)),0) AS watermark_gap,
           COALESCE(SUM(deleted_events),0) AS delete_events,
           COALESCE(SUM(cascade_deleted_events),0) AS cascade_delete_events
         FROM ${table('migration_cdc_checkpoints')}`,
      ),
      pool.query<MetricRow[]>(
        `SELECT COUNT(*) AS total,
           SUM(imported=1) AS imported,
           SUM(imported=1 AND imported_at IS NULL) AS imported_timestamp_missing,
           SUM(detail_json IS NULL) AS source_missing,
           SUM(imported=0 AND detail_json IS NOT NULL) AS awaiting_processing,
           COALESCE(MAX(seq),0) AS max_sequence,
           SUM(r.detail_json IS NOT NULL AND e.reserve_id IS NULL) AS raw_event_missing
         FROM ${table('lead_reserve')} r
         LEFT JOIN (
           SELECT DISTINCT CAST(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.reserveId')) AS UNSIGNED) AS reserve_id
           FROM ${table('lead_pipeline_raw_events')} WHERE source_type='lead_reserve'
         ) e ON e.reserve_id=r.id`,
      ),
      pool.query<MetricRow[]>(
        `SELECT
           (SELECT COUNT(*) FROM ${table('radar_raw_events')}) AS raw_events,
           (SELECT COUNT(*) FROM ${table('radar_candidates')}) AS candidates,
           (SELECT COUNT(*) FROM ${table('radar_collector_states')}) AS collector_states,
           (SELECT COUNT(*) FROM ${table('radar_source_registry')}) AS source_registry,
           (SELECT COUNT(*) FROM ${table('radar_sync_state')}) AS sync_states,
           (SELECT COUNT(*) FROM ${table('radar_sync_state')} WHERE backfill_complete=0) AS incomplete_backfills,
           (SELECT COALESCE(MAX(cursor_timestamp),0) FROM ${table('radar_candidates')}) AS latest_cursor_timestamp,
           (SELECT COUNT(*) FROM ${table('runtime_jobs')} WHERE id IN
             ('radar-collect-sync','radar-paper-daily','radar-wechat-daily','radar-wechat-retry','radar-wechat-institution')) AS runtime_jobs,
           (SELECT COUNT(*) FROM ${table('runtime_jobs')} WHERE id IN
             ('radar-collect-sync','radar-paper-daily','radar-wechat-daily','radar-wechat-retry','radar-wechat-institution')
             AND last_status IN ('failed','dead_letter')) AS failed_runtime_jobs`,
      ),
    ])
    const im = imResult[0][0]
    const delivery = deliveryResult[0][0]
    const files = fileResult[0][0]
    const security = securityResult[0][0]
    const leadAgents = leadAgentResult[0][0]
    const leadReviews = leadReviewResult[0][0]
    const leadDuplicates = leadDuplicateResult[0][0]
    const documentTasks = documentTaskResult[0][0]
    const documentArtifacts = documentArtifactResult[0][0]
    const jobRows = [runtimeJobResult, leadScoreJobResult, projectScoreJobResult, aiTaskResult]
      .map((result) => result[0][0])
    const coordination = coordinationResult[0][0]
    const processHistory = processHistoryResult[0][0]
    const cdc = cdcResult[0][0]
    const reserve = reserveResult[0][0]
    const radar = radarResult[0][0]
    return {
      mysqlPool: poolSnapshot(),
      mysqlServer,
      im: {
        queued: number(im, 'queued'), sending: number(im, 'sending'),
        failed: number(im, 'failed'), deadLetter: number(im, 'dead_letter'),
        deliveries15m: number(delivery, 'deliveries'),
        deliveryFailures15m: number(delivery, 'failures'),
        averageDeliveryMs15m: Math.round(number(delivery, 'average_duration_ms')),
      },
      files: {
        total: number(files, 'total'), totalBytes: number(files, 'total_bytes'),
        parsing: number(files, 'parsing'), parseFailed: number(files, 'parse_failed'),
        missingContentIdentity: number(files, 'missing_content_identity'),
        downloads15m: number(security, 'file_downloads'), previews15m: number(security, 'file_previews'),
      },
      security: {
        auditEvents15m: number(security, 'audit_events'),
        deniedEvents15m: number(security, 'denied_events'),
        authenticationDenied15m: number(security, 'authentication_denied'),
        credentialChanges15m: number(security, 'credential_changes'),
        highRiskToolDenied15m: number(security, 'high_risk_tool_denied'),
      },
      leadAgents: {
        runs24h: number(leadAgents, 'runs'), failed24h: number(leadAgents, 'failed'),
        inputTokens24h: number(leadAgents, 'input_tokens'), outputTokens24h: number(leadAgents, 'output_tokens'),
        missingTokenRuns24h: number(leadAgents, 'missing_token_runs'), toolCalls24h: number(leadAgents, 'tool_calls'),
        averageDurationMs24h: Math.round(number(leadAgents, 'average_duration_ms')),
        costMicrousd24h: number(leadAgents, 'cost_microusd'),
        pendingReviews: number(leadReviews, 'pending_reviews'),
        openedReviews24h: number(leadReviews, 'opened_reviews'),
        resolvedReviews24h: number(leadReviews, 'resolved_reviews'),
        averageReviewResolutionMs24h: Math.round(number(leadReviews, 'average_resolution_ms')),
        oldestPendingReviewAgeMs: Math.round(number(leadReviews, 'oldest_pending_age_ms')),
        duplicateNameGroups: number(leadDuplicates, 'duplicate_name_groups'),
        duplicateNameRecords: number(leadDuplicates, 'duplicate_name_records'),
        duplicateCompanyGroups: number(leadDuplicates, 'duplicate_company_groups'),
        duplicateCompanyRecords: number(leadDuplicates, 'duplicate_company_records'),
        duplicateEntityGroups: number(leadDuplicates, 'duplicate_name_groups')
          + number(leadDuplicates, 'duplicate_company_groups'),
      },
      documents: {
        tasks24h: number(documentTasks, 'tasks'),
        failedTasks24h: number(documentTasks, 'failed_tasks'),
        nativeDependencyFailures24h: number(documentTasks, 'native_dependency_failures'),
        renderFailures24h: number(documentTasks, 'render_failures'),
        fontFailures24h: number(documentTasks, 'font_failures'),
        artifacts24h: number(documentArtifacts, 'artifacts'),
        qualityFailed24h: number(documentArtifacts, 'quality_failed'),
        qualityUnchecked24h: number(documentArtifacts, 'quality_unchecked'),
      },
      jobHistory: {
        lifecycleRecords24h: jobRows.reduce((sum, row) => sum + number(row, 'lifecycle_records'), 0),
        failed24h: jobRows.reduce((sum, row) => sum + number(row, 'failed'), 0),
        deadLetter24h: jobRows.reduce((sum, row) => sum + number(row, 'dead_letter'), 0),
        cancelled24h: jobRows.reduce((sum, row) => sum + number(row, 'cancelled'), 0),
        retriedRecords24h: jobRows.reduce((sum, row) => sum + number(row, 'retried_records'), 0),
        timeoutFailures24h: jobRows.reduce((sum, row) => sum + number(row, 'timeout_failures'), 0),
        leaseRecoveries24h: jobRows.reduce((sum, row) => sum + number(row, 'lease_recoveries'), 0),
        expiredLeases: jobRows.reduce((sum, row) => sum + number(row, 'expired_leases'), 0),
        leaseContentions24h: number(coordination, 'lease_contentions'),
        duplicateSuppressed24h: number(coordination, 'duplicate_suppressed'),
        staleCompletionRejected24h: number(coordination, 'stale_completion_rejected'),
        leaseRecoveryEvents24h: number(coordination, 'lease_recovery_events'),
      },
      processHistory: {
        exits24h: number(processHistory, 'exits'),
        succeeded24h: number(processHistory, 'succeeded'),
        failed24h: number(processHistory, 'failed'),
        nonZeroExit24h: number(processHistory, 'non_zero_exit'),
        timeout24h: number(processHistory, 'timed_out'),
        aborted24h: number(processHistory, 'aborted'),
        shutdown24h: number(processHistory, 'shutdown_terminated'),
        maxBuffer24h: number(processHistory, 'max_buffer'),
        forceKilled24h: number(processHistory, 'force_killed'),
        averageDurationMs24h: Math.round(number(processHistory, 'average_duration_ms')),
      },
      cdc: {
        sources: number(cdc, 'sources'), unhealthySources: number(cdc, 'unhealthy_sources'),
        maxReplicationLagMs: number(cdc, 'max_replication_lag_ms'), watermarkGap: number(cdc, 'watermark_gap'),
        deleteEvents: number(cdc, 'delete_events'), cascadeDeleteEvents: number(cdc, 'cascade_delete_events'),
      },
      leadReserve: {
        total: number(reserve, 'total'), imported: number(reserve, 'imported'),
        importedTimestampMissing: number(reserve, 'imported_timestamp_missing'),
        sourceMissing: number(reserve, 'source_missing'), awaitingProcessing: number(reserve, 'awaiting_processing'),
        maxSequence: number(reserve, 'max_sequence'), rawEventMissing: number(reserve, 'raw_event_missing'),
      },
      radar: {
        rawEvents: number(radar, 'raw_events'), candidates: number(radar, 'candidates'),
        collectorStates: number(radar, 'collector_states'), sourceRegistry: number(radar, 'source_registry'),
        syncStates: number(radar, 'sync_states'), incompleteBackfills: number(radar, 'incomplete_backfills'),
        latestCursorTimestamp: number(radar, 'latest_cursor_timestamp'), runtimeJobs: number(radar, 'runtime_jobs'),
        failedRuntimeJobs: number(radar, 'failed_runtime_jobs'),
      },
    }
  }
}

export const operationalTelemetryRepository = new MysqlOperationalTelemetryRepository()
