import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { createPendingSourceGapDisposition, stableDomainSha } from './sourceGapDispositionContract.js'
import { collectCurrentSourceGaps } from './sourceGapDispositionRuntime.js'

type Result = { code: number | null; stdout: string; stderr: string }

function table(name: string): string {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

async function run(script: string, file: string, args: string[] = []): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: process.cwd(), env: { ...process.env, SOURCE_GAP_DISPOSITIONS_FILE: file },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.once('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

async function ledgerCounts() {
  const [[runs], [issues]] = await Promise.all([
    pool.query<Array<RowDataPacket & { value: number }>>(`SELECT COUNT(*) value FROM ${table('migration_runs')}`),
    pool.query<Array<RowDataPacket & { value: number }>>(`SELECT COUNT(*) value FROM ${table('migration_issues')}`),
  ])
  return { runs: Number(runs[0]?.value || 0), issues: Number(issues[0]?.value || 0) }
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'source-gap-dispositions-'))
try {
  const file = path.join(directory, 'decisions.json')
  const before = await collectCurrentSourceGaps()
  const beforeLedger = await ledgerCounts()
  const pending = createPendingSourceGapDisposition(before)
  await writeFile(file, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 })

  const preview = await run('server/src/scripts/validateSourceGapDispositions.ts', file)
  assert.equal(preview.code, 0, preview.stderr)
  assert.match(preview.stdout, /"pendingDomains":2/)

  const strictPending = await run('server/src/scripts/validateSourceGapDispositions.ts', file, ['--strict'])
  assert.equal(strictPending.code, 2)
  assert.match(strictPending.stdout, /DISPOSITION_REQUIRED/)

  const approvedAt = new Date(Date.now() - 60_000).toISOString()
  const approved = structuredClone(pending)
  Object.assign(approved.leadReserve, {
    disposition: 'approved-permanent-quarantine',
    rationale: 'Acceptance fixture approves retaining exact missing-detail rows in permanent quarantine.',
    approvedBy: 'fixture-lead-data-owner', approvedAt,
  })
  Object.assign(approved.aiArtifacts, {
    disposition: 'approved-permanent-archive',
    rationale: 'Acceptance fixture approves retaining exact missing-byte artifacts as hidden permanent archives.',
    approvedBy: 'fixture-artifact-data-owner', approvedAt,
  })
  await writeFile(file, `${JSON.stringify(approved, null, 2)}\n`, { mode: 0o600 })
  const strictApproved = await run('server/src/scripts/validateSourceGapDispositions.ts', file, ['--strict'])
  assert.equal(strictApproved.code, 0, strictApproved.stderr)
  assert.match(strictApproved.stdout, /"approvedDomains":2/)

  const applyPreview = await run('server/src/scripts/applySourceGapDispositions.ts', file)
  assert.equal(applyPreview.code, 0, applyPreview.stderr)
  assert.match(applyPreview.stdout, /"planned":104/)
  assert.match(applyPreview.stdout, /"databaseWrites":0/)

  const probeRollback = await run('server/src/scripts/applySourceGapDispositions.ts', file, ['--probe-rollback'])
  assert.equal(probeRollback.code, 0, probeRollback.stderr)
  assert.match(probeRollback.stdout, /"transactionalRecordsWritten":106/)
  assert.match(probeRollback.stdout, /"probeRolledBack":true/)
  assert.match(probeRollback.stdout, /"databaseWrites":0/)
  assert.deepEqual(await ledgerCounts(), beforeLedger)

  const refreshApproved = await run('server/src/scripts/prepareSourceGapDispositions.ts', file, ['--refresh-pending'])
  assert.equal(refreshApproved.code, 1)
  assert.match(refreshApproved.stderr, /cannot be replaced/)

  const drifted = structuredClone(approved)
  drifted.leadReserve.records[0].fingerprintSha256 = '0'.repeat(64)
  await writeFile(file, `${JSON.stringify(drifted, null, 2)}\n`, { mode: 0o600 })
  const drift = await run('server/src/scripts/validateSourceGapDispositions.ts', file, ['--strict'])
  assert.equal(drift.code, 1)
  assert.match(drift.stdout, /FINGERPRINT_DRIFT/)

  const invalid = structuredClone(approved)
  invalid.aiArtifacts.disposition = 'ignore-because-tests-are-excluded'
  await writeFile(file, `${JSON.stringify(invalid, null, 2)}\n`, { mode: 0o600 })
  const invalidDisposition = await run('server/src/scripts/validateSourceGapDispositions.ts', file, ['--strict'])
  assert.equal(invalidDisposition.code, 1)
  assert.match(invalidDisposition.stdout, /AI_ARTIFACTS:DISPOSITION_REQUIRED/)

  const after = await collectCurrentSourceGaps()
  const afterLedger = await ledgerCounts()
  assert.deepEqual(afterLedger, beforeLedger)
  assert.equal(stableDomainSha(after.leadReserve), stableDomainSha(before.leadReserve))
  assert.equal(stableDomainSha(after.aiArtifacts), stableDomainSha(before.aiArtifacts))

  const evidenceDirectory = path.resolve('.runtime/migration-evidence/source-gap-dispositions')
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
  const report = {
    ok: true, capturedAt: new Date().toISOString(), checks: 9,
    leadReserveGaps: before.leadReserve.length, aiArtifactGaps: before.aiArtifacts.length,
    pendingStrictlyBlocked: true, exactApprovedFixtureAccepted: true,
    approvedDraftOverwriteRejected: true, fingerprintDriftRejected: true,
    testExclusionIsNotDisposition: true, databaseWrites: 0,
    applyPreviewNoWrite: true, transactionalApplyProbeRolledBack: true,
    identitiesAndFileNamesExcludedFromEvidence: true,
  }
  await writeFile(path.join(evidenceDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify(report))
} finally {
  await rm(directory, { recursive: true, force: true })
  await pool.end()
}
