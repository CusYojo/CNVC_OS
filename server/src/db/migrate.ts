import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import { drizzle } from 'drizzle-orm/mysql2'
import type { RowDataPacket } from 'mysql2'
import { pool } from './client.js'
import { mysqlConfig, mysqlTableName } from './config.js'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

function resolveMigrationsFolder(): string {
  const configured = process.env.DB_MIGRATIONS_DIR?.trim()
  if (configured) return path.resolve(configured)

  // Source execution: server/src/db -> server/drizzle
  // Compiled execution: server-dist/db -> server/drizzle
  return path.resolve(moduleDir, moduleDir.includes(`${path.sep}server-dist${path.sep}`)
    ? '../../server/drizzle'
    : '../../drizzle')
}

export function rewriteMigrationSqlForPrefix(sqlText: string, tablePrefix: string): string {
  if (tablePrefix === 'sbl_') return sqlText
  const constraintName = (originalName: string) => {
    const expanded = originalName.startsWith('sbl_')
      ? `${tablePrefix}${originalName.slice('sbl_'.length)}`
      : `${tablePrefix}${originalName}`
    if (expanded.length <= 64) return expanded
    const hash = createHash('sha256').update(expanded).digest('hex').slice(0, 12)
    return `${expanded.slice(0, 64 - hash.length - 1)}_${hash}`
  }
  const rewrittenConstraints = sqlText
    .replace(/CONSTRAINT `([^`]+)`(?=\s+(?:FOREIGN\s+KEY|CHECK))/gi, (_match, name: string) => `CONSTRAINT \`${constraintName(name)}\``)
    .replace(/DROP CHECK `([^`]+)`/gi, (_match, name: string) => `DROP CHECK \`${constraintName(name)}\``)
  return rewrittenConstraints.replaceAll('`sbl_', `\`${tablePrefix}`)
}

async function prepareMigrationsFolder(): Promise<{ folder: string; cleanup: () => Promise<void> }> {
  const sourceFolder = resolveMigrationsFolder()
  if (mysqlConfig.tablePrefix === 'sbl_') {
    return { folder: sourceFolder, cleanup: async () => undefined }
  }
  const folder = await mkdtemp(path.join(tmpdir(), 'cybernaut-migrations-'))
  await cp(sourceFolder, folder, { recursive: true })
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue
    const filePath = path.join(folder, entry.name)
    const source = await readFile(filePath, 'utf8')
    await writeFile(filePath, rewriteMigrationSqlForPrefix(source, mysqlConfig.tablePrefix), 'utf8')
  }
  return { folder, cleanup: async () => rm(folder, { recursive: true, force: true }) }
}

async function verifyMySqlRuntime(): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT VERSION() AS version, @@character_set_database AS charset, @@session.time_zone AS timeZone',
  )
  const runtime = rows[0]
  const major = Number.parseInt(String(runtime?.version ?? '').split('.')[0] ?? '', 10)
  if (!Number.isFinite(major) || major < 8) {
    throw new Error(`[mysql migration] MySQL 8.x or newer is required, received ${String(runtime?.version ?? 'unknown')}`)
  }
  if (String(runtime?.charset ?? '').toLowerCase() !== 'utf8mb4') {
    throw new Error(`[mysql migration] database charset must be utf8mb4, received ${String(runtime?.charset ?? 'unknown')}`)
  }
}

const REQUIRED_RUNTIME_TABLES = [
  'users', 'auth_sessions', 'auth_legacy_bearer_policy', 'projects', 'project_classification_history', 'project_members', 'project_score_jobs', 'project_files', 'project_file_versions',
  'project_stage_materials', 'project_plans', 'project_plan_actions',
  'project_duty_assignments', 'project_governance_changes',
  'fde_workflow_policies', 'fde_workflow_policy_versions',
  'fde_type_policy_reviews', 'fde_type_policy_commands', 'fde_type_policy_events',
  'fde_type_registration_commands',
  'fde_type_instances', 'fde_type_execution_reviews', 'fde_type_execution_files', 'fde_type_execution_commands', 'fde_type_execution_events',
  'fde_type_execution_notices',
  'responsibility_policies', 'responsibility_policy_versions', 'responsibility_policy_commands', 'responsibility_policy_events',
  'responsibility_records', 'responsibility_evidence', 'responsibility_events', 'responsibility_commands', 'responsibility_notices', 'responsibility_task_markers',
  'responsibility_scan_cycles', 'responsibility_scan_state',
  'project_agent_configs', 'project_agent_runs', 'project_agent_recommendations', 'project_agent_decisions', 'project_agent_commands',
  'project_agent_schedule_requests', 'project_stage_dates',
  'project_replan_policies', 'project_replan_requests',
  'project_timeline_tasks', 'project_timeline_syncs',
  'todo_feedbacks', 'todo_feedback_evidence', 'todo_acceptances',
  'project_weekly_plans', 'project_weekly_plan_items', 'project_weekly_plan_events', 'project_weekly_plan_notices',
  'personal_weekly_reports', 'personal_weekly_report_events', 'personal_weekly_report_recipients',
  'meeting_workflow_events', 'meeting_workflow_notices',
  'committee_meetings', 'committee_years', 'committee_agendas', 'committee_files', 'committee_commands',
  'project_directives', 'directive_events', 'directive_notices', 'leader_time_requests',
  'leader_time_events', 'leader_time_notices', 'personal_calendar_events', 'personal_calendar_history', 'todo_calendar_schedules', 'todo_calendar_schedule_history',
  'leader_time_batches',
  'project_records', 'project_record_comments', 'project_record_events',
  'project_file_grants', 'project_file_events', 'project_material_submissions',
  'project_material_recipients', 'project_material_events', 'project_material_notices', 'project_material_request_closures',
  'company_knowledge', 'company_knowledge_grants', 'company_knowledge_comments', 'company_knowledge_ratings', 'company_knowledge_events', 'company_knowledge_commands',
  'oa_office_policies', 'oa_office_policy_versions', 'oa_office_events', 'oa_office_commands', 'oa_office_policy_commands', 'oa_office_attachments', 'oa_office_attachment_grants', 'oa_office_notices',
  'oa_office_executions', 'oa_office_execution_files',
  'departments', 'roles', 'permissions', 'role_permissions', 'user_roles', 'user_departments', 'dictionary_groups', 'dictionary_items',
  'knowledge_chunks', 'chat_conversations', 'agent_conversations', 'agent_messages',
  'agent_message_parts', 'leads', 'lead_score_jobs', 'lead_pipeline_raw_events', 'lead_source_candidates',
  'lead_entities', 'lead_entity_relations', 'lead_enrichment_jobs', 'lead_enrichment_topic_runs', 'lead_facts', 'lead_source_documents',
  'lead_topic_search_cache', 'lead_fact_evidence', 'lead_fact_conflicts', 'lead_enrichment_snapshots', 'lead_rating_history',
  'lead_intake_files', 'lead_import_batches', 'lead_import_rows',
  'lead_pipeline_items', 'lead_pipeline_transitions', 'lead_pipeline_prompt_versions',
  'lead_pipeline_runs', 'lead_agent_runtime_permits', 'lead_pipeline_decisions', 'lead_pipeline_evidence',
  'lead_pipeline_reviews', 'lead_pipeline_entity_matches', 'meetings', 'todos', 'risks',
  'oa_approval_requests', 'oa_approval_nodes', 'oa_approval_records', 'oa_approval_revisions', 'oa_workflow_logs',
  'ai_tasks', 'ai_task_templates', 'ai_task_sources', 'ai_artifacts', 'ai_custom_templates',
  'ai_model_providers', 'ai_models', 'ai_model_routes',
  'ai_capabilities', 'ai_capability_bindings', 'ai_conversation_capabilities',
  'im_bots', 'im_bot_bindings', 'im_outbox', 'im_delivery_logs', 'im_inbound_messages',
  'im_lead_push_rules',
  'ai_template_analysis_progress', 'ai_summaries',
  'runtime_jobs', 'runtime_job_runs', 'radar_raw_events', 'radar_candidates',
  'radar_wechat_chat_messages', 'radar_webhook_receipts', 'radar_collector_states', 'radar_source_registry', 'radar_sync_state',
  'radar_dingtalk_settings',
  'identity_resolution_issues', 'audit_logs',
  'admin_configuration_revisions',
  'migration_entity_mappings', 'migration_cdc_checkpoints', 'migration_cdc_events',
] as const

export async function assertSchemaReady(): Promise<void> {
  await verifyMySqlRuntime()
  const journal = JSON.parse(await readFile(path.join(resolveMigrationsFolder(), 'meta', '_journal.json'), 'utf8')) as {
    entries?: Array<{ when?: number; tag?: string }>
  }
  const latest = journal.entries?.at(-1)
  if (!latest?.when) throw new Error('[mysql runtime] migration journal is empty')
  const migrationTable = mysqlTableName('__drizzle_migrations')
  const [migrationRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count, MAX(created_at) AS latest FROM \`${migrationTable}\``,
  )
  if (Number(migrationRows[0]?.latest || 0) < latest.when) {
    throw new Error(`[mysql runtime] schema migration ${latest.tag || latest.when} has not been applied`)
  }
  const requiredNames = REQUIRED_RUNTIME_TABLES.map(mysqlTableName)
  const [tableRows] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS tableName FROM information_schema.TABLES
     WHERE TABLE_SCHEMA=? AND TABLE_NAME IN (${requiredNames.map(() => '?').join(',')})`,
    [mysqlConfig.database, ...requiredNames],
  )
  const existing = new Set(tableRows.map((row) => String(row.tableName)))
  const missing = requiredNames.filter((name) => !existing.has(name))
  if (missing.length) throw new Error(`[mysql runtime] required tables are missing: ${missing.join(',')}`)
  console.log(`[mysql] schema verified read-only prefix=${mysqlConfig.tablePrefix} migration=${latest.tag}`)
}

export async function applySchemaMigrations(): Promise<void> {
  await verifyMySqlRuntime()
  const connection = await pool.getConnection()
  const lockName = `cybernaut-migrate-${createHash('sha256')
    .update(`${mysqlConfig.database}:${mysqlConfig.tablePrefix}`)
    .digest('hex')
    .slice(0, 32)}`
  let lockAcquired = false
  let prepared: Awaited<ReturnType<typeof prepareMigrationsFolder>> | null = null
  try {
    const [lockRows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 60) AS acquired', [lockName])
    lockAcquired = Number(lockRows[0]?.acquired || 0) === 1
    if (!lockAcquired) throw new Error('[mysql migration] timed out waiting for schema migration lock')
    prepared = await prepareMigrationsFolder()
    const migrationDb = drizzle({ client: connection })
    await migrate(migrationDb, {
      migrationsFolder: prepared.folder,
      migrationsTable: mysqlTableName('__drizzle_migrations'),
    })
  } finally {
    await prepared?.cleanup()
    if (lockAcquired) await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined)
    connection.release()
  }
  console.log(`[mysql] schema migrations ready prefix=${mysqlConfig.tablePrefix}`)
}

export async function ensureSchema(): Promise<void> {
  try {
    await assertSchemaReady()
    return
  } catch (readinessError) {
    try {
      await applySchemaMigrations()
    } catch (migrationError) {
      if (
        migrationError instanceof Error
        && /denied|privilege/i.test(migrationError.message)
      ) {
        throw new Error(
          '[mysql runtime] schema is not ready and DB_USERNAME has no DDL permission; run db:migrate with the separated migration credential first',
          { cause: readinessError },
        )
      }
      throw migrationError
    }
  }
}
