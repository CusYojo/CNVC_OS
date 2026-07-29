import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { auditLogs, leads } from '../db/schema.js'
import { resolveLeadBusinessRegion } from './leadRegion.js'

export interface PublicIntelFundingRound {
  round: string
  date: string
  amount: string
  valuation: string
  investors: string
  sourceUrl: string
}

export interface PublicIntelShareholder {
  name: string
  percentage: string
  type: string
  sourceUrl: string
}

export interface PublicIntelCompetitor {
  name: string
  positioning: string
  comparison: string
  sourceUrl: string
}

export interface PublicIntelResult {
  positioning: string
  registeredCapital: string
  legalRepresentative: string
  foundedAt: string
  region: string
  registeredAddress: string
  fundingRounds: PublicIntelFundingRound[]
  shareholders: PublicIntelShareholder[]
  competitors: PublicIntelCompetitor[]
  companyNews: Array<{ title: string; summary: string; sourceUrl: string }>
  sources: Array<{ title: string; url: string; reliability: string }>
  confidence: number
}

const PLACEHOLDERS = new Set([
  '',
  '待核验',
  '待核实',
  '未公开',
  '未披露',
  '未披露/待核实',
  '未披露/待验证',
  '未识别/待核实',
  '融资轮次待核实',
  '待工商核验',
  '主体待确认',
  '不适用',
  '无',
  '-',
  'N/A',
  'null',
])

export function meaningfulPublicIntelText(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const text = String(value).trim()
  if (!text || PLACEHOLDERS.has(text)) return ''
  if (/^(?:暂?未|尚未|无法|通常不).*(?:披露|公开|获取|识别|核验|确认|查询)/.test(text)) return ''
  return text
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : []
}

function usefulObject(item: Record<string, unknown>, fields: string[]) {
  return fields.some((field) => meaningfulPublicIntelText(item[field]))
}

function dedupeObjects(
  items: Array<Record<string, unknown>>,
  keyOf: (item: Record<string, unknown>) => string | string[],
) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const rawKeys = keyOf(item)
    const keys = (Array.isArray(rawKeys) ? rawKeys : [rawKeys]).filter(Boolean)
    if (!keys.length || keys.some((key) => seen.has(key))) return false
    for (const key of keys) seen.add(key)
    return true
  })
}

function normalizedSourceIdentity(item: Record<string, unknown>) {
  const title = meaningfulPublicIntelText(item.title)
    .replace(/^(?:36氪|硬氪)?(?:首发|前线)?\s*[|｜丨:：-]\s*/i, '')
    .replace(/[\s“”"'「」『』|｜丨:：,，。！？!?·\-—_]/g, '')
    .toLocaleLowerCase()
  const keys: string[] = []
  if (title && !['公开信息来源', '来源证据', '雷达原文'].includes(title)) keys.push(`title:${title}`)
  const rawUrl = meaningfulPublicIntelText(item.url || item.sourceUrl)
  if (!rawUrl) return keys
  try {
    const url = new URL(rawUrl)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|from$|source$|ref$|refer$|share_|scene$|clicktime$|enterid$)/i.test(key)) {
        url.searchParams.delete(key)
      }
    }
    url.searchParams.sort()
    keys.push(`url:${url.toString().replace(/\/$/, '').toLocaleLowerCase()}`)
  } catch {
    keys.push(`url:${rawUrl.replace(/[?#].*$/, '').replace(/\/$/, '').toLocaleLowerCase()}`)
  }
  return keys
}

function mergeFundingRounds(existing: unknown, incoming: PublicIntelFundingRound[]) {
  const researched = incoming
    .map((item) => ({
      round: meaningfulPublicIntelText(item.round),
      date: meaningfulPublicIntelText(item.date),
      amount: meaningfulPublicIntelText(item.amount),
      valuation: meaningfulPublicIntelText(item.valuation),
      investors: meaningfulPublicIntelText(item.investors),
      sourceUrl: meaningfulPublicIntelText(item.sourceUrl),
    }))
    .filter((item) => usefulObject(item, ['round', 'date', 'amount', 'valuation', 'investors']))
    // 公开情报字段必须有来源；没有 URL 的具体融资数据不写回。
    .filter((item) => Boolean(item.sourceUrl))
  const current = objectArray(existing)
    .filter((item) => usefulObject(item, ['round', 'date', 'amount', 'valuation', 'investors']))
  return dedupeObjects([...researched, ...current], (item) => {
    const url = meaningfulPublicIntelText(item.sourceUrl)
    return url || [
      meaningfulPublicIntelText(item.round),
      meaningfulPublicIntelText(item.date),
      meaningfulPublicIntelText(item.amount),
    ].join('|')
  })
}

function mergeShareholders(existing: unknown, incoming: PublicIntelShareholder[]) {
  const researched = incoming
    .map((item) => ({
      name: meaningfulPublicIntelText(item.name),
      percentage: meaningfulPublicIntelText(item.percentage),
      type: meaningfulPublicIntelText(item.type),
      sourceUrl: meaningfulPublicIntelText(item.sourceUrl),
    }))
    .filter((item) => Boolean(item.name && item.sourceUrl))
  const current = objectArray(existing)
    .filter((item) => Boolean(meaningfulPublicIntelText(item.name)))
  return dedupeObjects([...researched, ...current], (item) => meaningfulPublicIntelText(item.name).toLocaleLowerCase())
}

function mergeCompetitors(existing: unknown, incoming: PublicIntelCompetitor[]) {
  const researched = incoming
    .map((item) => ({
      name: meaningfulPublicIntelText(item.name),
      is_self: false,
      tech: '',
      product: meaningfulPublicIntelText(item.positioning),
      funding: '',
      differentiation: meaningfulPublicIntelText(item.comparison),
      sourceUrl: meaningfulPublicIntelText(item.sourceUrl),
    }))
    .filter((item) => Boolean(item.name && item.sourceUrl))
  const current = objectArray(existing)
    .filter((item) => Boolean(meaningfulPublicIntelText(item.name)))
  return dedupeObjects([...researched, ...current], (item) => meaningfulPublicIntelText(item.name).toLocaleLowerCase())
}

function mergeSources(
  existing: unknown,
  intel: PublicIntelResult,
) {
  const accessedAt = new Date().toISOString().slice(0, 10)
  const researched = [
    ...(intel.sources ?? []).map((item) => ({
      id: `public-${Buffer.from(item.url || item.title).toString('base64url').slice(0, 20)}`,
      title: meaningfulPublicIntelText(item.title) || '公开信息来源',
      url: meaningfulPublicIntelText(item.url),
      publisher: '公开来源',
      accessedAt,
      category: '第三方数据库',
      reliability: item.reliability === '高' || item.reliability === '中' ? item.reliability : '待核验',
      excerpt: '',
    })),
    ...(intel.companyNews ?? []).map((item) => ({
      id: `news-${Buffer.from(item.sourceUrl || item.title).toString('base64url').slice(0, 20)}`,
      title: meaningfulPublicIntelText(item.title),
      url: meaningfulPublicIntelText(item.sourceUrl),
      publisher: '公开来源',
      accessedAt,
      category: '权威媒体',
      reliability: '中',
      excerpt: meaningfulPublicIntelText(item.summary),
    })),
  ].filter((item) => Boolean(item.title && item.url))
  const current = objectArray(existing)
    .filter((item) => Boolean(meaningfulPublicIntelText(item.url)))
  return dedupeObjects([...researched, ...current], normalizedSourceIdentity)
}

export async function mergeLeadPublicIntel(
  leadId: string,
  intel: PublicIntelResult,
  userId: string,
) {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1)
  if (!lead) return null

  const scoring = objectValue(lead.scoring)
  const registry = objectValue(scoring.registry)
  const registryPatch: Record<string, unknown> = { ...registry }
  const registryFields: Array<[string, unknown]> = [
    ['registeredCapital', intel.registeredCapital],
    ['legalRepresentative', intel.legalRepresentative],
    ['foundedAt', intel.foundedAt],
    ['regLocation', intel.region],
    ['registeredAddress', intel.registeredAddress],
  ]
  for (const [key, value] of registryFields) {
    const researched = meaningfulPublicIntelText(value)
    if (researched) registryPatch[key] = researched
  }

  const fundingRounds = mergeFundingRounds([
    ...objectArray(scoring.fundingRoundsResearched),
    ...objectArray(lead.fundingRounds),
  ], intel.fundingRounds ?? [])
  const structuredShareholders = mergeShareholders(scoring.structuredShareholders, intel.shareholders ?? [])
  const competitors = mergeCompetitors(scoring.competitors, intel.competitors ?? [])
  const sources = mergeSources(lead.sources, intel)
  const existingResearchSources = objectArray(scoring.researchSources)
  const researchSources = dedupeObjects([
    ...(intel.sources ?? []).map((item) => ({
      title: meaningfulPublicIntelText(item.title) || '公开信息来源',
      url: meaningfulPublicIntelText(item.url),
      excerpt: '',
    })).filter((item) => Boolean(item.url)),
    ...existingResearchSources,
  ], normalizedSourceIdentity)

  const scoringPatch = {
    ...scoring,
    registry: registryPatch,
    fundingRoundsResearched: fundingRounds,
    structuredShareholders,
    competitors,
    researchSources,
    publicIntelUpdatedAt: new Date().toISOString(),
  }
  const patch: Partial<typeof leads.$inferInsert> = {
    scoring: scoringPatch,
    fundingRounds,
    sources,
  }
  const regionResolution = resolveLeadBusinessRegion({
    registry: registryPatch,
    subjectName: lead.name,
    companyName: lead.companyName,
  })
  if (regionResolution) {
    patch.businessRegion = regionResolution.region
    patch.businessRegionSource = regionResolution.source
    patch.businessRegionConfidence = regionResolution.confidence
  }
  const positioning = meaningfulPublicIntelText(intel.positioning)
  if (positioning && !meaningfulPublicIntelText(lead.summary)) patch.summary = positioning.slice(0, 1000)

  const [updated] = await db.update(leads)
    .set(patch)
    .where(eq(leads.id, leadId))
    .returning()
  if (updated) {
    await db.insert(auditLogs).values({
      userId,
      userName: '（系统）',
      module: '项目获取池',
      action: '补充公开信息',
      target: updated.name,
    })
  }
  return updated
}
