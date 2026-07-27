import { createHash } from 'node:crypto'
import type { EvidenceSource } from './aiBusinessContentService.js'

const SEARXNG_BASE_URL = (
  process.env.SEARXNG_BASE_URL || 'http://127.0.0.1:8888'
).replace(/\/+$/, '')
const SEARXNG_ENGINES = process.env.SEARXNG_ENGINES || '360search,sogou,quark'

type SearxResult = {
  title?: string
  content?: string
  url?: string
  publishedDate?: string
  published_date?: string
}

export type DueDiligenceResearchResult = {
  sources: EvidenceSource[]
  attemptedQueries: number
  successfulQueries: number
  failedQueries: number
}

export type PublicResearchPurpose = 'due_diligence' | 'investment_proposal'

function cleanText(value: unknown, maxLength: number) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function validPublicUrl(value: unknown) {
  const url = cleanText(value, 1200)
  if (!/^https?:\/\//i.test(url)) return ''
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return ''
  }
}

function publishedDateOf(result: SearxResult) {
  const value = cleanText(result.publishedDate || result.published_date, 64)
  const parsed = value ? new Date(value) : undefined
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toISOString().slice(0, 10)
    : undefined
}

export function buildDueDiligenceResearchQueries(input: {
  projectName: string
  companyName?: string | null
  industry?: string | null
  purpose?: PublicResearchPurpose
}) {
  const company = cleanText(input.companyName, 160) || cleanText(input.projectName, 160)
  const industry = cleanText(input.industry, 120)
  const subject = company || cleanText(input.projectName, 160)
  if (input.purpose === 'investment_proposal') {
    return [
      { topic: '公司基本情况', query: `${subject} 公司简介 成立时间 注册资本 法定代表人 主营业务` },
      { topic: '核心团队', query: `${subject} 创始人 核心团队 高管 履历 管理层` },
      { topic: '股权与融资历史', query: `${subject} 股东 股权 实际控制人 融资轮次 投资方 估值` },
      { topic: '产品与技术', query: `${subject} 产品 技术 研发 专利 知识产权 测试 认证` },
      { topic: '客户与运营', query: `${subject} 客户 合同 订单 中标 交付 回款 商业化` },
      { topic: '财务表现', query: `${subject} 财务 营业收入 成本 毛利 净利润 现金流` },
      { topic: '本轮交易与保护条款', query: `${subject} 本轮融资 投前估值 投资金额 资金用途 保护性条款 回购 反稀释` },
      { topic: '经营预测与退出', query: `${subject} 经营预测 收入预测 利润预测 上市计划 退出 回报` },
      {
        topic: '行业与可比估值',
        query: `${industry || subject} 市场规模 增长率 竞争格局 可比公司 估值 PE PS EV`,
      },
      { topic: '风险与合规', query: `${subject} 风险 诉讼 行政处罚 被执行人 合规 舆情` },
    ]
  }
  return [
    { topic: '工商与股权', query: `${subject} 工商 注册资本 法定代表人 股东 股权 融资` },
    { topic: '团队与治理', query: `${subject} 创始人 核心团队 董事 高管 履历` },
    { topic: '产品与技术', query: `${subject} 产品 技术 专利 软件著作权 研发` },
    { topic: '客户与经营', query: `${subject} 客户 合作 中标 合同 营收 商业化` },
    {
      topic: '行业与市场',
      query: `${industry || subject} 行业 市场规模 增长率 竞争格局 产业链`,
    },
    { topic: '融资与估值', query: `${subject} 融资 估值 投资方 融资历程` },
    { topic: '资质与合规', query: `${subject} 资质 许可 认证 行政处罚 诉讼` },
    { topic: '风险与动态', query: `${subject} 风险 舆情 裁判文书 被执行人 最新动态` },
  ]
}

export async function collectDueDiligencePublicEvidence(
  input: {
    projectName: string
    companyName?: string | null
    industry?: string | null
    sourceCutoffDate: string
    maxSources?: number
    purpose?: PublicResearchPurpose
  },
  fetchImpl: typeof fetch = fetch,
): Promise<DueDiligenceResearchResult> {
  const queries = buildDueDiligenceResearchQueries(input)
  const cutoff = new Date(`${input.sourceCutoffDate}T23:59:59.999Z`)
  const responses = await Promise.all(queries.map(async ({ topic, query }, queryIndex) => {
    try {
      const url = `${SEARXNG_BASE_URL}/search?q=${encodeURIComponent(query)}&format=json&engines=${encodeURIComponent(SEARXNG_ENGINES)}`
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000) })
      if (!response.ok) return { ok: false, sources: [] as EvidenceSource[] }
      const body = await response.json() as { results?: SearxResult[] }
      const resultSources = (body.results ?? [])
        .slice(0, input.purpose === 'investment_proposal' ? 5 : 8)
        .flatMap((result, resultIndex) => {
        const title = cleanText(result.title, 240)
        const snippet = cleanText(result.content, 1800)
        const sourceUrl = validPublicUrl(result.url)
        const publishedDate = publishedDateOf(result)
        if (!title || !sourceUrl || snippet.length < 20) return []
        if (publishedDate && new Date(`${publishedDate}T23:59:59.999Z`) > cutoff) return []
        return [{
          sourceType: 'public_web',
          sourceId: sourceUrl,
          sourceName: `公开信息｜${title}`,
          chunkIndex: queryIndex * 10 + resultIndex,
          versionOrDate: publishedDate,
          content: [
            `检索主题：${topic}`,
            `网页标题：${title}`,
            `公开摘要：${snippet}`,
            `网页地址：${sourceUrl}`,
            publishedDate ? `公开日期：${publishedDate}` : '公开日期：网页未标明',
            '证据属性：联网公开信息，引用前应结合来源权威性和其他独立来源交叉核验。',
          ].join('\n'),
        } satisfies EvidenceSource]
      })
      const searchLog = input.purpose === 'investment_proposal'
        ? [{
            sourceType: 'public_web',
            sourceId: `search-${createHash('sha256').update(query).digest('hex').slice(0, 24)}`,
            sourceName: `公开检索记录｜${topic}`,
            chunkIndex: queryIndex * 10 + 9,
            versionOrDate: input.sourceCutoffDate,
            content: [
              `检索主题：${topic}`,
              `检索式：${query}`,
              `公开检索返回可用结果：${resultSources.length}条。`,
              resultSources.length
                ? '检索结果仅作为公开信息线索，具体事实须回到原网页或项目原件交叉核验。'
                : '本次公开检索未发现可直接引用的结果；该结果不能证明相关事项不存在，仍需向公司取得原始资料。',
            ].join('\n'),
          } satisfies EvidenceSource]
        : []
      return { ok: true, sources: [...resultSources, ...searchLog] }
    } catch {
      return { ok: false, sources: [] as EvidenceSource[] }
    }
  }))

  const deduped = new Map<string, EvidenceSource>()
  responses.flatMap((response) => response.sources).forEach((source) => {
    const key = source.sourceId || `${source.sourceName}:${source.content.slice(0, 160)}`
    if (!deduped.has(key)) deduped.set(key, source)
  })

  return {
    sources: [...deduped.values()].slice(0, input.maxSources ?? 48),
    attemptedQueries: queries.length,
    successfulQueries: responses.filter((response) => response.ok).length,
    failedQueries: responses.filter((response) => !response.ok).length,
  }
}
