import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'

const execFileAsync = promisify(execFile)
const checksumPattern = /^[a-f0-9]{64}$/
const outputDir = path.resolve('.runtime/migration-evidence/business-invariants')
const reconciliationReportPath = path.resolve('.runtime/migration-evidence/mysql-reconciliation/report.json')
const dumpPath = path.resolve(process.env.PG_DUMP_PATH?.trim() || 'cybernaut_mvp_dump.sql')

type TargetTable = { table: string; rows: number; keyColumns: string[]; keySha256: string }
type ForeignKey = { constraint: string; table: string; orphanRows: number }
type Invariant = { id: string; domain: string; blocking: boolean; violations: number }
type ReconciliationReport = {
  generatedAt: string
  readiness: { targetStructuralIntegrityReady: boolean }
  target: {
    tables: TargetTable[]
    totalRows: number
    foreignKeys: ForeignKey[]
    foreignKeyOrphans: number
    invariants: Invariant[]
  }
}

function table(base: string): string {
  return quoteMysqlIdentifier(mysqlTableName(base))
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${label} must be a JSON object`)
  return parsed as Record<string, unknown>
}

async function refreshTargetReconciliation(): Promise<void> {
  const result = await execFileAsync(process.execPath, [
    '--env-file-if-exists=.env',
    '--import', 'tsx',
    'server/src/scripts/mysqlMigrationReconciliationAudit.ts',
    '--strict-target',
  ], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 })
  const line = result.stdout.trim().split('\n').at(-1)
  assert(line, 'target reconciliation did not return a result')
  const summary = JSON.parse(line) as { ok?: unknown }
  assert.equal(summary.ok, true, 'target reconciliation must pass before invariant acceptance')
}

async function violationCount(sql: string): Promise<number> {
  const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(sql)
  return Number(rows[0]?.count ?? 0)
}

async function writeEvidence(payload: Record<string, unknown>): Promise<void> {
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  await chmod(outputDir, 0o700)
  const target = path.resolve(outputDir, 'report.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  await chmod(target, 0o600)
}

async function main(): Promise<void> {
  await refreshTargetReconciliation()
  await ensureSchema()
  const reconciliation = JSON.parse(await readFile(reconciliationReportPath, 'utf8')) as ReconciliationReport
  assert.equal(reconciliation.readiness.targetStructuralIntegrityReady, true)
  assert.equal(reconciliation.target.tables.length, 82, 'target table checksum coverage changed')
  assert(reconciliation.target.tables.every((item) =>
    item.keyColumns.length > 0 && checksumPattern.test(item.keySha256)),
  'every target table must have a normalized key checksum')
  assert.equal(reconciliation.target.foreignKeys.length, 133, 'foreign-key inventory changed')
  assert.equal(reconciliation.target.foreignKeyOrphans, 0, 'target contains orphan foreign keys')
  assert(reconciliation.target.foreignKeys.every((item) => item.orphanRows === 0), 'a foreign key contains orphan rows')

  const sourceAssetInvariantIds = new Set([
    'lead-reserve-missing-detail',
    'project-file-original-missing',
    'ai-artifact-source-file-missing',
  ])
  const targetBusinessInvariants = reconciliation.target.invariants
    .filter((item) => !sourceAssetInvariantIds.has(item.id))
  assert(targetBusinessInvariants.length > 0, 'target business invariant inventory is empty')
  assert(targetBusinessInvariants.every((item) => item.violations === 0),
    'target state or cross-table business invariant failed')
  const sourceAssetGaps = Object.fromEntries(reconciliation.target.invariants
    .filter((item) => sourceAssetInvariantIds.has(item.id))
    .map((item) => [item.id, item.violations]))

  const dumpBytes = await readFile(dumpPath)
  const sourceSha256 = createHash('sha256').update(dumpBytes).digest('hex')
  const [runRows] = await pool.query<Array<RowDataPacket & {
    id: string
    sourceChecksum: string
    targetChecksum: string
    report: unknown
  }>>(`
    SELECT id,source_checksum AS sourceChecksum,target_checksum AS targetChecksum,report
    FROM ${table('migration_runs')}
    WHERE migration_type='postgres-dump-baseline-reconciliation'
      AND source_sha256=? AND status='succeeded'
    ORDER BY completed_at DESC LIMIT 1
  `, [sourceSha256])
  assert.equal(runRows.length, 1, 'successful checksum-bound dump reconciliation is missing')
  assert(checksumPattern.test(String(runRows[0].sourceChecksum)), 'dump source checksum is invalid')
  assert(checksumPattern.test(String(runRows[0].targetChecksum)), 'dump target checksum is invalid')
  const runReport = jsonObject(runRows[0].report, 'dump reconciliation report')
  const dumpTables = Array.isArray(runReport.tables) ? runReport.tables as Array<Record<string, unknown>> : []
  assert.equal(dumpTables.length, 16, 'dump per-table checksum coverage changed')
  for (const item of dumpTables) {
    assert(checksumPattern.test(String(item.sourceHash)), `invalid source hash for ${String(item.table)}`)
    assert(checksumPattern.test(String(item.targetHash)), `invalid target hash for ${String(item.table)}`)
    assert(['verified', 'verified-preserved'].includes(String(item.status)),
      `dump table ${String(item.table)} is not verified`)
  }

  const stateQueries: Record<string, string> = {
    'pipeline-latest-transition-matches-item': `
      WITH ranked AS (
        SELECT event_id,to_status,
          ROW_NUMBER() OVER(PARTITION BY event_id ORDER BY created_at DESC,id DESC) rn
        FROM ${table('lead_pipeline_transitions')}
      )
      SELECT COUNT(*) count FROM ${table('lead_pipeline_items')} i
      LEFT JOIN ranked r ON r.event_id=i.event_id AND r.rn=1
      WHERE r.event_id IS NULL OR r.to_status<>i.status`,
    'pipeline-transition-has-item': `
      SELECT COUNT(*) count FROM ${table('lead_pipeline_transitions')} t
      LEFT JOIN ${table('lead_pipeline_items')} i ON i.event_id=t.event_id
      WHERE i.event_id IS NULL`,
    'lead-score-running-has-lease': `
      SELECT COUNT(*) count FROM ${table('lead_score_jobs')}
      WHERE status='running' AND (lease_owner IS NULL OR lease_expires_at IS NULL)`,
    'lead-score-terminal-has-timestamp': `
      SELECT COUNT(*) count FROM ${table('lead_score_jobs')}
      WHERE (status='done' AND completed_at IS NULL)
         OR (status='dead_letter' AND dead_lettered_at IS NULL)`,
    'project-score-running-has-lease': `
      SELECT COUNT(*) count FROM ${table('project_score_jobs')}
      WHERE status='running' AND (lease_owner IS NULL OR lease_expires_at IS NULL)`,
    'project-score-terminal-has-timestamp': `
      SELECT COUNT(*) count FROM ${table('project_score_jobs')}
      WHERE (status='done' AND completed_at IS NULL)
         OR (status='dead_letter' AND dead_lettered_at IS NULL)`,
    'ai-task-running-has-lease': `
      SELECT COUNT(*) count FROM ${table('ai_tasks')}
      WHERE status='running' AND (lease_owner IS NULL OR lease_expires_at IS NULL)`,
    'ai-task-terminal-has-completion': `
      SELECT COUNT(*) count FROM ${table('ai_tasks')}
      WHERE status IN ('succeeded','failed','cancelled') AND completed_at IS NULL`,
    'runtime-run-terminal-has-finish': `
      SELECT COUNT(*) count FROM ${table('runtime_job_runs')}
      WHERE status<>'running' AND finished_at IS NULL`,
    'pipeline-run-terminal-has-finish': `
      SELECT COUNT(*) count FROM ${table('lead_pipeline_runs')}
      WHERE status IN ('succeeded','failed','cancelled') AND finished_at IS NULL`,
    'pipeline-review-resolution-coherent': `
      SELECT COUNT(*) count FROM ${table('lead_pipeline_reviews')}
      WHERE (status='pending' AND (resolution_decision_id IS NOT NULL OR resolved_at IS NOT NULL))
         OR (status='resolved' AND (resolution_decision_id IS NULL OR reviewer_user_id IS NULL OR resolved_at IS NULL))`,
    'pipeline-entity-match-resolution-coherent': `
      SELECT COUNT(*) count FROM ${table('lead_pipeline_entity_matches')}
      WHERE (status IN ('candidate','ambiguous') AND (resolution_type<>'pending' OR resolved_at IS NOT NULL))
         OR (status IN ('selected','created','rejected') AND (resolution_type='pending' OR resolved_at IS NULL))`,
    'oa-active-key-and-completion-coherent': `
      SELECT COUNT(*) count FROM ${table('oa_approval_requests')}
      WHERE (status='审批中' AND (active_key IS NULL OR active_key<>project_id OR completed_at IS NOT NULL))
         OR (status<>'审批中' AND (active_key IS NOT NULL OR completed_at IS NULL))`,
    'chat-conversation-has-agent-index': `
      SELECT COUNT(*) count FROM ${table('chat_conversations')} c
      LEFT JOIN ${table('agent_conversations')} a ON a.id=c.id
      WHERE a.id IS NULL`,
    'chat-agent-user-binding-coherent': `
      SELECT COUNT(*) count FROM ${table('chat_conversations')} c
      JOIN ${table('agent_conversations')} a ON a.id=c.id
      WHERE a.user_id<>c.user_id`,
    'chat-agent-project-binding-coherent': `
      SELECT COUNT(*) count FROM ${table('chat_conversations')} c
      JOIN ${table('agent_conversations')} a ON a.id=c.id
      WHERE NOT (a.project_id<=>c.project_id)`,
    'chat-agent-scope-coherent': `
      SELECT COUNT(*) count FROM ${table('chat_conversations')} c
      JOIN ${table('agent_conversations')} a ON a.id=c.id
      WHERE a.scope<>c.scope
         OR (c.scope='global' AND c.project_id IS NOT NULL)
         OR (c.scope='project' AND c.project_id IS NULL)`,
    'chat-agent-external-session-coherent': `
      SELECT COUNT(*) count FROM ${table('chat_conversations')} c
      JOIN ${table('agent_conversations')} a ON a.id=c.id
      WHERE a.external_session_id<>c.agent_id`,
    'project-conversation-has-stable-project-access': `
      SELECT COUNT(*) count FROM ${table('chat_conversations')} c
      LEFT JOIN ${table('projects')} p ON p.id=c.project_id
      LEFT JOIN ${table('project_members')} pm ON pm.project_id=c.project_id AND pm.user_id=c.user_id
      WHERE c.scope='project'
        AND (p.id IS NULL OR NOT (p.created_by<=>c.user_id OR p.owner_user_id<=>c.user_id OR pm.user_id IS NOT NULL))`,
  }
  const stateMachineViolations: Record<string, number> = {}
  for (const [name, sql] of Object.entries(stateQueries)) {
    stateMachineViolations[name] = await violationCount(sql)
  }
  let conversationViolationShape: Array<Record<string, unknown>> = []
  if (
    stateMachineViolations['chat-agent-scope-coherent']
    || stateMachineViolations['project-conversation-has-stable-project-access']
  ) {
    const [rows] = await pool.query<Array<RowDataPacket & Record<string, unknown>>>(`
      SELECT c.scope AS chatScope,c.project_id IS NULL AS chatProjectNull,
        a.scope AS agentScope,a.project_id IS NULL AS agentProjectNull,
        a.legacy_source AS legacySource,
        (SELECT COUNT(*) FROM ${table('agent_messages')} m WHERE m.conversation_id=c.id) AS messageCount,
        (SELECT COUNT(*) FROM ${table('ai_tasks')} t WHERE t.conversation_id=c.id) AS taskCount
      FROM ${table('chat_conversations')} c
      JOIN ${table('agent_conversations')} a ON a.id=c.id
      LEFT JOIN ${table('projects')} p ON p.id=c.project_id
      LEFT JOIN ${table('project_members')} pm ON pm.project_id=c.project_id AND pm.user_id=c.user_id
      WHERE a.scope<>c.scope
         OR (c.scope='global' AND c.project_id IS NOT NULL)
         OR (c.scope='project' AND c.project_id IS NULL)
         OR (c.scope='project' AND (p.id IS NULL OR NOT (p.created_by<=>c.user_id OR p.owner_user_id<=>c.user_id OR pm.user_id IS NOT NULL)))
    `)
    conversationViolationShape = rows.map((row) => ({
      chatScope: row.chatScope,
      chatProjectNull: Boolean(row.chatProjectNull),
      agentScope: row.agentScope,
      agentProjectNull: Boolean(row.agentProjectNull),
      legacySource: row.legacySource,
      messageCount: Number(row.messageCount),
      taskCount: Number(row.taskCount),
    }))
  }
  assert(Object.values(stateMachineViolations).every((count) => count === 0),
    `one or more state-machine invariants failed: ${JSON.stringify({ stateMachineViolations, conversationViolationShape })}`)

  const output = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    ok: true,
    dump: {
      sourceSha256,
      runId: runRows[0].id,
      tables: dumpTables.length,
      sourceChecksum: runRows[0].sourceChecksum,
      targetChecksum: runRows[0].targetChecksum,
    },
    target: {
      tables: reconciliation.target.tables.length,
      totalRows: reconciliation.target.totalRows,
      normalizedKeyChecksums: reconciliation.target.tables.length,
      foreignKeys: reconciliation.target.foreignKeys.length,
      foreignKeyOrphans: reconciliation.target.foreignKeyOrphans,
      businessInvariants: targetBusinessInvariants.length,
      stateMachineInvariants: Object.keys(stateMachineViolations).length,
    },
    sourceAssetGaps,
    stateMachineViolations,
    checks: [
      'checksum-bound-dump-has-normalized-source-and-target-hash-per-table',
      'all-target-tables-have-normalized-key-checksums',
      'all-mysql-foreign-keys-have-zero-orphans',
      'target-cross-table-business-invariants-exclude-only-explicit-source-asset-gaps',
      'lead-project-ai-runtime-oa-state-machines-are-coherent',
      'chat-and-agent-conversation-indexes-have-stable-user-project-and-scope-bindings',
      'project-conversations-have-stable-project-access-without-later-owner-rewrite',
    ],
  }
  await writeEvidence(output)
  console.log(JSON.stringify(output))
}

await main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => pool.end())
