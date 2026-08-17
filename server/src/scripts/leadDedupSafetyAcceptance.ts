import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const outputDirectory = path.resolve('.runtime/migration-evidence/lead-dedup-safety')

async function runRetiredEntrypoint(script: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx',
      script,
      '--apply',
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk.slice(0, 16_384) })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk.slice(0, 16_384) })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function writeEvidence(payload: Record<string, unknown>) {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  await chmod(outputDirectory, 0o700)
  const target = path.resolve(outputDirectory, 'report.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  await chmod(target, 0o600)
}

const retiredEntrypoints = [
  ['server/src/scripts/dedupLeads.ts', 'LEAD_DEDUP_REQUIRES_APPROVED_LEDGER'],
  ['server/src/scripts/repairLeadSubjectNames.ts', 'LEAD_SUBJECT_REPAIR_REQUIRES_PIPELINE_REVIEW'],
] as const
for (const [script, expectedCode] of retiredEntrypoints) {
  const result = await runRetiredEntrypoint(script)
  assert.equal(result.code, 78, `${script} must fail closed with exit 78`)
  assert.equal(result.stdout, '', `${script} must not emit lead data`)
  const payload = JSON.parse(result.stderr.trim()) as Record<string, unknown>
  assert.equal(payload.ok, false)
  assert.equal(payload.code, expectedCode)
  assert.equal(payload.destructiveWriteAttempted, false)
  assert.deepEqual(Object.keys(payload).sort(), ['code', 'destructiveWriteAttempted', 'message', 'ok'])
}

const evidence = {
  schemaVersion: '1.0',
  generatedAt: new Date().toISOString(),
  ok: true,
  retiredEntrypoints: retiredEntrypoints.length,
  businessContentExcluded: true,
  identifiersExcluded: true,
  checks: [
    'legacy-apply-entrypoint-fails-closed',
    'standalone-ai-subject-repair-fails-closed',
    'no-database-write-is-attempted',
    'output-excludes-lead-names-and-identifiers',
    'versioned-business-disposition-is-required',
  ],
}
await writeEvidence(evidence)
console.log(JSON.stringify(evidence))
