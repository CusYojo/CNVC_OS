import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { EvidenceSource } from './aiBusinessContentService.js'

const GW_BASE = (
  process.env.LLM_BASE_URL
  || process.env.OPENAI_BASE_URL
  || 'http://127.0.0.1:18081/v1'
).replace(/\/$/, '')
const GW_KEY = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || ''
const MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-6'
const MODEL_RESEARCH_TIMEOUT_MS = Math.max(
  3_000,
  Math.min(Number(process.env.AI_COMPLIANCE_MODEL_RESEARCH_TIMEOUT_MS) || 30_000, 90_000),
)
const SOURCE_FETCH_TIMEOUT_MS = Math.max(
  2_000,
  Math.min(Number(process.env.AI_COMPLIANCE_SOURCE_FETCH_TIMEOUT_MS) || 8_000, 30_000),
)

type ProjectLike = {
  name: string
  companyName?: string | null
  industry?: string | null
  summary?: string | null
}

type ModelResearchHit = {
  topic?: unknown
  title?: unknown
  url?: unknown
  publisher?: unknown
  publishedAt?: unknown
}

type FetchLike = typeof fetch
type ResolveHost = (hostname: string) => Promise<string[]>

export type ComplianceModelResearchAudit = {
  enabled: boolean
  status: 'disabled' | 'succeeded' | 'partial' | 'no_results' | 'unavailable'
  provider: 'project_llm'
  model: string
  accessedAt: string
  requestedSections: string[]
  proposedSourceCount: number
  verifiedSourceCount: number
  rejectedSourceCount: number
}

export type ComplianceModelResearchResult = {
  sources: EvidenceSource[]
  audit: ComplianceModelResearchAudit
}

function meaningful(value: unknown) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text || /^(?:待核验|待补充|暂无|未提供|unknown|n\/?a)$/i.test(text)) return ''
  return text
}

function parseModelJson(value: string) {
  const cleaned = value.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '')
  return JSON.parse(cleaned) as { results?: ModelResearchHit[] }
}

function normalizedUrl(value: unknown) {
  try {
    const url = new URL(String(value ?? '').trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    url.hash = ''
    return url
  } catch {
    return undefined
  }
}

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '')
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8')
    || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true
  }
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return false
  const [a, b] = normalized.split('.').map(Number)
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224
}

async function defaultResolveHost(hostname: string) {
  const records = await lookup(hostname, { all: true })
  return records.map((record) => record.address)
}

async function isSafePublicUrl(url: URL, resolveHost: ResolveHost) {
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.local')) return false
  if (isIP(hostname)) return !isPrivateAddress(hostname)
  try {
    const addresses = await resolveHost(hostname)
    return addresses.length > 0 && addresses.every((address) => !isPrivateAddress(address))
  } catch {
    return false
  }
}

function htmlTitle(html: string) {
  return meaningful(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]+>/g, ' '))
}

function pageText(html: string) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
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
}

function normalizedDate(value: unknown) {
  const text = meaningful(value)
  if (!text) return ''
  const chinese = text.match(/\b(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})日?\b/)
  if (chinese) {
    const date = `${chinese[1]}-${chinese[2].padStart(2, '0')}-${chinese[3].padStart(2, '0')}`
    return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? '' : date
  }
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString().slice(0, 10)
}

function projectAliases(project: ProjectLike) {
  return [...new Set([
    meaningful(project.companyName),
    meaningful(project.name).replace(/项目$/, ''),
  ]
    .map((value) => value.replace(/(?:有限责任公司|股份有限公司|有限公司)$/g, '').replace(/\s+/g, ''))
    .filter((value) => value.length >= 2))]
}

function pageMatchesProject(text: string, project: ProjectLike, topic: string) {
  if (/政策|监管|投资限制|返投|关联交易|投资方向|投资配置|集中度/.test(topic)) return true
  const compact = text.replace(/\s+/g, '')
  return projectAliases(project).some((alias) => compact.includes(alias))
}

function sourceId(url: string) {
  return createHash('sha256').update(url).digest('hex')
}

function researchEnabled(parameters?: Record<string, unknown>) {
  if (parameters?.networkSupplement === false) return false
  if (process.env.AI_COMPLIANCE_DISABLE_LLM === '1') return false
  return process.env.AI_COMPLIANCE_MODEL_RESEARCH_ENABLED?.toLowerCase() !== 'false'
}

export async function fetchComplianceModelEvidence(input: {
  project: ProjectLike
  sourceCutoffDate: string
  missingSections: string[]
  parameters?: Record<string, unknown>
  fetchImpl?: FetchLike
  resolveHost?: ResolveHost
  now?: Date
  maxSources?: number
}): Promise<ComplianceModelResearchResult> {
  const enabled = researchEnabled(input.parameters)
  const now = input.now ?? new Date()
  const accessedAt = now.toISOString()
  const auditBase = {
    enabled,
    provider: 'project_llm' as const,
    model: MODEL,
    accessedAt,
    requestedSections: [...new Set(input.missingSections)],
  }
  if (!enabled || input.missingSections.length === 0) {
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

  const fetchImpl = input.fetchImpl ?? fetch
  const resolveHost = input.resolveHost ?? defaultResolveHost
  let hits: ModelResearchHit[] = []
  try {
    const response = await fetchImpl(`${GW_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(GW_KEY ? { Authorization: `Bearer ${GW_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content: `你是项目统一大模型的联网检索执行器。必须使用当前模型真实可用的联网或搜索能力查找公开网页；不得使用训练记忆编造事实或网址。只返回JSON：{"results":[{"topic":"","title":"","url":"","publisher":"","publishedAt":"YYYY-MM-DD或空字符串"}]}。topic只能是“公司工商与主体、官网、产品及技术、核心团队、融资与投资、处罚、诉讼与失信、行业政策与监管、投资方式及投资限制、返投政策与认定、关联交易、投资方向、投资配置、投资集中度”之一。每条必须有真实可访问的http/https URL；无法联网或没有可靠来源时返回空数组。`,
          },
          {
            role: 'user',
            content: `围绕同一具体项目定向补全缺失证据，不做泛行业研究。
项目名称：${input.project.name}
公司主体：${input.project.companyName || '待核验'}
所属行业：${input.project.industry || '待核验'}
项目概述：${input.project.summary || '待核验'}
缺失章节：${input.missingSections.join('、')}
资料截止日：${input.sourceCutoffDate}

优先检索政府、监管、司法、登记机关、学校或实验室官网、公司官网、投资机构公告和可信专业媒体。查找主体、团队、实验室、产品技术、融资事件、商业化信号、处罚诉讼及适用政策；对基金核查继续查找公开投资限制、返投政策与认定口径、返投公示、关联交易披露、投资方向、配置和集中度规则。不得提供资料截止日之后发布或更新的页面。最多返回16条。`,
          },
        ],
        max_tokens: 3500,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(MODEL_RESEARCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`LLM ${response.status}`)
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const parsed = parseModelJson(data.choices?.[0]?.message?.content ?? '')
    hits = Array.isArray(parsed.results) ? parsed.results.slice(0, 20) : []
  } catch {
    return {
      sources: [],
      audit: {
        ...auditBase,
        status: 'unavailable',
        proposedSourceCount: 0,
        verifiedSourceCount: 0,
        rejectedSourceCount: 0,
      },
    }
  }

  const maxSources = Math.max(1, Math.min(input.maxSources ?? 16, 24))
  const sources: EvidenceSource[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    if (sources.length >= maxSources) break
    const proposedUrl = normalizedUrl(hit.url)
    if (!proposedUrl || !(await isSafePublicUrl(proposedUrl, resolveHost))) continue
    try {
      const response = await fetchImpl(proposedUrl, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
          'User-Agent': 'Cybernaut-Project-LLM-Research/1.0',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
      })
      if (!response.ok) continue
      const finalUrl = normalizedUrl(response.url || proposedUrl.toString())
      if (!finalUrl || !(await isSafePublicUrl(finalUrl, resolveHost))) continue
      const canonicalUrl = finalUrl.toString()
      if (seen.has(canonicalUrl)) continue
      const html = await response.text()
      const text = pageText(html)
      const topic = meaningful(hit.topic) || '项目公开信息'
      if (text.length < 120 || !pageMatchesProject(text, input.project, topic)) continue
      const publishedAt = normalizedDate(hit.publishedAt)
      if (publishedAt && publishedAt > input.sourceCutoffDate) continue
      const title = meaningful(hit.title) || htmlTitle(html) || finalUrl.hostname
      const publisher = meaningful(hit.publisher) || finalUrl.hostname
      const contentHash = createHash('sha256').update(text).digest('hex')
      seen.add(canonicalUrl)
      sources.push({
        sourceType: 'public_web_llm',
        sourceId: sourceId(canonicalUrl),
        sourceName: `项目大模型网络补全·${topic}·${title}`.slice(0, 255),
        chunkIndex: sources.length,
        versionOrDate: publishedAt || `发布日期待核验；访问${accessedAt.slice(0, 10)}`,
        locator: canonicalUrl,
        content: [
          '本条由项目统一大模型发现，并经系统直接读取来源页面核验；仅作为待核验公开线索。',
          `页面标题：${title}`,
          `发布主体：${publisher}`,
          publishedAt
            ? `发布日期：${publishedAt}`
            : '发布日期待核验，不得据此认定资料截止日前已经公开。',
          `访问日期：${accessedAt.slice(0, 10)}`,
          `适用主题：${topic}`,
          `页面正文摘录：${text.slice(0, 2800)}`,
          `内容指纹：${contentHash}`,
          `项目大模型：${MODEL}`,
        ].join('\n'),
      })
    } catch {
      // 单条来源不可访问或不可核验时丢弃，不影响其他来源。
    }
  }

  const rejectedSourceCount = Math.max(0, hits.length - sources.length)
  return {
    sources,
    audit: {
      ...auditBase,
      status: sources.length === 0
        ? 'no_results'
        : rejectedSourceCount > 0
          ? 'partial'
          : 'succeeded',
      proposedSourceCount: hits.length,
      verifiedSourceCount: sources.length,
      rejectedSourceCount,
    },
  }
}
