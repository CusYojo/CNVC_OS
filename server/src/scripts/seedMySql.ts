import { createHash } from 'node:crypto'
import type { RowDataPacket } from 'mysql2/promise'

const apply = process.argv.includes('--apply')
const migrationUser = process.env.DB_MIGRATION_USERNAME?.trim()
const migrationPassword = process.env.DB_MIGRATION_PASSWORD
if (migrationUser || migrationPassword) {
  if (!migrationUser || !migrationPassword) {
    throw new Error('DB_MIGRATION_USERNAME and DB_MIGRATION_PASSWORD must be provided together')
  }
  process.env.DB_USERNAME = migrationUser
  process.env.DB_PASSWORD = migrationPassword
}

const [
  { pool },
  { assertSchemaReady },
  { mysqlConfig, mysqlTableName, quoteMysqlIdentifier },
  { AI_TEMPLATE_CATALOG, AI_TASK_TYPES },
  { AI_CAPABILITY_CATALOG, ensureBuiltinCapabilityCatalog },
  { runtimeJobDefinitions, seedRuntimeJobDefinitions },
] = await Promise.all([
  import('../db/client.js'),
  import('../db/migrate.js'),
  import('../db/config.js'),
  import('../services/aiTemplateCatalog.js'),
  import('../services/aiCapabilityService.js'),
  import('../services/runtimeJobScheduler.js'),
])

const SEED_VERSION = 'mysql-core-seed-v1'
const templates = AI_TASK_TYPES.map((type) => {
  const item = AI_TEMPLATE_CATALOG[type]
  return {
    type: item.type,
    label: item.label,
    templateVersion: item.templateVersion,
    skillName: item.skillName,
    outputFormat: item.outputFormat,
    status: 'enabled',
  }
})
const capabilities = AI_CAPABILITY_CATALOG.map((item) => ({
  kind: item.kind,
  capabilityKey: item.capabilityKey,
  name: item.name,
  packageVersion: item.packageVersion,
}))
const jobs = runtimeJobDefinitions().map((item) => ({
  id: item.id,
  task: item.task,
  enabled: item.enabled,
  scheduleKind: item.scheduleKind,
  intervalSeconds: item.intervalSeconds ?? null,
  dailyHour: item.dailyHour ?? null,
  dailyMinute: item.dailyMinute ?? null,
}))
const manifest = { version: SEED_VERSION, templates, capabilities, jobs }
const manifestSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
const runIdHex = createHash('sha256').update(`seed:${SEED_VERSION}:${manifestSha256}`).digest('hex').slice(0, 32)
const runId = `${runIdHex.slice(0, 8)}-${runIdHex.slice(8, 12)}-4${runIdHex.slice(13, 16)}-8${runIdHex.slice(17, 20)}-${runIdHex.slice(20)}`

const templateTable = quoteMysqlIdentifier(mysqlTableName('ai_task_templates'))
const capabilityTable = quoteMysqlIdentifier(mysqlTableName('ai_capabilities'))
const bindingTable = quoteMysqlIdentifier(mysqlTableName('ai_capability_bindings'))
const jobsTable = quoteMysqlIdentifier(mysqlTableName('runtime_jobs'))
const migrationRunsTable = quoteMysqlIdentifier(mysqlTableName('migration_runs'))

function sameTemplate(row: RowDataPacket | undefined, expected: typeof templates[number]): boolean {
  return Boolean(row
    && row.label === expected.label
    && row.template_version === expected.templateVersion
    && row.skill_name === expected.skillName
    && row.output_format === expected.outputFormat
    && row.status === expected.status)
}

async function inspectCurrent() {
  const [templateRows] = await pool.query<RowDataPacket[]>(
    `SELECT type, label, template_version, skill_name, output_format, status FROM ${templateTable}`,
  )
  const templateByType = new Map(templateRows.map((row) => [String(row.type), row]))
  const [capabilityRows] = await pool.query<RowDataPacket[]>(
    `SELECT kind, capability_key FROM ${capabilityTable}`,
  )
  const capabilityKeys = new Set(capabilityRows.map((row) => `${row.kind}:${row.capability_key}`))
  const [bindingRows] = await pool.query<RowDataPacket[]>(
    `SELECT c.kind, c.capability_key
       FROM ${bindingTable} b JOIN ${capabilityTable} c ON c.id=b.capability_id
      WHERE b.scope_type='global' AND b.scope_key='*'`,
  )
  const bindingKeys = new Set(bindingRows.map((row) => `${row.kind}:${row.capability_key}`))
  const [jobRows] = await pool.query<RowDataPacket[]>(`SELECT id FROM ${jobsTable}`)
  const jobIds = new Set(jobRows.map((row) => String(row.id)))
  const [ledgerRows] = await pool.query<RowDataPacket[]>(
    `SELECT status, source_sha256 FROM ${migrationRunsTable} WHERE id=? LIMIT 1`,
    [runId],
  )
  return {
    templateChanges: templates.filter((item) => !sameTemplate(templateByType.get(item.type), item)).length,
    missingCapabilities: capabilities.filter((item) => !capabilityKeys.has(`${item.kind}:${item.capabilityKey}`)).length,
    missingGlobalBindings: capabilities.filter((item) => !bindingKeys.has(`${item.kind}:${item.capabilityKey}`)).length,
    missingJobs: jobs.filter((item) => !jobIds.has(item.id)).length,
    ledgerCurrent: ledgerRows[0]?.status === 'completed' && ledgerRows[0]?.source_sha256 === manifestSha256,
  }
}

async function applySeed() {
  const connection = await pool.getConnection()
  const lockName = `cybernaut-seed-${createHash('sha256')
    .update(`${mysqlConfig.database}:${mysqlConfig.tablePrefix}`)
    .digest('hex')
    .slice(0, 32)}`
  let lockAcquired = false
  try {
    const [lockRows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 60) AS acquired', [lockName])
    lockAcquired = Number(lockRows[0]?.acquired || 0) === 1
    if (!lockAcquired) throw new Error('[mysql seed] timed out waiting for seed lock')

    await ensureBuiltinCapabilityCatalog()
    await seedRuntimeJobDefinitions()

    await connection.beginTransaction()
    try {
      for (const item of templates) {
        await connection.query(
          `INSERT INTO ${templateTable}
            (type, label, template_version, skill_name, output_format, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NOW(3), NOW(3))
           ON DUPLICATE KEY UPDATE label=VALUES(label), template_version=VALUES(template_version),
             skill_name=VALUES(skill_name), output_format=VALUES(output_format),
             status=VALUES(status), updated_at=NOW(3)`,
          [item.type, item.label, item.templateVersion, item.skillName, item.outputFormat, item.status],
        )
      }
      const counts = { templates: templates.length, capabilities: capabilities.length, jobs: jobs.length }
      const report = {
        seedVersion: SEED_VERSION,
        manifestSha256,
        demoUsersSeeded: false,
        canonicalTemplatesUpserted: templates.length,
        missingCapabilitiesAndGlobalBindingsInserted: true,
        runtimeJobDefinitionsReconciled: true,
      }
      await connection.query(
        `INSERT INTO ${migrationRunsTable}
          (id, migration_type, source_locator, source_sha256, mode, status,
           source_counts, target_counts, source_checksum, target_checksum, report, started_at, completed_at)
         VALUES (?, 'mysql-system-seed', ?, ?, 'apply', 'completed', ?, ?, ?, ?, ?, NOW(3), NOW(3))
         ON DUPLICATE KEY UPDATE source_locator=VALUES(source_locator), source_sha256=VALUES(source_sha256),
           mode='apply', status='completed', source_counts=VALUES(source_counts), target_counts=VALUES(target_counts),
           source_checksum=VALUES(source_checksum), target_checksum=VALUES(target_checksum), report=VALUES(report),
           completed_at=NOW(3)`,
        [
          runId,
          `bundled:${SEED_VERSION}`,
          manifestSha256,
          JSON.stringify(counts),
          JSON.stringify(counts),
          manifestSha256,
          manifestSha256,
          JSON.stringify(report),
        ],
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    }
  } finally {
    if (lockAcquired) await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined)
    connection.release()
  }
}

try {
  await assertSchemaReady()
  const before = await inspectCurrent()
  if (apply) await applySeed()
  const after = await inspectCurrent()
  if (apply && (after.templateChanges || after.missingCapabilities || after.missingGlobalBindings || after.missingJobs || !after.ledgerCurrent)) {
    throw new Error('[mysql seed] post-apply verification failed')
  }
  console.log(JSON.stringify({
    ok: true,
    mode: apply ? 'apply' : 'preview',
    seedVersion: SEED_VERSION,
    manifestSha256,
    planned: {
      templates: templates.length,
      capabilities: capabilities.length,
      runtimeJobs: jobs.length,
      demoUsers: 0,
    },
    before,
    after,
  }))
} finally {
  await pool.end()
}
