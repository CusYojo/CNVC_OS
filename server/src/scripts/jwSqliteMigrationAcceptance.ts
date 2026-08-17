import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'

const execFileAsync = promisify(execFile)
const expectedSha256 = 'f7b4df01f3e04481860cd4d7d1c94a3ac18ec1bba5dfbecbb4541494fbbe8163'

function table(base: string): string {
  return quoteMysqlIdentifier(mysqlTableName(base))
}

async function sentinel(): Promise<Record<string, number>> {
  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT
      (SELECT COUNT(*) FROM ${table('agent_conversations')}) AS conversations,
      (SELECT COUNT(*) FROM ${table('agent_messages')}) AS messages,
      (SELECT COUNT(*) FROM ${table('agent_conversation_source_mappings')}) AS conversationMappings,
      (SELECT COUNT(*) FROM ${table('agent_message_source_mappings')}) AS messageMappings
  `)
  return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)]))
}

async function runMigration(apply: boolean): Promise<Record<string, unknown>> {
  const result = await execFileAsync(process.execPath, [
    '--env-file-if-exists=.env', '--import', 'tsx',
    'server/src/scripts/migrateJwSqliteToMySql.ts',
    ...(apply ? ['--apply'] : []),
  ], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 })
  const line = result.stdout.trim().split('\n').at(-1)
  assert(line, 'JW SQLite migration did not return a report')
  return JSON.parse(line) as Record<string, unknown>
}

async function runStrictExclusionAudit(): Promise<Record<string, unknown>> {
  const result = await execFileAsync(process.execPath, [
    '--env-file-if-exists=.env', '--import', 'tsx',
    'server/src/scripts/aipinExclusionAudit.ts', '--strict',
  ], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 })
  const line = result.stdout.trim().split('\n').at(-1)
  assert(line, 'strict excluded-source audit did not return a report')
  return JSON.parse(line) as Record<string, unknown>
}

await ensureSchema()
const before = await sentinel()
const preview = await runMigration(false)
const firstApply = await runMigration(true)
const secondApply = await runMigration(true)
const after = await sentinel()
const exclusionAudit = await runStrictExclusionAudit()

assert.equal(preview.ok, true, 'checksum-bound JW preview must pass')
assert.equal(preview.mode, 'preview')
assert.equal(preview.sourceSha256, expectedSha256)
assert.equal((preview.sourceCounts as Record<string, unknown>).approvedConversations, 0)
assert.equal((preview.sourceCounts as Record<string, unknown>).approvedMessages, 0)
assert.equal((preview.sourceCounts as Record<string, unknown>).rejectedConversations, 37)
assert.equal((preview.sourceCounts as Record<string, unknown>).rejectedMessages, 2168)
assert.equal(firstApply.ok, true)
assert.equal(firstApply.applied, true)
assert.equal(secondApply.ok, true)
assert.equal(secondApply.idempotent, true)
assert.deepEqual(after, before, 'JW SQLite acceptance changed Agent business rows')
assert.equal(exclusionAudit.ok, true, 'strict excluded-source audit failed')

const [runRows] = await pool.query<RowDataPacket[]>(`
  SELECT
    COUNT(*) AS runs,
    (SELECT COUNT(*) FROM ${table('migration_issues')} i
      JOIN ${table('migration_runs')} r2 ON r2.id=i.run_id
      WHERE r2.migration_type='jw-sqlite-to-mysql' AND r2.source_sha256=?
        AND i.code='JW_REJECTED_SOURCE_EXCLUDED') AS exclusionIssues
  FROM ${table('migration_runs')} r
  WHERE r.migration_type='jw-sqlite-to-mysql' AND r.source_sha256=? AND r.status='succeeded'
`, [expectedSha256, expectedSha256])
assert.equal(Number(runRows[0]?.runs), 1, 'JW SQLite apply must keep one idempotent successful run')
assert.equal(Number(runRows[0]?.exclusionIssues), 1, 'JW SQLite apply must retain one aggregate exclusion issue')

console.log(JSON.stringify({
  ok: true,
  checksumBoundSource: true,
  approvedProjection: { conversations: 0, messages: 0 },
  rejectedSource: { conversations: 37, messages: 2168 },
  targetBusinessRowsChanged: 0,
  successfulRuns: 1,
  aggregateExclusionIssues: 1,
  repeatedApplyIdempotent: true,
  strictExcludedSourceAudit: true,
}))

await pool.end()
