import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'

test('isolated MySQL installs skill version, binding and atomic history constraints',
  { skip: process.env.EVOLUTION_ISOLATED_MYSQL_TEST !== 'true' }, async () => {
  assert.equal(process.env.DB_HOST, '127.0.0.1'); assert.equal(process.env.DB_PORT, '43318')
  assert.equal(process.env.DB_DATABASE, 'evolution_isolated_test'); assert.equal(process.env.DB_USERNAME, 'evolution_test')
  assert.equal(process.env.DB_FREFIX, 'evo_test_')
  const { pool } = await import('../src/db/client.js')
  try {
    const migration = await readFile('server/drizzle/0105_add_ai_evolution_skill_versions.sql', 'utf8')
    for (const statement of migration.replaceAll('`sbl_', '`evo_test_').split(';').map(value => value.trim()).filter(Boolean)) {
      await pool.query(statement.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '))
    }
    const [columns] = await pool.query("SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'evo_test_ai_evolution_skill_%'")
    const found = new Set((columns as { TABLE_NAME: string; COLUMN_NAME: string }[]).map(row => `${row.TABLE_NAME}.${row.COLUMN_NAME}`))
    for (const name of ['versions.content', 'versions.package_artifact', 'bindings.active_version_id', 'bindings.fallback_version_id',
      'bindings.trial_expires_at', 'binding_changes.input_hash', 'binding_changes.approval_id']) assert.ok(found.has(`evo_test_ai_evolution_skill_${name}`))
    const [indexes] = await pool.query("SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'evo_test_ai_evolution_skill_%' AND NON_UNIQUE=0")
    const names = new Set((indexes as { INDEX_NAME: string }[]).map(row => row.INDEX_NAME))
    for (const name of ['uq_evo_skill_content', 'uq_evo_skill_scope', 'uq_evo_skill_change_request', 'uq_evo_skill_change_revision']) assert.ok(names.has(name))
  } finally { await pool.end() }
})
