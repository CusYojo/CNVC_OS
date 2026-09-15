import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import { cleanupFdeTables, withAcceptanceCleanup, type FdeCleanupConnection } from './fdeAcceptanceCleanup.js'
import { withFdeAcceptanceSignals } from './fdeAcceptanceSignals.js'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

// A random table prefix is only an additional isolation layer, not permission
// to create fixtures in the configured business database. Fail before credential
// substitution, connection creation, temporary directories, or migrations.
assertIsolatedMysqlAcceptanceDatabase('fdeMigrationAcceptance')

const sourcePrefix = process.env.DB_FREFIX ?? ''
const allowedModes = ['--weekly-browser', '--time-report', '--records', '--files', '--knowledge', '--office', '--archives', '--responsibility', '--agent', '--timeline-tasks', '--timeline-events', '--timeline-times', '--milestone-sources', '--weekly-times', '--type-policies', '--type-execution', '--type-times', '--committee', '--type-registration', '--replans', '--office-execution']
assert.ok(process.argv.slice(2).every(arg => allowedModes.includes(arg)), '未知验收参数；不会默默运行完整写入验收')
assert.match(sourcePrefix, /^[A-Za-z0-9_]+$/, '必须提供合法业务表前缀')
const targetPrefix = `fde_accept_${randomBytes(5).toString('hex')}_`
assert.notEqual(targetPrefix, sourcePrefix)
if (process.env.DB_MIGRATION_USERNAME && process.env.DB_MIGRATION_PASSWORD) {
  process.env.DB_USERNAME = process.env.DB_MIGRATION_USERNAME
  process.env.DB_PASSWORD = process.env.DB_MIGRATION_PASSWORD
}
const connect = () => mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, charset: 'utf8mb4_0900_ai_ci', connectTimeout: 10000,
})
const tables = async (prefix: string) => {
  const connection = await connect()
  try {
    const [rows] = await connection.query<Array<RowDataPacket & { name: string }>>('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND LEFT(TABLE_NAME,?)=? ORDER BY TABLE_NAME', [process.env.DB_DATABASE, prefix.length, prefix])
    return rows.map((row) => row.name)
  } finally { await connection.end().catch(() => connection.destroy()) }
}
await withFdeAcceptanceSignals(async lifecycle => {
const sourceTables = await tables(sourcePrefix)
assert.equal((await tables(targetPrefix)).length, 0)
lifecycle.checkpoint()
const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'fde-migration-acceptance-'))
console.log(JSON.stringify({ fixturePrefix: targetPrefix, fixtureRoot }))
process.env.DB_FREFIX = targetPrefix
process.env.FDE_ACCEPTANCE_PREFIX = targetPrefix
process.env.PROJECT_FILE_ROOT = path.join(fixtureRoot, 'files')
process.env.AI_ARTIFACT_ROOT = path.join(fixtureRoot, 'artifacts')
let fixturePool: { end(): Promise<void> } | undefined
await withAcceptanceCleanup(async () => {
  const { pool } = await import('../db/client.js'); fixturePool = pool
  const { applySchemaMigrations, assertSchemaReady } = await import('../db/migrate.js')
  lifecycle.checkpoint()
  await applySchemaMigrations()
  await assertSchemaReady()
  const firstTables = await tables(targetPrefix)
  await applySchemaMigrations()
  assert.deepEqual(await tables(targetPrefix), firstTables, '迁移复跑不得重复建表或改变表集合')
  lifecycle.checkpoint()
  const execFileAsync = promisify(execFile)
  const browserMode = process.argv.includes('--weekly-browser')
  const timeReportMode = process.argv.includes('--time-report')
  const recordMode = process.argv.includes('--records')
  const fileMode = process.argv.includes('--files')
  const knowledgeMode = process.argv.includes('--knowledge')
  const officeMode = process.argv.includes('--office')
  const archiveMode = process.argv.includes('--archives')
  const responsibilityMode = process.argv.includes('--responsibility')
  const agentMode = process.argv.includes('--agent')
  const timelineTasksMode = process.argv.includes('--timeline-tasks')
  const timelineEventsMode = process.argv.includes('--timeline-events')
  const timelineTimesMode = process.argv.includes('--timeline-times')
  const milestoneSourcesMode = process.argv.includes('--milestone-sources')
  const weeklyTimesMode = process.argv.includes('--weekly-times')
  const typePoliciesMode = process.argv.includes('--type-policies')
  const typeExecutionMode = process.argv.includes('--type-execution')
  const typeTimesMode = process.argv.includes('--type-times')
  const committeeMode = process.argv.includes('--committee')
  const typeRegistrationMode = process.argv.includes('--type-registration')
  const replanMode = process.argv.includes('--replans')
  const officeExecutionMode = process.argv.includes('--office-execution')
  assert.ok([browserMode, timeReportMode, recordMode, fileMode, knowledgeMode, officeMode, archiveMode, responsibilityMode, agentMode, timelineTasksMode, timelineEventsMode, timelineTimesMode, milestoneSourcesMode, weeklyTimesMode, typePoliciesMode, typeExecutionMode, typeTimesMode, committeeMode, typeRegistrationMode, replanMode, officeExecutionMode].filter(Boolean).length <= 1, '不能混用浏览器与定向验收模式')
  const scripts = browserMode ? [] : fileMode ? ['fdeFileAcceptance.ts', 'fdeMaterialAcceptance.ts', 'fdeMaterialHttpAcceptance.ts', 'fdeWorkflowAcceptance.ts', 'fdeTaskAcceptance.ts'] : recordMode ? ['fdeProjectRecordAcceptance.ts', 'fdeWorkflowAcceptance.ts', 'fdeFridayMeetingAcceptance.ts'] : timeReportMode ? ['fdeScheduleTransactionAcceptance.ts', 'fdeTimeAcceptance.ts', 'fdeWeeklyReportSourcesAcceptance.ts'] : ['fdeProjectPoolAcceptance.ts', 'leadConversionAcceptance.ts', 'identityMappingAcceptance.ts', 'oaWorkflowAcceptance.ts', 'fdeWorkflowAcceptance.ts', 'fdeGovernanceAcceptance.ts', 'systemAdministrationAcceptance.ts', 'fdePolicyAcceptance.ts', 'fdeIntegrationSummaryAcceptance.ts', 'fdeTaskAcceptance.ts', 'fdeWeeklyPlanAcceptance.ts', 'fdeWeeklyReportAcceptance.ts', 'fdeFridayMeetingAcceptance.ts', 'fdeDirectiveAcceptance.ts', 'fdeScheduleTransactionAcceptance.ts', 'fdeTimeAcceptance.ts', 'fdeWeeklyReportSourcesAcceptance.ts', 'fdeProjectRecordAcceptance.ts', 'fdeFileAcceptance.ts', 'fdeMaterialAcceptance.ts', 'fdeMaterialHttpAcceptance.ts']
  if (archiveMode) scripts.splice(0, scripts.length, 'fdeArchiveAcceptance.ts', 'fdeFileAcceptance.ts', 'leadConversionAcceptance.ts')
  else if (officeMode) scripts.splice(0, scripts.length, 'fdeOfficeAcceptance.ts', 'fdeOfficeRecoveryAcceptance.ts', 'fdeOfficeInboxPolicyAcceptance.ts', 'oaWorkflowAcceptance.ts', 'fdeTaskAcceptance.ts', 'leadConversionAcceptance.ts')
  else if (knowledgeMode) scripts.splice(0, scripts.length, 'fdeKnowledgeAcceptance.ts', 'fdeFileAcceptance.ts', 'leadConversionAcceptance.ts')
  else if (!browserMode && !timeReportMode && !recordMode && !fileMode) scripts.push('fdeKnowledgeAcceptance.ts', 'fdeOfficeAcceptance.ts', 'fdeOfficeRecoveryAcceptance.ts', 'fdeOfficeInboxPolicyAcceptance.ts')
  if (!browserMode && !fileMode && !recordMode && !knowledgeMode && !archiveMode) scripts.push('fdeOfficeSourcesAcceptance.ts')
  if (knowledgeMode || (!browserMode && !officeMode && !fileMode && !recordMode && !timeReportMode && !archiveMode)) scripts.push('fdeKnowledgeRecoveryAcceptance.ts', 'fdeArchiveAcceptance.ts')
  if (responsibilityMode) scripts.splice(0, scripts.length, 'fdeResponsibilityPolicyAcceptance.ts', 'fdeResponsibilityAcceptance.ts', 'fdeResponsibilityScannerAcceptance.ts', 'fdeTaskAcceptance.ts', 'leadConversionAcceptance.ts')
  else if (!browserMode && !officeMode && !fileMode && !recordMode && !timeReportMode && !knowledgeMode && !archiveMode) scripts.push('fdeResponsibilityPolicyAcceptance.ts', 'fdeResponsibilityAcceptance.ts', 'fdeResponsibilityScannerAcceptance.ts')
  if (agentMode) scripts.splice(0, scripts.length, 'fdeProjectAgentAcceptance.ts', 'fdeAgentScheduleAcceptance.ts', 'fdeTimelineTaskAcceptance.ts', 'fdeWorkflowAcceptance.ts', 'fdeTaskAcceptance.ts', 'fdeFileAcceptance.ts', 'leadConversionAcceptance.ts', 'fdeWeeklyPlanAcceptance.ts', 'fdeWeeklyReportSourcesAcceptance.ts', 'fdeResponsibilityAcceptance.ts')
  else if (timelineTasksMode) scripts.splice(0, scripts.length, 'fdeTimelineTaskAcceptance.ts')
  else if (process.argv.length === 2) scripts.push('fdeProjectAgentAcceptance.ts', 'fdeAgentScheduleAcceptance.ts', 'fdeTimelineTaskAcceptance.ts')
  if (!browserMode && (agentMode || process.argv.length === 2)) scripts.push('fdeTimelineEventAcceptance.ts')
  if (timelineEventsMode) scripts.splice(0, scripts.length, 'fdeTimelineEventAcceptance.ts', 'fdeFridayMeetingAcceptance.ts', 'fdeDirectiveAcceptance.ts')
  if (process.argv.length === 2) scripts.push('fdeTimelineTimeAcceptance.ts')
  if (timelineTimesMode) scripts.splice(0, scripts.length, 'fdeTimelineTimeAcceptance.ts', 'fdeTimeAcceptance.ts', 'fdeTimelineEventAcceptance.ts', 'fdeAgentScheduleAcceptance.ts', 'fdeDirectiveAcceptance.ts')
  if (process.argv.length === 2) scripts.push('fdeMilestoneSourcesAcceptance.ts')
  if (milestoneSourcesMode) scripts.splice(0, scripts.length, 'fdeMilestoneSourcesAcceptance.ts', 'fdeAgentScheduleAcceptance.ts', 'fdeTimelineTaskAcceptance.ts', 'fdeTimeAcceptance.ts', 'fdeWeeklyReportAcceptance.ts', 'fdeWeeklyReportSourcesAcceptance.ts', 'fdeOfficeSourcesAcceptance.ts')
  if (process.argv.length === 2) scripts.push('fdeWeeklyLeaderTimeAcceptance.ts')
  if (weeklyTimesMode) scripts.splice(0, scripts.length, 'fdeWeeklyLeaderTimeAcceptance.ts', 'fdeWeeklyPlanAcceptance.ts', 'fdeFridayMeetingAcceptance.ts', 'fdeTimelineTimeAcceptance.ts', 'fdeTimeAcceptance.ts', 'fdeDirectiveAcceptance.ts', 'fdeWeeklyReportSourcesAcceptance.ts')
  if (process.argv.length === 2) scripts.push('fdeTypePolicyAcceptance.ts')
  if (typePoliciesMode) scripts.splice(0, scripts.length, 'fdeTypePolicyAcceptance.ts', 'fdePolicyAcceptance.ts', 'fdeGovernanceAcceptance.ts', 'fdeWorkflowAcceptance.ts', 'fdeTaskAcceptance.ts', 'fdeWeeklyPlanAcceptance.ts', 'leadConversionAcceptance.ts')
  if (process.argv.length === 2) scripts.push('fdeTypeExecutionPreparationAcceptance.ts')
  if (typeExecutionMode) scripts.splice(0, scripts.length, 'fdeTypePolicyAcceptance.ts', 'fdePolicyAcceptance.ts', 'fdeGovernanceAcceptance.ts', 'fdeWorkflowAcceptance.ts', 'fdeTaskAcceptance.ts', 'fdeWeeklyPlanAcceptance.ts', 'leadConversionAcceptance.ts', 'fdeTypeExecutionPreparationAcceptance.ts')
  if (typeExecutionMode || process.argv.length === 2) scripts.push('fdeTypeRuntimeAcceptance.ts')
  if (typeExecutionMode || process.argv.length === 2) scripts.push('fdeTypeApprovalAcceptance.ts')
  if (typeExecutionMode) scripts.push('fdeOfficeInboxPolicyAcceptance.ts', 'oaWorkflowAcceptance.ts')
  if (process.argv.length === 2 || typeExecutionMode) scripts.push('fdeTypeLeaderTimeAcceptance.ts')
  if (typeTimesMode) scripts.splice(0, scripts.length, 'fdeTypeLeaderTimeAcceptance.ts', 'fdeTypeRuntimeAcceptance.ts', 'fdeTypeApprovalAcceptance.ts', 'fdeGovernanceAcceptance.ts', 'fdeWeeklyLeaderTimeAcceptance.ts', 'fdeTimelineTimeAcceptance.ts', 'fdeTimeAcceptance.ts', 'fdeTaskAcceptance.ts', 'leadConversionAcceptance.ts')
  if (process.argv.length === 2) scripts.push('fdeCommitteeAcceptance.ts', 'fdeCommitteeHttpAcceptance.ts')
  if (committeeMode) scripts.splice(0, scripts.length, 'fdeCommitteeAcceptance.ts', 'fdeCommitteeHttpAcceptance.ts', 'fdeFridayMeetingAcceptance.ts', 'fdeScheduleTransactionAcceptance.ts', 'fdeTimeAcceptance.ts', 'fdeWeeklyReportSourcesAcceptance.ts', 'fdeWeeklyReportAcceptance.ts', 'fdeFileAcceptance.ts', 'oaWorkflowAcceptance.ts', 'leadConversionAcceptance.ts')
  if (process.argv.length === 2) scripts.push('fdeTypeRegistrationAcceptance.ts', 'fdeProjectReplanAcceptance.ts', 'fdeOfficeExecutionAcceptance.ts')
  if (typeRegistrationMode) scripts.splice(0, scripts.length, 'fdeTypePolicyAcceptance.ts', 'fdeTypeRegistrationAcceptance.ts', 'fdeTypeRuntimeAcceptance.ts', 'leadConversionAcceptance.ts')
  if (replanMode) scripts.splice(0, scripts.length, 'fdeProjectReplanAcceptance.ts', 'fdeAgentScheduleAcceptance.ts', 'fdeTimelineTaskAcceptance.ts', 'fdeMilestoneSourcesAcceptance.ts', 'fdeTimeAcceptance.ts', 'oaWorkflowAcceptance.ts')
  if (officeExecutionMode) scripts.splice(0, scripts.length, 'fdeOfficeExecutionAcceptance.ts', 'fdeOfficeAcceptance.ts', 'fdeOfficeRecoveryAcceptance.ts', 'fdeOfficeSourcesAcceptance.ts', 'oaWorkflowAcceptance.ts', 'leadConversionAcceptance.ts')
  for (const script of scripts) {
    lifecycle.checkpoint()
    try {
      const operation = execFileAsync(process.execPath, ['--import', 'tsx', `server/src/scripts/${script}`], { env: { ...process.env }, cwd: process.cwd(), maxBuffer: 2 * 1024 * 1024 })
      lifecycle.track(operation.child)
      const result = await operation
      process.stdout.write(result.stdout)
      console.log(JSON.stringify({ script, exitCode: 0 }))
    } catch (error) {
      console.error(JSON.stringify({ failedScript: script, businessRetry: false }))
      throw error
    }
  }
  if (browserMode) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/scripts/fdeWeeklyBrowserFixture.ts'], { env: { ...process.env }, cwd: process.cwd(), stdio: 'inherit' })
    lifecycle.track(child)
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`隔离浏览器夹具退出 ${code} signal=${signal ?? 'none'}`))) })
  }
  assert.deepEqual(await tables(sourcePrefix), sourceTables, '业务表集合必须保持不变')
  const checks = browserMode ? ['browser-fixture-lifecycle-only']
    : fileMode ? ['fde-file-access-lifecycle', 'fde-material-submissions', 'fde-material-authenticated-http', 'fde-workflow', 'fde-task-execution', 'focused-not-full-migration']
      : recordMode ? ['fde-project-records', 'fde-workflow', 'fde-friday-meetings', 'focused-not-full-migration']
        : timeReportMode ? ['fde-time-calendar-auto-schedule', 'fde-weekly-report-sources', 'focused-not-full-migration']
          : ['project-pool', 'legacy-oa', 'fde-workflow', 'fde-governance', 'system-administration', 'fde-versioned-policies', 'fde-integration-summary', 'fde-task-execution', 'fde-weekly-plans', 'fde-weekly-reports', 'fde-friday-meetings', 'fde-directives', 'fde-time-calendar-auto-schedule', 'fde-weekly-report-sources', 'fde-project-records', 'fde-file-access-lifecycle', 'fde-material-submissions', 'fde-material-authenticated-http']
  if (archiveMode) checks.splice(0, checks.length, 'fde-project-archives', 'fde-file-access-lifecycle', 'lead-conversion', 'focused-not-full-migration')
  else if (officeMode) checks.splice(0, checks.length, 'fde-office', 'fde-office-recovery', 'fde-office-inbox-policy', 'legacy-oa', 'fde-task-execution', 'lead-conversion', 'focused-not-full-migration')
  else if (knowledgeMode) checks.splice(0, checks.length, 'fde-company-knowledge', 'fde-file-access-lifecycle', 'lead-conversion', 'focused-not-full-migration')
  else if (!browserMode && !timeReportMode && !recordMode && !fileMode) checks.push('fde-company-knowledge', 'fde-office', 'fde-office-recovery', 'fde-office-inbox-policy')
  if (!browserMode && !fileMode && !recordMode && !knowledgeMode && !archiveMode) checks.push('fde-office-sources')
  if (knowledgeMode || (!browserMode && !officeMode && !fileMode && !recordMode && !timeReportMode && !archiveMode)) checks.push('fde-knowledge-recovery', 'fde-project-archives')
  if (responsibilityMode) checks.splice(0, checks.length, 'fde-responsibility-policy-foundation', 'fde-responsibility-source-ledger', 'fde-responsibility-deadline-scanner', 'fde-task-execution', 'lead-conversion', 'focused-not-full-migration')
  else if (!browserMode && !officeMode && !fileMode && !recordMode && !timeReportMode && !knowledgeMode && !archiveMode) checks.push('fde-responsibility-policy-foundation', 'fde-responsibility-source-ledger', 'fde-responsibility-deadline-scanner')
  if (agentMode) checks.splice(0, checks.length, 'fde-agent-facts-rules-human-drafts', 'fde-agent-node-date-approval', 'fde-timeline-task-sync', 'fde-workflow', 'fde-task', 'fde-file', 'lead-conversion', 'fde-weekly-plan', 'fde-weekly-report-sources', 'fde-responsibility', 'focused-not-full-migration')
  else if (timelineTasksMode) checks.splice(0, checks.length, 'fde-timeline-task-sync', 'focused-not-full-migration')
  else if (process.argv.length === 2) checks.push('fde-agent-facts-rules-human-drafts', 'fde-agent-node-date-approval')
  if (!browserMode && (agentMode || process.argv.length === 2)) checks.push('fde-timeline-source-events-recovery')
  if (timelineEventsMode) checks.splice(0, checks.length, 'fde-timeline-source-events-recovery', 'fde-friday-meetings', 'fde-directives', 'focused-not-full-migration')
  if (process.argv.length === 2) checks.push('fde-timeline-leader-time-source-lifecycle')
  if (timelineTimesMode) checks.splice(0, checks.length, 'fde-timeline-leader-time-source-lifecycle', 'fde-time-calendar-auto-schedule', 'fde-timeline-source-events-recovery', 'fde-agent-node-date-approval', 'fde-directives', 'focused-not-full-migration')
  if (process.argv.length === 2) checks.push('fde-approved-milestone-calendar-report-sources')
  if (milestoneSourcesMode) checks.splice(0, checks.length, 'fde-approved-milestone-sources', 'fde-agent-node-date-approval', 'fde-timeline-task-sync', 'fde-time', 'fde-weekly-report', 'fde-weekly-report-sources', 'fde-office-sources', 'focused-not-full-migration')
  if (process.argv.length === 2) checks.push('fde-weekly-leader-time-source-lifecycle')
  if (weeklyTimesMode) checks.splice(0, checks.length, 'fde-weekly-leader-time-source-lifecycle', 'fde-weekly-plans', 'fde-friday-meetings', 'fde-timeline-leader-time-source-lifecycle', 'fde-time', 'fde-directives', 'fde-weekly-report-sources', 'focused-not-full-migration')
  if (process.argv.length === 2) checks.push('fde-non-investment-template-review')
  if (typePoliciesMode) checks.splice(0, checks.length, 'fde-non-investment-template-review', 'fde-investment-policy', 'fde-governance', 'fde-workflow', 'fde-tasks', 'fde-weekly-plans', 'lead-conversion', 'focused-not-full-migration')
  if (typeExecutionMode) checks.splice(0, checks.length, 'fde-type-runtime', 'fde-type-unified-approval', 'fde-office-inbox-policy', 'legacy-oa', 'fde-type-preparation', 'fde-type-policy', 'fde-investment-policy', 'fde-governance', 'fde-workflow', 'fde-tasks', 'fde-weekly-plans', 'lead-conversion', 'focused-not-full-migration')
  if (process.argv.length === 2 || typeExecutionMode) checks.push('fde-type-leader-source-lifecycle')
  if (typeTimesMode) checks.splice(0, checks.length, 'fde-type-leader-source-lifecycle', 'fde-type-runtime', 'fde-type-unified-approval', 'fde-governance', 'fde-weekly-times', 'fde-timeline-times', 'fde-times', 'fde-tasks', 'lead-conversion', 'focused-not-full-migration')
  if (process.argv.length === 2) checks.push('fde-committee', 'fde-committee-authenticated-http')
  if (committeeMode) checks.splice(0, checks.length, 'fde-committee', 'fde-committee-authenticated-http', 'fde-friday-meetings', 'fde-schedule-transactions', 'fde-time', 'fde-weekly-report-sources', 'fde-weekly-report', 'fde-file', 'legacy-oa', 'lead-conversion', 'focused-not-full-migration')
  if (process.argv.length === 2) checks.push('fde-controlled-type-registration', 'fde-project-replan', 'fde-office-manual-execution-receipts')
  if (typeRegistrationMode) checks.splice(0, checks.length, 'fde-type-policy', 'fde-controlled-type-registration', 'fde-type-runtime', 'lead-conversion', 'focused-not-full-migration')
  if (replanMode) checks.splice(0, checks.length, 'fde-project-replan', 'fde-agent-schedule', 'fde-timeline-tasks', 'fde-milestone-sources', 'fde-time', 'legacy-oa', 'focused-not-full-migration')
  if (officeExecutionMode) checks.splice(0, checks.length, 'fde-office-manual-execution-receipts', 'fde-office', 'fde-office-recovery', 'fde-office-sources', 'legacy-oa', 'lead-conversion', 'focused-not-full-migration')
  console.log(JSON.stringify({ ok: true, prefix: targetPrefix, scripts, checks: ['fresh-schema', 'migration-idempotency', ...checks, 'business-table-set-unchanged'] }))
}, async () => {
  console.log(JSON.stringify({ cleanupStarted: true, prefix: targetPrefix, parentPid: process.pid }))
  await withAcceptanceCleanup(async () => { await fixturePool?.end() }, async () => {
    const result = await cleanupFdeTables({ targetPrefix, sourcePrefix, sourceTables, connect: async (): Promise<FdeCleanupConnection> => {
      const connection = await connect()
      // Orphaned test transactions can hold metadata locks after a disconnect.
      // Fail with retained diagnostics rather than hanging cleanup indefinitely;
      // never automatically kill a database session to make a test pass.
      try { await connection.query('SET SESSION lock_wait_timeout=10') }
      catch (error) { await connection.end().catch(() => connection.destroy()); throw error }
      return {
        tables: async (prefix) => {
          const [rows] = await connection.query<Array<RowDataPacket & { name: string }>>('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND LEFT(TABLE_NAME,?)=? ORDER BY TABLE_NAME', [process.env.DB_DATABASE, prefix.length, prefix])
          return rows.map(row => row.name)
        },
        foreignKeys: async (enabled) => { await connection.query(`SET FOREIGN_KEY_CHECKS=${enabled ? 1 : 0}`) },
        drop: async (table) => { await connection.query(`DROP TABLE IF EXISTS \`${table}\``) },
        close: async () => { await connection.end().catch(() => connection.destroy()) },
      }
    } })
    await rm(fixtureRoot, { recursive: true, force: true })
    console.log(`已清理本次隔离验收前缀 ${targetPrefix} 的 ${result.tables} 张临时表和临时文件，业务前缀未修改。`)
    console.log(JSON.stringify({ cleanup: true, prefix: targetPrefix, attempts: result.attempts, tables: result.tables }))
  })
})
})
