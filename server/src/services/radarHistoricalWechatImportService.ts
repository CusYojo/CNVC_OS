import { createHash } from 'node:crypto'

type JsonObject = Record<string, unknown>

const PROJECT_TERMS = ['人工智能', 'AI', '大模型', '机器人', '芯片', '半导体', '医药', '医疗', '材料', '新能源', '产品', '技术', '专利', '量产']
const INVESTMENT_TERMS = ['融资', '投资', '天使轮', '种子轮', 'Pre-A', 'A轮', 'B轮', 'C轮', '估值', '并购', '商业化', '产业化', '成果转化', '订单', '中标']
const ACADEMIC_ACCOUNT_RE = /大学|学院|研究院|研究所|实验室|课题组|清华|北大|交大|浙大|复旦/

function clean(value: unknown): string {
  return String(value ?? '').replace(/[\u200b-\u200f\ufeff]/g, '').replace(/\s+/g, ' ').trim()
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

function sourceBiz(link: string): string {
  try { return new URL(link).searchParams.get('__biz')?.trim() ?? '' } catch { return '' }
}

function candidateScore(text: string) {
  const normalized = text.toLowerCase()
  const projectHits = PROJECT_TERMS.filter((term) => normalized.includes(term.toLowerCase()))
  const investmentHits = INVESTMENT_TERMS.filter((term) => normalized.includes(term.toLowerCase()))
  const score = Math.min(100, 20 + projectHits.length * 4 + investmentHits.length * 8)
  const worthAttention = investmentHits.length > 0 || projectHits.length >= 2
  return {
    score,
    worthAttention,
    signals: [
      ...projectHits.slice(0, 8).map((term) => ({ code: 'technology_keyword', score: 4, detail: term })),
      ...investmentHits.slice(0, 8).map((term) => ({ code: 'investment_keyword', score: 8, detail: term })),
    ],
  }
}

export function historicalWechatCandidate(record: unknown): JsonObject | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  const raw = record as JsonObject
  const title = clean(raw.title)
  const link = clean(raw.url || raw.link)
  const sourceId = clean(raw.id) || md5(link || title)
  if (!title || !sourceId) return null
  const summary = clean(raw.summary)
  const articleText = clean(raw.content_text || raw.article_text).slice(0, 50_000)
  const accountName = clean(raw.account_name || raw.account)
  const accountId = clean(raw.account_id)
  const accountBiz = sourceBiz(link)
  const sourceGroup = ACADEMIC_ACCOUNT_RE.test(accountName) ? '高校公众号' : '机构公众号'
  const scored = candidateScore([title, summary, articleText].filter(Boolean).join('\n'))
  return {
    source: 'wechat_api',
    source_id: sourceId,
    fingerprint: md5(sourceId).slice(0, 16),
    title,
    summary: summary || articleText.slice(0, 300),
    article_text: articleText,
    article_text_length: articleText.length,
    article_fetch_status: 'historical_import',
    source_name: accountName,
    source_group: sourceGroup,
    source_key: accountId || accountBiz || accountName,
    source_type: 'historical_qingbo_wechat',
    account_name: accountName,
    wx_name: accountId,
    account_biz: accountBiz,
    news_author: clean(raw.author),
    categories: [sourceGroup, accountName, clean(raw.sector)].filter(Boolean),
    published_at: clean(raw.published_at),
    link,
    keywords: clean(raw.keywords),
    project_name: clean(raw.project),
    research_direction: clean(raw.research_direction),
    technology: raw.technology,
    product: raw.product,
    core_members: raw.core_members,
    attention_score: scored.score,
    worth_attention: scored.worthAttention,
    signals: scored.signals,
    decision: scored.worthAttention ? 'watchlist' : 'filter',
    decision_label: scored.worthAttention ? '保留观察' : '过滤',
    filter_reasons: scored.worthAttention ? [] : ['缺少明确的项目或投资信号'],
    collected_at: clean(raw.collected_at) || new Date().toISOString(),
    import_provenance: 'offline_historical_wechat_json',
  }
}

export function prepareHistoricalWechatImport(records: unknown) {
  if (!Array.isArray(records)) throw new Error('历史公众号输入必须是 JSON 数组')
  const valid = records.map(historicalWechatCandidate).filter((item): item is JsonObject => Boolean(item))
  const retained = valid.filter((item) => item.worth_attention === true)
  const deduped = new Map<string, JsonObject>()
  for (const item of retained) deduped.set(`${clean(item.source)}:${clean(item.source_id)}`, item)
  return {
    input: records.length,
    mapped: valid.length,
    retained: retained.length,
    filtered: valid.length - retained.length,
    duplicatesInInput: retained.length - deduped.size,
    rows: [...deduped.values()],
  }
}
