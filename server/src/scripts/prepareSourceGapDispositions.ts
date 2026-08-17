import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pool } from '../db/client.js'
import { createPendingSourceGapDisposition } from './sourceGapDispositionContract.js'
import { collectCurrentSourceGaps, parseSourceGapDisposition } from './sourceGapDispositionRuntime.js'

const refreshPending = process.argv.includes('--refresh-pending')
const target = path.resolve(
  process.env.SOURCE_GAP_DISPOSITIONS_FILE || '.runtime/migration-decisions/source-gap-dispositions.json',
)

async function main(): Promise<void> {
  const current = await collectCurrentSourceGaps()
  const existing = await lstat(target).catch(() => null)
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0) {
      throw new Error('existing source-gap disposition must be an owner-only regular file')
    }
    if (!refreshPending) throw new Error('source-gap disposition already exists; use --refresh-pending only before any approval')
    const previous = parseSourceGapDisposition(JSON.parse(await readFile(target, 'utf8')))
    if (previous.leadReserve.disposition !== 'pending' || previous.aiArtifacts.disposition !== 'pending'
      || previous.leadReserve.approvedBy || previous.aiArtifacts.approvedBy
      || previous.leadReserve.approvedAt || previous.aiArtifacts.approvedAt) {
      throw new Error('approved or partially approved source-gap disposition cannot be replaced')
    }
  }
  const document = createPendingSourceGapDisposition(current)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temporary, target)
  console.log(JSON.stringify({
    ok: true, mode: existing ? 'refresh-pending' : 'create',
    leadReserveGaps: current.leadReserve.length, aiArtifactGaps: current.aiArtifacts.length,
    dispositionsPending: 2, databaseWrites: 0, pathExcluded: true,
  }))
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, message: (error as Error).message }))
  process.exitCode = 1
}).finally(async () => pool.end())
