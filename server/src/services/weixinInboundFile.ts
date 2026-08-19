import { createDecipheriv, createHash } from 'node:crypto'
import path from 'node:path'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { decodeWeixinAesKey } from './weixinInboundImage.js'

const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const DEFAULT_MAX_FILE_BYTES = 12 * 1024 * 1024
const HARD_MAX_FILE_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_TEXT_CHARS = 120_000
const HARD_MAX_TEXT_CHARS = 300_000
const MAX_FILES_PER_MESSAGE = 3
const MAX_DOCX_ENTRIES = 2_000
const MAX_DOCX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024

export type WeixinInboundDocument = {
  kind: 'pdf' | 'text'
  fileName: string
  mediaType: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' | 'text/markdown'
  dataBase64?: string
  text?: string
  byteSize: number
  sha256: string
  truncated?: boolean
}

export type WeixinFileMessage = {
  item_list?: Array<{
    type?: number
    file_item?: {
      file_name?: string
      len?: string
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

export class WeixinInboundFileError extends Error {
  constructor(message: string, readonly publicMessage = '暂不支持该文件，请发送 PDF、DOCX 或 Markdown 文件。') {
    super(message)
    this.name = 'WeixinInboundFileError'
  }
}

function configuredBounded(name: string, fallback: number, hardMax: number) {
  const configured = Number(process.env[name] || fallback)
  if (!Number.isFinite(configured) || configured <= 0) return fallback
  return Math.min(Math.floor(configured), hardMax)
}

function maxFileBytes() {
  return configuredBounded('WEIXIN_INBOUND_FILE_MAX_BYTES', DEFAULT_MAX_FILE_BYTES, HARD_MAX_FILE_BYTES)
}

function maxTextChars() {
  return configuredBounded('WEIXIN_INBOUND_TEXT_MAX_CHARS', DEFAULT_MAX_TEXT_CHARS, HARD_MAX_TEXT_CHARS)
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
  ) throw new WeixinInboundFileError('微信文件下载地址不在允许列表')
  parsed.hash = ''
  return parsed
}

function fileDownloadUrl(item: NonNullable<WeixinFileMessage['item_list']>[number]) {
  const media = item.file_item?.media
  const direct = media?.full_url || media?.download_url || media?.url
  if (direct) return ensureWeixinCdnUrl(direct).toString()
  if (!media?.encrypt_query_param) throw new WeixinInboundFileError('微信文件缺少下载参数')
  const url = ensureWeixinCdnUrl(`${DEFAULT_CDN_BASE_URL}/download`)
  url.searchParams.set('encrypted_query_param', media.encrypt_query_param)
  return url.toString()
}

function safeFileName(value: string | undefined) {
  const base = path.basename(String(value || 'file').replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (base || 'file').slice(0, 180)
}

async function responseBuffer(response: Response, limit: number) {
  if (!response.ok) throw new WeixinInboundFileError(`微信文件下载失败：HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > limit) throw new WeixinInboundFileError('微信文件超过接收大小上限', '文件过大，目前无法通过微信机器人接收。')
  if (!response.body) throw new WeixinInboundFileError('微信文件响应为空')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new WeixinInboundFileError('微信文件超过接收大小上限', '文件过大，目前无法通过微信机器人接收。')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

function decryptFile(ciphertext: Buffer, keyText: string) {
  try {
    const decipher = createDecipheriv('aes-128-ecb', decodeWeixinAesKey(keyText), null)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (error) {
    if (error instanceof WeixinInboundFileError) throw error
    throw new WeixinInboundFileError(`微信文件解密失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function limitedText(value: string) {
  const normalized = value.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').trim()
  if (!normalized) throw new WeixinInboundFileError('微信文件没有可读取的文字内容')
  const limit = maxTextChars()
  if (normalized.length <= limit) return { text: normalized, truncated: false }
  return {
    text: `${normalized.slice(0, limit)}\n\n[文件内容过长，已截断至 ${limit} 个字符]`,
    truncated: true,
  }
}

function markdownText(content: Buffer) {
  if (content.includes(0)) throw new WeixinInboundFileError('Markdown 文件包含二进制内容')
  let decoded: string
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(content) }
  catch { throw new WeixinInboundFileError('Markdown 文件不是有效的 UTF-8 文本') }
  let controls = 0
  for (const character of decoded) {
    const code = character.charCodeAt(0)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) controls += 1
  }
  if (controls / Math.max(1, decoded.length) > 0.01) throw new WeixinInboundFileError('Markdown 文件包含过多控制字符')
  return limitedText(decoded)
}

async function docxText(content: Buffer) {
  let zip: JSZip
  try { zip = await JSZip.loadAsync(content) }
  catch { throw new WeixinInboundFileError('DOCX 不是有效的 OOXML/ZIP 文档') }
  const entries = Object.values(zip.files)
  if (entries.length > MAX_DOCX_ENTRIES) throw new WeixinInboundFileError('DOCX 内部条目数超过限制')
  let expandedSize = 0
  for (const entry of entries) {
    const original = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName || entry.name
    if (original.startsWith('/') || original.split('/').includes('..')) {
      throw new WeixinInboundFileError('DOCX 包含不安全的内部路径')
    }
    expandedSize += Number((entry as typeof entry & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize || 0)
    if (expandedSize > MAX_DOCX_UNCOMPRESSED_BYTES) throw new WeixinInboundFileError('DOCX 解压后容量超过限制')
  }
  if (!zip.file('[Content_Types].xml') || !zip.file('word/document.xml')) {
    throw new WeixinInboundFileError('DOCX 内部结构不完整')
  }
  let extracted: string
  try { extracted = (await mammoth.extractRawText({ buffer: content })).value || '' }
  catch (error) {
    throw new WeixinInboundFileError(`DOCX 文字提取失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return limitedText(extracted)
}

async function documentFromContent(fileName: string, content: Buffer): Promise<WeixinInboundDocument> {
  const extension = path.extname(fileName).toLowerCase()
  const common = {
    fileName,
    byteSize: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  }
  if (extension === '.pdf') {
    if (content.subarray(0, 5).toString('ascii') !== '%PDF-') throw new WeixinInboundFileError('PDF 文件签名无效')
    return { ...common, kind: 'pdf', mediaType: 'application/pdf', dataBase64: content.toString('base64') }
  }
  if (extension === '.docx') {
    const extracted = await docxText(content)
    return {
      ...common, kind: 'text',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      text: extracted.text, truncated: extracted.truncated,
    }
  }
  if (extension === '.md' || extension === '.markdown') {
    const extracted = markdownText(content)
    return {
      ...common, kind: 'text', mediaType: 'text/markdown',
      text: extracted.text, truncated: extracted.truncated,
    }
  }
  if (extension === '.doc') {
    throw new WeixinInboundFileError('旧版 .doc 二进制文档不受支持', '暂不支持旧版 .doc，请另存为 .docx 后再发送。')
  }
  throw new WeixinInboundFileError(`不受支持的微信文件扩展名：${extension || '<none>'}`)
}

export function weixinInboundFileCount(message: WeixinFileMessage) {
  return (message.item_list || []).filter((item) => item.type === 4 || item.file_item).length
}

export function weixinInboundFileReferenceHash(message: WeixinFileMessage) {
  const references = (message.item_list || []).flatMap((item) => {
    if (item.type !== 4 && !item.file_item) return []
    const media = item.file_item?.media
    return [`${item.file_item?.file_name || 'file'}\n${media?.encrypt_query_param || media?.full_url || media?.download_url || media?.url || 'file'}`]
  })
  return references.length ? createHash('sha256').update(references.join('\n')).digest('hex') : ''
}

export async function downloadWeixinInboundFiles(
  message: WeixinFileMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<WeixinInboundDocument[]> {
  const items = (message.item_list || [])
    .filter((item) => item.type === 4 || item.file_item)
    .slice(0, MAX_FILES_PER_MESSAGE)
  const documents: WeixinInboundDocument[] = []
  for (const item of items) {
    const fileName = safeFileName(item.file_item?.file_name)
    const key = item.file_item?.media?.aes_key || item.file_item?.media?.aeskey
    if (!key) throw new WeixinInboundFileError('微信文件缺少 AES 密钥')
    const response = await fetchImpl(fileDownloadUrl(item), {
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    })
    const encrypted = await responseBuffer(response, maxFileBytes() + 16)
    const content = decryptFile(encrypted, key)
    const limit = maxFileBytes()
    if (!content.length || content.length > limit) {
      throw new WeixinInboundFileError('微信文件为空或超过接收大小上限', '文件为空或过大，目前无法通过微信机器人接收。')
    }
    const declaredLength = Number(item.file_item?.len || 0)
    if (Number.isSafeInteger(declaredLength) && declaredLength > 0 && declaredLength !== content.length) {
      throw new WeixinInboundFileError('微信文件解密后长度与声明长度不一致')
    }
    documents.push(await documentFromContent(fileName, content))
  }
  return documents
}
