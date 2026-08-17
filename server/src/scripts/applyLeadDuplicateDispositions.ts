import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  validateLeadDuplicateDispositions, type LeadDuplicateDispositionFile,
} from './leadDuplicateDispositionContract.js'
import {
  applyApprovedLeadDuplicateDispositions, buildLeadDuplicateApplyPlan,
  verifyAppliedLeadDuplicateDisposition,
} from './leadDuplicateDispositionApplyRuntime.js'
import { loadCurrentLeadDuplicateDispositionContext } from './leadDuplicateDispositionRuntime.js'

const decisionPath = path.resolve(process.env.LEAD_DUPLICATE_DECISION_FILE
  || '.runtime/migration-decisions/lead-duplicate-dispositions.json')
const evidenceDirectory = path.resolve('.runtime/migration-evidence/lead-duplicate-dispositions')
const apply = process.argv.includes('--apply')
const probeRollback = process.argv.includes('--probe-rollback')

function table(name: string) {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

async function readDecisionFile() {
  const stat = await lstat(decisionPath)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('LEAD_DUPLICATE_DECISION_FILE_MUST_BE_OWNER_ONLY_REGULAR_FILE')
  }
  const source = await readFile(decisionPath, 'utf8')
  return {
    file: JSON.parse(source) as LeadDuplicateDispositionFile,
    sha256: createHash('sha256').update(source).digest('hex'),
  }
}

async function writeEvidence(report: Record<string, unknown>) {
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
  await writeFile(path.join(evidenceDirectory, 'apply-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}

async function main() {
  if (apply && probeRollback) throw new Error('LEAD_DUPLICATE_APPLY_AND_PROBE_ARE_MUTUALLY_EXCLUSIVE')
  const decision = await readDecisionFile()
  const connection = await pool.getConnection()
  try {
    const applied = await verifyAppliedLeadDuplicateDisposition({
      connection, file: decision.file, decisionFileSha256: decision.sha256,
    })
    if (applied) {
      const report = { schemaVersion: '1.0', generatedAt: new Date().toISOString(), ok: true,
        mode: 'already-applied', ...applied, databaseWrites: 0 }
      await writeEvidence(report)
      console.log(JSON.stringify(report))
      return
    }
    const [conflictingRuns] = await connection.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) count FROM ${table('migration_runs')}
       WHERE migration_type='lead-duplicate-disposition' AND source_locator=? AND status='succeeded' AND source_sha256<>?`,
      [`decision-set:${decision.file.decisionSetId}`, decision.sha256],
    )
    if (Number(conflictingRuns[0]?.count || 0) > 0) throw new Error('LEAD_DUPLICATE_DECISION_SET_ALREADY_APPLIED_WITH_DIFFERENT_HASH')

    const context = await loadCurrentLeadDuplicateDispositionContext()
    const validation = validateLeadDuplicateDispositions({ file: decision.file, expected: context.expected, strict: true })
    if (!validation.ready) {
      const report = { schemaVersion: '1.0', generatedAt: new Date().toISOString(), ok: false,
        mode: apply ? 'apply-blocked' : probeRollback ? 'probe-blocked' : 'preview-blocked',
        collisionGroups: validation.collisionGroups, pendingGroups: validation.pendingGroups,
        errors: validation.errors, databaseWrites: 0 }
      await writeEvidence(report)
      console.log(JSON.stringify(report))
      process.exitCode = validation.errors.some((error) => error !== 'PENDING_DECISIONS') ? 3 : 2
      return
    }
    const plan = buildLeadDuplicateApplyPlan(decision.file)
    if (!apply && !probeRollback) {
      const report = { schemaVersion: '1.0', generatedAt: new Date().toISOString(), ok: true,
        mode: 'preview', collisionGroups: decision.file.groups.length,
        mergeGroups: plan.actionCounts.merge, keepSeparateGroups: plan.actionCounts['keep-separate'],
        exceptionGroups: plan.actionCounts.exception, mergedLeadRecords: plan.mergeTargets.size,
        databaseWrites: 0 }
      await writeEvidence(report)
      console.log(JSON.stringify(report))
      return
    }
    await connection.beginTransaction()
    try {
      const result = await applyApprovedLeadDuplicateDispositions({
        connection, file: decision.file, decisionFileSha256: decision.sha256,
      })
      if (probeRollback) await connection.rollback()
      else await connection.commit()
      const report = { schemaVersion: '1.0', generatedAt: new Date().toISOString(), ok: true,
        mode: probeRollback ? 'transaction-probe-rolled-back' : 'apply', ...result,
        databaseWrites: probeRollback ? 0 : decision.file.groups.length + plan.mergeTargets.size + 2 }
      await writeEvidence(report)
      console.log(JSON.stringify(report))
    } catch (error) {
      await connection.rollback().catch(() => undefined)
      throw error
    }
  } finally {
    connection.release()
  }
}

await main().finally(async () => pool.end())
