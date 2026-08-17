import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { db, pool } from '../db/client.js'
import { projectFiles, projects } from '../db/schema.js'
import { eq, isNull } from 'drizzle-orm'
import { decodeAndValidateProjectFile } from '../security/projectFileValidation.js'
import { attachRecoveredProjectFile } from '../services/projectService.js'
import { removeProjectFile, saveProjectFileRevision } from '../services/projectFileStorageService.js'

type Candidate = {
  path: string
  byteSize: number
  sha256?: string
  sizeMatches: boolean
  valid: boolean
  validationError?: string
}

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'server-dist', '.runtime'])
const managedFileRoots = new Set([
  'server/project-files', 'server/generated', 'server/ai-artifacts', 'server/workspace',
].map((value) => path.resolve(process.cwd(), value)))

function cliRoots() {
  const roots: string[] = []
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === '--root' && process.argv[index + 1]) roots.push(path.resolve(process.argv[++index]))
  }
  if (roots.length) return roots
  const configured = process.env.PROJECT_FILE_SOURCE_ROOTS?.split(path.delimiter).map((value) => value.trim()).filter(Boolean)
  return configured?.length
    ? configured.map((value) => path.resolve(value))
    : [path.resolve(process.cwd(), '../files'), process.cwd()]
}

function recordedSizeMatches(recorded: string | null, byteSize: number) {
  const match = recorded?.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB)$/i)
  if (!match) return false
  const value = Number(match[1])
  const unit = match[2].toUpperCase()
  const divisor = unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 1
  const decimals = (match[1].split('.')[1] || '').length
  const tolerance = divisor * (0.5 * 10 ** -decimals)
  return Math.abs(byteSize - value * divisor) <= tolerance
}

async function filesByBasename(roots: string[], wanted: Set<string>) {
  const result = new Map<string, string[]>()
  async function walk(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const absolute = path.resolve(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name) && !managedFileRoots.has(absolute)) await walk(absolute)
      } else if (entry.isFile() && wanted.has(entry.name.normalize('NFC'))) {
        const key = entry.name.normalize('NFC')
        result.set(key, [...(result.get(key) || []), absolute])
      }
    }
  }
  for (const root of roots) await walk(root)
  return result
}

async function main() {
  const apply = process.argv.includes('--apply')
  const includeAttached = process.argv.includes('--include-attached')
  const requestedRoots = cliRoots()
  const roots: string[] = []
  for (const root of requestedRoots) {
    const info = await stat(root).catch(() => null)
    if (info?.isDirectory()) roots.push(await realpath(root))
  }
  if (!roots.length) throw new Error('没有可读取的项目原文件源目录；请使用 --root 或 PROJECT_FILE_SOURCE_ROOTS')
  const baseQuery = db.select({
    fileId: projectFiles.id, projectId: projectFiles.projectId, projectName: projects.name,
    name: projectFiles.name, type: projectFiles.type, recordedSize: projectFiles.size,
    version: projectFiles.version, uploadedBy: projectFiles.uploadedBy,
    storagePath: projectFiles.storagePath, currentByteSize: projectFiles.byteSize, currentSha256: projectFiles.sha256,
  }).from(projectFiles).innerJoin(projects, eq(projectFiles.projectId, projects.id))
  const rows = includeAttached ? await baseQuery : await baseQuery.where(isNull(projectFiles.storagePath))
  const pathsByName = await filesByBasename(roots, new Set(rows.map((row) => row.name.normalize('NFC'))))
  const findings = []
  for (const row of rows) {
    const candidates: Candidate[] = []
    for (const candidatePath of pathsByName.get(row.name.normalize('NFC')) || []) {
      const buffer = await readFile(candidatePath)
      try {
        const validated = await decodeAndValidateProjectFile({
          name: row.name, dataBase64: buffer.toString('base64'), declaredType: row.type,
        })
        candidates.push({
          path: candidatePath, byteSize: validated.byteSize, sha256: validated.sha256,
          sizeMatches: recordedSizeMatches(row.recordedSize, validated.byteSize), valid: true,
        })
      } catch (error) {
        candidates.push({
          path: candidatePath, byteSize: buffer.length, sizeMatches: recordedSizeMatches(row.recordedSize, buffer.length),
          valid: false, validationError: `${(error as Error & { code?: string }).code || 'VALIDATION_ERROR'}: ${(error as Error).message}`,
        })
      }
    }
    const verified = candidates.filter((candidate) => candidate.valid && candidate.sizeMatches && candidate.sha256)
    const hashes = new Set(verified.map((candidate) => candidate.sha256))
    const candidateStatus = !candidates.length ? 'not_found'
      : !verified.length ? 'no_verified_size_match'
        : hashes.size > 1 ? 'ambiguous_content'
          : 'unique_verified'
    const selected = candidateStatus === 'unique_verified'
      ? verified.sort((left, right) => roots.findIndex((root) => left.path.startsWith(root)) - roots.findIndex((root) => right.path.startsWith(root)) || left.path.localeCompare(right.path))[0]
      : undefined
    const status = row.storagePath
      ? selected && selected.sha256 === row.currentSha256 && selected.byteSize === row.currentByteSize
        ? 'attached_verified'
        : `attached_${candidateStatus}`
      : candidateStatus
    let applied = false
    let applyError: string | undefined
    let targetStoragePath = row.storagePath || undefined
    if (apply && selected && !row.storagePath) {
      if (!row.uploadedBy) applyError = 'MISSING_STABLE_UPLOADER'
      else {
        const buffer = await readFile(selected.path)
        const storagePath = await saveProjectFileRevision(row.projectId, row.fileId, buffer)
        targetStoragePath = storagePath
        try {
          await attachRecoveredProjectFile(
            row.fileId, storagePath, `${(buffer.length / 1024 / 1024).toFixed(2)} MB`,
            buffer.length, selected.sha256!, row.uploadedBy,
          )
          applied = true
        } catch (error) {
          await removeProjectFile(storagePath).catch(() => {})
          applyError = `${(error as Error & { code?: string }).code || 'APPLY_ERROR'}: ${(error as Error).message}`
        }
      }
    }
    findings.push({ ...row, status, selectedPath: selected?.path, selectedSha256: selected?.sha256, targetStoragePath, candidates, applied, applyError })
  }
  const report = {
    generatedAt: new Date().toISOString(), mode: apply ? 'apply' : 'preview', roots,
    records: findings.length,
    uniqueVerified: findings.filter((item) => item.status === 'unique_verified').length,
    attachedVerified: findings.filter((item) => item.status === 'attached_verified').length,
    ambiguous: findings.filter((item) => item.status === 'ambiguous_content').length,
    notFound: findings.filter((item) => item.status === 'not_found').length,
    noVerifiedSizeMatch: findings.filter((item) => item.status === 'no_verified_size_match').length,
    applied: findings.filter((item) => item.applied).length,
    applyErrors: findings.filter((item) => item.applyError).length,
    findings,
  }
  const evidenceDir = path.resolve('.runtime/migration-evidence/project-files')
  await mkdir(evidenceDir, { recursive: true })
  const reportJson = `${JSON.stringify(report, null, 2)}\n`
  const timestamp = report.generatedAt.replace(/[:.]/g, '-')
  await writeFile(path.join(evidenceDir, `source-discovery-${timestamp}-${report.mode}.json`), reportJson, { mode: 0o600 })
  await writeFile(path.join(evidenceDir, 'source-discovery.json'), reportJson, { mode: 0o600 })
  const ledgerPath = path.join(evidenceDir, 'source-recovery-ledger.json')
  const priorLedger = await readFile(ledgerPath, 'utf8').then((value) => JSON.parse(value) as { mappings?: unknown[] }).catch(() => ({ mappings: [] }))
  const mappings = [...(priorLedger.mappings || [])] as Array<Record<string, unknown>>
  for (const finding of findings.filter((item) => item.applied || item.status === 'attached_verified')) {
    const mapping = {
      fileId: finding.fileId, projectId: finding.projectId, projectName: finding.projectName, name: finding.name,
      sourcePath: finding.selectedPath, targetStoragePath: finding.targetStoragePath,
      byteSize: finding.candidates.find((candidate) => candidate.path === finding.selectedPath)?.byteSize,
      sha256: finding.selectedSha256, verifiedAt: report.generatedAt,
      evidence: 'exact-name+recorded-size+content-signature+unique-sha256',
    }
    const index = mappings.findIndex((item) => item.fileId === mapping.fileId && item.sha256 === mapping.sha256)
    if (index >= 0) mappings[index] = mapping
    else mappings.push(mapping)
  }
  await writeFile(ledgerPath, `${JSON.stringify({ updatedAt: report.generatedAt, mappings }, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({
    ok: true, releaseReady: report.records > 0 && report.uniqueVerified + report.attachedVerified === report.records,
    records: report.records, uniqueVerified: report.uniqueVerified, attachedVerified: report.attachedVerified, ambiguous: report.ambiguous,
    notFound: report.notFound, noVerifiedSizeMatch: report.noVerifiedSizeMatch,
    applied: report.applied, applyErrors: report.applyErrors,
  }))
}

await main().finally(async () => pool.end())
