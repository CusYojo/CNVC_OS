import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const PROJECT_FILE_ROOT = path.resolve(
  process.env.PROJECT_FILE_ROOT || path.join(process.cwd(), 'server', 'project-files'),
)

function resolveStoredPath(storagePath: string): string {
  const resolved = path.resolve(PROJECT_FILE_ROOT, storagePath)
  if (resolved !== PROJECT_FILE_ROOT && !resolved.startsWith(`${PROJECT_FILE_ROOT}${path.sep}`)) {
    throw Object.assign(new Error('项目文件存储路径无效'), { status: 500, code: 'INVALID_STORAGE_PATH' })
  }
  return resolved
}

export async function saveProjectFile(projectId: string, fileId: string, buffer: Buffer): Promise<string> {
  const storagePath = path.join(projectId, fileId)
  const target = resolveStoredPath(storagePath)
  const temp = `${target}.${randomUUID()}.tmp`
  await mkdir(path.dirname(target), { recursive: true })
  try {
    await writeFile(temp, buffer, { flag: 'wx', mode: 0o600 })
    await rename(temp, target)
    return storagePath
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export async function openProjectFile(storagePath: string) {
  const filePath = resolveStoredPath(storagePath)
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
  await rm(resolveStoredPath(storagePath), { force: true })
}

export async function removeProjectFileDirectory(projectId: string): Promise<void> {
  await rm(resolveStoredPath(projectId), { recursive: true, force: true })
}

export function projectFileContentType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase()
  return ({
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
  } as Record<string, string>)[ext] || 'application/octet-stream'
}
