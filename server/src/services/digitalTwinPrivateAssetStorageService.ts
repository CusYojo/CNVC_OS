import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const ROOT = path.resolve(process.env.DIGITAL_TWIN_ASSET_ROOT || path.join(process.cwd(), 'server', 'digital-twin-assets'))

function targetPath(ownerUserId: string, assetId: string) {
  const target = path.resolve(ROOT, ownerUserId, assetId)
  if (!target.startsWith(`${ROOT}${path.sep}`)) throw Object.assign(new Error('分身素材路径无效'), { status: 500, code: 'INVALID_ASSET_PATH' })
  return target
}

export async function saveDigitalTwinPrivateAsset(ownerUserId: string, assetId: string, buffer: Buffer) {
  const target = targetPath(ownerUserId, assetId)
  const temp = `${target}.${randomUUID()}.tmp`
  await mkdir(path.dirname(target), { recursive: true })
  try {
    await writeFile(temp, buffer, { flag: 'wx', mode: 0o600 })
    await rename(temp, target)
    return path.relative(ROOT, target)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function readDigitalTwinPrivateAsset(storagePath: string) {
  const target = path.resolve(ROOT, storagePath)
  if (!target.startsWith(`${ROOT}${path.sep}`)) throw Object.assign(new Error('分身素材路径无效'), { status: 404, code: 'ASSET_NOT_FOUND' })
  return readFile(target)
}
