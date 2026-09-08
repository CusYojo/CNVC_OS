import { createHash } from 'node:crypto'
import { readFile, realpath, mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export async function readVerifiedUploadedTemplate(filename: string, expectedSha256: string) {
  const bytes = await readFile(filename)
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)
    || createHash('sha256').update(bytes).digest('hex') !== expectedSha256.toLowerCase()) {
    throw Object.assign(new Error('上传模板内容与登记版本不一致，请重新上传模板'), {
      status: 409, code: 'CUSTOM_TEMPLATE_CONTENT_CHANGED',
    })
  }
  return bytes
}

/** Copy the verified buffer itself so a later source change cannot affect this execution. */
export async function materializeUploadedTemplate(filename: string, expectedSha256: string) {
  const bytes = await readVerifiedUploadedTemplate(filename, expectedSha256)
  const root = await realpath(os.tmpdir())
  const directory = await mkdtemp(path.join(root, 'ai-uploaded-template-'))
  const dispose = async () => {
    if (path.dirname(path.resolve(directory)) !== root
      || !path.basename(directory).startsWith('ai-uploaded-template-')) throw Error('Invalid uploaded template cleanup path')
    await rm(directory, { recursive: true, force: true })
  }
  try {
    const referencePath = path.join(directory, path.basename(filename))
    await writeFile(referencePath, bytes, { flag: 'wx', mode: 0o600 })
    return { referencePath, dispose }
  } catch (error) { await dispose(); throw error }
}
