import { createHash } from 'node:crypto'

export const POSTGRES_CDC_CAPTURE_VERSION = 'postgres-trigger-v1'

export const POSTGRES_CDC_TABLES = [
  'users',
  'projects',
  'project_files',
  'meetings',
  'todos',
  'risks',
  'ai_summaries',
  'leads',
  'audit_logs',
  'chat_conversations',
  'file_chunks',
  'knowledge_chunks',
  'ai_tasks',
  'ai_artifacts',
  'ai_task_sources',
  'ai_custom_templates',
  'radar_sync_state',
] as const

export type PostgresCdcTable = typeof POSTGRES_CDC_TABLES[number]
export type PostgresCdcOperation = 'I' | 'U' | 'D'

export type PostgresCdcEvent = {
  sequence: string
  txid: string
  table: PostgresCdcTable
  operation: PostgresCdcOperation
  entityId: string
  rowData: Record<string, unknown> | null
  tombstone: Record<string, unknown> | null
  occurredAt: string
  actor: string
  migrationBatch: string
  cascadeDelete: boolean
}

export function assertSafePostgresName(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`unsafe ${label}: ${value}`)
}

export function quotePostgresName(value: string): string {
  assertSafePostgresName(value, 'PostgreSQL identifier')
  return `"${value}"`
}

export function postgresCdcContractSha256(schema: string): string {
  return createHash('sha256').update(JSON.stringify({
    captureVersion: POSTGRES_CDC_CAPTURE_VERSION,
    schema,
    tables: POSTGRES_CDC_TABLES,
    safeHorizon: 'txid < txid_snapshot_xmin(txid_current_snapshot())',
  })).digest('hex')
}

export function postgresCdcBaseSql(schema: string): string[] {
  assertSafePostgresName(schema, 'CDC schema')
  const qualifiedSchema = quotePostgresName(schema)
  return [
    `CREATE SCHEMA IF NOT EXISTS ${qualifiedSchema}`,
    `CREATE TABLE IF NOT EXISTS ${qualifiedSchema}.change_log (
      sequence bigserial PRIMARY KEY,
      txid bigint NOT NULL DEFAULT txid_current(),
      table_name text NOT NULL,
      operation character(1) NOT NULL CHECK (operation IN ('I','U','D')),
      entity_id text NOT NULL,
      row_data jsonb,
      tombstone jsonb,
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      actor text NOT NULL,
      migration_batch text NOT NULL,
      cascade_delete boolean NOT NULL DEFAULT false
    )`,
    `CREATE INDEX IF NOT EXISTS change_log_txid_sequence_idx ON ${qualifiedSchema}.change_log (txid, sequence)`,
    `CREATE INDEX IF NOT EXISTS change_log_entity_sequence_idx ON ${qualifiedSchema}.change_log (table_name, entity_id, sequence)`,
    `CREATE TABLE IF NOT EXISTS ${qualifiedSchema}.capture_config (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      capture_version text NOT NULL,
      contract_sha256 character(64) NOT NULL,
      installed_tables jsonb NOT NULL,
      installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`,
    `CREATE OR REPLACE FUNCTION ${qualifiedSchema}.capture_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
    AS $function$
    DECLARE
      changed_row jsonb;
      deleted_row jsonb;
      changed_id text;
      configured_actor text;
      configured_batch text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        changed_row := NULL;
        deleted_row := to_jsonb(OLD);
        changed_id := OLD.id::text;
      ELSE
        changed_row := to_jsonb(NEW);
        deleted_row := NULL;
        changed_id := NEW.id::text;
      END IF;
      configured_actor := NULLIF(current_setting('sbl.migration_actor', true), '');
      configured_batch := NULLIF(current_setting('sbl.migration_batch', true), '');
      INSERT INTO ${qualifiedSchema}.change_log
        (txid,table_name,operation,entity_id,row_data,tombstone,occurred_at,actor,migration_batch,cascade_delete)
      VALUES
        (txid_current(),TG_TABLE_NAME,substring(TG_OP,1,1),changed_id,changed_row,deleted_row,
         clock_timestamp(),COALESCE(configured_actor,session_user),COALESCE(configured_batch,txid_current()::text),
         TG_OP='DELETE' AND pg_trigger_depth() > 1);
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END
    $function$`,
  ]
}

export function postgresCdcTriggerSql(schema: string, table: PostgresCdcTable): string[] {
  assertSafePostgresName(schema, 'CDC schema')
  assertSafePostgresName(table, 'CDC table')
  const trigger = quotePostgresName('sbl_migration_capture_change')
  const qualifiedTable = `${quotePostgresName('public')}.${quotePostgresName(table)}`
  return [
    `DROP TRIGGER IF EXISTS ${trigger} ON ${qualifiedTable}`,
    `CREATE TRIGGER ${trigger} AFTER INSERT OR UPDATE OR DELETE ON ${qualifiedTable}
      FOR EACH ROW EXECUTE FUNCTION ${quotePostgresName(schema)}.capture_change()`,
  ]
}

export function normalizePostgresCdcEvent(row: Record<string, unknown>): PostgresCdcEvent {
  const table = String(row.table ?? row.table_name ?? '')
  if (!POSTGRES_CDC_TABLES.includes(table as PostgresCdcTable)) {
    throw new Error(`CDC event table is not allowlisted: ${table}`)
  }
  const operation = String(row.operation ?? '')
  if (!['I', 'U', 'D'].includes(operation)) throw new Error(`invalid CDC operation: ${operation}`)
  const sequence = String(row.sequence ?? '')
  const txid = String(row.txid ?? '')
  const entityId = String(row.entityId ?? row.entity_id ?? '')
  if (!/^\d+$/.test(sequence) || !/^\d+$/.test(txid) || !entityId) {
    throw new Error('CDC event sequence, txid and entity id are required')
  }
  const occurredAtValue = row.occurredAt ?? row.occurred_at
  const occurredAt = occurredAtValue instanceof Date
    ? occurredAtValue.toISOString()
    : new Date(String(occurredAtValue ?? '')).toISOString()
  return {
    sequence,
    txid,
    table: table as PostgresCdcTable,
    operation: operation as PostgresCdcOperation,
    entityId,
    rowData: (row.rowData ?? row.row_data ?? null) as Record<string, unknown> | null,
    tombstone: (row.tombstone ?? null) as Record<string, unknown> | null,
    occurredAt,
    actor: String(row.actor ?? ''),
    migrationBatch: String(row.migrationBatch ?? row.migration_batch ?? ''),
    cascadeDelete: Boolean(row.cascadeDelete ?? row.cascade_delete),
  }
}
