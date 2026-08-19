import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import path from 'node:path'

const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const ARTIFACT_DOWNLOAD_PATTERN = new RegExp(`/api/ai/artifacts/(${UUID_PATTERN})/download`, 'ig')
const ARTIFACT_ID_PATTERN = new RegExp(`^${UUID_PATTERN}$`, 'i')
const MAX_JSON_TEXT_BYTES = 1_000_000
const MAX_WALK_DEPTH = 12
const CDN_UPLOAD_ATTEMPTS = 3

type SnapshotMessage = {
  id: string
  parts: Record<string, unknown>[]
}

type PostWeixin = <T>(endpoint: string, payload: unknown, timeoutMs: number) => Promise<T>

type UploadUrlResponse = {
  upload_param?: string
  upload_full_url?: string
}

type FetchLike = typeof fetch

function ensureAllowedCdnUrl(value: string) {
  const parsed = new URL(value)
  const host = parsed.hostname.toLowerCase()
  if (parsed.protocol !== 'https:' || (host !== 'weixin.qq.com' && !host.endsWith('.weixin.qq.com'))) {
    throw new Error('微信文件上传地址不在允许列表')
  }
  return parsed
}

function cdnUploadUrl(upload: UploadUrlResponse, fileKey: string) {
  if (upload.upload_full_url?.trim()) return ensureAllowedCdnUrl(upload.upload_full_url.trim()).toString()
  if (!upload.upload_param?.trim()) throw new Error('微信文件上传接口未返回上传地址')
  const url = ensureAllowedCdnUrl(`${DEFAULT_CDN_BASE_URL}/upload`)
  url.searchParams.set('encrypted_query_param', upload.upload_param)
  url.searchParams.set('filekey', fileKey)
  return url.toString()
}

function encryptFile(plaintext: Buffer, key: Buffer) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function sanitizeWeixinFileName(value: string) {
  const base = path.basename(value.replace(/[\r\n\0]/g, '').trim())
    .replace(/["\\]/g, '_')
    .trim()
  return (base || 'file').slice(0, 180)
}

function collectArtifactIds(value: unknown, ids: Set<string>, depth: number, inArtifacts = false) {
  if (depth > MAX_WALK_DEPTH || value === null || value === undefined) return
  if (typeof value === 'string') {
    ARTIFACT_DOWNLOAD_PATTERN.lastIndex = 0
    for (const match of value.matchAll(ARTIFACT_DOWNLOAD_PATTERN)) ids.add(match[1].toLowerCase())
    const trimmed = value.trim()
    if (
      trimmed.length > 1
      && trimmed.length <= MAX_JSON_TEXT_BYTES
      && ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))
    ) {
      try { collectArtifactIds(JSON.parse(trimmed), ids, depth + 1, inArtifacts) } catch { /* ordinary text */ }
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactIds(item, ids, depth + 1, inArtifacts)
    return
  }
  if (typeof value !== 'object') return
  const record = value as Record<string, unknown>
  const directId = typeof record.artifactId === 'string'
    ? record.artifactId
    : inArtifacts && typeof record.id === 'string' ? record.id : ''
  if (ARTIFACT_ID_PATTERN.test(directId)) ids.add(directId.toLowerCase())
  for (const [key, nested] of Object.entries(record)) {
    collectArtifactIds(nested, ids, depth + 1, inArtifacts || key === 'artifacts')
  }
}

export function weixinArtifactIdsFromMessages(messages: SnapshotMessage[], baselineIds: Set<string>) {
  const ids = new Set<string>()
  for (const message of messages) {
    if (baselineIds.has(message.id)) continue
    collectArtifactIds(message.parts, ids, 0)
  }
  return [...ids]
}

async function uploadCiphertext(input: {
  url: string
  ciphertext: Buffer
  fetchImpl: FetchLike
}) {
  let lastError: unknown
  for (let attempt = 1; attempt <= CDN_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await input.fetchImpl(input.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(input.ciphertext),
        signal: AbortSignal.timeout(120_000),
        redirect: 'error',
      })
      if (response.status >= 400 && response.status < 500) {
        throw Object.assign(new Error(`微信 CDN 拒绝文件上传：HTTP ${response.status}`), {
          noRetry: true,
        })
      }
      if (response.status !== 200) throw new Error(`微信 CDN 文件上传失败：HTTP ${response.status}`)
      const downloadParam = response.headers.get('x-encrypted-param')?.trim()
      if (!downloadParam) throw new Error('微信 CDN 未返回文件下载参数')
      return downloadParam
    } catch (error) {
      lastError = error
      if ((error as { noRetry?: boolean }).noRetry || attempt === CDN_UPLOAD_ATTEMPTS) throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('微信 CDN 文件上传失败')
}

export async function uploadAndSendWeixinFile(input: {
  postWeixin: PostWeixin
  targetUserId: string
  contextToken: string
  fileName: string
  content: Buffer
  channelVersion: string
  fetchImpl?: FetchLike
}) {
  const fileName = sanitizeWeixinFileName(input.fileName)
  const fileKey = randomBytes(16).toString('hex')
  const aesKey = randomBytes(16)
  const ciphertext = encryptFile(input.content, aesKey)
  const upload = await input.postWeixin<UploadUrlResponse>('ilink/bot/getuploadurl', {
    filekey: fileKey,
    media_type: 3,
    to_user_id: input.targetUserId,
    rawsize: input.content.length,
    rawfilemd5: createHash('md5').update(input.content).digest('hex'),
    filesize: ciphertext.length,
    no_need_thumb: true,
    aeskey: aesKey.toString('hex'),
    base_info: { channel_version: input.channelVersion },
  }, 15_000)
  const downloadParam = await uploadCiphertext({
    url: cdnUploadUrl(upload, fileKey),
    ciphertext,
    fetchImpl: input.fetchImpl || fetch,
  })
  const clientId = `sbl-weixin-file-${Date.now()}-${randomBytes(4).toString('hex')}`
  await input.postWeixin('ilink/bot/sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: input.targetUserId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: input.contextToken,
      item_list: [{
        type: 4,
        file_item: {
          media: {
            encrypt_query_param: downloadParam,
            aes_key: Buffer.from(aesKey.toString('hex')).toString('base64'),
            encrypt_type: 1,
          },
          file_name: fileName,
          len: String(input.content.length),
        },
      }],
    },
    base_info: { channel_version: input.channelVersion },
  }, 15_000)
  return { clientId, fileName, byteSize: input.content.length }
}
