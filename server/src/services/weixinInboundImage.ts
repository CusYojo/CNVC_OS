import { createDecipheriv, createHash } from 'node:crypto'

const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const DEFAULT_MAX_IMAGE_BYTES = 15 * 1024 * 1024
const HARD_MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_IMAGES_PER_MESSAGE = 4

export type WeixinInboundImage = {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  dataBase64: string
  byteSize: number
  sha256: string
}

export type WeixinImageMessage = {
  item_list?: Array<{
    type?: number
    image_item?: {
      aeskey?: string
      aes_key?: string
      media?: {
        encrypt_query_param?: string
        aes_key?: string
        aeskey?: string
        full_url?: string
        download_url?: string
        url?: string
      }
    }
  }>
}

function maxImageBytes() {
  const configured = Number(process.env.WEIXIN_INBOUND_IMAGE_MAX_BYTES || DEFAULT_MAX_IMAGE_BYTES)
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MAX_IMAGE_BYTES
  return Math.min(Math.floor(configured), HARD_MAX_IMAGE_BYTES)
}

function ensureWeixinCdnUrl(value: string) {
  const parsed = new URL(value)
  const host = parsed.hostname.toLowerCase()
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== '443')
    || (host !== 'weixin.qq.com' && !host.endsWith('.weixin.qq.com'))
  ) throw new Error('微信图片下载地址不在允许列表')
  parsed.hash = ''
  return parsed
}

function imageDownloadUrl(item: NonNullable<WeixinImageMessage['item_list']>[number]) {
  const media = item.image_item?.media
  const direct = media?.full_url || media?.download_url || media?.url
  if (direct) return ensureWeixinCdnUrl(direct).toString()
  if (!media?.encrypt_query_param) throw new Error('微信图片缺少下载参数')
  const url = ensureWeixinCdnUrl(`${DEFAULT_CDN_BASE_URL}/download`)
  url.searchParams.set('encrypted_query_param', media.encrypt_query_param)
  return url.toString()
}

export function decodeWeixinAesKey(value: string) {
  const clean = value.trim()
  if (/^[0-9a-f]{32}$/i.test(clean)) return Buffer.from(clean, 'hex')
  const decoded = Buffer.from(clean, 'base64')
  if (decoded.length === 16) return decoded
  const ascii = decoded.toString('ascii')
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(ascii)) return Buffer.from(ascii, 'hex')
  throw new Error('微信媒体 AES 密钥格式无效')
}

export const decodeWeixinImageAesKey = decodeWeixinAesKey

function decryptImage(ciphertext: Buffer, keyText: string) {
  const decipher = createDecipheriv('aes-128-ecb', decodeWeixinAesKey(keyText), null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function imageMediaType(content: Buffer): WeixinInboundImage['mediaType'] {
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return 'image/jpeg'
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  const prefix = content.subarray(0, 6).toString('ascii')
  if (prefix === 'GIF87a' || prefix === 'GIF89a') return 'image/gif'
  if (content.length >= 12 && content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  throw new Error('微信图片格式不受支持')
}

async function responseBuffer(response: Response, limit: number) {
  if (!response.ok) throw new Error(`微信图片下载失败：HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > limit) throw new Error('微信图片超过接收大小上限')
  if (!response.body) throw new Error('微信图片响应为空')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new Error('微信图片超过接收大小上限')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

export function weixinInboundImageCount(message: WeixinImageMessage) {
  return (message.item_list || []).filter((item) => item.type === 2 || item.image_item).length
}

export function weixinInboundImageReferenceHash(message: WeixinImageMessage) {
  const references = (message.item_list || []).flatMap((item) => {
    if (item.type !== 2 && !item.image_item) return []
    const media = item.image_item?.media
    return [media?.encrypt_query_param || media?.full_url || media?.download_url || media?.url || 'image']
  })
  return references.length ? createHash('sha256').update(references.join('\n')).digest('hex') : ''
}

export async function downloadWeixinInboundImages(
  message: WeixinImageMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<WeixinInboundImage[]> {
  const items = (message.item_list || [])
    .filter((item) => item.type === 2 || item.image_item)
    .slice(0, MAX_IMAGES_PER_MESSAGE)
  const images: WeixinInboundImage[] = []
  for (const item of items) {
    const response = await fetchImpl(imageDownloadUrl(item), {
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    })
    const encrypted = await responseBuffer(response, maxImageBytes() + 16)
    const key = item.image_item?.aeskey
      || item.image_item?.aes_key
      || item.image_item?.media?.aes_key
      || item.image_item?.media?.aeskey
    const content = key ? decryptImage(encrypted, key) : encrypted
    const limit = maxImageBytes()
    if (!content.length || content.length > limit) throw new Error('微信图片为空或超过接收大小上限')
    images.push({
      mediaType: imageMediaType(content),
      dataBase64: content.toString('base64'),
      byteSize: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    })
  }
  return images
}
