import { createHash } from 'node:crypto'
import type { EvidenceSource } from './aiBusinessContentService.js'

type ComplianceWebResearchProject = {
  name: string
  companyName?: string | null
  industry?: string | null
  summary?: string | null
}

type SearchTopic =
  | '公司工商与主体'
  | '官网、产品及技术'
  | '核心团队'
  | '融资与投资'
  | '处罚、诉讼与失信'
  | '行业政策与监管'
  | '投资方式及投资限制'

type SearchPlan = {
  topic: SearchTopic
  query: string
}

type SearxngHit = {
  title?: string
  content?: string
  url?: string
  publishedDate?: string
  published_date?: string
  date?: string
}

type FetchLike = typeof fetch

export type ComplianceWebResearchAudit = {
  enabled: boolean
  status: 'disabled' | 'succeeded' | 'partial' | 'no_results' | 'unavailable'
  provider: 'searxng'
  baseUrl: string
  accessedAt: string
  queryCount: number
  succeededQueryCount: number
  failedQueryCount: number
  resultCount: number
  sourceCount: number
  officialFallbackAttempted: boolean
  officialFallbackSourceCount: number
  queries: Array<{ topic: SearchTopic; query: string }>
}

export type ComplianceWebResearchResult = {
  sources: EvidenceSource[]
  audit: ComplianceWebResearchAudit
}

const DEFAULT_SEARXNG_BASE_URL = 'http://127.0.0.1:8888'
const OFFICIAL_DOMAINS = [
  'gov.cn',
  'csrc.gov.cn',
  'amac.org.cn',
  'court.gov.cn',
  'cnipa.gov.cn',
  'gsxt.gov.cn',
]
const OFFICIAL_REGULATORY_FALLBACKS = [
  {
    title: '私募投资基金监督管理暂行办法',
    url: 'https://www.csrc.gov.cn/csrc/c106256/c1653981/content.shtml',
  },
  {
    title: '私募投资基金监督管理条例（国令第762号）',
    url: 'https://www.csrc.gov.cn/qinghai/c105502/c7422302/content.shtml',
  },
]

function meaningful(value: unknown) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text || /^(?:待核验|待补充|暂无|未提供|unknown|n\/?a)$/i.test(text)) return ''
  return text
}

function quoteQueryTerm(value: string) {
  return `"${value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`
}

export function buildComplianceWebSearchQueries(
  project: ComplianceWebResearchProject,
): SearchPlan[] {
  const subject = meaningful(project.companyName) || meaningful(project.name)
  const industry = meaningful(project.industry)
  const subjectQuery = quoteQueryTerm(subject)
  return [
    { topic: '公司工商与主体', query: `${subjectQuery} 工商 成立 法定代表人 注册地址` },
    { topic: '官网、产品及技术', query: `${subjectQuery} 官网 产品 技术 专利` },
    { topic: '核心团队', query: `${subjectQuery} 创始人 核心团队 任职 履历` },
    { topic: '融资与投资', query: `${subjectQuery} 融资 估值 投资方` },
    { topic: '处罚、诉讼与失信', query: `${subjectQuery} 行政处罚 诉讼 失信` },
    {
      topic: '行业政策与监管',
      query: `${industry ? quoteQueryTerm(industry) : subjectQuery} 政策 监管 site:gov.cn`,
    },
    {
      topic: '投资方式及投资限制',
      query: '私募投资基金 投资方式 投资限制 监管 site:csrc.gov.cn',
    },
  ]
}

function normalizedBaseUrl(value: string | undefined) {
  const raw = meaningful(value) || DEFAULT_SEARXNG_BASE_URL
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) return DEFAULT_SEARXNG_BASE_URL
    return url.toString().replace(/\/$/, '')
  } catch {
    return DEFAULT_SEARXNG_BASE_URL
  }
}

function resultUrl(value: unknown) {
  try {
    const url = new URL(String(value ?? '').trim())
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

function officialSource(urlValue: string) {
  const hostname = new URL(urlValue).hostname.toLowerCase()
  return OFFICIAL_DOMAINS.some((domain) =>
    hostname === domain || hostname.endsWith(`.${domain}`))
}

function detectedPublishedDate(hit: SearxngHit) {
  const direct = meaningful(hit.publishedDate ?? hit.published_date ?? hit.date)
  const candidates = [
    direct,
    meaningful(hit.title),
    meaningful(hit.content),
  ].filter(Boolean)
  for (const candidate of candidates) {
    const chinese = candidate.match(/\b(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})日?\b/)
    if (chinese) {
      const value = `${chinese[1]}-${chinese[2].padStart(2, '0')}-${chinese[3].padStart(2, '0')}`
      if (!Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return value
    }
    const parsed = Date.parse(candidate)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10)
  }
  return ''
}

function pageText(html: string) {
  const text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&[a-z][a-z0-9]+;|&#\d+;|&#x[a-f0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const articleAnchor = text.search(/第一条\s*(?:为了|为)\s*(?:规范|促进|保护)/)
  const anchor = articleAnchor >= 0
    ? articleAnchor
    : text.search(/私募投资基金|私募基金/)
  const start = anchor >= 0 ? Math.max(0, anchor - 160) : 0
  return text.slice(start, start + 3200)
}

function sourceId(urlValue: string) {
  return createHash('sha256').update(urlValue).digest('hex')
}

function hitMatchesProject(input: {
  plan: SearchPlan
  project: ComplianceWebResearchProject
  title: string
  excerpt: string
}) {
  if (input.plan.topic === '投资方式及投资限制') return true
  const content = `${input.title} ${input.excerpt}`.replace(/\s+/g, '')
  if (input.plan.topic === '行业政策与监管') {
    const industry = meaningful(input.project.industry).replace(/\s+/g, '')
    return !industry || content.includes(industry)
  }
  const company = meaningful(input.project.companyName)
  const projectName = meaningful(input.project.name).replace(/项目$/, '')
  const companyCore = company.replace(/(?:有限责任公司|股份有限公司|有限公司)$/, '')
  return [company, companyCore, projectName]
    .map((value) => value.replace(/\s+/g, ''))
    .filter((value) => value.length >= 2)
    .some((value) => content.includes(value))
}

function isResearchEnabled(parameters?: Record<string, unknown>) {
  if (parameters?.webResearch === false) return false
  return process.env.AI_COMPLIANCE_WEB_RESEARCH_ENABLED?.toLowerCase() !== 'false'
}

async function searchSearxng(input: {
  plan: SearchPlan
  baseUrl: string
  engines: string
  fetchImpl: FetchLike
}) {
  const url = new URL('/search', `${input.baseUrl}/`)
  url.searchParams.set('q', input.plan.query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('language', 'zh-CN')
  url.searchParams.set('safesearch', '1')
  if (input.engines) url.searchParams.set('engines', input.engines)
  const response = await input.fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`SearXNG ${response.status}`)
  const body = await response.json() as { results?: SearxngHit[] }
  return Array.isArray(body.results) ? body.results.slice(0, 8) : []
}

export async function fetchComplianceWebEvidence(input: {
  project: ComplianceWebResearchProject
  sourceCutoffDate: string
  parameters?: Record<string, unknown>
  fetchImpl?: FetchLike
  baseUrl?: string
  now?: Date
  maxSources?: number
}): Promise<ComplianceWebResearchResult> {
  const enabled = isResearchEnabled(input.parameters)
  const baseUrl = normalizedBaseUrl(
    input.baseUrl
      ?? process.env.AI_COMPLIANCE_SEARXNG_BASE_URL
      ?? process.env.SEARXNG_BASE_URL
      ?? process.env.SEARXNG_BASE,
  )
  const now = input.now ?? new Date()
  const accessedAt = now.toISOString()
  const plans = buildComplianceWebSearchQueries(input.project)
  const auditBase = {
    enabled,
    provider: 'searxng' as const,
    baseUrl,
    accessedAt,
    queryCount: plans.length,
    queries: plans.map(({ topic, query }) => ({ topic, query })),
  }
  if (!enabled) {
    return {
      sources: [],
      audit: {
        ...auditBase,
        status: 'disabled',
        succeededQueryCount: 0,
        failedQueryCount: 0,
        resultCount: 0,
        sourceCount: 0,
        officialFallbackAttempted: false,
        officialFallbackSourceCount: 0,
      },
    }
  }

  const fetchImpl = input.fetchImpl ?? fetch
  const engines = process.env.AI_COMPLIANCE_WEB_SEARCH_ENGINES
    ?? process.env.SEARXNG_ENGINES
    ?? 'baidu,360search,sogou,quark'
  const settled = await Promise.allSettled(plans.map(async (plan) => ({
    plan,
    hits: await searchSearxng({ plan, baseUrl, engines, fetchImpl }),
  })))
  const succeeded = settled.filter(
    (result): result is PromiseFulfilledResult<{ plan: SearchPlan; hits: SearxngHit[] }> =>
      result.status === 'fulfilled',
  )
  const failedQueryCount = settled.length - succeeded.length
  const rawResultCount = succeeded.reduce((sum, result) => sum + result.value.hits.length, 0)
  const seenUrls = new Set<string>()
  const sources: EvidenceSource[] = []
  for (const { plan, hits } of succeeded.map((result) => result.value)) {
    let acceptedForTopic = 0
    for (const hit of hits) {
      const url = resultUrl(hit.url)
      const title = meaningful(hit.title)
      const excerpt = meaningful(hit.content)
      if (!url || seenUrls.has(url) || (!title && !excerpt)) continue
      if (!hitMatchesProject({ plan, project: input.project, title, excerpt })) continue
      const publishedDate = detectedPublishedDate(hit)
      if (publishedDate && publishedDate > input.sourceCutoffDate) continue
      seenUrls.add(url)
      const official = officialSource(url)
      const sourceLabel = official ? '官方公开信息' : '公开网络线索'
      const content = [
        `${sourceLabel}，仅用于本项目初步核验，不替代原始文件或专项尽调。`,
        title ? `页面标题：${title}` : '',
        excerpt ? `公开摘要：${excerpt}` : '',
        `适用核验主题：${plan.topic}。`,
        publishedDate
          ? `发布日期：${publishedDate}。`
          : '发布日期待核验，不得据此认定资料截止日前已经公开。',
        `访问日期：${accessedAt.slice(0, 10)}。`,
      ].filter(Boolean).join('\n').slice(0, 3200)
      sources.push({
        sourceType: official ? 'public_web_official' : 'public_web',
        sourceId: sourceId(url),
        sourceName: `${sourceLabel}·${plan.topic}·${title || new URL(url).hostname}`.slice(0, 255),
        chunkIndex: sources.length,
        versionOrDate: publishedDate || `发布日期待核验；访问${accessedAt.slice(0, 10)}`,
        locator: url,
        content,
      })
      acceptedForTopic += 1
      if (acceptedForTopic >= 3) break
      if (sources.length >= (input.maxSources ?? 24)) break
    }
    if (sources.length >= (input.maxSources ?? 24)) break
  }
  const hasRegulatoryEvidence = sources.some((source) =>
    source.sourceName.includes('投资方式及投资限制'))
  let officialFallbackSourceCount = 0
  if (!hasRegulatoryEvidence && sources.length < (input.maxSources ?? 24)) {
    const fallbackResults = await Promise.allSettled(
      OFFICIAL_REGULATORY_FALLBACKS.map(async ({ title, url }) => {
        const response = await fetchImpl(url, {
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'Cybernaut-Compliance-Research/1.0',
          },
          signal: AbortSignal.timeout(15_000),
        })
        if (!response.ok) throw new Error(`Official source ${response.status}`)
        const text = pageText(await response.text())
        if ((text.match(/[\u3400-\u9FFF]/g) || []).length < 80) {
          throw new Error('Official source has no readable Chinese content')
        }
        const publishedDate = detectedPublishedDate({ title, content: text })
        if (publishedDate && publishedDate > input.sourceCutoffDate) return undefined
        return {
          sourceType: 'public_web_official',
          sourceId: sourceId(url),
          sourceName: `官方公开信息·投资方式及投资限制·${title}`,
          chunkIndex: sources.length,
          versionOrDate: publishedDate || `发布日期待核验；访问${accessedAt.slice(0, 10)}`,
          locator: url,
          content: [
            '官方监管公开信息，仅用于建立通用核查基准，不替代本基金协议或本次交易文件。',
            `页面标题：${title}`,
            `公开正文摘录：${text}`,
            publishedDate
              ? `发布日期：${publishedDate}。`
              : '发布日期待核验，不得据此认定资料截止日前已经公开。',
            `访问日期：${accessedAt.slice(0, 10)}。`,
          ].join('\n').slice(0, 4000),
        } satisfies EvidenceSource
      }),
    )
    for (const result of fallbackResults) {
      if (result.status !== 'fulfilled' || !result.value) continue
      if (sources.some((source) => source.sourceId === result.value!.sourceId)) continue
      sources.push(result.value)
      officialFallbackSourceCount += 1
      if (sources.length >= (input.maxSources ?? 24)) break
    }
  }

  const status: ComplianceWebResearchAudit['status'] = sources.length
    ? failedQueryCount
      ? 'partial'
      : 'succeeded'
    : succeeded.length
      ? 'no_results'
      : 'unavailable'
  return {
    sources,
    audit: {
      ...auditBase,
      status,
      succeededQueryCount: succeeded.length,
      failedQueryCount,
      resultCount: rawResultCount,
      sourceCount: sources.length,
      officialFallbackAttempted: !hasRegulatoryEvidence,
      officialFallbackSourceCount,
    },
  }
}
