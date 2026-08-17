import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlConfig } from '../db/config.js'

type TableRow = RowDataPacket & { tableName: string }
type ColumnRow = RowDataPacket & {
  tableName: string
  columnName: string
  isNullable: 'YES' | 'NO'
  dataType: string
  extra: string
}
type IndexRow = RowDataPacket & {
  tableName: string
  indexName: string
  nonUnique: number
  columns: string
}
type ForeignKeyRow = RowDataPacket & {
  tableName: string
  columnName: string
  referencedTableName: string
  referencedColumnName: string
  deleteRule: string
}

const domainTables = Object.freeze({
  iam: [
    'users', 'auth_sessions', 'auth_legacy_bearer_policy', 'iam_user_mappings',
    'identity_resolution_issues', 'project_members',
  ],
  investment: [
    'projects', 'leads', 'meetings', 'meeting_participants', 'todos', 'risks',
    'oa_approval_requests', 'oa_approval_nodes', 'oa_approval_records', 'oa_workflow_logs',
    'lead_score_jobs', 'project_score_jobs',
  ],
  knowledge: [
    'project_files', 'project_file_versions', 'file_chunks', 'knowledge_chunks', 'ai_summaries',
  ],
  agent: [
    'agent_conversations', 'agent_messages', 'agent_message_parts',
    'agent_conversation_source_mappings', 'agent_message_source_mappings',
  ],
  aiTask: [
    'ai_tasks', 'ai_artifacts', 'ai_task_sources', 'ai_task_templates',
    'ai_custom_templates', 'ai_template_analysis_progress',
  ],
  runtime: [
    'ai_model_providers', 'ai_models', 'ai_model_routes', 'ai_capabilities',
    'ai_capability_bindings', 'ai_conversation_capabilities', 'im_bots', 'im_bot_bindings',
    'im_outbox', 'im_delivery_logs', 'im_inbound_messages', 'im_lead_push_rules',
  ],
  scheduler: ['runtime_jobs', 'runtime_job_runs'],
  audit: [
    'audit_logs', 'migration_runs', 'migration_issues', 'migration_entity_mappings',
    'migration_cdc_events', 'migration_cdc_checkpoints', 'admin_configuration_revisions',
  ],
})

const duplicateAuthorities = [
  'iam_users', 'investment_projects', 'knowledge_files', 'scheduler_jobs', 'scheduler_job_runs',
  'runtime_model_providers', 'runtime_models', 'runtime_capabilities', 'runtime_plugins',
  'runtime_im_bots', 'audit_security_events',
] as const

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[mysql architecture contract] ${message}`)
}

function physical(logicalName: string): string {
  return `${mysqlConfig.tablePrefix}${logicalName}`
}

function key(tableName: string, itemName: string): string {
  return `${tableName}\u0000${itemName}`
}

async function persistEvidence(report: Record<string, unknown>) {
  const evidenceDir = path.resolve('.runtime/migration-evidence/mysql-architecture-contract')
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const reportPath = path.join(evidenceDir, 'report.json')
  const summaryPath = path.join(evidenceDir, 'summary.md')
  const domains = report.domains as Record<string, string[]>
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await writeFile(summaryPath, [
    '# MySQL 领域架构契约验收',
    '',
    `- 结果：${report.ok ? '通过' : '未通过'}`,
    `- 领域：${Object.keys(domains).length}`,
    `- 契约覆盖逻辑表：${new Set(Object.values(domains).flat()).size}`,
    '- PostgreSQL 部分唯一等价：OA 活动流程已落生成键语义；线索活动名称约束保持待业务去重裁决。',
    '- 本验收只读 information_schema 与代码/文档，不创建夹具，不改变业务数据。',
    '',
    '报告不包含数据库主机、库名、用户名、密码或业务正文。',
    '',
  ].join('\n'), { mode: 0o600 })
  await Promise.all([chmod(reportPath, 0o600), chmod(summaryPath, 0o600)])
}

async function main() {
  try {
    const [tableRows] = await pool.query<TableRow[]>(`
      SELECT TABLE_NAME AS tableName
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
    `, [mysqlConfig.database])
    const [columnRows] = await pool.query<ColumnRow[]>(`
      SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
             IS_NULLABLE AS isNullable, DATA_TYPE AS dataType, EXTRA AS extra
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
    `, [mysqlConfig.database])
    const [indexRows] = await pool.query<IndexRow[]>(`
      SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
             GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS columns
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
      GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE
    `, [mysqlConfig.database])
    const [foreignKeyRows] = await pool.query<ForeignKeyRow[]>(`
      SELECT k.TABLE_NAME AS tableName, k.COLUMN_NAME AS columnName,
             k.REFERENCED_TABLE_NAME AS referencedTableName,
             k.REFERENCED_COLUMN_NAME AS referencedColumnName,
             r.DELETE_RULE AS deleteRule
      FROM information_schema.KEY_COLUMN_USAGE k
      JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
       AND r.TABLE_NAME = k.TABLE_NAME
       AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
      WHERE k.CONSTRAINT_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
    `, [mysqlConfig.database])

    const tables = new Set(tableRows.map((row) => row.tableName))
    const columns = new Map(columnRows.map((row) => [key(row.tableName, row.columnName), row]))
    const indexes = new Map(indexRows.map((row) => [key(row.tableName, row.indexName), row]))
    const foreignKeys = new Map(foreignKeyRows.map((row) => [key(row.tableName, row.columnName), row]))

    for (const [domain, logicalTables] of Object.entries(domainTables)) {
      for (const logicalTable of logicalTables) {
        assertContract(tables.has(physical(logicalTable)), `${domain} domain table is missing: ${logicalTable}`)
      }
    }
    for (const duplicate of duplicateAuthorities) {
      assertContract(!tables.has(physical(duplicate)), `duplicate prefix-only authority must not exist: ${duplicate}`)
    }

    const requireColumn = (tableName: string, columnName: string) => {
      const value = columns.get(key(physical(tableName), columnName))
      assertContract(value, `missing column ${tableName}.${columnName}`)
      return value
    }
    const requireIndex = (tableName: string, indexName: string, expectedColumns: string, unique?: boolean) => {
      const value = indexes.get(key(physical(tableName), indexName))
      assertContract(value, `missing index ${tableName}.${indexName}`)
      assertContract(value.columns === expectedColumns, `${tableName}.${indexName} columns drifted: ${value.columns}`)
      if (unique !== undefined) {
        assertContract(Number(value.nonUnique) === (unique ? 0 : 1), `${tableName}.${indexName} uniqueness drifted`)
      }
      return value
    }

    for (const tableName of ['ai_model_providers', 'ai_models', 'ai_model_routes', 'ai_capabilities', 'ai_capability_bindings']) {
      requireColumn(tableName, 'enabled')
      requireColumn(tableName, 'version')
    }
    for (const tableName of ['im_bots', 'im_bot_bindings', 'im_lead_push_rules']) {
      requireColumn(tableName, 'enabled')
      requireColumn(tableName, 'version')
    }
    for (const columnName of ['credential_ciphertext', 'credential_hint', 'credential_fingerprint']) {
      requireColumn('ai_model_providers', columnName)
      requireColumn('im_bots', columnName)
    }
    const credentialTables = new Set(['ai_model_providers', 'im_bots'].map(physical))
    const forbiddenCredentialColumns = columnRows.filter((row) => credentialTables.has(row.tableName)
      && /^(api_key|secret|access_token|password|credential_plaintext)$/i.test(row.columnName))
    assertContract(forbiddenCredentialColumns.length === 0, 'runtime configuration contains a plaintext credential column')
    requireIndex('ai_model_providers', 'uq_ai_model_providers_name', 'name', true)
    requireIndex('ai_models', 'uq_ai_models_provider_key', 'provider_id,model_key', true)
    requireIndex('ai_capabilities', 'uq_ai_capabilities_kind_key', 'kind,capability_key', true)
    requireIndex('ai_capability_bindings', 'uq_ai_capability_bindings_scope', 'capability_id,scope_type,scope_key', true)
    requireIndex('im_bot_bindings', 'uq_im_bot_bindings_external', 'bot_id,external_conversation_id', true)
    requireIndex('im_outbox', 'uq_im_outbox_idempotency', 'bot_id,idempotency_key', true)
    requireIndex('im_delivery_logs', 'uq_im_delivery_logs_attempt', 'outbox_id,attempt', true)
    requireIndex('im_inbound_messages', 'uq_im_inbound_external', 'bot_id,external_message_id', true)

    for (const columnName of [
      'enabled', 'schedule_kind', 'next_run_at', 'lease_owner', 'lease_expires_at',
      'current_run_id', 'last_status', 'consecutive_failures',
    ]) requireColumn('runtime_jobs', columnName)
    for (const columnName of ['job_id', 'status', 'attempt', 'lease_owner', 'started_at', 'finished_at', 'result', 'error']) {
      requireColumn('runtime_job_runs', columnName)
    }
    requireIndex('runtime_jobs', 'idx_runtime_jobs_due', 'enabled,next_run_at', false)
    requireIndex('runtime_jobs', 'idx_runtime_jobs_lease', 'lease_expires_at', false)
    requireIndex('runtime_job_runs', 'idx_runtime_job_runs_job_started', 'job_id,started_at', false)
    const runJobForeignKey = foreignKeys.get(key(physical('runtime_job_runs'), 'job_id'))
    assertContract(runJobForeignKey?.referencedTableName === physical('runtime_jobs'), 'runtime job run FK target drifted')
    assertContract(runJobForeignKey?.referencedColumnName === 'id', 'runtime job run FK column drifted')
    assertContract(runJobForeignKey?.deleteRule === 'CASCADE', 'runtime job run FK must cascade on job deletion')

    for (const columnName of ['user_id', 'user_name', 'module', 'action', 'target', 'ip', 'result', 'request_id', 'created_at']) {
      requireColumn('audit_logs', columnName)
    }
    requireIndex('audit_logs', 'idx_audit_user', 'user_id', false)
    requireIndex('audit_logs', 'idx_audit_time', 'created_at', false)
    requireIndex('audit_logs', 'idx_audit_request', 'request_id', false)
    for (const columnName of [
      'domain', 'resource_type', 'resource_id', 'operation', 'source_version',
      'snapshot_ciphertext', 'snapshot_sha256', 'created_by', 'created_at',
    ]) requireColumn('admin_configuration_revisions', columnName)
    requireIndex('admin_configuration_revisions', 'uq_admin_config_revision_resource_version',
      'domain,resource_type,resource_id,source_version', true)
    requireIndex('admin_configuration_revisions', 'idx_admin_config_revision_resource_time',
      'domain,resource_type,resource_id,created_at', false)
    requireIndex('admin_configuration_revisions', 'idx_admin_config_revision_actor_time',
      'created_by,created_at', false)
    const revisionActorForeignKey = foreignKeys.get(key(physical('admin_configuration_revisions'), 'created_by'))
    assertContract(revisionActorForeignKey?.referencedTableName === physical('users'), 'configuration revision actor FK target drifted')
    assertContract(revisionActorForeignKey?.deleteRule === 'SET NULL', 'configuration revision actor FK must preserve history after user deletion')

    const oaActiveKey = requireColumn('oa_approval_requests', 'active_key')
    assertContract(oaActiveKey.isNullable === 'YES', 'OA active_key must be nullable for terminal workflows')
    requireIndex('oa_approval_requests', 'uq_oa_active_project', 'active_key', true)
    requireIndex('users', `${mysqlConfig.tablePrefix}users_email_unique`, 'email', true)
    assertContract(!columns.has(key(physical('leads'), 'active_name')), 'lead active_name must remain deferred until duplicate adjudication')
    assertContract(!indexes.has(key(physical('leads'), 'uq_leads_name_active')), 'lead active-name unique index must remain deferred until duplicate adjudication')

    const [schedulerSource, aiConfigurationRepository, imRepository, revisionRepository, revisionCrypto, auditSource, lifecycleDecision, architectureDecision] = await Promise.all([
      readFile(path.resolve('server/src/services/runtimeJobScheduler.ts'), 'utf8'),
      readFile(path.resolve('server/src/repositories/mysql/mysqlAiConfigurationRepository.ts'), 'utf8'),
      readFile(path.resolve('server/src/repositories/mysql/mysqlImIntegrationRepository.ts'), 'utf8'),
      readFile(path.resolve('server/src/repositories/mysql/mysqlAdminConfigurationRevisionRepository.ts'), 'utf8'),
      readFile(path.resolve('server/src/security/configurationRevisionCrypto.ts'), 'utf8'),
      readFile(path.resolve('server/src/services/auditService.ts'), 'utf8'),
      readFile(path.resolve('docs/迁移计划/附属业务域迁移与退场报告-20260810.md'), 'utf8'),
      readFile(path.resolve('docs/迁移计划/MySQL领域命名与约束裁决-20260811.md'), 'utf8'),
    ])
    assertContract(/FOR UPDATE/.test(schedulerSource) && /lease_expires_at/.test(schedulerSource), 'scheduler row lock/lease implementation is missing')
    assertContract(/db\.transaction/.test(aiConfigurationRepository) && /expectedVersion/.test(aiConfigurationRepository), 'AI configuration transaction/optimistic-lock contract is missing')
    assertContract(/FOR UPDATE SKIP LOCKED/.test(imRepository) && /idempotencyKey/.test(imRepository), 'IM lease/idempotency contract is missing')
    assertContract(/db\.transaction/.test(revisionRepository) && /expectedVersion/.test(revisionRepository), 'configuration revision rollback transaction/optimistic-lock contract is missing')
    assertContract(/createCipheriv\('aes-256-gcm'/.test(revisionCrypto) && /setAAD/.test(revisionCrypto), 'configuration revision encryption/AAD contract is missing')
    assertContract(!/db\.(?:update|delete)\(adminConfigurationRevisions\)/.test(revisionRepository), 'configuration revision history must remain append-only')
    assertContract(/db\.insert\(auditLogs\)/.test(auditSource), 'audit service must append audit rows')
    assertContract(!/db\.(?:update|delete)\(auditLogs\)/.test(auditSource), 'runtime audit service must not update/delete audit rows')
    for (const lifecycle of ['OA 审批', '投后更新', '通知/已读', '旧材料记录/页面', '组织/角色/字典', '内置 AI 模板', '自定义模板']) {
      assertContract(lifecycleDecision.includes(lifecycle), `lifecycle decision is missing: ${lifecycle}`)
    }
    for (const id of ['MIG-0110', 'MIG-0111', 'MIG-0112', 'MIG-0113', 'MIG-0114', 'MIG-0116', 'MIG-0117', 'MIG-0118', 'MIG-0120', 'MIG-0126', 'MIG-0137']) {
      assertContract(architectureDecision.includes(id), `architecture decision does not trace ${id}`)
    }

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      readOnly: true,
      connectionIdentityExcluded: true,
      domains: domainTables,
      duplicateAuthoritiesAbsent: [...duplicateAuthorities],
      partialUniqueEquivalents: {
        oaActiveProject: 'nullable active_key + uq_oa_active_project',
        userEmail: 'full unique users_email_unique',
        leadActiveName: 'deferred: 9 duplicate name groups / 25 rows require business adjudication',
      },
      checks: [
        'conceptual-domains-map-to-existing-physical-tables',
        'prefix-only-duplicate-authorities-absent',
        'runtime-model-capability-plugin-im-configuration-contract',
        'encrypted-provider-and-bot-credential-columns',
        'configuration-unique-and-optimistic-version-contract',
        'scheduler-due-lease-run-history-and-cascade-contract',
        'audit-identity-result-request-time-and-append-only-runtime-contract',
        'configuration-revision-encryption-version-actor-and-append-only-contract',
        'oa-nullable-active-key-partial-unique-equivalent',
        'full-user-email-unique-equivalent',
        'lead-active-name-unique-remains-deferred',
        'transaction-row-lock-idempotency-and-optimistic-lock-source-contract',
        'adjacent-domain-lifecycle-decisions-present',
        'architecture-decision-traces-migration-items',
        'no-fixtures-or-business-data-writes',
        'connection-identity-and-business-content-excluded-from-evidence',
      ],
    }
    await persistEvidence(report)
    console.log(JSON.stringify(report))
  } finally {
    await pool.end()
  }
}

await main()
