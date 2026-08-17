import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlConfig } from '../db/config.js'

type OperationalVariables = RowDataPacket & {
  version: string
  defaultEngine: string
  databaseCharset: string
  databaseCollation: string
  clientCharset: string
  connectionCharset: string
  resultCharset: string
  connectionCollation: string
  globalTimeZone: string
  sessionTimeZone: string
  isolationLevel: string
  sqlMode: string
  maxConnections: number
  slowQueryLog: number
  longQueryTimeSeconds: number
  logOutput: string
  minExaminedRows: number
  performanceSchema: number
}

type StatusRow = RowDataPacket & {
  Variable_name: string
  Value: string
}

const APPROVED = Object.freeze({
  version: '8.0.36',
  engine: 'InnoDB',
  charset: 'utf8mb4',
  collation: 'utf8mb4_0900_ai_ci',
  timeZone: '+08:00',
  isolationLevel: 'READ-COMMITTED',
  minimumConnections: 100,
  maximumConnections: 10_000,
  maximumSlowQuerySeconds: 1,
})

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[mysql operational config] ${message}`)
}

function numericStatus(rows: StatusRow[], name: string): number {
  const value = Number(rows.find((row) => row.Variable_name === name)?.Value)
  assertContract(Number.isFinite(value), `missing numeric status ${name}`)
  return value
}

async function persistEvidence(report: Record<string, unknown>) {
  const evidenceDir = path.resolve('.runtime/migration-evidence/mysql-operational-config')
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const reportPath = path.join(evidenceDir, 'report.json')
  const summaryPath = path.join(evidenceDir, 'summary.md')
  const configuration = report.configuration as Record<string, unknown>
  const capacity = report.capacity as Record<string, unknown>
  const slowQuery = report.slowQuery as Record<string, unknown>
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await writeFile(summaryPath, [
    '# MySQL 运行配置验收',
    '',
    `- 结果：${report.ok ? '通过' : '未通过'}`,
    `- MySQL：${configuration.version}`,
    `- 字符集/排序规则：${configuration.databaseCharset}/${configuration.databaseCollation}`,
    `- 时区：全局 ${configuration.globalTimeZone}，会话 ${configuration.sessionTimeZone}`,
    `- 最大连接数：${capacity.maxConnections}；应用池：${capacity.applicationPoolConnections}；历史峰值：${capacity.maxUsedConnections}`,
    `- 慢查询：${slowQuery.enabled ? '开启' : '关闭'}；阈值 ${slowQuery.longQueryTimeSeconds}s；输出 ${slowQuery.logOutput}`,
    '',
    '报告不包含数据库主机、库名、用户名或密码。',
    '',
  ].join('\n'), { mode: 0o600 })
  await Promise.all([chmod(reportPath, 0o600), chmod(summaryPath, 0o600)])
}

async function main() {
  try {
    const [variableRows] = await pool.query<OperationalVariables[]>(`SELECT
      @@version AS version,
      @@default_storage_engine AS defaultEngine,
      @@character_set_database AS databaseCharset,
      @@collation_database AS databaseCollation,
      @@character_set_client AS clientCharset,
      @@character_set_connection AS connectionCharset,
      @@character_set_results AS resultCharset,
      @@collation_connection AS connectionCollation,
      @@global.time_zone AS globalTimeZone,
      @@session.time_zone AS sessionTimeZone,
      @@transaction_isolation AS isolationLevel,
      @@sql_mode AS sqlMode,
      @@max_connections AS maxConnections,
      @@slow_query_log AS slowQueryLog,
      @@long_query_time AS longQueryTimeSeconds,
      @@log_output AS logOutput,
      @@min_examined_row_limit AS minExaminedRows,
      @@performance_schema AS performanceSchema`)
    const variables = variableRows[0]
    assertContract(variables, 'server variable query returned no row')

    const [statusRows] = await pool.query<StatusRow[]>(`SHOW GLOBAL STATUS
      WHERE Variable_name IN ('Threads_connected','Threads_running','Max_used_connections','Slow_queries')`)
    const threadsConnected = numericStatus(statusRows, 'Threads_connected')
    const threadsRunning = numericStatus(statusRows, 'Threads_running')
    const maxUsedConnections = numericStatus(statusRows, 'Max_used_connections')
    const slowQueries = numericStatus(statusRows, 'Slow_queries')

    const [healthRows] = await pool.query<Array<RowDataPacket & { ok: number }>>('SELECT 1 AS ok')
    assertContract(Number(healthRows[0]?.ok) === 1, 'read-only health query failed')

    assertContract(variables.version === APPROVED.version, `version must be ${APPROVED.version}`)
    assertContract(variables.defaultEngine === APPROVED.engine, `default engine must be ${APPROVED.engine}`)
    assertContract(variables.databaseCharset === APPROVED.charset, `database charset must be ${APPROVED.charset}`)
    assertContract(variables.databaseCollation === APPROVED.collation, `database collation must be ${APPROVED.collation}`)
    assertContract(
      [variables.clientCharset, variables.connectionCharset, variables.resultCharset].every((value) => value === APPROVED.charset),
      `client, connection and result charset must all be ${APPROVED.charset}`,
    )
    assertContract(variables.connectionCollation === APPROVED.collation, `connection collation must be ${APPROVED.collation}`)
    assertContract(
      variables.globalTimeZone === APPROVED.timeZone && variables.sessionTimeZone === APPROVED.timeZone,
      `global and session time zones must both be ${APPROVED.timeZone}`,
    )
    assertContract(variables.isolationLevel === APPROVED.isolationLevel, `isolation must be ${APPROVED.isolationLevel}`)
    assertContract(variables.sqlMode.includes('STRICT_TRANS_TABLES'), 'STRICT_TRANS_TABLES must be enabled')

    const maxConnections = Number(variables.maxConnections)
    const requiredCapacity = Math.max(APPROVED.minimumConnections, mysqlConfig.connectionLimit + 20)
    assertContract(
      Number.isInteger(maxConnections)
        && maxConnections >= requiredCapacity
        && maxConnections <= APPROVED.maximumConnections,
      `max_connections must be between ${requiredCapacity} and ${APPROVED.maximumConnections}`,
    )
    assertContract(maxUsedConnections < maxConnections, 'historical connection peak must remain below max_connections')
    assertContract(mysqlConfig.queueLimit >= mysqlConfig.connectionLimit, 'pool queue limit must cover at least one full pool')
    assertContract(mysqlConfig.connectTimeoutMs <= 60_000, 'pool connect timeout must fail within 60 seconds')

    const logDestinations = variables.logOutput.split(',').map((value) => value.trim().toUpperCase())
    assertContract(Number(variables.slowQueryLog) === 1, 'slow query log must be enabled')
    assertContract(
      Number(variables.longQueryTimeSeconds) > 0
        && Number(variables.longQueryTimeSeconds) <= APPROVED.maximumSlowQuerySeconds,
      `long_query_time must be within (0, ${APPROVED.maximumSlowQuerySeconds}] seconds`,
    )
    assertContract(logDestinations.includes('TABLE') || logDestinations.includes('FILE'), 'slow query log must use TABLE or FILE output')

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      connectionIdentityExcluded: true,
      configuration: {
        version: variables.version,
        defaultEngine: variables.defaultEngine,
        databaseCharset: variables.databaseCharset,
        databaseCollation: variables.databaseCollation,
        clientCharset: variables.clientCharset,
        connectionCharset: variables.connectionCharset,
        resultCharset: variables.resultCharset,
        connectionCollation: variables.connectionCollation,
        globalTimeZone: variables.globalTimeZone,
        sessionTimeZone: variables.sessionTimeZone,
        isolationLevel: variables.isolationLevel,
        strictSqlMode: true,
      },
      capacity: {
        maxConnections,
        requiredCapacity,
        applicationPoolConnections: mysqlConfig.connectionLimit,
        applicationQueueLimit: mysqlConfig.queueLimit,
        connectTimeoutMs: mysqlConfig.connectTimeoutMs,
        threadsConnected,
        threadsRunning,
        maxUsedConnections,
      },
      slowQuery: {
        enabled: true,
        longQueryTimeSeconds: Number(variables.longQueryTimeSeconds),
        logOutput: variables.logOutput,
        minExaminedRows: Number(variables.minExaminedRows),
        slowQueries,
        performanceSchemaEnabled: Number(variables.performanceSchema) === 1,
      },
      checks: [
        'approved-version-engine-and-isolation',
        'utf8mb4-client-connection-database-contract',
        'approved-database-and-connection-collation',
        'global-and-session-time-zone',
        'strict-sql-mode',
        'bounded-server-connection-capacity',
        'pool-capacity-queue-and-connect-timeout',
        'historical-peak-below-capacity',
        'slow-query-log-enabled',
        'slow-query-threshold-and-destination',
        'read-only-database-health-query',
        'connection-identity-excluded-from-evidence',
      ],
    }
    await persistEvidence(report)
    console.log(JSON.stringify(report))
  } finally {
    await pool.end()
  }
}

await main()
