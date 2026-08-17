import { createHash } from 'node:crypto'
import type { EvidenceSource } from './aiBusinessContentService.js'
import { collectCompanyIntel } from './inProcessAiWorkflowService.js'
import { formatShanghaiDateKey, parseShanghaiDate } from '../utils/shanghaiTime.js'

const WORKFLOW = process.env.AI_DUE_DILIGENCE_RESEARCH_WORKFLOW || 'intel-collect'
const MODEL = 'deterministic-public-search-v1'
const TIMEOUT_MS = Math.max(
  30_000,
  // intel-collect 直接返回真实搜索证据；为多主题并发检索及备用搜索源
  // 留出余量，同时避免不可用时让文档任务长时间停留在补全阶段。
  Math.min(Number(process.env.AI_DUE_DILIGENCE_RESEARCH_TIMEOUT_MS) || 150_000, 240_000),
)

type ProjectLike = {
  name: string
  companyName?: string | null
}

type SearchEvidence = {
  query?: unknown
  title?: unknown
  snippet?: unknown
  url?: unknown
  publisher?: unknown
  publishedAt?: unknown
  reliability?: unknown
}

type IntelCollectResult = {
  searchEvidence?: SearchEvidence[]
  sources?: Array<{ title?: unknown; url?: unknown; reliability?: unknown }>
  companyNews?: Array<{ title?: unknown; summary?: unknown; sourceUrl?: unknown }>
  fundingRounds?: Array<{
    round?: unknown
    date?: unknown
    amount?: unknown
    valuation?: unknown
    investors?: unknown
    sourceUrl?: unknown
  }>
}

export type DueDiligenceNetworkResearchAudit = {
  enabled: boolean
  status: 'disabled' | 'succeeded' | 'partial' | 'no_results' | 'unavailable'
  provider: 'in_process_intel_collect'
  workflow: string
  model: string
  accessedAt: string
  requestedSections: string[]
  proposedSourceCount: number
  verifiedSourceCount: number
  rejectedSourceCount: number
  failureReason?: string
}

export type DueDiligenceNetworkResearchResult = {
  sources: EvidenceSource[]
  audit: DueDiligenceNetworkResearchAudit
}

type FetchLike = typeof fetch

function meaningful(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function normalizedUrl(value: unknown) {
  try {
    const url = new URL(meaningful(value))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ''
    if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) return ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

function normalizedDate(value: unknown) {
  const text = meaningful(value)
  if (!text) return ''
  const chinese = text.match(/\b(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})日?\b/)
  if (chinese) {
    const date = `${chinese[1]}-${chinese[2].padStart(2, '0')}-${chinese[3].padStart(2, '0')}`
    try { parseShanghaiDate(date); return date } catch { return '' }
  }
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? '' : formatShanghaiDateKey(parsed)
}

function enabled(parameters?: Record<string, unknown>) {
  if (parameters?.networkSupplement === false) return false
  return process.env.AI_DUE_DILIGENCE_NETWORK_RESEARCH_ENABLED?.toLowerCase() !== 'false'
}

function sourceId(url: string) {
  return createHash('sha256').update(url).digest('hex')
}

function projectAliases(project: ProjectLike) {
  return [...new Set([
    meaningful(project.companyName),
    meaningful(project.name).replace(/项目$/, ''),
  ]
    .map((value) => value
      .replace(/(?:有限责任公司|股份有限公司|有限公司)$/g, '')
      .replace(/\s+/g, ''))
    .filter((value) => value.length >= 3))]
}

function matchesProject(item: SearchEvidence, project: ProjectLike) {
  const compact = `${meaningful(item.title)}${meaningful(item.snippet)}`.replace(/\s+/g, '')
  return projectAliases(project).some((alias) => compact.includes(alias))
}

function isApplicablePublicRule(item: SearchEvidence) {
  const query = meaningful(item.query)
  const evidence = `${meaningful(item.title)} ${meaningful(item.snippet)}`
  if (!/返投|投资限制|关联交易|投资方向|投资配置|SPV|集中度|许可|备案|处罚|诉讼|失信|监管|政策/.test(query)) {
    return false
  }
  // 通用监管或返投规则不一定出现项目名称，但检索结果本身必须命中相同
  // 核查语义，避免把仅因搜索分词召回的无关网页带入项目资料库。
  return /返投|投资限制|关联交易|投资方向|投资配置|SPV|集中度|许可|备案|处罚|诉讼|失信|监管|政策|基金/.test(
    evidence,
  )
}

export async function fetchDueDiligenceNetworkEvidence(input: {
  project: ProjectLike
  sourceCutoffDate: string
  pendingTopics: string[]
  parameters?: Record<string, unknown>
  fetchImpl?: FetchLike
  now?: Date
  maxSources?: number
}): Promise<DueDiligenceNetworkResearchResult> {
  const researchEnabled = enabled(input.parameters)
  const accessedAt = (input.now ?? new Date()).toISOString()
  const requestedSections = [...new Set(input.pendingTopics.map(meaningful).filter(Boolean))]
  const auditBase = {
    enabled: researchEnabled,
    provider: 'in_process_intel_collect' as const,
    workflow: WORKFLOW,
    model: MODEL,
    accessedAt,
    requestedSections,
  }
  if (!researchEnabled || requestedSections.length === 0) {
    return {
      sources: [],
      audit: {
        ...auditBase,
        status: 'disabled',
        proposedSourceCount: 0,
        verifiedSourceCount: 0,
        rejectedSourceCount: 0,
      },
    }
  }

  let result: IntelCollectResult
  try {
    if (input.fetchImpl) {
      const response = await input.fetchImpl('http://in-process.invalid/intel-collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company: input.project.companyName || input.project.name,
          topics: requestedSections,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`情报采集模拟入口 ${response.status}`)
      const payload = await response.json() as { result?: IntelCollectResult }
      if (!payload.result) throw new Error('情报采集返回空 result')
      result = payload.result
    } else {
      result = await collectCompanyIntel({
        company: input.project.companyName || input.project.name,
        topics: requestedSections,
      })
    }
  } catch (error) {
    return {
      sources: [],
      audit: {
        ...auditBase,
        status: 'unavailable',
        proposedSourceCount: 0,
        verifiedSourceCount: 0,
        rejectedSourceCount: 0,
        failureReason: (error as Error).message.slice(0, 180),
      },
    }
  }

  const proposed: SearchEvidence[] = [
    ...(Array.isArray(result.searchEvidence) ? result.searchEvidence : []),
    ...(result.searchEvidence?.length ? [] : (result.sources ?? []).map((source) => ({
      title: source.title,
      url: source.url,
      reliability: source.reliability,
    }))),
    ...(result.companyNews ?? []).map((item) => ({
      title: item.title,
      snippet: item.summary,
      url: item.sourceUrl,
      query: '公司动态与商业化信号',
    })),
    ...(result.fundingRounds ?? []).map((item) => ({
      title: `${meaningful(item.date)} ${meaningful(item.round)} ${meaningful(item.amount)}`.trim(),
      snippet: [
        meaningful(item.valuation) ? `估值：${meaningful(item.valuation)}` : '',
        meaningful(item.investors) ? `投资方：${meaningful(item.investors)}` : '',
      ].filter(Boolean).join('；'),
      url: item.sourceUrl,
      publishedAt: item.date,
      query: '融资与投资事件',
    })),
  ]
  const maxSources = Math.max(1, Math.min(input.maxSources ?? 20, 30))
  const seen = new Set<string>()
  const sources: EvidenceSource[] = []
  for (const item of proposed) {
    if (sources.length >= maxSources) break
    if (!matchesProject(item, input.project) && !isApplicablePublicRule(item)) continue
    const url = normalizedUrl(item.url)
    if (!url || seen.has(url)) continue
    const publishedAt = normalizedDate(item.publishedAt)
    if (publishedAt && publishedAt > input.sourceCutoffDate) continue
    const title = meaningful(item.title)
    const snippet = meaningful(item.snippet)
    if (!title && !snippet) continue
    seen.add(url)
    const query = meaningful(item.query) || '项目公开信息'
    const contentHash = createHash('sha256')
      .update(`${query}\n${title}\n${snippet}\n${url}`)
      .digest('hex')
    sources.push({
      sourceType: 'public_web_agent_search',
      sourceId: sourceId(url),
      sourceName: `项目大模型网络补全·${query}·${title || '公开信息'}`.slice(0, 255),
      chunkIndex: sources.length,
      versionOrDate: publishedAt || `访问${accessedAt.slice(0, 10)}`,
      locator: url,
      content: [
        '检索方式：主服务进程内调用确定性公开检索器抓取搜索结果。',
        `检索问题：${query}`,
        `页面标题：${title || '未提取'}`,
        snippet ? `搜索摘要：${snippet}` : '',
        meaningful(item.publisher) ? `发布主体：${meaningful(item.publisher)}` : '',
        publishedAt ? `发布日期：${publishedAt}` : '发布日期未由搜索结果明确披露。',
        meaningful(item.reliability) ? `来源可靠性：${meaningful(item.reliability)}` : '',
        `来源网址：${url}`,
        `访问日期：${accessedAt.slice(0, 10)}`,
        `内容指纹：${contentHash}`,
        `采集器：${MODEL}`,
        `进程内流程：${WORKFLOW}`,
      ].filter(Boolean).join('\n'),
    })
  }

  return {
    sources,
    audit: {
      ...auditBase,
      status: sources.length === 0
        ? 'no_results'
        : sources.length < proposed.length
          ? 'partial'
          : 'succeeded',
      proposedSourceCount: proposed.length,
      verifiedSourceCount: sources.length,
      rejectedSourceCount: Math.max(0, proposed.length - sources.length),
    },
  }
}
