import { createHash } from 'node:crypto'

export const LEAD_ENRICHMENT_SCHEMA_VERSION = 'lead-enrichment-v8-web-hit' as const
export const LEAD_ENRICHMENT_TOPIC_KEYS = [
  'basic_profile',
  'financing',
  'ownership',
  'team',
  'customers_contracts',
  'financial_operations',
  'products',
  'technology_ip',
  'industrialization',
  'competition',
  'latest_developments',
  'market_policy',
  'transaction_exit',
] as const

export type LeadEnrichmentTopicKey = typeof LEAD_ENRICHMENT_TOPIC_KEYS[number]

// The shared-lead list and detail page consume these investment-profile topics.
// Keep the complete topic enum for stored snapshots and historical rows, but do
// not spend network/model budget on fields that the current product does not use.
export const LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS = [
  'basic_profile',
  'financing',
  'ownership',
  'team',
  'products',
  'latest_developments',
] as const satisfies readonly LeadEnrichmentTopicKey[]

const LEAD_DETAIL_ENRICHMENT_TOPICS = new Set<LeadEnrichmentTopicKey>(LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS)

export function leadDetailEnrichmentTopicApplies(input: {
  topicKey: LeadEnrichmentTopicKey
  entityType: LeadEntityType
}) {
  if (!LEAD_DETAIL_ENRICHMENT_TOPICS.has(input.topicKey)) return false
  // Research-only subjects expose technical and academic evidence, but cannot be
  // presented as a financed company, commercial customer or transaction target.
  if (input.entityType === 'research' && new Set<LeadEnrichmentTopicKey>([
    'financing', 'ownership', 'customers_contracts', 'competition', 'transaction_exit',
  ]).has(input.topicKey)) return false
  return true
}

export const LEAD_DEEP_ENRICHMENT_FORBIDDEN_FACT_KEY_PATTERNS = [
  /^ownership\.(?:snapshot_date|shareholder_type|beneficial_owner)$/,
  /^financing\.(?:investors|lead_investor|investor_role)$/,
  /^team\.(?:institution_period|full_time_status|institution_relation|historical_employment)$/,
  /^product\.(?:parameter|performance|use_case|matrix)$/,
  /^customer\./,
  /^contract\./,
  /^order\./,
  /^delivery\./,
  /^cash_collection\./,
  /^financial\./,
  /^market\./,
  /^policy\./,
  /^technology\./,
  /^competition\./,
  /^transaction\./,
  /^patent\./,
  /^qualification\./,
  /^certification\./,
  /^production\./,
  /^supply_chain$/,
  /^research\.(?:trl|reproducibility|validation|spin_off)$/,
  /^license\./,
  /^ip\.owner$/,
] as const

export function leadDeepEnrichmentFactKeyAllowed(factKey: unknown) {
  const normalized = typeof factKey === 'string' ? factKey.normalize('NFKC').trim() : ''
  return Boolean(normalized)
    && !LEAD_DEEP_ENRICHMENT_FORBIDDEN_FACT_KEY_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function curateLeadResearchMetadata(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).filter(([key]) => key !== 'rights'),
  )
}

export const LEAD_ENTITY_CONFIRMATION_REQUIRED_TOPICS = new Set<LeadEnrichmentTopicKey>([
  'financing', 'ownership', 'customers_contracts', 'financial_operations',
  'technology_ip', 'industrialization', 'transaction_exit',
])

export function topicRequiresConfirmedEntity(topicKey: LeadEnrichmentTopicKey) {
  return LEAD_ENTITY_CONFIRMATION_REQUIRED_TOPICS.has(topicKey)
}

export function leadEnrichmentRuntimePolicy(
  env: Record<string, string | undefined> = process.env,
) {
  return {
    workerEnabled: env.LEAD_ENRICHMENT_ENABLED !== 'false',
    acceptNewJobs: env.LEAD_ENRICHMENT_ACCEPT_NEW_JOBS !== 'false',
  }
}

export function leadResearchWebEnrichmentEnabled(input: {
  jobCreatedAt: string | Date
  env?: Record<string, string | undefined>
}) {
  const env = input.env ?? process.env
  if (String(env.LEAD_RESEARCH_WEB_ENRICHMENT_ENABLED ?? '').trim().toLowerCase() !== 'true') return false
  const cutoffText = String(env.LEAD_RESEARCH_WEB_ENRICHMENT_AFTER ?? '').trim()
  if (!cutoffText) return true
  const cutoff = Date.parse(cutoffText)
  const createdAt = new Date(input.jobCreatedAt).getTime()
  return Number.isFinite(cutoff) && Number.isFinite(createdAt) && createdAt >= cutoff
}
export type LeadEnrichmentTopicStatus =
  | 'queued'
  | 'running'
  | 'resolving_entity'
  | 'planning'
  | 'searching'
  | 'fetching'
  | 'extracting'
  | 'validating'
  | 'retrying'
  | 'completed'
  | 'partial'
  | 'missing'
  | 'not_applicable'
  | 'review'
  | 'failed'
  | 'dead_letter'

export const LEAD_ENRICHMENT_TERMINAL_TOPIC_STATUSES = new Set<LeadEnrichmentTopicStatus>([
  'completed', 'partial', 'missing', 'not_applicable', 'review', 'failed', 'dead_letter',
])

export type LeadEntityType = 'company' | 'project' | 'team' | 'research' | 'unknown'
export type LeadEntityStatus = 'confirmed' | 'claimed' | 'inferred' | 'ambiguous' | 'missing'
export type LeadEvidenceLevel = 'E1' | 'E2' | 'E3'
export type LeadFactVerificationStatus =
  | 'verified'
  | 'unverified'
  | 'missing'
  | 'not_applicable'
  | 'conflicted'
  | 'rejected'

export type PaperProvider = 'arxiv' | 'openalex' | 'crossref' | 'publisher' | 'repository' | 'unknown'
export type PaperContentType =
  | 'landing_page'
  | 'full_text_html'
  | 'paper_pdf'
  | 'dataset'
  | 'code_repository'
  | 'model_artifact'
  | 'supplement'
  | 'unknown'

export type NormalizedPaperIdentity = {
  provider: PaperProvider
  canonicalId: string
  arxivId: string
  openAlexId: string
  doi: string
  version: string
  landingPageUrl: string
  fullTextUrl: string
  pdfUrl: string
  sourceStatus: 'confirmed' | 'review'
  reviewReasons: string[]
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : ''
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))]
}

function arxivIdFrom(values: string[]): string {
  for (const value of values) {
    const match = value.match(/(?:arxiv(?:\.org)?[:/\s]*)?(\d{4}\.\d{4,5})(v\d+)?/i)
    if (match) return `${match[1]}${match[2] || ''}`
  }
  return ''
}

function openAlexIdFrom(values: string[]): string {
  for (const value of values) {
    const match = value.match(/(?:openalex\.org\/)?(W\d{5,})\b/i)
    if (match) return match[1].toUpperCase()
  }
  return ''
}

function doiFrom(values: string[]): string {
  for (const value of values) {
    const match = value.match(/\b(10\.\d{4,9}\/[\w.()/:;-]+?)(?=[\s?#]|$)/i)
    if (match) return match[1].replace(/[),.;]+$/, '').toLowerCase()
  }
  return ''
}

function versionFromArxivId(arxivId: string): string {
  return arxivId.match(/(v\d+)$/i)?.[1]?.toLowerCase() || ''
}

export function classifyPaperContent(input: { url?: unknown; mimeType?: unknown; label?: unknown }): PaperContentType {
  const url = text(input.url).toLowerCase()
  const mime = text(input.mimeType).toLowerCase()
  const label = text(input.label).toLowerCase()
  const combined = `${url} ${mime} ${label}`
  if (/github\.com|gitlab\.com|bitbucket\.org|\b(source\s*code|代码仓库|code repository)\b/.test(combined)) return 'code_repository'
  if (/huggingface\.co\/(?:datasets|spaces)|kaggle\.com\/datasets|\b(dataset|数据集)\b/.test(combined)) return 'dataset'
  if (/huggingface\.co\/(?!datasets|spaces)|\b(model weights?|模型权重)\b/.test(combined)) return 'model_artifact'
  if (/\.(?:xlsx?|csv|zip|tar|gz|7z|rar|png|jpe?g|webp)(?:[?#]|$)/.test(url)
    || /supp(?:lement|orting|l?\b)|附件|补充材料/.test(combined)) return 'supplement'
  if (/application\/pdf/.test(mime) || /\.pdf(?:[?#]|$)|arxiv\.org\/pdf\//.test(url)) return 'paper_pdf'
  if (/arxiv\.org\/html\/|\b(full\s*text|正文|html)\b/.test(combined)) return 'full_text_html'
  if (/^https?:\/\//.test(url)) return 'landing_page'
  return 'unknown'
}

export function normalizePaperIdentity(input: {
  provider?: unknown
  sourceName?: unknown
  sourceId?: unknown
  arxivId?: unknown
  openAlexId?: unknown
  doi?: unknown
  landingPageUrl?: unknown
  fullTextUrl?: unknown
  pdfUrl?: unknown
  link?: unknown
}): NormalizedPaperIdentity {
  const values = unique([
    text(input.sourceId), text(input.arxivId), text(input.openAlexId), text(input.doi),
    text(input.landingPageUrl), text(input.fullTextUrl), text(input.pdfUrl), text(input.link),
  ])
  const arxivId = arxivIdFrom(values)
  const openAlexId = openAlexIdFrom(values)
  const doi = doiFrom(values)
  const declaredProvider = text(input.provider || input.sourceName).toLowerCase()
  let provider: PaperProvider = 'unknown'
  if (openAlexId || /openalex/.test(declaredProvider)) provider = 'openalex'
  else if (arxivId || /arxiv/.test(declaredProvider)) provider = 'arxiv'
  else if (/crossref/.test(declaredProvider)) provider = 'crossref'
  else if (/repository|zenodo|datacite|仓储/.test(declaredProvider)) provider = 'repository'
  else if (doi || /publisher|出版社/.test(declaredProvider)) provider = 'publisher'

  const reviewReasons: string[] = []
  if (provider === 'openalex' && !openAlexId) reviewReasons.push('OpenAlex来源缺少规范Work ID')
  if (provider === 'arxiv' && !arxivId) reviewReasons.push('arXiv来源缺少规范arXiv ID')
  if (openAlexId && /arxiv/.test(declaredProvider)) reviewReasons.push('OpenAlex Work被错误标记为arXiv')
  if (arxivId && /openalex/.test(declaredProvider)) reviewReasons.push('arXiv论文被错误标记为OpenAlex')
  if (provider === 'unknown') reviewReasons.push('无法确认论文来源provider')

  const landingPageUrl = text(input.landingPageUrl || input.link)
  const fullTextUrl = text(input.fullTextUrl)
  const pdfUrl = text(input.pdfUrl)
  if (landingPageUrl && classifyPaperContent({ url: landingPageUrl }) === 'supplement') {
    reviewReasons.push('落地链接指向补充材料而非论文页面')
  }
  if (pdfUrl && classifyPaperContent({ url: pdfUrl }) !== 'paper_pdf') {
    reviewReasons.push('PDF链接内容类型不是论文PDF')
  }
  const canonicalId = provider === 'arxiv' ? arxivId
    : provider === 'openalex' ? openAlexId
      : doi
  return {
    provider,
    canonicalId,
    arxivId,
    openAlexId,
    doi,
    version: versionFromArxivId(arxivId),
    landingPageUrl,
    fullTextUrl,
    pdfUrl,
    sourceStatus: reviewReasons.length ? 'review' : 'confirmed',
    reviewReasons,
  }
}

export function normalizePaperPublicationDate(input: {
  declaredPublishedAt?: unknown
  recordCreatedAt?: unknown
  now?: Date
}) {
  const declared = text(input.declaredPublishedAt).match(/^\d{4}-\d{2}-\d{2}/)?.[0] || ''
  const created = text(input.recordCreatedAt).match(/^\d{4}-\d{2}-\d{2}/)?.[0] || ''
  const now = input.now ?? new Date()
  const declaredTime = declared ? Date.parse(`${declared}T23:59:59Z`) : Number.NaN
  const future = Number.isFinite(declaredTime) && declaredTime > now.getTime()
  return {
    publishedAt: future ? created : declared || created,
    declaredPublishedAt: declared,
    status: future || (!declared && !created) ? 'review' as const : 'confirmed' as const,
    basis: future || !declared ? 'metadata_record_created_at' as const : 'publisher_published_at' as const,
    reviewReasons: future ? ['来源声明的发布日期位于未来'] : (!declared && !created ? ['缺少可解析发布日期'] : []),
  }
}

export function initialTopicStates(input: {
  entityType: LeadEntityType
  hasCommercialCompany?: boolean
}): Record<LeadEnrichmentTopicKey, LeadEnrichmentTopicStatus> {
  const states = Object.fromEntries(LEAD_ENRICHMENT_TOPIC_KEYS.map((topicKey) => [
    topicKey,
    leadDetailEnrichmentTopicApplies({ topicKey, entityType: input.entityType }) ? 'queued' : 'not_applicable',
  ])) as Record<LeadEnrichmentTopicKey, LeadEnrichmentTopicStatus>
  return states
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]))
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return value
}

export function canonicalEnrichmentJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

export function enrichmentSnapshotHash(value: unknown): string {
  return createHash('sha256').update(canonicalEnrichmentJson(value)).digest('hex')
}
