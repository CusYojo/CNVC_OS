import { createHash } from 'node:crypto'
import type { EvidenceSource } from './aiBusinessContentService.js'
import type { ProjectQaDocumentCategory } from './aiQaPipelineService.js'

type QaResearchProject = {
  name: string
  companyName?: string | null
  industry?: string | null
}

type SearchPlan = {
  category: ProjectQaDocumentCategory
  topic: string
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

export type QaWebResearchResult = {
  sources: EvidenceSource[]
  attemptedQueries: number
  successfulQueries: number
  failedQueries: number
  resultCount: number
  accessedAt: string
  provider: 'searxng'
}

const DEFAULT_SEARXNG_BASE_URL = 'http://127.0.0.1:8888'

function cleanText(value: unknown, maxLength = 1200) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function quoteQueryTerm(value: string) {
  return `"${value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`
}

function normalizedBaseUrl(value: string | undefined) {
  try {
    const parsed = new URL(cleanText(value, 1000) || DEFAULT_SEARXNG_BASE_URL)
    if (!['http:', 'https:'].includes(parsed.protocol)) return DEFAULT_SEARXNG_BASE_URL
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return DEFAULT_SEARXNG_BASE_URL
  }
}

function validPublicUrl(value: unknown) {
  try {
    const parsed = new URL(cleanText(value, 1200))
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return ''
  }
}

function publishedDateOf(hit: SearxngHit) {
  const values = [
    cleanText(hit.publishedDate ?? hit.published_date ?? hit.date, 80),
    cleanText(hit.title, 260),
    cleanText(hit.content, 800),
  ].filter(Boolean)
  for (const value of values) {
    const chinese = value.match(/\b(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})日?\b/)
    if (chinese) {
      const normalized = `${chinese[1]}-${chinese[2].padStart(2, '0')}-${chinese[3].padStart(2, '0')}`
      if (!Number.isNaN(Date.parse(`${normalized}T00:00:00Z`))) return normalized
    }
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10)
  }
  return ''
}

function hashId(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

export function buildQaWebSearchQueries(project: QaResearchProject): SearchPlan[] {
  const company = cleanText(project.companyName, 180) || cleanText(project.name, 180)
  const industry = cleanText(project.industry, 140)
  const subject = quoteQueryTerm(company)
  const sector = industry ? quoteQueryTerm(industry) : subject
  return [
    {
      category: '企业介绍',
      topic: '公司主体与发展',
      query: `${subject} 公司简介 成立 注册资本 法定代表人 主营业务 官网`,
    },
    {
      category: '产品能力',
      topic: '产品、技术与知识产权',
      query: `${subject} 产品 技术 研发 专利 软件著作权 认证`,
    },
    {
      category: '团队',
      topic: '创始人与核心团队',
      query: `${subject} 创始人 核心团队 高管 履历`,
    },
    {
      category: '市场',
      topic: '行业需求与市场规模',
      query: `${sector} 市场规模 增长率 需求 政策 产业链`,
    },
    {
      category: '竞争',
      topic: '竞争格局与差异化',
      query: `${sector} 竞争格局 主要企业 替代方案 技术路线`,
    },
    {
      category: '客户',
      topic: '客户、合作与商业化',
      query: `${subject} 客户 合作 中标 合同 交付 商业化`,
    },
    {
      category: '商业模式',
      topic: '业务模式与运营',
      query: `${subject} 商业模式 收入模式 解决方案 服务 收费`,
    },
    {
      category: '融资',
      topic: '股权、融资与投资方',
      query: `${subject} 股东 股权 融资 估值 投资方 融资历程`,
    },
    {
      category: '合规',
      topic: '资质、处罚与诉讼',
      query: `${subject} 资质 许可 行政处罚 诉讼 被执行人 合规`,
    },
    {
      category: '未来规划',
      topic: '近期动态与发展路径',
      query: `${subject} 最新动态 战略合作 扩产 规划 发布`,
    },
  ]
}

async function searchSearxng(input: {
  plan: SearchPlan
  baseUrl: string
  engines: string
  fetchImpl: typeof fetch
}) {
  const url = new URL('/search', `${input.baseUrl}/`)
  url.searchParams.set('q', input.plan.query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('language', 'zh-CN')
  url.searchParams.set('safesearch', '1')
  if (input.engines) url.searchParams.set('engines', input.engines)
  const response = await input.fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`SearXNG ${response.status}`)
  const body = await response.json() as { results?: SearxngHit[] }
  return Array.isArray(body.results) ? body.results.slice(0, 6) : []
}

export async function collectQaPublicEvidence(
  input: {
    project: QaResearchProject
    sourceCutoffDate: string
    maxSources?: number
    baseUrl?: string
    now?: Date
  },
  fetchImpl: typeof fetch = fetch,
): Promise<QaWebResearchResult> {
  const plans = buildQaWebSearchQueries(input.project)
  const baseUrl = normalizedBaseUrl(
    input.baseUrl
      ?? process.env.AI_QA_SEARXNG_BASE_URL
      ?? process.env.SEARXNG_BASE_URL
      ?? process.env.SEARXNG_BASE,
  )
  const engines = process.env.AI_QA_WEB_SEARCH_ENGINES
    ?? process.env.SEARXNG_ENGINES
    ?? ''
  const accessedAt = (input.now ?? new Date()).toISOString()
  const settled = await Promise.allSettled(plans.map(async (plan) => ({
    plan,
    hits: await searchSearxng({ plan, baseUrl, engines, fetchImpl }),
  })))
  const succeeded = settled.filter(
    (result): result is PromiseFulfilledResult<{ plan: SearchPlan; hits: SearxngHit[] }> =>
      result.status === 'fulfilled',
  )
  const seen = new Set<string>()
  const sources: EvidenceSource[] = []
  let resultCount = 0
  for (const { plan, hits } of succeeded.map((result) => result.value)) {
    const usableHits: Array<{
      title: string
      excerpt: string
      url: string
      publishedDate: string
    }> = []
    for (const hit of hits) {
      const title = cleanText(hit.title, 260)
      const excerpt = cleanText(hit.content, 1800)
      const url = validPublicUrl(hit.url)
      const publishedDate = publishedDateOf(hit)
      if (!url || seen.has(url) || (!title && excerpt.length < 20)) continue
      if (publishedDate && publishedDate > input.sourceCutoffDate) continue
      seen.add(url)
      usableHits.push({ title, excerpt, url, publishedDate })
      resultCount += 1
      sources.push({
        sourceType: 'public_web',
        sourceId: hashId(url),
        sourceName: `公开信息｜${plan.topic}｜${title || new URL(url).hostname}`.slice(0, 255),
        chunkIndex: sources.length,
        versionOrDate: publishedDate || `网页未标明发布日期；访问${accessedAt.slice(0, 10)}`,
        locator: url,
        content: [
          `Q&A 分类：${plan.category}。检索主题：${plan.topic}。`,
          title ? `网页标题：${title}。` : '',
          excerpt ? `公开摘要：${excerpt}` : '',
          publishedDate
            ? `公开日期：${publishedDate}。`
            : '网页未标明公开日期，不能仅凭该页面证明资料截止日前已经发生的事实。',
          `访问日期：${accessedAt.slice(0, 10)}。`,
          '证据属性：联网公开信息；关键事实应尽量回到原网页或原始披露交叉核验。',
        ].filter(Boolean).join('\n').slice(0, 3600),
      })
      if (sources.length >= (input.maxSources ?? 60)) break
    }
    if (sources.length >= (input.maxSources ?? 60)) break
    sources.push({
      sourceType: 'public_web_search_audit',
      sourceId: `search-${hashId(plan.query)}`,
      sourceName: `公开检索记录｜${plan.topic}`,
      chunkIndex: sources.length,
      versionOrDate: accessedAt.slice(0, 10),
      content: [
        `Q&A 分类：${plan.category}。检索主题：${plan.topic}。`,
        `检索式：${plan.query}。`,
        `截至${input.sourceCutoffDate}的本次公开检索返回可用线索${usableHits.length}条。`,
        usableHits.length
          ? '检索结果仅作为公开信息线索，关键事实仍须结合原网页、项目原件或其他独立来源核验。'
          : '本次检索未发现可直接核验的公开披露；该结果不能证明相关事项不存在。',
      ].join('\n'),
    })
    if (sources.length >= (input.maxSources ?? 60)) break
  }

  return {
    sources: sources.slice(0, input.maxSources ?? 60),
    attemptedQueries: plans.length,
    successfulQueries: succeeded.length,
    failedQueries: plans.length - succeeded.length,
    resultCount,
    accessedAt,
    provider: 'searxng',
  }
}
