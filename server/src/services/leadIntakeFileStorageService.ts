import { mkdir, lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const LEAD_INTAKE_FILE_ROOT = path.resolve(
  process.env.LEAD_INTAKE_FILE_ROOT || path.join(process.cwd(), 'server', 'lead-intake-files'),
)

function inside(root: string, target: string) {
  return target === root || target.startsWith(`${root}${path.sep}`)
}

function resolvedStoragePath(storagePath: string) {
  const target = path.resolve(LEAD_INTAKE_FILE_ROOT, storagePath)
  if (!inside(LEAD_INTAKE_FILE_ROOT, target) || target === LEAD_INTAKE_FILE_ROOT) {
    throw Object.assign(new Error('线索导入文件存储路径无效'), { status: 500, code: 'INVALID_STORAGE_PATH' })
  }
  return target
}

export async function saveLeadIntakeFile(userId: string, fileId: string, buffer: Buffer) {
  const storagePath = path.join(userId, fileId)
  const target = resolvedStoragePath(storagePath)
  const temporary = `${target}.${randomUUID()}.tmp`
  await mkdir(path.dirname(target), { recursive: true })
  try {
    const rootReal = await realpath(LEAD_INTAKE_FILE_ROOT)
    const parentReal = await realpath(path.dirname(target))
    if (!inside(rootReal, parentReal)) throw new Error('线索导入文件真实路径越界')
    await writeFile(temporary, buffer, { flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
    return storagePath
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function readLeadIntakeFile(storagePath: string) {
  const target = resolvedStoragePath(storagePath)
  const [rootReal, targetReal, info] = await Promise.all([
    realpath(LEAD_INTAKE_FILE_ROOT),
    realpath(target).catch(() => ''),
    lstat(target).catch(() => null),
  ])
  if (!targetReal || !inside(rootReal, targetReal) || !info?.isFile() || info.isSymbolicLink()) {
    throw Object.assign(new Error('线索导入原始文件不存在'), { status: 404, code: 'FILE_CONTENT_NOT_FOUND' })
  }
  return await readFile(target)
}

