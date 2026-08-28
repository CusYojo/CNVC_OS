import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = 'docs/fde-acceptance/20260828-office-execution'
const files = ['server/src/db/schema.ts', 'server/drizzle/meta/_journal.json', 'server/drizzle/0087_add_fde_office_execution.sql', 'server/src/contracts/fdeOfficeContract.ts', 'server/src/contracts/fdeOfficeExecutionContract.ts', 'server/src/services/fdeOfficeAccessService.ts', 'server/src/services/fdeOfficePolicyService.ts', 'server/src/services/fdeOfficeService.ts', 'server/src/services/fdeOfficeExecutionService.ts', 'server/src/routes/office.ts', 'server/src/scripts/fdeMigrationAcceptance.ts', 'server/src/scripts/fdeOfficeExecutionAcceptance.ts', 'server/tests/fdeOfficeExecution.test.ts', 'server/tests/fdeOfficeRecovery.test.ts', 'src/lib/fdeOfficeRecovery.ts', 'src/components/FdeOfficePanel.tsx', 'src/components/FdeOfficePolicyPanel.tsx', 'src/components/FdeOfficeExecutionPanel.tsx']
const phase = process.argv[2]
// These are new task-owned files (the snapshot helper itself was created just
// before the baseline). Record original absence without rewriting start.json.
files.push('src/components/FdeOfficeExecutionPolicyEditor.tsx', 'server/tests/fdeMigrationAcceptanceSafety.test.ts', 'scripts/fde-office-line-snapshot.mjs', 'scripts/verify-fde-office-execution.mjs')
if (!['start', 'end'].includes(phase)) throw new Error('Expected start or end')
mkdirSync(root, { recursive: true })
if (phase === 'start' && existsSync(join(root, 'start.json'))) throw new Error('Baseline already exists')
const rows = files.map(file => {
  if (!existsSync(file)) return { file, sha256: null }
  const bytes = readFileSync(file)
  if (phase === 'start') { const destination = join(root, 'baseline', file); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(file, destination) }
  return { file, sha256: createHash('sha256').update(bytes).digest('hex') }
})
writeFileSync(join(root, `${phase}.json`), JSON.stringify({ at: new Date().toISOString(), files: rows }, null, 2) + '\n')
if (phase === 'end') {
  const before = new Map(JSON.parse(readFileSync(join(root, 'start.json'), 'utf8')).files.map(row => [row.file, row.sha256]))
  const changed = rows.filter(row => row.sha256 !== (before.get(row.file) ?? null)).map(row => ({ ...row, beforeSha256: before.get(row.file) ?? null }))
  let patch = ''
  for (const row of changed) {
    const baseline = row.beforeSha256 ? join(root, 'baseline', row.file) : '/dev/null'
    const diff = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--', baseline, row.file], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
    if (diff.status !== 1) throw new Error(`Cannot produce delta: ${row.file}`)
    patch += diff.stdout.replace(`diff --git a/${baseline === '/dev/null' ? row.file : baseline} b/${row.file}`, `diff --git a/${row.file} b/${row.file}`).replace(`--- a/${baseline}`, `--- a/${row.file}`)
  }
  writeFileSync(join(root, 'changes.json'), JSON.stringify(changed, null, 2) + '\n')
  writeFileSync(join(root, 'oa-execution-increment.patch'), patch)
  const whitespaceFailures = changed.filter(row => /[\t ]+$/m.test(readFileSync(row.file, 'utf8'))).map(row => row.file)
  const reverse = spawnSync('git', ['apply', '--reverse', '--check', join(root, 'oa-execution-increment.patch')], { encoding: 'utf8' })
  writeFileSync(join(root, 'delta-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), changedFiles: changed.length, whitespaceFailures,
    reversePatchCheckExitCode: reverse.status, reversePatchCheckError: reverse.stderr.trim() || null, patchSha256: createHash('sha256').update(patch).digest('hex') }, null, 2) + '\n')
  if (whitespaceFailures.length || reverse.status !== 0) throw new Error('Delta validation failed')
  console.log({ changed: changed.length, patchSha256: createHash('sha256').update(patch).digest('hex') })
}
console.log({ phase, files: rows.length, existing: rows.filter(row => row.sha256).length })
