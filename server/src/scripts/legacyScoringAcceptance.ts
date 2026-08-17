import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'

type CountRow = RowDataPacket & { count: number }

function table(base: string): string {
  return quoteMysqlIdentifier(mysqlTableName(base))
}

function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[legacy-scoring-acceptance] ${message}`)
}

function scored(alias: string): string {
  return `${alias}.scoring IS NOT NULL AND (
    COALESCE(JSON_LENGTH(JSON_EXTRACT(${alias}.scoring,'$.dimensions')),0)>0
    OR JSON_EXTRACT(${alias}.scoring,'$.total') IS NOT NULL
  )`
}

async function count(sql: string): Promise<number> {
  const [rows] = await pool.query<CountRow[]>(sql)
  return Number(rows[0]?.count ?? 0)
}

async function main() {
  await ensureSchema()
  const [sourceRuns] = await pool.query<Array<RowDataPacket & { sourceSha256: string }>>(`
    SELECT source_sha256 AS sourceSha256 FROM ${table('migration_runs')}
    WHERE migration_type='postgres-dump-baseline-reconciliation' AND status='succeeded'
    ORDER BY completed_at DESC LIMIT 1
  `)
  const sourceRun = sourceRuns[0]
  requireCheck(sourceRun, 'successful locked PostgreSQL baseline reconciliation is required')

  const [classificationRuns] = await pool.query<Array<RowDataPacket & {
    id: string
    sourceCounts: Record<string, unknown> | string
    targetCounts: Record<string, unknown> | string
  }>>(`
    SELECT id,source_counts AS sourceCounts,target_counts AS targetCounts
    FROM ${table('migration_runs')}
    WHERE migration_type='legacy-scoring-classification' AND status='succeeded' AND source_sha256=?
    ORDER BY completed_at DESC LIMIT 1
  `, [sourceRun.sourceSha256])
  const classificationRun = classificationRuns[0]
  requireCheck(classificationRun, 'successful source-hash-bound legacy scoring classification is required')
  const parseCounts = (value: Record<string, unknown> | string): Record<string, number> => {
    const parsed = typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : value
    return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, Number(item)]))
  }
  const sourceCounts = parseCounts(classificationRun.sourceCounts)
  const targetCounts = parseCounts(classificationRun.targetCounts)
  requireCheck(sourceCounts.leads === targetCounts.leads && sourceCounts.projects === targetCounts.projects,
    'classification run source/target counts differ')

  const entities = ['leads', 'projects'] as const
  const summary: Record<string, { scored: number; legacy: number; agentRun: number }> = {}
  for (const entity of entities) {
    const alias = 'e'
    const scoreWhere = scored(alias)
    const entityIdPath = entity === 'leads' ? '$.leadId' : '$.projectId'
    const expectedType = entity === 'leads' ? 'lead' : 'project'
    const expectedRawType = entity === 'leads' ? 'lead-scoring-input' : 'project-scoring-input'
    const scoredRows = await count(`SELECT COUNT(*) count FROM ${table(entity)} ${alias} WHERE ${scoreWhere}`)
    const legacyRows = await count(`SELECT COUNT(*) count FROM ${table(entity)} ${alias}
      WHERE ${scoreWhere} AND JSON_UNQUOTE(JSON_EXTRACT(e.scoring,'$.provenance'))='legacy-import'`)
    const agentRows = await count(`SELECT COUNT(*) count FROM ${table(entity)} ${alias}
      WHERE ${scoreWhere} AND JSON_UNQUOTE(JSON_EXTRACT(e.scoring,'$.provenance'))='agent-run'`)
    const invalidProvenance = await count(`SELECT COUNT(*) count FROM ${table(entity)} ${alias}
      WHERE ${scoreWhere} AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.scoring,'$.provenance')),'')
        NOT IN ('legacy-import','agent-run')`)
    requireCheck(invalidProvenance === 0, `${entity} contains scored rows without explicit provenance`)
    requireCheck(scoredRows === legacyRows + agentRows, `${entity} provenance partition is incomplete`)

    const invalidLegacy = await count(`
      SELECT COUNT(*) count FROM ${table(entity)} e
      LEFT JOIN ${table('migration_runs')} mr
        ON BINARY mr.id=BINARY JSON_UNQUOTE(JSON_EXTRACT(e.scoring,'$._migration.runId'))
      WHERE ${scoreWhere}
        AND JSON_UNQUOTE(JSON_EXTRACT(e.scoring,'$.provenance'))='legacy-import'
        AND (
          JSON_UNQUOTE(JSON_EXTRACT(e.scoring,'$._migration.classification'))<>'legacy-import'
          OR JSON_EXTRACT(e.scoring,'$._migration.evidenceReconstructable')<>CAST('false' AS JSON)
          OR JSON_UNQUOTE(JSON_EXTRACT(e.scoring,'$._migration.sourceSystem'))<>'postgres_dump'
          OR JSON_UNQUOTE(JSON_EXTRACT(e.scoring,'$._migration.sourceSha256')) NOT REGEXP '^[0-9a-f]{64}$'
          OR JSON_UNQUOTE(JSON_EXTRACT(e.scoring,'$._migration.originalScoringChecksum')) NOT REGEXP '^[0-9a-f]{64}$'
          OR mr.id IS NULL OR mr.migration_type<>'legacy-scoring-classification' OR mr.status<>'succeeded'
          OR BINARY mr.source_sha256<>BINARY JSON_UNQUOTE(JSON_EXTRACT(e.scoring,'$._migration.sourceSha256'))
        )
    `)
    requireCheck(invalidLegacy === 0, `${entity} legacy-import rows lack immutable migration evidence`)

    const invalidAgent = await count(`
      SELECT COUNT(*) count FROM ${table(entity)} e
      LEFT JOIN ${table('lead_pipeline_runs')} r
        ON BINARY r.id=BINARY JSON_UNQUOTE(JSON_EXTRACT(e.scoring,'$.evidenceChain.runId'))
      LEFT JOIN ${table('lead_pipeline_decisions')} d
        ON BINARY d.id=BINARY JSON_UNQUOTE(JSON_EXTRACT(e.scoring,'$.evidenceChain.decisionId'))
      LEFT JOIN ${table('lead_pipeline_raw_events')} raw
        ON BINARY raw.id=BINARY JSON_UNQUOTE(JSON_EXTRACT(e.scoring,'$.evidenceChain.inputEventId'))
      WHERE ${scoreWhere}
        AND JSON_UNQUOTE(JSON_EXTRACT(e.scoring,'$.provenance'))='agent-run'
        AND (
          r.id IS NULL OR r.status<>'succeeded'
          OR d.id IS NULL OR BINARY d.run_id<>BINARY r.id OR BINARY d.event_id<>BINARY raw.id
          OR raw.id IS NULL OR raw.source_type<>'${expectedRawType}'
          OR BINARY JSON_UNQUOTE(JSON_EXTRACT(raw.payload,'${entityIdPath}'))<>BINARY e.id
          OR JSON_UNQUOTE(JSON_EXTRACT(r.metadata,'$.entityType'))<>'${expectedType}'
          OR BINARY JSON_UNQUOTE(JSON_EXTRACT(r.metadata,'${entityIdPath}'))<>BINARY e.id
          OR NOT EXISTS (
            SELECT 1 FROM ${table('lead_pipeline_evidence')} ev
            WHERE BINARY ev.decision_id=BINARY d.id AND BINARY ev.event_id=BINARY raw.id
              AND BINARY ev.source_id=BINARY raw.id AND ev.verification_status='verified'
          )
        )
    `)
    requireCheck(invalidAgent === 0, `${entity} agent-run rows lack a succeeded run/decision/input/evidence chain`)
    requireCheck(Number(sourceCounts[entity] ?? -1) >= legacyRows,
      `${entity} current legacy rows exceed the classified baseline`)
    summary[entity] = { scored: scoredRows, legacy: legacyRows, agentRun: agentRows }
  }

  const result = {
    ok: true,
    checks: [
      'all-historical-scores-explicitly-marked-legacy-import',
      'legacy-import-retains-source-hash-run-and-original-score-checksum',
      'agent-run-scores-bind-succeeded-run-decision-input-and-verified-evidence',
      'non-score-json-is-not-misclassified-as-a-score',
    ],
    classificationRunId: classificationRun.id,
    classifiedBaseline: sourceCounts,
    entities: summary,
  }
  console.log(JSON.stringify(result))
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
}).finally(() => pool.end())
