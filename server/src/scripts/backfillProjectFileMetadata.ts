import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { projectFiles, projectFileVersions } from '../db/schema.js'
import { openProjectFile } from '../services/projectFileStorageService.js'

type FileDigest = { byteSize: number; sha256: string }
type Issue = { code: string; fileId: string; projectId: string; storagePath?: string; details?: string }

async function digestStoredFile(storagePath: string): Promise<FileDigest> {
  const opened = await openProjectFile(storagePath)
  const hash = createHash('sha256')
  let byteSize = 0
  for await (const chunk of opened.stream) {
    const buffer = Buffer.from(chunk)
    byteSize += buffer.length
    hash.update(buffer)
  }
  if (byteSize !== opened.size) throw new Error(`stored byte count changed during read: ${storagePath}`)
  return { byteSize, sha256: hash.digest('hex') }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const files = await db.select().from(projectFiles)
  const versions = await db.select().from(projectFileVersions)
  const digestByPath = new Map<string, FileDigest>()
  const issues: Issue[] = []
  const paths = [...new Set([
    ...files.map((row) => row.storagePath), ...versions.map((row) => row.storagePath),
  ].filter((value): value is string => Boolean(value)))]
  for (const storagePath of paths) {
    try { digestByPath.set(storagePath, await digestStoredFile(storagePath)) }
    catch (error) {
      const file = files.find((row) => row.storagePath === storagePath)
      issues.push({
        code: 'MISSING_OR_UNSAFE_ORIGINAL', fileId: file?.id || '', projectId: file?.projectId || '', storagePath,
        details: (error as Error).message,
      })
    }
  }

  if (apply) {
    await db.transaction(async (tx) => {
      for (const version of versions) {
        const digest = digestByPath.get(version.storagePath)
        if (digest && (version.byteSize !== digest.byteSize || version.sha256 !== digest.sha256)) {
          await tx.update(projectFileVersions).set(digest).where(eq(projectFileVersions.id, version.id))
        }
      }
      for (const file of files) {
        if (!file.storagePath) continue
        const digest = digestByPath.get(file.storagePath)
        if (!digest) continue
        await tx.update(projectFiles).set(digest).where(eq(projectFiles.id, file.id))
        const existingVersion = versions.find((row) => (
          row.fileId === file.id && row.version === file.version && row.storagePath === file.storagePath
        ))
        if (!existingVersion) {
          await tx.insert(projectFileVersions).values({
            fileId: file.id, version: file.version, ...digest, storagePath: file.storagePath, createdBy: file.uploadedBy,
          })
        }
      }
    })
  }

  const currentDigests = files.flatMap((file) => {
    const digest = file.storagePath ? digestByPath.get(file.storagePath) : undefined
    return digest ? [{ file, digest }] : []
  })
  const duplicateGroups = new Map<string, typeof currentDigests>()
  for (const item of currentDigests) {
    const key = `${item.file.projectId}\u0000${item.digest.sha256}`
    duplicateGroups.set(key, [...(duplicateGroups.get(key) || []), item])
  }
  for (const group of duplicateGroups.values()) {
    if (group.length < 2) continue
    for (const item of group) issues.push({
      code: 'DUPLICATE_PROJECT_CONTENT', fileId: item.file.id, projectId: item.file.projectId,
      storagePath: item.file.storagePath || undefined, details: `same SHA-256 appears in ${group.length} project files`,
    })
  }
  for (const file of files.filter((row) => !row.storagePath)) {
    issues.push({ code: 'NO_ORIGINAL_CONTENT', fileId: file.id, projectId: file.projectId })
  }

  const report = {
    generatedAt: new Date().toISOString(), mode: apply ? 'apply' : 'preview',
    files: files.length, versions: versions.length, storedPaths: paths.length,
    verifiedPaths: digestByPath.size,
    metadataUpdates: currentDigests.filter(({ file, digest }) => file.byteSize !== digest.byteSize || file.sha256 !== digest.sha256).length,
    duplicateProjectGroups: [...duplicateGroups.values()].filter((group) => group.length > 1).length,
    issues,
  }
  const evidenceDir = path.resolve('.runtime/migration-evidence/project-files')
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(path.join(evidenceDir, 'metadata-backfill.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ ok: true, releaseReady: issues.length === 0, ...report, issues: issues.length }))
}

await main().finally(async () => pool.end())
