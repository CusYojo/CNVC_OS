import { createHash } from 'node:crypto'
import type { RowDataPacket } from 'mysql2/promise'

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
] = await Promise.all([
  import('../db/client.js'),
  import('../db/migrate.js'),
  import('../db/config.js'),
  import('../services/aiTemplateCatalog.js'),
])

const templates = AI_TASK_TYPES.map((type) => {
  const template = AI_TEMPLATE_CATALOG[type]
  return {
    type: template.type,
    label: template.label,
    templateVersion: template.templateVersion,
    skillName: template.skillName,
    outputFormat: template.outputFormat,
    status: 'enabled',
  }
})
const templateTable = quoteMysqlIdentifier(mysqlTableName('ai_task_templates'))

function matches(row: RowDataPacket | undefined, expected: typeof templates[number]) {
  return Boolean(row
    && row.label === expected.label
    && row.template_version === expected.templateVersion
    && row.skill_name === expected.skillName
    && row.output_format === expected.outputFormat
    && row.status === expected.status)
}

async function readRegistry() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT type, label, template_version, skill_name, output_format, status FROM ${templateTable}`,
  )
  return new Map(rows.map((row) => [String(row.type), row]))
}

try {
  await assertSchemaReady()
  const before = await readRegistry()
  const changedTypes = templates
    .filter((template) => !matches(before.get(template.type), template))
    .map((template) => template.type)

  const connection = await pool.getConnection()
  const lockName = `cybernaut-ai-template-sync-${createHash('sha256')
    .update(`${mysqlConfig.database}:${mysqlConfig.tablePrefix}`)
    .digest('hex')
    .slice(0, 24)}`
  let lockAcquired = false
  try {
    const [lockRows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 60) AS acquired', [lockName])
    lockAcquired = Number(lockRows[0]?.acquired || 0) === 1
    if (!lockAcquired) throw new Error('[ai template sync] timed out waiting for registry lock')
    await connection.beginTransaction()
    try {
      for (const template of templates) {
        await connection.query(
          `INSERT INTO ${templateTable}
            (type, label, template_version, skill_name, output_format, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NOW(3), NOW(3))
           ON DUPLICATE KEY UPDATE label=VALUES(label), template_version=VALUES(template_version),
             skill_name=VALUES(skill_name), output_format=VALUES(output_format),
             status=VALUES(status), updated_at=NOW(3)`,
          [
            template.type,
            template.label,
            template.templateVersion,
            template.skillName,
            template.outputFormat,
            template.status,
          ],
        )
      }
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    }
  } finally {
    if (lockAcquired) await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined)
    connection.release()
  }

  const after = await readRegistry()
  const mismatches = templates
    .filter((template) => !matches(after.get(template.type), template))
    .map((template) => template.type)
  if (mismatches.length) {
    throw new Error(`[ai template sync] post-apply verification failed: ${mismatches.join(',')}`)
  }
  console.log(JSON.stringify({
    ok: true,
    registeredTemplates: templates.length,
    changedTypes,
  }))
} finally {
  await pool.end()
}
