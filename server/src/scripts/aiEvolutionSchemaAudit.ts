import type { RowDataPacket } from 'mysql2'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { pool } from '../db/client.js'
import { mysqlConfig, mysqlTableName } from '../db/config.js'

export type EvolutionSchemaAuditStatus = 'compatible' | 'repairable' | 'blocked'
export type EvolutionSchemaShape = Record<string, Record<string, string>>

const EXPECTED_EVOLUTION_SCHEMA: EvolutionSchemaShape = {
  ai_evolution_proposals: { id: 'varchar', owner_user_id: 'varchar', kind: 'varchar', spec: 'json', spec_hash: 'varchar', status: 'varchar', revision: 'int' },
  ai_evolution_runs: { id: 'varchar', proposal_id: 'varchar', input_hash: 'varchar', status: 'varchar', attempt: 'int', lease_token: 'int', budget: 'json', time_accounted_at: 'datetime' },
  ai_evolution_events: { id: 'varchar', run_id: 'varchar', sequence: 'int', payload: 'json' },
  ai_evolution_audits: { id: 'varchar', proposal_id: 'varchar', action: 'varchar', content_hash: 'varchar' },
  ai_evolution_model_calls: { id: 'varchar', run_id: 'varchar', call_key: 'varchar', lease_token: 'int', reserved_tokens: 'int' },
  ai_evolution_candidates: { id: 'varchar', run_id: 'varchar', content_hash: 'varchar', manifest: 'json', status: 'varchar' },
  ai_evolution_evaluations: { id: 'varchar', candidate_id: 'varchar', evaluation_hash: 'varchar', report: 'json' },
  ai_evolution_approvals: { id: 'varchar', candidate_id: 'varchar', candidate_hash: 'varchar', evaluation_hash: 'varchar', purpose: 'varchar', consumed_at: 'datetime' },
  ai_experiences: { id: 'varchar', owner_user_id: 'varchar', scope_type: 'varchar', active_version_id: 'varchar', status: 'varchar' },
  ai_experience_versions: { id: 'varchar', experience_id: 'varchar', proposal_id: 'varchar', spec: 'json', content_hash: 'varchar' },
  ai_evolution_applications: { id: 'varchar', owner_user_id: 'varchar', task_id: 'varchar', snapshot_hash: 'varchar', snapshot: 'json', check_execution: 'json' },
  ai_evolution_skill_versions: { id: 'varchar', capability_id: 'varchar', run_id: 'varchar', content_hash: 'varchar', content: 'json' },
  ai_evolution_skill_bindings: { id: 'varchar', capability_id: 'varchar', scope_type: 'varchar', active_version_id: 'varchar', revision: 'int' },
  ai_evolution_skill_binding_changes: { id: 'varchar', binding_id: 'varchar', operation: 'varchar', input_hash: 'varchar', revision: 'int' },
  ai_evolution_skill_applications: { id: 'varchar', owner_user_id: 'varchar', task_id: 'varchar', snapshot_hash: 'varchar', snapshot: 'json' },
  ai_evolution_release_jobs: { id: 'varchar', candidate_id: 'varchar', approval_id: 'varchar', status: 'varchar', operation: 'varchar', lease_token: 'int', source_release_job_id: 'varchar' },
  ai_evolution_feedback: { id: 'varchar', owner_user_id: 'varchar', feedback_type: 'varchar', comment: 'text', content_hash: 'varchar' },
}

function normalizedType(value: string) {
  return value.toLowerCase().replace(/\(.*/, '')
}

export function classifyAiEvolutionSchema(expected: EvolutionSchemaShape, actual: EvolutionSchemaShape) {
  const missingTables: string[] = []
  const missingColumns: Array<{ table: string; column: string; expectedType: string }> = []
  const incompatibleColumns: Array<{ table: string; column: string; expectedType: string; actualType: string }> = []
  for (const [table, columns] of Object.entries(expected)) {
    const actualColumns = actual[table]
    if (!actualColumns) {
      missingTables.push(table)
      continue
    }
    for (const [column, expectedType] of Object.entries(columns)) {
      const actualType = actualColumns[column]
      if (!actualType) missingColumns.push({ table, column, expectedType })
      else if (normalizedType(actualType) !== normalizedType(expectedType)) {
        incompatibleColumns.push({ table, column, expectedType, actualType })
      }
    }
  }
  const status: EvolutionSchemaAuditStatus = incompatibleColumns.length
    ? 'blocked'
    : missingTables.length || missingColumns.length ? 'repairable' : 'compatible'
  return { status, missingTables, missingColumns, incompatibleColumns }
}

export async function readAiEvolutionSchema(): Promise<EvolutionSchemaShape> {
  const expectedNames = Object.keys(EXPECTED_EVOLUTION_SCHEMA).map(mysqlTableName)
  const [rows] = await pool.query<Array<RowDataPacket & { tableName: string; columnName: string; dataType: string }>>(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, DATA_TYPE AS dataType
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=? AND TABLE_NAME IN (${expectedNames.map(() => '?').join(',')})
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [mysqlConfig.database, ...expectedNames],
  )
  const actual: EvolutionSchemaShape = {}
  for (const row of rows) {
    const logicalName = Object.keys(EXPECTED_EVOLUTION_SCHEMA)
      .find(name => mysqlTableName(name) === String(row.tableName))
    if (!logicalName) continue
    actual[logicalName] ??= {}
    actual[logicalName][String(row.columnName)] = String(row.dataType)
  }
  return actual
}

async function main() {
  const actual = await readAiEvolutionSchema()
  const result = classifyAiEvolutionSchema(EXPECTED_EVOLUTION_SCHEMA, actual)
  console.log(JSON.stringify({
    ok: result.status !== 'blocked',
    mode: 'read-only',
    database: mysqlConfig.database,
    tablePrefix: mysqlConfig.tablePrefix,
    ...result,
  }, null, 2))
  if (result.status === 'blocked') process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().finally(() => pool.end())
}
