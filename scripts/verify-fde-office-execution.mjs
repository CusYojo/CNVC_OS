import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const destination = 'docs/fde-acceptance/20260828-office-execution'
mkdirSync(destination, { recursive: true })
const env = { ...process.env }
for (const key of Object.keys(env)) if (/^(DB_|MYSQL_|ALLOW_MYSQL_|FDE_ACCEPTANCE_PREFIX$|PROJECT_FILE_ROOT$)/.test(key)) delete env[key]
const steps = [
  ['types', 'npm', ['run', 'check:types']],
  ['database-boundary', 'npm', ['run', 'check:db-boundary']],
  ['unit', process.execPath, ['--import', 'tsx', '--test', 'server/tests/fdeOfficeExecution.test.ts', 'server/tests/fdeOfficeContract.test.ts', 'server/tests/fdeOfficeRecovery.test.ts', 'server/tests/fdeOfficeSources.test.ts', 'server/tests/fdeOfficePolicyRecovery.test.ts', 'server/tests/fdeMigrationAcceptanceSafety.test.ts']],
]
const results = []
for (const [name, command, args] of steps) {
  const startedAt = new Date().toISOString(), result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 180000, maxBuffer: 10 * 1024 * 1024 })
  writeFileSync(`${destination}/${name}.log`, result.stdout + result.stderr)
  results.push({ name, command, args, startedAt, endedAt: new Date().toISOString(), exitCode: result.status, error: result.error?.message ?? null })
  console.log({ name, exitCode: result.status })
  if (result.status !== 0) { process.exitCode = 1; break }
}
writeFileSync(`${destination}/verification.json`, JSON.stringify({ node: process.version, databaseEnvironmentRemoved: true, results }, null, 2) + '\n')
