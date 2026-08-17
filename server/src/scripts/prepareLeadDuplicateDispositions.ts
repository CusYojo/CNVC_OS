import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pool } from '../db/client.js'
import type { LeadDuplicateDispositionFile } from './leadDuplicateDispositionContract.js'
import { loadCurrentLeadDuplicateDispositionContext } from './leadDuplicateDispositionRuntime.js'

const outputPath = path.resolve(process.env.LEAD_DUPLICATE_DECISION_FILE
  || '.runtime/migration-decisions/lead-duplicate-dispositions.json')
const replacePending = process.argv.includes('--replace-pending')

async function existingFileIsPendingOnly() {
  try {
    const stat = await lstat(outputPath)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('LEAD_DUPLICATE_DECISION_PATH_UNSAFE')
    const current = JSON.parse(await readFile(outputPath, 'utf8')) as LeadDuplicateDispositionFile
    return Array.isArray(current.groups) && current.groups.every((group) => group.decision?.action === 'pending')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function main() {
  const existingPendingOnly = await existingFileIsPendingOnly()
  if (existingPendingOnly !== null && (!replacePending || !existingPendingOnly)) {
    throw new Error(existingPendingOnly
      ? 'LEAD_DUPLICATE_PENDING_TEMPLATE_EXISTS_USE_REPLACE_PENDING'
      : 'LEAD_DUPLICATE_DECISIONS_EXIST_REFUSING_OVERWRITE')
  }
  const context = await loadCurrentLeadDuplicateDispositionContext()
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${outputPath}.tmp-${process.pid}`
  await writeFile(temporaryPath, `${JSON.stringify(context.expected, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temporaryPath, outputPath)
  console.log(JSON.stringify({
    ok: true,
    mode: 'prepare-pending-review',
    collisionGroups: context.expected.scope.collisionGroups,
    collisionRecordOccurrences: context.expected.scope.collisionRecordOccurrences,
    uniqueLeadRecords: context.expected.scope.uniqueLeadRecords,
    pendingGroups: context.expected.groups.length,
    outputPath,
    databaseWrites: 0,
  }))
}

await main().finally(async () => pool.end())
