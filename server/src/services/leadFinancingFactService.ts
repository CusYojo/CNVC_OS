import { createHash } from 'node:crypto'

export const LEAD_FINANCING_EXTRACTOR_VERSION = 'lead-financing-facts-v1' as const

export type LeadFinancingEvidenceStatus = 'source_labeled' | 'source_supported' | 'conflicting'

export interface LeadFinancingFact {
  idempotencyKey: string
  roundRaw: string
  round: string
  amountRaw: string
  amount: string
  currency: 'CNY' | 'USD' | ''
  investors: string[]
  leadInvestors: string[]
  date: string
  valuation: string
  sourceUrl: string
  evidenceQuote: string
  evidenceStatus: LeadFinancingEvidenceStatus
  extractionMethod: 'deterministic_rule'
  extractorVersion: typeof LEAD_FINANCING_EXTRACTOR_VERSION
}

export interface LeadFinancingExtractionResult {
  status: 'succeeded' | 'no_candidate' | 'failed'
  facts: LeadFinancingFact[]
  extractorVersion: typeof LEAD_FINANCING_EXTRACTOR_VERSION
  error?: string
}

const ROUND_PATTERN = /(?:Pre\s*[-－—]?\s*(?:IPO|[A-C])(?:\s*\+{1,2})?|[A-F](?:\d|\+{1,2})?|天使(?:\+{1,2})?|种子(?:\+{1,2})?|战略融资|战略投资|股权融资|风险投资|首轮|新一轮)/i
const RAW_ROUND_PATTERN = /(?:Pre\s*[-－—]?\s*(?:IPO|[A-C])(?:\s*[+＋]){0,2}|[A-F](?:\d|(?:\s*[+＋]){1,2})?|天使(?:\s*[+＋]){0,2}|种子(?:\s*[+＋]){0,2}|战略融资|战略投资|股权融资|风险投资|首轮|新一轮)\s*轮?/i
const COMPLETED_FINANCING = /(?:完成|完成了|已完成|宣布完成|正式完成|获得|获|融得|成功募集).{0,64}?(?:轮)?融资/
const PLANNED_FINANCING = /(?:拟|计划|寻求|启动|目标|意向|预计).{0,32}?(?:轮)?融资|融资目标|募资目标/
const NON_FINANCING_AMOUNT = /(?:估值|市值|市场规模|市场空间|合同金额|订单金额|销售额|营收|注册资本|总投资|产值)/
const FINANCING_AMOUNT = /(?:融资金额|融资规模|融资总额|单笔金额|融得|募集|融资).{0,10}$/
const INVALID_INVESTOR = /^(?:本轮|本轮融资|融资|融资由|经纬观点|投资方|领投方|未披露|待核验|轮融资)$/

function compact(value: unknown) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/[\t\r ]+/g, ' ').trim() : ''
}

function evidenceText(value: unknown) {
  return typeof value === 'string' ? value.replace(/[\t\r ]+/g, ' ').trim() : ''
}

/** Normalize typography used by deterministic extraction without destroying sentence boundaries. */
export function normalizeFinancingText(value: unknown) {
  return compact(value)
    .replace(/[－—–]/g, '-')
    .replace(/\s*\+\s*/g, '+')
    .replace(/\s*轮\s*(?=融资|投资)/g, '轮')
    .replace(/Pre\s*-\s*/gi, 'Pre-')
}

export function normalizeFinancingRound(value: unknown) {
  const normalized = normalizeFinancingText(value)
  const raw = normalized.match(ROUND_PATTERN)?.[0]?.replace(/\s+/g, '') || ''
  if (!raw) return ''
  if (/^pre-?ipo$/i.test(raw)) return 'Pre-IPO'
  if (/^pre-?[a-c](?:\+{1,2})?$/i.test(raw)) {
    const stage = raw.replace(/^pre-?/i, '').toUpperCase()
    return `Pre-${stage}轮`
  }
  if (/^[a-f](?:\d|\+{1,2})?$/i.test(raw)) return `${raw.toUpperCase()}轮`
  if (/^(?:天使|种子)(?:\+{1,2})?$/.test(raw)) return `${raw}轮`
  if (raw === '首轮' || raw === '新一轮') return raw
  return raw
}

function sentences(value: string) {
  return value.match(/[^。！？!?\n]+[。！？!?]?/g)?.map((item) => item.trim()).filter(Boolean) ?? []
}

function amountCandidates(sentence: string) {
  const regex = /(?:(?:人民币|RMB|CNY|美元|USD|美金|[¥￥$])\s*\d+(?:\.\d+)?\s*(?:千万|百万|万|亿)?\s*元?|\d+(?:\.\d+)?\s*(?:千万|百万|万|亿)?\s*(?:元人民币|人民币|美元|美金|元))/gi
  const result: Array<{ raw: string; amount: string; currency: 'CNY' | 'USD'; score: number }> = []
  for (const match of sentence.matchAll(regex)) {
    const raw = match[0].trim()
    const index = match.index ?? 0
    const before = sentence.slice(Math.max(0, index - 24), index)
    const around = sentence.slice(Math.max(0, index - 16), Math.min(sentence.length, index + raw.length + 12))
    let score = 10
    if (FINANCING_AMOUNT.test(before)) score += 50
    if (/融资/.test(around)) score += 15
    if (NON_FINANCING_AMOUNT.test(before.slice(-12)) || NON_FINANCING_AMOUNT.test(around)) score -= 80
    const currency = /美元|USD|美金|\$/i.test(raw) ? 'USD' as const : 'CNY' as const
    const numeric = raw.normalize('NFKC')
      .replace(/人民币|RMB|CNY|美元|USD|美金|[¥￥$]/gi, '')
      .replace(/\s+/g, '')
      .replace(/元$/, '')
    const amount = currency === 'USD' ? `${numeric}美元` : `${numeric}元人民币`
    result.push({ raw, amount, currency, score })
  }
  return result.sort((left, right) => right.score - left.score)
}

function cleanInvestors(value: string) {
  return value
    .replace(/^(?:本轮(?:融资)?由|融资由|由)/, '')
    .replace(/(?:共同|联合)?(?:领投|参投|跟投|追加投资).*$/, '')
    .split(/[、,，；;]|以及|及(?=[\u4e00-\u9fa5A-Za-z])/)
    .map((item) => item.replace(/^(?:并由|并|和|与)/, '').trim())
    .filter((item) => item.length >= 2 && item.length <= 64 && !INVALID_INVESTOR.test(item))
}

function investorsFrom(sentence: string) {
  const leadInvestors: string[] = []
  const investors: string[] = []
  for (const match of sentence.matchAll(/由\s*([^，。；;]{2,100}?)\s*(?:共同|联合)?领投/g)) {
    leadInvestors.push(...cleanInvestors(match[1]))
  }
  for (const match of sentence.matchAll(/(?:，|,|、|；|;)\s*([^，。；;]{2,100}?)\s*(?:参投|跟投|追加投资)/g)) {
    investors.push(...cleanInvestors(match[1]))
  }
  return {
    leadInvestors: [...new Set(leadInvestors)],
    investors: [...new Set([...leadInvestors, ...investors])],
  }
}

function eventDate(sentence: string, fallback: string) {
  const match = sentence.match(/((?:19|20)\d{2})年(?:([01]?\d)月)?(?:([0-3]?\d)日)?/)
  if (!match) return fallback
  const month = match[2] ? `-${match[2].padStart(2, '0')}` : ''
  const day = match[3] ? `-${match[3].padStart(2, '0')}` : ''
  return `${match[1]}${month}${day}`
}

function factKey(input: Pick<LeadFinancingFact, 'round' | 'amount' | 'date' | 'sourceUrl' | 'evidenceQuote'>) {
  return createHash('sha256').update([
    input.round,
    input.amount,
    input.date,
    input.sourceUrl.replace(/[?#].*$/, ''),
    normalizeFinancingText(input.evidenceQuote),
  ].join('|')).digest('hex')
}

/**
 * Extract only completed financing events. Planned fundraising, valuations, market sizes,
 * orders and contracts intentionally remain outside this fact projection.
 */
export function extractLeadFinancingFacts(input: {
  text?: unknown
  sourceUrl?: unknown
  publishedAt?: unknown
}): LeadFinancingFact[] {
  const original = evidenceText(input.text).slice(0, 100_000)
  if (!original) return []
  const sourceUrl = compact(input.sourceUrl)
  const publishedAt = compact(input.publishedAt)
  const facts: LeadFinancingFact[] = []
  for (const evidenceQuote of sentences(original)) {
    const normalized = normalizeFinancingText(evidenceQuote)
    if (!COMPLETED_FINANCING.test(normalized) || PLANNED_FINANCING.test(normalized)) continue
    const roundMatch = normalized.match(new RegExp(`${ROUND_PATTERN.source}\\s*(?:轮)?(?=融资)`, 'i'))?.[0] || ''
    const round = normalizeFinancingRound(roundMatch)
    const amounts = amountCandidates(normalized)
    const selectedAmount = amounts.find((item) => item.score > 0)
    const { investors, leadInvestors } = investorsFrom(normalized)
    const draft: LeadFinancingFact = {
      idempotencyKey: '',
      roundRaw: evidenceQuote.match(RAW_ROUND_PATTERN)?.[0]?.trim() || roundMatch,
      round: round || '待核验',
      amountRaw: selectedAmount?.raw || '',
      amount: selectedAmount?.amount || '未披露',
      currency: selectedAmount?.currency || '',
      investors,
      leadInvestors,
      date: eventDate(normalized, publishedAt),
      valuation: '未披露',
      sourceUrl,
      evidenceQuote,
      evidenceStatus: 'source_labeled',
      extractionMethod: 'deterministic_rule',
      extractorVersion: LEAD_FINANCING_EXTRACTOR_VERSION,
    }
    draft.idempotencyKey = factKey(draft)
    facts.push(draft)
  }
  return [...new Map(facts.map((fact) => [fact.idempotencyKey, fact])).values()]
}

/** Keep document-fetch state and fact-extraction state independently observable. */
export function extractLeadFinancingFactsWithStatus(input: {
  text?: unknown
  sourceUrl?: unknown
  publishedAt?: unknown
}): LeadFinancingExtractionResult {
  try {
    const facts = extractLeadFinancingFacts(input)
    return {
      status: facts.length ? 'succeeded' : 'no_candidate',
      facts,
      extractorVersion: LEAD_FINANCING_EXTRACTOR_VERSION,
    }
  } catch (error) {
    return {
      status: 'failed',
      facts: [],
      extractorVersion: LEAD_FINANCING_EXTRACTOR_VERSION,
      error: error instanceof Error ? error.message.slice(0, 500) : 'unknown extraction failure',
    }
  }
}

export function financingEvidenceLabel(status: LeadFinancingEvidenceStatus | unknown) {
  if (status === 'source_supported') return '多源已核验'
  if (status === 'conflicting') return '存在冲突'
  return '原文已标注，待交叉核验'
}
