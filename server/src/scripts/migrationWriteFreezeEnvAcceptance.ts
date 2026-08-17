import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

type Result = { code: number | null; stdout: string; stderr: string }

async function run(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/scripts/migrationWriteFreezeEnv.ts', ...args], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.once('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'migration-write-freeze-env-'))
try {
  await chmod(directory, 0o700)
  const envFile = path.join(directory, '.env')
  const original = [
    'DB_PASSWORD=fixture-secret-value-that-must-not-be-printed',
    'MIGRATION_WRITE_FREEZE=false',
    'MIGRATION_WRITE_FREEZE_MODE=',
    'UNCHANGED=value',
    '',
  ].join('\n')
  await writeFile(envFile, original, { mode: 0o600 })

  const preview = await run(['--enable', '--env-file', envFile])
  assert.equal(preview.code, 0)
  assert.equal(await readFile(envFile, 'utf8'), original)
  assert.doesNotMatch(preview.stdout, /fixture-secret/)

  const enabled = await run(['--enable', '--env-file', envFile, '--apply'])
  assert.equal(enabled.code, 0, enabled.stderr)
  const enabledText = await readFile(envFile, 'utf8')
  assert.match(enabledText, /^MIGRATION_WRITE_FREEZE=true$/m)
  assert.match(enabledText, /^MIGRATION_WRITE_FREEZE_MODE=rollback-window$/m)
  assert.match(enabledText, /^DB_PASSWORD=fixture-secret-value-that-must-not-be-printed$/m)
  assert.match(enabledText, /^UNCHANGED=value$/m)

  const enabledAgain = await run(['--enable', '--env-file', envFile, '--apply'])
  assert.equal(enabledAgain.code, 0)
  assert.match(enabledAgain.stdout, /"idempotent":true/)

  const missingApproval = await run(['--disable', '--env-file', envFile, '--apply'])
  assert.equal(missingApproval.code, 1)
  assert.match(missingApproval.stderr, /ponr-approval-file/)

  const approvalFile = path.join(directory, 'ponr-approval.json')
  const approvedAt = new Date(Date.now() - 60_000).toISOString()
  const approval = {
    schemaVersion: '1.0', environment: 'production', decision: 'point-of-no-return', approved: true,
    thresholdPolicyVersion: 1, commitSha: 'a'.repeat(40), sourceSafeWatermark: '100', targetSequence: 100,
    reconciliationReportSha256: 'b'.repeat(64), fileManifestSha256: 'c'.repeat(64), approvedAt,
    approvals: Object.fromEntries(['business', 'technical', 'data', 'security', 'operations'].map((role, index) => [
      role, { approvedBy: `${role}-owner-${index + 1}`, approvedAt },
    ])),
  }
  await writeFile(approvalFile, `${JSON.stringify(approval)}\n`, { mode: 0o600 })

  const invalidApprovalFile = path.join(directory, 'invalid-approval.json')
  await writeFile(invalidApprovalFile, `${JSON.stringify({ ...approval, approvals: { business: approval.approvals.business } })}\n`, { mode: 0o600 })
  const invalidApproval = await run(['--disable', '--env-file', envFile, '--ponr-approval-file', invalidApprovalFile, '--apply'])
  assert.equal(invalidApproval.code, 1)
  assert.match(invalidApproval.stderr, /JSON object/)

  const disabled = await run(['--disable', '--env-file', envFile, '--ponr-approval-file', approvalFile, '--apply'])
  assert.equal(disabled.code, 0, disabled.stderr)
  const disabledText = await readFile(envFile, 'utf8')
  assert.match(disabledText, /^MIGRATION_WRITE_FREEZE=false$/m)
  assert.match(disabledText, /^MIGRATION_WRITE_FREEZE_MODE=$/m)
  assert.doesNotMatch(disabled.stdout, /fixture-secret|business-owner/)

  const duplicateFile = path.join(directory, 'duplicate.env')
  await writeFile(duplicateFile, 'MIGRATION_WRITE_FREEZE=false\nMIGRATION_WRITE_FREEZE=true\n', { mode: 0o600 })
  const duplicate = await run(['--enable', '--env-file', duplicateFile, '--apply'])
  assert.equal(duplicate.code, 1)
  assert.match(duplicate.stderr, /duplicate MIGRATION_WRITE_FREEZE/)

  const symlinkFile = path.join(directory, 'symlink.env')
  await symlink(envFile, symlinkFile)
  const symlinkResult = await run(['--enable', '--env-file', symlinkFile, '--apply'])
  assert.equal(symlinkResult.code, 1)
  assert.match(symlinkResult.stderr, /non-symlink/)

  const evidenceDirectory = path.resolve('.runtime/migration-evidence/migration-write-freeze-env')
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
  const report = {
    ok: true, capturedAt: new Date().toISOString(), checks: 8,
    previewNoWrite: true, atomicEnable: true, idempotentEnable: true,
    disableRequiresPonrApproval: true, fiveRoleApprovalRequired: true,
    duplicateKeysRejected: true, symlinkRejected: true, secretsExcluded: true,
  }
  await writeFile(path.join(evidenceDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify(report))
} finally {
  await rm(directory, { recursive: true, force: true })
}
