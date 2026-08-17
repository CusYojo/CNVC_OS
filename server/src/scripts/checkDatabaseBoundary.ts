import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const sourceRoot = path.resolve('server/src')
const allowedLegacyTools = new Set([
  path.resolve('server/src/scripts/postgresInventory.ts'),
  path.resolve('server/src/scripts/migratePostgresToMySql.ts'),
  path.resolve('server/src/scripts/migratePostgresDumpToMySql.ts'),
  path.resolve('server/src/scripts/installPostgresCdc.ts'),
  path.resolve('server/src/scripts/migratePostgresCdcToMySql.ts'),
  path.resolve('server/src/scripts/mysqlMigrationReconciliationAudit.ts'),
])
const forbidden = [
  { label: 'PostgreSQL driver import', pattern: /from\s+['"]pg['"]/ },
  { label: 'PostgreSQL Drizzle adapter', pattern: /drizzle-orm\/(?:node-postgres|pg-core)/ },
  { label: 'legacy runtime DATABASE_URL', pattern: /DATABASE_URL/ },
  { label: 'PostgreSQL RETURNING', pattern: /\.returning\s*\(/ },
  { label: 'PostgreSQL JSONB SQL', pattern: /(?:jsonb_|::jsonb)/i },
]

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return filesUnder(target)
    return entry.isFile() && target.endsWith('.ts') ? [target] : []
  }))
  return nested.flat()
}

const violations: Array<{ file: string; rule: string }> = []
for (const file of await filesUnder(sourceRoot)) {
  if (file === path.resolve('server/src/scripts/checkDatabaseBoundary.ts')) continue
  if (allowedLegacyTools.has(file)) continue
  const source = await readFile(file, 'utf8')
  for (const rule of forbidden) {
    if (rule.pattern.test(source)) violations.push({ file: path.relative('.', file), rule: rule.label })
  }
}

if (violations.length > 0) {
  console.error(JSON.stringify({ ok: false, violations }, null, 2))
  process.exitCode = 1
} else {
  console.log(JSON.stringify({ ok: true, legacyPostgresAllowlist: [...allowedLegacyTools].map((file) => path.relative('.', file)) }))
}
