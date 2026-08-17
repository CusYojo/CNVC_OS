import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { projectFileMimeType, projectFilePreviewMimeType } from '../security/projectFileValidation.js'

const PROJECT_FILE_ROOT = path.resolve(
  process.env.PROJECT_FILE_ROOT || path.join(process.cwd(), 'server', 'project-files'),
)
const PROJECT_FILE_TEMP_PATTERN = /\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i

function projectFileTempMaxAgeMs(): number {
  const value = Number(process.env.PROJECT_FILE_TEMP_MAX_AGE_MS ?? 24 * 60 * 60 * 1_000)
  if (!Number.isInteger(value) || value < 60_000 || value > 7 * 24 * 60 * 60 * 1_000) {
    throw new Error('PROJECT_FILE_TEMP_MAX_AGE_MS must be an integer between 60000 and 604800000')
  }
  return value
}

function pathInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`)
}

export async function cleanupStaleProjectFileTemps(options: {
  root?: string
  nowMs?: number
  maxAgeMs?: number
} = {}) {
  const root = path.resolve(options.root || PROJECT_FILE_ROOT)
  const nowMs = options.nowMs ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? projectFileTempMaxAgeMs()
  if (!Number.isFinite(nowMs) || !Number.isInteger(maxAgeMs) || maxAgeMs < 1) {
    throw new Error('invalid project file temporary cleanup clock or maximum age')
  }
  await mkdir(root, { recursive: true })
  const rootReal = await realpath(root)
  const result = { scanned: 0, removed: 0, retainedFresh: 0, ignored: 0, skippedSymlinks: 0 }

  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.resolve(directory, entry.name)
      if (!pathInside(root, candidate)) throw new Error('project file temporary cleanup escaped configured root')
      const info = await lstat(candidate).catch(() => null)
      if (!info) continue
      if (info.isSymbolicLink()) {
        result.skippedSymlinks += 1
        continue
      }
      if (info.isDirectory()) {
        await walk(candidate)
        continue
      }
      result.scanned += 1
      if (!info.isFile() || !PROJECT_FILE_TEMP_PATTERN.test(entry.name)) {
        result.ignored += 1
        continue
      }
      if (info.mtimeMs > nowMs - maxAgeMs) {
        result.retainedFresh += 1
        continue
      }
      const candidateReal = await realpath(candidate).catch(() => '')
      if (!candidateReal || !pathInside(rootReal, candidateReal)) {
        result.skippedSymlinks += 1
        continue
      }
      const current = await lstat(candidate).catch(() => null)
      if (!current || !current.isFile() || current.isSymbolicLink()
        || current.dev !== info.dev || current.ino !== info.ino || current.mtimeMs > nowMs - maxAgeMs) {
        result.retainedFresh += 1
        continue
      }
      await rm(candidate, { force: true })
      result.removed += 1
    }
  }

  await walk(root)
  return { ...result, maxAgeMs }
}

function resolveStoredPath(storagePath: string): string {
  const resolved = path.resolve(PROJECT_FILE_ROOT, storagePath)
  if (resolved !== PROJECT_FILE_ROOT && !resolved.startsWith(`${PROJECT_FILE_ROOT}${path.sep}`)) {
    throw Object.assign(new Error('项目文件存储路径无效'), { status: 500, code: 'INVALID_STORAGE_PATH' })
  }
  return resolved
}

function invalidDeletionPath(message: string) {
  return Object.assign(new Error(message), { status: 500, code: 'INVALID_STORAGE_PATH' })
}

function assertOwnedStoragePath(storagePath: string, projectId: string, fileId: string): void {
  const normalized = path.normalize(storagePath)
  const ownedRoot = path.normalize(path.join(projectId, fileId))
  if (normalized !== ownedRoot && !normalized.startsWith(`${ownedRoot}${path.sep}`)) {
    throw invalidDeletionPath('项目文件存储路径与项目或文件归属不一致')
  }
}

async function removeStoredEntry(storagePath: string, recursive = false): Promise<void> {
  const target = resolveStoredPath(storagePath)
  if (target === PROJECT_FILE_ROOT) throw invalidDeletionPath('禁止删除项目文件存储根目录')
  const initial = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!initial) return
  if (initial.isSymbolicLink()) throw invalidDeletionPath('禁止通过符号链接删除项目文件')
  const [rootReal, targetReal] = await Promise.all([realpath(PROJECT_FILE_ROOT), realpath(target)])
  if (!pathInside(rootReal, targetReal)) throw invalidDeletionPath('项目文件删除目标真实路径越界')
  const current = await lstat(target).catch(() => null)
  if (!current || current.isSymbolicLink() || current.dev !== initial.dev || current.ino !== initial.ino) {
    throw invalidDeletionPath('项目文件删除目标在校验后发生变化')
  }
  await rm(target, { recursive, force: true })
}

async function assertRealPathInsideRoot(filePath: string, existingFile: boolean): Promise<void> {
  const rootReal = await realpath(PROJECT_FILE_ROOT)
  const targetReal = await realpath(existingFile ? filePath : path.dirname(filePath))
  if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${path.sep}`)) {
    throw Object.assign(new Error('项目文件真实路径越界'), { status: 404, code: 'FILE_CONTENT_NOT_FOUND' })
  }
  if (existingFile && (await lstat(filePath)).isSymbolicLink()) {
    throw Object.assign(new Error('项目文件不允许使用符号链接'), { status: 404, code: 'FILE_CONTENT_NOT_FOUND' })
  }
}

export async function saveProjectFile(projectId: string, fileId: string, buffer: Buffer): Promise<string> {
  const storagePath = path.join(projectId, fileId)
  const target = resolveStoredPath(storagePath)
  const temp = `${target}.${randomUUID()}.tmp`
  await mkdir(path.dirname(target), { recursive: true })
  try {
    await assertRealPathInsideRoot(target, false)
    await writeFile(temp, buffer, { flag: 'wx', mode: 0o600 })
    await rename(temp, target)
    return storagePath
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export async function saveProjectFileRevision(projectId: string, fileId: string, buffer: Buffer): Promise<string> {
  return saveProjectFile(projectId, path.join(fileId, randomUUID()), buffer)
}

export async function openProjectFile(storagePath: string) {
  const filePath = resolveStoredPath(storagePath)
  await assertRealPathInsideRoot(filePath, true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw Object.assign(new Error('项目原始文件不存在，请重新上传'), { status: 404, code: 'FILE_CONTENT_NOT_FOUND' })
    }
    throw error
  })
  const info = await stat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw Object.assign(new Error('项目原始文件不存在，请重新上传'), { status: 404, code: 'FILE_CONTENT_NOT_FOUND' })
    }
    throw error
  })
  if (!info.isFile()) {
    throw Object.assign(new Error('项目原始文件不存在'), { status: 404, code: 'FILE_CONTENT_NOT_FOUND' })
  }
  return { size: info.size, stream: createReadStream(filePath) }
}

export async function removeProjectFile(storagePath: string | null | undefined): Promise<void> {
  if (!storagePath) return
  await removeStoredEntry(storagePath)
}

export async function removeOwnedProjectFile(
  storagePath: string | null | undefined,
  projectId: string,
  fileId: string,
): Promise<void> {
  if (!storagePath) return
  assertOwnedStoragePath(storagePath, projectId, fileId)
  await removeStoredEntry(storagePath)
}

export async function removeProjectFileDirectory(projectId: string): Promise<void> {
  await removeStoredEntry(projectId, true)
}

export async function removeProjectFileHistory(projectId: string, fileId: string): Promise<void> {
  await removeStoredEntry(path.join(projectId, fileId), true)
}

export function projectFileContentType(fileName: string): string {
  return projectFileMimeType(fileName)
}

export function projectFilePreviewContentType(fileName: string): string | null {
  return projectFilePreviewMimeType(fileName)
}
