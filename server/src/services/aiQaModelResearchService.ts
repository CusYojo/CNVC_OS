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
  5_000,
  Math.min(Number(process.env.AI_QA_MODEL_RESEARCH_TIMEOUT_MS) || 25_000, 90_000),
)
const SOURCE_FETCH_TIMEOUT_MS = Math.max(
  2_000,
  Math.min(Number(process.env.AI_QA_SOURCE_FETCH_TIMEOUT_MS) || 10_000, 30_000),
)
const DIRECT_SEARCH_TIMEOUT_MS = Math.max(
  2_000,
  Math.min(Number(process.env.AI_QA_DIRECT_SEARCH_TIMEOUT_MS) || 12_000, 30_000),
)
const DIRECT_SEARCH_ENDPOINT = process.env.AI_QA_DIRECT_SEARCH_ENDPOINT
  || 'https://search.brave.com/search'
const DIRECT_SEARCH_FALLBACK_ENDPOINT = 'https://html.duckduckgo.com/html/'
const NATIVE_MODEL_SEARCH_ENABLED =
  process.env.AI_QA_NATIVE_MODEL_SEARCH_ENABLED?.toLowerCase() === 'true'

type ProjectLike = {
  name: string
  companyName?: string | null
  industry?: string | null
  summary?: string | null
  team?: string | null
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

export const PROJECT_QA_RESEARCH_TOPICS = [
  '项目主体与工商',
  '股权、治理与关联关系',
  '创始人与核心团队',
  '产品、技术指标与工程化里程碑',
  '知识产权与研发合作',
  '客户、订单与商业化信号',
  '财务与现金流',
  '融资、估值与投资方',
  '交易方案与关键条款',
  '竞品、替代方案与项目级对标',
  '监管、诉讼与重大风险',
] as const

export type ProjectQaResearchTopic = typeof PROJECT_QA_RESEARCH_TOPICS[number]

export type ProjectQaModelResearchAudit = {
  enabled: boolean
  status: 'disabled' | 'succeeded' | 'partial' | 'no_results' | 'unavailable'
  provider: 'project_llm'
  model: string
  accessedAt: string
  requestedTopics: ProjectQaResearchTopic[]
  discovery:
    | 'none'
    | 'agent_search'
    | 'model'
    | 'direct_search'
    | 'agent_and_model'
    | 'agent_and_direct_search'
    | 'model_and_direct_search'
    | 'agent_model_and_direct_search'
  agentCandidateCount: number
  proposedSourceCount: number
  verifiedSourceCount: number
  rejectedSourceCount: number
  failureReason?: string
}

export type ProjectQaModelResearchResult = {
  sources: EvidenceSource[]
  audit: ProjectQaModelResearchAudit
}

export type ProjectWebResearchAudit = ProjectQaModelResearchAudit
export type ProjectWebResearchResult = ProjectQaModelResearchResult

const TOPIC_SIGNALS: Record<ProjectQaResearchTopic, string[]> = {
  '项目主体与工商': ['公司主体', '法律主体', '成立于', '注册资本', '工商', '统一社会信用代码'],
  '股权、治理与关联关系': ['股权结构', '股东', '持股比例', '实际控制人', '董事会', '关联交易', '工商变更'],
  '创始人与核心团队': ['创始人', '联合创始人', '核心团队', '首席科学家', '教授', '博士', 'CEO', 'CTO'],
  '产品、技术指标与工程化里程碑': ['核心产品', '技术指标', '样机', '原型', '中试', '量产', '交付', '工程化'],
  '知识产权与研发合作': ['发明专利', '专利号', '论文', '软件著作权', '知识产权权属', '职务发明', '技术许可', '联合研发'],
  '客户、订单与商业化信号': ['客户合同', '正式合同', '采购订单', '试点', 'POC', '验收', '营业收入', '回款', '复购'],
  '财务与现金流': ['营业收入', '成本', '毛利率', '净利润', '现金流', '应收账款', '回款', '财务报表'],
  '融资、估值与投资方': ['完成融资', '投资方', '融资轮次', '融资金额', '本轮融资', '估值', '增资', '股权转让'],
  '交易方案与关键条款': ['投资方案', '交易方案', '投资金额', '持股比例', '交割条件', '回购', '保护性条款'],
  '竞品、替代方案与项目级对标': ['竞争对手', '主要竞品', '对标项目', '替代方案', '差异化', '竞争壁垒'],
  '监管、诉讼与重大风险': ['行政处罚', '监管', '诉讼', '执行信息', '失信', '重大风险', '业务资质'],
}

const TOPIC_QUERY_TERMS: Record<ProjectQaResearchTopic, string> = {
  '项目主体与工商': '公司 成立 工商 主体',
  '股权、治理与关联关系': '股东 股权 实际控制人 董事',
  '创始人与核心团队': '创始人 联合创始人 核心团队 履历',
  '产品、技术指标与工程化里程碑': '产品 技术 样机 中试 量产',
  '知识产权与研发合作': '专利 论文 知识产权 研发合作',
  '客户、订单与商业化信号': '客户 订单 合同 试点 商业化',
  '财务与现金流': '收入 毛利 财务 现金流',
  '融资、估值与投资方': '融资 投资方 估值 轮次',
  '交易方案与关键条款': '投资 交易 增资 股权转让',
  '竞品、替代方案与项目级对标': '竞品 对标 替代方案',
  '监管、诉讼与重大风险': '监管 诉讼 行政处罚 风险',
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

const WEB_CHROME_PATTERN =
  /(?:联系我们|联系邮箱|联系电话|客服热线|微信号|微信公众号|京ICP备|公网安备|Copyright|All Rights Reserved|隐私政策|用户协议|网站地图|返回顶部|上一篇|下一篇|相关推荐|热门推荐)/i

const WEB_NAVIGATION_TERMS = [
  '首页',
  '权威榜',
  '价值榜',
  '行业数据',
  '产业图谱',
  '行业研究',
  '查询企业',
  '企业入驻',
  '登录',
  '登入',
  '小程序',
]

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = {
    nbsp: ' ',
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
  }
  return value
    .replace(/&([a-z]+);/gi, (token, name: string) => named[name.toLowerCase()] ?? ' ')
    .replace(/&#(\d+);/g, (_token, code: string) =>
      String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_token, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)))
}

function stripPageChrome(html: string) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style|noscript|svg|canvas|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(
      /<([a-z][\w:-]*)\b[^>]*(?:id|class)=["'][^"']*(?:nav|menu|header|footer|sidebar|breadcrumb|toolbar|share|social|contact|copyright|record|login|search|recommend|related|qrcode)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
      ' ',
    )
}

function textLinesFromHtml(html: string) {
  const withBoundaries = stripPageChrome(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6]|article|main|section|div|td|th|tr|dl|dt|dd)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeHtmlEntities(withBoundaries)
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .flatMap((line) => {
      if (line.length <= 700) return [line]
      const sentences = line.split(/(?<=[。！？!?；;])/)
      return sentences.length > 1 ? sentences : [line]
    })
    .map((line) => {
      const noise = line.match(WEB_CHROME_PATTERN)
      if (!noise || noise.index === undefined) return line
      const prefix = line.slice(0, noise.index).replace(/[，,；;、\s]+$/, '').trim()
      return prefix.length >= 20 ? prefix : ''
    })
    .map((line) => line.length > 420 ? `${line.slice(0, 420).trim()}…` : line)
    .filter((line) => {
      if (line.length < 12 || WEB_CHROME_PATTERN.test(line)) return false
      const navigationHits = WEB_NAVIGATION_TERMS
        .filter((term) => line.includes(term))
        .length
      if (navigationHits >= 3) return false
      const meaningfulCharacters = (line.match(/[\u3400-\u9fffA-Za-z0-9]/g) ?? []).length
      return meaningfulCharacters / Math.max(1, line.length) >= 0.45
    })
}

function htmlTitle(html: string) {
  const raw = decodeHtmlEntities(
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/<[^>]+>/g, ' ') ?? '',
  ).replace(/\s+/g, ' ').trim()
  const chromeStart = raw.search(/(?:innoHere|英诺嘿呀首页|联系我们|Copyright|All Rights Reserved)/i)
  const withoutChrome = (chromeStart > 0 ? raw.slice(0, chromeStart) : raw)
    .replace(/\s*[-|_]\s*[^-|_]*(?:首页|官网|平台)\s*$/i, '')
  return meaningful(withoutChrome.replace(/[-|_·\s]+$/, '').slice(0, 160))
}

export function extractProjectQaPublicPageText(html: string) {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const line of textLinesFromHtml(html)) {
    const key = line.replace(/[\s，。；：！？、,.!?;:'"“”‘’（）()《》【】[\]]+/g, '')
    if (key.length < 10 || seen.has(key)) continue
    seen.add(key)
    unique.push(line)
    if (unique.join('\n').length >= 12_000) break
  }
  return unique.join('\n').slice(0, 12_000).trim()
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

function publishedDateFromHtml(html: string) {
  const candidates = [
    html.match(/<meta[^>]+(?:property|name)=["'](?:article:published_time|publishdate|pubdate|date)["'][^>]+content=["']([^"']+)["']/i)?.[1],
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:article:published_time|publishdate|pubdate|date)["']/i)?.[1],
    html.match(/["']datePublished["']\s*:\s*["']([^"']+)["']/i)?.[1],
  ]
  return candidates.map(normalizedDate).find(Boolean) || ''
}

function normalizedAlias(value: unknown) {
  return meaningful(value)
    .replace(/(?:有限责任公司|股份有限公司|有限公司|项目)$/g, '')
    .replace(/[“”"'《》\s]+/g, '')
}

function projectAliases(project: ProjectLike, sources: readonly EvidenceSource[]) {
  const aliases = [
    normalizedAlias(project.companyName),
    normalizedAlias(project.name),
  ]
  const sourceText = sources.slice(0, 30).map((source) => source.content).join('\n')
  const explicitNames = sourceText.match(
    /(?:公司主体|项目主体|公司名称|项目名称|核心产品|产品名称)[：:]\s*([^\n。；;]{2,40})/g,
  ) ?? []
  explicitNames.forEach((entry) => aliases.push(normalizedAlias(entry.split(/[：:]/).slice(1).join(':'))))
  return [...new Set(aliases.filter((value) => value.length >= 2))].slice(0, 12)
}

function exactProjectEntityNames(project: ProjectLike, sources: readonly EvidenceSource[]) {
  const values = [meaningful(project.companyName), meaningful(project.name)]
  const sourceText = sources.slice(0, 30).map((source) => source.content).join('\n')
  const matches = sourceText.match(
    /(?:公司主体|法律主体|公司全称|运营主体|业务主体)[：:]\s*([^\n。；;]{2,60})/g,
  ) ?? []
  matches.forEach((entry) => values.push(
    meaningful(entry.split(/[：:]/).slice(1).join(':')),
  ))
  return [...new Set(values
    .map((value) => value.replace(/[“”"'《》\s]+/g, ''))
    .filter((value) =>
      value.length >= 4
      && /(?:公司|大学|学院|研究院|实验室|研究所|中心)$/.test(value)))]
}

type ProjectPageMatch = 'exact' | 'alias' | 'none'

function projectPageMatch(
  text: string,
  project: ProjectLike,
  sources: readonly EvidenceSource[],
): ProjectPageMatch {
  const compact = text.replace(/\s+/g, '')
  if (exactProjectEntityNames(project, sources).some((name) => compact.includes(name))) {
    return 'exact'
  }
  return projectAliases(project, sources).some((alias) => compact.includes(alias))
    ? 'alias'
    : 'none'
}

function pageMatchesProject(
  text: string,
  project: ProjectLike,
  sources: readonly EvidenceSource[],
) {
  return projectPageMatch(text, project, sources) !== 'none'
}

const EXACT_ENTITY_REQUIRED_TOPICS = new Set<ProjectQaResearchTopic>([
  '项目主体与工商',
  '股权、治理与关联关系',
  '财务与现金流',
  '融资、估值与投资方',
  '交易方案与关键条款',
  '监管、诉讼与重大风险',
])

function sourceId(url: string) {
  return createHash('sha256').update(url).digest('hex')
}

function decodeSearchHtml(value: string) {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#x2f;|&#47;/gi, '/')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

function directSearchCandidates(html: string) {
  const blockedHosts = [
    'search.brave.com',
    'cdn.search.brave.com',
    'imgs.search.brave.com',
    'tiles.search.brave.com',
    'www.w3.org',
    'duckduckgo.com',
    'html.duckduckgo.com',
  ]
  const lowTrustHosts = [
    'blog.csdn.net',
    'zhuanlan.zhihu.com',
    'baike.baidu.com',
    'www.fxbaogao.com',
    'fxbaogao.com',
    'www.sohu.com',
    'sohu.com',
    'toutiao.com',
    'chejiahao.autohome.com.cn',
    'www.163.com',
    '163.com',
    'www.ulapia.com',
    'ulapia.com',
  ]
  const decoded = decodeSearchHtml(html)
  const redirectUrls = [...decoded.matchAll(/[?&]uddg=([^&"'<>\\\s]+)/gi)]
    .flatMap((match) => {
      try {
        return [decodeURIComponent(match[1])]
      } catch {
        return []
      }
    })
  const urls = [
    ...redirectUrls,
    ...(decoded.match(/https?:\/\/[^"'<>\\\s]+/gi) ?? []),
  ]
  const seen = new Set<string>()
  return urls.flatMap((value) => {
    const candidate = normalizedUrl(value.replace(/[),.;]+$/, ''))
    if (!candidate) return []
    const hostname = candidate.hostname.toLowerCase()
    if (
      blockedHosts.some((blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`))
      || lowTrustHosts.some((blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`))
      || /\.(?:png|jpe?g|gif|svg|webp|woff2?|css|js|ico|pdf)$/i.test(candidate.pathname)
    ) {
      return []
    }
    const canonical = candidate.toString()
    if (seen.has(canonical)) return []
    seen.add(canonical)
    return [canonical]
  }).slice(0, 12)
}

function publicSearchName(project: ProjectLike) {
  return normalizedAlias(project.name)
    || normalizedAlias(project.companyName)
    || meaningful(project.name)
}

async function discoverViaDirectSearch(input: {
  project: ProjectLike
  topics: readonly ProjectQaResearchTopic[]
  fetchImpl: FetchLike
  resolveHost: ResolveHost
}) {
  const projectName = publicSearchName(input.project)
  if (!projectName) return { hits: [] as ModelResearchHit[], error: '项目名称不可用于公开检索' }
  const endpoints = [
    normalizedUrl(DIRECT_SEARCH_ENDPOINT),
    normalizedUrl(DIRECT_SEARCH_FALLBACK_ENDPOINT),
  ].filter((endpoint): endpoint is URL => Boolean(endpoint))
  const safeEndpoints: URL[] = []
  for (const endpoint of endpoints) {
    if (await isSafePublicUrl(endpoint, input.resolveHost)) safeEndpoints.push(endpoint)
  }
  if (!safeEndpoints.length) {
    return { hits: [] as ModelResearchHit[], error: '公开检索入口不可用' }
  }
  const perTopic = await Promise.all(input.topics.slice(0, 8).map(async (topic) => {
    for (const endpoint of safeEndpoints) {
      try {
        const searchUrl = new URL(endpoint)
        searchUrl.searchParams.set('q', `${projectName} ${TOPIC_QUERY_TERMS[topic]}`)
        if (searchUrl.hostname === 'search.brave.com') searchUrl.searchParams.set('source', 'web')
        const response = await input.fetchImpl(searchUrl, {
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'Mozilla/5.0 (compatible; Cybernaut-QA/1.0)',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(DIRECT_SEARCH_TIMEOUT_MS),
        })
        if (!response.ok) continue
        const candidates = directSearchCandidates(await response.text())
        if (candidates.length) {
          return candidates.map((url) => ({
            topic,
            title: new URL(url).hostname,
            url,
            publisher: new URL(url).hostname,
            publishedAt: '',
          }))
        }
      } catch {
        // 当前入口不可用时尝试下一公开搜索入口。
      }
    }
    return [] as ModelResearchHit[]
  }))
  const interleaved: ModelResearchHit[] = []
  for (let rank = 0; rank < 12; rank += 1) {
    perTopic.forEach((values) => {
      if (values[rank]) interleaved.push(values[rank])
    })
  }
  return {
    hits: interleaved.slice(0, 48),
    error: interleaved.length ? '' : '公开检索未返回可核验候选页',
  }
}

function researchEnabled(parameters?: Record<string, unknown>) {
  if (parameters?.networkSupplement === false) return false
  if (process.env.AI_QA_DISABLE_MODEL_RESEARCH === '1') return false
  return process.env.AI_QA_MODEL_RESEARCH_ENABLED?.toLowerCase() !== 'false'
}

function topicFromCandidate(
  source: EvidenceSource,
  requestedTopics: readonly ProjectQaResearchTopic[],
) {
  const text = `${source.sourceName}\n${source.content}`
  return requestedTopics
    .map((topic, index) => ({
      topic,
      index,
      hits: TOPIC_SIGNALS[topic].filter((signal) => text.includes(signal)).length,
    }))
    .sort((left, right) => right.hits - left.hits || left.index - right.index)[0]?.topic
    ?? requestedTopics[0]
}

function candidateHits(
  sources: readonly EvidenceSource[],
  requestedTopics: readonly ProjectQaResearchTopic[],
): ModelResearchHit[] {
  if (requestedTopics.length === 0) return []
  return sources.flatMap((source) => {
    const url = meaningful(source.locator)
      || source.content.match(/来源网址[：:]\s*(https?:\/\/\S+)/i)?.[1]
      || ''
    if (!url) return []
    const topic = topicFromCandidate(source, requestedTopics)
    return [{
      topic,
      title: source.content.match(/页面标题[：:]\s*([^\n]+)/i)?.[1]
        || source.sourceName,
      url,
      publisher: source.content.match(/发布主体[：:]\s*([^\n]+)/i)?.[1],
      publishedAt: source.versionOrDate,
    }]
  })
}

export function projectQaResearchTopicsForSources(
  sources: readonly EvidenceSource[],
  maxTopics = 8,
): ProjectQaResearchTopic[] {
  const text = sources.map((source) => source.content).join('\n').toLowerCase()
  return [...PROJECT_QA_RESEARCH_TOPICS]
    .map((topic, index) => ({
      topic,
      index,
      evidenceHits: TOPIC_SIGNALS[topic]
        .filter((signal) => text.includes(signal.toLowerCase()))
        .length,
    }))
    .sort((left, right) => left.evidenceHits - right.evidenceHits || left.index - right.index)
    .slice(0, Math.max(1, Math.min(maxTopics, PROJECT_QA_RESEARCH_TOPICS.length)))
    .map((item) => item.topic)
}

export async function fetchProjectQaModelEvidence(input: {
  project: ProjectLike
  currentSources: EvidenceSource[]
  candidateSources?: EvidenceSource[]
  sourceCutoffDate: string
  parameters?: Record<string, unknown>
  requestedTopics?: ProjectQaResearchTopic[]
  fetchImpl?: FetchLike
  resolveHost?: ResolveHost
  now?: Date
  maxSources?: number
}): Promise<ProjectQaModelResearchResult> {
  const enabled = researchEnabled(input.parameters)
  const now = input.now ?? new Date()
  const accessedAt = now.toISOString()
  const requestedTopics = input.requestedTopics
    ?? projectQaResearchTopicsForSources(input.currentSources)
  const auditBase = {
    enabled,
    provider: 'project_llm' as const,
    model: MODEL,
    accessedAt,
    requestedTopics,
  }
  if (!enabled || requestedTopics.length === 0) {
    return {
      sources: [],
      audit: {
        ...auditBase,
        status: 'disabled',
        discovery: 'none',
        agentCandidateCount: 0,
        proposedSourceCount: 0,
        verifiedSourceCount: 0,
        rejectedSourceCount: 0,
      },
    }
  }

  const fetchImpl = input.fetchImpl ?? fetch
  const resolveHost = input.resolveHost ?? defaultResolveHost
  const nativeModelSearchEnabled = input.parameters?.nativeModelSearch === true
    || NATIVE_MODEL_SEARCH_ENABLED
  const agentHits = candidateHits(input.candidateSources ?? [], requestedTopics)
  let modelHits: ModelResearchHit[] = []
  let modelFailureReason = ''
  if (nativeModelSearchEnabled) {
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
            content: `你是投资中台资深投资经理的联网证据检索执行器。必须使用当前模型真实可用的联网或搜索能力，围绕当前会话绑定项目查找公开网页；不得使用训练记忆编造事实、网址、人物、融资或客户。只返回JSON：{"results":[{"topic":"","title":"","url":"","publisher":"","publishedAt":"YYYY-MM-DD或空字符串"}]}。topic只能来自用户给出的检索主题。每条必须是可直接访问的http/https原始页面，不得返回搜索结果页、聚合摘要页或无来源转载。没有可靠结果时返回空数组。`,
          },
          {
            role: 'user',
            content: `围绕同一具体项目补全可改变当前阶段判断或下一步建议的证据，不写泛行业研究。
项目公开名称：${publicSearchName(input.project)}
检索主题：${requestedTopics.join('、')}
资料截止日：${input.sourceCutoffDate}

不得把项目资料库内容写进搜索词。优先级：政府/监管/司法/登记机关、专利与论文原始页面、公司或研发合作机构官网、投资机构公告、客户或合作方公告、可信专业媒体。重点寻找具体主体、股权与治理、人物及履历、产品和技术指标、知识产权、样机/中试/量产、客户试点/订单/验收/回款、连续财务数据、融资轮次/金额/投资方/估值、交易事项及重大风险。必须区分公司自述、媒体转述和已经完成的可核验事件；融资意向、股东借款、资产出售和正式股权融资不得混写。竞品只返回明确提及当前项目并能形成项目级比较的页面。不得返回资料截止日之后发布或更新的页面。最多返回16条。`,
          },
        ],
        max_tokens: 4500,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(MODEL_RESEARCH_TIMEOUT_MS),
    })
      if (!response.ok) throw new Error(`LLM ${response.status}`)
      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const parsed = parseModelJson(data.choices?.[0]?.message?.content ?? '')
      modelHits = Array.isArray(parsed.results) ? parsed.results.slice(0, 24) : []
    } catch (error) {
      modelFailureReason = `原生模型搜索不可用：${(error as Error).message}`
    }
  }
  const directSearch = await discoverViaDirectSearch({
    project: input.project,
    topics: requestedTopics,
    fetchImpl,
    resolveHost,
  })
  const hits = [...agentHits, ...modelHits, ...directSearch.hits].filter((hit, index, values) => {
    const url = meaningful(hit.url)
    return url && values.findIndex((candidate) => meaningful(candidate.url) === url) === index
  })
  const discovery = agentHits.length && modelHits.length && directSearch.hits.length
    ? 'agent_model_and_direct_search' as const
    : agentHits.length && modelHits.length
      ? 'agent_and_model' as const
      : agentHits.length && directSearch.hits.length
        ? 'agent_and_direct_search' as const
        : modelHits.length && directSearch.hits.length
          ? 'model_and_direct_search' as const
          : agentHits.length
            ? 'agent_search' as const
            : modelHits.length
              ? 'model' as const
              : directSearch.hits.length
                ? 'direct_search' as const
                : 'none' as const

  const maxSources = Math.max(1, Math.min(input.maxSources ?? 16, 24))
  const sources: EvidenceSource[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    if (sources.length >= maxSources) break
    const topic = meaningful(hit.topic) as ProjectQaResearchTopic
    if (!requestedTopics.includes(topic)) continue
    const proposedUrl = normalizedUrl(hit.url)
    if (!proposedUrl || !(await isSafePublicUrl(proposedUrl, resolveHost))) continue
    try {
      const response = await fetchImpl(proposedUrl, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
          'User-Agent': 'Cybernaut-QA-Model-Research/1.0',
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
      const text = extractProjectQaPublicPageText(html)
      const matchLevel = projectPageMatch(text, input.project, input.currentSources)
      if (
        text.length < 160
        || !pageMatchesProject(text, input.project, input.currentSources)
        || (matchLevel !== 'exact' && EXACT_ENTITY_REQUIRED_TOPICS.has(topic))
      ) {
        continue
      }
      const publishedAt = normalizedDate(hit.publishedAt) || publishedDateFromHtml(html)
      if (publishedAt && publishedAt > input.sourceCutoffDate) continue
      const title = htmlTitle(html) || meaningful(hit.title) || finalUrl.hostname
      const publisher = meaningful(hit.publisher) || finalUrl.hostname
      const contentHash = createHash('sha256').update(text).digest('hex')
      seen.add(canonicalUrl)
      sources.push({
        sourceType: 'public_web_llm',
        sourceId: sourceId(canonicalUrl),
        sourceName: `项目联网核验·${topic}·${title}`.slice(0, 255),
        chunkIndex: sources.length,
        versionOrDate: publishedAt || `发布日期待核验；访问${accessedAt.slice(0, 10)}`,
        locator: canonicalUrl,
        content: [
          '证据属性：系统联网发现并直接读取页面，已核验页面与当前项目名称匹配；公开披露由项目大模型总结归纳，仍需与项目原件交叉核验。',
          matchLevel === 'exact'
            ? '项目匹配：项目法律名称或完整主体名称一致。'
            : '项目匹配：仅项目简称或近名一致；不得据此确认当前项目的工商、股权、财务或融资事实。',
          `Q&A 分类：${topic}`,
          `页面标题：${title}`,
          `发布主体：${publisher}`,
          publishedAt
            ? `发布日期：${publishedAt}`
            : '发布日期待核验，不得据此认定资料截止日前已经公开。',
          `访问日期：${accessedAt.slice(0, 10)}`,
          `页面正文摘录：${text.slice(0, 5000)}`,
          `内容指纹：${contentHash}`,
          `项目大模型：${MODEL}`,
        ].join('\n'),
      })
    } catch {
      // 单条来源不可访问、超时或无法核验时丢弃，不影响其余来源。
    }
  }

  const rejectedSourceCount = Math.max(0, hits.length - sources.length)
  const discoveryFailureReason = [modelFailureReason, directSearch.error].filter(Boolean).join('；')
  return {
    sources,
    audit: {
      ...auditBase,
      status: sources.length === 0
        ? discovery === 'none' ? 'unavailable' : 'no_results'
        : rejectedSourceCount > 0
          ? 'partial'
          : 'succeeded',
      discovery,
      agentCandidateCount: agentHits.length,
      proposedSourceCount: hits.length,
      verifiedSourceCount: sources.length,
      rejectedSourceCount,
      ...(sources.length === 0 && discoveryFailureReason
        ? { failureReason: discoveryFailureReason }
        : {}),
    },
  }
}

// 通用快捷任务复用 Q&A 已验收的联网证据链。保留旧导出以兼容现有 Q&A 调用方。
export const fetchVerifiedProjectWebEvidence = fetchProjectQaModelEvidence
export const projectWebResearchTopicsForSources = projectQaResearchTopicsForSources
