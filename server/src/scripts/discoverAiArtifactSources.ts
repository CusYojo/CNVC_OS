import { createHash, randomUUID } from 'node:crypto'
import { constants as fileConstants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { loadLegacyAiArtifactSources } from './postgresDumpAiArtifactSource.js'

type TargetArtifact = RowDataPacket & {
  id: string
  taskId: string
  userId: string
  projectId: string
  fileName: string
  format: string
  storagePath: string
  qualityStatus: string
  archived: number
  metadata: Record<string, unknown> | string
}

type Candidate = {
  path: string
  byteSize: number
  sha256?: string
  valid: boolean
  sizeMatches: boolean
  validationError?: string
}

const apply = process.argv.includes('--apply')
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'server-dist', '.runtime', '.venv'])
const artifactRoot = path.resolve(process.env.AI_ARTIFACT_ROOT || path.join(process.cwd(), 'server', 'ai-artifacts'))
const evidenceDirectory = path.resolve('.runtime/migration-evidence/missing-file-assets')

function table(name: string): string {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  }
  return {}
}

function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function cliRoots(): string[] {
  const roots: string[] = []
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === '--root' && process.argv[index + 1]) roots.push(path.resolve(process.argv[++index]))
  }
  const configured = process.env.AI_ARTIFACT_SOURCE_ROOTS?.split(path.delimiter).map((value) => value.trim()).filter(Boolean)
  return roots.length ? roots : configured?.length
    ? configured.map((value) => path.resolve(value))
    : [path.resolve(process.cwd(), '../files'), process.cwd()]
}

async function filesByBasename(roots: string[], wanted: Set<string>): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>()
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink()) continue
      const absolute = path.resolve(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name) && absolute !== artifactRoot) await walk(absolute)
      } else if (entry.isFile() && wanted.has(entry.name.normalize('NFC'))) {
        const key = entry.name.normalize('NFC')
        found.set(key, [...(found.get(key) || []), absolute])
      }
    }
  }
  for (const root of roots) await walk(root)
  return found
}

async function validateArtifact(buffer: Buffer, format: string): Promise<void> {
  if (format === 'md') {
    if (buffer.includes(0)) throw new Error('markdown contains NUL bytes')
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return
  }
  if (format === 'pdf') {
    if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('invalid PDF signature')
    return
  }
  if (format === 'png') {
    if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('invalid PNG signature')
    return
  }
  if (format === 'jpg' || format === 'jpeg') {
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) throw new Error('invalid JPEG signature')
    return
  }
  if (format === 'docx' || format === 'pptx' || format === 'xlsx') {
    const zip = await JSZip.loadAsync(buffer, { checkCRC32: true })
    const required = format === 'docx' ? 'word/document.xml'
      : format === 'pptx' ? 'ppt/presentation.xml'
        : 'xl/workbook.xml'
    if (!zip.file('[Content_Types].xml') || !zip.file(required)) throw new Error(`invalid ${format.toUpperCase()} package`)
    return
  }
  throw new Error(`unsupported artifact format: ${format}`)
}

async function writeEvidence(report: Record<string, unknown>): Promise<void> {
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
  const target = path.join(evidenceDirectory, 'source-discovery.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

async function main(): Promise<void> {
  const requestedRoots = cliRoots()
  const roots: string[] = []
  for (const root of requestedRoots) {
    const info = await stat(root).catch(() => null)
    if (info?.isDirectory()) roots.push(await realpath(root))
  }
  if (!roots.length) throw new Error('没有可读取的 AI 产物源目录；请使用 --root 或 AI_ARTIFACT_SOURCE_ROOTS')
  const source = await loadLegacyAiArtifactSources()
  const [rows] = await pool.query<TargetArtifact[]>(`
    SELECT id,task_id AS taskId,user_id AS userId,project_id AS projectId,file_name AS fileName,
      format,storage_path AS storagePath,quality_status AS qualityStatus,archived,metadata
    FROM ${table('ai_artifacts')} WHERE storage_path REGEXP '^/Users/[^/]+/' ORDER BY id
  `)
  const pathsByName = await filesByBasename(roots, new Set(rows.map((row) => row.fileName.normalize('NFC'))))
  const findings = []
  for (const row of rows) {
    const legacy = source.records.get(row.id)
    const metadata = objectValue(row.metadata)
    const expectedBytes = Number(metadata.bytes)
    const sourceIdentityMatches = Boolean(legacy)
      && sha256Text(legacy!.storagePath) === metadata.legacyStoragePathSha256
      && legacy!.taskId === row.taskId
      && legacy!.userId === row.userId
      && legacy!.projectId === row.projectId
      && legacy!.fileName === row.fileName
      && legacy!.format === row.format
    const candidates: Candidate[] = []
    for (const candidatePath of pathsByName.get(row.fileName.normalize('NFC')) || []) {
      const buffer = await readFile(candidatePath)
      const sizeMatches = Number.isInteger(expectedBytes) && expectedBytes >= 0 && buffer.length === expectedBytes
      try {
        await validateArtifact(buffer, row.format)
        candidates.push({ path: candidatePath, byteSize: buffer.length, sha256: sha256Buffer(buffer), valid: true, sizeMatches })
      } catch (error) {
        candidates.push({ path: candidatePath, byteSize: buffer.length, valid: false, sizeMatches, validationError: (error as Error).message })
      }
    }
    const verified = sourceIdentityMatches
      ? candidates.filter((candidate) => candidate.valid && candidate.sizeMatches && candidate.sha256)
      : []
    const hashes = new Set(verified.map((candidate) => candidate.sha256))
    const status = !sourceIdentityMatches ? 'source_identity_mismatch'
      : !candidates.length ? 'not_found'
        : !verified.length ? 'no_verified_size_match'
          : hashes.size > 1 ? 'ambiguous_content'
            : 'unique_verified'
    const selected = status === 'unique_verified'
      ? verified.sort((left, right) => left.path.localeCompare(right.path))[0]
      : undefined
    findings.push({ row, metadata, expectedBytes, sourceIdentityMatches, candidates, status, selected })
  }

  const recoverable = findings.filter((finding) => finding.status === 'unique_verified')
  const createdFiles: string[] = []
  let transactionStarted = false
  let runId: string | undefined
  if (apply && recoverable.length) {
    const connection = await pool.getConnection()
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
    try {
      for (const finding of recoverable) {
        const targetDirectory = path.resolve(artifactRoot, finding.row.userId, finding.row.projectId, finding.row.taskId)
        const targetPath = path.resolve(targetDirectory, finding.row.fileName)
        if (!targetPath.startsWith(`${artifactRoot}${path.sep}`)) throw new Error('unsafe AI artifact recovery target')
        await mkdir(targetDirectory, { recursive: true, mode: 0o700 })
        const existing = await lstat(targetPath).catch(() => null)
        if (existing) {
          if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`unsafe existing recovery target: ${finding.row.id}`)
          const existingHash = sha256Buffer(await readFile(targetPath))
          if (existingHash !== finding.selected!.sha256) throw new Error(`recovery target collision: ${finding.row.id}`)
        } else {
          await copyFile(finding.selected!.path, targetPath, fileConstants.COPYFILE_EXCL)
          await chmod(targetPath, 0o600)
          createdFiles.push(targetPath)
        }
        Object.assign(finding, { targetPath })
      }

      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      await connection.beginTransaction()
      transactionStarted = true
      for (const finding of recoverable) {
        const legacy = source.records.get(finding.row.id)!
        const recoveredAt = new Date().toISOString()
        const nextMetadata = {
          ...finding.metadata,
          migrationDisposition: 'source-file-recovered',
          recoveredAt,
          recoveredByteSize: finding.selected!.byteSize,
          recoveredSha256: finding.selected!.sha256,
          recoveredSourcePathSha256: sha256Text(finding.selected!.path),
        }
        const [result] = await connection.query<ResultSetHeader>(`
          UPDATE ${table('ai_artifacts')} SET storage_path=?,quality_status=?,archived=?,metadata=?
          WHERE id=? AND storage_path=? AND archived=1 AND quality_status='failed'
        `, [
          (finding as typeof finding & { targetPath: string }).targetPath,
          String(finding.metadata.legacyQualityStatus || legacy.qualityStatus),
          Boolean(finding.metadata.legacyArchived ?? legacy.archived) ? 1 : 0,
          JSON.stringify(nextMetadata), finding.row.id, finding.row.storagePath,
        ])
        if (result.affectedRows !== 1) throw new Error(`AI artifact recovery baseline changed: ${finding.row.id}`)
      }
      runId = randomUUID()
      const reportForLedger = {
        schemaVersion: '1.0', generatedAt: new Date().toISOString(), mode: 'apply', sourceSha256: source.sourceSha256,
        counts: { artifacts: rows.length, recovered: recoverable.length },
      }
      await connection.query(`
        INSERT INTO ${table('migration_runs')}
          (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,
           source_checksum,target_checksum,report,started_at,completed_at)
        VALUES (?,'ai-artifact-source-recovery','configured-source-roots',?,'apply','succeeded',?,?,?,?,?,NOW(3),NOW(3))
      `, [
        runId, source.sourceSha256,
        JSON.stringify({ legacy_artifacts: rows.length, verified_candidates: recoverable.length }),
        JSON.stringify({ recovered_artifacts: recoverable.length }),
        source.sourceSha256, source.sourceSha256, JSON.stringify(reportForLedger),
      ])
      await connection.commit()
      transactionStarted = false
    } catch (error) {
      if (transactionStarted) await connection.rollback().catch(() => undefined)
      await Promise.all(createdFiles.map((file) => unlink(file).catch(() => undefined)))
      throw error
    } finally {
      connection.release()
    }
  }

  const report = {
    schemaVersion: '1.0', generatedAt: new Date().toISOString(), mode: apply ? 'apply' : 'preview',
    sourceSha256: source.sourceSha256, roots: roots.map((root) => ({ pathSha256: sha256Text(root) })),
    counts: {
      artifacts: rows.length,
      uniqueVerified: recoverable.length,
      notFound: findings.filter((finding) => finding.status === 'not_found').length,
      noVerifiedSizeMatch: findings.filter((finding) => finding.status === 'no_verified_size_match').length,
      ambiguous: findings.filter((finding) => finding.status === 'ambiguous_content').length,
      sourceIdentityMismatch: findings.filter((finding) => finding.status === 'source_identity_mismatch').length,
      recovered: apply ? recoverable.length : 0,
    },
    findings: findings.map((finding) => ({
      id: finding.row.id, fileName: finding.row.fileName, format: finding.row.format,
      expectedBytes: finding.expectedBytes, sourceIdentityMatches: finding.sourceIdentityMatches,
      status: finding.status,
      candidates: finding.candidates.map((candidate) => ({
        pathSha256: sha256Text(candidate.path), byteSize: candidate.byteSize, sha256: candidate.sha256,
        valid: candidate.valid, sizeMatches: candidate.sizeMatches, validationError: candidate.validationError,
      })),
    })),
    ok: true, applied: apply && recoverable.length > 0, runId,
  }
  await writeEvidence(report)
  console.log(JSON.stringify({ ok: true, mode: report.mode, ...report.counts }))
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, message: (error as Error).message }))
  process.exitCode = 1
}).finally(async () => pool.end())
