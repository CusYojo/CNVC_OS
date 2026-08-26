import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import type { RowDataPacket } from 'mysql2'
import { PDFParse } from 'pdf-parse'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

type ResolveHost = (hostname: string) => Promise<string[]>
type FetchLike = typeof fetch

const documentsTable = quoteMysqlIdentifier(mysqlTableName('lead_source_documents'))
const maxBytes = Math.max(256_000, Math.min(10_000_000, Number(process.env.LEAD_SOURCE_MAX_BYTES) || 5_000_000))
const cacheHours = Math.max(1, Math.min(168, Number(process.env.LEAD_SOURCE_CACHE_HOURS) || 24))
const userAgent = 'SBL-Jedi-EvidenceBot/1.0 (+controlled investment research)'

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalLeadSourceUrl(value: unknown) {
  const url = new URL(String(value ?? '').normalize('NFKC').trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Object.assign(new Error('unsupported source URL'), { code: 'SOURCE_URL_REJECTED' })
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|spm|from|source|ref|fbclid|gclid)/i.test(key)) url.searchParams.delete(key)
  }
  url.hostname = url.hostname.toLowerCase()
  url.protocol = url.protocol.toLowerCase()
  return url.toString().replace(/\?$/, '')
}

export function isPrivateLeadSourceAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '')
  if (normalized === '::' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true
  if (/^(?:fc|fd|fe8|fe9|fea|feb)/.test(normalized)) return true
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return false
  const [a, b] = normalized.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || a >= 224
}

async function defaultResolveHost(hostname: string) {
  return (await lookup(hostname, { all: true })).map((record) => record.address)
}

async function assertPublicUrl(url: URL, resolveHost: ResolveHost) {
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw Object.assign(new Error('private hostname rejected'), { code: 'SOURCE_SSRF_REJECTED' })
  }
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname)
  if (!addresses.length || addresses.some(isPrivateLeadSourceAddress)) {
    throw Object.assign(new Error('private or unresolved source address rejected'), { code: 'SOURCE_SSRF_REJECTED' })
  }
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&[a-z][a-z0-9]+;/gi, ' ')
}

function htmlText(html: string) {
  return decodeHtml(html)
    .replace(/<(?:script|style|noscript|svg)\b[\s\S]*?<\/(?:script|style|noscript|svg)>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/[ \t\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
}

function metaContent(html: string, names: string[]) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const direct = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1]
    const reverse = html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["']`, 'i'))?.[1]
    if (direct || reverse) return decodeHtml(direct || reverse || '').trim()
  }
  return ''
}

function normalizeEvidenceText(value: string) {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

export function sourceDocumentContainsQuote(documentText: string, quote: string) {
  const haystack = normalizeEvidenceText(documentText)
  const needle = normalizeEvidenceText(quote)
  return needle.length >= 4 && haystack.includes(needle)
}

function robotsAllows(body: string, pathname: string) {
  let applies = false
  const disallow: string[] = []
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    const [key, ...rest] = line.split(':')
    const value = rest.join(':').trim()
    if (key?.trim().toLowerCase() === 'user-agent') applies = value === '*'
    else if (applies && key?.trim().toLowerCase() === 'disallow' && value) disallow.push(value)
  }
  return !disallow.some((path) => pathname.startsWith(path))
}

async function respectRobots(url: URL, fetchImpl: FetchLike, resolveHost: ResolveHost) {
  const robots = new URL('/robots.txt', url)
  await assertPublicUrl(robots, resolveHost)
  try {
    const response = await fetchImpl(robots, { redirect: 'manual', signal: AbortSignal.timeout(8_000), headers: { 'user-agent': userAgent } })
    if (!response.ok) return
    const body = (await response.text()).slice(0, 200_000)
    if (!robotsAllows(body, url.pathname)) throw Object.assign(new Error('robots policy disallows source fetch'), { code: 'SOURCE_ROBOTS_REJECTED' })
  } catch (error) {
    if ((error as { code?: string }).code === 'SOURCE_ROBOTS_REJECTED') throw error
    // A missing or temporarily unavailable robots.txt does not manufacture permission;
    // the fetch still remains public-only, size-bounded and read-only.
  }
}

async function responseBytes(response: Response) {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maxBytes) throw Object.assign(new Error('source document exceeds byte budget'), { code: 'SOURCE_TOO_LARGE' })
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > maxBytes) throw Object.assign(new Error('source document exceeds byte budget'), { code: 'SOURCE_TOO_LARGE' })
  return buffer
}

async function extractDocument(buffer: Buffer, contentType: string, finalUrl: string) {
  if (/pdf/i.test(contentType) || /\.pdf(?:$|\?)/i.test(finalUrl)) {
    const parser = new PDFParse({ data: buffer })
    try {
      const result = await parser.getText()
      return { text: result.text.slice(0, 1_000_000), title: '', publisher: '', publishedAt: null, kind: 'paper_pdf' }
    } finally { await parser.destroy() }
  }
  if (!/(?:html|text|xml|json)/i.test(contentType)) {
    throw Object.assign(new Error(`unsupported source content type: ${contentType || 'unknown'}`), { code: 'SOURCE_CONTENT_UNSUPPORTED' })
  }
  const html = buffer.toString('utf8')
  const text = /html|xml/i.test(contentType) ? htmlText(html) : html.replace(/\s+/g, ' ').trim()
  const title = metaContent(html, ['og:title', 'twitter:title']) || decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, ' ').trim()
  const publisher = metaContent(html, ['og:site_name', 'article:publisher', 'publisher'])
  const date = metaContent(html, ['article:published_time', 'datePublished', 'date', 'pubdate'])
  const publishedAt = date && !Number.isNaN(Date.parse(date)) ? new Date(date) : null
  return { text: text.slice(0, 1_000_000), title, publisher, publishedAt, kind: 'web_page' }
}

export type LeadSourceDocument = {
  id: string | null
  canonicalUrl: string
  finalUrl: string
  status: 'ready'
  httpStatus: number
  contentType: string
  title: string
  publisher: string
  publishedAt: Date | null
  contentHash: string
  text: string
  accessedAt: Date
  cached: boolean
}

export async function fetchLeadSourceDocument(input: {
  url: string
  leadId?: string
  fetchImpl?: FetchLike
  resolveHost?: ResolveHost
  persist?: boolean
  respectRobots?: boolean
}): Promise<LeadSourceDocument> {
  const canonicalUrl = canonicalLeadSourceUrl(input.url)
  const canonicalHash = sha256(canonicalUrl)
  const fetchImpl = input.fetchImpl ?? fetch
  const resolveHost = input.resolveHost ?? defaultResolveHost
  const persist = input.persist !== false
  if (persist && !input.fetchImpl) {
    const [cached] = await pool.query<Array<RowDataPacket & {
      id: string; final_url: string; http_status: number; content_type: string; title: string | null;
      publisher: string | null; published_at: Date | null; content_hash: string; extracted_text: string; accessed_at: Date;
    }>>(`SELECT id,final_url,http_status,content_type,title,publisher,published_at,content_hash,extracted_text,accessed_at
         FROM ${documentsTable} WHERE canonical_url_hash=? AND fetch_status='ready' AND expires_at>NOW(3)
         ORDER BY accessed_at DESC,id DESC LIMIT 1`, [canonicalHash])
    if (cached[0]) return {
      id: cached[0].id, canonicalUrl, finalUrl: cached[0].final_url, status: 'ready', httpStatus: Number(cached[0].http_status),
      contentType: cached[0].content_type, title: cached[0].title || '', publisher: cached[0].publisher || '',
      publishedAt: cached[0].published_at, contentHash: cached[0].content_hash, text: cached[0].extracted_text,
      accessedAt: cached[0].accessed_at, cached: true,
    }
  }

  let current = new URL(canonicalUrl)
  if (input.respectRobots !== false) await respectRobots(current, fetchImpl, resolveHost)
  let response: Response | null = null
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    await assertPublicUrl(current, resolveHost)
    response = await fetchImpl(current, {
      redirect: 'manual', signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.1' },
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    if (!location || redirects === 3) throw Object.assign(new Error('source redirect limit exceeded'), { code: 'SOURCE_REDIRECT_REJECTED' })
    current = new URL(location, current)
    if (!['http:', 'https:'].includes(current.protocol)) throw Object.assign(new Error('source redirect protocol rejected'), { code: 'SOURCE_REDIRECT_REJECTED' })
  }
  if (!response || !response.ok) throw Object.assign(new Error(`source fetch failed: HTTP ${response?.status || 0}`), { code: 'SOURCE_FETCH_FAILED', httpStatus: response?.status || 0 })
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  const buffer = await responseBytes(response)
  const extracted = await extractDocument(buffer, contentType, current.toString())
  if (!normalizeEvidenceText(extracted.text)) throw Object.assign(new Error('source document has no extractable text'), { code: 'SOURCE_PARSE_EMPTY' })
  const accessedAt = new Date()
  const contentHash = sha256(extracted.text)
  let id: string | null = null
  if (persist) {
    id = randomUUID()
    await pool.query(
      `INSERT INTO ${documentsTable}
        (id,lead_id,canonical_url,canonical_url_hash,final_url,fetch_status,http_status,content_type,title,publisher,
         published_at,content_hash,extracted_text,error_code,accessed_at,expires_at,created_at)
       VALUES (?,?,?,?,?,'ready',?,?,?,?,?,?,?,NULL,?,DATE_ADD(?,INTERVAL ? HOUR),NOW(3))
       ON DUPLICATE KEY UPDATE id=id`,
      [id, input.leadId ?? null, canonicalUrl, canonicalHash, current.toString(), response.status, contentType || extracted.kind,
        extracted.title || null, extracted.publisher || null, extracted.publishedAt, contentHash, extracted.text,
        accessedAt, accessedAt, cacheHours],
    )
    const [saved] = await pool.query<Array<RowDataPacket & { id: string }>>(
      `SELECT id FROM ${documentsTable} WHERE canonical_url_hash=? AND content_hash=? LIMIT 1`, [canonicalHash, contentHash],
    )
    id = saved[0]?.id || id
  }
  return {
    id, canonicalUrl, finalUrl: current.toString(), status: 'ready', httpStatus: response.status,
    contentType: contentType || extracted.kind, title: extracted.title, publisher: extracted.publisher,
    publishedAt: extracted.publishedAt, contentHash, text: extracted.text, accessedAt, cached: false,
  }
}
