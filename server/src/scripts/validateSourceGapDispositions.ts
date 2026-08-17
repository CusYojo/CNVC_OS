import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pool } from '../db/client.js'
import { validateSourceGapDisposition } from './sourceGapDispositionContract.js'
import { collectCurrentSourceGaps, parseSourceGapDisposition } from './sourceGapDispositionRuntime.js'

const strict = process.argv.includes('--strict')
const target = path.resolve(
  process.env.SOURCE_GAP_DISPOSITIONS_FILE || '.runtime/migration-decisions/source-gap-dispositions.json',
)

async function main(): Promise<void> {
  const stat = await lstat(target)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('source-gap disposition must be an owner-only regular file')
  }
  const document = parseSourceGapDisposition(JSON.parse(await readFile(target, 'utf8')))
  const current = await collectCurrentSourceGaps()
  const errors = validateSourceGapDisposition(document, current, strict)
  const pendingDomains = [document.leadReserve, document.aiArtifacts]
    .filter((domain) => domain.disposition === 'pending').length
  const report = {
    ok: errors.length === 0,
    mode: strict ? 'strict' : 'preview',
    leadReserveGaps: current.leadReserve.length,
    aiArtifactGaps: current.aiArtifacts.length,
    pendingDomains,
    approvedDomains: 2 - pendingDomains,
    errors,
    databaseWrites: 0,
  }
  console.log(JSON.stringify(report))
  if (errors.length) process.exitCode = strict && pendingDomains > 0
    && errors.every((error) => error.includes('REQUIRED')) ? 2 : 1
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, message: (error as Error).message, databaseWrites: 0 }))
  process.exitCode = 1
}).finally(async () => pool.end())
