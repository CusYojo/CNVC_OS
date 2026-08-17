import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const backupRoot = path.resolve(
  process.env.MIGRATION_BACKUP_ROOT || '/Users/hyw/Desktop/sbl_jedi-migration-backup-20260808',
)
const backupDir = path.join(backupRoot, 'file-assets')
const archivePath = path.join(backupDir, 'current-file-assets.tar')
const outputDir = path.resolve('.runtime/migration-evidence/file-asset-backup')
const maxFiles = Number(process.env.FILE_BACKUP_MAX_FILES || 250_000)

type ManifestFile = {
  root: string
  relativePath: string
  bytes: number
  modifiedAt: string
  mode: string
  sha256: string
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function configuredRoots(): Array<{ key: string; absolutePath: string }> {
  const workspace = path.resolve(process.env.AGENT_WORKSPACE?.trim() || 'server/workspace')
  const candidates = [
    { key: 'project-files', absolutePath: path.resolve(process.env.PROJECT_FILE_ROOT || 'server/project-files') },
    { key: 'ai-artifacts', absolutePath: path.resolve(process.env.AI_ARTIFACT_ROOT || 'server/ai-artifacts') },
    { key: 'ai-template-data', absolutePath: path.resolve(process.env.AI_CUSTOM_TEMPLATE_DATA_ROOT || process.env.AI_CUSTOM_TEMPLATE_ROOT || 'server/ai-template-data') },
    { key: 'legacy-template-skills', absolutePath: path.resolve('server/ai-template-skills') },
    { key: 'generated', absolutePath: path.resolve('server/generated') },
    { key: 'workspace', absolutePath: workspace },
    { key: 'jw-agent-workspace', absolutePath: path.resolve(process.env.AGENT_WORKSPACE?.trim() || 'server/agent-workspace') },
    { key: 'radar-data', absolutePath: path.resolve(process.env.RADAR_DATA_DIR?.trim() || 'project-discovery/data') },
    { key: 'skills', absolutePath: path.resolve(process.env.AI_SKILL_ROOT?.trim() || path.join(workspace, '.agents/skills')) },
    { key: 'server-assets', absolutePath: path.resolve('server/assets') },
  ]
  const unique = [...new Map(candidates.map((candidate) => [candidate.absolutePath, candidate])).values()]
  return unique.filter((candidate) => !unique.some((parent) => (
    parent !== candidate && isInside(parent.absolutePath, candidate.absolutePath)
  )))
}

async function existingRoots(): Promise<Array<{ key: string; absolutePath: string; archivePath: string }>> {
  const result: Array<{ key: string; absolutePath: string; archivePath: string }> = []
  for (const candidate of configuredRoots()) {
    const metadata = await lstat(candidate.absolutePath).catch(() => null)
    if (!metadata) continue
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`[file-asset-backup] unsafe root: ${candidate.key}`)
    }
    if (!isInside(root, candidate.absolutePath)) {
      throw new Error(`[file-asset-backup] local rehearsal only accepts roots inside the project: ${candidate.key}`)
    }
    result.push({
      ...candidate,
      archivePath: path.relative(root, candidate.absolutePath).split(path.sep).join('/'),
    })
  }
  return result.sort((left, right) => left.archivePath.localeCompare(right.archivePath))
}

async function scanRoots(roots: Awaited<ReturnType<typeof existingRoots>>, baseRoot = root): Promise<ManifestFile[]> {
  const files: ManifestFile[] = []
  let scanned = 0
  async function walk(rootEntry: typeof roots[number], directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++scanned > maxFiles) throw new Error(`[file-asset-backup] exceeded FILE_BACKUP_MAX_FILES=${maxFiles}`)
      const absolute = path.join(directory, entry.name)
      const metadata = await lstat(absolute)
      if (metadata.isSymbolicLink()) throw new Error(`[file-asset-backup] symlink is not allowed: ${rootEntry.key}`)
      if (metadata.isDirectory()) {
        await walk(rootEntry, absolute)
        continue
      }
      if (!metadata.isFile()) throw new Error(`[file-asset-backup] unsupported filesystem entry: ${rootEntry.key}`)
      files.push({
        root: rootEntry.key,
        relativePath: path.relative(path.resolve(baseRoot, rootEntry.archivePath), absolute).split(path.sep).join('/'),
        bytes: metadata.size,
        modifiedAt: metadata.mtime.toISOString(),
        mode: (metadata.mode & 0o777).toString(8).padStart(3, '0'),
        sha256: await sha256File(absolute),
      })
    }
  }
  for (const rootEntry of roots) await walk(rootEntry, path.resolve(baseRoot, rootEntry.archivePath))
  return files.sort((left, right) => `${left.root}/${left.relativePath}`.localeCompare(`${right.root}/${right.relativePath}`))
}

function manifestIdentity(files: ManifestFile[]): string {
  return createHash('sha256').update(JSON.stringify(files.map((file) => ({
    root: file.root,
    relativePath: file.relativePath,
    bytes: file.bytes,
    sha256: file.sha256,
  })))).digest('hex')
}

async function writePrivate(file: string, value: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, file)
  await chmod(file, 0o600)
}

async function main() {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error('FILE_BACKUP_MAX_FILES must be a positive integer')
  const roots = await existingRoots()
  if (!roots.length) throw new Error('[file-asset-backup] no local asset roots exist')
  const sourceFiles = await scanRoots(roots)
  const sourceIdentity = manifestIdentity(sourceFiles)
  await mkdir(backupDir, { recursive: true, mode: 0o700 })
  await chmod(backupDir, 0o700)
  const temporaryArchive = `${archivePath}.${process.pid}.tmp`
  await execFileAsync('tar', ['-cf', temporaryArchive, '--', ...roots.map((entry) => entry.archivePath)], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10 * 60_000,
  })
  await rename(temporaryArchive, archivePath)
  await chmod(archivePath, 0o600)
  const archiveMetadata = await stat(archivePath)
  const archiveSha256 = await sha256File(archivePath)

  const restoreRoot = await mkdtemp(path.join(tmpdir(), 'sbl-file-assets-restore-'))
  let restoredFiles: ManifestFile[] = []
  try {
    await execFileAsync('tar', ['-xf', archivePath, '-C', restoreRoot], {
      cwd: root,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10 * 60_000,
    })
    restoredFiles = await scanRoots(roots, restoreRoot)
  } finally {
    await rm(restoreRoot, { recursive: true, force: true })
  }
  const restoredIdentity = manifestIdentity(restoredFiles)
  const totalBytes = sourceFiles.reduce((sum, file) => sum + file.bytes, 0)
  const maxModifiedAt = sourceFiles.map((file) => file.modifiedAt).sort().at(-1) || null
  const checks = {
    allConfiguredLocalRootsArchived: roots.length >= 1,
    noSymlinkOrUnsupportedEntry: true,
    archiveOwnerOnly: (archiveMetadata.mode & 0o077) === 0,
    restoredFileCountMatches: restoredFiles.length === sourceFiles.length,
    restoredContentIdentityMatches: restoredIdentity === sourceIdentity,
  }
  const report = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    ok: Object.values(checks).every(Boolean),
    scope: 'current local configured roots only; missing production roots and missing source bytes remain external blockers',
    backup: {
      directory: backupDir,
      archive: path.basename(archivePath),
      archiveBytes: archiveMetadata.size,
      archiveSha256,
      roots: roots.map(({ key, archivePath: archivedPath }) => ({ key, archivePath: archivedPath })),
      files: sourceFiles.length,
      bytes: totalBytes,
      maxModifiedAt,
      contentIdentity: sourceIdentity,
    },
    restore: {
      files: restoredFiles.length,
      contentIdentity: restoredIdentity,
      temporaryRestoreRemoved: true,
    },
    checks,
    manifest: sourceFiles,
  }
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  await chmod(outputDir, 0o700)
  await writePrivate(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const summary = [
    '# 本地文件资产备份恢复验收',
    '',
    `生成时间：${report.generatedAt}`,
    '',
    `- 根目录：${roots.length}`,
    `- 文件：${sourceFiles.length}`,
    `- 原始字节：${totalBytes}`,
    `- 最大 mtime：${maxModifiedAt || '无'}`,
    `- 归档：${archiveMetadata.size} bytes，SHA-256 \`${archiveSha256}\``,
    `- 内容身份：\`${sourceIdentity}\``,
    `- 隔离恢复：${restoredFiles.length} 个文件，内容身份一致=${restoredIdentity === sourceIdentity}`,
    '- 范围限制：只覆盖当前本机已配置且存在的根；生产文件根和已经缺失的源字节仍需独立取得或批准。',
    '',
    '## 根目录',
    '',
    ...roots.map((entry) => `- ${entry.key}: \`${entry.archivePath}\``),
    '',
  ].join('\n')
  await writePrivate(path.join(outputDir, 'summary.md'), summary)
  console.log(JSON.stringify({
    ok: report.ok,
    outputDir,
    backup: {
      archivePath,
      roots: roots.length,
      files: sourceFiles.length,
      bytes: totalBytes,
      maxModifiedAt,
      archiveBytes: archiveMetadata.size,
      archiveSha256,
      contentIdentity: sourceIdentity,
    },
    restore: report.restore,
    checks,
  }))
  if (!report.ok) process.exitCode = 2
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
