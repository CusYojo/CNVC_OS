import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pool } from '../db/client.js'
import {
  validateLeadDuplicateDispositions, type LeadDuplicateDispositionFile,
} from './leadDuplicateDispositionContract.js'
import { loadCurrentLeadDuplicateDispositionContext } from './leadDuplicateDispositionRuntime.js'

const decisionPath = path.resolve(process.env.LEAD_DUPLICATE_DECISION_FILE
  || '.runtime/migration-decisions/lead-duplicate-dispositions.json')
const outputDirectory = path.resolve('.runtime/migration-evidence/lead-duplicate-dispositions')
const strict = process.argv.includes('--strict')

async function main() {
  const stat = await lstat(decisionPath)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('LEAD_DUPLICATE_DECISION_FILE_MUST_BE_OWNER_ONLY_REGULAR_FILE')
  }
  const file = JSON.parse(await readFile(decisionPath, 'utf8')) as LeadDuplicateDispositionFile
  const context = await loadCurrentLeadDuplicateDispositionContext()
  const result = validateLeadDuplicateDispositions({ file, expected: context.expected, strict })
  const invalidErrors = result.errors.filter((error) => error !== 'PENDING_DECISIONS')
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  const report = {
    schemaVersion: '1.0', generatedAt: new Date().toISOString(), mode: strict ? 'strict' : 'preview',
    ...result, normalizationReportSha256: context.reportSha256,
    collisionSignature: context.collisionSignature, databaseWrites: 0,
  }
  await writeFile(path.join(outputDirectory, 'validation-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({
    ok: invalidErrors.length === 0 && (!strict || result.ready), mode: report.mode,
    collisionGroups: result.collisionGroups, collisionRecordOccurrences: result.collisionRecordOccurrences,
    uniqueLeadRecords: result.uniqueLeadRecords, pendingGroups: result.pendingGroups,
    decidedGroups: result.decidedGroups, errors: result.errors, databaseWrites: 0,
  }))
  if (invalidErrors.length > 0) process.exitCode = 3
  else if (strict && !result.ready) process.exitCode = 2
}

await main().finally(async () => pool.end())
