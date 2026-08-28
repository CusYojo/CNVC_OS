import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
const entry = read('../src/scripts/fdeMigrationAcceptance.ts')
const modes = {
  '--committee': ['fdeCommitteeAcceptance.ts', 'fdeCommitteeHttpAcceptance.ts', 'fdeFridayMeetingAcceptance.ts', 'fdeScheduleTransactionAcceptance.ts', 'fdeTimeAcceptance.ts', 'fdeWeeklyReportSourcesAcceptance.ts', 'fdeWeeklyReportAcceptance.ts', 'fdeFileAcceptance.ts', 'oaWorkflowAcceptance.ts', 'leadConversionAcceptance.ts'],
  '--type-registration': ['fdeTypePolicyAcceptance.ts', 'fdeTypeRegistrationAcceptance.ts', 'fdeTypeRuntimeAcceptance.ts', 'leadConversionAcceptance.ts'],
  '--replans': ['fdeProjectReplanAcceptance.ts', 'fdeAgentScheduleAcceptance.ts', 'fdeTimelineTaskAcceptance.ts', 'fdeMilestoneSourcesAcceptance.ts', 'fdeTimeAcceptance.ts', 'oaWorkflowAcceptance.ts'],
  '--office-execution': ['fdeOfficeExecutionAcceptance.ts', 'fdeOfficeAcceptance.ts', 'fdeOfficeRecoveryAcceptance.ts', 'fdeOfficeSourcesAcceptance.ts', 'oaWorkflowAcceptance.ts', 'leadConversionAcceptance.ts'],
}

function selectedScripts(args: string[]): string[] {
  // Execute only the existing pure selection block: no imports, connection,
  // lifecycle or child-process runner is included in this isolated context.
  const start = entry.indexOf('  const browserMode ='), end = entry.indexOf('  for (const script of scripts)')
  assert.ok(start >= 0 && end > start)
  const selector = entry.slice(start, end)
  assert.doesNotMatch(selector, /\bawait\b|\bimport\b|\bspawn\b|execFile|connect\(/)
  return JSON.parse(JSON.stringify(runInNewContext(`${selector}\nscripts`, { process: { argv: ['node', 'entry', ...args] }, assert }, { timeout: 1000 })))
}

test('parallel migration journal retains ordered 0084 through 0087 with no duplicate index or tag', () => {
  const journal = JSON.parse(read('../drizzle/meta/_journal.json')) as { entries: Array<{ idx: number; tag: string; when: number }> }
  assert.deepEqual(journal.entries.slice(-4).map(x => [x.idx, x.tag]), [
    [84, '0084_add_fde_committee'], [85, '0085_add_fde_type_registration'],
    [86, '0086_add_fde_project_replan'], [87, '0087_add_fde_office_execution'],
  ])
  assert.equal(new Set(journal.entries.map(x => x.idx)).size, journal.entries.length)
  assert.equal(new Set(journal.entries.map(x => x.tag)).size, journal.entries.length)
  for (let i = 1; i < journal.entries.length; i++) assert.ok(journal.entries[i].when > journal.entries[i - 1].when)
  for (const migration of journal.entries) assert.ok(existsSync(new URL(`../drizzle/${migration.tag}.sql`, import.meta.url)))
})

test('all four feature migrations have schema exports and runtime readiness checks', () => {
  const schema = read('../src/db/schema.ts'), readiness = read('../src/db/migrate.ts')
  const groups = [
    ['0084_add_fde_committee', 'committee_meetings', 'committee_years', 'committee_agendas', 'committee_files', 'committee_commands'],
    ['0085_add_fde_type_registration', 'fde_type_registration_commands'],
    ['0086_add_fde_project_replan', 'project_replan_policies', 'project_replan_requests'],
    ['0087_add_fde_office_execution', 'oa_office_executions', 'oa_office_execution_files'],
  ]
  for (const [migration, ...tables] of groups) {
    const sql = read(`../drizzle/${migration}.sql`)
    for (const table of tables) {
      assert.ok(schema.includes(`mysqlTable('${table}'`), `${table}: missing schema`)
      assert.ok(readiness.includes(`'${table}'`), `${table}: missing readiness check`)
      assert.ok(sql.includes(table), `${table}: missing migration`)
    }
  }
})

test('integrated selection retains committee HTTP and each exact reviewed feature suite', () => {
  for (const [mode, expected] of Object.entries(modes)) {
    assert.ok(entry.includes(`'${mode}'`))
    assert.deepEqual(selectedScripts([mode]), expected)
  }
  assert.throws(() => selectedScripts(['--replans', '--office-execution']), /不能混用/)
})

test('full selection contains each new acceptance exactly once and every script exists', () => {
  const scripts = selectedScripts([])
  assert.equal(scripts.length, 48)
  assert.equal(new Set(scripts).size, scripts.length)
  for (const script of scripts) assert.ok(existsSync(new URL(`../src/scripts/${script}`, import.meta.url)), script)
  for (const script of ['fdeCommitteeHttpAcceptance.ts', 'fdeTypeRegistrationAcceptance.ts', 'fdeProjectReplanAcceptance.ts', 'fdeOfficeExecutionAcceptance.ts']) assert.ok(scripts.includes(script))
})

for (const mode of Object.keys(modes)) test(`${mode} still rejects an unsafe database before any resources`, () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', new URL('../src/scripts/fdeMigrationAcceptance.ts', import.meta.url).pathname, mode], {
    env: { PATH: process.env.PATH, DB_DATABASE: 'business', DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USERNAME: 'fixture', DB_PASSWORD: 'fixture', DB_FREFIX: 'fixture_', ALLOW_MYSQL_ACCEPTANCE_WRITES: '1' },
    encoding: 'utf8', timeout: 10000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /requires ALLOW_MYSQL_ACCEPTANCE_WRITES=1 with a dedicated test\/acceptance MySQL database/)
  assert.equal(result.stdout, '')
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|ENOTFOUND|fixturePrefix|fixtureRoot|cleanupStarted|ER_ACCESS_DENIED/)
})
