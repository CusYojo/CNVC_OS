import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { radarCandidates, radarCollectorStates, radarSourceRegistry } from '../db/schema.js'
import { ingestRadarCandidates, saveRadarCollectorState } from './radarDataMigrationService.js'
import { authorContributions } from './externalPaperMetadataService.js'
import { arxivPaperId, fetchArxivResearchMetadata } from './paperResearchMetadataService.js'
import {
  classifyPaperContent,
  normalizePaperIdentity,
  normalizePaperPublicationDate,
} from './leadEnrichmentContract.js'
import type { RadarPublicSourceConfig, RadarPublicSourceType } from './radarSourceCatalog.js'

type JsonObject = Record<string, unknown>

interface ManagedPublicSource extends RadarPublicSourceConfig {
  enabled: boolean
}

interface WechatAccount {
  group: string
  accountName: string
  wxName: string
}

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
  Accept: 'text/html,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}
const ARXIV_LEGACY_MIN_INTERVAL_MS = Math.max(
  3_000,
  Number(process.env.ARXIV_LEGACY_MIN_INTERVAL_MS) || 3_200,
)
const ARXIV_LEGACY_MAX_ATTEMPTS = 2
let arxivLegacyRequestQueue = Promise.resolve()
let arxivLegacyLastStartedAt = 0
const GSDATA_API_URL = 'http://databus.gsdata.cn:8888/api/service'
const GSDATA_WECHAT_ROUTER = '/weixin/article/search1'
const GSDATA_WECHAT_CONTENT_ROUTER = '/weixin/article/content'
const PITCHHUB_FLOW_URL = 'https://gateway.36kr.com/api/mis/nav/home/project/bulletin/flow'

const PROJECT_TERMS = [
  '人工智能', '大模型', 'AI', '机器人', '芯片', '半导体', '医疗', '医药', '材料', '新能源',
  '算法', '软件', '平台', '产品', '技术', '成果', '专利', '临床', '量产', '客户', '订单',
]
const INVESTMENT_TERMS = [
  '融资', '投资', '天使轮', '种子轮', 'Pre-A', 'A轮', 'B轮', 'C轮', '估值', '并购',
  '募资', '创始人', '创业', '初创', '商业化', '产业化', '成果转化',
]

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/[\u200b-\u200f\ufeff]/g, '').replace(/\s+/g, ' ').trim()
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  }
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(x?[0-9a-f]+);/gi, (_match, code: string) => {
      const parsed = Number.parseInt(code.startsWith('x') || code.startsWith('X') ? code.slice(1) : code, code.toLowerCase().startsWith('x') ? 16 : 10)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : ''
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match)
}

function htmlToText(value: unknown, maxLength = 12_000): string {
  return cleanText(decodeEntities(String(value ?? '')
    .replace(/<(script|style|svg|noscript|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|li|h[1-6]|blockquote|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))).slice(0, maxLength)
}

function xmlBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, 'gi'))]
    .map((match) => match[1])
}

function xmlValue(block: string, ...tags: string[]): string {
  for (const tag of tags) {
    const match = block.match(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, 'i'))
    if (match) return htmlToText(match[1])
  }
  return ''
}

function xmlValues(block: string, tag: string): string[] {
  return xmlBlocks(block, tag).map((value) => htmlToText(value)).filter(Boolean)
}

function xmlLink(block: string): string {
  const alternate = block.match(/<(?:[\w-]+:)?link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i)
    ?? block.match(/<(?:[\w-]+:)?link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i)
  return cleanText(decodeEntities(alternate?.[1] ?? xmlValue(block, 'link')))
}

function xmlCategories(block: string): string[] {
  return [...block.matchAll(/<(?:[\w-]+:)?category\b[^>]*(?:term|label)=["']([^"']+)["'][^>]*\/?>/gi)]
    .map((match) => cleanText(decodeEntities(match[1]))).filter(Boolean)
}

function parseFeedAuthors(block: string): string[] {
  const atomNames = xmlValues(block, 'name')
  if (atomNames.length > 0) return [...new Set(atomNames)]

  const rssAuthors = xmlValues(block, 'author')
  if (rssAuthors.length > 0) return [...new Set(rssAuthors)]

  // arXiv's category RSS feeds expose the complete author list in
  // <dc:creator> rather than Atom's <author><name> structure.
  return [...new Set(xmlValues(block, 'creator').flatMap((value) => (
    value.split(/\s*[,;；，]\s*/).map((author) => cleanText(author)).filter(Boolean)
  )))]
}

export function parseFeedEntries(xml: string): Array<{ title: string; summary: string; link: string; publishedAt: string; updatedAt: string; authors: string[]; categories: string[]; id: string }> {
  const blocks = xmlBlocks(xml, 'entry')
  const entries = blocks.length > 0 ? blocks : xmlBlocks(xml, 'item')
  return entries.map((block) => ({
    title: xmlValue(block, 'title'),
    summary: xmlValue(block, 'summary', 'description', 'content', 'encoded'),
    link: xmlLink(block),
    publishedAt: xmlValue(block, 'published', 'pubDate', 'date'),
    updatedAt: xmlValue(block, 'updated', 'lastBuildDate'),
    authors: parseFeedAuthors(block),
    categories: xmlCategories(block),
    id: xmlValue(block, 'id', 'guid'),
  })).filter((entry) => entry.title)
}

function candidateScore(group: string, title: string, summary: string) {
  const text = `${title}\n${summary}`.toLowerCase()
  const projectHits = PROJECT_TERMS.filter((term) => text.includes(term.toLowerCase())).slice(0, 8)
  const investmentHits = INVESTMENT_TERMS.filter((term) => text.includes(term.toLowerCase())).slice(0, 8)
  const base = group === '论文' ? 50 : group === '专利' ? 45 : group === '高校成果' ? 35 : 20
  const score = Math.min(100, base + projectHits.length * 4 + investmentHits.length * 7)
  const worthAttention = group === '论文' || group === '专利' || score >= 35
  const signals = [
    ...projectHits.map((term) => ({ code: 'technology_keyword', score: 4, detail: term })),
    ...investmentHits.map((term) => ({ code: 'investment_keyword', score: 7, detail: term })),
  ]
  return {
    score,
    worthAttention,
    signals,
    decision: worthAttention ? 'watchlist' : 'filter',
    decision_label: worthAttention ? '保留观察' : '过滤',
    filter_reasons: worthAttention ? [] : ['缺少明确的项目或投资信号'],
  }
}

function sourceCandidate(source: ManagedPublicSource, input: {
  title: string
  summary?: string
  link?: string
  publishedAt?: string
  sourceId?: string
  authors?: string[]
  categories?: string[]
  extra?: JsonObject
}): JsonObject {
  const title = cleanText(input.title)
  const summary = htmlToText(input.summary ?? '', 4_000)
  const link = cleanText(input.link)
  const sourceId = cleanText(input.sourceId) || link || sha256(`${source.key}:${title}`).slice(0, 24)
  const score = candidateScore(source.group, title, summary)
  const isArxiv = source.type === 'arxiv_rss'
  const isOpenAlex = source.type === 'openalex_api'
  const arxivMatch = `${sourceId} ${link}`.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?)/i)
  const arxivId = arxivMatch?.[1] ?? ''
  return {
    source: isArxiv ? 'arxiv' : isOpenAlex ? 'openalex' : 'investment',
    source_id: isArxiv && arxivId ? arxivId : sourceId,
    fingerprint: md5(sourceId || title).slice(0, 16),
    title,
    summary,
    authors: input.authors ?? [],
    first_author: input.authors?.[0] ?? '',
    second_author: input.authors?.[1] ?? '',
    source_name: source.name,
    source_group: source.group,
    source_key: source.key,
    source_type: source.type,
    categories: input.categories?.length ? input.categories : [source.group, source.name],
    published_at: cleanText(input.publishedAt),
    updated_at: '',
    link: isArxiv && arxivId ? `https://arxiv.org/abs/${arxivId}` : link,
    pdf_url: isArxiv && arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : '',
    attention_score: score.score,
    worth_attention: score.worthAttention,
    signals: score.signals,
    decision: score.decision,
    decision_label: score.decision_label,
    filter_reasons: score.filter_reasons,
    collected_at: new Date().toISOString(),
    ...(input.extra ?? {}),
  }
}

function openAlexAbstract(invertedIndex: unknown): string {
  if (!invertedIndex || typeof invertedIndex !== 'object' || Array.isArray(invertedIndex)) return ''
  const words: Array<{ position: number; word: string }> = []
  for (const [word, rawPositions] of Object.entries(invertedIndex as JsonObject)) {
    if (!Array.isArray(rawPositions)) continue
    for (const rawPosition of rawPositions) {
      const position = Number(rawPosition)
      if (Number.isSafeInteger(position) && position >= 0 && position < 100_000) words.push({ position, word })
    }
  }
  return words.sort((left, right) => left.position - right.position).map((item) => item.word).join(' ').slice(0, 12_000)
}

function openAlexResourceType(value: unknown): string {
  const normalized = cleanText(value).toLowerCase()
  if (normalized === 'article') return '期刊论文'
  if (normalized === 'dissertation') return '学位论文'
  if (['dataset', 'model'].includes(normalized)) return '研究数据/模型'
  if (normalized === 'standard') return '研究标准/框架'
  return cleanText(value) || '科研成果'
}

function openAlexLicense(value: unknown) {
  const slug = cleanText(value).toLowerCase()
  const mappings: Record<string, { code: string; url: string }> = {
    'cc-by': { code: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
    'cc-by-sa': { code: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
    'cc-by-nc': { code: 'CC BY-NC 4.0', url: 'https://creativecommons.org/licenses/by-nc/4.0/' },
    'cc-by-nc-sa': { code: 'CC BY-NC-SA 4.0', url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' },
    'cc-by-nc-nd': { code: 'CC BY-NC-ND 4.0', url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/' },
  }
  const mapped = mappings[slug]
  return mapped ? { ...mapped, label: mapped.code, status: 'confirmed' as const, scope: 'article' as const } : undefined
}

export function parseOpenAlexWorks(source: ManagedPublicSource, payload: unknown, limit = 50): JsonObject[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('OpenAlex 返回格式无效')
  const results = Array.isArray((payload as JsonObject).results) ? (payload as JsonObject).results as unknown[] : []
  const rows: JsonObject[] = []
  for (const raw of results.slice(0, Math.min(100, Math.max(1, limit)))) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const work = raw as JsonObject
    const openAlexId = cleanText(work.id)
    const sourceId = openAlexId.split('/').pop() || openAlexId
    const title = cleanText(work.title || work.display_name)
    if (!sourceId || !title) continue
    const authorships = Array.isArray(work.authorships) ? work.authorships : []
    const authors = authorships.flatMap((authorship) => {
      if (!authorship || typeof authorship !== 'object' || Array.isArray(authorship)) return []
      const author = (authorship as JsonObject).author
      return author && typeof author === 'object' && !Array.isArray(author)
        ? [cleanText((author as JsonObject).display_name)].filter(Boolean)
        : []
    })
    const paperAuthors = authorships.flatMap((authorship, position) => {
      if (!authorship || typeof authorship !== 'object' || Array.isArray(authorship)) return []
      const authorRecord = authorship as JsonObject
      const author = authorRecord.author && typeof authorRecord.author === 'object' && !Array.isArray(authorRecord.author)
        ? authorRecord.author as JsonObject : {}
      const name = cleanText(author.display_name)
      if (!name) return []
      const institutions = (Array.isArray(authorRecord.institutions) ? authorRecord.institutions : []).flatMap((institution) => {
        if (!institution || typeof institution !== 'object' || Array.isArray(institution)) return []
        const item = institution as JsonObject
        const institutionName = cleanText(item.display_name)
        return institutionName ? [{
          id: cleanText(item.id).split('/').pop() || cleanText(item.id),
          name: institutionName,
          evidenceUrl: openAlexId,
        }] : []
      })
      return [{
        name,
        normalizedName: name.normalize('NFKC').toLocaleLowerCase('en-US'),
        position: position + 1,
        role: position === 0 ? 'first_author' : 'coauthor',
        openAlexAuthorId: cleanText(author.id).split('/').pop() || cleanText(author.id),
        orcid: cleanText(author.orcid).replace(/^https?:\/\/orcid\.org\//i, ''),
        affiliations: institutions,
        identityStatus: cleanText(author.id) || cleanText(author.orcid) ? 'confirmed' : 'claimed',
        evidenceUrl: openAlexId,
      }]
    })
    const affiliations = [...new Map(authorships.flatMap((authorship) => {
      if (!authorship || typeof authorship !== 'object' || Array.isArray(authorship)) return []
      const authorRecord = authorship as JsonObject
      const institutions = Array.isArray(authorRecord.institutions) ? authorRecord.institutions : []
      return institutions.flatMap((institution) => {
        if (!institution || typeof institution !== 'object' || Array.isArray(institution)) return []
        const item = institution as JsonObject
        const name = cleanText(item.display_name)
        return name ? [[name.toLocaleLowerCase('en-US'), { name, sourceUrl: openAlexId, evidenceStatus: 'source_confirmed' as const }] as const] : []
      })
    })).values()]
    const topics = (Array.isArray(work.topics) ? work.topics : []).flatMap((topic) => (
      topic && typeof topic === 'object' && !Array.isArray(topic)
        ? [cleanText((topic as JsonObject).display_name)].filter(Boolean)
        : []
    ))
    const keywords = (Array.isArray(work.keywords) ? work.keywords : []).flatMap((keyword) => (
      keyword && typeof keyword === 'object' && !Array.isArray(keyword)
        ? [cleanText((keyword as JsonObject).display_name)].filter(Boolean)
        : []
    ))
    const primaryLocation = work.primary_location && typeof work.primary_location === 'object' && !Array.isArray(work.primary_location)
      ? work.primary_location as JsonObject : {}
    const bestOaLocation = work.best_oa_location && typeof work.best_oa_location === 'object' && !Array.isArray(work.best_oa_location)
      ? work.best_oa_location as JsonObject : {}
    const doi = cleanText(work.doi)
    const rawPdfUrl = cleanText(bestOaLocation.pdf_url || primaryLocation.pdf_url)
    const landingCandidates = [doi, bestOaLocation.landing_page_url, primaryLocation.landing_page_url, openAlexId]
      .map(cleanText).filter(Boolean)
    const link = landingCandidates.find((url) => !['supplement', 'paper_pdf'].includes(classifyPaperContent({ url }))) || openAlexId
    const declaredPublishedAt = cleanText(work.publication_date)
    const recordCreatedAt = cleanText(work.created_date)
    const publication = normalizePaperPublicationDate({ declaredPublishedAt, recordCreatedAt })
    const publishedAt = publication.publishedAt
    const license = openAlexLicense(bestOaLocation.license || primaryLocation.license)
    const contributions = authorContributions(authors)
    const researchTeam = { name: `${title}联合研究团队`, basis: 'paper_coauthorship', memberCount: authors.length }
    const rights = {
      ...(license ? { articleLicense: license } : {}),
      intellectualProperty: { status: 'undisclosed', label: '未披露', note: '论文或成果开放许可不等于知识产权归属' },
    }
    const resourceType = openAlexResourceType(work.type)
    const normalizedIdentity = normalizePaperIdentity({
      provider: 'openalex', sourceId, openAlexId, doi, landingPageUrl: link, pdfUrl: rawPdfUrl,
    })
    const paperIdentity = publication.status === 'review' ? {
      ...normalizedIdentity,
      sourceStatus: 'review' as const,
      reviewReasons: [...normalizedIdentity.reviewReasons, ...publication.reviewReasons],
    } : normalizedIdentity
    rows.push(sourceCandidate(source, {
      title,
      summary: openAlexAbstract(work.abstract_inverted_index),
      link,
      publishedAt,
      sourceId,
      authors,
      categories: [...new Set([source.group, source.name, ...topics.slice(0, 8), ...keywords.slice(0, 8)])],
      extra: {
        openalex_id: openAlexId,
        doi,
        pdf_url: classifyPaperContent({ url: rawPdfUrl }) === 'paper_pdf' ? rawPdfUrl : '',
        cited_by_count: Number(work.cited_by_count || 0),
        primary_topic: topics[0] || '',
        openalex_keywords: keywords,
        declared_published_at: declaredPublishedAt,
        publication_date_status: publication.status === 'review' ? 'source_declared_future' : 'confirmed',
        publication_date_basis: publication.basis,
        paper_source_identity: paperIdentity,
        paper_content_links: [
          { url: link, contentType: classifyPaperContent({ url: link }) },
          ...(rawPdfUrl ? [{ url: rawPdfUrl, contentType: classifyPaperContent({ url: rawPdfUrl }) }] : []),
        ],
        paper_authors: paperAuthors,
        paper_author_affiliations: paperAuthors.flatMap((author) => author.affiliations.map((affiliation) => ({
          author: author.name,
          authorOpenAlexId: author.openAlexAuthorId,
          affiliation: affiliation.name,
          institutionOpenAlexId: affiliation.id,
          evidenceUrl: affiliation.evidenceUrl,
          status: 'source_confirmed',
        }))),
        paper_affiliations: affiliations,
        paper_research_team: researchTeam,
        paper_author_contributions: contributions,
        paper_rights: rights,
        paper_metadata_source: {
          provider: 'OpenAlex',
          url: `https://api.openalex.org/works/${sourceId}`,
          recordCreatedAt,
          declaredPublishedAt,
          publicationDateStatus: publication.status === 'review' ? 'source_declared_future' : 'confirmed',
          publicationDateBasis: publication.basis,
        },
        paper_resource_type: resourceType,
      },
    }))
  }
  return rows
}

export function buildOpenAlexWorksUrl(input: {
  sourceUrl: string
  apiKey?: string
  mailto?: string
  query: string
  fromDate: string
  toDate: string
  limit: number
}) {
  const url = new URL(input.sourceUrl)
  const apiKey = cleanText(input.apiKey)
  if (apiKey) url.searchParams.set('api_key', apiKey)
  const mailto = cleanText(input.mailto)
  if (mailto) url.searchParams.set('mailto', mailto)
  url.searchParams.set('search', cleanText(input.query) || 'artificial intelligence')
  url.searchParams.set('filter', `from_publication_date:${input.fromDate},to_publication_date:${input.toDate}`)
  url.searchParams.set('sort', 'publication_date:desc')
  url.searchParams.set('per_page', String(Math.min(100, Math.max(1, input.limit))))
  return url.toString()
}

async function collectOpenAlex(source: ManagedPublicSource, signal: AbortSignal, limit: number, options: { query?: string; days?: number } = {}): Promise<JsonObject[]> {
  const days = Math.min(90, Math.max(1, options.days ?? (Number(source.days) || 14)))
  const fromDate = shanghaiDate(-days)
  const toDate = shanghaiDate()
  const url = buildOpenAlexWorksUrl({
    sourceUrl: source.url,
    apiKey: process.env.OPENALEX_API_KEY,
    mailto: process.env.OPENALEX_MAILTO,
    query: cleanText(options.query || source.keyword || process.env.OPENALEX_SEARCH_QUERY),
    fromDate,
    toDate,
    limit,
  })
  const payload = JSON.parse(await fetchText(url, signal, 35_000)) as unknown
  return parseOpenAlexWorks(source, payload, limit)
}

function isArxivLegacyApiUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    return url.hostname === 'rss.arxiv.org'
      || (url.hostname === 'export.arxiv.org' && url.pathname.startsWith('/api/'))
  } catch {
    return false
  }
}

async function waitForDelay(delayMs: number, signal: AbortSignal) {
  if (delayMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, delayMs)
    const abort = () => {
      clearTimeout(timer)
      cleanup()
      reject(signal.reason instanceof Error ? signal.reason : new Error('request aborted'))
    }
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
  })
}

function retryAfterMs(response: Response) {
  const retryAfter = response.headers.get('retry-after')?.trim() || ''
  if (/^\d+(?:\.\d+)?$/.test(retryAfter)) return Math.ceil(Number(retryAfter) * 1_000)
  const retryAt = Date.parse(retryAfter)
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0
}

async function fetchTextNow(url: string, signal: AbortSignal, timeoutMs: number, init: RequestInit): Promise<string> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('request aborted')
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(`request timeout after ${timeoutMs}ms`)), timeoutMs)
  try {
    const response = await fetch(url, {
      ...init,
      headers: { ...FETCH_HEADERS, ...(init.headers ?? {}) },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!response.ok) {
      const error = Object.assign(new Error(`HTTP ${response.status} ${response.statusText}`), {
        status: response.status,
        retryAfterMs: retryAfterMs(response),
      })
      await response.body?.cancel().catch(() => undefined)
      throw error
    }
    return await response.text()
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

async function fetchArxivLegacyText(url: string, signal: AbortSignal, timeoutMs: number, init: RequestInit) {
  let releaseQueue!: () => void
  const previous = arxivLegacyRequestQueue
  arxivLegacyRequestQueue = new Promise<void>((resolve) => { releaseQueue = resolve })
  await previous
  try {
    let lastError: unknown
    for (let attempt = 1; attempt <= ARXIV_LEGACY_MAX_ATTEMPTS; attempt += 1) {
      const spacingMs = ARXIV_LEGACY_MIN_INTERVAL_MS - (Date.now() - arxivLegacyLastStartedAt)
      await waitForDelay(spacingMs, signal)
      arxivLegacyLastStartedAt = Date.now()
      try {
        return await fetchTextNow(url, signal, timeoutMs, init)
      } catch (error) {
        lastError = error
        const detail = error as Error & { status?: number; retryAfterMs?: number }
        if (detail.status !== 429 || attempt >= ARXIV_LEGACY_MAX_ATTEMPTS) throw error
        const backoffMs = Math.max(ARXIV_LEGACY_MIN_INTERVAL_MS, detail.retryAfterMs || 0)
        await waitForDelay(backoffMs, signal)
      }
    }
    throw lastError
  } finally {
    releaseQueue()
  }
}

async function fetchText(url: string, signal: AbortSignal, timeoutMs = 25_000, init: RequestInit = {}): Promise<string> {
  return isArxivLegacyApiUrl(url)
    ? await fetchArxivLegacyText(url, signal, timeoutMs, init)
    : await fetchTextNow(url, signal, timeoutMs, init)
}

function parseRssSource(source: ManagedPublicSource, xml: string, limit: number): JsonObject[] {
  return parseFeedEntries(xml).slice(0, limit).map((entry) => sourceCandidate(source, {
    title: entry.title,
    summary: entry.summary,
    link: entry.link,
    publishedAt: entry.publishedAt || entry.updatedAt,
    sourceId: entry.id,
    authors: entry.authors,
    categories: entry.categories,
  }))
}

function parseHtmlListSource(source: ManagedPublicSource, html: string, limit: number): JsonObject[] {
  const rows: JsonObject[] = []
  const seen = new Set<string>()
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  for (const match of html.matchAll(anchorPattern)) {
    const href = cleanText(decodeEntities(match[1]))
    const title = htmlToText(match[2], 300)
    if (title.length < 6 || seen.has(title)) continue
    const combined = `${title} ${href}`.toLowerCase()
    if (![...PROJECT_TERMS, ...INVESTMENT_TERMS].some((term) => combined.includes(term.toLowerCase()))) continue
    let link = href
    try { link = new URL(href, source.url).toString() } catch { /* preserve the source value */ }
    rows.push(sourceCandidate(source, { title, summary: title, link }))
    seen.add(title)
    if (rows.length >= limit) break
  }
  return rows
}

function shanghaiDate(daysOffset = 0): string {
  const now = new Date(Date.now() + daysOffset * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

function pitchhubDate(value: unknown): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return ''
  return shanghaiDateFrom(new Date(numeric > 10_000_000_000 ? numeric : numeric * 1_000))
}

function shanghaiDateFrom(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
}

function pitchhubItem(source: ManagedPublicSource, raw: JsonObject): JsonObject | null {
  const material = raw.templateMaterial && typeof raw.templateMaterial === 'object' ? raw.templateMaterial as JsonObject : {}
  const title = cleanText(material.widgetTitle)
  const itemId = cleanText(raw.itemId || material.itemId)
  if (!title || !itemId) return null
  const route = cleanText(raw.route)
  const link = route.startsWith('detail_article') ? `https://36kr.com/p/${itemId}` : `https://36kr.com/newsflashes/${itemId}`
  const project = raw.projectCard && typeof raw.projectCard === 'object' ? raw.projectCard as JsonObject : {}
  return sourceCandidate(source, {
    title,
    summary: cleanText(material.widgetContent),
    link,
    sourceId: itemId,
    publishedAt: pitchhubDate(material.publishTime),
    extra: {
      source_time_label: pitchhubDate(material.publishTime),
      project_name: cleanText(project.name),
      project_brief: cleanText(project.briefIntro),
    },
  })
}

function embeddedJsonArray(html: string, property: string): unknown[] {
  const marker = `"${property}":`
  const markerIndex = html.indexOf(marker)
  if (markerIndex < 0) return []
  const start = html.indexOf('[', markerIndex + marker.length)
  if (start < 0) return []
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === '[') depth += 1
    else if (character === ']' && --depth === 0) {
      try {
        const value = JSON.parse(html.slice(start, index + 1))
        return Array.isArray(value) ? value : []
      } catch { return [] }
    }
  }
  return []
}

async function fetchPitchhub(source: ManagedPublicSource, html: string, signal: AbortSignal, limit: number): Promise<JsonObject[]> {
  const yesterday = shanghaiDate(-1)
  const rows: JsonObject[] = []
  const seen = new Set<string>()
  for (const raw of embeddedJsonArray(html, 'itemList')) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = pitchhubItem(source, raw as JsonObject)
    if (!item || cleanText(item.published_at) !== yesterday) continue
    const key = cleanText(item.source_id)
    if (seen.has(key)) continue
    rows.push(item)
    seen.add(key)
    if (rows.length >= limit) return rows
  }
  const callback = cleanText(html.match(/(?:\\?"pageCallback\\?"\s*:\s*\\?")([^"\\]+)/)?.[1])
  let pageCallback = callback
  let hasNext = /(?:\\?"hasNextPage\\?"\s*:\s*)1/.test(html)
  const maxPages = Math.min(12, Math.max(1, Number(source.max_pages) || 8))
  for (let page = 1; page < maxPages && pageCallback && hasNext && rows.length < limit; page += 1) {
    const body = {
      partner_id: 'web', timestamp: Date.now(), partner_version: '1.0.0',
      param: { pageSize: Math.min(20, Math.max(1, limit)), pageEvent: 1, pageCallback, siteId: 1, platformId: 2 },
    }
    const text = await fetchText(PITCHHUB_FLOW_URL, signal, 25_000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://pitchhub.36kr.com', Referer: source.url },
      body: JSON.stringify(body),
    })
    const payload = JSON.parse(text) as JsonObject
    if (Number(payload.code) !== 0) throw new Error(cleanText(payload.message || payload.msg || text).slice(0, 500))
    const data = payload.data && typeof payload.data === 'object' ? payload.data as JsonObject : {}
    const itemList = Array.isArray(data.itemList) ? data.itemList : []
    let sawOlder = false
    for (const raw of itemList) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const item = pitchhubItem(source, raw as JsonObject)
      if (!item) continue
      const date = cleanText(item.published_at)
      if (date === yesterday && !seen.has(cleanText(item.source_id))) {
        rows.push(item)
        seen.add(cleanText(item.source_id))
      } else if (date && date < yesterday) sawOlder = true
      if (rows.length >= limit) break
    }
    hasNext = Boolean(data.hasNextPage) && !sawOlder
    pageCallback = cleanText(data.pageCallback)
  }
  if (rows.length > 0) return rows
  // Keep a best-effort HTML fallback for a changed or missing page callback.
  const anchors = [...html.matchAll(/<a\b[^>]*href=["']([^"']*(?:newsflashes|\/p\/)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)]
  for (const match of anchors) {
    const title = htmlToText(match[2], 300)
    if (!title || seen.has(title)) continue
    rows.push(sourceCandidate(source, { title, summary: title, link: new URL(match[1], source.url).toString(), publishedAt: yesterday }))
    seen.add(title)
    if (rows.length >= limit) break
  }
  return rows
}

async function collectOnePublicSource(source: ManagedPublicSource, signal: AbortSignal, requestedLimit?: number): Promise<JsonObject[]> {
  if (['manual', 'wanfang_search'].includes(source.type)) return []
  const limit = Math.min(100, Math.max(1, requestedLimit ?? (Number(source.max_entries_per_run) || 20)))
  if (source.type === 'openalex_api') return await collectOpenAlex(source, signal, limit)
  const text = await fetchText(source.url, signal)
  if (source.type === 'rss' || source.type === 'arxiv_rss') return parseRssSource(source, text, limit)
  if (source.type === 'html_list') return parseHtmlListSource(source, text, limit)
  if (source.type === '36kr_financing_flash') return await fetchPitchhub(source, text, signal, limit)
  throw new Error(`unsupported source type: ${source.type}`)
}

async function collectDetailedArxiv(
  enabledSources: ManagedPublicSource[],
  signal: AbortSignal,
  options: { categories?: string[]; keywords?: string[]; maxResults?: number; days?: number; watchAuthors?: string[] } = {},
): Promise<JsonObject[]> {
  const source = enabledSources.find((item) => item.type === 'arxiv_rss')
  if (!source) return []
  const categories = (options.categories?.length ? options.categories : ['cs.AI', 'cs.CL', 'cs.CV', 'cs.LG'])
    .map((value) => cleanText(value)).filter((value) => /^[a-z-]+(?:\.[a-z-]+)?$/i.test(value)).slice(0, 20)
  const keywords = (options.keywords ?? []).map((value) => cleanText(value)).filter(Boolean).slice(0, 20)
  const categoryQuery = `(${categories.map((category) => `cat:${category}`).join(' OR ')})`
  const keywordQuery = keywords.length ? ` AND (${keywords.map((keyword) => `all:"${keyword.replaceAll('"', '')}"`).join(' OR ')})` : ''
  const query = encodeURIComponent(`${categoryQuery}${keywordQuery}`)
  const maxResults = Math.min(100, Math.max(1, options.maxResults ?? 50))
  const xml = await fetchText(`https://export.arxiv.org/api/query?search_query=${query}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`, signal, 35_000)
  const apiSource: ManagedPublicSource = { ...source, key: 'arxiv_api', name: 'arXiv API', url: 'https://export.arxiv.org/api/query' }
  const cutoff = Date.now() - Math.min(90, Math.max(1, options.days ?? 14)) * 86_400_000
  const watchAuthors = new Set((options.watchAuthors ?? []).map((value) => cleanText(value).toLocaleLowerCase()).filter(Boolean))
  const parsed = parseRssSource(apiSource, xml, maxResults).filter((item) => {
    const published = Date.parse(cleanText(item.published_at))
    return Number.isNaN(published) || published >= cutoff
  }).map((item) => {
    const authors = Array.isArray(item.authors) ? item.authors.map((value) => cleanText(value)) : []
    const watchHits = authors.filter((author) => watchAuthors.has(author.toLocaleLowerCase()))
    if (!watchHits.length) return item
    return {
      ...item,
      attention_score: Math.min(100, Number(item.attention_score || 0) + 10),
      worth_attention: true,
      watch_author_hits: watchHits,
      signals: [...(Array.isArray(item.signals) ? item.signals : []), ...watchHits.map((author) => ({ code: 'watch_author', score: 10, detail: author }))],
    }
  })
  const enriched: JsonObject[] = new Array(parsed.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < parsed.length) {
      const index = nextIndex++
      const item = parsed[index]
      try {
        const authors = Array.isArray(item.authors) ? item.authors.map((value) => cleanText(value)).filter(Boolean) : []
        const researchMetadata = await fetchArxivResearchMetadata({
          arxivId: arxivPaperId(cleanText(item.source_id || item.id || item.link || item.pdf_url)),
          authors,
          projectName: cleanText(item.project_name || item.title) || '论文',
        })
        enriched[index] = {
          ...item,
          paper_affiliations: researchMetadata.affiliations,
          paper_authors: researchMetadata.paperAuthors,
          paper_author_affiliations: researchMetadata.authorAffiliations,
          paper_research_team: researchMetadata.researchTeam,
          paper_author_contributions: researchMetadata.authorContributions,
          paper_rights: researchMetadata.rights,
          paper_metadata_source: researchMetadata.metadataSource,
        }
      } catch (cause) {
        enriched[index] = {
          ...item,
          paper_research_metadata_error: cause instanceof Error ? cause.message.slice(0, 500) : String(cause).slice(0, 500),
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, parsed.length) }, worker))
  return enriched
}

async function managedPublicSources(): Promise<ManagedPublicSource[]> {
  const rows = await db.select().from(radarSourceRegistry)
    .where(eq(radarSourceRegistry.sourceKind, 'public-source'))
  return rows.map((row) => {
    const config = row.config as JsonObject
    return {
      ...config,
      key: cleanText(row.externalKey || config.key),
      name: cleanText(row.displayName || config.name),
      url: cleanText(config.url),
      group: cleanText(row.sourceGroup || config.group),
      type: cleanText(config.type) as RadarPublicSourceType,
      frequency: cleanText(config.frequency),
      enabled: Boolean(row.enabled),
    } as ManagedPublicSource
  }).filter((source) => source.key && source.url && source.name && source.type)
}

async function collectorState(id: string): Promise<JsonObject> {
  const [row] = await db.select().from(radarCollectorStates).where(eq(radarCollectorStates.id, id)).limit(1)
  return row?.state ?? {}
}

async function runRadarPublicCollectionScope(
  stateId: 'auto' | 'paper_daily',
  includeSource: (source: ManagedPublicSource) => boolean,
  includeDetailedArxiv: boolean,
  signal: AbortSignal,
): Promise<JsonObject> {
  const startedAt = new Date().toISOString()
  const previous = await collectorState(stateId)
  const sources = (await managedPublicSources()).filter((source) => source.enabled && includeSource(source))
  await saveRadarCollectorState(stateId, { ...previous, enabled: true, running: true, last_started_at: startedAt, last_error: '' })
  try {
    const rows: JsonObject[] = []
    const sourceResults: JsonObject[] = []
    const errors: JsonObject[] = []
    for (let index = 0; index < sources.length; index += 4) {
      const batch = sources.slice(index, index + 4)
      const results = await Promise.all(batch.map(async (source) => {
        try {
          const items = await collectOnePublicSource(source, signal)
          return { source, items, error: '' }
        } catch (error) {
          if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : error
          return { source, items: [] as JsonObject[], error: error instanceof Error ? error.message : String(error) }
        }
      }))
      for (const result of results) {
        rows.push(...result.items)
        sourceResults.push({ key: result.source.key, name: result.source.name, fetched: result.items.length, error: result.error })
        if (result.error) errors.push({ source: result.source.name, key: result.source.key, error: result.error.slice(0, 500) })
      }
    }
    let arxiv: JsonObject = { fetched: 0, error: '', skipped: !includeDetailedArxiv }
    if (includeDetailedArxiv) {
      try {
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Radar collection aborted')
        const arxivRows = await collectDetailedArxiv(sources, signal)
        rows.push(...arxivRows)
        arxiv = { fetched: arxivRows.length, error: '' }
      } catch (error) {
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : error
        arxiv = { fetched: 0, error: error instanceof Error ? error.message : String(error) }
      }
    }
    const unique = [...new Map(rows.map((item) => [`${cleanText(item.source)}:${cleanText(item.source_id || item.link || item.title)}`, item])).values()]
    const retained = unique.filter((item) => item.worth_attention !== false)
    const imported = await ingestRadarCandidates(retained)
    const result = {
      fetched: unique.length,
      retained: retained.length,
      filtered: unique.length - retained.length,
      written: imported,
      source_results: sourceResults,
      error_samples: errors.slice(0, 50),
      arxiv,
    }
    const finishedAt = new Date().toISOString()
    const allFailed = errors.length === sources.length
      && sources.length > 0
      && Number(arxiv.fetched || 0) === 0
    await saveRadarCollectorState(stateId, {
      ...previous,
      enabled: true,
      running: false,
      groups: [...new Set(sources.map((source) => source.group))],
      last_started_at: startedAt,
      last_finished_at: finishedAt,
      last_result: result,
      last_error: allFailed ? '所有外部来源均采集失败' : '',
      consecutive_error_runs: allFailed ? Number(previous.consecutive_error_runs || 0) + 1 : 0,
      run_count: Number(previous.run_count || 0) + 1,
    })
    if (allFailed) {
      throw Object.assign(new Error('所有外部来源均采集失败'), { radarStatePersisted: true })
    }
    return { ...result, started_at: startedAt, finished_at: finishedAt }
  } catch (error) {
    if ((error as { radarStatePersisted?: boolean }).radarStatePersisted) throw error
    const message = error instanceof Error ? error.message : String(error)
    await saveRadarCollectorState(stateId, {
      ...previous,
      enabled: true,
      running: false,
      last_started_at: startedAt,
      last_finished_at: new Date().toISOString(),
      last_error: message,
      consecutive_error_runs: Number(previous.consecutive_error_runs || 0) + 1,
      run_count: Number(previous.run_count || 0) + 1,
    })
    throw error
  }
}

export async function runRadarPublicCollection(signal: AbortSignal): Promise<JsonObject> {
  return await runRadarPublicCollectionScope('auto', (source) => source.group !== '论文', false, signal)
}

export async function runRadarPaperCollection(signal: AbortSignal): Promise<JsonObject> {
  return await runRadarPublicCollectionScope('paper_daily', (source) => source.group === '论文', true, signal)
}

export async function runRadarArxivCollection(options: {
  categories?: string[]
  keywords?: string[]
  maxResults?: number
  days?: number
  watchAuthors?: string[]
}, signal: AbortSignal): Promise<JsonObject> {
  const sources = (await managedPublicSources()).filter((source) => source.enabled && source.group === '论文')
  const rows = await collectDetailedArxiv(sources, signal, options)
  const written = await ingestRadarCandidates(rows)
  return {
    fetched: rows.length, retained: rows.length, filtered: 0, written,
    worth_attention: rows.filter((row) => row.worth_attention !== false).length,
    items: rows,
  }
}

export async function runRadarOpenAlexCollection(options: {
  query?: string
  maxResults?: number
  days?: number
}, signal: AbortSignal): Promise<JsonObject> {
  const source = (await managedPublicSources()).find((item) => item.enabled && item.type === 'openalex_api')
  if (!source) throw new Error('OpenAlex 采集源未启用')
  const rows = await collectOpenAlex(source, signal, Math.min(100, Math.max(1, options.maxResults ?? 50)), options)
  const written = await ingestRadarCandidates(rows)
  return {
    fetched: rows.length, retained: rows.length, filtered: 0, written,
    worth_attention: rows.filter((row) => row.worth_attention !== false).length,
    items: rows,
  }
}

export async function runRadarInvestmentCollection(options: {
  groups?: string[]
  maxEntriesPerSource?: number
  keyword?: string
}, signal: AbortSignal): Promise<JsonObject> {
  const groupSet = new Set((options.groups ?? []).map((value) => cleanText(value)).filter(Boolean))
  const sources = (await managedPublicSources()).filter((source) => (
    source.enabled && source.group !== '论文' && (groupSet.size === 0 || groupSet.has(source.group))
  ))
  const rows: JsonObject[] = []
  const sourceResults: JsonObject[] = []
  const errors: JsonObject[] = []
  for (let index = 0; index < sources.length; index += 4) {
    const results = await Promise.all(sources.slice(index, index + 4).map(async (source) => {
      try {
        return { source, items: await collectOnePublicSource(source, signal, options.maxEntriesPerSource), error: '' }
      } catch (error) {
        return { source, items: [] as JsonObject[], error: error instanceof Error ? error.message : String(error) }
      }
    }))
    for (const result of results) {
      rows.push(...result.items)
      sourceResults.push({ key: result.source.key, name: result.source.name, fetched: result.items.length, error: result.error })
      if (result.error) errors.push({ source: result.source.name, key: result.source.key, error: result.error.slice(0, 500) })
    }
  }
  const unique = [...new Map(rows.map((item) => [`${cleanText(item.source)}:${cleanText(item.source_id || item.link || item.title)}`, item])).values()]
  const retained = unique.filter((item) => item.worth_attention !== false)
  const written = await ingestRadarCandidates(retained)
  return {
    fetched: unique.length, retained: retained.length, filtered: unique.length - retained.length,
    written, worth_attention: retained.length, keyword: cleanText(options.keyword),
    source_results: sourceResults, error_samples: errors.slice(0, 50), items: retained,
  }
}

// 兼容旧 `/api/wechat/run`：读取已迁入 MySQL 的 985 高校 RSS 配置，
// 不再依赖 wechat_985_sources.json 文件。
export async function runRadarUniversityWechatRss(
  signal: AbortSignal,
  maxEntriesPerFeed = 20,
): Promise<JsonObject> {
  const configured = await db.select().from(radarSourceRegistry)
    .where(and(eq(radarSourceRegistry.sourceKind, 'university-source'), eq(radarSourceRegistry.enabled, true)))
  const rows: JsonObject[] = []
  const errors: JsonObject[] = []
  let feeds = 0
  for (const source of configured) {
    const config = source.config as JsonObject
    const school = cleanText(config.school || source.displayName)
    const province = cleanText(config.province)
    const accounts = Array.isArray(config.accounts) ? config.accounts : []
    for (const rawAccount of accounts) {
      if (!rawAccount || typeof rawAccount !== 'object' || Array.isArray(rawAccount)) continue
      const account = rawAccount as JsonObject
      const accountName = cleanText(account.name) || school
      const rssUrl = cleanText(account.rss_url)
      if (!rssUrl) continue
      feeds += 1
      try {
        const xml = await fetchText(rssUrl, signal)
        for (const entry of parseFeedEntries(xml).slice(0, Math.min(100, Math.max(1, maxEntriesPerFeed)))) {
          const sourceId = entry.link || md5(`${school}:${accountName}:${entry.title}`).slice(0, 16)
          const score = candidateScore('高校成果', entry.title, entry.summary)
          rows.push({
            source: 'wechat_985', source_id: sourceId, fingerprint: md5(sourceId).slice(0, 16),
            title: entry.title, summary: entry.summary, school, province, account_name: accountName,
            authors: entry.authors, categories: ['985公众号', school], published_at: entry.publishedAt,
            updated_at: entry.updatedAt, link: entry.link, attention_score: score.score,
            worth_attention: score.worthAttention, signals: score.signals, decision: score.decision,
            decision_label: score.decision_label, filter_reasons: score.filter_reasons,
            collected_at: new Date().toISOString(),
          })
        }
      } catch (error) {
        errors.push({ school, account: accountName, rss_url: rssUrl, error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) })
      }
    }
  }
  const retained = rows.filter((row) => row.worth_attention !== false)
  const written = await ingestRadarCandidates(retained)
  return { feeds, fetched: rows.length, retained: retained.length, filtered: rows.length - retained.length, written, errors, items: retained.slice(0, 100) }
}

async function loadGsdataCredentials(): Promise<{ appKey: string; appSecret: string }> {
  const appKey = cleanText(process.env.GSDATA_APP_KEY)
  const appSecret = cleanText(process.env.GSDATA_APP_SECRET)
  if (!appKey || !appSecret) throw new Error('缺少 GSData app_key/app_secret')
  return { appKey, appSecret }
}

async function managedWechatAccounts(groups?: string[], wxNames?: string[]): Promise<WechatAccount[]> {
  const rows = await db.select().from(radarSourceRegistry)
    .where(and(eq(radarSourceRegistry.sourceKind, 'wechat-account'), eq(radarSourceRegistry.enabled, true)))
  const groupSet = new Set(groups?.filter(Boolean) ?? [])
  const wxSet = new Set((wxNames ?? []).map((value) => value.toLowerCase()))
  return rows.map((row) => ({
    group: cleanText(row.sourceGroup),
    accountName: cleanText(row.displayName),
    wxName: cleanText(row.externalKey),
  })).filter((account) => account.accountName && account.wxName)
    .filter((account) => groupSet.size === 0 || groupSet.has(account.group))
    .filter((account) => wxSet.size === 0 || wxSet.has(account.wxName.toLowerCase()))
    .sort((a, b) => (a.group === '机构' ? -1 : 1) - (b.group === '机构' ? -1 : 1) || a.accountName.localeCompare(b.accountName))
}

function gsdataToken(params: Record<string, string>, router: string, appKey: string, appSecret: string): string {
  const joined = Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('')
  const sign = md5(`${appSecret}_${joined}_${appSecret}`)
  return Buffer.from(`${appKey}:${sign}:${router}`).toString('base64')
}

async function gsdataGet(router: string, params: Record<string, string>, signal: AbortSignal): Promise<JsonObject> {
  const { appKey, appSecret } = await loadGsdataCredentials()
  const url = new URL(GSDATA_API_URL)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const text = await fetchText(url.toString(), signal, 25_000, {
        headers: { 'access-token': gsdataToken(params, router, appKey, appSecret) },
      })
      return JSON.parse(text) as JsonObject
    } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_000 * (2 ** attempt)))
    }
  }
  throw lastError
}

async function fetchWechatArticleContent(article: JsonObject, signal: AbortSignal): Promise<{ text: string; status: string }> {
  const localUrl = cleanText(article.news_local_url)
  if (localUrl) {
    try {
      const payload = await gsdataGet(GSDATA_WECHAT_CONTENT_ROUTER, { news_local_url: localUrl }, signal)
      const data = payload.data && typeof payload.data === 'object' ? payload.data as JsonObject : {}
      const text = htmlToText(data.news_content || data.content || data.html)
      if (text) return { text, status: 'gsdata_content_ok' }
    } catch { /* fall through to the public article URL */ }
  }
  const link = cleanText(article.news_url)
  if (link.includes('mp.weixin.qq.com')) {
    try {
      const html = await fetchText(link, signal, 15_000)
      const content = html.match(/<(?:div|section)\b[^>]*(?:id=["']js_content["']|class=["'][^"']*rich_media_content[^"']*["'])[^>]*>([\s\S]*?)<\/(?:div|section)>/i)?.[1] ?? ''
      const text = htmlToText(content)
      if (text) return { text, status: 'mp_article_ok' }
    } catch { /* record an empty body below */ }
  }
  return { text: '', status: 'content_unavailable' }
}

async function fetchWechatAccount(account: WechatAccount, date: string, days: number, limit: number, signal: AbortSignal): Promise<{ rows: JsonObject[]; error: string }> {
  const start = `${date} 00:00:00`
  const endDate = new Date(`${date}T00:00:00+08:00`)
  endDate.setUTCDate(endDate.getUTCDate() + days)
  const end = `${shanghaiDateFrom(endDate)} 00:00:00`
  const rows: JsonObject[] = []
  const pageSize = Math.min(50, Math.max(1, limit))
  const maxPages = Math.min(10, Math.max(1, Math.ceil(limit / pageSize)))
  try {
    for (let page = 1; page <= maxPages && rows.length < limit; page += 1) {
      const payload = await gsdataGet(GSDATA_WECHAT_ROUTER, {
        wx_name: account.wxName,
        posttime_start: start,
        posttime_end: end,
        order: 'desc', sort: 'posttime', page: String(page), limit: String(pageSize),
      }, signal)
      if (!payload.success) throw new Error(cleanText(payload.msg || payload.message || JSON.stringify(payload)).slice(0, 500))
      const data = payload.data && typeof payload.data === 'object' ? payload.data as JsonObject : {}
      const articles = Array.isArray(data.newsList) ? data.newsList : []
      for (const raw of articles) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const article = raw as JsonObject
        const title = cleanText(article.news_title)
        if (!title) continue
        const digest = htmlToText(article.news_digest, 2_000)
        const preliminary = candidateScore(`${account.group}公众号`, title, digest)
        if (!preliminary.worthAttention) continue
        const content = await fetchWechatArticleContent(article, signal)
        const summary = digest || content.text.slice(0, 300)
        const score = candidateScore(`${account.group}公众号`, title, `${digest}\n${content.text}`)
        const link = cleanText(article.news_url)
        const sourceId = cleanText(article.news_uuid) || link || `${account.wxName}:${title}`
        rows.push({
          source: 'wechat_api', source_id: sourceId, fingerprint: md5(sourceId).slice(0, 16),
          title, summary, article_text: content.text, article_text_length: content.text.length,
          article_fetch_status: content.status, source_name: account.accountName,
          source_group: `${account.group}公众号`, source_key: account.wxName, source_type: 'gsdata_wechat',
          account_name: account.accountName, wx_name: account.wxName, wx_nickname: cleanText(article.wx_nickname),
          news_author: cleanText(article.news_author), news_local_url: cleanText(article.news_local_url),
          source_url: cleanText(article.source_url), categories: [`${account.group}公众号`, account.accountName],
          published_at: cleanText(article.news_posttime), updated_at: cleanText(article.news_entertime), link,
          cover_url: cleanText(article.cover_url), read_count: article.news_read_count ?? '',
          like_count: article.news_like_count ?? '', share_num: article.share_num ?? '',
          attention_score: score.score, worth_attention: score.worthAttention, signals: score.signals,
          decision: score.decision, decision_label: score.decision_label, filter_reasons: score.filter_reasons,
          collected_at: new Date().toISOString(),
        })
        if (rows.length >= limit) break
      }
      if (articles.length < pageSize) break
    }
    return { rows, error: '' }
  } catch (error) {
    return { rows, error: error instanceof Error ? error.message : String(error) }
  }
}

async function runWechatCollection(options: { groups?: string[]; wxNames?: string[]; days?: number; limit?: number; date?: string; maxAccounts?: number }, signal: AbortSignal): Promise<JsonObject> {
  const days = Math.min(30, Math.max(1, options.days ?? 7))
  const date = cleanText(options.date) || shanghaiDate(-days)
  const allAccounts = await managedWechatAccounts(options.groups, options.wxNames)
  const accounts = options.maxAccounts && options.maxAccounts > 0 ? allAccounts.slice(0, Math.min(5_000, options.maxAccounts)) : allAccounts
  const rows: JsonObject[] = []
  const accountResults: JsonObject[] = []
  const errors: JsonObject[] = []
  for (let index = 0; index < accounts.length; index += 4) {
    const results = await Promise.all(accounts.slice(index, index + 4).map(async (account) => ({
      account,
      result: await fetchWechatAccount(account, date, days, options.limit ?? 100, signal),
    })))
    for (const { account, result } of results) {
      rows.push(...result.rows)
      accountResults.push({ group: account.group, account_name: account.accountName, wx_name: account.wxName, fetched: result.rows.length, error: result.error })
      if (result.error) errors.push({ group: account.group, account_name: account.accountName, wx_name: account.wxName, error: result.error.slice(0, 500) })
    }
  }
  const imported = await ingestRadarCandidates(rows)
  const sourceState = Object.fromEntries(accountResults.map((item) => [cleanText(item.wx_name), item]))
  await saveRadarCollectorState('wechat_sources', { updated_at: new Date().toISOString(), sources: sourceState })
  return {
    date, days, accounts: accounts.length, fetched: rows.length, retained: rows.length,
    filtered: 0, written: imported, worth_attention: rows.length, errors,
    account_results: accountResults,
    failed_accounts: errors.map((error) => ({ group: error.group, account_name: error.account_name, wx_name: error.wx_name })),
    items: rows.slice(0, 100),
  }
}

export async function runRadarWechatCollection(options: {
  groups?: string[]
  wxNames?: string[]
  days?: number
  limit?: number
  date?: string
  maxAccounts?: number
}, signal: AbortSignal): Promise<JsonObject> {
  return await runWechatCollection(options, signal)
}

export async function runRadarWechatDaily(signal: AbortSignal): Promise<JsonObject> {
  const previous = await collectorState('wechat_daily')
  const startedAt = new Date().toISOString()
  await saveRadarCollectorState('wechat_daily', { ...previous, running: true, last_started_at: startedAt, last_error: '' })
  try {
    const result = await runWechatCollection({ groups: ['高校', '机构'] }, signal)
    await saveRadarCollectorState('wechat_daily', {
      ...previous, running: false, last_started_at: startedAt, last_finished_at: new Date().toISOString(),
      last_result: result, pending_retry_accounts: result.failed_accounts ?? [], last_error: '',
    })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await saveRadarCollectorState('wechat_daily', { ...previous, running: false, last_started_at: startedAt, last_finished_at: new Date().toISOString(), last_error: message })
    throw error
  }
}

export async function runRadarWechatRetry(signal: AbortSignal): Promise<JsonObject> {
  const previous = await collectorState('wechat_daily')
  const pending = Array.isArray(previous.pending_retry_accounts) ? previous.pending_retry_accounts : []
  const wxNames = pending.flatMap((item) => item && typeof item === 'object' && !Array.isArray(item) ? [cleanText((item as JsonObject).wx_name)] : []).filter(Boolean)
  if (wxNames.length === 0) return { skipped: true, reason: 'no_pending_accounts', accounts: 0 }
  const result = await runWechatCollection({ wxNames: wxNames.slice(0, 100) }, signal)
  await saveRadarCollectorState('wechat_daily', { ...previous, last_retry_result: result, pending_retry_accounts: result.failed_accounts ?? [], last_error: '' })
  return result
}

export async function runRadarWechatInstitution(signal: AbortSignal): Promise<JsonObject> {
  const previous = await collectorState('wechat_daily')
  const result = await runWechatCollection({ groups: ['机构'] }, signal)
  await saveRadarCollectorState('wechat_daily', { ...previous, last_institution_result: result, pending_retry_accounts: result.failed_accounts ?? [], last_error: '' })
  return result
}

export async function radarCollectorHealth() {
  try {
    const [sources, candidates, [state]] = await Promise.all([
      db.select().from(radarSourceRegistry).where(eq(radarSourceRegistry.sourceKind, 'public-source')),
      db.select({ sourceKeyHash: radarCandidates.sourceKeyHash }).from(radarCandidates),
      db.select().from(radarCollectorStates).where(eq(radarCollectorStates.id, 'auto')).limit(1),
    ])
    return {
      name: 'radar-typescript-collector', ok: sources.length > 0, inProcess: true,
      mode: 'node-in-process', publicSources: sources.length,
      enabledSources: sources.filter((source) => source.enabled).length,
      candidateTotal: candidates.length, lastFinishedAt: state?.state?.last_finished_at ?? null,
    }
  } catch (error) {
    return { name: 'radar-typescript-collector', ok: false, inProcess: true, mode: 'node-in-process', error: error instanceof Error ? error.message : String(error) }
  }
}
