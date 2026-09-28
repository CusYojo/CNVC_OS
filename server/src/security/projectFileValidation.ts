import path from 'node:path'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { decodeTextBuffer, inspectTextQuality } from '../services/textQualityService.js'

type FileKind = {
  label: string
  mime: string
  acceptedMimes: readonly string[]
  signature: 'pdf' | 'ooxml-word' | 'ooxml-sheet' | 'ooxml-presentation' | 'ole' | 'png' | 'jpeg' | 'gif' | 'bmp' | 'webp' | 'mp3' | 'wav' | 'm4a' | 'webm' | 'text'
}

const FILE_KINDS: Record<string, FileKind> = {
  pdf: { label: 'PDF', mime: 'application/pdf', acceptedMimes: ['application/pdf'], signature: 'pdf' },
  doc: { label: 'DOC', mime: 'application/msword', acceptedMimes: ['application/msword', 'application/octet-stream'], signature: 'ole' },
  docx: { label: 'DOCX', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', acceptedMimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/octet-stream'], signature: 'ooxml-word' },
  xls: { label: 'XLS', mime: 'application/vnd.ms-excel', acceptedMimes: ['application/vnd.ms-excel', 'application/octet-stream'], signature: 'ole' },
  xlsx: { label: 'XLSX', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', acceptedMimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip', 'application/octet-stream'], signature: 'ooxml-sheet' },
  xlsm: { label: 'XLSM', mime: 'application/vnd.ms-excel.sheet.macroEnabled.12', acceptedMimes: ['application/vnd.ms-excel.sheet.macroEnabled.12', 'application/zip', 'application/octet-stream'], signature: 'ooxml-sheet' },
  ppt: { label: 'PPT', mime: 'application/vnd.ms-powerpoint', acceptedMimes: ['application/vnd.ms-powerpoint', 'application/octet-stream'], signature: 'ole' },
  pptx: { label: 'PPTX', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', acceptedMimes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip', 'application/octet-stream'], signature: 'ooxml-presentation' },
  txt: { label: 'TXT', mime: 'text/plain; charset=utf-8', acceptedMimes: ['text/plain', 'application/octet-stream'], signature: 'text' },
  md: { label: 'MD', mime: 'text/markdown; charset=utf-8', acceptedMimes: ['text/markdown', 'text/plain', 'application/octet-stream'], signature: 'text' },
  markdown: { label: 'MARKDOWN', mime: 'text/markdown; charset=utf-8', acceptedMimes: ['text/markdown', 'text/plain', 'application/octet-stream'], signature: 'text' },
  csv: { label: 'CSV', mime: 'text/csv; charset=utf-8', acceptedMimes: ['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream'], signature: 'text' },
  htm: { label: 'HTML', mime: 'text/html; charset=utf-8', acceptedMimes: ['text/html', 'text/plain', 'application/octet-stream'], signature: 'text' },
  html: { label: 'HTML', mime: 'text/html; charset=utf-8', acceptedMimes: ['text/html', 'text/plain', 'application/octet-stream'], signature: 'text' },
  log: { label: 'LOG', mime: 'text/plain; charset=utf-8', acceptedMimes: ['text/plain', 'application/octet-stream'], signature: 'text' },
  json: { label: 'JSON', mime: 'application/json; charset=utf-8', acceptedMimes: ['application/json', 'text/plain', 'application/octet-stream'], signature: 'text' },
  png: { label: 'PNG', mime: 'image/png', acceptedMimes: ['image/png', 'application/octet-stream'], signature: 'png' },
  jpg: { label: 'JPG', mime: 'image/jpeg', acceptedMimes: ['image/jpeg', 'application/octet-stream'], signature: 'jpeg' },
  jpeg: { label: 'JPEG', mime: 'image/jpeg', acceptedMimes: ['image/jpeg', 'application/octet-stream'], signature: 'jpeg' },
  gif: { label: 'GIF', mime: 'image/gif', acceptedMimes: ['image/gif', 'application/octet-stream'], signature: 'gif' },
  bmp: { label: 'BMP', mime: 'image/bmp', acceptedMimes: ['image/bmp', 'image/x-ms-bmp', 'application/octet-stream'], signature: 'bmp' },
  webp: { label: 'WEBP', mime: 'image/webp', acceptedMimes: ['image/webp', 'application/octet-stream'], signature: 'webp' },
  mp3: { label: 'MP3', mime: 'audio/mpeg', acceptedMimes: ['audio/mpeg', 'audio/mp3', 'application/octet-stream'], signature: 'mp3' },
  wav: { label: 'WAV', mime: 'audio/wav', acceptedMimes: ['audio/wav', 'audio/x-wav', 'audio/wave', 'application/octet-stream'], signature: 'wav' },
  m4a: { label: 'M4A', mime: 'audio/mp4', acceptedMimes: ['audio/mp4', 'audio/x-m4a', 'video/mp4', 'application/octet-stream'], signature: 'm4a' },
  webm: { label: 'WEBM', mime: 'audio/webm', acceptedMimes: ['audio/webm', 'video/webm', 'application/octet-stream'], signature: 'webm' },
}

function fileError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code })
}

function boundedEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function normalizedMime(value: string | null | undefined): string | null {
  if (!value?.includes('/')) return null
  return value.split(';')[0].trim().toLowerCase() || null
}

function parseBase64(input: string): { payload: string; dataUrlMime: string | null } {
  if (!input.startsWith('data:')) return { payload: input, dataUrlMime: null }
  const comma = input.indexOf(',')
  if (comma < 0) throw fileError(400, 'INVALID_FILE_ENCODING', 'Data URL 缺少文件内容')
  const metadata = input.slice(5, comma)
  if (!/(?:^|;)base64$/i.test(metadata)) throw fileError(400, 'INVALID_FILE_ENCODING', '文件 Data URL 必须使用 base64 编码')
  const mime = metadata.split(';')[0]?.trim().toLowerCase() || null
  return { payload: input.slice(comma + 1), dataUrlMime: mime }
}

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  return bytes.every((value, index) => buffer[index] === value)
}

function isCanonicalBase64(payload: string): boolean {
  if (!payload || payload.length % 4 !== 0) return false
  let padding = 0
  if (payload.endsWith('==')) padding = 2
  else if (payload.endsWith('=')) padding = 1
  const contentLength = payload.length - padding
  for (let index = 0; index < contentLength; index += 1) {
    const code = payload.charCodeAt(index)
    const accepted = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f
    if (!accepted) return false
  }
  for (let index = contentLength; index < payload.length; index += 1) {
    if (payload.charCodeAt(index) !== 0x3d) return false
  }
  return true
}

async function assertSafeOoxml(buffer: Buffer, requiredEntry: string): Promise<void> {
  let zip: JSZip
  try { zip = await JSZip.loadAsync(buffer) }
  catch { throw fileError(415, 'FILE_SIGNATURE_MISMATCH', 'Office 文件不是有效的 OOXML/ZIP 文档') }
  const entries = Object.values(zip.files)
  const maxEntries = boundedEnv('PROJECT_FILE_ARCHIVE_MAX_ENTRIES', 5_000, 10, 50_000)
  const maxUncompressed = boundedEnv('PROJECT_FILE_ARCHIVE_MAX_UNCOMPRESSED_BYTES', 250 * 1024 * 1024, 1_024, 1024 * 1024 * 1024)
  if (entries.length > maxEntries) throw fileError(413, 'ARCHIVE_EXPANSION_LIMIT', 'Office 文件内部条目数量超过限制')
  let uncompressedBytes = 0
  for (const entry of entries) {
    const original = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName || entry.name
    if (original.startsWith('/') || original.split('/').includes('..')) {
      throw fileError(415, 'UNSAFE_ARCHIVE_PATH', 'Office 文件包含不安全的内部路径')
    }
    const size = Number((entry as typeof entry & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize || 0)
    uncompressedBytes += size
    if (uncompressedBytes > maxUncompressed) throw fileError(413, 'ARCHIVE_EXPANSION_LIMIT', 'Office 文件解压后容量超过限制')
  }
  if (!zip.file('[Content_Types].xml') || !zip.file(requiredEntry)) {
    throw fileError(415, 'FILE_SIGNATURE_MISMATCH', 'Office 文件内部结构与扩展名不一致')
  }
}

async function assertSignature(extension: string, kind: FileKind, buffer: Buffer): Promise<void> {
  let valid = true
  switch (kind.signature) {
    case 'pdf':
      valid = buffer.subarray(0, 5).toString('ascii') === '%PDF-'
        && buffer.subarray(Math.max(0, buffer.length - 2_048)).includes(Buffer.from('%%EOF'))
      break
    case 'png': valid = startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); break
    case 'jpeg': valid = startsWith(buffer, [0xff, 0xd8, 0xff]) && buffer.subarray(-2).equals(Buffer.from([0xff, 0xd9])); break
    case 'gif': valid = ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii')); break
    case 'bmp': valid = buffer.subarray(0, 2).toString('ascii') === 'BM'; break
    case 'webp': valid = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'; break
    case 'mp3': valid = buffer.subarray(0, 3).toString('ascii') === 'ID3' || (buffer.length > 1 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0); break
    case 'wav': valid = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE'; break
    case 'm4a': valid = buffer.subarray(4, 8).toString('ascii') === 'ftyp' && /M4A |isom|mp42|M4B /.test(buffer.subarray(8, 12).toString('ascii')); break
    case 'webm': valid = startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3]); break
    case 'ole': valid = startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); break
    case 'text': {
      if (valid && extension === 'json') {
        try { JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, '')) }
        catch { valid = false }
      }
      break
    }
    case 'ooxml-word': await assertSafeOoxml(buffer, 'word/document.xml'); return
    case 'ooxml-sheet': await assertSafeOoxml(buffer, 'xl/workbook.xml'); return
    case 'ooxml-presentation': await assertSafeOoxml(buffer, 'ppt/presentation.xml'); return
  }
  if (!valid) throw fileError(415, 'FILE_SIGNATURE_MISMATCH', `文件内容与 .${extension} 扩展名不一致或结构无效`)
}

/** Convert every supported text upload to canonical UTF-8 before persistence.
 * The same helper is used when previewing legacy files saved in GB18030/UTF-16. */
export function canonicalizeUtf8TextBuffer(buffer: Buffer): Buffer {
  const decoded = decodeTextBuffer(buffer)
  const quality = inspectTextQuality(decoded.text)
  if (quality.corrupted) {
    throw fileError(422, 'FILE_TEXT_ENCODING_INVALID', '文件文字编码异常，请重新导出为 UTF-8、PDF 或图片后上传')
  }
  const canonical = quality.text
  if (!canonical.trim()) throw fileError(400, 'EMPTY_FILE', '文件中没有可读取的文字')
  return Buffer.from(canonical, 'utf8')
}

export function canonicalizeProjectTextBuffer(fileName: string, buffer: Buffer): Buffer {
  const extension = path.extname(fileName).slice(1).toLowerCase()
  const kind = FILE_KINDS[extension]
  if (kind?.signature !== 'text') return buffer
  const canonicalBuffer = canonicalizeUtf8TextBuffer(buffer)
  const canonical = canonicalBuffer.toString('utf8')
  if (extension === 'json') {
    try { JSON.parse(canonical) }
    catch { throw fileError(415, 'FILE_SIGNATURE_MISMATCH', 'JSON 文件内容无效') }
  }
  return canonicalBuffer
}

export async function decodeAndValidateProjectFile(input: { name: string; dataBase64: string; declaredType?: string }) {
  const nameQuality = inspectTextQuality(input.name)
  if (nameQuality.corrupted) throw fileError(422, 'FILE_NAME_ENCODING_INVALID', '文件名包含无法识别的文字，请重命名后上传')
  const name = nameQuality.text
  if (!name || name !== name.trim() || name.length > 255 || /[\u0000/\\]/.test(name) || path.basename(name) !== name) {
    throw fileError(400, 'INVALID_FILE_NAME', '文件名不能为空、越界或包含路径字符')
  }
  const extension = path.extname(name).slice(1).toLowerCase()
  const kind = FILE_KINDS[extension]
  if (!kind) throw fileError(415, 'FILE_UNSUPPORTED_TYPE', '仅支持 PDF、Word、Excel、PPT、图片、音频和文本类项目资料')

  const { payload: rawPayload, dataUrlMime } = parseBase64(input.dataBase64)
  const payload = rawPayload.replace(/[\r\n]/g, '')
  const maxBytes = boundedEnv('PROJECT_FILE_MAX_BYTES', 100 * 1024 * 1024, 1, 500 * 1024 * 1024)
  if (!isCanonicalBase64(payload)) {
    throw fileError(400, 'INVALID_FILE_ENCODING', '文件内容不是规范 Base64')
  }
  if (payload.length > Math.ceil(maxBytes / 3) * 4 + 4) throw fileError(413, 'PAYLOAD_TOO_LARGE', '文件不能超过配置的容量上限')
  let buffer = Buffer.from(payload, 'base64')
  if (!buffer.length || buffer.length > maxBytes) throw fileError(buffer.length ? 413 : 400, buffer.length ? 'PAYLOAD_TOO_LARGE' : 'EMPTY_FILE', buffer.length ? '文件不能超过配置的容量上限' : '不能上传空文件')
  if (buffer.toString('base64').replace(/=+$/, '') !== payload.replace(/=+$/, '')) {
    throw fileError(400, 'INVALID_FILE_ENCODING', '文件 Base64 解码校验失败')
  }

  const suppliedMimes = [normalizedMime(input.declaredType), normalizedMime(dataUrlMime)].filter((value): value is string => Boolean(value))
  const incompatibleMime = suppliedMimes.find((mime) => !kind.acceptedMimes.some((accepted) => accepted.toLowerCase() === mime))
  if (incompatibleMime) throw fileError(415, 'FILE_MIME_MISMATCH', `声明的 MIME ${incompatibleMime} 与 .${extension} 不一致`)
  buffer = canonicalizeProjectTextBuffer(name, buffer)
  await assertSignature(extension, kind, buffer)
  return {
    buffer, name, extension, typeLabel: kind.label, contentType: kind.mime,
    byteSize: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

export function projectFileMimeType(fileName: string): string {
  return FILE_KINDS[path.extname(fileName).slice(1).toLowerCase()]?.mime || 'application/octet-stream'
}

export function projectFilePreviewMimeType(fileName: string): string | null {
  const extension = path.extname(fileName).slice(1).toLowerCase()
  const kind = FILE_KINDS[extension]
  if (!kind || ['ole', 'ooxml-word', 'ooxml-sheet', 'ooxml-presentation'].includes(kind.signature)) return null
  if (['htm', 'html', 'md', 'markdown', 'csv', 'log'].includes(extension)) return 'text/plain; charset=utf-8'
  return kind.mime
}

export const supportedProjectFileExtensions = Object.freeze(Object.keys(FILE_KINDS))
