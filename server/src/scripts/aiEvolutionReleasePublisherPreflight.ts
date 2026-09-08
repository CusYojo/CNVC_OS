import path from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { pool } from '../db/client.js'
import { mysqlConfig } from '../db/config.js'
import { loadAiEvolutionReleaseTargetsFile } from '../services/aiEvolutionReleaseRegistry.js'
import { loadEvolutionPublisherLifecycleConfig } from '../services/aiEvolutionPublisherLifecycleRegistry.js'
import { validateEvolutionPublisherPreflight } from '../services/aiEvolutionPublisherPreflight.js'

const secureFile = async (name: string, value: string | undefined) => {
  if (!value || !path.isAbsolute(value)) throw Error(`${name} must be an absolute path`)
  const source = await lstat(value), actual = await realpath(value), info = await lstat(actual)
  if (source.isSymbolicLink() || actual !== path.resolve(value) || !info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw Error(`${name} must be a private regular file`)
  }
  return actual
}
try {
  const [targetsFile, lifecycleFile] = await Promise.all([
    secureFile('AI_EVOLUTION_RELEASE_TARGETS_FILE', process.env.AI_EVOLUTION_RELEASE_TARGETS_FILE),
    secureFile('AI_EVOLUTION_PUBLISHER_LIFECYCLE_FILE', process.env.AI_EVOLUTION_PUBLISHER_LIFECYCLE_FILE),
  ])
  const [release, lifecycle] = await Promise.all([loadAiEvolutionReleaseTargetsFile(), loadEvolutionPublisherLifecycleConfig()])
  const roots = await Promise.all(release.targets.map(async target => ({ id: target.id, root: await realpath(target.root) })))
  const table = `${mysqlConfig.tablePrefix}ai_evolution_release_jobs`
  const [columns] = await pool.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [table])
  const actualColumns = (columns as { COLUMN_NAME: string }[]).map(row => row.COLUMN_NAME)
  const [indexes] = await pool.query(`SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, [table])
  validateEvolutionPublisherPreflight({ release, lifecycle, columns: actualColumns,
    indexes: (indexes as { INDEX_NAME: string }[]).map(row => row.INDEX_NAME), table })
  console.log(JSON.stringify({ ok: true, databaseTable: table, targets: roots, targetsFile, lifecycleFile, databaseWrites: 0, processMutation: false }))
} finally { await pool.end() }
